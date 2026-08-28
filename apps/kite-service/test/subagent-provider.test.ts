import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createToolRecoveryJournal } from '@kite-ai/agent-kernel';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import { aiMessage, BuiltinModelEffectCoordinator } from '@kite-ai/builtin-runtime/model';
import type { SubagentLifecycleArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import {
  BuiltinChildRuntimeDriver,
  type LocalSubagentLifecycleDriver,
  LocalSubagentProvider,
  SubagentGrantAuthority,
  type SubagentTaskArtifactAccess,
  subagentTaskDigest,
} from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  SubagentDelegationGrant,
  SubagentHandle,
  SubagentProvider,
  SubagentResumeGrant,
} from '@kite-ai/runtime-spi';
import { SUBAGENT_PROVIDER_SCHEMA_ } from '@kite-ai/runtime-spi';
import { subagentResultFromObservation } from '#kite-service/bootstrap/runtime/subagent/observation-codec';
import { SubagentProviderRecoveryRequiredError } from '#kite-service/bootstrap/runtime/subagent/task-tool';
import type { AgentConfig } from '#kite-service/config/index';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createMockModel } from '../../../tests/helpers/mock-model';
import { createTestModelInvocationHarness } from '../../../tests/helpers/model-invocation';
import {
  executeTestRuntimeTools,
  testBuiltinToolCatalog,
  testRuntimeCapabilityExecutionPort,
  testSubagentTaskRequests,
} from '../../../tests/helpers/runtime-model';
import { createPipelineSubagentRuntime } from '../src/bootstrap/runtime/subagent/pipeline-runtime';

const TEST_TASK = 'task';
const TEST_RECOVERY_IDENTITY_KEY = '1'.repeat(64);
const TEST_TASK_DIGEST = subagentTaskDigest(TEST_TASK);
const TEST_AGENT_CONFIG: AgentConfig = {
  apiKey: 'unused',
  baseURL: 'https://example.invalid',
  providerName: 'fixture',
  modelName: 'fixture',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};
const TEST_TASK_REF = Object.freeze({
  artifactId: `pa_${'1'.repeat(64)}`,
  kind: 'subagent_task' as const,
  integrityIdentifier: `sha256:${'2'.repeat(64)}`,
  byteLength: 256,
});
let testStoredTask = TEST_TASK;
const TEST_TASK_ARTIFACTS: SubagentTaskArtifactAccess = {
  write: ({ task }) => {
    testStoredTask = task;
    return { ref: TEST_TASK_REF, taskDigest: subagentTaskDigest(task) };
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
    taskDigest: subagentTaskDigest(testStoredTask),
    taskByteLength: Buffer.byteLength(testStoredTask),
  }),
};
const TEST_HANDLE_REF = Object.freeze({
  artifactId: `pa_${'3'.repeat(64)}`,
  kind: 'subagent_handle' as const,
  integrityIdentifier: `sha256:${'4'.repeat(64)}`,
  byteLength: 512,
});
let testStoredHandle: SubagentHandle | undefined;
const TEST_LIFECYCLE_ARTIFACTS: SubagentLifecycleArtifactAccess = {
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
  reject?: (events: import('@kite-ai/agent-kernel').RuntimeEvent[]) => boolean,
) {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `lifecycle-${invocationId}`,
    userId: 'test',
    workspace: process.cwd(),
  });
  state.capabilities.invocations[invocationId] = {
    invocationId,
    toolCallId: 'parent-tool',
    capabilityId: 'builtin:task',
    capabilityRevision: digestCapabilityValue({ value: 'capability' }),
    argumentsDigest: digestCapabilityValue({ value: 'arguments' }),
    authorizationDigest: digestCapabilityValue({ value: 'authorization' }),
    admissionDigest: digestCapabilityValue({ value: 'admission' }),
    effectiveEffectsDigest: digestCapabilityValue({ value: 'effects' }),
    status: 'running',
    recordedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    attemptsStarted: attempt,
  };
  return {
    getState: () => state,
    persistEvents: async (events: import('@kite-ai/agent-kernel').RuntimeEvent[]) => {
      if (reject?.(events)) return false;
      for (const event of events) state = reduceRuntimeState(state, event);
      return true;
    },
  };
}

function taskProviderJourney(input: { invocationId: string; task?: string }) {
  const task = input.task ?? 'Inspect the acknowledged Provider route.';
  const taskRequests = testSubagentTaskRequests();
  const parentModelInvocationId = `provider-parent-model:${input.invocationId}`;
  const taskArtifact = taskRequests.write({
    parentModelInvocationId,
    parentToolCallId: 'pipeline-task',
    name: 'Inspect provider route',
    role: 'review',
    task,
  });
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: TEST_RECOVERY_IDENTITY_KEY,
    threadId: `provider-task-${input.invocationId}`,
    userId: 'test',
    workspace: process.cwd(),
  });
  state.tools.calls['pipeline-task'] = {
    toolCallId: 'pipeline-task',
    modelInvocationId: parentModelInvocationId,
    modelMessageId: parentModelInvocationId,
    name: 'task',
    args: { name: 'Inspect provider route', subagent_type: 'review', taskArtifact },
    status: 'queued',
    sideEffect: false,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'pipeline-task'];
  return {
    state,
    taskRequests,
    persistRuntimeEvents: async (events: import('@kite-ai/agent-kernel').RuntimeEvent[]) => {
      for (const event of events) state = reduceRuntimeState(state, event);
      return true;
    },
    getRuntimeState: () => state,
  };
}

function binding() {
  const hash = (name: string) => digestCapabilityValue({ name });
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

describe('SubagentProvider grant and Local Provider', () => {
  test('seals every current interaction mode and rejects the removed legacy identity', () => {
    for (const interactionMode of ['accept_edits', 'auto', 'full'] as const) {
      const authority = new SubagentGrantAuthority({
        idSource: () => `grant-${interactionMode}`,
      });
      expect(
        authority.issueStart({
          ...binding(),
          authorization: { ...binding().authorization, interactionMode },
        }).authorization.interactionMode,
      ).toBe(interactionMode);
    }
    expect(() =>
      new SubagentGrantAuthority().issueStart({
        ...binding(),
        authorization: {
          ...binding().authorization,
          interactionMode: 'default' as never,
        },
      }),
    ).toThrow('invalid subagent grant');
  });

  test('rejects cross-child and digest-mutated observation envelopes', () => {
    const expected = handle({
      ...new SubagentGrantAuthority({ idSource: () => 'observation-grant' }).issueStart(binding()),
    });
    const privatePayload = JSON.parse(
      JSON.stringify({
        ok: true,
        summary: 'done',
        toolCallCount: 0,
        durationMs: 1,
        terminalStatus: 'completed',
        error: null,
        failureDiagnostic: null,
        resourceAdmissionFailure: null,
        steps: [],
        executionJournal: [],
        exhaustedFingerprints: {},
        toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
        blocked: null,
      }),
    ) as import('@kite-ai/runtime-spi').JsonObject;
    const body = {
      schema: SUBAGENT_PROVIDER_SCHEMA_,
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
    expect(() =>
      subagentResultFromObservation(observation, expected, TEST_RECOVERY_IDENTITY_KEY),
    ).toThrow('malformed or inconsistent');
    const crossChildBody = {
      ...body,
      handleId: expected.handleId,
      childInvocationId: 'other-child',
    };
    expect(() =>
      subagentResultFromObservation(
        {
          ...crossChildBody,
          observationDigest: `sha256:${createHash('sha256')
            .update(JSON.stringify(crossChildBody))
            .digest('hex')}`,
        },
        expected,
        TEST_RECOVERY_IDENTITY_KEY,
      ),
    ).toThrow('malformed or inconsistent');
    expect(() =>
      subagentResultFromObservation(
        { ...observation, handleId: expected.handleId },
        expected,
        TEST_RECOVERY_IDENTITY_KEY,
      ),
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
        subagentResultFromObservation(
          {
            ...resourceBody,
            observationDigest: `sha256:${createHash('sha256')
              .update(JSON.stringify(resourceBody))
              .digest('hex')}`,
          },
          expected,
          TEST_RECOVERY_IDENTITY_KEY,
        ),
      ).toThrow(
        reason === 'forged_reason'
          ? 'malformed or inconsistent'
          : 'resource terminal is inconsistent',
      );
    }
  });

  test('retains only the bounded child failure diagnostic across observation', () => {
    const expected = handle({
      ...new SubagentGrantAuthority({ idSource: () => 'diagnostic-grant' }).issueStart(binding()),
    });
    const privatePayload = JSON.parse(
      JSON.stringify({
        ok: false,
        summary: 'Sub-agent execution failed.',
        toolCallCount: 3,
        durationMs: 9,
        terminalStatus: 'failed',
        error: 'Sub-agent execution failed.',
        failureDiagnostic: {
          code: 'model_step_failed',
          stage: 'model_step',
          modelInvocationId: 'model-child-last',
        },
        resourceAdmissionFailure: null,
        steps: [],
        executionJournal: [],
        exhaustedFingerprints: {},
        toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
        blocked: null,
      }),
    ) as import('@kite-ai/runtime-spi').JsonObject;
    const body = {
      schema: SUBAGENT_PROVIDER_SCHEMA_,
      handleId: expected.handleId,
      childInvocationId: expected.childInvocationId,
      status: 'failed' as const,
      summary: 'Sub-agent execution failed.',
      toolCallCount: 3,
      durationMs: 9,
      privatePayload,
    };
    const observation = {
      ...body,
      observationDigest: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
    };

    expect(
      subagentResultFromObservation(observation, expected, TEST_RECOVERY_IDENTITY_KEY),
    ).toMatchObject({
      failureDiagnostic: {
        code: 'model_step_failed',
        stage: 'model_step',
        modelInvocationId: 'model-child-last',
      },
    });
    expect(JSON.stringify(observation)).not.toContain('private next-round failure detail');
  });

  test('binds, expires, and consumes an exact start grant once', async () => {
    let now = 10;
    const authority = new SubagentGrantAuthority({
      now: () => now,
      ttlMs: 20,
      idSource: () => 'grant-1',
    });
    const driver: LocalSubagentLifecycleDriver = {
      abandon: () => true,
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProvider(
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

    const expiring = new SubagentGrantAuthority({
      now: () => now,
      ttlMs: 5,
      idSource: () => 'grant-expired',
    });
    const expiredGrant = expiring.issueStart(binding());
    now = 16;
    const expiredProvider = new LocalSubagentProvider(
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
    const authority = new SubagentGrantAuthority({
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
    const authority = new SubagentGrantAuthority({
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
    const authority = new SubagentGrantAuthority({ idSource: () => `discard-${++ordinal}` });
    const startGrant = authority.issueStart(binding());
    const resumeGrant = authority.issueResume({
      ...binding(),
      childInvocationId: 'child-resume-discard',
      continuationId: 'continuation-discard',
      continuationDigest: digestCapabilityValue({ value: 'continuation-discard' }),
      blockedToolCallId: 'blocked-model-discard',
      blockedRuntimeToolCallId: 'blocked-runtime-discard',
      resumeAttempt: 2,
    });
    const registration = (grant: SubagentDelegationGrant | SubagentResumeGrant) => ({
      childInvocationId: grant.childInvocationId,
      parentInvocationId: grant.parentInvocationId,
      parentToolCallId: grant.parentToolCallId,
      parentAttempt: grant.parentAttempt,
      run: async (consumedGrant: typeof grant) => {
        return driverResult(consumedGrant.childInvocationId);
      },
    });
    const driver = new BuiltinChildRuntimeDriver();
    driver.registerStart(startGrant.grantId, registration(startGrant));
    driver.registerResume(resumeGrant.grantId, registration(resumeGrant));
    expect(driver.pendingRegistrationCount()).toBe(2);
    expect(driver.abandon({ ...startGrant, childInvocationId: 'wrong-child' })).toBe(false);
    expect(driver.pendingRegistrationCount()).toBe(2);
    expect(driver.abandon(startGrant)).toBe(true);
    expect(driver.abandon(resumeGrant)).toBe(true);
    expect(driver.pendingRegistrationCount()).toBe(0);

    let now = 0;
    const bounded = new BuiltinChildRuntimeDriver({ now: () => now, maxPendingRegistrations: 1 });
    bounded.registerStart('expired-registration', {
      ...registration(startGrant),
      expiresAtMs: 1,
    });
    now = 1;
    expect(bounded.pendingRegistrationCount()).toBe(0);
    bounded.registerStart('live-registration', {
      ...registration(startGrant),
      expiresAtMs: 10,
    });
    expect(() =>
      bounded.registerResume('over-capacity', {
        ...registration(resumeGrant),
        expiresAtMs: 10,
      }),
    ).toThrow('capacity is exhausted');

    for (const expiresAtMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 5 * 60_000 + 1]) {
      const strict = new BuiltinChildRuntimeDriver({ now: () => 0 });
      expect(() =>
        strict.registerStart(`invalid-expiry-${String(expiresAtMs)}`, {
          ...registration(startGrant),
          expiresAtMs,
        }),
      ).toThrow('expiry is invalid');
    }
    const overflow = new BuiltinChildRuntimeDriver({
      now: () => Number.MAX_SAFE_INTEGER - 1,
    });
    expect(() =>
      overflow.registerStart('overflow-expiry', {
        ...registration(startGrant),
      }),
    ).toThrow('expiry is invalid');
  });

  test('rejects a tampered grant and stale or identity-mutated handles', async () => {
    const authority = new SubagentGrantAuthority({ idSource: () => 'grant-2' });
    const driver: LocalSubagentLifecycleDriver = {
      abandon: () => true,
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    const provider = new LocalSubagentProvider(
      authority.verifier(),
      driver,
      TEST_TASK_ARTIFACTS,
      () => 'handle-2',
    );
    const grant = authority.issueStart(binding());
    expect(
      await provider.start({
        grant: { ...grant, parentAttempt: 2 } as SubagentDelegationGrant,
      }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid_grant' } });
    const valid = authority.issueStart({ ...binding(), childInvocationId: 'child-2' });
    const started = await provider.start({ grant: valid });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(
      await provider.observe({
        handle: { ...started.value, role: 'code' } as SubagentHandle,
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
    const crashAuthority = new SubagentGrantAuthority({ idSource: () => 'grant-crash' });
    const crashProvider = new LocalSubagentProvider(
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

    const largeAuthority = new SubagentGrantAuthority({ idSource: () => 'grant-large' });
    const largeProvider = new LocalSubagentProvider(
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
    const authority = new SubagentGrantAuthority({
      idSource: () => `grant-resume-${++grantOrdinal}`,
    });
    const driver: LocalSubagentLifecycleDriver = {
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
    const provider = new LocalSubagentProvider(
      authority.verifier(),
      driver,
      TEST_TASK_ARTIFACTS,
      () => 'handle-resume',
    );
    const resumeGrant = authority.issueResume({
      ...binding(),
      continuationId: 'continuation-exact',
      continuationDigest: digestCapabilityValue({ value: 'continuation' }),
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
    const authority = new SubagentGrantAuthority({ idSource: () => 'grant-leak' });
    const never = new Promise<ReturnType<typeof driverResult>>(() => {});
    const provider = new LocalSubagentProvider(
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
    const authority = new SubagentGrantAuthority({
      now: () => now,
      idSource: () => `grant-unconfirmed-clock-${++grantOrdinal}`,
    });
    const never = new Promise<ReturnType<typeof driverResult>>(() => {});
    const provider = new LocalSubagentProvider(
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
    const authority = new SubagentGrantAuthority();
    const driver: LocalSubagentLifecycleDriver = {
      abandon: () => true,
      start: async (grant) => driverResult(grant.childInvocationId),
      resume: async (grant) => driverResult(grant.childInvocationId),
    };
    for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(
        () =>
          new LocalSubagentProvider(
            authority.verifier(),
            driver,
            TEST_TASK_ARTIFACTS,
            undefined,
            10,
            { now: () => clock },
          ),
      ).toThrow('clock is invalid');
      expect(() => new BuiltinChildRuntimeDriver({ now: () => clock })).toThrow('clock is invalid');
    }

    const overflowAuthority = new SubagentGrantAuthority({
      now: () => Number.MAX_SAFE_INTEGER,
    });
    expect(() => overflowAuthority.issueStart(binding())).toThrow('expiry is invalid');
  });

  test('bounds same-process Provider lifecycle tombstones and fails closed after eviction', async () => {
    let now = 100;
    let grantOrdinal = 0;
    let handleOrdinal = 0;
    const authority = new SubagentGrantAuthority({
      now: () => now,
      idSource: () => `grant-bounded-provider-${++grantOrdinal}`,
    });
    const provider = new LocalSubagentProvider(
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

class FakeProvider implements SubagentProvider {
  starts = 0;
  observes = 0;
  cancels = 0;
  lastGrant?: SubagentDelegationGrant;
  lastResumeGrant?: SubagentResumeGrant;
  readonly mode: 'deny' | 'crash' | 'stale' | 'recovery';
  constructor(mode: 'deny' | 'crash' | 'stale' | 'recovery') {
    this.mode = mode;
  }
  async start(input: { grant: SubagentDelegationGrant }) {
    this.starts += 1;
    this.lastGrant = input.grant;
    if (this.mode === 'deny') {
      return { ok: false as const, failure: { code: 'fake_denied' as const, message: 'denied' } };
    }
    return { ok: true, value: handle(input.grant) } as const;
  }
  async resume(input: { grant: SubagentResumeGrant }) {
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

async function executeAppTaskWithFakeProvider(input: {
  mode: 'deny' | 'crash' | 'stale' | 'recovery';
  persistRuntimeEvents?: (
    events: import('@kite-ai/agent-kernel').RuntimeEvent[],
  ) => Promise<boolean>;
}) {
  const journey = taskProviderJourney({ invocationId: `app-task-${input.mode}` });
  const fake = new FakeProvider(input.mode);
  const driver = new BuiltinChildRuntimeDriver();
  let runtimeFactoryCalls = 0;
  const events = await executeTestRuntimeTools({
    state: journey.state,
    toolCallIds: ['pipeline-task'],
    taskConfig: TEST_AGENT_CONFIG,
    taskModel: createMockModel([{ message: aiMessage({ content: 'must not dispatch model' }) }]),
    subagentTaskRequests: journey.taskRequests,
    persistRuntimeEvents: input.persistRuntimeEvents ?? journey.persistRuntimeEvents,
    getRuntimeState: journey.getRuntimeState,
    capabilityExecution: testRuntimeCapabilityExecutionPort(),
    subagentRuntimeFactory: () => {
      runtimeFactoryCalls += 1;
      return createPipelineSubagentRuntime(() => ({
        grants: new SubagentGrantAuthority({ idSource: () => `app-task-${input.mode}` }),
        driver,
        provider: fake,
        taskArtifacts: TEST_TASK_ARTIFACTS,
        lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
      }));
    },
  });
  return { events, fake, driver, runtimeFactoryCalls, journey };
}

function handle(grant: SubagentDelegationGrant | SubagentResumeGrant): SubagentHandle {
  return {
    schema: SUBAGENT_PROVIDER_SCHEMA_,
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
    integrityIdentifier: `sha256:${'5'.repeat(64)}`,
  };
}

describe('Pipeline-owned Fake Provider negatives', () => {
  test('releases the exact Driver registration when intent or handle-ready ack fails', async () => {
    for (const rejectedType of [
      'capability.subagent_dispatch_intent_recorded',
      'capability.subagent_handle_recorded',
    ] as const) {
      const invocationId = `registration-${rejectedType}`;
      const harness = createTestModelInvocationHarness({ workspace: process.cwd() });
      const grants = new SubagentGrantAuthority({ idSource: () => `grant-${rejectedType}` });
      const driver = new BuiltinChildRuntimeDriver();
      const provider = new LocalSubagentProvider(
        grants.verifier(),
        driver,
        TEST_TASK_ARTIFACTS,
        () => `handle-${rejectedType}`,
      );
      const runtime = createPipelineSubagentRuntime(() => ({
        grants,
        driver,
        provider,
        taskArtifacts: TEST_TASK_ARTIFACTS,
        lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
      }));
      await expect(
        runtime.start(
          {
            builtinToolCatalog: testBuiltinToolCatalog(),
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
            modelEffectCoordinator: new BuiltinModelEffectCoordinator(harness.gateway),
            modelInvocationPersistence: harness.persistence,
            subagentLifecyclePersistence: lifecyclePersistence(invocationId, 1, (events) =>
              events.some((event) => event.type === rejectedType),
            ),
            modelInvocationParentId: 'parent-model',
            modelInvocationParentToolCallId: 'parent-tool',
            subagentInvocationIdentity: {
              invocationId,
              attempt: 1,
              capabilityRevision: digestCapabilityValue({ value: 'capability' }),
              authorizationDigest: digestCapabilityValue({ value: 'authorization' }),
              admissionDigest: digestCapabilityValue({ value: 'admission' }),
              effectiveEffectsDigest: digestCapabilityValue({ value: 'effects' }),
            },
            subagentRuntime: runtime,
          },
          {
            name: `Inspect ${rejectedType}`,
            subagent_type: 'review',
            task: `inspect ${rejectedType}`,
          },
        ),
      ).rejects.toBeInstanceOf(SubagentProviderRecoveryRequiredError);
      expect(driver.pendingRegistrationCount()).toBe(0);
      expect(harness.events.filter((event) => event.type.startsWith('model.'))).toHaveLength(0);
    }
  });

  test('injects Fake Providers only after a real admitted Task attempt is acknowledged', async () => {
    const noAck = await executeAppTaskWithFakeProvider({
      mode: 'deny',
      persistRuntimeEvents: async () => false,
    });
    expect(noAck.runtimeFactoryCalls).toBe(0);
    expect(noAck.fake.starts).toBe(0);
    expect(noAck.driver.pendingRegistrationCount()).toBe(0);
    expect(noAck.events).toContainEqual(expect.objectContaining({ type: 'tool.failed' }));

    for (const mode of ['deny', 'crash', 'stale', 'recovery'] as const) {
      const result = await executeAppTaskWithFakeProvider({ mode });
      expect(result.runtimeFactoryCalls).toBe(1);
      expect(result.fake.starts).toBe(1);
      expect(result.driver.pendingRegistrationCount()).toBe(0);
      expect(result.events.some((event) => event.type === 'model.requested')).toBe(false);
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'tool.failed', toolCallId: 'pipeline-task' }),
      );
    }
  });

  for (const mode of ['deny', 'crash', 'stale', 'recovery'] as const) {
    test(`${mode} never falls back to Local Provider or the legacy runner`, async () => {
      const harness = createTestModelInvocationHarness({ workspace: process.cwd() });
      const fake = new FakeProvider(mode);
      const runtime = createPipelineSubagentRuntime(() => ({
        grants: new SubagentGrantAuthority({ idSource: () => `grant-${mode}` }),
        driver: new BuiltinChildRuntimeDriver(),
        provider: fake,
        taskArtifacts: TEST_TASK_ARTIFACTS,
        lifecycleArtifacts: TEST_LIFECYCLE_ARTIFACTS,
      }));
      const result = runtime.start(
        {
          builtinToolCatalog: testBuiltinToolCatalog(),
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
          modelEffectCoordinator: new BuiltinModelEffectCoordinator(harness.gateway),
          modelInvocationPersistence: harness.persistence,
          subagentLifecyclePersistence: lifecyclePersistence('parent-invocation'),
          modelInvocationParentId: 'parent-model',
          modelInvocationParentToolCallId: 'parent-tool',
          subagentInvocationIdentity: {
            invocationId: 'parent-invocation',
            attempt: 1,
            capabilityRevision: digestCapabilityValue({ value: 'capability' }),
            authorizationDigest: digestCapabilityValue({ value: 'authorization' }),
            admissionDigest: digestCapabilityValue({ value: 'admission' }),
            effectiveEffectsDigest: digestCapabilityValue({ value: 'effects' }),
          },
          subagentRuntime: runtime,
        },
        { name: 'Inspect provider path', subagent_type: 'review', task: 'inspect' },
      );
      if (mode === 'deny') {
        expect(await result).toMatchObject({ ok: false, summary: 'denied' });
      } else {
        await expect(result).rejects.toBeInstanceOf(SubagentProviderRecoveryRequiredError);
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
});
