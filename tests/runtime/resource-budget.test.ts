import { describe, expect, test } from 'bun:test';
import {
  type BudgetReservation,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  LIMITED_RESOURCE_BUDGET_,
  type ResourceUsage,
  reduceResourceBudgetState,
  tightenResourceBudget,
} from '@kite/runtime-host/kernel-adapter';

function usage(input?: {
  toolInvocations?: number;
  inputTokens?: number;
  outputTokens?: number;
  activeTools?: number;
}): ResourceUsage {
  const value = createZeroResourceUsage('versioned_upper_bound', 'test-estimator-v1');
  value.counters.toolInvocations = input?.toolInvocations ?? 0;
  value.counters.inputTokens = input?.inputTokens ?? 0;
  value.counters.outputTokens = input?.outputTokens ?? 0;
  value.gauges.activeToolInvocations = input?.activeTools ?? 0;
  return value;
}

function actual(input?: { toolInvocations?: number; inputTokens?: number }): ResourceUsage {
  const value = createZeroResourceUsage();
  value.counters.toolInvocations = input?.toolInvocations ?? 0;
  value.counters.inputTokens = input?.inputTokens ?? 0;
  return value;
}

function reservation(
  reservationId: string,
  invocationId: string,
  upper = usage({ toolInvocations: 1, activeTools: 1 }),
  parentReservationId?: string,
): BudgetReservation {
  return {
    version: 1,
    reservationId,
    runId: 'run-1',
    invocationId,
    ...(parentReservationId ? { parentReservationId } : {}),
    resourceKind: 'tool',
    executableUpperBound: upper,
    state: 'reserved',
  };
}

function configured() {
  return reduceResourceBudgetState(
    createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget',
      userId: 'u',
      workspace: '/',
    }).resourceBudget,
    {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: LIMITED_RESOURCE_BUDGET_,
    },
  );
}

describe('ResourceBudget', () => {
  test('freezes the D-11 limited and internal ceilings and allows only tightening', () => {
    expect(LIMITED_RESOURCE_BUDGET_).toMatchObject({
      maxRunDurationMs: 1_800_000,
      maxTurns: 30,
      maxModelRequests: 60,
      maxToolInvocations: 250,
      maxRunInputTokens: 1_000_000,
      maxRunOutputTokens: 250_000,
      maxConcurrentSubagents: 2,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 4,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 15_000,
      maxArtifactBytes: 256 * 1024 * 1024,
    });
    expect(INTERNAL_RESOURCE_BUDGET_.maxToolInvocations).toBe(500);
    expect(tightenResourceBudget(LIMITED_RESOURCE_BUDGET_, { maxTurns: 10 }).maxTurns).toBe(10);
    expect(() => tightenResourceBudget(LIMITED_RESOURCE_BUDGET_, { maxTurns: 31 })).toThrow(
      'can only be lowered',
    );
  });

  test('starts fail-closed and requires one immutable run ledger', () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget',
      userId: 'u',
      workspace: '/',
    }).resourceBudget;
    expect(initial.status).toBe('unconfigured');
    const state = configured();
    expect(state).toMatchObject({ status: 'active', runId: 'run-1', reservations: {} });
    expect(() =>
      reduceResourceBudgetState(state, {
        type: 'resource_budget.configured',
        runId: 'run-2',
        startedAt: '2026-07-30T00:00:00Z',
        deadlineAt: '2026-07-30T00:30:00Z',
        budget: LIMITED_RESOURCE_BUDGET_,
      }),
    ).toThrow('cannot be replaced');
  });

  test('shares cumulative reservations across parent and child invocations', () => {
    let state = configured();
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('parent', 'parent-invocation'),
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('child', 'child-invocation', undefined, 'parent'),
    });
    expect(state.status === 'active' && Object.keys(state.reservations)).toEqual([
      'parent',
      'child',
    ]);
    expect(() =>
      reduceResourceBudgetState(state, {
        type: 'resource_budget.reserved',
        reservation: reservation(
          'overflow',
          'overflow-invocation',
          usage({ toolInvocations: 249, activeTools: 1 }),
        ),
      }),
    ).toThrow('exhausted');
  });

  test('persists dispatch, reconciliation, unknown and release semantics idempotently', () => {
    let state = configured();
    const reserved = reservation('r1', 'i1');
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reserved,
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'r1',
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.unknown',
      reservationId: 'r1',
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'r1',
      actual: actual({ toolInvocations: 1 }),
    });
    const replayed = reduceResourceBudgetState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'r1',
      actual: actual({ toolInvocations: 1 }),
    });
    expect(replayed).toBe(state);
    expect(state.status === 'active' && state.reconciledUsage.counters.toolInvocations).toBe(1);

    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('r2', 'i2'),
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.released',
      reservationId: 'r2',
    });
    expect(state.status === 'active' && state.reservations.r2?.state).toBe('released');
  });
});
