import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '@/core/config';
import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { aiMessage } from '@/core/messages';
import type { RuntimeEvent } from '@/core/runtime/events';
import {
  createRuntimeEffectExecutor,
  prepareRuntimeEffectForBudgetV1,
  shouldEscalateAutoReviewResult,
} from '@/core/runtime/executor';
import { resolveFailureModeV1 } from '@/core/runtime/failure-mode-conformance';
import { classifyFailure } from '@/core/runtime/failures';
import { AgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import {
  createDescendantResourceAdmissionV1,
  DescendantResourceAdmissionError,
  planRuntimeBudgetAdmissionV1,
  reconciliationEventsForReservationsV1,
} from '@/core/runtime/resource-budget-admission';
import { resolveResourceAdmissionFailureOutcomeV1, runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { failedTerminalOutcomeV1 } from '@/core/runtime/terminal-outcome';
import { createMockModel } from '../mock-model';

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

  test('reserves the exact main-model projection and clamps Provider output', async () => {
    let state = configuredState({ maxRunOutputTokens: 7 });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'budgeted-prompt',
      content: 'Inspect the current runtime state.',
    });
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'budget-model',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      modelKwargs: { maxOutputTokens: 100 },
      sandbox: { enabled: false },
    };
    const model = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
    let providerMaxOutputTokens: number | undefined;
    const rawModel = model.model as unknown as {
      doGenerate: (options: { maxOutputTokens?: number }) => Promise<unknown>;
    };
    const originalGenerate = rawModel.doGenerate.bind(rawModel);
    rawModel.doGenerate = async (options: { maxOutputTokens?: number }) => {
      providerMaxOutputTokens = options.maxOutputTokens;
      return originalGenerate(options);
    };

    const prepared = prepareRuntimeEffectForBudgetV1({ type: 'call_model' }, state, {
      config,
      model,
    });
    if (prepared.type !== 'call_model' || !prepared.resourceEstimate) {
      throw new Error('Expected a prepared model effect.');
    }
    if (!Number.isFinite(prepared.resourceEstimate.inputTokens)) {
      throw new Error(`Non-finite input estimate: ${prepared.resourceEstimate.inputTokens}`);
    }
    expect(prepared.resourceEstimate.inputTokens).toBeGreaterThan(0);
    expect(prepared.resourceEstimate.maxOutputTokens).toBe(7);
    const admission = planRuntimeBudgetAdmissionV1(
      state,
      prepared,
      new Date('2026-07-30T00:00:01Z'),
    );
    expect(admission.reason).toBe('admitted');
    expect(admission.status).toBe('admitted');
    expect(admission.preparationEvents[0]).toMatchObject({
      type: 'resource_budget.reserved',
      reservation: {
        executableUpperBound: {
          counters: {
            inputTokens: prepared.resourceEstimate?.inputTokens,
            outputTokens: 7,
          },
        },
      },
    });

    await invokeRuntimeModel({
      model,
      state,
      config,
      resourceAdmission: prepared.resourceEstimate,
    });
    expect(providerMaxOutputTokens).toBe(7);
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

  test('preserves unknown external outcome instead of misclassifying it as budget exhaustion', () => {
    const state = configuredState();
    const first = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:01Z'),
    );
    const dispatched = apply(state, [...first.preparationEvents, ...first.dispatchEvents]);
    const unknown = apply(
      dispatched,
      first.reservationIds.map((reservationId) => ({
        type: 'resource_budget.unknown' as const,
        reservationId,
      })),
    );

    const resumed = planRuntimeBudgetAdmissionV1(
      unknown,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:02Z'),
    );
    expect(resumed).toMatchObject({
      status: 'denied',
      reason: 'reconciliation_required',
    });
    expect(resumed.preparationEvents).toEqual([]);
    expect(resumed.dispatchEvents).toEqual([]);
  });

  test('releases dispatch-started usage only with local Provider denial proof', () => {
    const state = configuredState();
    const plan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:01Z'),
    );
    const dispatched = apply(state, [...plan.preparationEvents, ...plan.dispatchEvents]);
    const reservationId = plan.reservationIds[0]!;

    expect(() =>
      reduceRuntimeState(dispatched, {
        type: 'resource_budget.released',
        reservationId,
      }),
    ).toThrow('Only a proven undispatched reservation can be released');
    expect(
      reduceRuntimeState(dispatched, {
        type: 'resource_budget.released',
        reservationId,
        proof: 'local_provider_admission_denied',
      }).resourceBudget,
    ).toMatchObject({
      reservations: { [reservationId]: { state: 'released' } },
    });
  });

  test('enforces every Sub-agent model invocation in the shared durable ledger', async () => {
    let state = configuredState({ maxModelRequests: 1 });
    state.tools.calls['task-1'] = {
      toolCallId: 'task-1',
      modelMessageId: 'model-1',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-1');
    const parentPlan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'run_tools', toolCallIds: ['task-1'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const persisted: string[] = [];
    const admission = createDescendantResourceAdmissionV1({
      state,
      parentReservationId: parentPlan.reservationIds[0]!,
      now: () => new Date('2026-07-30T00:00:02Z'),
      persistEvent: async (event) => {
        state = reduceRuntimeState(state, event);
        persisted.push(event.type);
        return true;
      },
      persistEvents: async (events) => {
        state = apply(state, events);
        persisted.push(...events.map((event) => event.type));
        return true;
      },
    });

    const first = await admission.reserveModel({
      invocationKey: 'model:0',
      inputTokens: 20,
      requestedMaxOutputTokens: 5,
    });
    await admission.reconcileModel({
      reservationId: first.reservationId,
      inputTokens: 20,
      outputTokens: 3,
    });
    await expect(
      admission.reserveModel({
        invocationKey: 'model:1',
        inputTokens: 20,
        requestedMaxOutputTokens: 5,
      }),
    ).rejects.toThrow('Resource budget exhausted before dispatch');

    expect(persisted).toEqual([
      'resource_budget.reserved',
      'resource_budget.dispatch_started',
      'resource_budget.reconciled',
    ]);
    expect(state.resourceBudget).toMatchObject({
      status: 'active',
      reconciledUsage: {
        counters: { modelRequests: 1, inputTokens: 20, outputTokens: 3 },
      },
    });
  });

  test('blocks descendant dispatch when the persisted run deadline has elapsed', async () => {
    let state = configuredState();
    state.tools.calls['task-deadline'] = {
      toolCallId: 'task-deadline',
      modelMessageId: 'model-deadline',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-deadline');
    const parentPlan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'run_tools', toolCallIds: ['task-deadline'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    let persisted = 0;
    const admission = createDescendantResourceAdmissionV1({
      state,
      parentReservationId: parentPlan.reservationIds[0]!,
      now: () => new Date('2026-07-30T00:30:01Z'),
      persistEvent: async () => {
        persisted += 1;
        return true;
      },
      persistEvents: async () => {
        persisted += 1;
        return true;
      },
    });

    let rejected: unknown;
    try {
      await admission.reserveModel({ invocationKey: 'model:late', inputTokens: 1 });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ reason: 'budget_exhausted' });
    expect(persisted).toBe(0);
  });

  test('queues descendant tool permits durably in FIFO order and promotes atomically', async () => {
    let state = configuredState({
      maxConcurrentToolInvocations: 1,
      maxConcurrencyWaitMs: 1_000,
    });
    if (state.resourceBudget.status === 'active') {
      state.resourceBudget = {
        ...state.resourceBudget,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    state.tools.calls['task-fifo'] = {
      toolCallId: 'task-fifo',
      modelMessageId: 'model-fifo',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-fifo');
    const parentPlan = planRuntimeBudgetAdmissionV1(state, {
      type: 'run_tools',
      toolCallIds: ['task-fifo'],
    });
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const batches: string[][] = [];
    const persistEvents = async (events: import('@/core/runtime/events').RuntimeEvent[]) => {
      kernel.processEventBatch(events);
      batches.push(events.map((event) => event.type));
      return true;
    };
    const admission = () =>
      createDescendantResourceAdmissionV1({
        state: kernel.getState(),
        parentReservationId: parentPlan.reservationIds[0]!,
        getState: () => kernel.getState(),
        persistEvent: async (event) => persistEvents([event]),
        persistEvents,
      });
    const firstAdmission = admission();
    const secondAdmission = admission();

    const firstPromise = firstAdmission.reserveTool({
      invocationKey: 'tool:first',
      toolKind: 'read_file',
      shell: false,
    });
    const secondPromise = secondAdmission.reserveTool({
      invocationKey: 'tool:second',
      toolKind: 'read_file',
      shell: false,
    });
    const first = await firstPromise;
    for (let i = 0; i < 20; i++) {
      const budget = kernel.getState().resourceBudget;
      if (
        budget.status === 'active' &&
        Object.values(budget.waiters).some((waiter) => waiter.state === 'waiting')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const waitingBudget = kernel.getState().resourceBudget;
    expect(
      waitingBudget.status === 'active'
        ? Object.values(waitingBudget.waiters).map((waiter) => waiter.state)
        : [],
    ).toEqual(['waiting']);

    await firstAdmission.reconcileTool({ reservationId: first.reservationId });
    const second = await secondPromise;
    expect(batches).toContainEqual(['resource_budget.waiter_promoted', 'resource_budget.reserved']);
    expect(kernel.getState().resourceBudget).toMatchObject({
      status: 'active',
      reservations: { [second.reservationId]: { state: 'dispatch_started' } },
    });
    await secondAdmission.reconcileTool({ reservationId: second.reservationId });
    kernel.close();
  });

  test('cancels a queued descendant permit with the child invocation signal', async () => {
    let state = configuredState({
      maxConcurrentToolInvocations: 1,
      maxConcurrencyWaitMs: 1_000,
    });
    if (state.resourceBudget.status === 'active') {
      state.resourceBudget = {
        ...state.resourceBudget,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    state.tools.calls['task-cancel'] = {
      toolCallId: 'task-cancel',
      modelMessageId: 'model-cancel',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-cancel');
    const parentPlan = planRuntimeBudgetAdmissionV1(state, {
      type: 'run_tools',
      toolCallIds: ['task-cancel'],
    });
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const persistEvents = async (events: import('@/core/runtime/events').RuntimeEvent[]) => {
      kernel.processEventBatch(events);
      return true;
    };
    const admission = createDescendantResourceAdmissionV1({
      state: kernel.getState(),
      parentReservationId: parentPlan.reservationIds[0]!,
      getState: () => kernel.getState(),
      persistEvent: async (event) => persistEvents([event]),
      persistEvents,
    });
    const occupied = await admission.reserveTool({
      invocationKey: 'tool:occupied',
      toolKind: 'read_file',
      shell: false,
    });
    const abortController = new AbortController();
    const queued = admission.reserveTool({
      invocationKey: 'tool:cancelled',
      toolKind: 'read_file',
      shell: false,
      signal: abortController.signal,
    });

    await Bun.sleep(10);
    abortController.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(kernel.getState().resourceBudget).toMatchObject({
      status: 'active',
      waiters: {
        'descendant:tool:task-cancel:tool:cancelled': { state: 'cancelled' },
      },
    });

    await admission.reconcileTool({ reservationId: occupied.reservationId });
    kernel.close();
  });

  test('times out a descendant compound permit with a typed canonical reason', async () => {
    let state = configuredState({
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 5,
    });
    if (state.resourceBudget.status === 'active') {
      state.resourceBudget = {
        ...state.resourceBudget,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    state.tools.calls['task-timeout'] = {
      toolCallId: 'task-timeout',
      modelMessageId: 'model-timeout',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-timeout');
    const parentPlan = planRuntimeBudgetAdmissionV1(state, {
      type: 'run_tools',
      toolCallIds: ['task-timeout'],
    });
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const persisted: string[] = [];
    const admission = createDescendantResourceAdmissionV1({
      state,
      parentReservationId: parentPlan.reservationIds[0]!,
      getState: () => state,
      persistEvent: async (event) => {
        state = reduceRuntimeState(state, event);
        persisted.push(event.type);
        return true;
      },
      persistEvents: async (events) => {
        state = apply(state, events);
        persisted.push(...events.map((event) => event.type));
        return true;
      },
    });
    const occupied = await admission.reserveTool({
      invocationKey: 'shell:occupied',
      toolKind: 'shell_execute',
      shell: true,
    });

    let rejected: unknown;
    try {
      await admission.reserveTool({
        invocationKey: 'shell:timeout',
        toolKind: 'shell_execute',
        shell: true,
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(DescendantResourceAdmissionError);
    expect(rejected).toMatchObject({ reason: 'shell_concurrency_saturated' });
    expect(persisted).toEqual([
      'resource_budget.reserved',
      'resource_budget.dispatch_started',
      'resource_budget.waiter_enqueued',
      'resource_budget.waiter_timed_out',
    ]);
    await admission.reconcileTool({ reservationId: occupied.reservationId });
  });

  test('reconciles a late descendant terminal only through the bounded resource path', async () => {
    let state = configuredState();
    state.tools.calls['task-late'] = {
      toolCallId: 'task-late',
      modelMessageId: 'model-late',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-late');
    const parentPlan = planRuntimeBudgetAdmissionV1(
      state,
      {
        type: 'run_tools',
        toolCallIds: ['task-late'],
      },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    let rejectNormalReconciliation = false;
    let lateCalls = 0;
    const admission = createDescendantResourceAdmissionV1({
      state,
      parentReservationId: parentPlan.reservationIds[0]!,
      now: () => new Date('2026-07-30T00:00:02Z'),
      getState: () => state,
      persistEvent: async (event) => {
        if (rejectNormalReconciliation && event.type === 'resource_budget.reconciled') return false;
        state = reduceRuntimeState(state, event);
        return true;
      },
      persistEvents: async (events) => {
        state = apply(state, events);
        return true;
      },
      persistLateResourceReconciliation: async (event) => {
        lateCalls += 1;
        state = reduceRuntimeState(state, event);
        return true;
      },
    });
    const reservation = await admission.reserveTool({
      invocationKey: 'tool:late',
      toolKind: 'read_file',
      shell: false,
    });
    state = reduceRuntimeState(state, {
      type: 'resource_budget.unknown',
      reservationId: reservation.reservationId,
    });
    rejectNormalReconciliation = true;

    await admission.reconcileTool({ reservationId: reservation.reservationId });
    expect(lateCalls).toBe(1);
    expect(state.resourceBudget).toMatchObject({
      status: 'active',
      reservations: { [reservation.reservationId]: { state: 'reconciled' } },
    });
  });

  test('rejects non-reconciliation events from the late resource channel at runtime', () => {
    const state = configuredState();
    const plan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:01Z'),
    );
    const dispatched = apply(state, [...plan.preparationEvents, ...plan.dispatchEvents]);
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: dispatched,
      interactionMode: 'accept_edits',
    });
    const revision = kernel.getState().revision;

    expect(
      kernel.applyLateResourceReconciliation([
        {
          type: 'user.message_appended',
          messageId: 'late-channel-injection',
          content: 'must not be accepted',
        },
      ]),
    ).toBe(false);
    expect(kernel.getState().revision).toBe(revision);
    expect(kernel.applyLateResourceReconciliation([])).toBe(false);
    expect(
      kernel.applyLateResourceReconciliation([
        {
          type: 'resource_budget.reconciled',
          reservationId: plan.reservationIds[0]!,
          actual: createZeroResourceUsageV1(),
        },
      ]),
    ).toBe(true);
    expect(kernel.getState().revision).toBe(revision + 1);
    kernel.close();
  });

  test('opens a distinct parent reservation when a suspended Sub-agent resumes', () => {
    let state = configuredState();
    state.tools.calls['task-1'] = {
      toolCallId: 'task-1',
      modelMessageId: 'model-1',
      name: 'task',
      args: { subagent_type: 'code', task: 'continue' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-1');
    const first = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'run_tools', toolCallIds: ['task-1'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...first.preparationEvents, ...first.dispatchEvents]);
    state = apply(state, reconciliationEventsForReservationsV1(state, first.reservationIds));
    state.suspendedSubagents['task-1'] = {
      subagentId: 'subagent-1',
      role: 'code',
      task: 'continue',
      messages: [],
      toolCallCount: 1,
      steps: [],
      blockedTool: {
        toolCallId: 'nested-shell',
        toolName: 'shell_execute',
        args: { command: 'pwd' },
        command: 'pwd',
      },
    };

    const resumed = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'run_tools', toolCallIds: ['task-1'] },
      new Date('2026-07-30T00:00:02Z'),
    );

    expect(resumed).toMatchObject({
      status: 'admitted',
      effect: { type: 'run_tools', toolCallIds: ['task-1'] },
    });
    expect(resumed.preparationEvents[0]).toMatchObject({
      type: 'resource_budget.reserved',
      reservation: {
        invocationId: 'tool:task-1:resume:1',
        resourceKind: 'subagent',
      },
    });
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

  test('runner emits the canonical failure-mode outcome when budget admission is denied', async () => {
    const now = Date.now();
    const state = configuredState({ maxModelRequests: 1 });
    if (state.resourceBudget.status === 'active') {
      state.resourceBudget = {
        ...state.resourceBudget,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
        reconciledUsage: {
          ...state.resourceBudget.reconciledUsage,
          counters: {
            ...state.resourceBudget.reconciledUsage.counters,
            modelRequests: 1,
          },
        },
      };
    }
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const events: import('@/core/runtime/events').RuntimeEvent[] = [];
    let executorCalled = false;

    for await (const event of runRuntimeLoop(
      kernel,
      async () => {
        executorCalled = true;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event);
    }

    expect(executorCalled).toBe(false);
    const terminal = events.find((event) => event.type === 'run.error');
    expect(terminal).toMatchObject({
      type: 'run.error',
      failure: { kind: 'budget_exceeded' },
    });
    expect(terminal?.type === 'run.error' ? terminal.outcome : undefined).toEqual(
      resolveFailureModeV1('budget_exhausted', {
        knownExternalEffects: 'known',
      }).terminalOutcome!,
    );
    kernel.close();
  });

  test('projects descendant permit timeout through the canonical run terminal policy', async () => {
    let state = configuredState({
      maxConcurrentToolInvocations: 1,
      maxConcurrencyWaitMs: 5,
    });
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    state.resourceBudget = {
      ...state.resourceBudget,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    };
    const occupiedUsage = createZeroResourceUsageV1(
      'versioned_upper_bound',
      'descendant-terminal-test-v1',
    );
    occupiedUsage.counters.toolInvocations = 1;
    occupiedUsage.gauges.activeToolInvocations = 1;
    state = apply(state, [
      {
        type: 'resource_budget.reserved',
        reservation: {
          version: 1,
          reservationId: 'occupied-tool',
          runId: state.resourceBudget.runId,
          invocationId: 'fixture:occupied-tool',
          resourceKind: 'tool',
          executableUpperBound: occupiedUsage,
          state: 'reserved',
        },
      },
      { type: 'resource_budget.dispatch_started', reservationId: 'occupied-tool' },
    ]);
    state.tools.calls['task-terminal'] = {
      toolCallId: 'task-terminal',
      modelMessageId: 'model-terminal',
      name: 'task',
      args: { subagent_type: 'explore', task: 'Read a file.' },
      status: 'approved',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task-terminal');
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'child-terminal-model',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      features: { resourceBudgetV1: true, boundedCancellationV1: true },
      sandbox: { enabled: false },
    };
    const executor = createRuntimeEffectExecutor({
      config,
      model: createMockModel([
        {
          message: aiMessage({
            content: 'read',
            tool_calls: [{ id: 'child-read', name: 'read_file', args: { path: 'missing.txt' } }],
          }),
        },
      ]),
      subagentEventSink: () => {},
    });
    const events: import('@/core/runtime/events').RuntimeEvent[] = [];
    for await (const event of runRuntimeLoop(kernel, executor, {
      requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
    })) {
      events.push(event);
    }

    const terminal = events.find((event) => event.type === 'run.error');
    expect(terminal).toMatchObject({
      type: 'run.error',
      failure: { kind: 'resource_saturated' },
    });
    expect(terminal?.type === 'run.error' ? terminal.outcome : undefined).toEqual(
      resolveResourceAdmissionFailureOutcomeV1('tool_concurrency_saturated', kernel.getState()),
    );
    expect(events.map((event) => event.type)).toContain('turn.aborted');
    expect(events.map((event) => event.type)).not.toContain('tool.failed');
    kernel.close();
  });

  test.each([
    ['budget_unconfigured', 'mandatory_admin_policy_unavailable', 'none'],
    ['budget_exhausted', 'budget_exhausted', 'known'],
    ['tool_concurrency_saturated', 'tool_permit_timeout', 'none'],
    ['shell_concurrency_saturated', 'shell_permit_timeout', 'none'],
  ] as const)('production admission adapter maps %s to the canonical %s outcome', (reason, mode, knownExternalEffects) => {
    const state =
      reason === 'budget_unconfigured'
        ? createInitialRuntimeState({ threadId: 'unconfigured', userId: 'u', workspace: '/' })
        : configuredState();
    if (reason === 'budget_exhausted' && state.resourceBudget.status === 'active') {
      state.resourceBudget = {
        ...state.resourceBudget,
        reconciledUsage: {
          ...state.resourceBudget.reconciledUsage,
          counters: {
            ...state.resourceBudget.reconciledUsage.counters,
            modelRequests: 1,
          },
        },
      };
    }
    expect(resolveResourceAdmissionFailureOutcomeV1(reason, state)).toEqual(
      resolveFailureModeV1(mode, { knownExternalEffects }).terminalOutcome!,
    );
  });

  test('production admission adapter maps persistence failure without inventing a conformance mode', () => {
    expect(
      resolveResourceAdmissionFailureOutcomeV1('persistence_unavailable', configuredState()),
    ).toEqual(
      failedTerminalOutcomeV1(
        classifyFailure(
          'persistence_unavailable',
          'Runtime resource admission could not be persisted.',
        ),
        { knownExternalEffects: 'none' },
      ),
    );
  });

  test('production admission adapter keeps reconciliation-required outcomes unknown', () => {
    const state = configuredState();
    const plan = planRuntimeBudgetAdmissionV1(
      state,
      { type: 'call_model' },
      new Date('2026-07-30T00:00:01Z'),
    );
    const dispatched = apply(state, [...plan.preparationEvents, ...plan.dispatchEvents]);
    const unknown = apply(
      dispatched,
      plan.reservationIds.map((reservationId) => ({
        type: 'resource_budget.unknown' as const,
        reservationId,
      })),
    );

    expect(resolveResourceAdmissionFailureOutcomeV1('reconciliation_required', unknown)).toEqual(
      failedTerminalOutcomeV1(
        classifyFailure('unknown', 'Runtime resource admission denied: reconciliation_required.'),
        { knownExternalEffects: 'unknown' },
      ),
    );
  });

  test('falls back to user approval when the final auto-review Provider gate denies dispatch', async () => {
    let state = configuredState();
    if (state.resourceBudget.status === 'active') {
      const now = Date.now();
      state.resourceBudget = {
        ...state.resourceBudget,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
      };
    }
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'reviewed-shell',
      name: 'shell_execute',
      args: { command: 'printf ok' },
    });
    state = reduceRuntimeState(state, {
      type: 'auto_review.requested',
      reviewId: 'review-denied',
      toolCallId: 'reviewed-shell',
      toolName: 'shell_execute',
      reason: 'Requires governed review.',
      approval: {
        scope: 'once',
        cwd: '/',
        threadId: state.session.threadId,
        tool: 'shell_execute',
        command: 'printf ok',
        risk: 'execute_code',
        approvalHash: 'review-denied-hash',
        summary: 'Run a fixture command.',
        reason: 'Requires governed review.',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    });
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: state,
      interactionMode: 'auto',
    });
    const model = createMockModel([]);
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'review-model',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      features: { providerDataPolicyV1: true, resourceBudgetV1: true },
      sandbox: { enabled: false },
    };
    const executor = createRuntimeEffectExecutor({
      config,
      model,
      providerDataAdmission: () => ({
        admitted: false,
        reason: 'mandatory_policy_unavailable',
        routeAlias: 'fixture:denied',
      }),
    });
    const emitted: RuntimeEvent[] = [];
    for await (const event of runRuntimeLoop(kernel, executor, {
      requestAction: async (effect) => {
        expect(effect.type).toBe('request_tool_approval');
        return { type: 'reject', interactionId: effect.interactionId };
      },
    })) {
      emitted.push(event);
    }

    expect(model.callCount.count).toBe(0);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({ ok: false, failureType: 'technical' }),
      }),
    );
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'approval.requested' }));
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'approval.rejected' }));
    expect(
      Object.values(
        kernel.getState().resourceBudget.status === 'active'
          ? kernel.getState().resourceBudget.reservations
          : {},
      ),
    ).toEqual([
      expect.objectContaining({
        resourceKind: 'verification',
        state: 'reconciled',
      }),
    ]);
    kernel.close();
  });

  test('escalates auto-review risk and technical failure, but not an approval', () => {
    expect(
      shouldEscalateAutoReviewResult({
        ok: true,
        suggestion: { approved: false, grant: 'approve_once', reason: 'risk' },
      }),
    ).toBe(true);
    expect(
      shouldEscalateAutoReviewResult({ ok: false, failureType: 'technical', reason: 'timeout' }),
    ).toBe(true);
    expect(
      shouldEscalateAutoReviewResult({
        ok: true,
        suggestion: { approved: true, grant: 'approve_once', reason: 'safe' },
      }),
    ).toBe(false);
  });

  test('keeps a verification reservation unknown when Provider denial follows an executed check', async () => {
    let state = configuredState();
    if (state.resourceBudget.status === 'active') {
      const now = Date.now();
      state.resourceBudget = {
        ...state.resourceBudget,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
      };
    }
    state.transcript.final = 'Ready for verification.';
    state = reduceRuntimeState(state, {
      type: 'verification.requested',
      verificationId: 'partial-verification',
      mode: 'required',
      spec: {
        schemaVersion: 1,
        verificationId: 'partial-verification',
        subject: 'Partially executed verification',
        checks: [
          {
            checkId: 'command-first',
            type: 'command',
            description: 'Execute a local verification command.',
            command: 'printf ok',
          },
          {
            checkId: 'reviewer-last',
            type: 'reviewer',
            description: 'Review the collected evidence.',
            instructions: 'Confirm the evidence.',
          },
        ],
        repair: { maxAttempts: 0 },
      },
      requestedAt: new Date().toISOString(),
    });
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'auto',
    });
    let shellCalls = 0;
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'review-model',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      features: { providerDataPolicyV1: true, resourceBudgetV1: true },
      sandbox: { enabled: false },
    };
    const executor = createRuntimeEffectExecutor({
      config,
      model: createMockModel([]),
      shellExecutor: async ({ command }) => {
        shellCalls += 1;
        return {
          ok: true,
          command,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        };
      },
      providerDataAdmission: (_payload, purpose) => ({
        admitted: purpose !== 'verification_review',
        reason: purpose === 'verification_review' ? 'provider_policy_missing' : 'admitted',
        routeAlias: 'fixture:review',
      }),
    });
    let thrown: unknown;
    try {
      for await (const _event of runRuntimeLoop(kernel, executor, {
        requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
      })) {
        // Drain until the reviewer admission denial terminates execution.
      }
    } catch (error) {
      thrown = error;
    }

    expect(shellCalls).toBe(1);
    expect(thrown).toBeInstanceOf(ProviderDataAdmissionError);
    expect(thrown).toMatchObject({ knownExternalEffects: 'unknown' });
    expect(
      Object.values(
        kernel.getState().resourceBudget.status === 'active'
          ? kernel.getState().resourceBudget.reservations
          : {},
      ),
    ).toEqual([
      expect.objectContaining({
        resourceKind: 'verification',
        state: 'unknown',
      }),
    ]);
    kernel.close();
  });
});
