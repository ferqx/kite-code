import { describe, expect, test } from 'bun:test';
import { AgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import {
  planRuntimeBudgetAdmissionV1,
  reconciliationEventsForReservationsV1,
} from '@/core/runtime/resource-budget-admission';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

function configuredState(overrides: Partial<typeof LIMITED_RESOURCE_BUDGET_V1> = {}): RuntimeState {
  return reduceRuntimeState(
    createInitialRuntimeState({ threadId: 'budget', userId: 'u', workspace: '/' }),
    {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: { ...LIMITED_RESOURCE_BUDGET_V1, ...overrides, version: 1 },
    },
  );
}

function apply(
  state: RuntimeState,
  events: Parameters<typeof reduceRuntimeState>[1][],
): RuntimeState {
  return events.reduce(reduceRuntimeState, state);
}

describe('runtime resource budget admission', () => {
  test('persists reservation before dispatch and reconciles terminal usage', () => {
    const state = configuredState();
    const plan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:01Z'),
    );
    expect(plan.status).toBe('admitted');
    expect(plan.preparationEvents.map((event) => event.type)).toEqual(['resource_budget.reserved']);
    expect(plan.dispatchEvents.map((event) => event.type)).toEqual([
      'resource_budget.dispatch_started',
    ]);
    const dispatched = apply(state, [...plan.preparationEvents, ...plan.dispatchEvents]);
    const terminal = reconciliationEventsForReservationsV1(dispatched, plan.reservationIds);
    const reconciled = apply(dispatched, terminal);
    expect(reconciled.resourceBudget).toMatchObject({
      status: 'active',
      reconciledUsage: { counters: { modelRequests: 1 } },
    });
  });

  test('denies cumulative exhaustion before producing dispatch_started', () => {
    const state = configuredState({ maxModelRequests: 1 });
    const first = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:01Z'),
    );
    const dispatched = apply(state, [...first.preparationEvents, ...first.dispatchEvents]);
    const consumed = apply(
      dispatched,
      reconciliationEventsForReservationsV1(dispatched, first.reservationIds),
    );
    consumed.transcript.messages.push({
      kind: 'assistant',
      messageId: 'response-1',
      turnId: consumed.turn.turnId,
      ordinal: 0,
      createdAt: '2026-07-30T00:00:02Z',
      content: 'continue',
      toolCalls: [],
    });
    const second = planRuntimeBudgetAdmissionV1(
      consumed,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:03Z'),
    );
    expect(second).toMatchObject({ status: 'denied', reason: 'budget_exhausted' });
    expect(second.dispatchEvents).toEqual([]);
  });

  test('runner persists dispatch before the executor and reconciles with the terminal batch', async () => {
    const store = createRuntimeStore(':memory:');
    const startedAt = new Date();
    const liveState = reduceRuntimeState(
      createInitialRuntimeState({ threadId: 'budget-live', userId: 'u', workspace: '/' }),
      {
        type: 'resource_budget.configured',
        runId: 'run-live',
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(
          startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
        ).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_V1,
      },
    );
    const kernel = new AgentKernel({
      store,
      initialState: liveState,
      interactionMode: 'accept_edits',
    });
    let sawDispatchBeforeSideEffect = false;
    const eventTypes: string[] = [];
    for await (const event of runRuntimeLoop(
      kernel,
      async (effect, state) => {
        if (effect.type !== 'call_model') return [];
        sawDispatchBeforeSideEffect =
          state.resourceBudget.status === 'active' &&
          Object.values(state.resourceBudget.reservations).some(
            (reservation) => reservation.state === 'dispatch_started',
          );
        return [
          {
            type: 'model.responded',
            messageId: 'budgeted-answer',
            text: 'done',
            inputTokens: 10,
            outputTokens: 2,
          },
        ];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      eventTypes.push(event.type);
    }
    expect(sawDispatchBeforeSideEffect).toBe(true);
    expect(eventTypes.slice(0, 3)).toEqual([
      'resource_budget.reserved',
      'resource_budget.dispatch_started',
      'model.responded',
    ]);
    expect(eventTypes).toContain('resource_budget.reconciled');
    expect(kernel.getState().resourceBudget).toMatchObject({
      status: 'active',
      reconciledUsage: {
        counters: { turns: 1, modelRequests: 1, inputTokens: 10, outputTokens: 2 },
      },
    });
    kernel.close();
  });
});
