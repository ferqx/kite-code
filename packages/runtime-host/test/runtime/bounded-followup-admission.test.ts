import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
  planBoundedFollowupModelResource,
  reduceResourceBudgetState,
} from '@kite-ai/runtime-host/kernel-adapter';

const deadlineAt = '2026-09-23T00:30:00.000Z';

function state() {
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'session',
    userId: 'user',
    workspace: '/workspace',
  });
  const configured = reduceResourceBudgetState(initial.resourceBudget, {
    type: 'resource_budget.configured',
    runId: 'funding-run',
    startedAt: '2026-09-23T00:00:00.000Z',
    deadlineAt,
    budget: LIMITED_RESOURCE_BUDGET_,
  });
  const upper = createZeroResourceUsage('versioned_upper_bound', 'test-backup-v1');
  upper.counters.turns = 1;
  upper.counters.modelRequests = 1;
  upper.counters.inputTokens = 100;
  upper.counters.outputTokens = 50;
  upper.gauges.activeSubagents = 1;
  return {
    ...initial,
    resourceBudget: reduceResourceBudgetState(configured, {
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'backup',
        runId: 'funding-run',
        invocationId: 'followup-command',
        resourceKind: 'subagent',
        executableUpperBound: upper,
        state: 'reserved',
      },
    }),
  };
}

const input = {
  fundingRunId: 'funding-run',
  fundingDeadlineAt: deadlineAt,
  backupReservationId: 'backup',
  replacementReservationId: 'first-model',
  turnReservationId: 'child-turn',
  invocationId: 'first-model',
  inputTokens: 50,
  requestedMaxOutputTokens: 50,
  now: new Date('2026-09-23T00:01:00.000Z'),
};

describe('bounded followup model admission', () => {
  test('returns one atomic replacement event for the frozen first Surface', () => {
    const before = state();
    const plan = planBoundedFollowupModelResource(before, input);
    expect(plan.preparationEvents).toHaveLength(1);
    expect(plan.preparationEvents[0]?.type).toBe('resource_budget.bounded_replaced');
    const event = plan.preparationEvents[0]! as Extract<
      (typeof plan.preparationEvents)[number],
      { type: 'resource_budget.bounded_replaced' }
    >;
    const after = reduceResourceBudgetState(before.resourceBudget, event);
    expect(after.reservations.backup?.state).toBe('released');
    expect(after.reservations['child-turn']?.executableUpperBound).toMatchObject({
      counters: { turns: 1, modelRequests: 0 },
      gauges: { activeSubagents: 1 },
    });
    expect(after.reservations['first-model']?.executableUpperBound.counters).toMatchObject({
      turns: 0,
      modelRequests: 1,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(plan.turnReservationId).toBe('child-turn');
    expect(plan.turnDispatchEvent).toEqual({
      type: 'resource_budget.dispatch_started',
      reservationId: 'child-turn',
    });
    expect(reduceResourceBudgetState(after, event)).toBe(after);
  });

  test('keeps backup on bound, ledger, deadline and unknown failures', () => {
    const before = state();
    for (const changed of [
      { inputTokens: 51 },
      { requestedMaxOutputTokens: 51 },
      { fundingRunId: 'new-run' },
      { fundingDeadlineAt: '2026-09-23T00:31:00.000Z' },
      { now: new Date(deadlineAt) },
    ]) {
      expect(() => planBoundedFollowupModelResource(before, { ...input, ...changed })).toThrow();
      expect(before.resourceBudget.reservations.backup?.state).toBe('reserved');
    }
    const unknown = {
      ...before,
      resourceBudget: reduceResourceBudgetState(before.resourceBudget, {
        type: 'resource_budget.unknown',
        reservationId: 'backup',
      }),
    };
    expect(() => planBoundedFollowupModelResource(unknown, input)).toThrow();
  });

  test('covers the already committed target Run input ceiling without exceeding backup', () => {
    const before = state();
    const plan = planBoundedFollowupModelResource(before, {
      ...input,
      inputTokens: 20,
      minimumInputTokensUpperBound: 80,
    });
    const event = plan.preparationEvents[0]! as Extract<
      (typeof plan.preparationEvents)[number],
      { type: 'resource_budget.bounded_replaced' }
    >;
    expect(event.replacement.executableUpperBound.counters.inputTokens).toBe(80);
    expect(() =>
      planBoundedFollowupModelResource(before, {
        ...input,
        inputTokens: 20,
        minimumInputTokensUpperBound: 101,
      }),
    ).toThrow();
    expect(before.resourceBudget.reservations.backup?.state).toBe('reserved');
  });

  test('admits a retained funding Run after a new foreground Run starts', () => {
    const before = state();
    if (before.resourceBudget.status !== 'active') throw new Error('Fixture budget is inactive.');
    const current = reduceResourceBudgetState(
      { status: 'unconfigured', reservations: {} },
      {
        type: 'resource_budget.configured',
        runId: 'new-run',
        startedAt: '2026-09-23T00:02:00.000Z',
        deadlineAt: '2026-09-23T00:32:00.000Z',
        budget: LIMITED_RESOURCE_BUDGET_,
      },
    );
    if (current.status !== 'active') throw new Error('New budget is inactive.');
    const rotated = {
      ...before,
      resourceBudget: current,
      retainedResourceBudgets: { 'funding-run': before.resourceBudget },
    };
    const plan = planBoundedFollowupModelResource(rotated, input);
    expect(plan.preparationEvents[0]).toMatchObject({
      type: 'resource_budget.bounded_replaced',
      reservationId: 'backup',
    });
    expect(rotated.resourceBudget.runId).toBe('new-run');
    expect(() =>
      planBoundedFollowupModelResource(rotated, {
        ...input,
        fundingRunId: 'new-run',
      }),
    ).toThrow();
  });
});
