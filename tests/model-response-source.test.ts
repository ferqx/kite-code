import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '@/core/config';
import { humanMessage } from '@/core/messages';
import type { ModelInvocationPersistenceV1 } from '@/core/model/invocation-gateway';
import {
  computeModelAttemptOutcomeDigestV1,
  computeModelEnvelopeReplayDigestV1,
  ModelReplayErrorV1,
  StrictModelReplayCatalogV1,
} from '@/core/model/replay-catalog';
import {
  createLiveModelResponseSourceV1,
  createRecordModelResponseSourceV1,
  createReplayModelResponseSourceV1,
  type ModelResponseSourceV1,
} from '@/core/model/response-source';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import { compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import { createInitialRuntimeState } from '@/core/runtime/state';
import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
  MODEL_INVOCATION_ENVELOPE_SCHEMA_V1,
  MODEL_REPLAY_CATALOG_SCHEMA_V1,
  type ModelAttemptOutcomeV1,
  type ModelInvocationEnvelopeV1,
  type ModelReplayAttemptRecordV1,
  type ModelReplayCatalogV1,
  type ModelReplayInvocationBindingV1,
  type Sha256DigestV1,
} from '@/protocol/model-surface';
import { createTestModelInvocationHarnessV1 } from './helpers/model-invocation';
import { createMockModel } from './mock-model';

const CONFIG: AgentConfig = {
  apiKey: '',
  baseURL: 'https://replay-fixture.invalid/v1',
  modelName: 'replay-fixture',
  providerName: 'fixture',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};

const BINDING: ModelReplayInvocationBindingV1 = Object.freeze({
  suiteId: 'suite-fixture-v1',
  suiteRevision: 1,
  fixtureDigest: digest('1'),
  actor: { kind: 'parent' as const },
  logicalInvocationOrdinal: 1,
  replayDigest: null,
});

const LIVE_RESPONSE = Object.freeze({
  message: {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'recorded response' }],
  },
  finishReason: 'stop' as const,
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cacheReadTokens: null },
  providerMetadata: { responseId: 'raw-provider-response-id', rawFinishReason: 'stop' },
});

function fixture(message = 'replay this request') {
  const model = createMockModel([]);
  return {
    model,
    compiled: compileModelSurfaceV1({
      purpose: 'primary_agent',
      config: CONFIG,
      model,
      messages: [humanMessage(message)],
      tools: {},
      transport: 'generate',
    }),
  };
}

function invocationInput(
  compiled: ReturnType<typeof fixture>['compiled'],
  persistence: ModelInvocationPersistenceV1,
  model?: ReturnType<typeof createMockModel>,
) {
  return {
    ...(model ? { model } : {}),
    compiled,
    persistence,
    provenance: {
      promptContractVersion: 'replay-prompt-contract-v1',
      projectionEnvironmentDigest: digest('2'),
      capabilityBindingDigest: digest('3'),
    },
    providerDataPolicyRequired: false,
    resourceKind: 'model' as const,
    replayBinding: BINDING,
    limits: { maxAttempts: 2 },
  };
}

function encodeForCassette(input: {
  outcome: ModelAttemptOutcomeV1;
  attemptOrdinal: number;
}): ModelAttemptOutcomeV1 {
  if (input.outcome.kind !== 'success') return input.outcome;
  return {
    ...input.outcome,
    response: {
      ...input.outcome.response,
      providerMetadata: {
        responseId: `cassette-response-${input.attemptOrdinal}`,
        rawFinishReason: null,
      },
    },
    nativeReplayState: null,
  };
}

function catalog(records: readonly ModelReplayAttemptRecordV1[]): ModelReplayCatalogV1 {
  return {
    schema: MODEL_REPLAY_CATALOG_SCHEMA_V1,
    catalogRevision: 'catalog-fixture-v1',
    suite: {
      suiteId: BINDING.suiteId,
      suiteRevision: BINDING.suiteRevision,
      fixtureDigest: BINDING.fixtureDigest,
    },
    records,
  };
}

function digest(fill: string): Sha256DigestV1 {
  return `sha256:${fill.repeat(64).slice(0, 64)}`;
}

async function recordTwoAttempts(): Promise<{
  records: ModelReplayAttemptRecordV1[];
  order: string[];
  compiled: ReturnType<typeof fixture>['compiled'];
}> {
  const records: ModelReplayAttemptRecordV1[] = [];
  const order: string[] = [];
  let dispatches = 0;
  const responseSource = createRecordModelResponseSourceV1({
    live: createLiveModelResponseSourceV1(async () => {
      dispatches += 1;
      order.push(`dispatch-${dispatches}`);
      if (dispatches === 1) {
        throw Object.assign(new Error('synthetic unavailable'), { statusCode: 503 });
      }
      return LIVE_RESPONSE;
    }),
    recorder: {
      append: (record) => {
        records.push(record);
        order.push(`record-${record.attemptOrdinal}`);
      },
    },
    encodeForCassette,
  });
  const modelFixture = fixture();
  const harness = createTestModelInvocationHarnessV1({
    workspace: '/tmp/model-record-source',
    source: responseSource,
    persist: (events) => {
      for (const event of events) {
        if (event.type === 'model.invocation_attempt_started') order.push(`ack-${event.attempt}`);
        if (event.type === 'model.retry') order.push(`retry-${event.attempt}`);
      }
      return true;
    },
  });
  const pending = await harness.gateway.invoke(
    invocationInput(modelFixture.compiled, harness.persistence, modelFixture.model),
  );
  await pending.commit();
  return { records, order, compiled: modelFixture.compiled };
}

describe('ModelResponseSourceV1 record/replay boundary', () => {
  test('records one outcome per Gateway-owned attempt and replays keylessly in the same order', async () => {
    const recorded = await recordTwoAttempts();
    expect(recorded.order).toEqual([
      'ack-1',
      'dispatch-1',
      'record-1',
      'retry-1',
      'ack-2',
      'dispatch-2',
      'record-2',
    ]);
    expect(recorded.records.map((record) => record.outcome.kind)).toEqual([
      'retryable_failure',
      'success',
    ]);
    expect(
      recorded.records[1]?.outcome.kind === 'success'
        ? recorded.records[1].outcome.response.providerMetadata
        : null,
    ).toEqual({ responseId: 'cassette-response-2', rawFinishReason: null });

    const replayCatalog = StrictModelReplayCatalogV1.parse(
      canonicalModelJsonV1(catalog(recorded.records)),
    );
    const replay = createReplayModelResponseSourceV1(replayCatalog);
    const replayOrder: string[] = [];
    const observedReplay: ModelResponseSourceV1 = {
      mode: 'replay',
      attempt: (input) => {
        replayOrder.push(`lookup-${input.attemptOrdinal}`);
        return replay.attempt(input);
      },
    };
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-source',
      source: observedReplay,
      persist: (events) => {
        for (const event of events) {
          if (event.type === 'model.invocation_attempt_started') {
            replayOrder.push(`ack-${event.attempt}`);
          }
          if (event.type === 'model.retry') replayOrder.push(`retry-${event.attempt}`);
        }
        return true;
      },
    });

    // No model, API key or transport is supplied to the replay invocation.
    const pending = await harness.gateway.invoke(
      invocationInput(recorded.compiled, harness.persistence),
    );
    const response = await pending.commit();

    expect(response.message.content).toEqual([{ type: 'text', text: 'recorded response' }]);
    expect(replayOrder).toEqual(['ack-1', 'lookup-1', 'retry-1', 'ack-2', 'lookup-2']);
    expect(() => replayCatalog.assertConsumed()).not.toThrow();
  });

  test('performs current admission and attempt acknowledgement before replay lookup', async () => {
    const recorded = await recordTwoAttempts();
    const createObservedSource = (counter: { lookups: number }): ModelResponseSourceV1 => {
      const replay = createReplayModelResponseSourceV1(
        StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(catalog(recorded.records))),
      );
      return {
        mode: 'replay',
        attempt: (input) => {
          counter.lookups += 1;
          return replay.attempt(input);
        },
      };
    };

    const denied = { lookups: 0 };
    const deniedHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-admission-denied',
      source: createObservedSource(denied),
    });
    await expect(
      deniedHarness.gateway.invoke({
        ...invocationInput(recorded.compiled, deniedHarness.persistence),
        providerDataPolicyRequired: true,
        providerDataAdmission: () => ({
          admitted: false,
          reason: 'provider_policy_missing',
          routeAlias: 'denied',
        }),
      }),
    ).rejects.toThrow();
    expect(denied.lookups).toBe(0);

    const resourceDenied = { lookups: 0 };
    const expiredAt = Date.now() - LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs - 1_000;
    const exhaustedState = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 'model-replay-resource-denied',
        userId: 'test',
        workspace: '/tmp/model-replay-resource-denied',
      }),
      {
        type: 'resource_budget.configured',
        runId: 'model-replay-resource-denied-run',
        startedAt: new Date(expiredAt).toISOString(),
        deadlineAt: new Date(expiredAt + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_V1,
      },
    );
    const resourceDeniedHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-resource-denied',
      state: exhaustedState,
      source: createObservedSource(resourceDenied),
    });
    await expect(
      resourceDeniedHarness.gateway.invoke(
        invocationInput(recorded.compiled, resourceDeniedHarness.persistence),
      ),
    ).rejects.toThrow('budget_exhausted');
    expect(resourceDenied.lookups).toBe(0);

    const unacked = { lookups: 0 };
    const unackedHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-ack-denied',
      source: createObservedSource(unacked),
      persist: (events) =>
        !events.some((event) => event.type === 'model.invocation_attempt_started'),
    });
    await expect(
      unackedHarness.gateway.invoke(invocationInput(recorded.compiled, unackedHarness.persistence)),
    ).rejects.toThrow('acknowledgement was rejected');
    expect(unacked.lookups).toBe(0);
  });

  test('fails closed on miss, out-of-order, route mismatch, corruption and extra consumption', async () => {
    const recorded = await recordTwoAttempts();
    const base = catalog(recorded.records);

    const changedFixture = fixture('changed semantic prompt');
    const missCatalog = StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(base));
    const missHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-miss',
      source: createReplayModelResponseSourceV1(missCatalog),
    });
    await expect(
      missHarness.gateway.invoke(invocationInput(changedFixture.compiled, missHarness.persistence)),
    ).rejects.toMatchObject({ code: 'MODEL_REPLAY_MISS' });
    expect(missHarness.events.at(-1)).toMatchObject({
      type: 'model.invocation_interrupted',
      dispatchCertainty: 'none',
    });

    const outOfOrder = structuredClone(base);
    outOfOrder.records[0]!.attemptOrdinal = 3;
    const outOfOrderHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-out-of-order',
      source: createReplayModelResponseSourceV1(
        StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(outOfOrder)),
      ),
    });
    await expect(
      outOfOrderHarness.gateway.invoke(
        invocationInput(recorded.compiled, outOfOrderHarness.persistence),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_REPLAY_MISS' });

    const routeMismatch = structuredClone(base);
    routeMismatch.records[0]!.routeFingerprint = digest('9');
    const routeHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-route-mismatch',
      source: createReplayModelResponseSourceV1(
        StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(routeMismatch)),
      ),
    });
    await expect(
      routeHarness.gateway.invoke(invocationInput(recorded.compiled, routeHarness.persistence)),
    ).rejects.toMatchObject({ code: 'MODEL_REPLAY_ROUTE_MISMATCH' });

    const corrupt = structuredClone(base);
    const corruptOutcome = corrupt.records[1]!.outcome;
    if (corruptOutcome.kind !== 'success') throw new Error('expected success fixture');
    const firstPart = corruptOutcome.response.message.content[0];
    if (firstPart?.type !== 'text') throw new Error('expected text fixture');
    firstPart.text = 'tampered response';
    expect(() => StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(corrupt))).toThrow(
      'MODEL_REPLAY_CORRUPT',
    );

    const consumedCatalog = StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(base));
    expect(() => consumedCatalog.assertConsumed()).toThrow('MODEL_REPLAY_MISS');
  });

  test('rejects non-canonical, unknown-field and unsafe Provider identity catalogs', async () => {
    const recorded = await recordTwoAttempts();
    const base = catalog(recorded.records);
    expect(() => StrictModelReplayCatalogV1.parse(JSON.stringify(base, null, 2))).toThrow(
      'MODEL_REPLAY_CORRUPT',
    );

    const unknown = structuredClone(base) as ModelReplayCatalogV1 & { fallback?: string };
    unknown.fallback = 'live';
    expect(() => StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(unknown))).toThrow(
      'MODEL_REPLAY_CORRUPT',
    );

    const unsafe = structuredClone(base);
    const success = unsafe.records[1]!.outcome;
    if (success.kind !== 'success') throw new Error('expected success fixture');
    success.response.providerMetadata = {
      responseId: 'raw-provider-response-id',
      rawFinishReason: null,
    };
    expect(() => StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(unsafe))).toThrow(
      'MODEL_REPLAY_CORRUPT',
    );

    const normalizedWithoutAuthority = structuredClone(base);
    normalizedWithoutAuthority.records[0]!.replayDigest = digest('7');
    expect(() =>
      StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(normalizedWithoutAuthority)),
    ).toThrow('MODEL_REPLAY_CORRUPT');
  });

  test('matches adapter replay-owner and actor-local coordinates exactly', async () => {
    const recorded = await recordTwoAttempts();
    const ownerMismatch = structuredClone(catalog(recorded.records));
    ownerMismatch.records[0]!.replayOwner.ownerFingerprint = digest('8');
    const ownerHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-owner-mismatch',
      source: createReplayModelResponseSourceV1(
        StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(ownerMismatch)),
      ),
    });
    await expect(
      ownerHarness.gateway.invoke(invocationInput(recorded.compiled, ownerHarness.persistence)),
    ).rejects.toMatchObject({ code: 'MODEL_REPLAY_ROUTE_MISMATCH' });

    const actorHarness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-replay-actor-mismatch',
      source: createReplayModelResponseSourceV1(
        StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(catalog(recorded.records))),
      ),
    });
    await expect(
      actorHarness.gateway.invoke({
        ...invocationInput(recorded.compiled, actorHarness.persistence),
        replayBinding: {
          ...BINDING,
          actor: {
            kind: 'subagent',
            parentToolCallId: 'parent-call-1',
            subagentId: 'child-1',
            continuationId: null,
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_REPLAY_MISS' });

    const duplicate = structuredClone(catalog(recorded.records));
    duplicate.records = [...duplicate.records, structuredClone(duplicate.records[0]!)];
    expect(() => StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(duplicate))).toThrow(
      'MODEL_REPLAY_CORRUPT',
    );
  });

  test('strictly parses fatal and aborted attempt outcomes', async () => {
    const recorded = await recordTwoAttempts();
    const closedOutcomes = structuredClone(catalog(recorded.records));
    const fatal: ModelAttemptOutcomeV1 = {
      schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
      kind: 'fatal_failure',
      classification: 'provider_rejected',
      providerStatusCode: 401,
    };
    const aborted: ModelAttemptOutcomeV1 = {
      schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
      kind: 'aborted',
      classification: 'transport_aborted',
    };
    closedOutcomes.records[0]!.outcome = fatal;
    closedOutcomes.records[0]!.outcomeDigest = computeModelAttemptOutcomeDigestV1(fatal);
    closedOutcomes.records[1]!.outcome = aborted;
    closedOutcomes.records[1]!.outcomeDigest = computeModelAttemptOutcomeDigestV1(aborted);
    expect(() =>
      StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(closedOutcomes)),
    ).not.toThrow();
  });

  test('never retries a failed record append or falls through to another source', async () => {
    let dispatches = 0;
    const source = createRecordModelResponseSourceV1({
      live: createLiveModelResponseSourceV1(async () => {
        dispatches += 1;
        return LIVE_RESPONSE;
      }),
      recorder: { append: () => Promise.reject(new Error('private recorder detail')) },
      encodeForCassette,
    });
    const modelFixture = fixture();
    const harness = createTestModelInvocationHarnessV1({
      workspace: '/tmp/model-record-append-failure',
      source,
    });
    await expect(
      harness.gateway.invoke(
        invocationInput(modelFixture.compiled, harness.persistence, modelFixture.model),
      ),
    ).rejects.toThrow('MODEL_RECORD_APPEND_FAILED');
    expect(dispatches).toBe(1);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'model.invocation_interrupted',
      dispatchCertainty: 'attempted',
    });
  });
});

test('envelopeReplayDigest excludes runtime identity but binds retry/admission semantics', () => {
  const envelope: ModelInvocationEnvelopeV1 = {
    schema: MODEL_INVOCATION_ENVELOPE_SCHEMA_V1,
    surface: {
      artifact: {
        artifactId: 'surface-artifact-1',
        kind: 'model_surface',
        integrityIdentifier: 'hmac-sha256:fixture',
        byteLength: 10,
      },
      surfaceIntegrityIdentifier: 'hmac-sha256:fixture',
    },
    admission: {
      providerDataPolicyRevision: 'policy-v1',
      routeIdentityDigest: digest('4'),
      payloadClassificationDigest: digest('5'),
      admitted: true,
    },
    provenance: {
      invocationId: 'invocation-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      parentInvocationId: null,
      parentToolCallId: null,
      stateRevision: 1,
      contextCheckpointId: null,
      promptContractVersion: 'prompt-v1',
      projectionEnvironmentDigest: digest('6'),
      capabilityBindingDigest: digest('7'),
    },
    resource: {
      budget: { kind: 'reservation', reservationId: 'reservation-1', parentReservationId: null },
      limits: { maxAttempts: 3, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 5_000 },
    },
  };
  const baseline = computeModelEnvelopeReplayDigestV1(envelope, 'primary_agent');
  const runtimeIdentityDrift = structuredClone(envelope);
  runtimeIdentityDrift.surface.artifact.artifactId = 'surface-artifact-2';
  runtimeIdentityDrift.provenance.invocationId = 'invocation-2';
  runtimeIdentityDrift.provenance.threadId = 'thread-2';
  runtimeIdentityDrift.provenance.turnId = 'turn-2';
  runtimeIdentityDrift.provenance.stateRevision = 99;
  if (runtimeIdentityDrift.resource.budget.kind === 'reservation') {
    runtimeIdentityDrift.resource.budget.reservationId = 'reservation-2';
  }
  expect(computeModelEnvelopeReplayDigestV1(runtimeIdentityDrift, 'primary_agent')).toBe(baseline);

  const admissionDrift = structuredClone(envelope);
  admissionDrift.admission.payloadClassificationDigest = digest('8');
  expect(computeModelEnvelopeReplayDigestV1(admissionDrift, 'primary_agent')).not.toBe(baseline);
  const retryDrift = structuredClone(envelope);
  retryDrift.resource.limits.maxAttempts = 4;
  expect(computeModelEnvelopeReplayDigestV1(retryDrift, 'primary_agent')).not.toBe(baseline);
  expect(computeModelEnvelopeReplayDigestV1(envelope, 'subagent')).not.toBe(baseline);
});

test('record/replay Gateway construction requires explicit authority binding', async () => {
  const modelFixture = fixture();
  const source: ModelResponseSourceV1 = {
    mode: 'replay',
    attempt: async () => {
      throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
    },
  };
  const harness = createTestModelInvocationHarnessV1({
    workspace: '/tmp/model-replay-missing-binding',
    source,
  });
  const input = invocationInput(modelFixture.compiled, harness.persistence);
  const { replayBinding: _replayBinding, ...withoutBinding } = input;
  await expect(harness.gateway.invoke(withoutBinding)).rejects.toThrow(
    'require an authority-bound replay binding',
  );
  await expect(
    harness.gateway.invoke({
      ...input,
      model: modelFixture.model,
    }),
  ).rejects.toThrow('must not receive a live model transport handle');
  expect(harness.events).toHaveLength(0);
});
