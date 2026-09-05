import { describe, expect, test } from 'bun:test';
import type {
  AcceptedPresentationEnvelope,
  RuntimeClientEvent,
  RuntimeClientInteraction,
} from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/initialState';
import {
  outputBlockVisualDigest,
  projectOutputBlockTimeline,
} from '../src/tui/presentation/timeline';
import { eventReducer } from '../src/tui/reducers';
import { handleClientEventAction } from '../src/tui/reducers/handleClientEvent';
import type { OutputBlock, TuiRuntimeAuthorityProjection, TuiState } from '../src/tui/types';
import { acceptedEnvelope } from './helpers/accepted-envelope';

function authority(): TuiRuntimeAuthorityProjection {
  return {
    revision: 1,
    activeTask: { taskId: 'task-1', phase: 'building' },
    currentRun: {
      runId: 'run-1',
      initialTurnId: 'turn-1',
      activeTurnId: 'turn-1',
      taskId: 'task-1',
      status: 'running',
      revision: 1,
    },
    interactionQueue: { revision: 1, interactions: [] },
  };
}

function liveState(): TuiState {
  return {
    ...createInitialState(),
    activeSessionId: 'session-1',
    runtimeAuthority: authority(),
    runPromptPresented: true,
  };
}

function dispatch(state: TuiState, event: RuntimeClientEvent): TuiState {
  return eventReducer(state, {
    type: 'ACCEPT_PRESENTATION_ENVELOPE',
    event: acceptedEnvelope(event),
  });
}

function dispatchEnvelope(
  state: TuiState,
  event: RuntimeClientEvent,
  envelope: Partial<AcceptedPresentationEnvelope>,
): TuiState {
  return handleClientEventAction(state, acceptedEnvelope(event, envelope));
}

function allBlocks(state: TuiState): OutputBlock[] {
  return state.turns.flatMap((turn) => turn.blocks);
}

function timelineView(state: TuiState) {
  return state.presentationTimeline.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    state: item.state,
    sourceIdentity: item.sourceIdentity,
    visualDigest: item.state === 'sealed' ? item.visualDigest : undefined,
    renderModel: item.renderModel,
  }));
}

function expectTimelineMirrorsBlocks(state: TuiState): void {
  const blocks = allBlocks(state);
  expect(state.presentationTimeline.items).toHaveLength(blocks.length);
  state.presentationTimeline.items.forEach((item, index) => {
    const block = blocks[index]!;
    expect(item.sourceIdentity.blockId).toBe(block.id);
    // A sealed Timeline may intentionally retain the first immutable render
    // model object while the reducer performs a bookkeeping-only update.
    expect(item.renderModel.block).toEqual(block);
    expect(item.state).toBe(block.presentationState === 'sealed' ? 'sealed' : 'live');
    if (item.state === 'sealed') {
      expect(item.visualDigest).toBe(outputBlockVisualDigest(block));
    }
  });
}

const trace: RuntimeClientEvent[] = [
  { type: 'user.message', messageId: 'message-1', kind: 'task', text: 'Summarize this.' },
  { type: 'model.requested', requestId: 'request-1' },
  {
    type: 'reasoning.activity',
    requestId: 'request-1',
    segmentId: 'reason-1',
    state: 'streaming',
    text: 'Inspecting the request.',
  },
  { type: 'model.text_delta', requestId: 'request-1', text: 'Final answer.\n' },
  {
    type: 'model.responded',
    requestId: 'request-1',
    messageId: 'message-2',
    toolCallCount: 0,
    summary: 'Final answer.\n',
  },
  { type: 'run.terminal', runId: 'run-1', status: 'completed' },
];

describe('TUI Timeline closeout invariants', () => {
  test('every accepted event advances the reducer-owned Timeline projection', () => {
    let state = liveState();
    for (const event of trace) {
      state = dispatch(state, event);
      expectTimelineMirrorsBlocks(state);
    }
    expect(state.presentationTimeline.items.map((item) => item.state)).toEqual([
      'sealed',
      'sealed',
    ]);
  });

  test('live, history replay, and direct replay converge on identity/state/digest/render model', () => {
    let live = liveState();
    for (const event of trace) live = dispatch(live, event);

    let history: TuiState = {
      ...createInitialState(),
      presentationMode: 'history',
    };
    for (const event of trace) history = dispatch(history, event);

    const directReplay = projectOutputBlockTimeline(
      allBlocks(history),
      history.presentationTimeline.renderEpoch,
    );
    expect(timelineView(live)).toEqual(timelineView(history));
    expect(timelineView(history)).toEqual(
      directReplay.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        state: item.state,
        sourceIdentity: item.sourceIdentity,
        visualDigest: item.state === 'sealed' ? item.visualDigest : undefined,
        renderModel: item.renderModel,
      })),
    );
  });

  test('visual digest is sensitive to rendered fields but ignores lifecycle/bookkeeping fields', () => {
    const text: OutputBlock = {
      id: 1,
      kind: 'text',
      content: 'answer',
      streaming: false,
      presentationState: 'sealed',
    };
    expect(outputBlockVisualDigest(text)).not.toBe(
      outputBlockVisualDigest({ ...text, content: 'changed' }),
    );
    expect(outputBlockVisualDigest(text)).not.toBe(
      outputBlockVisualDigest({ ...text, isError: true }),
    );
    expect(outputBlockVisualDigest(text)).toBe(
      outputBlockVisualDigest({
        ...text,
        id: 99,
        modelRequestId: 'request-1',
        modelTerminal: true,
        modelDurationMs: 20,
        thoughtContent: 'private reasoning',
        presentationState: 'live',
      }),
    );

    const tool: OutputBlock = {
      id: 2,
      kind: 'tool_card',
      callId: 'tool-1',
      name: 'shell_execute',
      args: { command: 'printf ok' },
      status: 'running',
      summary: 'running',
      liveOutput: 'ok',
      presentationState: 'live',
    };
    expect(outputBlockVisualDigest(tool)).not.toBe(
      outputBlockVisualDigest({ ...tool, liveOutput: 'changed' }),
    );
    expect(outputBlockVisualDigest(tool)).not.toBe(
      outputBlockVisualDigest({ ...tool, status: 'done', summary: 'done' }),
    );
    expect(outputBlockVisualDigest(tool)).not.toBe(
      outputBlockVisualDigest({
        ...tool,
        id: 22,
        callId: 'different-tool',
        startedAt: 123,
      }),
    );
    expect(outputBlockVisualDigest(tool)).toBe(
      outputBlockVisualDigest({
        ...tool,
        id: 22,
        callId: 'different-tool',
        reviewedPlanBody: true,
        presentationState: 'sealed',
      }),
    );

    const subagent: OutputBlock = {
      id: 3,
      kind: 'subagent',
      subagentId: 'child-1',
      role: 'explore',
      task: 'Inspect files',
      status: 'done',
      summary: 'internal summary',
      toolCallCount: 1,
      durationMs: 10,
      steps: [
        {
          stepId: 'step-1',
          toolCallId: 'tool-1',
          toolName: 'read_file',
          toolArgs: { path: 'a.ts' },
          status: 'success',
          summary: 'internal step summary',
        },
      ],
      presentationState: 'sealed',
    };
    expect(outputBlockVisualDigest(subagent)).not.toBe(
      outputBlockVisualDigest({ ...subagent, task: 'Different task' }),
    );
    expect(outputBlockVisualDigest(subagent)).not.toBe(
      outputBlockVisualDigest({ ...subagent, concurrencyGroupId: 'group-2' }),
    );
    expect(outputBlockVisualDigest(subagent)).not.toBe(
      outputBlockVisualDigest({ ...subagent, expanded: true }),
    );
    expect(outputBlockVisualDigest(subagent)).toBe(
      outputBlockVisualDigest({
        ...subagent,
        id: 33,
        subagentId: 'child-2',
        summary: 'late internal summary',
        toolCallCount: 999,
        steps: [
          {
            ...subagent.steps[0]!,
            stepId: 'step-2',
            toolCallId: 'tool-2',
            summary: 'late internal step summary',
          },
        ],
      }),
    );
  });

  test('input answered/cancelled seal once and late settlements are ignored', () => {
    const interaction: Extract<RuntimeClientInteraction, { kind: 'input' }> = {
      kind: 'input',
      interactionId: 'input-1',
      sessionRevision: 1,
      question: 'Which file?',
      options: [],
      allowFreeText: true,
    };
    let answered = liveState();
    answered = dispatch(answered, { type: 'input.requested', interaction });
    answered = dispatch(answered, {
      type: 'input.answered',
      interactionId: 'input-1',
      summary: 'a.ts',
    });
    const answeredQuestion = allBlocks(answered).find(
      (block) => block.kind === 'question' && block.interactionId === 'input-1',
    );
    expect(answeredQuestion).toEqual(
      expect.objectContaining({ resolved: 'a.ts', presentationState: 'sealed' }),
    );
    expect(
      allBlocks(answered).some((block) => block.kind === 'text' && block.content === 'a.ts'),
    ).toBe(true);
    const answeredSettled = answered;
    answered = dispatch(answered, {
      type: 'input.cancelled',
      interactionId: 'input-1',
    });
    expect(answered).toBe(answeredSettled);

    const cancelledInteraction = { ...interaction, interactionId: 'input-2' };
    let cancelled = liveState();
    cancelled = dispatch(cancelled, { type: 'input.requested', interaction: cancelledInteraction });
    cancelled = dispatch(cancelled, {
      type: 'input.cancelled',
      interactionId: 'input-2',
    });
    const cancelledQuestion = allBlocks(cancelled).find(
      (block) => block.kind === 'question' && block.interactionId === 'input-2',
    );
    expect(cancelledQuestion).toEqual(
      expect.objectContaining({ resolved: 'cancelled', presentationState: 'sealed' }),
    );
    const cancelledSettled = cancelled;
    cancelled = dispatch(cancelled, {
      type: 'input.answered',
      interactionId: 'input-2',
      summary: 'late answer',
    });
    expect(cancelled).toBe(cancelledSettled);
  });

  test('run terminal fences late ephemeral and durable packets without changing Timeline', () => {
    let state = liveState();
    state = dispatchEnvelope(
      state,
      { type: 'user.message', messageId: 'message-late', kind: 'task', text: 'Prompt' },
      { durability: 'durable', revision: 1 },
    );
    state = dispatchEnvelope(
      state,
      { type: 'model.requested', requestId: 'request-late' },
      {
        durability: 'ephemeral',
        stream: {
          actorId: 'model',
          attemptId: 'attempt-1',
          compositionRevision: 'composition-1',
          streamId: 'stream-1',
          sequence: 1,
        },
      },
    );
    state = dispatchEnvelope(
      state,
      { type: 'model.text_delta', requestId: 'request-late', text: 'Stable answer.\n' },
      {
        durability: 'ephemeral',
        stream: {
          actorId: 'model',
          attemptId: 'attempt-1',
          compositionRevision: 'composition-1',
          streamId: 'stream-1',
          sequence: 2,
        },
      },
    );
    state = dispatchEnvelope(
      state,
      {
        type: 'model.responded',
        requestId: 'request-late',
        messageId: 'answer-late',
        toolCallCount: 0,
        summary: 'Stable answer.\n',
      },
      { durability: 'durable', revision: 2 },
    );
    state = dispatchEnvelope(
      state,
      { type: 'run.terminal', runId: 'run-1', status: 'completed' },
      { durability: 'durable', revision: 3 },
    );
    const settled = state;
    const before = timelineView(state);
    const lateEphemeral = [
      {
        type: 'reasoning.activity',
        requestId: 'request-late',
        segmentId: 'late-reason',
        state: 'completed',
        text: 'late reasoning',
      },
      { type: 'model.text_delta', requestId: 'request-late', text: 'late text' },
      { type: 'tool.progress', toolId: 'late-tool', summary: 'late progress' },
    ] satisfies RuntimeClientEvent[];
    for (const [index, event] of lateEphemeral.entries()) {
      state = dispatchEnvelope(state, event, {
        durability: 'ephemeral',
        stream: {
          actorId: 'model',
          attemptId: 'attempt-1',
          compositionRevision: 'composition-1',
          streamId: 'stream-1',
          sequence: index + 10,
        },
      });
      expect(state).toBe(settled);
    }
    const lateDurable = [
      {
        type: 'tool.queued',
        toolId: 'late-tool',
        toolName: 'read_file',
        presentation: 'standalone',
        arguments: { path: 'late.ts' },
        summary: 'late queued',
      },
      { type: 'tool.started', toolId: 'late-tool', summary: 'late started' },
      {
        type: 'tool.finished',
        toolId: 'late-tool',
        toolName: 'read_file',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: 'late', stderr: '' },
        summary: 'late finished',
      },
    ] satisfies RuntimeClientEvent[];
    for (const [index, event] of lateDurable.entries()) {
      state = dispatchEnvelope(state, event, { durability: 'durable', revision: index + 4 });
      expect(state).toBe(settled);
    }
    expect(timelineView(state)).toEqual(before);
    expect(state.presentationTimeline).toBe(settled.presentationTimeline);
  });
});
