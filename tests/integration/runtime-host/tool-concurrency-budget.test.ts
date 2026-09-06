import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
  planRuntimeBudgetAdmission,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

function withQueuedTools(names: string[]): RuntimeState {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'tools',
    userId: 'u',
    workspace: '/',
  });
  state = reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: 'run-tools',
    startedAt: '2026-07-30T00:00:00Z',
    deadlineAt: '2026-07-30T00:30:00Z',
    budget: LIMITED_RESOURCE_BUDGET_,
  });
  for (const [index, name] of names.entries()) {
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: `call-${index}`,
      name,
      args: {},
      effectClass: 'read_only',
      sideEffect: false,
    });
  }
  return state;
}

describe('tool concurrency budget', () => {
  test('shrinks a subagent batch to the shared child concurrency ceiling', () => {
    let state = withQueuedTools(['task', 'task', 'task']);
    state = {
      ...state,
      resourceBudget: {
        ...state.resourceBudget,
        budget: {
          ...LIMITED_RESOURCE_BUDGET_,
          maxConcurrentSubagents: 2,
        },
      } as Extract<RuntimeState['resourceBudget'], { status: 'active' }>,
    };
    for (const call of Object.values(state.tools.calls)) {
      call.args = {
        subagent_type: 'review',
        task: 'Review one independent runtime concern and report evidence.',
      };
    }

    const plan = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['call-0', 'call-1', 'call-2'] },
      new Date('2026-07-30T00:00:01Z'),
    );

    expect(plan.status).toBe('admitted');
    expect(plan.effect).toEqual({ type: 'run_tools', toolCallIds: ['call-0', 'call-1'] });
    expect(plan.reservationIds).toHaveLength(2);
    expect(
      plan.preparationEvents.filter((event) => event.type === 'resource_budget.waiter_enqueued'),
    ).toHaveLength(1);
  });

  test('admits every ordinary tool in one model batch without concurrency waiters', () => {
    let state = withQueuedTools(['read_file', 'search_files', 'read_file']);
    const running = createZeroResourceUsage('versioned_upper_bound', 'test-v1');
    running.counters.toolInvocations = 1;
    running.gauges.activeToolInvocations = 1;
    state = reduceRuntimeState(state, {
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'existing',
        runId: 'run-tools',
        invocationId: 'existing-tool',
        resourceKind: 'tool',
        executableUpperBound: running,
        state: 'reserved',
      },
    });
    state = reduceRuntimeState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'existing',
    });

    const plan = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['call-0', 'call-1', 'call-2'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    expect(plan.status).toBe('admitted');
    expect(plan.effect).toEqual({
      type: 'run_tools',
      toolCallIds: ['call-0', 'call-1', 'call-2'],
    });
    expect(plan.reservationIds).toHaveLength(3);
    expect(
      plan.preparationEvents.filter((event) => event.type === 'resource_budget.waiter_enqueued'),
    ).toHaveLength(0);
  });

  test('admits another shell while an earlier shell is still active', () => {
    let state = withQueuedTools(['shell_execute']);
    const running = createZeroResourceUsage('versioned_upper_bound', 'test-v1');
    running.counters.toolInvocations = 1;
    running.gauges.activeToolInvocations = 1;
    running.gauges.activeShellInvocations = 1;
    state = reduceRuntimeState(state, {
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'running-shell',
        runId: 'run-tools',
        invocationId: 'running-shell',
        resourceKind: 'tool',
        executableUpperBound: running,
        state: 'reserved',
      },
    });
    state = reduceRuntimeState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'running-shell',
    });
    const plan = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['call-0'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    expect(plan.status).toBe('admitted');
    expect(plan.effect).toEqual({ type: 'run_tools', toolCallIds: ['call-0'] });
    expect(plan.reservationIds).toHaveLength(1);
    expect(
      plan.preparationEvents.some((event) => event.type === 'resource_budget.waiter_enqueued'),
    ).toBe(false);
  });
});
