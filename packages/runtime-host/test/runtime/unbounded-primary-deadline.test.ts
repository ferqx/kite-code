import { expect, test } from 'bun:test';
import {
  assertAgentStateInvariants,
  reduceAgentState as reduceLeaseState,
} from '@kite-ai/agent-kernel';
import {
  assertResourceBudgetRuntimeState,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  fundingDeadlineMatches,
  LIMITED_RESOURCE_BUDGET_,
  planBoundedFollowupModelResource,
  planModelInvocationResource,
  reduceResourceBudgetState,
  UNBOUNDED_CUMULATIVE_RESOURCE_BUDGET_,
  UNBOUNDED_PRIMARY_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';

const start = '2026-09-01T00:00:00.000Z';
const deadline = '2026-09-01T00:30:00.000Z';
function initial() {
  return createRuntimeHostStateInitialState({
    threadId: 'main',
    userId: 'u',
    workspace: '/',
    recoveryIdentityKey: 'a'.repeat(64),
  });
}
function legacy() {
  return reduceLeaseState(initial(), {
    type: 'resource_budget.configured',
    runId: 'main-run',
    startedAt: start,
    deadlineAt: deadline,
    budget: UNBOUNDED_CUMULATIVE_RESOURCE_BUDGET_,
  });
}

test('durable primary upgrade preserves original funding identity and permits work past it', () => {
  const before = legacy();
  const event = { type: 'resource_budget.run_deadline_removed', runId: 'main-run' } as const;
  const state = reduceLeaseState(before, event);
  expect(state.resourceBudget).toMatchObject({
    deadlineAt: null,
    previousDeadlineAt: deadline,
    budget: { unboundedRunDuration: true, maxRunDurationMs: 0 },
  });
  expect(reduceResourceBudgetState(before.resourceBudget, event)).toEqual(state.resourceBudget);
  assertAgentStateInvariants(state);
  assertResourceBudgetRuntimeState(state.resourceBudget);
  const ledger = state.resourceBudget;
  if (ledger.status !== 'active') throw new Error('missing ledger');
  expect(fundingDeadlineMatches(ledger, deadline)).toBe(true);
  expect(fundingDeadlineMatches(ledger, null)).toBe(true);
  expect(fundingDeadlineMatches(ledger, '2026-09-01T00:31:00.000Z')).toBe(false);
  const model = planModelInvocationResource(state, {
    invocationId: 'model-after-old-deadline',
    inputTokens: 20,
    resourceKind: 'model',
    now: new Date('2026-09-02T00:00:00.000Z'),
  });
  expect(model.preparationEvents).toHaveLength(1);
  expect(() =>
    planBoundedFollowupModelResource(state, {
      fundingRunId: 'main-run',
      fundingDeadlineAt: deadline,
      backupReservationId: 'legacy-backup',
      turnReservationId: 'legacy-turn',
      replacementReservationId: 'legacy-model',
      invocationId: 'legacy-model',
      inputTokens: 20,
      now: new Date('2026-09-02T00:00:00.000Z'),
    }),
  ).toThrow('Funding run deadline elapsed');
  const upper = createZeroResourceUsage('versioned_upper_bound', 'unlimited-test');
  upper.counters.toolInvocations = 1;
  upper.gauges.elapsedRunMs = 24 * 60 * 60_000;
  const next = reduceLeaseState(state, {
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: 'late-tool',
      runId: 'main-run',
      invocationId: 'late-tool',
      resourceKind: 'tool',
      executableUpperBound: upper,
      state: 'reserved',
    },
  });
  expect(
    reduceLeaseState(next, { type: 'resource_budget.dispatch_started', reservationId: 'late-tool' })
      .resourceBudget.reservations['late-tool']?.state,
  ).toBe('dispatch_started');
  expect(reduceLeaseState(state, event)).toBe(state);
});

test('null requires explicit primary marker and cannot upgrade child or wrong Run', () => {
  expect(() =>
    reduceLeaseState(initial(), {
      type: 'resource_budget.configured',
      runId: 'r',
      startedAt: start,
      deadlineAt: null,
      budget: LIMITED_RESOURCE_BUDGET_,
    }),
  ).toThrow();
  const primary = reduceLeaseState(initial(), {
    type: 'resource_budget.configured',
    runId: 'r',
    startedAt: start,
    deadlineAt: null,
    budget: UNBOUNDED_PRIMARY_RESOURCE_BUDGET_,
  });
  assertAgentStateInvariants(primary);
  expect(() =>
    reduceLeaseState(legacy(), { type: 'resource_budget.run_deadline_removed', runId: 'wrong' }),
  ).toThrow();
  const child = { ...legacy(), childSessionOrigin: {} as never };
  expect(() =>
    reduceLeaseState(child, { type: 'resource_budget.run_deadline_removed', runId: 'main-run' }),
  ).toThrow();
  expect(() =>
    reduceLeaseState(
      { ...initial(), childSessionOrigin: {} as never },
      {
        type: 'resource_budget.configured',
        runId: 'r',
        startedAt: start,
        deadlineAt: null,
        budget: UNBOUNDED_PRIMARY_RESOURCE_BUDGET_,
      },
    ),
  ).toThrow();
  expect(() =>
    assertAgentStateInvariants({
      ...initial(),
      childSessionOrigin: {} as never,
      retainedResourceBudgets: { r: primary.resourceBudget as never },
    }),
  ).toThrow('retain primary');
  if (primary.resourceBudget.status !== 'active') throw new Error('missing ledger');
  const ledger = primary.resourceBudget;
  expect(() =>
    assertResourceBudgetRuntimeState({ ...ledger, previousDeadlineAt: 'invalid' }),
  ).toThrow();
});
