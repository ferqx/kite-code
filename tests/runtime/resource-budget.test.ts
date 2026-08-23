import { describe, expect, test } from 'bun:test';
import {
  type BudgetReservationV1,
  createRuntimeHostStateInitialStateV1,
  createZeroResourceUsageV1,
  INTERNAL_RESOURCE_BUDGET_V1,
  LIMITED_RESOURCE_BUDGET_V1,
  type ResourceUsageV1,
  reduceResourceBudgetStateV1,
  tightenResourceBudgetV1,
} from '@kite/runtime-host';

function usage(input?: {
  toolInvocations?: number;
  inputTokens?: number;
  outputTokens?: number;
  activeTools?: number;
}): ResourceUsageV1 {
  const value = createZeroResourceUsageV1('versioned_upper_bound', 'test-estimator-v1');
  value.counters.toolInvocations = input?.toolInvocations ?? 0;
  value.counters.inputTokens = input?.inputTokens ?? 0;
  value.counters.outputTokens = input?.outputTokens ?? 0;
  value.gauges.activeToolInvocations = input?.activeTools ?? 0;
  return value;
}

function actual(input?: { toolInvocations?: number; inputTokens?: number }): ResourceUsageV1 {
  const value = createZeroResourceUsageV1();
  value.counters.toolInvocations = input?.toolInvocations ?? 0;
  value.counters.inputTokens = input?.inputTokens ?? 0;
  return value;
}

function reservation(
  reservationId: string,
  invocationId: string,
  upper = usage({ toolInvocations: 1, activeTools: 1 }),
  parentReservationId?: string,
): BudgetReservationV1 {
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
  return reduceResourceBudgetStateV1(
    createRuntimeHostStateInitialStateV1({
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
      budget: LIMITED_RESOURCE_BUDGET_V1,
    },
  );
}

describe('ResourceBudgetV1', () => {
  test('freezes the D-11 limited and internal ceilings and allows only tightening', () => {
    expect(LIMITED_RESOURCE_BUDGET_V1).toMatchObject({
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
    expect(INTERNAL_RESOURCE_BUDGET_V1.maxToolInvocations).toBe(500);
    expect(tightenResourceBudgetV1(LIMITED_RESOURCE_BUDGET_V1, { maxTurns: 10 }).maxTurns).toBe(10);
    expect(() => tightenResourceBudgetV1(LIMITED_RESOURCE_BUDGET_V1, { maxTurns: 31 })).toThrow(
      'can only be lowered',
    );
  });

  test('starts fail-closed and requires one immutable run ledger', () => {
    const initial = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget',
      userId: 'u',
      workspace: '/',
    }).resourceBudget;
    expect(initial.status).toBe('unconfigured');
    const state = configured();
    expect(state).toMatchObject({ status: 'active', runId: 'run-1', reservations: {} });
    expect(() =>
      reduceResourceBudgetStateV1(state, {
        type: 'resource_budget.configured',
        runId: 'run-2',
        startedAt: '2026-07-30T00:00:00Z',
        deadlineAt: '2026-07-30T00:30:00Z',
        budget: LIMITED_RESOURCE_BUDGET_V1,
      }),
    ).toThrow('cannot be replaced');
  });

  test('shares cumulative reservations across parent and child invocations', () => {
    let state = configured();
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('parent', 'parent-invocation'),
    });
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('child', 'child-invocation', undefined, 'parent'),
    });
    expect(state.status === 'active' && Object.keys(state.reservations)).toEqual([
      'parent',
      'child',
    ]);
    expect(() =>
      reduceResourceBudgetStateV1(state, {
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
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.reserved',
      reservation: reserved,
    });
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'r1',
    });
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.unknown',
      reservationId: 'r1',
    });
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'r1',
      actual: actual({ toolInvocations: 1 }),
    });
    const replayed = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'r1',
      actual: actual({ toolInvocations: 1 }),
    });
    expect(replayed).toBe(state);
    expect(state.status === 'active' && state.reconciledUsage.counters.toolInvocations).toBe(1);

    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('r2', 'i2'),
    });
    state = reduceResourceBudgetStateV1(state, {
      type: 'resource_budget.released',
      reservationId: 'r2',
    });
    expect(state.status === 'active' && state.reservations.r2?.state).toBe('released');
  });
});
