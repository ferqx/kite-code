import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createSnapshot, digestCapability } from '@/core/capabilities/catalog';
import { getFeatureFlags } from '@/core/config/features';
import {
  admitAuthorizedToolInvocationV1,
  authorizePolicyEvaluatedToolV1,
  classifyValidatedToolInvocationV1,
  createToolCallSnapshotV1,
  dispatchAdmittedToolInvocationV1,
  evaluateClassifiedToolPolicyV1,
  resolveToolInvocationV1,
  ToolInvocationPersistenceErrorV1,
  validateResolvedToolInvocationV1,
} from '@/core/execution/tool-pipeline';
import { createPipelineSubagentRuntimeV1 } from '@/core/execution/tool-pipeline/subagent-runtime';
import { aiMessage } from '@/core/messages';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import { ChildRuntimeDriverV1 } from '@/core/subagent/child-runtime-driver';
import {
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from '@/core/subagent/continuation-codec';
import { SubagentGrantAuthorityV1 } from '@/core/subagent/grant-authority';
import {
  type LocalSubagentLifecycleDriverV1,
  LocalSubagentProviderV1,
} from '@/core/subagent/local-provider';
import { subagentResultFromObservationV1 } from '@/core/subagent/observation-codec';
import { subagentReplayContextDigestV1 } from '@/core/subagent/replay-context';
import { getRoleConfig } from '@/core/subagent/roles';
import {
  resumeTaskSubAgentV1,
  runTaskSubAgent,
  SubagentProviderRecoveryRequiredErrorV1,
} from '@/core/subagent/task-tool';
import type {
  SubagentDelegationGrantV1,
  SubagentHandleV1,
  SubagentProviderV1,
  SubagentResumeGrantV1,
} from '@/protocol/subagent-provider';
import { SUBAGENT_PROVIDER_SCHEMA_V1 } from '@/protocol/subagent-provider';
import { createTestModelInvocationHarnessV1 } from './helpers/model-invocation';
import { createMockModel } from './mock-model';

function binding() {
  const hash = (name: string) => digestCapability({ name });
  return {
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    parentAttempt: 1,
    capabilityRevision: hash('capability'),
    admissionDigest: hash('admission'),
    effectiveEffectsDigest: hash('effects'),
    childInvocationId: 'child-1',
    role: 'review' as const,
    taskArtifact: {
      artifactId: 'task-artifact',
      kind: 'subagent_task' as const,
      digest: hash('task'),
      byteLength: 4,
    },
    taskDigest: hash('task'),
    capabilityCeiling: {
      allowedTools: ['read_file'],
      bindingIds: [],
      bindingRevision: hash('bindings'),
      ceilingDigest: hash('ceiling'),
    },
    authorization: {
      authorizationDigest: hash('authorization'),
      interactionMode: 'accept_edits' as const,
      phase: 'building' as const,
      workspaceAccess: 'write' as const,
    },
    executionBoundary: {
      canonicalWorkspace: '/workspace',
      executionBoundaryDigest: hash('boundary'),
    },
    resource: { parentReservationId: 'reservation', budgetDigest: hash('budget') },
    cancellationCorrelation: 'parent-tool',
    model: {
      parentModelInvocationId: 'parent-model',
      parentToolCallId: 'parent-tool',
      responseSourceMode: 'live' as const,
      replayContextDigest: hash('replay'),
    },
  };
}

function driverResult(childInvocationId = 'child-1') {
  return {
    childInvocationId,
    status: 'completed' as const,
    summary: 'done',
    toolCallCount: 0,
    durationMs: 1,
    privatePayload: {},
  };
}

describe('SubagentProviderV1 grant and Local Provider', () => {
  test('rejects cross-child and digest-mutated observation envelopes', () => {
    const expected = handle({
      ...new SubagentGrantAuthorityV1({ idSource: () => 'observation-grant' }).issueStart(
        binding(),
      ),
    });
    const privatePayload = JSON.parse(
      JSON.stringify({
        ok: true,
        summary: 'done',
        toolCallCount: 0,
        durationMs: 1,
        terminalStatus: 'completed',
        error: null,
        resourceAdmissionFailure: null,
        steps: [],
        executionJournal: [],
        exhaustedFingerprints: {},
        toolRecovery: createToolRecoveryJournalV1('1'.repeat(64)),
        blocked: null,
      }),
    ) as import('@/protocol/subagent').JsonObject;
    const body = {
      schema: SUBAGENT_PROVIDER_SCHEMA_V1,
      handleId: 'other-handle',
      childInvocationId: expected.childInvocationId,
      status: 'completed' as const,
      summary: 'done',
      toolCallCount: 0,
      durationMs: 1,
      privatePayload,
    };
    const observation = {
      ...body,
      observationDigest: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
    };
    expect(() => subagentResultFromObservationV1(observation, expected)).toThrow(
      'malformed or inconsistent',
    );
    const crossChildBody = {
      ...body,
      handleId: expected.handleId,
      childInvocationId: 'other-child',
    };
    expect(() =>
      subagentResultFromObservationV1(
        {
          ...crossChildBody,
          observationDigest: `sha256:${createHash('sha256')
            .update(JSON.stringify(crossChildBody))
            .digest('hex')}`,
        },
        expected,
      ),
    ).toThrow('malformed or inconsistent');
    expect(() =>
      subagentResultFromObservationV1({ ...observation, handleId: expected.handleId }, expected),
    ).toThrow('digest is invalid');
    for (const reason of ['forged_reason', 'budget_exhausted'] as const) {
      const resourceBody = {
        ...body,
        handleId: expected.handleId,
        privatePayload: {
          ...privatePayload,
          resourceAdmissionFailure: {
            reason,
            message: 'resource terminal',
            parentInvocationId: expected.parentInvocationId,
            parentToolCallId: expected.parentToolCallId,
            childInvocationId: expected.childInvocationId,
          },
        },
      };
      expect(() =>
        subagentResultFromObservationV1(
          {
            ...resourceBody,
            observationDigest: `sha256:${createHash('sha256')
              .update(JSON.stringify(resourceBody))
              .digest('hex')}`,
          },
          expected,
        ),
      ).toThrow(
        reason === 'forged_reason'
          ? 'malformed or inconsistent'
          : 'resource terminal is inconsistent',
      );
    }
  });

  test('binds, expires, and consumes an exact start grant once', async () => {
    let now = 10;
    const authority = new SubagentGrantAuthorityV1({
      key: new Uint8Array(32).fill(7),
      now: () => now,
      ttlMs: 20,
      idSource: () => 'grant-1',
    });
    const driver: LocalSubagentLifecycleDriverV1 = {
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProviderV1(authority.verifier(), driver, () => 'handle-1');
    const grant = authority.issueStart(binding());
    const started = await provider.start({ grant });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const observed = await provider.observe({ handle: started.value });
    expect(observed).toMatchObject({
      ok: true,
      value: { handleId: 'handle-1', childInvocationId: 'child-1', status: 'completed' },
    });
    if (observed.ok) expect(observed.value.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await provider.start({ grant })).toMatchObject({
      ok: false,
      failure: { code: 'consumed_grant' },
    });

    const expiring = new SubagentGrantAuthorityV1({
      key: new Uint8Array(32).fill(9),
      now: () => now,
      ttlMs: 5,
      idSource: () => 'grant-expired',
    });
    const expiredGrant = expiring.issueStart(binding());
    now = 16;
    const expiredProvider = new LocalSubagentProviderV1(expiring.verifier(), driver);
    expect(await expiredProvider.start({ grant: expiredGrant })).toMatchObject({
      ok: false,
      failure: { code: 'expired_grant' },
    });
  });

  test('rejects a tampered grant and stale or identity-mutated handles', async () => {
    const authority = new SubagentGrantAuthorityV1({ idSource: () => 'grant-2' });
    const driver: LocalSubagentLifecycleDriverV1 = {
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProviderV1(authority.verifier(), driver, () => 'handle-2');
    const grant = authority.issueStart(binding());
    expect(
      await provider.start({
        grant: { ...grant, parentAttempt: 2 } as SubagentDelegationGrantV1,
      }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid_grant' } });
    const valid = authority.issueStart({ ...binding(), childInvocationId: 'child-2' });
    const started = await provider.start({ grant: valid });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(
      await provider.observe({
        handle: { ...started.value, role: 'code' } as SubagentHandleV1,
      }),
    ).toMatchObject({ ok: false, failure: { code: 'stale_handle' } });
    expect(await provider.observe({ handle: started.value })).toMatchObject({ ok: true });
    expect(await provider.observe({ handle: started.value })).toMatchObject({
      ok: false,
      failure: { code: 'stale_handle' },
    });
  });

  test('maps driver crash and oversized observations to typed transport failures', async () => {
    const crashAuthority = new SubagentGrantAuthorityV1({ idSource: () => 'grant-crash' });
    const crashProvider = new LocalSubagentProviderV1(
      crashAuthority.verifier(),
      {
        start: async () => {
          throw new Error('boom');
        },
        resume: async () => {
          throw new Error('boom');
        },
      },
      () => 'handle-crash',
    );
    const crashStart = await crashProvider.start({ grant: crashAuthority.issueStart(binding()) });
    expect(crashStart.ok).toBe(true);
    if (crashStart.ok) {
      expect(await crashProvider.observe({ handle: crashStart.value })).toMatchObject({
        ok: false,
        failure: { code: 'driver_crashed' },
      });
    }

    const largeAuthority = new SubagentGrantAuthorityV1({ idSource: () => 'grant-large' });
    const largeProvider = new LocalSubagentProviderV1(
      largeAuthority.verifier(),
      {
        start: async (grant) => ({
          ...driverResult(grant.childInvocationId),
          privatePayload: { value: 'x'.repeat(4 * 1024 * 1024) },
        }),
        resume: async (grant) => driverResult(grant.childInvocationId),
      },
      () => 'handle-large',
    );
    const largeStart = await largeProvider.start({ grant: largeAuthority.issueStart(binding()) });
    expect(largeStart.ok).toBe(true);
    if (largeStart.ok) {
      expect(await largeProvider.observe({ handle: largeStart.value })).toMatchObject({
        ok: false,
        failure: { code: 'observation_too_large' },
      });
    }
  });

  test('consumes an exact resume grant and confirms abort-aware cancellation cleanup', async () => {
    let grantOrdinal = 0;
    const authority = new SubagentGrantAuthorityV1({
      idSource: () => `grant-resume-${++grantOrdinal}`,
    });
    const driver: LocalSubagentLifecycleDriverV1 = {
      start: async (grant, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                ...driverResult(grant.childInvocationId),
                status: 'cancelled',
              }),
            { once: true },
          );
        }),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProviderV1(
      authority.verifier(),
      driver,
      () => 'handle-resume',
    );
    const resumeGrant = authority.issueResume({
      ...binding(),
      continuationId: 'continuation-exact',
      continuationDigest: digestCapability({ value: 'continuation' }),
      blockedToolCallId: 'blocked-model-tool',
      blockedRuntimeToolCallId: 'blocked-runtime-tool',
      resumeAttempt: 2,
    });
    const resumed = await provider.resume({ grant: resumeGrant });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(await provider.observe({ handle: resumed.value })).toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
    }

    const startGrant = authority.issueStart({ ...binding(), childInvocationId: 'child-cancel' });
    const started = await provider.start({ grant: startGrant });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(await provider.cancel({ handle: started.value, reason: 'test cancel' })).toMatchObject(
        {
          ok: true,
        },
      );
      expect(await provider.observe({ handle: started.value })).toMatchObject({
        ok: true,
        value: { status: 'cancelled' },
      });
      expect(await provider.observe({ handle: started.value })).toMatchObject({
        ok: false,
        failure: { code: 'stale_handle' },
      });
    }
  });

  test('uses one bounded cleanup grace and forgets a non-cooperative driver handle', async () => {
    const authority = new SubagentGrantAuthorityV1({ idSource: () => 'grant-leak' });
    const never = new Promise<ReturnType<typeof driverResult>>(() => {});
    const provider = new LocalSubagentProviderV1(
      authority.verifier(),
      {
        start: async () => never,
        resume: async () => never,
      },
      () => 'handle-leak',
      10,
    );
    const started = await provider.start({ grant: authority.issueStart(binding()) });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const controller = new AbortController();
    const observing = provider.observe({ handle: started.value, signal: controller.signal });
    const beganAt = Date.now();
    controller.abort('test cleanup');
    expect(await observing).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });
    expect(Date.now() - beganAt).toBeLessThan(100);
    expect(await provider.cancel({ handle: started.value, reason: 'late cancel' })).toMatchObject({
      ok: false,
      failure: { code: 'stale_handle' },
    });
    expect(await provider.observe({ handle: started.value })).toMatchObject({
      ok: false,
      failure: { code: 'stale_handle' },
    });
  });
});

class FakeProviderV1 implements SubagentProviderV1 {
  starts = 0;
  observes = 0;
  cancels = 0;
  lastGrant?: SubagentDelegationGrantV1;
  lastResumeGrant?: SubagentResumeGrantV1;
  readonly mode: 'deny' | 'crash' | 'stale' | 'recovery';
  constructor(mode: 'deny' | 'crash' | 'stale' | 'recovery') {
    this.mode = mode;
  }
  async start(input: { grant: SubagentDelegationGrantV1 }) {
    this.starts += 1;
    this.lastGrant = input.grant;
    if (this.mode === 'deny') {
      return { ok: false as const, failure: { code: 'fake_denied' as const, message: 'denied' } };
    }
    return { ok: true, value: handle(input.grant) } as const;
  }
  async resume(input: { grant: SubagentResumeGrantV1 }) {
    this.lastResumeGrant = input.grant;
    return { ok: true, value: handle(input.grant) } as const;
  }
  async observe() {
    this.observes += 1;
    const code =
      this.mode === 'stale'
        ? 'stale_handle'
        : this.mode === 'recovery'
          ? 'recovery_required'
          : 'fake_crashed';
    return { ok: false, failure: { code, message: code } } as const;
  }
  async cancel() {
    this.cancels += 1;
    return { ok: true, value: { cancelled: true as const } } as const;
  }
}

function handle(grant: SubagentDelegationGrantV1 | SubagentResumeGrantV1): SubagentHandleV1 {
  return {
    schema: SUBAGENT_PROVIDER_SCHEMA_V1,
    handleId: `handle-${grant.grantId}`,
    grantId: grant.grantId,
    childInvocationId: grant.childInvocationId,
    parentInvocationId: grant.parentInvocationId,
    parentToolCallId: grant.parentToolCallId,
    role: grant.role,
    lifecycle: 'running',
  };
}

describe('Pipeline-owned Fake Provider negatives', () => {
  test('injects Fake Providers only after a real admitted Task attempt is acknowledged', async () => {
    const args = {
      subagent_type: 'review' as const,
      task: 'Review acknowledged Provider routing and report exact evidence.',
    };
    const snapshot = createToolCallSnapshotV1({
      toolCallId: 'pipeline-task',
      name: 'task',
      rawArguments: args,
      createdAtTurnId: 'turn-provider',
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const resolved = resolveToolInvocationV1(snapshot.value, {
      currentTurnId: 'turn-provider',
      catalogRevision: createSnapshot([]).revision,
      availabilityContext: {
        workspace: process.cwd(),
        phase: 'building',
        hasTaskAdapter: true,
        featureFlags: getFeatureFlags(),
      },
      bindings: [],
      descriptors: [],
      disclosures: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const validated = validateResolvedToolInvocationV1(resolved.value);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const classified = classifyValidatedToolInvocationV1(validated.value);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const policyContext = {
      phase: 'building' as const,
      workspace: process.cwd(),
      threadId: 'thread-provider',
      authorization: { mode: 'default' as const, commandGrants: {} },
      interactionMode: 'accept_edits' as const,
      planKind: 'building_without_plan' as const,
      circuitBreakerTripped: false,
      callStatus: 'queued' as const,
      gates: {
        recoveryAdmission: 'admitted' as const,
        boundedCancellation: 'admitted' as const,
        executionBoundary: 'admitted' as const,
        skillCapabilityCeiling: 'admitted' as const,
      },
    };
    const policy = evaluateClassifiedToolPolicyV1(classified.value, policyContext);
    expect(policy.kind).toBe('continue');
    if (policy.kind !== 'continue') return;
    const authorized = authorizePolicyEvaluatedToolV1(policy.value, policyContext);
    expect(authorized.kind).toBe('continue');
    if (authorized.kind !== 'continue') return;
    const admission = admitAuthorizedToolInvocationV1(authorized.value, {
      reservationRequired: false,
      reservationIds: [],
      freshness: 'current',
    });
    expect(admission.kind).toBe('continue');
    if (admission.kind !== 'continue') return;

    const dispatchInput = (harness: ReturnType<typeof createTestModelInvocationHarnessV1>) => ({
      workspace: process.cwd(),
      request: {
        source: 'builtin' as const,
        id: 'pipeline-task',
        name: 'task' as const,
        args,
        reason: 'provider routing fixture',
        protectedCommand: 'task',
      },
      taskConfig: { providerName: 'fixture', modelName: 'fixture' } as never,
      interactionMode: 'accept_edits' as const,
      subagentEventSink: () => {},
      modelInvocationGateway: harness.gateway,
      modelInvocationPersistence: harness.persistence,
      modelInvocationParentId: 'parent-model',
      modelInvocationParentToolCallId: 'pipeline-task',
    });

    const noAckFake = new FakeProviderV1('deny');
    const noAckHarness = createTestModelInvocationHarnessV1({ workspace: process.cwd() });
    let noAckFactoryCalls = 0;
    await expect(
      dispatchAdmittedToolInvocationV1(admission.value, dispatchInput(noAckHarness), {
        threadId: 'thread-provider',
        toolCallId: 'pipeline-task',
        persistence: {
          getState: () =>
            createInitialRuntimeState({
              threadId: 'thread-provider',
              userId: 'test',
              workspace: process.cwd(),
            }),
          persistEvents: async () => false,
        },
        subagentRuntimeFactory: () => {
          noAckFactoryCalls += 1;
          return createPipelineSubagentRuntimeV1(() => ({
            grants: new SubagentGrantAuthorityV1(),
            driver: new ChildRuntimeDriverV1(),
            provider: noAckFake,
          }));
        },
      }),
    ).rejects.toBeInstanceOf(ToolInvocationPersistenceErrorV1);
    expect(noAckFactoryCalls).toBe(0);
    expect(noAckFake.starts).toBe(0);
    expect(noAckHarness.events.filter((event) => event.type.startsWith('model.'))).toHaveLength(0);

    for (const mode of ['deny', 'crash', 'stale', 'recovery'] as const) {
      let state = createInitialRuntimeState({
        threadId: `thread-provider-${mode}`,
        userId: 'test',
        workspace: process.cwd(),
      });
      const harness = createTestModelInvocationHarnessV1({ workspace: process.cwd() });
      const fake = new FakeProviderV1(mode);
      const dispatched = dispatchAdmittedToolInvocationV1(admission.value, dispatchInput(harness), {
        threadId: `thread-provider-${mode}`,
        toolCallId: 'pipeline-task',
        persistence: {
          getState: () => state,
          persistEvents: async (events) => {
            for (const event of events) state = reduceRuntimeState(state, event);
            return true;
          },
        },
        subagentRuntimeFactory: () =>
          createPipelineSubagentRuntimeV1(() => ({
            grants: new SubagentGrantAuthorityV1({ idSource: () => `pipeline-${mode}` }),
            driver: new ChildRuntimeDriverV1(),
            provider: fake,
          })),
      });
      if (mode === 'deny') {
        expect(await dispatched).toMatchObject({
          kind: 'dispatched',
          value: { result: { ok: false } },
        });
      } else {
        await expect(dispatched).rejects.toMatchObject({
          name: 'ToolInvocationDispatchErrorV1',
          recorded: { attempt: 1 },
          causeValue: { name: 'SubagentProviderRecoveryRequiredErrorV1' },
        });
      }
      expect(fake.starts).toBe(1);
      expect(harness.events.filter((event) => event.type.startsWith('model.'))).toHaveLength(0);
    }
  });

  for (const mode of ['deny', 'crash', 'stale', 'recovery'] as const) {
    test(`${mode} never falls back to Local Provider or the legacy runner`, async () => {
      const harness = createTestModelInvocationHarnessV1({ workspace: process.cwd() });
      const fake = new FakeProviderV1(mode);
      const runtime = createPipelineSubagentRuntimeV1(() => ({
        grants: new SubagentGrantAuthorityV1({ idSource: () => `grant-${mode}` }),
        driver: new ChildRuntimeDriverV1(),
        provider: fake,
      }));
      const result = runTaskSubAgent(
        {
          config: {
            apiKey: 'unused',
            baseURL: 'https://example.invalid',
            providerName: 'fixture',
            modelName: 'fixture',
            providerType: 'openai-compatible',
            sandbox: { enabled: false },
          },
          workspace: process.cwd(),
          interactionMode: 'accept_edits',
          recoveryIdentityKey: '5'.repeat(64),
          model: createMockModel([{ message: aiMessage({ content: 'must not dispatch' }) }]),
          eventSink: () => {},
          modelInvocationGateway: harness.gateway,
          modelInvocationPersistence: harness.persistence,
          modelInvocationParentId: 'parent-model',
          modelInvocationParentToolCallId: 'parent-tool',
          subagentInvocationIdentity: {
            invocationId: 'parent-invocation',
            attempt: 1,
            capabilityRevision: digestCapability({ value: 'capability' }),
            authorizationDigest: digestCapability({ value: 'authorization' }),
            admissionDigest: digestCapability({ value: 'admission' }),
            effectiveEffectsDigest: digestCapability({ value: 'effects' }),
          },
          subagentRuntime: runtime,
        },
        { subagent_type: 'review', task: 'inspect' },
      );
      if (mode === 'deny') {
        expect(await result).toMatchObject({ ok: false, summary: 'denied' });
      } else {
        await expect(result).rejects.toBeInstanceOf(SubagentProviderRecoveryRequiredErrorV1);
      }
      expect(fake.starts).toBe(1);
      expect(fake.lastGrant).toMatchObject({
        purpose: 'start',
        parentInvocationId: 'parent-invocation',
        parentToolCallId: 'parent-tool',
        parentAttempt: 1,
      });
      expect(harness.events.filter((event) => event.type.startsWith('model.'))).toHaveLength(0);
      if (mode === 'recovery') expect(fake.cancels).toBe(1);
    });
  }

  test('binds actor-local start and resume cursors to the exact replay suite authority', async () => {
    const recordSource = {
      mode: 'record' as const,
      attempt: async () => {
        throw new Error('model source must not run');
      },
    };
    const fixtureDigest = `sha256:${'1'.repeat(64)}` as const;
    const bindingFor = (
      actor: import('@/protocol/model-surface').ModelReplayActorIdentityV1,
      ordinal: number,
      replayDigest: `sha256:${string}` | null = null,
    ) => ({
      suiteId: 'subagent-suite',
      suiteRevision: 1,
      fixtureDigest,
      actor,
      logicalInvocationOrdinal: ordinal,
      replayDigest,
    });
    const base = bindingFor(
      {
        kind: 'subagent',
        parentToolCallId: 'parent-tool',
        subagentId: 'child',
        continuationId: null,
      },
      1,
    );
    expect(subagentReplayContextDigestV1('record', base)).not.toBe(
      subagentReplayContextDigestV1('record', { ...base, suiteRevision: 2 }),
    );
    expect(subagentReplayContextDigestV1('record', base)).not.toBe(
      subagentReplayContextDigestV1('record', {
        ...base,
        fixtureDigest: `sha256:${'2'.repeat(64)}`,
      }),
    );
    expect(subagentReplayContextDigestV1('record', base)).not.toBe(
      subagentReplayContextDigestV1('record', {
        ...base,
        replayDigest: `sha256:${'3'.repeat(64)}`,
      }),
    );

    for (const [label, drift] of [
      ['suite', (value: ReturnType<typeof bindingFor>) => ({ ...value, suiteRevision: 2 })],
      [
        'fixture',
        (value: ReturnType<typeof bindingFor>) => ({
          ...value,
          fixtureDigest: `sha256:${'2'.repeat(64)}` as const,
        }),
      ],
      [
        'replay',
        (value: ReturnType<typeof bindingFor>) => ({
          ...value,
          replayDigest: `sha256:${'3'.repeat(64)}` as const,
        }),
      ],
    ] as const) {
      let sourceAttempts = 0;
      const source = {
        mode: 'record' as const,
        attempt: async () => {
          sourceAttempts += 1;
          throw new Error('drifted replay authority reached the model source');
        },
      };
      const harness = createTestModelInvocationHarnessV1({ workspace: process.cwd(), source });
      const invocationId = `drift-parent-${label}`;
      const task = `inspect ${label} replay drift`;
      const childInvocationId = `subagent-${digestCapability({
        schema: 'kite.subagent-child-identity.v1',
        parentInvocationId: invocationId,
        parentAttempt: 1,
        parentToolCallId: 'parent-tool',
        role: 'review',
        task,
      })}`;
      let bindingCalls = 0;
      const result = await runTaskSubAgent(
        {
          config: {
            apiKey: 'unused',
            baseURL: 'https://example.invalid',
            providerName: 'fixture',
            modelName: 'fixture',
            providerType: 'openai-compatible',
            sandbox: { enabled: false },
          },
          workspace: process.cwd(),
          interactionMode: 'accept_edits',
          recoveryIdentityKey: '5'.repeat(64),
          eventSink: () => {},
          model: createMockModel([{ message: aiMessage({ content: 'must not dispatch' }) }]),
          modelInvocationGateway: harness.gateway,
          modelInvocationPersistence: harness.persistence,
          modelInvocationParentId: 'parent-model',
          modelInvocationParentToolCallId: 'parent-tool',
          modelReplayBinding: (ordinal) => {
            bindingCalls += 1;
            const value = bindingFor(
              {
                kind: 'subagent',
                parentToolCallId: 'parent-tool',
                subagentId: childInvocationId,
                continuationId: null,
              },
              ordinal,
            );
            return bindingCalls === 1 ? value : drift(value);
          },
          subagentInvocationIdentity: {
            invocationId,
            attempt: 1,
            capabilityRevision: digestCapability({ value: 'capability' }),
            authorizationDigest: digestCapability({ value: 'authorization' }),
            admissionDigest: digestCapability({ value: 'admission' }),
            effectiveEffectsDigest: digestCapability({ value: 'effects' }),
          },
          subagentRuntime: createPipelineSubagentRuntimeV1(),
        },
        { subagent_type: 'review', task },
      );
      expect(result).toMatchObject({ ok: false, terminalStatus: 'failed' });
      expect(bindingCalls).toBeGreaterThanOrEqual(2);
      expect(sourceAttempts).toBe(0);
      expect(harness.events.some((event) => event.type === 'model.requested')).toBe(false);
    }

    const siblingOrdinals: number[][] = [[], []];
    for (const sibling of [0, 1]) {
      const harness = createTestModelInvocationHarnessV1({
        workspace: process.cwd(),
        source: recordSource,
      });
      const fake = new FakeProviderV1('deny');
      const invocationId = `parent-invocation-${sibling}`;
      const task = `inspect sibling ${sibling}`;
      const childInvocationId = `subagent-${digestCapability({
        schema: 'kite.subagent-child-identity.v1',
        parentInvocationId: invocationId,
        parentAttempt: 1,
        parentToolCallId: 'parent-tool',
        role: 'review',
        task,
      })}`;
      await runTaskSubAgent(
        {
          config: { providerName: 'fixture', modelName: 'fixture' } as never,
          workspace: process.cwd(),
          interactionMode: 'accept_edits',
          eventSink: () => {},
          modelInvocationGateway: harness.gateway,
          modelInvocationPersistence: harness.persistence,
          modelInvocationParentId: 'parent-model',
          modelInvocationParentToolCallId: 'parent-tool',
          modelReplayBinding: (ordinal) => {
            siblingOrdinals[sibling]!.push(ordinal);
            return bindingFor(
              {
                kind: 'subagent',
                parentToolCallId: 'parent-tool',
                subagentId: childInvocationId,
                continuationId: null,
              },
              ordinal,
            );
          },
          subagentInvocationIdentity: {
            invocationId,
            attempt: 1,
            capabilityRevision: digestCapability({ value: 'capability' }),
            authorizationDigest: digestCapability({ value: 'authorization' }),
            admissionDigest: digestCapability({ value: 'admission' }),
            effectiveEffectsDigest: digestCapability({ value: 'effects' }),
          },
          subagentRuntime: createPipelineSubagentRuntimeV1(() => ({
            grants: new SubagentGrantAuthorityV1(),
            driver: new ChildRuntimeDriverV1(),
            provider: fake,
          })),
        },
        { subagent_type: 'review', task },
      );
    }
    expect(siblingOrdinals).toEqual([[1], [1]]);

    const harness = createTestModelInvocationHarnessV1({
      workspace: process.cwd(),
      source: recordSource,
    });
    const fake = new FakeProviderV1('crash');
    const continuation = {
      id: 'child-resume',
      role: getRoleConfig('review'),
      task: 'resume exact child',
      messages: [],
      toolCallCount: 1,
      modelInvocationOrdinal: 4,
      steps: [],
      toolRecovery: createToolRecoveryJournalV1('4'.repeat(64)),
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' as const,
        toolCallId: 'blocked-tool',
        runtimeToolCallId: 'blocked-runtime-tool',
        toolName: 'shell_execute',
        args: { command: 'pwd' },
        command: 'pwd',
      },
    };
    const snapshot = serializeSubagentContinuation(continuation, continuation.blockedTool);
    const continuationId = subagentContinuationCursorIdV1(snapshot);
    const resumeOrdinals: number[] = [];
    await expect(
      resumeTaskSubAgentV1(
        {
          config: { providerName: 'fixture', modelName: 'fixture' } as never,
          workspace: process.cwd(),
          interactionMode: 'accept_edits',
          eventSink: () => {},
          modelInvocationGateway: harness.gateway,
          modelInvocationPersistence: harness.persistence,
          modelInvocationParentId: 'parent-model-resume',
          modelInvocationParentToolCallId: 'parent-tool',
          modelReplayBinding: (ordinal) => {
            resumeOrdinals.push(ordinal);
            return bindingFor(
              {
                kind: 'subagent',
                parentToolCallId: 'parent-tool',
                subagentId: continuation.id,
                continuationId,
              },
              ordinal,
            );
          },
          subagentInvocationIdentity: {
            invocationId: 'parent-resume',
            attempt: 2,
            capabilityRevision: digestCapability({ value: 'capability' }),
            authorizationDigest: digestCapability({ value: 'authorization' }),
            admissionDigest: digestCapability({ value: 'admission' }),
            effectiveEffectsDigest: digestCapability({ value: 'effects' }),
          },
          subagentRuntime: createPipelineSubagentRuntimeV1(() => ({
            grants: new SubagentGrantAuthorityV1(),
            driver: new ChildRuntimeDriverV1(),
            provider: fake,
          })),
        },
        continuation,
        {
          toolCallId: 'blocked-tool',
          toolName: 'shell_execute',
          result: { ok: true, command: 'pwd', exitCode: 0, stdout: '', stderr: '' },
        },
      ),
    ).rejects.toBeInstanceOf(SubagentProviderRecoveryRequiredErrorV1);
    expect(resumeOrdinals).toEqual([5]);
    expect(fake.lastResumeGrant).toMatchObject({
      continuationId,
      childInvocationId: continuation.id,
      blockedRuntimeToolCallId: 'blocked-runtime-tool',
    });
    expect(harness.events.filter((event) => event.type.startsWith('model.'))).toHaveLength(0);
  });
});
