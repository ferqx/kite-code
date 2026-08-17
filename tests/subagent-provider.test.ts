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
import type { SubagentLifecycleArtifactAccessV1 } from '@/core/persistence/subagent-lifecycle-artifacts';
import {
  type SubagentTaskArtifactAccessV1,
  subagentTaskDigestV1,
} from '@/core/persistence/subagent-task-artifacts';
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

const TEST_TASK = 'task';
const TEST_TASK_DIGEST = subagentTaskDigestV1(TEST_TASK);
const TEST_TASK_REF = Object.freeze({
  artifactId: `pa_${'1'.repeat(64)}`,
  kind: 'subagent_task' as const,
  integrityIdentifier: `hmac-sha256:${'2'.repeat(64)}`,
  byteLength: 256,
});
let testStoredTask = TEST_TASK;
const TEST_TASK_ARTIFACTS: SubagentTaskArtifactAccessV1 = {
  write: ({ task }) => {
    testStoredTask = task;
    return { ref: TEST_TASK_REF, taskDigest: subagentTaskDigestV1(task) };
  },
  read: (_ref, expected) => ({
    artifactFormatVersion: 1,
    owner: {
      parentInvocationId: expected.parentInvocationId,
      parentAttempt: expected.parentAttempt,
      parentToolCallId: expected.parentToolCallId,
      childInvocationId: expected.childInvocationId,
    },
    task: testStoredTask,
    taskDigest: subagentTaskDigestV1(testStoredTask),
    taskByteLength: Buffer.byteLength(testStoredTask),
  }),
};
const TEST_HANDLE_REF = Object.freeze({
  artifactId: `pa_${'3'.repeat(64)}`,
  kind: 'subagent_handle' as const,
  integrityIdentifier: `hmac-sha256:${'4'.repeat(64)}`,
  byteLength: 512,
});
let testStoredHandle: SubagentHandleV1 | undefined;
const TEST_LIFECYCLE_ARTIFACTS: SubagentLifecycleArtifactAccessV1 = {
  write: (value) => {
    testStoredHandle = value;
    return TEST_HANDLE_REF;
  },
  read: () => {
    if (!testStoredHandle) throw new Error('missing fixture handle');
    return testStoredHandle;
  },
};

function lifecyclePersistence(
  invocationId: string,
  attempt = 1,
  reject?: (events: import('@/core/runtime/events').RuntimeEvent[]) => boolean,
) {
  let state = createInitialRuntimeState({
    threadId: `lifecycle-${invocationId}`,
    userId: 'test',
    workspace: process.cwd(),
  });
  state.capabilities.invocations[invocationId] = {
    invocationId,
    toolCallId: 'parent-tool',
    capabilityId: 'builtin:task',
    capabilityRevision: digestCapability({ value: 'capability' }),
    argumentsDigest: digestCapability({ value: 'arguments' }),
    authorizationDigest: digestCapability({ value: 'authorization' }),
    admissionDigest: digestCapability({ value: 'admission' }),
    effectiveEffectsDigest: digestCapability({ value: 'effects' }),
    status: 'running',
    recordedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    attemptsStarted: attempt,
  };
  return {
    getState: () => state,
    persistEvents: async (events: import('@/core/runtime/events').RuntimeEvent[]) => {
      if (reject?.(events)) return false;
      for (const event of events) state = reduceRuntimeState(state, event);
      return true;
    },
  };
}

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
    taskArtifact: TEST_TASK_REF,
    taskDigest: TEST_TASK_DIGEST,
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
      executionBoundaryDigest: `sha256:${hash('boundary')}`,
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
      abandon: () => true,
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProviderV1(
      authority.verifier(),
      driver,
      TEST_TASK_ARTIFACTS,
      () => 'handle-1',
    );
    const grant = authority.issueStart(binding());
    const started = await provider.start({ grant });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await provider.activate({ handle: started.value })).toMatchObject({ ok: true });
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
    const expiredProvider = new LocalSubagentProviderV1(
      expiring.verifier(),
      driver,
      TEST_TASK_ARTIFACTS,
    );
    expect(await expiredProvider.start({ grant: expiredGrant })).toMatchObject({
      ok: false,
      failure: { code: 'expired_grant' },
    });
  });

  test('bounds consumed-grant tombstones without replaying a still-valid grant', () => {
    let now = 0;
    let ordinal = 0;
    const authority = new SubagentGrantAuthorityV1({
      key: new Uint8Array(32).fill(8),
      now: () => now,
      ttlMs: 10,
      maxConsumedGrantTombstones: 2,
      idSource: () => `bounded-grant-${++ordinal}`,
    });
    const verifier = authority.verifier();
    const first = authority.issueStart({ ...binding(), childInvocationId: 'bounded-child-1' });
    const second = authority.issueStart({ ...binding(), childInvocationId: 'bounded-child-2' });
    const waiting = authority.issueStart({ ...binding(), childInvocationId: 'bounded-child-3' });

    verifier.verifyAndConsumeStart(first);
    verifier.verifyAndConsumeStart(second);
    expect(() => verifier.verifyAndConsumeStart(first)).toThrow('already consumed');
    expect(() => verifier.verifyAndConsumeStart(waiting)).toThrow(
      'tombstone capacity is exhausted',
    );

    // Valid tombstones are never evicted. Once their sealed grants expire,
    // the bounded ledger can reclaim them and admit a fresh grant.
    now = 10;
    const fresh = authority.issueStart({ ...binding(), childInvocationId: 'bounded-child-4' });
    expect(verifier.verifyAndConsumeStart(fresh).grantId).toBe(fresh.grantId);
  });

  test('uses a non-decreasing grant clock so rollback cannot revive an expired grant', () => {
    let now = 0;
    const authority = new SubagentGrantAuthorityV1({
      key: new Uint8Array(32).fill(10),
      now: () => now,
      ttlMs: 10,
      idSource: () => 'grant-clock-rollback',
    });
    const verifier = authority.verifier();
    const grant = authority.issueStart({ ...binding(), childInvocationId: 'clock-rollback-child' });
    verifier.verifyAndConsumeStart(grant);

    now = 11;
    expect(() => verifier.verifyAndConsumeStart(grant)).toThrow('expired');
    // The consumed tombstone was pruned at the high-water expiry boundary;
    // the monotonic effective clock still rejects the old sealed grant.
    now = 1;
    expect(() => verifier.verifyAndConsumeStart(grant)).toThrow('expired');
  });

  test('discards only exact pre-activation start and resume Driver registrations', () => {
    let ordinal = 0;
    const authority = new SubagentGrantAuthorityV1({ idSource: () => `discard-${++ordinal}` });
    const startGrant = authority.issueStart(binding());
    const resumeGrant = authority.issueResume({
      ...binding(),
      childInvocationId: 'child-resume-discard',
      continuationId: 'continuation-discard',
      continuationDigest: digestCapability({ value: 'continuation-discard' }),
      blockedToolCallId: 'blocked-model-discard',
      blockedRuntimeToolCallId: 'blocked-runtime-discard',
      resumeAttempt: 2,
    });
    const registrationInput = (grant: SubagentDelegationGrantV1 | SubagentResumeGrantV1) =>
      ({
        childInvocationId: grant.childInvocationId,
        modelInvocationParentToolCallId: grant.parentToolCallId,
        subagentGrantContext: {
          parentInvocationId: grant.parentInvocationId,
          attempt: grant.parentAttempt,
        },
      }) as never;
    const driver = new ChildRuntimeDriverV1();
    driver.registerStart(startGrant.grantId, { input: registrationInput(startGrant) });
    driver.registerResume(resumeGrant.grantId, {
      input: registrationInput(resumeGrant),
      continuation: {},
      toolResult: {},
    } as never);
    expect(driver.pendingRegistrationCountV1()).toBe(2);
    expect(driver.abandon({ ...startGrant, childInvocationId: 'wrong-child' })).toBe(false);
    expect(driver.pendingRegistrationCountV1()).toBe(2);
    expect(driver.abandon(startGrant)).toBe(true);
    expect(driver.abandon(resumeGrant)).toBe(true);
    expect(driver.pendingRegistrationCountV1()).toBe(0);

    let now = 0;
    const bounded = new ChildRuntimeDriverV1({ now: () => now, maxPendingRegistrations: 1 });
    bounded.registerStart('expired-registration', {
      input: registrationInput(startGrant),
      expiresAtMs: 1,
    });
    now = 1;
    expect(bounded.pendingRegistrationCountV1()).toBe(0);
    bounded.registerStart('live-registration', {
      input: registrationInput(startGrant),
      expiresAtMs: 10,
    });
    expect(() =>
      bounded.registerResume('over-capacity', {
        input: registrationInput(resumeGrant),
        continuation: {},
        toolResult: {},
        expiresAtMs: 10,
      } as never),
    ).toThrow('capacity is exhausted');

    for (const expiresAtMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 5 * 60_000 + 1]) {
      const strict = new ChildRuntimeDriverV1({ now: () => 0 });
      expect(() =>
        strict.registerStart(`invalid-expiry-${String(expiresAtMs)}`, {
          input: registrationInput(startGrant),
          expiresAtMs,
        }),
      ).toThrow('expiry is invalid');
    }
    const overflow = new ChildRuntimeDriverV1({
      now: () => Number.MAX_SAFE_INTEGER - 1,
    });
    expect(() =>
      overflow.registerStart('overflow-expiry', {
        input: registrationInput(startGrant),
      }),
    ).toThrow('expiry is invalid');
  });

  test('rejects a tampered grant and stale or identity-mutated handles', async () => {
    const authority = new SubagentGrantAuthorityV1({ idSource: () => 'grant-2' });
    const driver: LocalSubagentLifecycleDriverV1 = {
      abandon: () => true,
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProviderV1(
      authority.verifier(),
      driver,
      TEST_TASK_ARTIFACTS,
      () => 'handle-2',
    );
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
    expect(await provider.activate({ handle: started.value })).toMatchObject({ ok: true });
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
        abandon: () => true,
        start: async () => {
          throw new Error('boom');
        },
        resume: async () => {
          throw new Error('boom');
        },
      },
      TEST_TASK_ARTIFACTS,
      () => 'handle-crash',
    );
    const crashStart = await crashProvider.start({ grant: crashAuthority.issueStart(binding()) });
    expect(crashStart.ok).toBe(true);
    if (crashStart.ok) {
      expect(await crashProvider.activate({ handle: crashStart.value })).toMatchObject({
        ok: true,
      });
      expect(await crashProvider.observe({ handle: crashStart.value })).toMatchObject({
        ok: false,
        failure: { code: 'driver_crashed' },
      });
    }

    const largeAuthority = new SubagentGrantAuthorityV1({ idSource: () => 'grant-large' });
    const largeProvider = new LocalSubagentProviderV1(
      largeAuthority.verifier(),
      {
        abandon: () => true,
        start: async (grant) => ({
          ...driverResult(grant.childInvocationId),
          privatePayload: { value: 'x'.repeat(4 * 1024 * 1024) },
        }),
        resume: async (grant) => driverResult(grant.childInvocationId),
      },
      TEST_TASK_ARTIFACTS,
      () => 'handle-large',
    );
    const largeStart = await largeProvider.start({ grant: largeAuthority.issueStart(binding()) });
    expect(largeStart.ok).toBe(true);
    if (largeStart.ok) {
      expect(await largeProvider.activate({ handle: largeStart.value })).toMatchObject({
        ok: true,
      });
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
      abandon: () => true,
      start: async (grant, _task, signal) =>
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
      TEST_TASK_ARTIFACTS,
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
      expect(await provider.activate({ handle: resumed.value })).toMatchObject({ ok: true });
      expect(await provider.observe({ handle: resumed.value })).toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
    }

    const startGrant = authority.issueStart({ ...binding(), childInvocationId: 'child-cancel' });
    const started = await provider.start({ grant: startGrant });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(await provider.activate({ handle: started.value })).toMatchObject({ ok: true });
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
        abandon: () => true,
        start: async () => never,
        resume: async () => never,
      },
      TEST_TASK_ARTIFACTS,
      () => 'handle-leak',
      10,
    );
    const started = await provider.start({ grant: authority.issueStart(binding()) });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await provider.activate({ handle: started.value })).toMatchObject({ ok: true });
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
    expect(await provider.reconcile({ handle: started.value })).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });
  });

  test('keeps an unconfirmed hint fail-closed across expiry and clock rollback', async () => {
    let now = 100;
    let grantOrdinal = 0;
    let handleOrdinal = 0;
    const authority = new SubagentGrantAuthorityV1({
      now: () => now,
      idSource: () => `grant-unconfirmed-clock-${++grantOrdinal}`,
    });
    const never = new Promise<ReturnType<typeof driverResult>>(() => {});
    const provider = new LocalSubagentProviderV1(
      authority.verifier(),
      {
        abandon: () => true,
        start: async () => never,
        resume: async () => never,
      },
      TEST_TASK_ARTIFACTS,
      () => `handle-unconfirmed-clock-${++handleOrdinal}`,
      1,
      { now: () => now, tombstoneTtlMs: 10, maxProviderTombstones: 4 },
    );
    const started = await provider.start({
      grant: authority.issueStart({ ...binding(), childInvocationId: 'unconfirmed-clock-child' }),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await provider.activate({ handle: started.value })).toMatchObject({ ok: true });
    const controller = new AbortController();
    const observing = provider.observe({ handle: started.value, signal: controller.signal });
    controller.abort('clock rollback cleanup');
    expect(await observing).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });

    expect(await provider.reconcile({ handle: started.value })).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });
    now = 110;
    expect(await provider.reconcile({ handle: started.value })).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });
    now = 101;
    expect(await provider.reconcile({ handle: started.value })).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });
  });

  test('rejects non-finite or unsafe Provider and Driver clocks', () => {
    const authority = new SubagentGrantAuthorityV1();
    const driver: LocalSubagentLifecycleDriverV1 = {
      abandon: () => true,
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(
        () =>
          new LocalSubagentProviderV1(
            authority.verifier(),
            driver,
            TEST_TASK_ARTIFACTS,
            undefined,
            10,
            { now: () => clock },
          ),
      ).toThrow('clock is invalid');
      expect(() => new ChildRuntimeDriverV1({ now: () => clock })).toThrow('clock is invalid');
    }

    const overflowAuthority = new SubagentGrantAuthorityV1({
      now: () => Number.MAX_SAFE_INTEGER,
    });
    expect(() => overflowAuthority.issueStart(binding())).toThrow('expiry is invalid');
  });

  test('bounds same-process Provider lifecycle tombstones and fails closed after eviction', async () => {
    let now = 100;
    let grantOrdinal = 0;
    let handleOrdinal = 0;
    const authority = new SubagentGrantAuthorityV1({
      now: () => now,
      idSource: () => `grant-bounded-provider-${++grantOrdinal}`,
    });
    const provider = new LocalSubagentProviderV1(
      authority.verifier(),
      {
        abandon: () => true,
        start: async (grant) => driverResult(grant.childInvocationId),
        resume: async (grant) => driverResult(grant.childInvocationId),
      },
      TEST_TASK_ARTIFACTS,
      () => `handle-bounded-provider-${++handleOrdinal}`,
      10,
      { now: () => now, tombstoneTtlMs: 10, maxProviderTombstones: 1 },
    );

    const finish = async (childInvocationId: string) => {
      const started = await provider.start({
        grant: authority.issueStart({ ...binding(), childInvocationId }),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error('bounded Provider fixture did not start');
      expect(await provider.activate({ handle: started.value })).toMatchObject({ ok: true });
      expect(await provider.observe({ handle: started.value })).toMatchObject({ ok: true });
      return started.value;
    };

    const first = await finish('bounded-provider-child-1');
    const second = await finish('bounded-provider-child-2');
    expect(await provider.reconcile({ handle: first })).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
    });
    expect(await provider.reconcile({ handle: second })).toMatchObject({
      ok: true,
      value: { status: 'stopped', cleanupConfirmed: true },
    });

    now += 10;
    expect(await provider.reconcile({ handle: second })).toMatchObject({
      ok: false,
      failure: { code: 'recovery_required' },
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
  async activate() {
    return { ok: true, value: { activated: true as const } } as const;
  }
  async cancel() {
    this.cancels += 1;
    return { ok: true, value: { cancelled: true as const } } as const;
  }
  async reconcile() {
    return {
      ok: false,
      failure: { code: 'recovery_required' as const, message: 'fixture recovery required' },
    } as const;
  }
}

function handle(grant: SubagentDelegationGrantV1 | SubagentResumeGrantV1): SubagentHandleV1 {
  return {
    schema: SUBAGENT_PROVIDER_SCHEMA_V1,
    handleId: `handle-${grant.grantId}`,
    grantId: grant.grantId,
    purpose: grant.purpose,
    childInvocationId: grant.childInvocationId,
    parentInvocationId: grant.parentInvocationId,
    parentToolCallId: grant.parentToolCallId,
    parentAttempt: grant.parentAttempt,
    role: grant.role,
    taskArtifact: grant.taskArtifact,
    taskDigest: grant.taskDigest,
    continuationId: grant.purpose === 'resume' ? grant.continuationId : null,
    continuationDigest: grant.purpose === 'resume' ? grant.continuationDigest : null,
    blockedToolCallId: grant.purpose === 'resume' ? grant.blockedToolCallId : null,
    blockedRuntimeToolCallId: grant.purpose === 'resume' ? grant.blockedRuntimeToolCallId : null,
    resumeAttempt: grant.purpose === 'resume' ? grant.resumeAttempt : null,
    ownerProcessId: process.pid,
    ownerProcessStartIdentity: 'fixture-process-start',
    providerInstanceId: 'fixture-provider',
    lifecycle: 'running',
    integrityIdentifier: `hmac-sha256:${'5'.repeat(64)}`,
  };
}

describe('Pipeline-owned Fake Provider negatives', () => {
  test('releases the exact Driver registration when intent or handle-ready ack fails', async () => {
    for (const rejectedType of [
      'capability.subagent_dispatch_intent_recorded',
      'capability.subagent_handle_recorded',
    ] as const) {
      const invocationId = `registration-${rejectedType}`;
      const harness = createTestModelInvocationHarnessV1({ workspace: process.cwd() });
      const grants = new SubagentGrantAuthorityV1({ idSource: () => `grant-${rejectedType}` });
      const driver = new ChildRuntimeDriverV1();
      const provider = new LocalSubagentProviderV1(
        grants.verifier(),
        driver,
        TEST_TASK_ARTIFACTS,
        () => `handle-${rejectedType}`,
      );
      await expect(
        runTaskSubAgent(
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
            subagentLifecyclePersistence: lifecyclePersistence(invocationId, 1, (events) =>
              events.some((event) => event.type === rejectedType),
            ),
            modelInvocationParentId: 'parent-model',
            modelInvocationParentToolCallId: 'parent-tool',
            subagentInvocationIdentity: {
              invocationId,
              attempt: 1,
              capabilityRevision: digestCapability({ value: 'capability' }),
              authorizationDigest: digestCapability({ value: 'authorization' }),
              admissionDigest: digestCapability({ value: 'admission' }),
              effectiveEffectsDigest: digestCapability({ value: 'effects' }),
            },
            subagentRuntime: createPipelineSubagentRuntimeV1(() => ({
              grants,
              driver,
              provider,
              taskArtifacts: TEST_TASK_ARTIFACTS,
              lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
            })),
          },
          { subagent_type: 'review', task: `inspect ${rejectedType}` },
        ),
      ).rejects.toBeInstanceOf(SubagentProviderRecoveryRequiredErrorV1);
      expect(driver.pendingRegistrationCountV1()).toBe(0);
      expect(harness.events.filter((event) => event.type.startsWith('model.'))).toHaveLength(0);
    }
  });

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
      privateSubagentTask: {
        source: 'legacy_v24' as const,
        payload: args,
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
            taskArtifacts: TEST_TASK_ARTIFACTS,
            lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
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
      let registeredDriver: ChildRuntimeDriverV1 | undefined;
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
          createPipelineSubagentRuntimeV1(() => {
            const driver = new ChildRuntimeDriverV1();
            registeredDriver = driver;
            return {
              grants: new SubagentGrantAuthorityV1({ idSource: () => `pipeline-${mode}` }),
              driver,
              provider: fake,
              taskArtifacts: TEST_TASK_ARTIFACTS,
              lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
            };
          }),
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
      expect(registeredDriver?.pendingRegistrationCountV1()).toBe(0);
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
        taskArtifacts: TEST_TASK_ARTIFACTS,
        lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
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
          subagentLifecyclePersistence: lifecyclePersistence('parent-invocation'),
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
          subagentLifecyclePersistence: lifecyclePersistence(invocationId),
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
          subagentRuntime: (() => {
            const grants = new SubagentGrantAuthorityV1({ idSource: () => 'drift-grant' });
            const driver = new ChildRuntimeDriverV1();
            const provider = new LocalSubagentProviderV1(
              grants.verifier(),
              driver,
              TEST_TASK_ARTIFACTS,
            );
            return createPipelineSubagentRuntimeV1(() => ({
              grants,
              driver,
              provider,
              taskArtifacts: TEST_TASK_ARTIFACTS,
              lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
            }));
          })(),
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
          subagentLifecyclePersistence: lifecyclePersistence(invocationId),
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
            taskArtifacts: TEST_TASK_ARTIFACTS,
            lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
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
          subagentLifecyclePersistence: lifecyclePersistence('parent-resume', 2),
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
            taskArtifacts: TEST_TASK_ARTIFACTS,
            lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
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
