import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type BudgetReservation,
  committedResourceUsage,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  LIMITED_RESOURCE_BUDGET_,
  type ResourceBudget,
  reduceResourceBudgetState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeEvent, RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import {
  childBudgetAtActivation,
  planChildDelegatedAllotment,
} from '../src/bootstrap/runtime/subagent/child-delegated-allotment';

const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const DEADLINE = new Date(NOW + 50 * 60_000).toISOString();

function childId(index: number): string {
  return `child_${createHash('sha256').update(`child-${index}`).digest('hex')}`;
}

function transientId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function initialState(budget: ResourceBudget = INTERNAL_RESOURCE_BUDGET_): RuntimeState {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'allotment-parent',
    userId: 'user-1',
    workspace: '/workspace',
  });
  return {
    ...state,
    resourceBudget: {
      status: 'active',
      runId: 'parent-run',
      startedAt: new Date(NOW).toISOString(),
      deadlineAt: new Date(NOW + Math.min(50 * 60_000, budget.maxRunDurationMs)).toISOString(),
      budget,
      reconciledUsage: createZeroResourceUsage(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 0,
    },
  };
}

function transient(index: number): BudgetReservation {
  const id = transientId(index);
  const upper = createZeroResourceUsage('versioned_upper_bound', 'task-tool-test-v1');
  upper.counters.toolInvocations = 1;
  upper.counters.artifactBytes = 1;
  return {
    version: 1,
    reservationId: id,
    runId: 'parent-run',
    invocationId: `tool:task-${index}`,
    resourceKind: 'subagent',
    executableUpperBound: upper,
    state: 'reserved',
  };
}

function withTransient(state: RuntimeState, index: number, invocationId?: string): RuntimeState {
  const held = { ...transient(index), ...(invocationId ? { invocationId } : {}) };
  const reserved = reduceResourceBudgetState(state.resourceBudget, {
    type: 'resource_budget.reserved',
    reservation: held,
  });
  const started = reduceResourceBudgetState(reserved, {
    type: 'resource_budget.dispatch_started',
    reservationId: held.reservationId,
  });
  return { ...state, resourceBudget: started };
}

function finished(index: number): Extract<RuntimeEvent, { type: 'tool.finished' }> {
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
      resultMeta: { taskId: childId(index), taskStatus: 'running', taskDisposition: 'required' },
    },
  };
}

function applyPlanned(
  state: RuntimeState,
  events: ReturnType<typeof planChildDelegatedAllotment>['events'],
): RuntimeState {
  const first = reduceResourceBudgetState(state.resourceBudget, events[0]);
  const second = reduceResourceBudgetState(first, events[1]);
  return { ...state, resourceBudget: second };
}

test('three read-only child allotments reconcile transient Tools and coexist under INTERNAL budget', () => {
  let state = initialState();
  const reservations: BudgetReservation[] = [];
  for (let index = 1; index <= 3; index += 1) {
    state = withTransient(state, index);
    const plan = planChildDelegatedAllotment({
      state,
      transientReservationId: transientId(index),
      toolFinished: finished(index),
      childThreadId: childId(index),
      role: 'review',
      taskArtifactBytes: 1,
      now: NOW,
    });
    expect(plan.events.map((event) => event.type)).toEqual([
      'resource_budget.reconciled',
      'resource_budget.reserved',
    ]);
    expect(plan.events[0].actual.counters.toolInvocations).toBe(1);
    expect(plan.events[0].actual.gauges.activeSubagents).toBe(0);
    expect(plan.reservation.invocationId).toBe(`child-allotment:${childId(index)}`);
    expect(plan.reservation.executableUpperBound.gauges.activeWriters).toBe(0);
    expect(plan.childBudget.maxTurns).toBe(0);
    expect(plan.childBudget.maxModelRequests).toBe(0);
    expect(plan.childBudget.durationOnlyChildRun).toBe(true);
    expect(plan.childBudget.maxRunInputTokens).toBe(0);
    expect(plan.childBudget.maxRunOutputTokens).toBe(0);
    expect(plan.childBudget.maxArtifactBytes).toBe(0);
    expect(plan.childBudget.maxRunDurationMs).toBe(30 * 60_000);
    expect(plan.childBudget.unboundedToolInvocations).toBe(true);
    expect(plan.childBudget.maxToolInvocations).toBe(0);
    expect(plan.reservation.executableUpperBound.unboundedToolInvocations).toBe(true);
    expect(plan.reservation.executableUpperBound.independentChildTurnDeadline).toBe(true);
    expect(plan.reservation.executableUpperBound.durationOnlyChildRun).toBe(true);
    expect(Object.values(plan.reservation.executableUpperBound.counters)).toEqual(Array(6).fill(0));
    expect(Date.parse(plan.deadlineAt)).toBe(NOW + 30 * 60_000);
    reservations.push(plan.reservation);
    state = applyPlanned(state, plan.events);
  }
  if (state.resourceBudget.status !== 'active') throw new Error('Projected budget closed.');
  expect(reservations.map((item) => item.reservationId)).toEqual(
    [1, 2, 3].map((index) => `child-allotment:${childId(index)}`),
  );
  expect(committedResourceUsage(state.resourceBudget).gauges.activeSubagents).toBe(3);
  expect(committedResourceUsage(state.resourceBudget).counters.toolInvocations).toBe(3);
});

test('large private Task input does not consume parent output Artifact budget', () => {
  const state = withTransient(initialState(LIMITED_RESOURCE_BUDGET_), 1);
  const plan = planChildDelegatedAllotment({
    state,
    transientReservationId: transientId(1),
    toolFinished: finished(1),
    childThreadId: childId(1),
    role: 'explore',
    taskArtifactBytes: 20 * 1024 * 1024,
    now: NOW,
  });
  expect(plan.events[0].actual.counters.artifactBytes).toBe(0);
  expect(plan.childBudget.maxConcurrencyWaitMs).toBe(plan.childBudget.maxRunDurationMs);
  expect(plan.childBudget.maxConcurrentToolInvocations).toBe(Number.MAX_SAFE_INTEGER);
  expect(plan.childBudget.maxConcurrentShellInvocations).toBe(Number.MAX_SAFE_INTEGER);
});

test('child allotments use subagent slots without reserving Tool or Shell slots', () => {
  let state = initialState({
    ...INTERNAL_RESOURCE_BUDGET_,
    maxConcurrentToolInvocations: 1,
    maxConcurrentShellInvocations: 0,
  });
  for (let index = 1; index <= 3; index += 1) {
    state = withTransient(state, index);
    const plan = planChildDelegatedAllotment({
      state,
      transientReservationId: transientId(index),
      toolFinished: finished(index),
      childThreadId: childId(index),
      role: 'review',
      taskArtifactBytes: 1,
      now: NOW,
    });
    expect(plan.reservation.executableUpperBound.gauges.activeToolInvocations).toBe(0);
    expect(plan.reservation.executableUpperBound.gauges.activeShellInvocations).toBe(0);
    state = applyPlanned(state, plan.events);
  }
  if (state.resourceBudget.status !== 'active') throw new Error('Projected budget closed.');
  expect(committedResourceUsage(state.resourceBudget).gauges.activeSubagents).toBe(3);
});

test('LIMITED budget admits three child allotments and rejects a fourth without queuing', () => {
  let state = initialState(LIMITED_RESOURCE_BUDGET_);
  const reservations: BudgetReservation[] = [];
  for (let index = 1; index <= 3; index += 1) {
    state = withTransient(state, index);
    const plan = planChildDelegatedAllotment({
      state,
      transientReservationId: transientId(index),
      toolFinished: finished(index),
      childThreadId: childId(index),
      role: 'review',
      taskArtifactBytes: 1,
      now: NOW,
    });
    expect(plan.childBudget.maxRunDurationMs).toBe(30 * 60_000);
    expect(plan.childBudget.maxModelRequests).toBe(0);
    expect(Date.parse(plan.deadlineAt)).toBe(NOW + plan.childBudget.maxRunDurationMs);
    expect(plan.reservation.executableUpperBound.gauges.elapsedRunMs).toBe(
      plan.childBudget.maxRunDurationMs,
    );
    reservations.push(plan.reservation);
    state = applyPlanned(state, plan.events);
  }
  if (state.resourceBudget.status !== 'active') throw new Error('Projected budget closed.');
  expect(committedResourceUsage(state.resourceBudget).gauges.activeSubagents).toBe(3);
  state = withTransient(state, 4);
  expect(() =>
    planChildDelegatedAllotment({
      state,
      transientReservationId: transientId(4),
      toolFinished: finished(4),
      childThreadId: childId(4),
      role: 'review',
      taskArtifactBytes: 1,
      now: NOW,
    }),
  ).toThrow('Sub-agent concurrency capacity is full');
  expect(
    Object.values(state.resourceBudget.reservations).filter((item) => item.state === 'queued'),
  ).toEqual([]);
  state = {
    ...state,
    resourceBudget: reduceResourceBudgetState(state.resourceBudget, {
      type: 'resource_budget.released',
      reservationId: reservations[0]!.reservationId,
    }),
  };
  if (state.resourceBudget.status !== 'active') throw new Error('Projected budget closed.');
  expect(committedResourceUsage(state.resourceBudget).gauges.activeSubagents).toBe(2);
});

test('short remaining parent deadline does not shorten the new child turn', () => {
  const base = initialState(LIMITED_RESOURCE_BUDGET_);
  if (base.resourceBudget.status !== 'active') throw new Error('Projected budget closed.');
  const deadlineAt = new Date(NOW + 25).toISOString();
  const state = withTransient(
    { ...base, resourceBudget: { ...base.resourceBudget, deadlineAt } },
    1,
  );
  const plan = planChildDelegatedAllotment({
    state,
    transientReservationId: transientId(1),
    toolFinished: finished(1),
    childThreadId: childId(1),
    role: 'review',
    taskArtifactBytes: 1,
    now: NOW + 10,
  });
  expect(plan.childBudget.maxRunDurationMs).toBe(30 * 60_000);
  expect(plan.deadlineAt).toBe(new Date(NOW + 10 + 30 * 60_000).toISOString());
  expect(plan.reservation.executableUpperBound.gauges.elapsedRunMs).toBe(30 * 60_000);
});

test('code children use only parent subagent slots', () => {
  let state = initialState({
    ...INTERNAL_RESOURCE_BUDGET_,
    maxConcurrentSubagents: 2,
    maxConcurrentWriters: 0,
  });
  for (let index = 1; index <= 2; index += 1) {
    state = withTransient(state, index);
    const plan = planChildDelegatedAllotment({
      state,
      transientReservationId: transientId(index),
      toolFinished: finished(index),
      childThreadId: childId(index),
      role: 'code',
      taskArtifactBytes: 1,
      now: NOW,
    });
    expect(plan.reservation.executableUpperBound.gauges.activeWriters).toBe(0);
    expect(plan.childBudget.maxConcurrentWriters).toBe(Number.MAX_SAFE_INTEGER);
    state = applyPlanned(state, plan.events);
  }
  state = withTransient(state, 3);
  expect(() =>
    planChildDelegatedAllotment({
      state,
      transientReservationId: transientId(3),
      toolFinished: finished(3),
      childThreadId: childId(3),
      role: 'code',
      taskArtifactBytes: 1,
      now: NOW,
    }),
  ).toThrow('Sub-agent concurrency capacity is full');
});

test('finite parent counters do not shrink child work; expired parent deadline rejects it', () => {
  const low = initialState({ ...INTERNAL_RESOURCE_BUDGET_, maxTurns: 3 });
  const plan = planChildDelegatedAllotment({
    state: withTransient(low, 1),
    transientReservationId: transientId(1),
    toolFinished: finished(1),
    childThreadId: childId(1),
    role: 'review',
    taskArtifactBytes: 1,
    now: NOW,
  });
  expect(plan.childBudget.durationOnlyChildRun).toBe(true);
  expect(plan.reservation.executableUpperBound.counters.turns).toBe(0);
  expect(() =>
    planChildDelegatedAllotment({
      state: withTransient(initialState(), 1),
      transientReservationId: transientId(1),
      toolFinished: finished(1),
      childThreadId: childId(1),
      role: 'review',
      taskArtifactBytes: 1,
      now: Date.parse(DEADLINE),
    }),
  ).toThrow('deadline has expired');
});

test('same facts produce the same child allotment identity and stale input is refused', () => {
  const state = withTransient(initialState(), 1);
  const input = {
    state,
    transientReservationId: transientId(1),
    toolFinished: finished(1),
    childThreadId: childId(1),
    role: 'review' as const,
    taskArtifactBytes: 1,
    now: NOW,
  };
  const first = planChildDelegatedAllotment(input);
  expect(planChildDelegatedAllotment(input)).toEqual(first);
  expect(() =>
    planChildDelegatedAllotment({ ...input, transientReservationId: transientId(2) }),
  ).toThrow('transient reservation is not reconcilable');
  expect(() =>
    planChildDelegatedAllotment({
      ...input,
      state: withTransient(initialState(), 1, 'tool:other-task'),
    }),
  ).toThrow('transient reservation is not reconcilable');
  expect(() =>
    planChildDelegatedAllotment({ ...input, state: applyPlanned(state, first.events) }),
  ).toThrow('transient reservation is not reconcilable');
});

test('delayed child activation starts its own 30-minute clock without changing parent allotment', () => {
  const plan = planChildDelegatedAllotment({
    state: withTransient(initialState(), 1),
    transientReservationId: transientId(1),
    toolFinished: finished(1),
    childThreadId: childId(1),
    role: 'review',
    taskArtifactBytes: 1,
    now: NOW,
  });
  const startedAt = NOW + 60_000;
  const activated = childBudgetAtActivation({
    childBudget: plan.childBudget,
    deadlineAt: plan.deadlineAt,
    startedAt,
    independentTurnDeadline: true,
  });
  expect(activated.maxRunDurationMs).toBe(30 * 60_000);
  expect(plan.childBudget.maxRunDurationMs).toBe(
    plan.reservation.executableUpperBound.gauges.elapsedRunMs,
  );
  expect(
    childBudgetAtActivation({
      childBudget: plan.childBudget,
      deadlineAt: plan.deadlineAt,
      startedAt: Date.parse(plan.deadlineAt),
      independentTurnDeadline: true,
    }).maxRunDurationMs,
  ).toBe(30 * 60_000);
  expect(() =>
    childBudgetAtActivation({
      childBudget: { ...plan.childBudget, unboundedToolInvocations: undefined },
      deadlineAt: plan.deadlineAt,
      startedAt: Date.parse(plan.deadlineAt),
    }),
  ).toThrow('deadline has expired');
});
