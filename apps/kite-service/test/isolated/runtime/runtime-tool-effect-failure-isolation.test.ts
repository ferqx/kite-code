import { describe, expect, test } from 'bun:test';
import type { AgentPendingApproval } from '@kite-ai/agent-kernel';
import {
  committedResourceUsage,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
  planRuntimeBudgetAdmission,
  reconciliationEventsForReservations,
} from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { StateHostSessionHarness as AgentKernel } from '../../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../../scripts/support/runtime-storage';
import { executeAppRuntimeToolsEffect } from '../../../src/bootstrap/runtime/runtime-tool-effect';
import { runStateRuntimeLoop } from '../../../src/bootstrap/runtime/state-runner';
import { AppStateToolPipelinePersistenceError } from '../../../src/runtime/tool-persistence';

type EffectInput = Parameters<typeof executeAppRuntimeToolsEffect>;

function fixture(toolName = 'shell_execute', toolCallIds = ['call'], admitted = true) {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'tool-isolation',
    userId: 'user',
    workspace: process.cwd(),
  });
  for (const toolCallId of toolCallIds) {
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'message',
      name: toolName,
      args: { command: 'pwd' },
      status: 'queued',
      sideEffect: toolCallIds.length === 1,
      createdAtTurnId: state.turn.turnId,
    };
  }
  state.tools.queue = [...state.tools.queue, ...toolCallIds];
  const now = Date.now();
  state = reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: 'run-tool-isolation',
    startedAt: new Date(now - 1000).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
    budget: { ...LIMITED_RESOURCE_BUDGET_, version: 1 },
  });
  const admission = planRuntimeBudgetAdmission(state, { type: 'run_tools', toolCallIds });
  if (admission.status !== 'admitted') throw new Error('Expected Tool admission.');
  if (admitted)
    state = [...admission.preparationEvents, ...admission.dispatchEvents].reduce(
      reduceRuntimeState,
      state,
    );
  const dependencies = {
    commandContext: { bindingReference: 'binding' },
    workspaceEffectCompositionFactory: () => {
      throw new Error('preparation failed');
    },
  } as unknown as EffectInput[2];
  const context = {
    reservationIds: admission.reservationIds,
    getState: () => state,
    persistEvent: async () => true,
    persistEvents: async () => true,
  } as EffectInput[4];
  const run = () =>
    executeAppRuntimeToolsEffect(
      { type: 'run_tools', toolCallIds },
      state,
      dependencies,
      undefined,
      context,
      () => {},
    );
  return { state, run, reservationIds: admission.reservationIds, dependencies };
}

describe('Tool effect preparation failure isolation', () => {
  test('reports a confirmed undispatched ordinary tool failure locally', async () => {
    const { run, state, reservationIds } = fixture();
    const events = await run();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'resource_budget.released',
        reservationId: reservationIds[0],
        proof: 'local_pre_dispatch_failure',
      }),
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'call',
        failure: expect.objectContaining({ kind: 'tool_runtime_error' }),
      }),
    ]);
    expect(reconciliationEventsForReservations(state, [...reservationIds], events)).toEqual([]);
  });

  test('continues the same Run after a local Tool failure without charging its reservation', async () => {
    const { state, dependencies } = fixture('shell_execute', ['call'], false);
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const events: import('@kite-ai/agent-kernel').RuntimeEvent[] = [];
    try {
      for await (const event of runStateRuntimeLoop(
        kernel,
        (effect, currentState, emit, context) =>
          effect.type === 'run_tools'
            ? executeAppRuntimeToolsEffect(
                effect,
                currentState,
                dependencies,
                emit,
                context,
                () => {},
              )
            : effect.type === 'call_model'
              ? Promise.resolve([
                  {
                    type: 'model.responded' as const,
                    messageId: 'after-failure',
                    text: 'continued',
                  },
                ])
              : Promise.resolve([]),
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      ))
        events.push(event);
      expect(
        events.some((event) => event.type === 'tool.failed' && event.toolCallId === 'call'),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === 'model.responded' && event.messageId === 'after-failure',
        ),
      ).toBe(true);
      expect(
        events.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      const budget = kernel.getState().resourceBudget;
      if (budget.status !== 'active') throw new Error('Budget closed unexpectedly.');
      expect(committedResourceUsage(budget).counters.artifactBytes).toBe(0);
      expect(committedResourceUsage(budget).counters.toolInvocations).toBe(0);
    } finally {
      kernel.close();
    }
  });

  test('preserves the hard boundary after a tool attempt has started', async () => {
    const { state, run } = fixture();
    state.tools.calls.call = { ...state.tools.calls.call!, status: 'running' };
    await expect(run()).rejects.toThrow('preparation failed');
  });

  test('uses the current approval reservation despite an older reconciled reservation', async () => {
    const { state, run, reservationIds } = fixture();
    (state.pendingApprovals as Map<string, AgentPendingApproval>).set('approval', {
      interactionId: 'approval',
      toolCallId: 'call',
      route: 'user',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      bindingDigest: 'a'.repeat(64),
      approval: {
        scope: 'once',
        cwd: state.session.workspace,
        threadId: state.session.threadId,
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'read',
        approvalHash: 'a'.repeat(64),
        summary: 'Read workspace',
        reason: 'Fixture approval',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
      invocation: {},
      sequence: 1,
      generation: 1,
      createdAt: new Date().toISOString(),
      status: 'authorized_queued',
      dispatchState: 'before_dispatch',
      receiptId: 'receipt',
    });
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    const current = state.resourceBudget.reservations[reservationIds[0]!];
    if (!current) throw new Error('Expected current reservation.');
    state.resourceBudget = {
      ...state.resourceBudget,
      reservations: {
        ...state.resourceBudget.reservations,
        [current.reservationId]: { ...current, invocationId: 'tool:call:approval:receipt' },
        older: {
          ...current,
          reservationId: 'older',
          invocationId: 'tool:call',
          state: 'reconciled',
          actual: createZeroResourceUsage('actual'),
        },
      },
    };
    expect(await run()).toContainEqual({
      type: 'resource_budget.released',
      reservationId: current.reservationId,
      proof: 'local_pre_dispatch_failure',
    });
  });

  test('never releases a sibling reservation whose ID contains the current call prefix', async () => {
    const { state, run, reservationIds } = fixture();
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    const current = state.resourceBudget.reservations[reservationIds[0]!]!;
    state.tools.calls['call:other'] = { ...state.tools.calls.call!, toolCallId: 'call:other' };
    state.resourceBudget = {
      ...state.resourceBudget,
      reservations: {
        [current.reservationId]: { ...current, invocationId: 'tool:call:other' },
      },
    };
    await expect(run()).rejects.toThrow('preparation failed');
  });

  test('isolates a router error before any acknowledged Tool attempt', async () => {
    const { state, reservationIds } = fixture();
    const catalog = {};
    const dependencies = {
      config: Object.defineProperty({}, 'features', {
        get() {
          throw new Error('router preparation failed');
        },
      }),
      builtinToolCatalog: catalog,
      toolPipelineComposition: { baseProjection: catalog },
      modelEffectCoordinator: {},
    } as unknown as EffectInput[2];
    const context = {
      reservationIds,
      getState: () => state,
      persistEvent: async () => true,
      persistEvents: async () => true,
    } as EffectInput[4];
    expect(
      await executeAppRuntimeToolsEffect(
        { type: 'run_tools', toolCallIds: ['call'] },
        state,
        dependencies,
        undefined,
        context,
        () => {},
      ),
    ).toEqual([
      expect.objectContaining({ type: 'resource_budget.released' }),
      expect.objectContaining({ type: 'tool.failed', toolCallId: 'call' }),
    ]);
  });

  test('isolates parallel ordinary siblings before their attempts', async () => {
    const { state, reservationIds } = fixture('shell_execute', ['call', 'other']);
    const catalog = {};
    const dependencies = {
      config: Object.defineProperty({}, 'features', {
        get() {
          throw new Error('router preparation failed');
        },
      }),
      builtinToolCatalog: catalog,
      toolPipelineComposition: { baseProjection: catalog },
      modelEffectCoordinator: {},
    } as unknown as EffectInput[2];
    const context = {
      reservationIds,
      getState: () => state,
      persistEvent: async () => true,
      persistEvents: async () => true,
    } as EffectInput[4];
    const events = await executeAppRuntimeToolsEffect(
      { type: 'run_tools', toolCallIds: ['call', 'other'] },
      state,
      dependencies,
      undefined,
      context,
      () => {},
    );
    expect(
      events.filter((event) => event.type === 'tool.failed').map((event) => event.toolCallId),
    ).toEqual(['call', 'other']);
    expect(events.filter((event) => event.type === 'resource_budget.released')).toHaveLength(2);
  });

  test('keeps a persistence failure at the hard recovery boundary', async () => {
    const { state, reservationIds } = fixture();
    const dependencies = {
      commandContext: { bindingReference: 'binding' },
      workspaceEffectCompositionFactory: () => {
        throw new AppStateToolPipelinePersistenceError('persistence_unavailable');
      },
    } as unknown as EffectInput[2];
    const context = {
      reservationIds,
      getState: () => state,
      persistEvent: async () => true,
      persistEvents: async () => true,
    } as EffectInput[4];
    await expect(
      executeAppRuntimeToolsEffect(
        { type: 'run_tools', toolCallIds: ['call'] },
        state,
        dependencies,
        undefined,
        context,
        () => {},
      ),
    ).rejects.toBeInstanceOf(AppStateToolPipelinePersistenceError);
  });

  test('does not infer no dispatch when durable State is unavailable', async () => {
    const { state } = fixture();
    const dependencies = {
      commandContext: { bindingReference: 'binding' },
      workspaceEffectCompositionFactory: () => {
        throw new Error('preparation failed');
      },
    } as unknown as EffectInput[2];
    await expect(
      executeAppRuntimeToolsEffect(
        { type: 'run_tools', toolCallIds: ['call'] },
        state,
        dependencies,
        undefined,
        undefined,
        () => {},
      ),
    ).rejects.toThrow('preparation failed');
  });

  test('does not treat a Task or MCP preparation error as an ordinary local failure', async () => {
    for (const name of ['task', 'mcp__server__tool']) {
      const { run } = fixture(name);
      await expect(run()).rejects.toThrow('preparation failed');
    }
  });
});
