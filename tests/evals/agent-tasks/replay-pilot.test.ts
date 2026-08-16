import { describe, expect, test } from 'bun:test';
import { StrictModelReplayCatalogV1 } from '@/core/model/replay-catalog';
import { createReplayModelResponseSourceV1 } from '@/core/model/response-source';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import { createDeterministicRuntimeIdSourceV1 } from '@/core/runtime/id-source';
import type { ModelReplayActorIdentityV1 } from '@/protocol/model-surface';
import {
  createReplayWorkspaceNormalizerV1,
  MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1,
  MODEL_REPLAY_PILOT_AUTHORITY_V1,
  MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1,
  MODEL_REPLAY_PILOT_EXPECTED_REPORT_DIGEST_V1,
  MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
} from '../../../scripts/evals/contracts/model-replay-pilot';
import { sha256Digest } from '../../../scripts/release/canonical-json';
import { createTestModelInvocationHarnessV1 } from '../../helpers/model-invocation';
import {
  compileReplayPilotSurfaceV1,
  type ReplayPilotSemanticMutationV1,
  readReplayPilotCatalogV1,
  replayPilotBindingV1,
  runDeterministicModelReplayPilotV1,
} from './replay-pilot';

const PARENT = Object.freeze({ kind: 'parent' as const });

describe('RP-02 deterministic keyless replay pilot', () => {
  test('freezes candidate-only suite, fixture, cassette, oracle and catalog identity', () => {
    const { catalog, digest } = readReplayPilotCatalogV1();
    expect(MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1).toBe(
      'sha256:f6374383352a28476a09bd8242f1932e3055d02494d9f1ebbd575dfabd6eff54',
    );
    expect(digest).toBe(MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1);
    expect(catalog.suite).toEqual({
      suiteId: MODEL_REPLAY_PILOT_AUTHORITY_V1.suiteId,
      suiteRevision: MODEL_REPLAY_PILOT_AUTHORITY_V1.suiteRevision,
      fixtureDigest: MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
    });
    expect(catalog.catalogRevision).toBe(MODEL_REPLAY_PILOT_AUTHORITY_V1.catalogRevision);
    expect(catalog.records).toHaveLength(MODEL_REPLAY_PILOT_AUTHORITY_V1.catalogRecordCount);
    expect(catalog.records.every((record) => record.replayDigest === null)).toBe(true);
    expect(MODEL_REPLAY_PILOT_AUTHORITY_V1).toMatchObject({
      status: 'deterministic_pilot',
      evidenceEligible: false,
      replayGate: 'disabled',
      recordAuthorization: 'denied',
    });
  });

  test('replays twice with reversed concurrent child scheduling and exact canonical equality', async () => {
    const [first, second] = await Promise.all([
      runDeterministicModelReplayPilotV1({ childSchedule: 'ab' }),
      runDeterministicModelReplayPilotV1({ childSchedule: 'ba' }),
    ]);
    expect(first.canonicalDigest).toBe(MODEL_REPLAY_PILOT_EXPECTED_REPORT_DIGEST_V1);
    expect(second.canonicalDigest).toBe(first.canonicalDigest);
    expect(second.runtime.canonicalTerminals).toEqual(first.runtime.canonicalTerminals);
    expect(second.runtime.canonicalReceipts).toEqual(first.runtime.canonicalReceipts);
    expect(first).toMatchObject({
      actorCursor: {
        parentLogicalInvocations: 4,
        concurrentChildren: ['pilot-child-a', 'pilot-child-b'],
        allRecordsConsumed: true,
      },
      runtime: {
        completed: true,
        modelAttempts: 4,
        toolTerminals: 2,
        recoveryObserved: true,
        verificationPassed: true,
      },
      oracle: { passed: true, digest: MODEL_REPLAY_PILOT_AUTHORITY_V1.expectedOracleDigest },
      privacy: {
        apiKeyRead: false,
        providerTransportAttempts: 0,
        networkAttempts: 0,
        unboundHostPaths: 0,
      },
      cleanup: { ownedRootRemoved: true, residualProcesses: 0, residualWorktrees: 0 },
    });
  });

  test('fails closed when prompt, tool schema, prior tool output or fixture binding changes', async () => {
    for (const [mutation, ordinal] of [
      ['prompt', 1],
      ['schema', 1],
      ['tool_output', 2],
    ] as const satisfies ReadonlyArray<readonly [ReplayPilotSemanticMutationV1, number]>) {
      await expect(invokeOne(PARENT, ordinal, { mutation })).rejects.toMatchObject({
        code: 'MODEL_REPLAY_MISS',
      });
    }
    await expect(
      invokeOne(PARENT, 1, { fixtureDigest: `sha256:${'9'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'MODEL_REPLAY_MISS' });
  });

  test('normalizes only bound workspace roots and keeps per-scope deterministic identity', () => {
    const first = createReplayWorkspaceNormalizerV1({
      workspace: process.cwd(),
      processCwd: process.cwd(),
    });
    const value = {
      path: `${process.cwd()}/src/example.ts`,
      nested: [`${process.cwd()}/README.md`],
    };
    expect(first.normalize(value)).toEqual({
      path: '<process-cwd>/src/example.ts',
      nested: ['<process-cwd>/README.md'],
    });
    expect(first.digest(value)).toBe(first.digest(structuredClone(value)));
    const unbound = ['', 'Users', 'outside', 'secret.txt'].join('/');
    expect(() => first.normalize({ path: unbound })).toThrow('unbound absolute path');
    const sparse = new Array(1);
    expect(() => first.normalize(sparse)).toThrow('sparse or extended arrays');
    const accessor = Object.defineProperty({}, 'path', { enumerable: true, get: () => 'value' });
    expect(() => first.normalize(accessor)).toThrow('accessors and hidden fields');
    expect(() => first.normalize({ [Symbol('hidden')]: 'value' })).toThrow('symbol fields');

    const left = createDeterministicRuntimeIdSourceV1({ seed: 'pilot-id', epochMs: 10 });
    const right = createDeterministicRuntimeIdSourceV1({ seed: 'pilot-id', epochMs: 10 });
    expect([
      left.next('model_invocation'),
      left.next('kernel_effect'),
      left.next('model_invocation'),
    ]).toEqual([
      right.next('model_invocation'),
      right.next('kernel_effect'),
      right.next('model_invocation'),
    ]);
    expect(left.next('kernel_effect')).toBe('pilot-id-kernel-effect-0002');
    expect([left.now(), left.now()]).toEqual([10, 11]);
  });

  test('rejects cassette secrets and host paths without echoing the unsafe value', () => {
    const { catalog } = readReplayPilotCatalogV1();
    const secret = ['sk', 'proj', '0123456789abcdefghijklmnopqrstuvwxyz'].join('-');
    const poisoned = structuredClone(catalog);
    const first = poisoned.records[0]!;
    if (first.outcome.kind !== 'success') throw new Error('Pilot success outcome is unavailable.');
    first.outcome.response.message.content = [{ type: 'text', text: secret }];
    expect(() => StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(poisoned))).toThrow(
      'MODEL_REPLAY_CORRUPT',
    );
    try {
      StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(poisoned));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

async function invokeOne(
  actor: ModelReplayActorIdentityV1,
  ordinal: number,
  options: {
    mutation?: ReplayPilotSemanticMutationV1;
    fixtureDigest?: `sha256:${string}`;
  },
) {
  const { catalog } = readReplayPilotCatalogV1();
  const strict = new StrictModelReplayCatalogV1(catalog);
  const harness = createTestModelInvocationHarnessV1({
    workspace: '<workspace>',
    source: createReplayModelResponseSourceV1(strict),
    runtimeIdSource: createDeterministicRuntimeIdSourceV1({
      seed: 'pilot-mismatch',
      epochMs: 946684800000,
    }),
  });
  return harness.gateway.invoke({
    compiled: compileReplayPilotSurfaceV1({
      actor,
      logicalInvocationOrdinal: ordinal,
      mutation: options.mutation,
    }),
    persistence: harness.persistence,
    provenance: {
      promptContractVersion: 'replay-pilot-prompt-v1',
      projectionEnvironmentDigest: sha256Digest('pilot-projection'),
      capabilityBindingDigest: sha256Digest('pilot-capability-bindings'),
    },
    providerDataPolicyRequired: false,
    resourceKind: 'model',
    replayBinding: replayPilotBindingV1({
      actor,
      logicalInvocationOrdinal: ordinal,
      fixtureDigest: options.fixtureDigest,
    }),
    limits: { maxAttempts: 1, perAttemptTimeoutMs: 5_000, totalTimeBudgetMs: 5_000 },
  });
}
