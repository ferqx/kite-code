import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { decideAutoReview } from '@kite-ai/agent-kernel';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';

import { aiMessage } from '@kite-ai/builtin-runtime/model';
import {
  createDescendantResourceAdmission,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  DescendantResourceAdmissionError,
  LIMITED_RESOURCE_BUDGET_,
  planModelInvocationResource,
  planRuntimeBudgetAdmission,
  type RuntimeState,
  reconciliationEventsForReservations,
  runtimeHostStateResolveFailureMode as resolveFailureMode,
} from '@kite-ai/runtime-host/kernel-adapter';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import {
  resolveResourceAdmissionFailureOutcome,
  runStateRuntimeLoop,
} from '#app/bootstrap/runtime/state-runner';
import { failedTerminalOutcome } from '#app/bootstrap/runtime/terminal-outcome';
import type { AgentConfig } from '#app/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { prepareRuntimeEffectForBudget } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-dependencies';
import { StateHostSessionHarness as AgentKernel } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';
import {
  createTestRuntimeEffectExecutor,
  projectTestPrimaryModelEffect,
  testBuiltinToolCatalog,
  testSubagentTaskRequests,
  testWorkspaceFilesystemRuntime,
} from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

function configuredState(overrides: Partial<typeof LIMITED_RESOURCE_BUDGET_> = {}): RuntimeState {
  return reduceRuntimeState(
    createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget',
      userId: 'u',
      workspace: '/',
    }),
    {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: { ...LIMITED_RESOURCE_BUDGET_, ...overrides, version: 1 },
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
    const plan = planModelInvocationResource(state, {
      invocationId: 'model-budget-1',
      inputTokens: 10,
      requestedMaxOutputTokens: 20,
      resourceKind: 'model',
      now: new Date('2026-07-30T00:00:01Z'),
    });
    expect(plan.preparationEvents.map((event) => event.type)).toEqual(['resource_budget.reserved']);
    if (plan.budget.kind !== 'reservation') throw new Error('Expected a model reservation.');
    const dispatched = apply(state, [
      ...plan.preparationEvents,
      { type: 'resource_budget.dispatch_started', reservationId: plan.budget.reservationId },
    ]);
    const terminal = reconciliationEventsForReservations(dispatched, [plan.budget.reservationId]);
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
      const response = (await originalGenerate(options)) as {
        usage: {
          inputTokens: { total: number; noCache: number };
          outputTokens: { total: number };
          totalTokens: number;
        };
      };
      return {
        ...response,
        usage: {
          ...response.usage,
          outputTokens: { total: 7 },
          totalTokens: response.usage.inputTokens.total + 7,
        },
      };
    };

    const prepared = prepareRuntimeEffectForBudget({ type: 'call_model' }, state, {
      config,
      model,
      builtinToolCatalog: testBuiltinToolCatalog(),
    });
    if (prepared.type !== 'call_model' || !prepared.resourceEstimate) {
      throw new Error('Expected a prepared model effect.');
    }
    if (!Number.isFinite(prepared.resourceEstimate.inputTokens)) {
      throw new Error(`Non-finite input estimate: ${prepared.resourceEstimate.inputTokens}`);
    }
    expect(prepared.resourceEstimate.inputTokens).toBeGreaterThan(0);
    expect(prepared.resourceEstimate.maxOutputTokens).toBe(7);
    const admission = planModelInvocationResource(state, {
      invocationId: 'exact-model-projection',
      inputTokens: prepared.resourceEstimate.inputTokens,
      requestedMaxOutputTokens: prepared.resourceEstimate.maxOutputTokens,
      resourceKind: 'model',
      now: new Date('2026-07-30T00:00:01Z'),
    });
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

    if (state.resourceBudget.status === 'active') {
      const now = Date.now();
      state.resourceBudget = {
        ...state.resourceBudget,
        startedAt: new Date(now - 1_000).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
      };
    }

    await projectTestPrimaryModelEffect({
      model,
      state,
      config,
      resourceAdmission: prepared.resourceEstimate,
    });
    expect(providerMaxOutputTokens).toBe(7);
  });

  test('denies cumulative exhaustion before producing dispatch_started', () => {
    const state = configuredState({ maxModelRequests: 1 });
    const first = planModelInvocationResource(state, {
      invocationId: 'first-model',
      inputTokens: 1,
      requestedMaxOutputTokens: 1,
      resourceKind: 'model',
      now: new Date('2026-07-30T00:00:01Z'),
    });
    if (first.budget.kind !== 'reservation') throw new Error('Expected a model reservation.');
    const dispatched = apply(state, [
      ...first.preparationEvents,
      { type: 'resource_budget.dispatch_started', reservationId: first.budget.reservationId },
    ]);
    const consumed = apply(
      dispatched,
      reconciliationEventsForReservations(dispatched, [first.budget.reservationId]),
    );
    consumed.transcript.messages = [
      ...consumed.transcript.messages,
      {
        kind: 'assistant',
        messageId: 'response-1',
        turnId: consumed.turn.turnId,
        ordinal: 0,
        createdAt: '2026-07-30T00:00:02Z',
        content: 'continue',
        toolCalls: [],
      },
    ];
    expect(() =>
      planModelInvocationResource(consumed, {
        invocationId: 'second-model',
        inputTokens: 1,
        requestedMaxOutputTokens: 1,
        resourceKind: 'model',
        now: new Date('2026-07-30T00:00:03Z'),
      }),
    ).toThrow('Resource budget exhausted before dispatch.');
  });

  test('preserves unknown external outcome instead of misclassifying it as budget exhaustion', () => {
    const state = configuredState();
    const first = planModelInvocationResource(state, {
      invocationId: 'unknown-model',
      inputTokens: 1,
      requestedMaxOutputTokens: 1,
      resourceKind: 'model',
      now: new Date('2026-07-30T00:00:01Z'),
    });
    if (first.budget.kind !== 'reservation') throw new Error('Expected a model reservation.');
    const dispatched = apply(state, [
      ...first.preparationEvents,
      { type: 'resource_budget.dispatch_started', reservationId: first.budget.reservationId },
    ]);
    const unknown = apply(dispatched, [
      { type: 'resource_budget.unknown', reservationId: first.budget.reservationId },
    ]);

    expect(() =>
      planModelInvocationResource(unknown, {
        invocationId: 'replacement-model',
        inputTokens: 1,
        requestedMaxOutputTokens: 1,
        resourceKind: 'model',
        now: new Date('2026-07-30T00:00:02Z'),
      }),
    ).toThrow('reconciliation_required');
  });

  test('releases dispatch-started usage only with local Provider denial proof', () => {
    const state = configuredState();
    const plan = planModelInvocationResource(state, {
      invocationId: 'denied-model',
      inputTokens: 1,
      requestedMaxOutputTokens: 1,
      resourceKind: 'model',
      now: new Date('2026-07-30T00:00:01Z'),
    });
    if (plan.budget.kind !== 'reservation') throw new Error('Expected a model reservation.');
    const reservationId = plan.budget.reservationId;
    const dispatched = apply(state, [
      ...plan.preparationEvents,
      { type: 'resource_budget.dispatch_started', reservationId },
    ]);

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
        proof: 'local_pre_dispatch_failure',
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
    state.tools.queue = [...state.tools.queue, 'task-1'];
    const parentPlan = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['task-1'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const persisted: string[] = [];
    const admission = createDescendantResourceAdmission({
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

  test('rejects descendant dispatch after the shared run deadline has elapsed', async () => {
    let state = configuredState();
    state.tools.calls['task-deadline'] = {
      toolCallId: 'task-deadline',
      modelMessageId: 'model-deadline',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      status: 'approved',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task-deadline'];
    const parentPlan = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['task-deadline'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    let persisted = 0;
    const admission = createDescendantResourceAdmission({
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

    await expect(
      admission.reserveModel({ invocationKey: 'model:late', inputTokens: 1 }),
    ).rejects.toMatchObject({ reason: 'budget_exhausted' });
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
    state.tools.queue = [...state.tools.queue, 'task-fifo'];
    const parentPlan = planRuntimeBudgetAdmission(state, {
      type: 'run_tools',
      toolCallIds: ['task-fifo'],
    });
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const batches: string[][] = [];
    const persistEvents = async (events: import('@kite-ai/agent-kernel').RuntimeEvent[]) => {
      kernel.processEventBatch(events);
      batches.push(events.map((event) => event.type));
      return true;
    };
    const admission = () =>
      createDescendantResourceAdmission({
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
    state.tools.queue = [...state.tools.queue, 'task-cancel'];
    const parentPlan = planRuntimeBudgetAdmission(state, {
      type: 'run_tools',
      toolCallIds: ['task-cancel'],
    });
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const persistEvents = async (events: import('@kite-ai/agent-kernel').RuntimeEvent[]) => {
      kernel.processEventBatch(events);
      return true;
    };
    const admission = createDescendantResourceAdmission({
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

  test('times out a descendant compound permit at the earlier shared run deadline', async () => {
    let state = configuredState({
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 5_000,
    });
    if (state.resourceBudget.status === 'active') {
      state.resourceBudget = {
        ...state.resourceBudget,
        deadlineAt: new Date(Date.now() + 200).toISOString(),
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
    state.tools.queue = [...state.tools.queue, 'task-timeout'];
    const parentPlan = planRuntimeBudgetAdmission(state, {
      type: 'run_tools',
      toolCallIds: ['task-timeout'],
    });
    state = apply(state, [...parentPlan.preparationEvents, ...parentPlan.dispatchEvents]);
    const persisted: string[] = [];
    const admission = createDescendantResourceAdmission({
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
    state.tools.queue = [...state.tools.queue, 'task-late'];
    const parentPlan = planRuntimeBudgetAdmission(
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
    const admission = createDescendantResourceAdmission({
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
    const plan = planModelInvocationResource(state, {
      invocationId: 'late-model',
      inputTokens: 1,
      requestedMaxOutputTokens: 1,
      resourceKind: 'model',
      now: new Date('2026-07-30T00:00:01Z'),
    });
    if (plan.budget.kind !== 'reservation') throw new Error('Expected a model reservation.');
    const dispatched = apply(state, [
      ...plan.preparationEvents,
      {
        type: 'resource_budget.dispatch_started',
        reservationId: plan.budget.reservationId,
      },
    ]);
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
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
          reservationId: plan.budget.reservationId,
          actual: createZeroResourceUsage(),
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
    state.tools.queue = [...state.tools.queue, 'task-1'];
    const first = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['task-1'] },
      new Date('2026-07-30T00:00:01Z'),
    );
    state = apply(state, [...first.preparationEvents, ...first.dispatchEvents]);
    state = apply(state, reconciliationEventsForReservations(state, first.reservationIds));
    state.suspendedSubagents['task-1'] = {
      storage: 'private_artifact_v1',
      subagentId: 'subagent-1',
      role: 'code',
      continuationId: `continuation-${'a'.repeat(64)}`,
      modelInvocationOrdinal: 0,
      continuationArtifact: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'subagent_continuation',
        integrityIdentifier: `sha256:${'c'.repeat(64)}`,
        byteLength: 1,
      },
      parentInvocationId: 'parent-task-1',
      parentAttempt: 1,
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'nested-shell',
        toolName: 'shell_execute',
      },
    };

    const resumed = planRuntimeBudgetAdmission(
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

  test('does not reserve another Sub-agent invocation when presenting a deferred approval', () => {
    const state = configuredState();
    state.tools.calls['task-1'] = {
      toolCallId: 'task-1',
      modelMessageId: 'model-1',
      name: 'task',
      args: { subagent_type: 'code', task: 'continue' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task-1'];
    state.suspendedSubagents['task-1'] = {
      storage: 'private_artifact_v1',
      subagentId: 'subagent-1',
      role: 'code',
      continuationId: `continuation-${'a'.repeat(64)}`,
      modelInvocationOrdinal: 0,
      continuationArtifact: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'subagent_continuation',
        integrityIdentifier: `sha256:${'c'.repeat(64)}`,
        byteLength: 1,
      },
      parentInvocationId: 'parent-task-1',
      parentAttempt: 1,
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'nested-shell',
        toolName: 'shell_execute',
      },
    };

    const presentation = planRuntimeBudgetAdmission(
      state,
      { type: 'run_tools', toolCallIds: ['task-1'] },
      new Date('2026-07-30T00:00:01Z'),
    );

    expect(presentation).toMatchObject({
      status: 'not_required',
      preparationEvents: [],
      dispatchEvents: [],
      reservationIds: [],
    });
  });

  test('runner delegates model reservations to the Gateway without creating a second authority', async () => {
    const store = openStateStoreForTest(':memory:');
    const startedAt = new Date();
    const liveState = reduceRuntimeState(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'budget-live',
        userId: 'u',
        workspace: '/',
      }),
      {
        type: 'resource_budget.configured',
        runId: 'run-live',
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(
          startedAt.getTime() + LIMITED_RESOURCE_BUDGET_.maxRunDurationMs,
        ).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_,
      },
    );
    const kernel = new AgentKernel({
      store,
      initialState: liveState,
      interactionMode: 'accept_edits',
    });
    let sawDispatchBeforeSideEffect = false;
    const eventTypes: string[] = [];
    for await (const event of runStateRuntimeLoop(
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
    expect(sawDispatchBeforeSideEffect).toBe(false);
    expect(eventTypes[0]).toBe('model.responded');
    expect(eventTypes.some((type) => type.startsWith('resource_budget.'))).toBe(false);
    expect(kernel.getState().resourceBudget).toMatchObject({
      status: 'active',
      reconciledUsage: {
        counters: { modelRequests: 0, inputTokens: 0, outputTokens: 0 },
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
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const events: import('@kite-ai/agent-kernel').RuntimeEvent[] = [];
    const model = createMockModel([{ message: aiMessage({ content: 'must not dispatch' }) }]);
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'budget-model',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
    };
    const executor = createTestRuntimeEffectExecutor({ config, model });

    for await (const event of runStateRuntimeLoop(kernel, executor, {
      requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
    })) {
      events.push(event);
    }

    expect(model.callCount.count).toBe(0);
    const terminal = events.find((event) => event.type === 'run.error');
    expect(terminal).toMatchObject({
      type: 'run.error',
      failure: { kind: 'budget_exceeded' },
    });
    expect(terminal?.type === 'run.error' ? terminal.outcome : undefined).toEqual(
      resolveFailureMode('budget_exhausted', {
        knownExternalEffects: 'known',
      }).terminalOutcome!,
    );
    kernel.close();
  });

  test('binds an active-budget child Tool Pipeline admission to its exact durable reservation', async () => {
    const state = configuredState();
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    state.resourceBudget = {
      ...state.resourceBudget,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    };
    state.session.workspace = '/tmp';
    const subagentTaskRequests = testSubagentTaskRequests();
    state.tools.calls['task-child-read'] = {
      toolCallId: 'task-child-read',
      modelMessageId: 'model-child-read',
      modelInvocationId: 'parent-model-child-read',
      name: 'task',
      args: {
        name: 'Read missing fixture',
        subagent_type: 'explore',
        taskArtifact: subagentTaskRequests.write({
          parentModelInvocationId: 'parent-model-child-read',
          parentToolCallId: 'task-child-read',
          name: 'Read missing fixture',
          role: 'explore',
          task: 'Read the missing fixture once, then stop.',
        }),
      },
      status: 'queued',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task-child-read'];
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const executor = createTestRuntimeEffectExecutor({
      config: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'child-budget-model',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        features: { resourceBudget: true, boundedCancellation: true },
        sandbox: { enabled: false },
      },
      model: createMockModel([
        {
          message: aiMessage({
            content: 'read',
            tool_calls: [
              {
                id: 'child-read-attempt',
                name: 'read_file',
                args: { path: 'missing-child-budget-fixture.txt' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'Stopped after the governed read result.' }) },
        { message: aiMessage({ content: 'Parent turn complete.' }) },
      ]),
      subagentTaskRequests,
      workspaceFilesystemRuntime: testWorkspaceFilesystemRuntime('/tmp'),
      subagentEventSink: () => {},
    });
    const events: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(kernel, executor, {
      requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
    })) {
      events.push(event);
    }

    const budget = kernel.getState().resourceBudget;
    if (budget.status !== 'active') throw new Error('Expected active budget.');
    const childReservation = Object.values(budget.reservations).find(
      (reservation) =>
        reservation.resourceKind === 'tool' &&
        reservation.invocationId.includes('child-read-attempt:attempt:1'),
    );
    const parentReservation = childReservation?.parentReservationId
      ? budget.reservations[childReservation.parentReservationId]
      : undefined;
    expect(childReservation).toMatchObject({
      state: 'reconciled',
      parentReservationId: expect.any(String),
      actual: { counters: { toolInvocations: 1 } },
    });
    expect(parentReservation).toMatchObject({ resourceKind: 'subagent', state: 'reconciled' });
    const childInvocation = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'capability.invocation_recorded' }> =>
        event.type === 'capability.invocation_recorded' &&
        event.toolCallId.startsWith('subagent-tool:'),
    );
    expect(childInvocation?.admissionDigest).toBe(
      digestCapabilityValue({
        authorizationDigest: childInvocation?.authorizationDigest,
        reservationIds: [childReservation!.reservationId],
        freshness: 'current',
      }),
    );
    expect(events.some((event) => event.type === 'run.error')).toBe(false);
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
    const occupiedUsage = createZeroResourceUsage(
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
    const subagentTaskRequests = testSubagentTaskRequests();
    state.tools.calls['task-terminal'] = {
      toolCallId: 'task-terminal',
      modelMessageId: 'model-terminal',
      modelInvocationId: 'parent-model-terminal',
      name: 'task',
      args: {
        name: 'Read one file',
        subagent_type: 'explore',
        taskArtifact: subagentTaskRequests.write({
          parentModelInvocationId: 'parent-model-terminal',
          parentToolCallId: 'task-terminal',
          name: 'Read one file',
          role: 'explore',
          task: 'Read a file.',
        }),
      },
      status: 'queued',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task-terminal'];
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'child-terminal-model',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      features: { resourceBudget: true, boundedCancellation: true },
      sandbox: { enabled: false },
    };
    const executor = createTestRuntimeEffectExecutor({
      config,
      model: createMockModel([
        {
          message: aiMessage({
            content: 'read',
            tool_calls: [{ id: 'child-read', name: 'read_file', args: { path: 'missing.txt' } }],
          }),
        },
      ]),
      subagentTaskRequests,
      workspaceFilesystemRuntime: testWorkspaceFilesystemRuntime(state.session.workspace),
      subagentEventSink: () => {},
    });
    const events: import('@kite-ai/agent-kernel').RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(kernel, executor, {
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
      resolveResourceAdmissionFailureOutcome('tool_concurrency_saturated', kernel.getState()),
    );
    expect(events.map((event) => event.type)).toContain('turn.aborted');
    expect(
      events.some(
        (event) =>
          event.type === 'capability.invocation_recorded' &&
          event.toolCallId.startsWith('subagent-tool:'),
      ),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'capability.execution_failed',
        artifact: expect.objectContaining({ kind: 'capability_result' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'task-terminal',
        failure: expect.objectContaining({ kind: 'resource_saturated' }),
      }),
    );
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
        ? createRuntimeHostStateInitialState({
            recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
            threadId: 'unconfigured',
            userId: 'u',
            workspace: '/',
          })
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
    expect(resolveResourceAdmissionFailureOutcome(reason, state)).toEqual(
      resolveFailureMode(mode, { knownExternalEffects }).terminalOutcome!,
    );
  });

  test('production admission adapter maps persistence failure without inventing a conformance mode', () => {
    expect(
      resolveResourceAdmissionFailureOutcome('persistence_unavailable', configuredState()),
    ).toEqual(
      failedTerminalOutcome(
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
    const plan = planRuntimeBudgetAdmission(
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

    expect(resolveResourceAdmissionFailureOutcome('reconciliation_required', unknown)).toEqual(
      failedTerminalOutcome(
        classifyFailure('unknown', 'Runtime resource admission denied: reconciliation_required.'),
        { knownExternalEffects: 'unknown' },
      ),
    );
  });

  test('uses the Kernel auto-review decision for risk, technical failure, and approval', () => {
    expect(
      decideAutoReview({
        reviewId: 'review-risk',
        toolCallId: 'tool-risk',
        ok: true,
        approved: false,
        requiresUserApproval: true,
        grant: 'approve_once',
        reason: 'risk',
      }),
    ).toMatchObject({ kind: 'request_user_approval', reason: 'risk' });
    expect(
      decideAutoReview({
        reviewId: 'review-timeout',
        toolCallId: 'tool-timeout',
        ok: false,
        approved: false,
        failureType: 'technical',
        reason: 'timeout',
      }),
    ).toMatchObject({ kind: 'request_user_approval', failureType: 'technical' });
    expect(
      decideAutoReview({
        reviewId: 'review-safe',
        toolCallId: 'tool-safe',
        ok: true,
        approved: true,
        grant: 'approve_once',
        reason: 'safe',
      }),
    ).toMatchObject({ kind: 'accepted_approval', grant: 'approve_once' });
  });
});
