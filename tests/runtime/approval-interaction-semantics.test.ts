import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrentRuntimeEvent, type RuntimeEvent } from '@kite/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  type RuntimeState,
} from '@kite/runtime-host/kernel-adapter';
import { projectRuntimeSessionLiveMode } from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import {
  approvalRejectionSettlementEvents,
  deferredApprovalRejectionTurnAbortEvent,
  eventsForRunCancellation,
  eventsForRuntimeAction,
  type RuntimeUserAction,
} from '#app/bootstrap/runtime/state-actions';
import {
  type RuntimeStateSessionPort,
  runStateRuntimeLoop,
} from '#app/bootstrap/runtime/state-runner';
import { loadAgentConfig, saveInteractionMode } from '#app/config/index';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

function initialState(): RuntimeState {
  return createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'saq-semantics-test',
    userId: 'test-user',
    workspace: '/tmp/saq-semantics-test',
  });
}

function approval(command = 'printf saq') {
  return {
    scope: 'once' as const,
    cwd: '/tmp/saq-semantics-test',
    threadId: 'saq-semantics-test',
    tool: 'shell_execute',
    command,
    risk: 'execute_code' as const,
    approvalHash: `sha256:${command}`,
    summary: `Run ${command}`,
    reason: 'SAQ approval fixture',
    expectedEffects: [],
    grantOptions: ['approve_once', 'same_command'] as const,
    recommendedGrant: 'approve_once' as const,
  };
}

function addTool(state: RuntimeState, toolCallId: string): RuntimeState {
  return reduceRuntimeState(state, {
    type: 'tool.queued',
    toolCallId,
    name: 'shell_execute',
    args: { command: `printf ${toolCallId}` },
  });
}

function withStatuses(
  state: RuntimeState,
  statuses: readonly [string, RuntimeState['tools']['calls'][string]['status']][],
): RuntimeState {
  const calls = { ...state.tools.calls };
  for (const [toolCallId, status] of statuses) {
    const call = calls[toolCallId];
    if (!call) throw new Error(`missing tool fixture ${toolCallId}`);
    calls[toolCallId] = { ...call, status };
  }
  return { ...state, tools: { ...state.tools, calls } };
}

describe('SAQ-16/17 — approval interaction semantics', () => {
  test('focused rejection durably settles the Tool and aborts only an otherwise idle turn', () => {
    const state = withStatuses(addTool(initialState(), 'shell-a'), [
      ['shell-a', 'awaiting_approval'],
    ]);
    const events = approvalRejectionSettlementEvents(state, [
      {
        type: 'approval.rejected',
        interactionId: 'approval-a',
        toolCallId: 'shell-a',
        generation: 0,
        reason: 'focused rejection',
      },
    ]);

    expect(events.map((event) => event.type)).toEqual(['tool.rejected', 'turn.aborted']);
    expect(events).toEqual([
      { type: 'tool.rejected', toolCallId: 'shell-a', reason: 'focused rejection' },
      {
        type: 'turn.aborted',
        turnId: state.turn.turnId,
        reason: 'focused rejection',
        cause: 'user',
      },
    ]);
  });

  test('focused rejection never cancels a queued sibling', () => {
    const state = withStatuses(addTool(addTool(initialState(), 'shell-a'), 'shell-b'), [
      ['shell-a', 'awaiting_approval'],
      ['shell-b', 'queued'],
    ]);
    const events = approvalRejectionSettlementEvents(state, [
      {
        type: 'approval.rejected',
        interactionId: 'approval-a',
        toolCallId: 'shell-a',
        generation: 0,
        reason: 'focused rejection',
      },
    ]);

    expect(events.map((event) => event.type)).toEqual(['tool.rejected']);
    expect(events).not.toContainEqual(expect.objectContaining({ toolCallId: 'shell-b' }));
  });

  test('after a sibling settles, approval rejection closes the turn exactly once', () => {
    const state = withStatuses(addTool(addTool(initialState(), 'shell-a'), 'shell-b'), [
      ['shell-a', 'rejected'],
      ['shell-b', 'succeeded'],
    ]);
    state.tools.calls['shell-a'] = {
      ...state.tools.calls['shell-a']!,
      error: 'focused rejection',
      failure: {
        kind: 'approval_rejected',
        message: 'focused rejection',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
    };

    const first = deferredApprovalRejectionTurnAbortEvent(state);
    expect(first).toMatchObject({ type: 'turn.aborted', cause: 'user' });
    expect(
      deferredApprovalRejectionTurnAbortEvent({
        ...state,
        turn: { ...state.turn, status: 'aborted' },
      }),
    ).toBeNull();
  });

  test('runStateRuntimeLoop defers rejection abort until siblings settle and never replays it', async () => {
    let state = withStatuses(addTool(addTool(initialState(), 'shell-a'), 'shell-b'), [
      ['shell-a', 'rejected'],
      ['shell-b', 'succeeded'],
    ]);
    state.tools.calls['shell-a'] = {
      ...state.tools.calls['shell-a']!,
      error: 'focused rejection',
      failure: {
        kind: 'approval_rejected',
        message: 'focused rejection',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
    };
    let lastAppliedEvents: RuntimeEvent[] = [];
    let processEventCalls = 0;
    let executorCalls = 0;
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: (event) => {
        processEventCalls += 1;
        state = reduceRuntimeState(state, event);
        lastAppliedEvents = [event];
        return { status: 'applied', eventId: `event-${processEventCalls}` };
      },
      processEventBatch: (events) => {
        const normalizedEvents = events.map((event) =>
          event.type === 'tool.rejected'
            ? normalizeCurrentToolOutcomeEvent(event, state, '2026-08-25T00:00:01.000Z')
            : event,
        );
        for (const event of normalizedEvents) state = reduceRuntimeState(state, event);
        lastAppliedEvents = normalizedEvents;
        return lastAppliedEvents;
      },
      getLastAppliedEvents: () => lastAppliedEvents,
      selectPendingEffects: () => [{ type: 'stop' }],
      acquireRunner: () => 'approval-rejection-runner',
      releaseRunner: () => undefined,
      beginEffect: () => {
        throw new Error('No effect should be started after approval rejection.');
      },
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'No action should be requested after approval rejection.',
        telemetry: { type: 'runtime.action_ignored', reason: 'unexpected action' },
      }),
    };

    const run = async (): Promise<RuntimeEvent[]> => {
      const emitted: RuntimeEvent[] = [];
      for await (const event of runStateRuntimeLoop(
        kernel,
        async () => {
          executorCalls += 1;
          return [];
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unexpected' }) },
      )) {
        emitted.push(event);
      }
      return emitted;
    };

    const first = await run();
    expect(first.map((event) => event.type)).toEqual(['turn.aborted']);
    expect(processEventCalls).toBe(1);
    expect(executorCalls).toBe(0);
    expect(state.turn.status).toBe('aborted');

    const second = await run();
    expect(second).toEqual([]);
    expect(processEventCalls).toBe(1);
    expect(executorCalls).toBe(0);
  });

  test('provider waiter path settles a rejection when applyAction returns only the decision', async () => {
    let state = reduceRuntimeState(addTool(initialState(), 'shell-a'), {
      type: 'approval.requested',
      interactionId: 'approval-a',
      toolCallId: 'shell-a',
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
      approval: approval(),
    });
    let lastAppliedEvents: RuntimeEvent[] = [];
    let processEventCalls = 0;
    let providerCalls = 0;
    let executorCalls = 0;
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: (event) => {
        processEventCalls += 1;
        state = reduceRuntimeState(state, event);
        lastAppliedEvents = [event];
        return { status: 'applied', eventId: `event-${processEventCalls}` };
      },
      processEventBatch: (events) => {
        const normalizedEvents = events.map((event) =>
          event.type === 'tool.rejected'
            ? normalizeCurrentToolOutcomeEvent(event, state, '2026-08-25T00:00:01.000Z')
            : event,
        );
        for (const event of normalizedEvents) state = reduceRuntimeState(state, event);
        lastAppliedEvents = normalizedEvents;
        return lastAppliedEvents;
      },
      getLastAppliedEvents: () => lastAppliedEvents,
      selectPendingEffects: () =>
        state.turn.status === 'active' && state.interactions.kind === 'awaiting_tool_approval'
          ? [{ type: 'request_tool_approval', interactionId: 'approval-a', toolCallId: 'shell-a' }]
          : [{ type: 'stop' }],
      acquireRunner: () => 'provider-waiter-runner',
      releaseRunner: () => undefined,
      beginEffect: () => {
        throw new Error('No executor effect should be started.');
      },
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: (action) => {
        const event: RuntimeEvent = {
          type: 'approval.rejected',
          interactionId: 'interactionId' in action ? action.interactionId : 'unexpected',
          toolCallId: 'shell-a',
          generation: action.type === 'reject' ? action.generation : 0,
          reason: 'provider rejection',
          outcome: {
            schemaVersion: 1,
            status: 'rejected',
            failure: { kind: 'approval_rejected', detailCode: 'approval_rejected' },
            dispatchState: 'not_started',
            externalEffects: 'none',
            replaySafety: 'pre_dispatch',
            recovery: {
              disposition: 'never',
              maximumAdditionalCalls: 0,
              requiresNewModelResponse: false,
              safeAutomaticRetry: false,
            },
            timing: { source: 'runtime_boundary' },
          },
        };
        state = reduceRuntimeState(state, event);
        lastAppliedEvents = [event];
        return { status: 'applied', events: [event] };
      },
    };

    const run = async (): Promise<RuntimeEvent[]> => {
      const emitted: RuntimeEvent[] = [];
      for await (const event of runStateRuntimeLoop(
        kernel,
        async () => {
          executorCalls += 1;
          return [];
        },
        {
          requestAction: async () => {
            providerCalls += 1;
            return {
              type: 'reject' as const,
              interactionId: 'approval-a',
              generation: 0,
            };
          },
        },
      )) {
        emitted.push(event);
      }
      return emitted;
    };

    const first = await run();
    expect(first.map((event) => event.type)).toEqual([
      'approval.rejected',
      'tool.rejected',
      'turn.aborted',
    ]);
    expect(providerCalls).toBe(1);
    expect(executorCalls).toBe(0);
    expect(state.turn.status).toBe('aborted');

    const second = await run();
    expect(second).toEqual([]);
    expect(processEventCalls).toBe(0);
    expect(providerCalls).toBe(1);
    expect(executorCalls).toBe(0);
  });

  test('an old approval rejection cannot abort the next turn of the same Task', async () => {
    let state = withStatuses(addTool(initialState(), 'old-shell'), [['old-shell', 'rejected']]);
    state.activeTaskId = 'task-same-across-turns';
    state.tools.calls['old-shell'] = {
      ...state.tools.calls['old-shell']!,
      taskId: state.activeTaskId,
      failure: {
        kind: 'approval_rejected',
        message: 'old rejection',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
    };
    state = reduceRuntimeState(state, { type: 'turn.started', turnId: 'next-turn' });
    let processEventCalls = 0;
    let lastAppliedEvents: RuntimeEvent[] = [];
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: (event) => {
        processEventCalls += 1;
        state = reduceRuntimeState(state, event);
        lastAppliedEvents = [event];
        return { status: 'applied', eventId: `event-${processEventCalls}` };
      },
      processEventBatch: (events) => {
        for (const event of events) state = reduceRuntimeState(state, event);
        lastAppliedEvents = [...events];
        return lastAppliedEvents;
      },
      getLastAppliedEvents: () => lastAppliedEvents,
      selectPendingEffects: () => [{ type: 'stop' }],
      acquireRunner: () => 'cross-turn-runner',
      releaseRunner: () => undefined,
      beginEffect: () => {
        throw new Error('No effect should be started.');
      },
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'No action should be requested.',
        telemetry: { type: 'runtime.action_ignored', reason: 'unexpected action' },
      }),
    };

    const emitted: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(kernel, async () => [], {
      requestAction: async () => ({ type: 'cancel', interactionId: 'unexpected' }),
    })) {
      emitted.push(event);
    }

    expect(emitted).toEqual([]);
    expect(processEventCalls).toBe(0);
    expect(state.turn).toMatchObject({ turnId: 'next-turn', status: 'active' });
  });

  test('never accepts full_access as an approval grant', () => {
    const state: RuntimeState = {
      ...addTool(initialState(), 'shell-a'),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-a',
        toolCallId: 'shell-a',
        approval: approval(),
      },
    };

    const legacyGrant = {
      type: 'approval.granted',
      interactionId: 'approval-a',
      toolCallId: 'shell-a',
      grant: 'full_access',
      receiptId: 'legacy-full-access',
      generation: 0,
    } as const;
    expect(() => assertCurrentRuntimeEvent(legacyGrant)).toThrow();

    const events = eventsForRuntimeAction(
      state,
      {
        type: 'approve',
        interactionId: 'approval-a',
        generation: 0,
        grant: 'full_access',
      } as unknown as RuntimeUserAction,
      { sandboxAvailable: true },
    );
    expect(events.some((event) => event.type === 'approval.granted')).toBe(false);
    expect(events.some((event) => event.type === 'approval.batch_released')).toBe(false);
  });

  test('Esc rejects only the focused approval; input and plan cancellation stay distinct', () => {
    let state = addTool(initialState(), 'shell-a');
    state = addTool(state, 'shell-b');
    state = {
      ...withStatuses(state, [
        ['shell-a', 'awaiting_approval'],
        ['shell-b', 'awaiting_approval'],
      ]),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-a',
        toolCallId: 'shell-a',
        approval: approval(),
      },
    };

    const approvalEsc = eventsForRuntimeAction(state, {
      type: 'reject',
      interactionId: 'approval-a',
      generation: 0,
      reason: 'focused Esc',
    });
    expect(approvalEsc.filter((event) => event.type === 'approval.rejected')).toHaveLength(1);
    expect(approvalEsc.some((event) => event.type === 'turn.aborted')).toBe(false);
    expect(
      approvalEsc.some(
        (event) => event.type === 'tool.cancelled' && event.toolCallId === 'shell-b',
      ),
    ).toBe(false);

    const inputState: RuntimeState = {
      ...state,
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'input-1',
        toolCallId: 'shell-a',
        request: { question: 'Continue?', options: [], allow_free_text: true },
      },
    };
    const inputEsc = eventsForRuntimeAction(inputState, {
      type: 'cancel',
      interactionId: 'input-1',
      reason: 'Esc input',
    });
    expect(inputEsc.map((event) => event.type)).toEqual(['user_input.cancelled', 'tool.finished']);
  });
});

describe('SAQ-18 — whole-turn Ctrl+C cancellation', () => {
  test('cancels queued, awaiting, authorized, and running children atomically', () => {
    let state = initialState();
    for (const toolCallId of ['queued', 'awaiting', 'authorized', 'running']) {
      state = addTool(state, toolCallId);
    }
    state = withStatuses(state, [
      ['queued', 'queued'],
      ['awaiting', 'awaiting_approval'],
      ['authorized', 'approved'],
      ['running', 'running'],
    ]);
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-awaiting',
      toolCallId: 'awaiting',
      approval: approval('printf awaiting'),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
    });
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-authorized',
      toolCallId: 'authorized',
      approval: approval('printf authorized'),
      fullModeBypassEligible: false,
      fullModePolicyBypassAllowed: false,
    });
    const awaitingPending = state.pendingApprovals.get('approval-awaiting');
    const authorizedPending = state.pendingApprovals.get('approval-authorized');
    if (!awaitingPending || !authorizedPending)
      throw new Error('approval queue fixture incomplete');
    state = {
      ...state,
      activeApprovalId: 'approval-awaiting',
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-awaiting',
        toolCallId: 'awaiting',
        approval: awaitingPending.approval,
      },
      pendingApprovals: new Map([
        ['approval-awaiting', awaitingPending],
        [
          'approval-authorized',
          { ...authorizedPending, status: 'authorized_queued', state: 'authorized_queued' },
        ],
      ]),
    };

    const persisted = eventsForRunCancellation(state, 'Ctrl+C', 'user');
    const cancelledIds = new Set(
      persisted
        .filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool.cancelled' }> =>
            event.type === 'tool.cancelled',
        )
        .map((event) => event.toolCallId),
    );
    expect(cancelledIds).toEqual(new Set(['queued', 'authorized', 'running']));
    expect(persisted.some((event) => event.type === 'approval.rejected')).toBe(true);
    expect(persisted.some((event) => event.type === 'turn.aborted')).toBe(true);

    const settled = persisted.reduce(
      (current, event) =>
        reduceRuntimeState(
          current,
          normalizeCurrentToolOutcomeEvent(event, current, '2026-08-25T00:00:01.000Z'),
        ),
      state,
    );
    expect(
      (settled as RuntimeState & { pendingApprovals?: Map<unknown, unknown> }).pendingApprovals,
    ).toEqual(new Map());

    const late = reduceRuntimeState(settled, {
      type: 'approval.granted',
      interactionId: 'approval-awaiting',
      toolCallId: 'awaiting',
      grant: 'approve_once',
      receiptId: 'late-receipt',
      generation: 0,
    });
    expect(late).toEqual(settled);
  });
});

describe('SAQ-19 — permissions persistence, mode orthogonality, and identity revision', () => {
  test('persists /permissions mode without making Full a grant', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-saq-permissions-'));
    const configPath = join(directory, 'kite-code.jsonc');
    try {
      expect(saveInteractionMode('full', configPath)).toBe(true);
      expect(readFileSync(configPath, 'utf8')).toContain('"interactionMode": "full"');
      expect(
        loadAgentConfig({ configPath, providerName: 'ollama', modelName: 'fixture' })
          .interactionMode,
      ).toBe('full');

      const state = reduceRuntimeState(initialState(), {
        type: 'interaction_mode.changed',
        mode: 'full',
        source: 'user',
        changedAt: '2026-08-25T00:00:00.000Z',
      });
      expect(state.mode).toBe('full');
      expect(state).not.toHaveProperty('authorization');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('models live interaction mode as a revision, not immutable session identity', () => {
    const before = initialState();
    expect(projectRuntimeSessionLiveMode(before)).toEqual({
      interactionMode: 'accept_edits',
      interactionModeRevision: 0,
    });
    const after = reduceRuntimeState(before, {
      type: 'interaction_mode.changed',
      mode: 'full',
      source: 'user',
      changedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(projectRuntimeSessionLiveMode(after)).toEqual({
      interactionMode: 'full',
      interactionModeRevision: 1,
    });
  });
});
