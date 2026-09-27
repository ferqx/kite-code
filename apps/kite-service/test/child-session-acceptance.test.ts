import { expect, test } from 'bun:test';
import { SubagentGrantAuthority } from '@kite-ai/builtin-runtime/subagent';
import {
  type BudgetReservation,
  committedResourceUsage,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  LIMITED_RESOURCE_BUDGET_,
  reduceResourceBudgetState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeEvent, RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import { createChildSessionAcceptanceStage } from '../src/bootstrap/runtime/subagent/child-session-acceptance';

const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const RUN = 'acceptance-parent-run';
const INVOCATION = 'acceptance-parent-invocation';

function initialState(): RuntimeState {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'acceptance-parent',
    userId: 'user-1',
    workspace: '/workspace',
  });
  return {
    ...state,
    resourceBudget: {
      status: 'active',
      runId: RUN,
      startedAt: new Date(NOW).toISOString(),
      deadlineAt: new Date(NOW + 50 * 60_000).toISOString(),
      budget: INTERNAL_RESOURCE_BUDGET_,
      reconciledUsage: createZeroResourceUsage(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 0,
    },
  };
}

function addTransient(state: RuntimeState, index: number): RuntimeState {
  const upper = createZeroResourceUsage('versioned_upper_bound', 'acceptance-test-v1');
  upper.counters.toolInvocations = 1;
  upper.counters.artifactBytes = 100;
  const reservation: BudgetReservation = {
    version: 1,
    reservationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    runId: RUN,
    invocationId: `tool:task-${index}`,
    resourceKind: 'subagent',
    executableUpperBound: upper,
    state: 'reserved',
  };
  const reserved = reduceResourceBudgetState(state.resourceBudget, {
    type: 'resource_budget.reserved',
    reservation,
  });
  return {
    ...state,
    resourceBudget: reduceResourceBudgetState(reserved, {
      type: 'resource_budget.dispatch_started',
      reservationId: reservation.reservationId,
    }),
  };
}

function runningReceipt(index: number): Extract<RuntimeEvent, { type: 'tool.finished' }> {
  return {
    type: 'tool.finished',
    toolCallId: `task-${index}`,
    name: 'task',
    result: {
      ok: true,
      command: '',
      exitCode: 0,
      stdout: '',
      stderr: '',
      resultMeta: {
        taskId: `child-invocation-${index}`,
        taskStatus: 'running',
        taskDisposition: 'required',
      },
    },
  };
}

function grant(index: number, role: 'review' | 'code' = 'review') {
  return new SubagentGrantAuthority({
    now: () => NOW,
    idSource: () => `acceptance-grant-${index}`,
  }).issueStart({
    parentInvocationId: INVOCATION,
    parentToolCallId: `task-${index}`,
    parentAttempt: 1,
    capabilityRevision: '1'.repeat(64),
    admissionDigest: '2'.repeat(64),
    effectiveEffectsDigest: '3'.repeat(64),
    childInvocationId: `child-invocation-${index}`,
    role,
    taskArtifact: {
      artifactId: `pa_${String(index).repeat(64)}`,
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${String(index).repeat(64)}`,
      byteLength: 100,
    },
    taskDigest: `sha256:${String(index + 3).repeat(64)}`,
    capabilityCeiling: {
      allowedTools: ['read_file'],
      bindingIds: [],
      bindingRevision: '4'.repeat(64),
      ceilingDigest: '5'.repeat(64),
    },
    authorization: {
      authorizationDigest: '6'.repeat(64),
      interactionMode: 'accept_edits',
      phase: 'building',
      workspaceAccess: 'write',
    },
    executionBoundary: {
      canonicalWorkspace: '/workspace',
      executionBoundaryDigest: `sha256:${'7'.repeat(64)}`,
    },
    resource: { parentReservationId: null, budgetDigest: '8'.repeat(64) },
    cancellationCorrelation: `task-${index}`,
    model: { parentModelInvocationId: 'parent-model', parentToolCallId: `task-${index}` },
  });
}

test('unconfigured parent budget rejects staging before any receipt becomes pending', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'acceptance-parent',
    userId: 'user-1',
    workspace: '/workspace',
  });
  let commits = 0;
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async () => {
      commits += 1;
      return true;
    },
    onAccepted: () => undefined,
  });
  expect(
    stage.stage({
      grant: grant(1),
      name: 'reviewer',
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    }),
  ).toMatchObject({
    ok: false,
    terminalStatus: 'failed',
    summary: 'Background child Session requires an active Run resource budget.',
  });
  expect(await stage.commitReceipt([runningReceipt(1)])).toBeNull();
  expect(commits).toBe(0);
});

test('zero-share parent budget rejects staging before a running receipt', async () => {
  const base = initialState();
  if (base.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
  const state = addTransient(
    {
      ...base,
      resourceBudget: {
        ...base.resourceBudget,
        budget: { ...LIMITED_RESOURCE_BUDGET_, maxConcurrentSubagents: 29 },
      },
    },
    1,
  );
  let commits = 0;
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async () => {
      commits += 1;
      return true;
    },
    onAccepted: () => undefined,
  });
  expect(
    stage.stage({
      grant: grant(1),
      name: 'reviewer',
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    }),
  ).toMatchObject({
    ok: false,
    terminalStatus: 'failed',
    summary:
      'Sub-agent budget cannot provide a positive child allotment; the new child was not created.',
  });
  expect(await stage.commitReceipt([runningReceipt(1)])).toBeNull();
  expect(commits).toBe(0);
});

test('exhausted model budget rejects staging before a running receipt', async () => {
  const base = initialState();
  if (base.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
  const usage = createZeroResourceUsage();
  usage.counters.modelRequests = base.resourceBudget.budget.maxModelRequests;
  const state = addTransient(
    {
      ...base,
      resourceBudget: { ...base.resourceBudget, reconciledUsage: usage },
    },
    1,
  );
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async () => {
      throw new Error('Unexpected child acceptance.');
    },
    onAccepted: () => undefined,
  });
  expect(
    stage.stage({
      grant: grant(1),
      name: 'reviewer',
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    }),
  ).toMatchObject({ ok: false, terminalStatus: 'failed' });
  expect(await stage.commitReceipt([runningReceipt(1)])).toBeNull();
});

test('pending sibling shares are counted before staging another child', () => {
  const base = initialState();
  if (base.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
  const usage = createZeroResourceUsage();
  usage.counters.turns = base.resourceBudget.budget.maxTurns - 10;
  let state: RuntimeState = {
    ...base,
    resourceBudget: { ...base.resourceBudget, reconciledUsage: usage },
  };
  state = addTransient(addTransient(state, 1), 2);
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async () => {
      throw new Error('Unexpected child acceptance.');
    },
    onAccepted: () => undefined,
  });
  const candidate = (index: number) =>
    stage.stage({
      grant: grant(index),
      name: `reviewer-${index}`,
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    });
  expect(candidate(1).ok).toBe(true);
  expect(candidate(2)).toMatchObject({ ok: false, terminalStatus: 'failed' });
});

test('one remaining turn can still fund a child with a reduced allotment', () => {
  const base = initialState();
  if (base.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
  const usage = createZeroResourceUsage();
  usage.counters.turns = base.resourceBudget.budget.maxTurns - 1;
  const state = addTransient(
    { ...base, resourceBudget: { ...base.resourceBudget, reconciledUsage: usage } },
    1,
  );
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async () => true,
    onAccepted: () => undefined,
  });
  expect(
    stage.stage({
      grant: grant(1),
      name: 'reviewer',
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    }).ok,
  ).toBe(true);
});

test('staging does not dispatch; receipt commits one sealed parent batch with exact lease', async () => {
  const state = addTransient(initialState(), 1);
  const originalRevision = state.revision;
  const accepted: string[] = [];
  const committed: RuntimeEvent[][] = [];
  const leases: Array<{ effectId: string; ownerId: string; expiresAtMs: number }> = [];
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: {
      tryAcquireEffectLease: (_sessionId, effectId, ownerId, expiresAtMs) => {
        leases.push({ effectId, ownerId, expiresAtMs });
        return true;
      },
      releaseEffectLease: () => undefined,
    },
    commit: async (events, requiredLease, sealedGrant) => {
      const acquired = leases[0];
      if (!acquired) throw new Error('Acceptance lease was not acquired.');
      expect(requiredLease.effectId).toBe(acquired.effectId);
      expect(requiredLease.ownerId).toBe(acquired.ownerId);
      expect(requiredLease.observedAtMs).toBe(NOW);
      expect(sealedGrant.sealedGrantDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      committed.push([...events]);
      return true;
    },
    onAccepted: ({ childThreadId }) => {
      accepted.push(childThreadId);
    },
  });
  const startGrant = grant(1);
  const staged = stage.stage({
    grant: startGrant,
    name: 'reviewer',
    role: 'review',
    originRunId: RUN,
    originTurnId: state.turn.turnId,
    disposition: 'required',
  });
  expect(staged.backgroundTaskId).toBe(startGrant.childInvocationId);
  expect(committed).toHaveLength(0);
  expect(leases).toHaveLength(0);
  expect(accepted).toHaveLength(0);
  expect(state.revision).toBe(originalRevision);
  expect(
    await stage.commitReceipt([{ type: 'runtime.action_ignored', reason: 'unrelated' }]),
  ).toBeNull();
  expect(await stage.commitReceipt([runningReceipt(1)])).toBe(true);
  expect(committed).toHaveLength(1);
  expect(committed[0]?.map((event) => event.type)).toEqual([
    'resource_budget.reconciled',
    'resource_budget.reserved',
    'capability.subagent_dispatch_intent_recorded',
    'subagent.started',
    'subagent.child_session_intended',
    'tool.finished',
  ]);
  expect(leases).toHaveLength(1);
  expect(leases[0]?.effectId).toContain(accepted[0]!);
  expect(accepted).toHaveLength(1);
});

test('three sibling receipts serialize fresh parent budget planning', async () => {
  let state = initialState();
  for (let index = 1; index <= 3; index += 1) state = addTransient(state, index);
  const batches: RuntimeEvent[][] = [];
  const accepted: string[] = [];
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async (events) => {
      batches.push([...events]);
      for (const event of events) {
        if (
          event.type === 'resource_budget.reconciled' ||
          event.type === 'resource_budget.reserved'
        ) {
          state = {
            ...state,
            resourceBudget: reduceResourceBudgetState(state.resourceBudget, event),
          };
        }
      }
      return true;
    },
    onAccepted: ({ childThreadId }) => {
      accepted.push(childThreadId);
    },
  });
  for (let index = 1; index <= 3; index += 1) {
    stage.stage({
      grant: grant(index),
      name: `reviewer-${index}`,
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    });
  }
  expect(
    await Promise.all([1, 2, 3].map((index) => stage.commitReceipt([runningReceipt(index)]))),
  ).toEqual([true, true, true]);
  expect(batches).toHaveLength(3);
  expect(new Set(accepted).size).toBe(3);
  if (state.resourceBudget.status !== 'active') throw new Error('Parent budget closed.');
  expect(committedResourceUsage(state.resourceBudget).gauges.activeSubagents).toBe(3);
  expect(committedResourceUsage(state.resourceBudget).counters.toolInvocations).toBe(3);
  expect(
    Object.keys(state.resourceBudget.reservations).filter((id) =>
      id.startsWith('child-allotment:'),
    ),
  ).toHaveLength(3);
});

test('fourth sibling is rejected before a child intent or Session can be created', async () => {
  let state = initialState();
  for (let index = 1; index <= 4; index += 1) state = addTransient(state, index);
  const batches: RuntimeEvent[][] = [];
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async (events) => {
      batches.push([...events]);
      for (const event of events) {
        if (
          event.type === 'resource_budget.reconciled' ||
          event.type === 'resource_budget.reserved'
        ) {
          state = {
            ...state,
            resourceBudget: reduceResourceBudgetState(state.resourceBudget, event),
          };
        }
      }
      return true;
    },
    onAccepted: () => undefined,
  });
  const stageOne = (index: number) =>
    stage.stage({
      grant: grant(index),
      name: `reviewer-${index}`,
      role: 'review',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    });
  for (let index = 1; index <= 3; index += 1) {
    expect(stageOne(index).ok).toBe(true);
  }
  expect(stageOne(4)).toMatchObject({
    ok: false,
    terminalStatus: 'failed',
    summary: 'Sub-agent concurrency limit (3) reached; the new child was not created.',
  });
  expect(await stage.commitReceipt([runningReceipt(4)])).toBeNull();
  expect(batches).toHaveLength(0);
});

test('code writer capacity fails immediately and a failed staged receipt releases its pending slot', async () => {
  const initial = initialState();
  let state = {
    ...initial,
    resourceBudget: {
      ...initial.resourceBudget,
      budget: { ...INTERNAL_RESOURCE_BUDGET_, maxConcurrentWriters: 1 },
    },
  } as RuntimeState;
  state = addTransient(addTransient(state, 1), 2);
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: { tryAcquireEffectLease: () => true, releaseEffectLease: () => undefined },
    commit: async () => true,
    onAccepted: () => undefined,
  });
  const code = (index: number) =>
    stage.stage({
      grant: grant(index, 'code'),
      name: `coder-${index}`,
      role: 'code',
      originRunId: RUN,
      originTurnId: state.turn.turnId,
      disposition: 'required',
    });
  expect(code(1).ok).toBe(true);
  expect(code(2)).toMatchObject({
    ok: false,
    summary: 'Code sub-agent writer capacity is full; the new child was not created.',
  });
  const failed = runningReceipt(1);
  expect(
    await stage.commitReceipt([{ ...failed, result: { ...failed.result, ok: false } }]),
  ).toBeNull();
  expect(code(2).ok).toBe(true);
});

test('post-commit release and activation failures cannot turn a receipt into a Tool failure', async () => {
  const state = addTransient(initialState(), 1);
  let commits = 0;
  const stage = createChildSessionAcceptanceStage({
    getState: () => state,
    now: () => NOW,
    effectLeases: {
      tryAcquireEffectLease: () => true,
      releaseEffectLease: () => {
        throw new Error('Store lease release failed after commit');
      },
    },
    commit: async () => {
      commits += 1;
      return true;
    },
    onAccepted: () => {
      throw new Error('child scheduler unavailable');
    },
  });
  stage.stage({
    grant: grant(1),
    name: 'reviewer',
    role: 'review',
    originRunId: RUN,
    originTurnId: state.turn.turnId,
    disposition: 'required',
  });
  expect(await stage.commitReceipt([runningReceipt(1)])).toBe(true);
  expect(commits).toBe(1);
});
