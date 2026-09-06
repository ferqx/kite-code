import { describe, expect, test } from 'bun:test';
import type {
  AcceptedPresentationEnvelope,
  RuntimeClientEvent,
  RuntimeInteractionQueueProjection,
} from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/initialState';
import { eventReducer } from '../src/tui/reducers';
import { handleClientEventAction } from '../src/tui/reducers/handleClientEvent';
import type { OutputBlock, TuiRuntimeAuthorityProjection, TuiState } from '../src/tui/types';
import { acceptedEnvelope } from './helpers/accepted-envelope';

function reduce(state: TuiState, event: RuntimeClientEvent): TuiState {
  return eventReducer(state, {
    type: 'ACCEPT_PRESENTATION_ENVELOPE',
    event: acceptedEnvelope(event),
  });
}

function blocks(state: TuiState): OutputBlock[] {
  return state.turns.flatMap((turn) => turn.blocks);
}

function runtimeAuthority(
  runId = 'run-1',
  turnId = 'turn-1',
  taskId = 'task-1',
): TuiRuntimeAuthorityProjection {
  const interactionQueue: RuntimeInteractionQueueProjection = {
    revision: 1,
    interactions: [],
  };
  return {
    revision: 1,
    activeTask: { taskId, phase: 'building' },
    currentRun: {
      runId,
      initialTurnId: turnId,
      activeTurnId: turnId,
      taskId,
      status: 'running',
      revision: 1,
    },
    interactionQueue,
  };
}

function envelope(
  event: RuntimeClientEvent,
  sequence: number,
  overrides: Partial<AcceptedPresentationEnvelope> = {},
): AcceptedPresentationEnvelope {
  const { durability = 'ephemeral', stream: overrideStream, ...rest } = overrides;
  return {
    sessionId: 'session-1',
    connectionGeneration: 1,
    durability,
    runId: 'run-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    ...rest,
    ...(durability === 'ephemeral'
      ? {
          stream: overrideStream ?? {
            actorId: 'model',
            attemptId: 'attempt-1',
            compositionRevision: 'composition-1',
            streamId: 'stream-1',
            sequence,
          },
        }
      : {}),
    event,
  };
}

describe('TUI projector convergence invariants', () => {
  test('request assembly overflow is scoped to one request', () => {
    let state = createInitialState();
    for (let index = 0; index < 65; index += 1) {
      state = reduce(state, { type: 'model.requested', requestId: `request-${index}` });
    }
    const before = state;
    state = reduce(state, {
      type: 'model.responded',
      requestId: 'request-0',
      messageId: 'message-0',
      toolCallCount: 0,
      summary: 'The first request completed.',
    });
    expect(state).not.toBe(before);
    expect(
      blocks(state).some(
        (block) => block.kind === 'text' && block.content === 'The first request completed.',
      ),
    ).toBe(true);

    const overflowBefore = state;
    state = reduce(state, {
      type: 'model.responded',
      requestId: 'request-64',
      messageId: 'message-overflow',
      toolCallCount: 0,
      summary: 'Must recover from history.',
    });
    expect(state).toBe(overflowBefore);
  });

  test('model terminal explicitly seals every text component it owns', () => {
    let state = createInitialState();
    state = reduce(state, { type: 'model.requested', requestId: 'request-1' });
    state = reduce(state, {
      type: 'model.text_delta',
      requestId: 'request-1',
      text: 'Answer paragraph.\n',
    });
    state = reduce(state, {
      type: 'model.responded',
      requestId: 'request-1',
      messageId: 'message-1',
      toolCallCount: 0,
      summary: 'Answer paragraph.\n',
    });
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        modelRequestId: 'request-1',
        modelTerminal: true,
        presentationState: 'sealed',
      }),
    );
    expect(state.presentationTimeline?.items).toContainEqual(
      expect.objectContaining({ state: 'sealed', kind: 'text' }),
    );

    const sealed = state;
    state = reduce(state, {
      type: 'reasoning.activity',
      requestId: 'request-1',
      segmentId: 'reasoning-late',
      state: 'completed',
      text: 'Late private reasoning.',
    });
    expect(blocks(state)).toEqual(blocks(sealed));
    expect(
      blocks(state).find(
        (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
      )?.thoughtContent,
    ).toBeUndefined();
  });

  test('predecessor turn and run terminals cannot settle the successor authority', () => {
    let state: TuiState = {
      ...createInitialState(),
      activeSessionId: 'session-1',
      runtimeAuthority: runtimeAuthority('run-2', 'turn-2', 'task-2'),
      runPromptPresented: true,
      runStartTime: Date.now(),
    };
    state = reduce(state, {
      type: 'turn.terminal',
      turnId: 'turn-1',
      status: 'completed',
      summary: 'old turn',
    });
    state = reduce(state, {
      type: 'run.terminal',
      runId: 'run-1',
      status: 'completed',
      summary: 'old run',
    });
    expect(state.exited).toBe(false);
    expect(state.runtimeAuthority?.currentRun?.runId).toBe('run-2');
    expect(blocks(state)).toEqual([]);

    const rejectedTerminal = envelope(
      { type: 'run.terminal', runId: 'run-1', status: 'completed', summary: 'old run' },
      1,
      { durability: 'durable', revision: 1 },
    );
    expect(handleClientEventAction(state, rejectedTerminal).closedRunIds?.has('run-1')).toBe(false);
    state = {
      ...state,
      runtimeAuthority: runtimeAuthority('run-1', 'turn-1', 'task-1'),
    };
    state = handleClientEventAction(state, rejectedTerminal);
    expect(state.closedRunIds?.has('run-1')).toBe(true);
  });

  test('live terminals require a joined Runtime authority', () => {
    const state = createInitialState();
    const terminal = envelope(
      { type: 'run.terminal', runId: 'run-without-authority', status: 'completed' },
      1,
      { durability: 'durable', runId: 'run-without-authority', revision: 1 },
    );
    expect(handleClientEventAction(state, terminal)).toBe(state);
  });

  test('history replay explicitly opts into terminal projection without live authority', () => {
    const state = {
      ...createInitialState(),
      presentationMode: 'history' as const,
    };
    const terminal = envelope(
      { type: 'run.terminal', runId: 'history-run', status: 'completed' },
      1,
      { durability: 'durable', runId: 'history-run', revision: 1 },
    );
    const projected = handleClientEventAction(state, terminal);
    expect(projected).not.toBe(state);
    expect(projected.exited).toBe(true);
  });

  test('run terminal freezes still-running tool and subagent render models', () => {
    let state: TuiState = {
      ...createInitialState(),
      activeSessionId: 'session-1',
      runtimeAuthority: runtimeAuthority(),
      runPromptPresented: true,
      runStartTime: Date.now(),
    };
    state = reduce(state, {
      type: 'tool.queued',
      toolId: 'tool-live-at-terminal',
      toolName: 'shell_execute',
      presentation: 'standalone',
      arguments: { command: 'long-running command' },
      summary: 'Queued.',
    });
    state = reduce(state, { type: 'tool.started', toolId: 'tool-live-at-terminal' });
    state = reduce(state, {
      type: 'subagent.started',
      subagentId: 'child-live-at-terminal',
      role: 'explore',
      name: 'Still running child',
    });

    state = reduce(state, {
      type: 'run.terminal',
      runId: 'run-1',
      status: 'completed',
      summary: 'Run complete.',
    });

    expect(blocks(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'tool-live-at-terminal',
          status: 'cancelled',
          presentationState: 'sealed',
        }),
        expect.objectContaining({
          kind: 'subagent',
          subagentId: 'child-live-at-terminal',
          status: 'cancelled',
          presentationState: 'sealed',
        }),
      ]),
    );
  });

  test('approval settlement requires matching generation and owner', () => {
    const owner = {
      kind: 'root_tool' as const,
      toolCallId: 'root-tool-1',
    };
    let state = reduce(createInitialState(), {
      type: 'approval.queued',
      queueSequence: 1,
      interaction: {
        kind: 'approval',
        interactionId: 'approval-1',
        sessionRevision: 1,
        generation: 2,
        grants: ['approve_once'],
        owner,
      },
    });
    const before = state;
    state = reduce(state, {
      type: 'approval.granted',
      interactionId: 'approval-1',
      generation: 1,
      owner,
    });
    expect(state).toBe(before);
    state = reduce(state, {
      type: 'approval.granted',
      interactionId: 'approval-1',
      generation: 2,
      owner: { kind: 'root_tool', toolCallId: 'other-tool' },
    });
    expect(state).toBe(before);
    state = reduce(state, {
      type: 'approval.granted',
      interactionId: 'approval-1',
      generation: 2,
      owner,
    });
    expect(state.pendingApprovals?.get('approval-1')).toEqual(
      expect.objectContaining({ status: 'authorized_queued', result: 'authorized' }),
    );
    expect(state.interrupt).toBeNull();
  });

  test('local approval rejection waits for the durable owner-bound terminal', () => {
    const owner = {
      kind: 'root_tool' as const,
      toolCallId: 'root-tool-reject',
    };
    const state = reduce(createInitialState(), {
      type: 'approval.queued',
      queueSequence: 1,
      interaction: {
        kind: 'approval',
        interactionId: 'approval-reject-local',
        sessionRevision: 1,
        generation: 3,
        grants: ['approve_once'],
        owner,
      },
    });
    const afterLocalReject = eventReducer(state, {
      type: 'RESOLVE_INTERRUPT',
      resolution: { action: 'denied' },
    });
    expect(afterLocalReject).toBe(state);
    expect(afterLocalReject.pendingApprovals?.get('approval-reject-local')).toEqual(
      expect.objectContaining({ status: 'awaiting_user' }),
    );
  });

  test('subagent steps use stable identities and late steps cannot reopen a terminal child', () => {
    let state = createInitialState();
    state = reduce(state, {
      type: 'subagent.started',
      subagentId: 'child-1',
      role: 'explore',
      name: 'Inspect files',
      concurrencyGroupId: 'group-1',
    });
    state = reduce(state, {
      type: 'subagent.step',
      subagentId: 'child-1',
      stepId: 'step-a',
      toolCallId: 'tool-a',
      toolName: 'read_file',
      status: 'started',
      arguments: { path: 'a.ts' },
    });
    state = reduce(state, {
      type: 'subagent.step',
      subagentId: 'child-1',
      stepId: 'step-b',
      toolCallId: 'tool-b',
      toolName: 'read_file',
      status: 'started',
      arguments: { path: 'b.ts' },
    });
    const beforePartialIdentity = state;
    state = reduce(state, {
      type: 'subagent.step',
      subagentId: 'child-1',
      stepId: 'step-other',
      toolCallId: 'tool-a',
      toolName: 'read_file',
      status: 'completed',
      summary: 'Must not match only toolCallId.',
    });
    expect(state).toBe(beforePartialIdentity);
    state = reduce(state, {
      type: 'subagent.step',
      subagentId: 'child-1',
      stepId: 'step-b',
      toolCallId: 'tool-b',
      toolName: 'read_file',
      status: 'completed',
      summary: 'B complete.',
    });
    state = reduce(state, {
      type: 'subagent.step',
      subagentId: 'child-1',
      stepId: 'step-a',
      toolCallId: 'tool-a',
      toolName: 'read_file',
      status: 'completed',
      summary: 'A complete.',
    });
    const child = blocks(state).find(
      (block): block is Extract<OutputBlock, { kind: 'subagent' }> => block.kind === 'subagent',
    );
    expect(child?.steps).toEqual([
      expect.objectContaining({ stepId: 'step-a', toolCallId: 'tool-a', status: 'success' }),
      expect.objectContaining({ stepId: 'step-b', toolCallId: 'tool-b', status: 'success' }),
    ]);
    state = reduce(state, {
      type: 'subagent.completed',
      subagentId: 'child-1',
      summary: 'Child complete.',
      toolCallCount: 2,
      durationMs: 20,
    });
    const terminal = state;
    state = reduce(state, {
      type: 'subagent.step',
      subagentId: 'child-1',
      stepId: 'step-c',
      toolCallId: 'tool-c',
      toolName: 'write_file',
      status: 'started',
    });
    expect(state).toBe(terminal);
  });

  test('terminal-before-started joins one bounded pending child card', () => {
    let state = createInitialState();
    state = reduce(state, {
      type: 'subagent.completed',
      subagentId: 'child-late-start',
      summary: 'Already complete.',
      toolCallCount: 1,
      durationMs: 5,
    });
    expect(blocks(state)).toEqual([]);
    expect(state.pendingSubagentTerminals?.has('child-late-start')).toBe(true);
    state = reduce(state, {
      type: 'subagent.started',
      subagentId: 'child-late-start',
      role: 'review',
      name: 'Review',
    });
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({
        kind: 'subagent',
        subagentId: 'child-late-start',
        status: 'done',
        presentationState: 'sealed',
      }),
    );
    expect(state.pendingSubagentTerminals?.has('child-late-start')).toBe(false);
  });

  test('pending terminal overflow leaves a sealed unavailable diagnostic', () => {
    let state = createInitialState();
    for (let index = 0; index < 65; index += 1) {
      state = reduce(state, {
        type: 'subagent.failed',
        subagentId: `child-overflow-${index}`,
        summary: 'Child result arrived before its start.',
        toolCallCount: 1,
        durationMs: 1,
      });
    }
    expect(state.pendingSubagentTerminals?.size).toBe(64);
    expect(state.pendingSubagentTerminals?.has('child-overflow-0')).toBe(false);
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        presentationState: 'sealed',
        content: expect.stringContaining('exceeded the recovery window'),
      }),
    );
    expect(blocks(state).some((block) => block.kind === 'subagent')).toBe(false);
  });

  test('pending terminal expires after a durable revision gap', () => {
    let state = handleClientEventAction(
      createInitialState(),
      envelope(
        {
          type: 'subagent.completed',
          subagentId: 'child-revision-expiry',
          summary: 'Child completed before its start.',
          toolCallCount: 1,
          durationMs: 1,
        },
        1,
        { durability: 'durable', revision: 1 },
      ),
    );
    expect(state.pendingSubagentTerminals?.get('child-revision-expiry')?.revision).toBe(1);

    state = handleClientEventAction(
      state,
      envelope(
        {
          type: 'session.notice',
          code: 'history_gap',
          message: 'A later durable revision arrived.',
        },
        66,
        { durability: 'durable', revision: 66 },
      ),
    );
    expect(state.pendingSubagentTerminals?.has('child-revision-expiry')).toBe(false);
    expect(blocks(state)).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        presentationState: 'sealed',
        content: expect.stringContaining('terminal recovery window'),
      }),
    );
  });

  test('different server read-only groups never merge into one Thought item', () => {
    let state = createInitialState();
    const queue = (toolId: string, groupId: string): RuntimeClientEvent => ({
      type: 'tool.queued',
      toolId,
      toolName: 'read_file',
      presentation: 'exploration',
      presentationGroupId: groupId,
      arguments: { path: `${toolId}.ts` },
      summary: 'Queued.',
    });
    state = reduce(state, queue('group-a-tool', 'group-a'));
    state = reduce(state, { type: 'tool.started', toolId: 'group-a-tool' });
    state = reduce(state, {
      type: 'tool.finished',
      toolId: 'group-a-tool',
      toolName: 'read_file',
      presentation: 'exploration',
      result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
      summary: 'Done.',
    });
    state = reduce(state, queue('group-b-tool', 'group-b'));
    state = reduce(state, { type: 'tool.started', toolId: 'group-b-tool' });
    const summaries = blocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.map((summary) => summary.presentationGroupId)).toEqual(['group-a', 'group-b']);
  });

  test('auto-review child approval never leaves the manual Working/approval surface visible', () => {
    const owner = {
      kind: 'subagent_tool' as const,
      toolCallId: 'child-tool',
      subagentId: 'child-review',
      parentToolCallId: 'parent-tool',
    };
    let state = createInitialState();
    state = reduce(state, {
      type: 'subagent.started',
      subagentId: 'child-review',
      role: 'review',
      name: 'Review changes',
    });
    state = reduce(state, {
      type: 'subagent.phase',
      subagentId: 'child-review',
      parentToolCallId: 'parent-tool',
      status: 'suspended',
      approvalState: 'auto_reviewing',
      interactionId: 'auto-approval',
    });
    state = reduce(state, {
      type: 'approval.queued',
      queueSequence: 1,
      interaction: {
        kind: 'approval',
        interactionId: 'auto-approval',
        sessionRevision: 1,
        generation: 1,
        grants: ['approve_once'],
        owner,
      },
    });
    expect(state.interrupt).toBeNull();
    expect(state.pendingApprovals?.get('auto-approval')).toEqual(
      expect.objectContaining({ status: 'auto_reviewing', owner }),
    );
  });

  test('AcceptedPresentationEnvelope fences Session, stream sequence, and late ephemeral events', () => {
    let unbound = createInitialState();
    unbound = handleClientEventAction(
      unbound,
      envelope({ type: 'model.requested', requestId: 'request-unbound' }, 1),
    );
    const afterFirstSession = unbound;
    unbound = handleClientEventAction(
      unbound,
      envelope({ type: 'model.text_delta', requestId: 'request-unbound', text: 'foreign' }, 2, {
        sessionId: 'other-session',
      }),
    );
    expect(unbound).toBe(afterFirstSession);

    let state: TuiState = {
      ...createInitialState(),
      activeSessionId: 'session-1',
      runtimeAuthority: runtimeAuthority(),
      runPromptPresented: true,
    };
    state = handleClientEventAction(
      state,
      envelope({ type: 'model.requested', requestId: 'request-envelope' }, 1),
    );
    const beforeForeign = state;
    state = handleClientEventAction(
      state,
      envelope({ type: 'model.text_delta', requestId: 'request-envelope', text: 'foreign' }, 2, {
        sessionId: 'other-session',
      }),
    );
    expect(state).toBe(beforeForeign);
    const beforeDuplicate = state;
    state = handleClientEventAction(
      state,
      envelope({ type: 'model.text_delta', requestId: 'request-envelope', text: 'duplicate' }, 1),
    );
    expect(state).toBe(beforeDuplicate);

    state = handleClientEventAction(
      state,
      envelope(
        {
          type: 'model.responded',
          requestId: 'request-envelope',
          messageId: 'message-envelope',
          toolCallCount: 0,
          summary: 'Envelope answer.\n',
        },
        3,
        { durability: 'durable', revision: 2 },
      ),
    );
    state = handleClientEventAction(
      state,
      envelope(
        { type: 'run.terminal', runId: 'run-1', status: 'completed', summary: 'Run complete.' },
        4,
        { durability: 'durable', revision: 3 },
      ),
    );
    const terminal = state;
    state = handleClientEventAction(
      state,
      envelope({ type: 'model.text_delta', requestId: 'request-envelope', text: 'late' }, 5),
    );
    expect(state).toBe(terminal);
    state = handleClientEventAction(
      state,
      envelope(
        {
          type: 'tool.queued',
          toolId: 'late-tool',
          toolName: 'read_file',
          arguments: { path: 'late.ts' },
          presentation: 'standalone',
          presentationGroupId: 'late-group',
          summary: 'Queued.',
        },
        6,
        { durability: 'durable', revision: 4 },
      ),
    );
    expect(state).toBe(terminal);
  });
});
