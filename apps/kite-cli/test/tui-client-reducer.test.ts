import { describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/App';
import { eventReducer } from '../src/tui/reducers';
import { sessionDataToUI } from '../src/tui/replay-blocks';

describe('closed RuntimeClientEvent reducer', () => {
  test('renders a durable user prompt once by message identity across replay', () => {
    const first = {
      type: 'user.message' as const,
      messageId: 'message-identity-1',
      kind: 'task' as const,
      text: '你好',
    };
    // Reconnect/replay must never use prompt text as a deduplication key:
    // identical text under another durable identity remains another turn.
    const sameTextNewMessage = { ...first, messageId: 'message-identity-2' };

    let state = eventReducer(createInitialState(), { type: 'RUNTIME_EVENT', event: first });
    state = eventReducer(state, { type: 'RUNTIME_EVENT', event: first });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: sameTextNewMessage,
    });

    const userBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter(
        (
          block,
        ): block is Extract<(typeof state.turns)[number]['blocks'][number], { kind: 'user' }> =>
          block.kind === 'user',
      );
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks.map((block) => block.messageId)).toEqual([
      'message-identity-1',
      'message-identity-2',
    ]);
    expect(userBlocks.map((block) => block.content)).toEqual(['你好', '你好']);
  });

  test('renders safe user/model/tool facts without raw tool arguments or paths', () => {
    let state = createInitialState();
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'user.message',
        messageId: 'message-1',
        kind: 'task',
        text: 'Refactor the client.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'model.requested', requestId: 'request-safe-facts' },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.text_delta',
        requestId: 'request-safe-facts',
        text: 'I will inspect the contract.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.responded',
        requestId: 'request-safe-facts',
        messageId: 'message-safe-facts',
        toolCallCount: 1,
        summary: 'I will inspect the contract.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.queued',
        toolId: 'tool-1',
        toolName: 'other',
        presentation: 'standalone',
        arguments: {},
        summary: 'Inspecting runtime contract.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'tool.started', toolId: 'tool-1', summary: 'Running tool.' },
    });
    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', content: 'Refactor the client.' }),
        expect.objectContaining({ kind: 'text', content: 'I will inspect the contract.' }),
        expect.objectContaining({ kind: 'tool_card', callId: 'tool-1', args: {} }),
      ]),
    );
  });

  test('renders distinct safe tool cards from the Runtime Client contract', () => {
    const events: readonly RuntimeClientEvent[] = [
      {
        type: 'tool.queued',
        toolId: 'tool-read',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: { path: '/private/workspace/secret.ts' },
        summary: 'Queued.',
      },
      {
        type: 'tool.finished',
        toolId: 'tool-read',
        toolName: 'read_file',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'private', stderr: '' },
        summary: 'Completed.',
      },
      {
        type: 'tool.queued',
        toolId: 'tool-search',
        toolName: 'search_content',
        presentation: 'exploration',
        arguments: { query: '[redacted]' },
        summary: 'Queued.',
      },
      {
        type: 'tool.finished',
        toolId: 'tool-search',
        toolName: 'search_content',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'private', stderr: '' },
        summary: 'Completed.',
      },
    ];
    let state = createInitialState();
    for (const event of events) state = eventReducer(state, { type: 'RUNTIME_EVENT', event });

    const toolEntries = state.turns.flatMap((turn) =>
      turn.blocks.flatMap((block) =>
        block.kind === 'tool_card'
          ? [{ callId: block.callId, name: block.name, status: block.status }]
          : block.kind === 'tool_summary'
            ? block.tools.map(({ callId, name, status }) => ({ callId, name, status }))
            : [],
      ),
    );
    expect(toolEntries).toEqual([
      { callId: 'tool-read', name: 'read_file', status: 'done' },
      { callId: 'tool-search', name: 'search_content', status: 'done' },
    ]);
    expect(JSON.stringify(toolEntries)).not.toContain('/private/workspace');
    expect(JSON.stringify(toolEntries)).not.toContain('super-secret');
  });

  test('merges adjacent terminal file searches while retaining bounded local arguments', () => {
    const events: readonly RuntimeClientEvent[] = [
      {
        type: 'tool.queued',
        toolId: 'search-first',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'private-first-pattern', path: '/private/workspace' },
        summary: 'Queued.',
      },
      {
        type: 'tool.finished',
        toolId: 'search-first',
        toolName: 'search_files',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'private', stderr: '' },
        summary: 'Completed.',
      },
      {
        type: 'tool.queued',
        toolId: 'search-second',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'private-second-pattern', path: '/private/workspace' },
        summary: 'Queued.',
      },
      {
        type: 'tool.finished',
        toolId: 'search-second',
        toolName: 'search_files',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'private', stderr: '' },
        summary: 'Completed.',
      },
    ];
    let state = createInitialState();
    for (const event of events) state = eventReducer(state, { type: 'RUNTIME_EVENT', event });

    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter(
        (
          block,
        ): block is Extract<
          (typeof state.turns)[number]['blocks'][number],
          { kind: 'tool_summary' }
        > => block.kind === 'tool_summary',
      );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        summaryLine: 'searched 2 file patterns',
        tools: [
          expect.objectContaining({
            callId: 'search-first',
            name: 'search_files',
            args: { pattern: 'private-first-pattern', path: '/private/workspace' },
          }),
          expect.objectContaining({
            callId: 'search-second',
            name: 'search_files',
            args: { pattern: 'private-second-pattern', path: '/private/workspace' },
          }),
        ],
      }),
    );
  });

  test('keeps queued exploration hidden, then merges parallel starts and terminal events by call id', () => {
    const queue = (toolCallId: string, name: string, args: Record<string, unknown>) =>
      ({
        type: 'tool.queued',
        toolId: toolCallId,
        toolName: name as Extract<RuntimeClientEvent, { type: 'tool.queued' }>['toolName'],
        presentation: 'exploration',
        arguments: args,
        summary: 'Queued.',
      }) satisfies RuntimeClientEvent;
    const started = (toolCallId: string) =>
      ({ type: 'tool.started', toolId: toolCallId }) satisfies RuntimeClientEvent;
    const finished = (toolCallId: string, name: string) =>
      ({
        type: 'tool.finished',
        toolId: toolCallId,
        toolName: name as Extract<RuntimeClientEvent, { type: 'tool.finished' }>['toolName'],
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'private', stderr: '' },
        summary: 'Completed.',
      }) satisfies RuntimeClientEvent;

    let state = createInitialState();
    for (const [toolCallId, name, args] of [
      ['read-1', 'read_file', { path: '/private/one.ts' }],
      ['find-1', 'search_files', { pattern: 'private-first-pattern' }],
      ['read-2', 'read_file', { path: '/private/two.ts' }],
      ['find-2', 'search_files', { pattern: 'private-second-pattern' }],
      ['read-3', 'read_file', { path: '/private/three.ts' }],
    ] as const) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event: queue(toolCallId, name, args) });
    }

    expect(state.turns.flatMap((turn) => turn.blocks)).toHaveLength(0);
    expect(Object.keys(state.pendingToolCalls)).toHaveLength(5);

    for (const [toolCallId, name] of [
      ['read-2', 'read_file'],
      ['find-1', 'search_files'],
      ['read-1', 'read_file'],
      ['read-3', 'read_file'],
      ['find-2', 'search_files'],
    ] as const) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event: started(toolCallId) });
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event: finished(toolCallId, name) });
    }

    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter(
        (
          block,
        ): block is Extract<
          (typeof state.turns)[number]['blocks'][number],
          { kind: 'tool_summary' }
        > => block.kind === 'tool_summary',
      );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        active: true,
        summaryLine: 'read 3 files, searched 2 file patterns',
        tools: expect.arrayContaining([
          expect.objectContaining({
            callId: 'read-1',
            args: { path: '/private/one.ts' },
            status: 'done',
          }),
          expect.objectContaining({
            callId: 'read-2',
            args: { path: '/private/two.ts' },
            status: 'done',
          }),
          expect.objectContaining({
            callId: 'read-3',
            args: { path: '/private/three.ts' },
            status: 'done',
          }),
          expect.objectContaining({
            callId: 'find-1',
            args: { pattern: 'private-first-pattern' },
            status: 'done',
          }),
          expect.objectContaining({
            callId: 'find-2',
            args: { pattern: 'private-second-pattern' },
            status: 'done',
          }),
        ]),
      }),
    );
    expect(
      state.turns.flatMap((turn) => turn.blocks).some((block) => block.kind === 'tool_card'),
    ).toBe(false);
  });

  test('keeps task and subagent tool lifecycles out of generic tool presentation', () => {
    let state = createInitialState();
    for (const event of [
      {
        type: 'tool.queued' as const,
        toolId: 'task-parent',
        toolName: 'task' as const,
        presentation: 'hidden' as const,
        arguments: {},
        summary: 'Queued.',
      },
      { type: 'tool.started' as const, toolId: 'task-parent', summary: 'Running tool.' },
      {
        type: 'tool.finished' as const,
        toolId: 'task-parent',
        toolName: 'task' as const,
        presentation: 'hidden' as const,
        result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
        summary: 'Completed.',
      },
      {
        type: 'tool.queued' as const,
        toolId: 'subagent-tool:child-read',
        toolName: 'read_file' as const,
        presentation: 'hidden' as const,
        arguments: {},
        summary: 'Queued.',
      },
      {
        type: 'tool.started' as const,
        toolId: 'subagent-tool:child-read',
        summary: 'Running tool.',
      },
    ]) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    }

    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([]);
    expect(state.pendingToolCalls).toEqual({});
  });

  test('does not invent a generic card for an unpaired started/cancelled lifecycle', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: { type: 'tool.started', toolId: 'missing-queued', summary: 'Running tool.' },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'tool.cancelled', toolId: 'missing-queued', summary: 'Cancelled.' },
    });

    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([]);
  });

  test('deduplicates a late cumulative text delta after its durable model terminal', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: { type: 'model.requested', requestId: 'request-late-delta' },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.responded',
        requestId: 'request-late-delta',
        messageId: 'message-late-delta',
        toolCallCount: 0,
        summary: 'One final answer.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.text_delta',
        requestId: 'request-late-delta',
        text: 'One final answer.',
      },
    });

    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.kind === 'text' && block.content === 'One final answer.'),
    ).toHaveLength(1);
  });

  test('detaches a pending final caption once when a run terminal wins delivery order', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: { type: 'model.requested', requestId: 'request-terminal-race' },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'reasoning.activity',
        requestId: 'request-terminal-race',
        state: 'completed',
        segmentId: 'reasoning-terminal-race',
        text: 'Finishing the response.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.text_delta',
        requestId: 'request-terminal-race',
        text: 'One raced final answer.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'run.terminal',
        runId: 'run-terminal-race',
        status: 'completed',
        summary: 'One raced final answer.',
      },
    });

    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.kind === 'text' && block.content === 'One raced final answer.'),
    ).toHaveLength(1);
    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .some((block) => block.kind === 'tool_summary' && block.pendingCaption !== undefined),
    ).toBe(false);
  });

  test('binds text-first reasoning and model terminal facts to one answer block', () => {
    const requestId = 'request-text-first';
    const answer = '你好！我是 Kite，可以帮你处理编码任务。';
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId },
      { type: 'model.text_delta', requestId, text: answer },
      {
        type: 'reasoning.activity',
        requestId,
        state: 'completed',
        segmentId: 'reasoning-text-first',
        text: 'Preparing the greeting.',
      },
      {
        type: 'model.responded',
        requestId,
        messageId: 'message-text-first',
        durationMs: 2_000,
        toolCallCount: 0,
        summary: answer,
      },
      {
        type: 'run.terminal',
        runId: 'run-text-first',
        status: 'completed',
        summary: answer,
      },
    ] satisfies RuntimeClientEvent[]) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks.filter((block) => block.kind === 'text' && block.content === answer)).toEqual([
      expect.objectContaining({
        kind: 'text',
        modelRequestId: requestId,
        streaming: false,
        thoughtElapsedMs: 2_000,
        thoughtContent: 'Preparing the greeting.',
      }),
    ]);
    expect(blocks.some((block) => block.kind === 'tool_summary')).toBe(false);
  });

  test('enriches the same answer when responded and reasoning arrive after run terminal', () => {
    const requestId = 'request-terminal-first';
    const answer = 'One terminal-first answer.';
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId },
      { type: 'model.text_delta', requestId, text: answer },
      {
        type: 'run.terminal',
        runId: 'run-terminal-first',
        status: 'completed',
        summary: answer,
      },
      {
        type: 'reasoning.activity',
        requestId,
        state: 'completed',
        segmentId: 'reasoning-terminal-first',
        text: 'Late but correlated reasoning.',
      },
      {
        type: 'model.responded',
        requestId,
        messageId: 'message-terminal-first',
        durationMs: 1_400,
        toolCallCount: 0,
        summary: answer,
      },
    ] satisfies RuntimeClientEvent[]) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks.filter((block) => block.kind === 'text' && block.content === answer)).toEqual([
      expect.objectContaining({
        kind: 'text',
        modelRequestId: requestId,
        thoughtElapsedMs: 1_400,
        thoughtContent: 'Late but correlated reasoning.',
      }),
    ]);
    expect(blocks.some((block) => block.kind === 'tool_summary')).toBe(false);
  });

  test('keeps late reasoning owned by its answer after a later notice block', () => {
    const requestId = 'request-reasoning-after-notice';
    const answer = 'The original answer.';
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId },
      { type: 'model.text_delta', requestId, text: answer },
      {
        type: 'model.responded',
        requestId,
        messageId: 'message-reasoning-after-notice',
        durationMs: 800,
        toolCallCount: 0,
        summary: answer,
      },
      {
        type: 'session.notice',
        code: 'reconnected',
        message: 'Runtime reconnected.',
      },
      {
        type: 'reasoning.activity',
        requestId,
        state: 'completed',
        segmentId: 'reasoning-after-notice',
        text: 'Late correlated reasoning.',
      },
    ] satisfies RuntimeClientEvent[]) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'text',
        content: answer,
        modelRequestId: requestId,
        thoughtContent: 'Late correlated reasoning.',
      }),
      expect.objectContaining({ kind: 'text', content: 'Runtime reconnected.' }),
    ]);
    expect(blocks.some((block) => block.kind === 'tool_summary')).toBe(false);
  });

  test('detaches a pure Thought when content interleaves between reasoning packets', () => {
    const requestId = 'request-reasoning-last';
    const answer = 'One reasoning-last answer.';
    const trailingReasoning = 'Inspecting the curl result before answering.';
    let state = createInitialState();
    const dispatch = (event: RuntimeClientEvent) => {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    };

    for (const event of [
      { type: 'model.requested', requestId },
      {
        type: 'reasoning.activity',
        requestId,
        state: 'streaming',
        segmentId: 'reasoning-last',
        text: 'Inspecting the curl result',
      },
      { type: 'model.text_delta', requestId, text: answer },
    ] satisfies RuntimeClientEvent[]) {
      dispatch(event);
    }

    // The first delta closes the visible Thought immediately, but the
    // incomplete paragraph remains hidden until another component boundary
    // or the terminal response proves it complete.
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: false,
        responsePending: true,
        modelRequestId: requestId,
      }),
    ]);
    expect(state.thoughtPhaseStatus).toBe('awaiting_terminal');

    for (const event of [
      {
        type: 'reasoning.activity',
        requestId,
        state: 'streaming',
        segmentId: 'reasoning-last',
        text: trailingReasoning,
      },
      {
        type: 'reasoning.activity',
        requestId,
        state: 'completed',
        segmentId: 'reasoning-last',
        text: trailingReasoning,
      },
    ] satisfies RuntimeClientEvent[]) {
      dispatch(event);
    }

    // A completed trailing segment enriches the text block off-screen; it
    // cannot recreate the active Thought whose preview would leak the raw
    // reasoning below the visible answer.
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: false,
        responsePending: true,
        modelRequestId: requestId,
      }),
    ]);
    expect(state.turns.flatMap((turn) => turn.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: 'tool_summary', active: true }),
    );

    for (const event of [
      {
        type: 'model.responded',
        requestId,
        messageId: 'message-reasoning-last',
        durationMs: 7_323,
        toolCallCount: 0,
        summary: answer,
      },
      {
        type: 'run.terminal',
        runId: 'run-reasoning-last',
        status: 'completed',
        summary: answer,
      },
    ] satisfies RuntimeClientEvent[]) {
      dispatch(event);
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks.filter((block) => block.kind === 'text' && block.content === answer)).toEqual([
      expect.objectContaining({
        kind: 'text',
        thoughtElapsedMs: 7_323,
        thoughtContent: trailingReasoning,
      }),
    ]);
    expect(blocks.some((block) => block.kind === 'tool_summary')).toBe(false);
    expect(
      blocks.filter((block) => block.kind === 'text' && block.content === answer),
    ).toHaveLength(1);
  });

  test('commits cumulative model text as immutable paragraph components', () => {
    const requestId = 'request-component-commit';
    let state = createInitialState();
    const dispatch = (event: RuntimeClientEvent) => {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    };

    dispatch({ type: 'model.requested', requestId });
    dispatch({ type: 'model.text_delta', requestId, text: 'First paragraph' });
    expect(state.turns.flatMap((turn) => turn.blocks)).toHaveLength(0);

    dispatch({
      type: 'model.text_delta',
      requestId,
      text: 'First paragraph\n\nS',
    });
    let textBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(textBlocks).toEqual([
      expect.objectContaining({
        content: 'First paragraph\n\n',
        streaming: false,
        modelRequestId: requestId,
      }),
    ]);
    const committedFirst = textBlocks[0];

    dispatch({
      type: 'model.text_delta',
      requestId,
      text: 'First paragraph\n\nSecond paragraph\n\nT',
    });
    textBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0]).toBe(committedFirst);
    expect(textBlocks.map((block) => block.content)).toEqual([
      'First paragraph\n\n',
      'Second paragraph\n\n',
    ]);

    dispatch({
      type: 'model.responded',
      requestId,
      messageId: 'message-component-commit',
      toolCallCount: 0,
      summary: 'First paragraph\n\nSecond paragraph\n\nTail.',
    });
    textBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(textBlocks.map((block) => block.content)).toEqual([
      'First paragraph\n\n',
      'Second paragraph\n\n',
      'Tail.',
    ]);
    expect(textBlocks.every((block) => block.streaming !== true)).toBe(true);
  });

  test('keeps one mutable structural component and commits it only when closed', () => {
    const requestId = 'request-structural-commit';
    let state = createInitialState();
    const dispatch = (event: RuntimeClientEvent) => {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    };

    dispatch({ type: 'model.requested', requestId });
    dispatch({
      type: 'model.text_delta',
      requestId,
      text: '```ts\nconst complete = true;\nconst unfinished',
    });
    let textBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(textBlocks).toEqual([
      expect.objectContaining({
        content: '```ts\nconst complete = true;\n',
        streaming: true,
        streamingComponent: 'code',
        streamingSource: '```ts\nconst complete = true;\nconst unfinished',
      }),
    ]);

    dispatch({
      type: 'model.text_delta',
      requestId,
      text: '```ts\nconst complete = true;\nconst unfinished = false;\n```',
    });
    textBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(textBlocks).toEqual([
      expect.objectContaining({
        content: '```ts\nconst complete = true;\nconst unfinished = false;\n```',
        streaming: false,
      }),
    ]);
    expect(textBlocks[0]?.streamingComponent).toBeUndefined();
    expect(textBlocks[0]?.streamingSource).toBeUndefined();
  });

  test('commits streaming lists one complete item at a time', () => {
    const requestId = 'request-list-items';
    let state = createInitialState();
    const dispatch = (event: RuntimeClientEvent) => {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    };
    dispatch({ type: 'model.requested', requestId });
    dispatch({ type: 'model.text_delta', requestId, text: '- first item\n- second' });
    dispatch({
      type: 'model.text_delta',
      requestId,
      text: '- first item\n- second item\n- third',
    });
    dispatch({
      type: 'model.responded',
      requestId,
      messageId: 'message-list-items',
      toolCallCount: 0,
      summary: '- first item\n- second item\n- third item',
    });

    const textBlocks = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(textBlocks.map((block) => block.content)).toEqual([
      '- first item\n',
      '- second item\n',
      '- third item',
    ]);
  });

  test('keeps streamed narration outside Thought when its terminal declares tools', () => {
    const requestId = 'request-content-before-tool-terminal';
    const caption = 'Checking the matching files now.';
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId },
      {
        type: 'reasoning.activity',
        requestId,
        state: 'completed',
        segmentId: 'reasoning-before-tool-terminal',
        text: 'Selecting the next search.',
      },
      { type: 'model.text_delta', requestId, text: 'Checking the matching ' },
      { type: 'model.text_delta', requestId, text: caption },
      {
        type: 'model.responded',
        requestId,
        messageId: 'message-content-before-tool-terminal',
        durationMs: 1_200,
        toolCallCount: 1,
        summary: caption,
      },
      {
        type: 'tool.queued',
        toolId: 'content-before-tool-terminal-search',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'README' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'content-before-tool-terminal-search' },
    ] satisfies RuntimeClientEvent[]) {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: false,
        responsePending: false,
        modelRequestId: requestId,
        tools: [],
      }),
      expect.objectContaining({
        kind: 'text',
        content: caption,
        modelRequestId: requestId,
      }),
      expect.objectContaining({
        kind: 'tool_summary',
        active: true,
        summaryLine: 'searched 1 file pattern',
      }),
    ]);
  });

  test('keeps standalone tools hidden until started, then closes the active Thought before its named card', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'reasoning.activity',
        requestId: 'request-write-reason',
        state: 'streaming',
        segmentId: 'write-reason',
        text: 'Writing.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.queued',
        toolId: 'write-1',
        toolName: 'write_file',
        presentation: 'standalone',
        arguments: { path: 'notes.md', content: 'updated' },
        summary: 'Queued.',
      },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toHaveLength(1);

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'tool.started', toolId: 'write-1', summary: 'Running tool.' },
    });
    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool_summary', active: false }),
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'write-1',
          name: 'write_file',
          args: { path: 'notes.md', content: 'updated' },
          preview: 'notes.md',
        }),
      ]),
    );
    expect(state.pendingToolCalls).toEqual({});
  });

  test('drops an unstarted standalone cancellation without creating a card', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.queued',
        toolId: 'write-cancelled',
        toolName: 'write_file',
        presentation: 'standalone',
        arguments: { path: 'notes.md', content: 'x' },
        summary: 'Queued.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'tool.cancelled', toolId: 'write-cancelled' },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([]);
    expect(state.pendingToolCalls).toEqual({});
  });

  test('drops an approval-rejected tool that never started without inventing a card', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.queued',
        toolId: 'write-rejected',
        toolName: 'write_file',
        presentation: 'standalone',
        arguments: { path: 'notes.md', content: 'x' },
        summary: 'Queued.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.rejected',
        toolId: 'write-rejected',
        summary: 'Tool execution rejected.',
      },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([]);
    expect(state.pendingToolCalls).toEqual({});

    const gapState = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.rejected',
        toolId: 'write-rejected-after-gap',
        summary: 'Tool execution rejected.',
      },
    });
    expect(gapState.turns.flatMap((turn) => turn.blocks)).toEqual([]);
  });

  test('projects a user-cancelled turn identically for live delivery and replay', () => {
    const events = [
      {
        type: 'tool.queued' as const,
        toolId: 'read-running',
        toolName: 'read_file' as const,
        presentation: 'exploration' as const,
        arguments: { path: 'src/running.ts' },
        summary: 'Queued.',
      },
      { type: 'tool.started' as const, toolId: 'read-running' },
      {
        type: 'tool.queued' as const,
        toolId: 'write-running',
        toolName: 'write_file' as const,
        presentation: 'standalone' as const,
        arguments: { path: 'src/write.ts', content: 'x' },
        summary: 'Queued.',
      },
      { type: 'tool.started' as const, toolId: 'write-running' },
      {
        type: 'tool.queued' as const,
        toolId: 'read-never-started',
        toolName: 'read_file' as const,
        presentation: 'exploration' as const,
        arguments: { path: 'src/future.ts' },
        summary: 'Queued.',
      },
      { type: 'tool.cancelled' as const, toolId: 'write-running' },
      {
        type: 'turn.terminal' as const,
        turnId: 'turn-user-cancelled',
        status: 'cancelled' as const,
        cause: 'user' as const,
      },
    ];
    const reduce = () =>
      events.reduce(
        (state, event) => eventReducer(state, { type: 'RUNTIME_EVENT', event }),
        createInitialState(),
      );
    const live = reduce();
    const replay = reduce();
    const visible = (state: typeof live) =>
      state.turns.flatMap((turn) =>
        turn.blocks.map((block) =>
          block.kind === 'tool_card'
            ? {
                kind: block.kind,
                callId: block.callId,
                status: block.status,
                expanded: block.expanded,
              }
            : block.kind === 'tool_summary'
              ? { kind: block.kind, tools: block.tools.map((tool) => [tool.callId, tool.status]) }
              : { kind: block.kind },
        ),
      );

    expect(visible(live)).toEqual(visible(replay));
    expect(live.pendingToolCalls).toEqual({});
    expect(live.running).toBe(false);
    expect(visible(live)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'write-running',
          status: 'cancelled',
          expanded: true,
        }),
        expect.objectContaining({ kind: 'tool_summary', tools: [['read-running', 'cancelled']] }),
      ]),
    );
    expect(JSON.stringify(visible(live))).not.toContain('read-never-started');
  });

  test('updates subagent steps in their owning block without emitting a text fragment', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.started',
        subagentId: 'child-1',
        role: 'explore',
        name: 'Inspect files',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.step',
        subagentId: 'child-1',
        toolName: 'read_file',
        status: 'started',
        arguments: { path: 'src/child.ts' },
        durationMs: 4,
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.step',
        subagentId: 'child-1',
        toolName: 'read_file',
        status: 'completed',
        result: { ok: true },
        totalLines: 42,
        durationMs: 18,
        summary: 'Read complete.',
      },
    });
    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks.filter((block) => block.kind === 'text')).toHaveLength(0);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'subagent',
        toolCallCount: 1,
        steps: [
          expect.objectContaining({
            toolName: 'read_file',
            toolArgs: { path: 'src/child.ts' },
            status: 'success',
            ok: true,
            totalLines: 42,
            durationMs: 18,
            summary: 'Read complete.',
          }),
        ],
      }),
    );
  });

  test('keeps streamed narration between the completed Thought and later exploration', () => {
    const dispatch = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = dispatch(createInitialState(), {
      type: 'reasoning.activity',
      requestId: 'request-1',
      state: 'streaming',
      segmentId: 'reasoning-1',
      text: 'Inspecting',
    });
    const summary = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(summary?.kind === 'tool_summary' ? summary.latestActivity : undefined).toBeUndefined();

    state = dispatch(state, {
      type: 'reasoning.activity',
      requestId: 'request-1',
      state: 'completed',
      segmentId: 'reasoning-1',
      text: 'Inspecting the relevant files.',
    });
    state = dispatch(state, {
      type: 'tool.queued',
      toolId: 'read-1',
      toolName: 'read_file',
      presentation: 'exploration',
      arguments: { path: 'src/one.ts' },
      summary: 'Queued.',
    });
    state = dispatch(state, { type: 'tool.started', toolId: 'read-1' });
    state = dispatch(state, {
      type: 'model.text_delta',
      requestId: 'request-1',
      text: 'I found the first part; checking one more file.',
    });
    state = dispatch(state, {
      type: 'model.responded',
      requestId: 'request-1',
      messageId: 'message-1',
      durationMs: 73,
      toolCallCount: 1,
      summary: 'I found the first part; checking one more file.',
    });
    let blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: false,
        responsePending: false,
        modelRequestId: 'request-1',
        tools: [],
      }),
      expect.objectContaining({
        kind: 'tool_summary',
        active: false,
        tools: [expect.objectContaining({ callId: 'read-1' })],
      }),
      expect.objectContaining({
        kind: 'text',
        content: 'I found the first part; checking one more file.',
        streaming: false,
        modelRequestId: 'request-1',
      }),
    ]);

    state = dispatch(state, {
      type: 'tool.queued',
      toolId: 'read-2',
      toolName: 'read_file',
      presentation: 'exploration',
      arguments: { path: 'src/two.ts' },
      summary: 'Queued.',
    });
    state = dispatch(state, { type: 'tool.started', toolId: 'read-2' });
    state = dispatch(state, {
      type: 'reasoning.activity',
      requestId: 'request-2',
      state: 'streaming',
      segmentId: 'reasoning-2',
      text: 'Comparing',
    });
    state = dispatch(state, {
      type: 'reasoning.activity',
      requestId: 'request-2',
      state: 'completed',
      segmentId: 'reasoning-2',
      text: 'Comparing both files.',
    });
    state = dispatch(state, {
      type: 'model.responded',
      requestId: 'request-2',
      messageId: 'message-2',
      durationMs: 31,
      toolCallCount: 0,
      summary: 'Final answer.',
    });

    blocks = state.turns.flatMap((turn) => turn.blocks);
    const summaries = blocks.filter(
      (
        block,
      ): block is Extract<
        (typeof state.turns)[number]['blocks'][number],
        { kind: 'tool_summary' }
      > => block.kind === 'tool_summary',
    );
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        active: false,
        modelMs: 73,
        tools: [],
      }),
    );
    expect(summaries[1]).toEqual(
      expect.objectContaining({
        active: false,
        tools: [expect.objectContaining({ callId: 'read-1', args: { path: 'src/one.ts' } })],
      }),
    );
    expect(summaries[2]).toEqual(
      expect.objectContaining({
        active: false,
        tools: [expect.objectContaining({ callId: 'read-2', args: { path: 'src/two.ts' } })],
      }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        content: 'Final answer.',
        thoughtContent: 'Comparing both files.',
      }),
    );
    expect(
      blocks.filter(
        (block) =>
          block.kind === 'text' &&
          block.content === 'I found the first part; checking one more file.',
      ),
    ).toHaveLength(1);
    expect(state.currentThoughtSummaryId).toBeUndefined();
  });

  test('settles post-Bash searches before a later model request owns reasoning', () => {
    const dispatch = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = createInitialState();
    const events = [
      {
        type: 'tool.queued',
        toolId: 'bash-1',
        toolName: 'shell_execute',
        presentation: 'standalone',
        arguments: { command: 'git status --short && git log --oneline -3' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'bash-1' },
      {
        type: 'tool.finished',
        toolId: 'bash-1',
        toolName: 'shell_execute',
        presentation: 'standalone',
        result: { ok: false, exitCode: 1, stdout: '', stderr: 'xcrun cache unavailable' },
        summary: 'Failed.',
      },
      { type: 'model.requested', requestId: 'request-search' },
      {
        type: 'model.responded',
        requestId: 'request-search',
        messageId: 'message-search',
        durationMs: 4_000,
        toolCallCount: 2,
      },
      {
        type: 'tool.queued',
        toolId: 'search-1',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'README' },
        summary: 'Queued.',
      },
      {
        type: 'tool.queued',
        toolId: 'search-2',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'AGENTS' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'search-1' },
      { type: 'tool.started', toolId: 'search-2' },
      {
        type: 'tool.finished',
        toolId: 'search-2',
        toolName: 'search_files',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'AGENTS.md', stderr: '' },
        summary: 'Completed.',
      },
      {
        type: 'tool.finished',
        toolId: 'search-1',
        toolName: 'search_files',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'README.md', stderr: '' },
        summary: 'Completed.',
      },
      { type: 'model.requested', requestId: 'request-final' },
      {
        type: 'reasoning.activity',
        requestId: 'request-final',
        state: 'streaming',
        segmentId: 'reasoning-final',
        text: 'Summarizing',
      },
      {
        type: 'reasoning.activity',
        requestId: 'request-final',
        state: 'completed',
        segmentId: 'reasoning-final',
        text: 'Summarizing the project.',
      },
      {
        type: 'model.responded',
        requestId: 'request-final',
        messageId: 'message-final',
        durationMs: 10_000,
        toolCallCount: 0,
        summary: 'Project overview.',
      },
    ] satisfies RuntimeClientEvent[];
    for (const event of events) {
      state = dispatch(state, event);
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    const summaries = blocks.filter(
      (block): block is Extract<(typeof blocks)[number], { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        active: false,
        summaryLine: 'searched 2 file patterns',
        tools: expect.arrayContaining([
          expect.objectContaining({ callId: 'search-1' }),
          expect.objectContaining({ callId: 'search-2' }),
        ]),
      }),
    );
    expect(summaries[0]?.hasThinking).not.toBe(true);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        content: 'Project overview.',
        thoughtElapsedMs: 10_000,
        thoughtContent: 'Summarizing the project.',
      }),
    );
  });

  test('groups exploration tools only through their exact model presentation identity', () => {
    const reduce = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId: 'group-request-1' },
      {
        type: 'model.responded',
        requestId: 'group-request-1',
        messageId: 'group-message-1',
        toolCallCount: 1,
      },
      {
        type: 'tool.queued',
        toolId: 'group-read-1',
        presentationGroupId: 'group-message-1',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: { path: 'README.md' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'group-read-1' },
    ] satisfies RuntimeClientEvent[]) {
      state = reduce(state, event);
    }
    const first = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(first).toEqual(
      expect.objectContaining({ modelRequestId: 'group-request-1', summaryLine: 'read 1 file' }),
    );

    state = reduce(state, { type: 'model.requested', requestId: 'group-request-2' });
    state = reduce(state, {
      type: 'reasoning.activity',
      requestId: 'group-request-2',
      state: 'completed',
      segmentId: 'group-reasoning-2',
      text: 'A distinct step.',
    });
    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.kind === 'tool_summary')
        .map((block) => block.modelRequestId),
    ).toEqual(['group-request-1', 'group-request-2']);
  });

  test('keeps missing and mismatched tool identities outside the active Thought', () => {
    const reduce = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId: 'identity-request-1' },
      {
        type: 'model.responded',
        requestId: 'identity-request-1',
        messageId: 'identity-message-1',
        toolCallCount: 1,
      },
      { type: 'model.requested', requestId: 'identity-request-2' },
      {
        type: 'reasoning.activity',
        requestId: 'identity-request-2',
        state: 'completed',
        segmentId: 'identity-reasoning-2',
        text: 'New reasoning.',
      },
      {
        type: 'tool.queued',
        toolId: 'identity-missing',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: { path: 'README.md' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'identity-missing' },
      {
        type: 'tool.queued',
        toolId: 'identity-mismatch',
        presentationGroupId: 'identity-message-1',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'README' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'identity-mismatch' },
    ] satisfies RuntimeClientEvent[]) {
      state = reduce(state, event);
    }

    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'tool_summary');
    const activeThought = summaries.find((block) => block.modelRequestId === 'identity-request-2');
    expect(activeThought?.tools).toHaveLength(0);
    expect(activeThought?.timeline).toContainEqual(
      expect.objectContaining({ kind: 'thinking', text: 'New reasoning.' }),
    );
    expect(
      summaries
        .filter((block) => block.modelRequestId === undefined)
        .flatMap((block) => block.tools.map((tool) => tool.callId)),
    ).toEqual(['identity-missing', 'identity-mismatch']);
    expect(summaries.filter((block) => block.active)).toHaveLength(1);
  });

  test('keeps late final reasoning with its answer instead of the preceding search step', () => {
    const events = [
      {
        type: 'user.message',
        messageId: 'post-bash-resume-user',
        kind: 'task',
        text: 'Give me a project overview.',
      },
      {
        type: 'model.requested',
        requestId: 'post-bash-resume-searches',
      },
      {
        type: 'model.responded',
        requestId: 'post-bash-resume-searches',
        messageId: 'post-bash-resume-searches-message',
        durationMs: 2_000,
        toolCallCount: 3,
      },
      {
        type: 'tool.queued',
        toolId: 'post-bash-resume-bash',
        toolName: 'shell_execute',
        presentation: 'standalone',
        arguments: { command: 'git status --short' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'post-bash-resume-bash' },
      ...(['CLAUDE.md', 'package.json'] as const).flatMap(
        (pattern, index): RuntimeClientEvent[] => {
          const toolId = `post-bash-resume-search-${index}`;
          return [
            {
              type: 'tool.queued' as const,
              toolId,
              toolName: 'search_files',
              presentation: 'exploration' as const,
              arguments: { pattern },
              summary: 'Queued.',
            },
            { type: 'tool.started' as const, toolId },
            {
              type: 'tool.finished' as const,
              toolId,
              toolName: 'search_files',
              presentation: 'exploration' as const,
              result: { ok: true as const, exitCode: 0, stdout: pattern, stderr: '' },
              summary: 'Completed.',
            },
          ];
        },
      ),
      // The independent Bash terminal arrives after both searches. It owns
      // the earlier standalone card and must not close their aggregate.
      {
        type: 'tool.finished',
        toolId: 'post-bash-resume-bash',
        toolName: 'shell_execute',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
        summary: 'Completed.',
      },
      { type: 'model.requested', requestId: 'post-bash-resume-final' },
      {
        type: 'reasoning.activity',
        requestId: 'post-bash-resume-final',
        state: 'completed',
        segmentId: 'post-bash-resume-final-reasoning',
        text: 'Synthesizing the search results.',
      },
      {
        type: 'model.responded',
        requestId: 'post-bash-resume-final',
        messageId: 'post-bash-resume-final-message',
        durationMs: 14_000,
        toolCallCount: 0,
        summary: 'POST_BASH_RESUME_DONE',
      },
      {
        type: 'run.terminal',
        runId: 'post-bash-resume-run',
        status: 'completed',
        summary: 'POST_BASH_RESUME_DONE',
      },
    ] satisfies RuntimeClientEvent[];
    const reduce = (runtimeEvents: readonly RuntimeClientEvent[], initial = createInitialState()) =>
      runtimeEvents.reduce(
        (state, event) => eventReducer(state, { type: 'RUNTIME_EVENT', event }),
        initial,
      );
    const assertProjection = (blocks: ReturnType<typeof reduce>['turns'][number]['blocks']) => {
      const summaries = blocks.filter(
        (block): block is Extract<(typeof blocks)[number], { kind: 'tool_summary' }> =>
          block.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toEqual(
        expect.objectContaining({
          summaryLine: 'searched 2 file patterns',
        }),
      );
      expect(summaries[0]?.hasThinking).not.toBe(true);
      expect(summaries[0]?.timeline ?? []).not.toContainEqual(
        expect.objectContaining({ kind: 'thinking', text: 'Synthesizing the search results.' }),
      );
      expect(blocks).toContainEqual(
        expect.objectContaining({
          kind: 'text',
          content: 'POST_BASH_RESUME_DONE',
          thoughtElapsedMs: 14_000,
          thoughtContent: 'Synthesizing the search results.',
        }),
      );
    };

    const bashTerminalIndex = events.findIndex(
      (event) => event.type === 'tool.finished' && event.toolId === 'post-bash-resume-bash',
    );
    const afterBashTerminal = reduce(events.slice(0, bashTerminalIndex + 1));
    const activeSearchSummary = afterBashTerminal.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(activeSearchSummary).toEqual(
      expect.objectContaining({ active: true, summaryLine: 'searched 2 file patterns' }),
    );
    expect(afterBashTerminal.currentThoughtSummaryId).toBe(activeSearchSummary?.id);

    assertProjection(reduce(events).turns.flatMap((turn) => turn.blocks));

    const replay = sessionDataToUI({
      threadId: 'post-bash-resume-session',
      messages: [],
      runtimeEvents: events,
      interrupt: null,
      modelProvider: 'test',
      modelName: 'test',
      thinkingLevel: null,
      plan: null,
      interactionMode: 'accept_edits',
    });
    assertProjection(replay.blocks);

    // Durable terminal delivery may still overtake completed reasoning during
    // replay. It must enrich the answer owned by that request, never the prior
    // request's tool summary.
    const reasoningIndex = events.findIndex((event) => event.type === 'reasoning.activity');
    const modelRespondedIndex = events.findIndex(
      (event) => event.type === 'model.responded' && event.requestId === 'post-bash-resume-final',
    );
    const terminalBeforeReasoning = [
      ...events.slice(0, reasoningIndex),
      events[modelRespondedIndex]!,
      events[reasoningIndex]!,
      ...events.slice(modelRespondedIndex + 1),
    ];
    assertProjection(reduce(terminalBeforeReasoning).turns.flatMap((turn) => turn.blocks));
  });

  test('keeps late narration as text before the following tool-bearing summary', () => {
    const dispatch = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    const caption = 'I found the first result; checking the remaining files.';
    let state = createInitialState();
    const events = [
      { type: 'model.requested', requestId: 'request-late-caption' },
      {
        type: 'reasoning.activity',
        requestId: 'request-late-caption',
        state: 'completed',
        segmentId: 'reasoning-late-caption',
        text: 'Inspecting the project.',
      },
      {
        type: 'model.responded',
        requestId: 'request-late-caption',
        messageId: 'message-late-caption',
        durationMs: 14_000,
        toolCallCount: 2,
        summary: caption,
      },
      // The durable response has already declared exploration tools, but
      // their started facts have not reached the Client pump yet. This late
      // narration still belongs to the same active tool-bearing Thought.
      { type: 'model.text_delta', requestId: 'request-late-caption', text: caption },
      {
        type: 'tool.queued',
        toolId: 'late-search-1',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'README' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'late-search-1' },
      {
        type: 'tool.queued',
        toolId: 'late-search-2',
        toolName: 'search_files',
        presentation: 'exploration',
        arguments: { pattern: 'AGENTS' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'late-search-2' },
    ] satisfies RuntimeClientEvent[];
    for (const event of events) {
      state = dispatch(state, event);
    }

    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter(
        (
          block,
        ): block is Extract<
          (typeof state.turns)[number]['blocks'][number],
          { kind: 'tool_summary' }
        > => block.kind === 'tool_summary',
      );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        active: false,
        hasThinking: true,
        modelMs: 14_000,
        tools: [],
      }),
    );
    expect(summaries[1]).toEqual(
      expect.objectContaining({
        active: true,
        hasThought: false,
        summaryLine: 'searched 2 file patterns',
      }),
    );
    expect(summaries[1]!.tools).toHaveLength(2);
    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.kind === 'text' && block.content === caption),
    ).toHaveLength(1);
  });

  test('settles an active Thought at an approval boundary and falls back from a missing terminal queue', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'reasoning.activity',
        requestId: 'request-approval-reason',
        state: 'streaming',
        segmentId: 'approval-reason',
        text: 'Checking.',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'approval.queued',
        queueSequence: 0,
        interaction: {
          kind: 'approval',
          interactionId: 'approval-boundary',
          sessionRevision: 1,
          generation: 0,
          grants: ['approve_once'],
        },
      },
    });
    expect(state.currentThoughtSummaryId).toBeUndefined();
    expect(state.turns.flatMap((turn) => turn.blocks).at(-1)).toEqual(
      expect.objectContaining({ kind: 'tool_summary', active: false }),
    );

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.finished',
        toolId: 'missing-queue',
        toolName: 'write_file',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: 'Wrote notes.md', stderr: '' },
        summary: 'Completed.',
      },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'missing-queue',
          name: 'write_file',
          summary: 'Wrote notes.md',
        }),
      ]),
    );
  });

  test('caches a streaming reasoning segment without exposing it before completion', () => {
    const state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'reasoning.activity',
        requestId: 'request-cached-reason',
        state: 'streaming',
        segmentId: 'cached-reason',
        text: 'Not committed yet.',
      },
    });
    const summary = state.turns.flatMap((turn) => turn.blocks).at(-1);
    expect(summary).toEqual(
      expect.objectContaining({
        kind: 'tool_summary',
        active: true,
        hasThought: true,
        hasThinking: true,
        tools: [],
      }),
    );
    expect(summary?.kind === 'tool_summary' ? summary.latestActivity : undefined).toBeUndefined();
  });

  test('turns closed provider and verification facts into actionable safe interactions', () => {
    let state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'provider.action',
        status: 'required',
        interaction: {
          kind: 'provider_action',
          interactionId: 'provider-1',
          sessionRevision: 3,
          provider: { providerId: 'oauth' },
          action: 'approve',
          title: 'Provider admission required',
        },
      },
    });
    expect(state.interrupt).toEqual(
      expect.objectContaining({ kind: 'input', interactionId: 'provider-1' }),
    );
    expect(state.turns.flatMap((turn) => turn.blocks).at(-1)).toEqual(
      expect.objectContaining({
        kind: 'question',
        question: expect.objectContaining({
          question: "Required MCP provider 'oauth' requires a decision.",
          options: expect.arrayContaining([expect.objectContaining({ label: 'Session Waive' })]),
        }),
      }),
    );

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'interaction.settled',
        interactionId: 'provider-1',
        sessionRevision: 4,
        outcome: 'completed',
      },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'verification.status',
        status: 'pending',
        interaction: {
          kind: 'verification',
          interactionId: 'verification-1',
          sessionRevision: 5,
          verification: { verificationId: 'verification-1', revision: 'revision-1' },
        },
      },
    });
    expect(state.interrupt).toEqual(
      expect.objectContaining({ kind: 'input', interactionId: 'verification-1' }),
    );
  });

  test('preserves approval generation and interaction identity without a raw approval payload', () => {
    const state = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'approval.queued',
        queueSequence: 4,
        interaction: {
          kind: 'approval',
          interactionId: 'approval-1',
          sessionRevision: 8,
          generation: 3,
          grants: ['approve_once'],
        },
      },
    });
    expect(state.interrupt).toEqual(
      expect.objectContaining({ kind: 'approval', interactionId: 'approval-1' }),
    );
    expect(state.pendingApprovals?.get('approval-1')).toEqual(
      expect.objectContaining({ generation: 3, sequence: 4 }),
    );
  });
});
