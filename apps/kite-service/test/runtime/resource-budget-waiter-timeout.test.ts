import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  LIMITED_RESOURCE_BUDGET_,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { runStateRuntimeLoop } from '#kite-service/bootstrap/runtime/state-runner';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { StateHostSessionHarness as AgentKernel } from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';

function waitingArtifactState(ids: readonly string[]): RuntimeState {
  const now = Date.now();
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: `artifact-timeout-${ids.join('-')}`,
    userId: 'user',
    workspace: '/tmp',
  });
  state = reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: state.turn.turnId,
    startedAt: new Date(now - 5_000).toISOString(),
    deadlineAt: new Date(now + 30_000).toISOString(),
    budget: { ...LIMITED_RESOURCE_BUDGET_, maxConcurrentWriters: 1 },
  });
  ids.forEach((toolCallId, index) => {
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'writer-model',
      name: 'shell_execute',
      args: { command: `printf ${index}` },
      status: 'approved',
      sideEffect: true,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, toolCallId];
    state = reduceRuntimeState(state, {
      type: 'resource_budget.waiter_enqueued',
      waiter: {
        version: 1,
        runId: state.turn.turnId,
        invocationId: `tool:${toolCallId}`,
        requiredPermits: ['artifact_capacity'],
        sequence: index,
        enqueuedAt: new Date(now - 2_000).toISOString(),
        deadlineAt: new Date(now + (index === 0 ? -1_000 : 20_000)).toISOString(),
        state: 'waiting',
      },
    });
  });
  return state;
}

async function untilToolFailure(
  kernel: AgentKernel,
  toolCallId: string,
  continueUntilModel = false,
) {
  const dispatched: string[] = [];
  const events: RuntimeEvent[] = [];
  const stream = runStateRuntimeLoop(
    kernel,
    async (effect) => {
      dispatched.push(effect.type);
      if (effect.type === 'call_model') {
        return [
          {
            type: 'model.responded',
            messageId: 'writer-timeout-followup',
            text: 'I can continue after the Tool failure.',
            inputTokens: 1,
            outputTokens: 1,
          },
        ];
      }
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  );
  try {
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'tool.failed' && event.toolCallId === toolCallId && !continueUntilModel)
        break;
      if (event.type === 'model.responded') break;
      if (event.type === 'run.error' || event.type === 'turn.aborted') break;
    }
  } finally {
    await stream.return(undefined);
  }
  return { events, dispatched };
}

describe('artifact capacity waiter timeout remains a Tool outcome', () => {
  test('fails an unfunded Tool locally while the Agent can still use its model budget', async () => {
    const now = Date.now();
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: 'c'.repeat(64),
      threadId: 'tool-budget-denied',
      userId: 'user',
      workspace: '/tmp',
    });
    state = reduceRuntimeState(state, {
      type: 'resource_budget.configured',
      runId: state.turn.turnId,
      startedAt: new Date(now - 1_000).toISOString(),
      deadlineAt: new Date(now + 30_000).toISOString(),
      budget: { ...LIMITED_RESOURCE_BUDGET_, maxToolInvocations: 1 },
    });
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    state.resourceBudget = {
      ...state.resourceBudget,
      reconciledUsage: {
        ...state.resourceBudget.reconciledUsage,
        counters: { ...state.resourceBudget.reconciledUsage.counters, toolInvocations: 1 },
      },
    };
    state.tools.calls['writer-budget'] = {
      toolCallId: 'writer-budget',
      modelMessageId: 'writer-budget-model',
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'approved',
      sideEffect: true,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'writer-budget'];
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    try {
      const { events, dispatched } = await untilToolFailure(kernel, 'writer-budget', true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: 'writer-budget',
          failure: expect.objectContaining({ kind: 'budget_exceeded' }),
        }),
      );
      expect(
        events.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      expect(dispatched).not.toContain('run_tools');
      expect(dispatched).toContain('call_model');
      expect(events.some((event) => event.type === 'model.responded')).toBe(true);
    } finally {
      kernel.close();
    }
  });

  test('fails the undispatched Tool locally without aborting its Run', async () => {
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: waitingArtifactState(['writer-one']),
      interactionMode: 'accept_edits',
    });
    try {
      const { events, dispatched } = await untilToolFailure(kernel, 'writer-one', true);
      expect(events).toContainEqual({
        type: 'resource_budget.waiter_timed_out',
        invocationId: 'tool:writer-one',
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: 'writer-one',
          failure: expect.objectContaining({ kind: 'budget_exceeded' }),
        }),
      );
      expect(
        events.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === 'tool.started' || event.type === 'resource_budget.dispatch_started',
        ),
      ).toBe(false);
      expect(dispatched).not.toContain('run_tools');
      expect(dispatched).toContain('call_model');
      expect(events.some((event) => event.type === 'model.responded')).toBe(true);
      expect(kernel.getState().turn.status).toBe('active');
      expect(kernel.getState().tools.calls['writer-one']?.status).toBe('failed');
    } finally {
      kernel.close();
    }
  });

  test('fails only the expired Artifact waiter while another Tool remains queued', async () => {
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: waitingArtifactState(['writer-one', 'writer-two']),
      interactionMode: 'accept_edits',
    });
    try {
      const { events, dispatched } = await untilToolFailure(kernel, 'writer-one');
      expect(
        events.filter((event) => event.type === 'tool.failed').map((event) => event.toolCallId),
      ).toEqual(['writer-one']);
      expect(kernel.getState().tools.calls['writer-one']?.status).toBe('failed');
      expect(kernel.getState().tools.calls['writer-two']?.status).toBe('approved');
      const budget = kernel.getState().resourceBudget;
      expect(
        budget.status === 'active' ? budget.waiters['tool:writer-two']?.state : undefined,
      ).toBe('waiting');
      expect(dispatched).not.toContain('run_tools');
      expect(
        events.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    } finally {
      kernel.close();
    }
  });
});
