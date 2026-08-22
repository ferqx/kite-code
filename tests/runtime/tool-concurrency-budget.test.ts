import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostState25InitialStateV1,
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
  planRuntimeBudgetAdmissionV1,
  type RuntimeState,
} from '@kite/runtime-host';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';

function withQueuedTools(names: string[]): RuntimeState {
  let state = createRuntimeHostState25InitialStateV1({
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
    budget: {
      ...LIMITED_RESOURCE_BUDGET_V1,
      maxConcurrentToolInvocations: 2,
      maxConcurrentShellInvocations: 1,
    },
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
          ...LIMITED_RESOURCE_BUDGET_V1,
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

    const plan = planRuntimeBudgetAdmissionV1(
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

  test('shrinks a batch to available permits and queues the remainder in FIFO order', () => {
    let state = withQueuedTools(['read_file', 'search_files', 'read_file']);
    const running = createZeroResourceUsageV1('versioned_upper_bound', 'test-v1');
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

    const plan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'run_tools', toolCallIds: ['call-0', 'call-1', 'call-2'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    expect(plan.status).toBe('admitted');
    expect(plan.effect).toEqual({ type: 'run_tools', toolCallIds: ['call-0'] });
    expect(plan.preparationEvents.map((event) => event.type)).toEqual([
      'resource_budget.reserved',
      'resource_budget.waiter_enqueued',
      'resource_budget.waiter_enqueued',
    ]);
  });

  test('never grants the tool half of a compound shell permit', () => {
    let state = withQueuedTools(['shell_execute']);
    const running = createZeroResourceUsageV1('versioned_upper_bound', 'test-v1');
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
    const plan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'run_tools', toolCallIds: ['call-0'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    expect(plan).toMatchObject({
      status: 'waiting',
      reason: 'shell_concurrency_saturated',
      reservationIds: [],
      dispatchEvents: [],
    });
    expect(plan.preparationEvents[0]).toMatchObject({
      type: 'resource_budget.waiter_enqueued',
      waiter: { requiredPermits: ['tool', 'shell_invocation'], sequence: 0 },
    });
  });
});
