import { describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/App';
import { eventReducer } from '../src/tui/reducers';
import { sessionDataToUI } from '../src/tui/replay-blocks';
import type { OutputBlock } from '../src/tui/types';

describe('closed RuntimeClientEvent reducer', () => {
  test('shows a local prompt immediately and upgrades only its marked durable echo', () => {
    let state = eventReducer(createInitialState(), { type: 'SET_RUNNING' });
    state = eventReducer(state, { type: 'LOCAL_USER_PROMPT', text: 'Same prompt' });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({ kind: 'user', content: 'Same prompt', pendingEcho: true }),
    ]);

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'user.message',
        messageId: 'message-1',
        kind: 'task',
        text: 'Same prompt',
      },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'Same prompt',
        messageId: 'message-1',
        pendingEcho: undefined,
      }),
    ]);

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'user.message',
        messageId: 'message-2',
        kind: 'task',
        text: 'Same prompt',
      },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toHaveLength(2);
  });

  test('renders an accepted queued prompt once when the receipt arrives before its message', () => {
    let state: ReturnType<typeof createInitialState> = {
      ...createInitialState(),
      activeSessionId: 'session-1',
    };
    state = eventReducer(state, {
      type: 'QUEUE_LOCAL_PROMPT',
      id: 1,
      sessionId: 'session-1',
      text: 'Queued prompt',
    });
    state = eventReducer(state, {
      type: 'ACCEPT_QUEUED_PROMPT',
      id: 1,
      sessionId: 'session-1',
      text: 'Queued prompt',
    });
    expect(state.queuedPrompts).toEqual([]);
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({ kind: 'user', content: 'Queued prompt', pendingEcho: true }),
    ]);

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'user.message',
        messageId: 'queued-message-1',
        kind: 'task',
        text: 'Queued prompt',
      },
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'Queued prompt',
        messageId: 'queued-message-1',
        pendingEcho: undefined,
      }),
    ]);
  });

  test('renders an accepted queued prompt once when its message arrives before the receipt', () => {
    let state: ReturnType<typeof createInitialState> = {
      ...createInitialState(),
      activeSessionId: 'session-1',
    };
    state = eventReducer(state, {
      type: 'QUEUE_LOCAL_PROMPT',
      id: 1,
      sessionId: 'session-1',
      text: 'Queued prompt',
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'user.message',
        messageId: 'queued-message-1',
        kind: 'task',
        text: 'Queued prompt',
      },
    });
    expect(state.queuedPrompts).toEqual([]);

    state = eventReducer(state, {
      type: 'ACCEPT_QUEUED_PROMPT',
      id: 1,
      sessionId: 'session-1',
      text: 'Queued prompt',
    });
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'Queued prompt',
        messageId: 'queued-message-1',
      }),
    ]);
    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .some((block) => block.kind === 'user' && block.pendingEcho === true),
    ).toBe(false);
    expect(state.runPromptPresented).toBe(true);
  });

  test('does not consume an identical queued successor when acknowledging an earlier local echo', () => {
    let state: ReturnType<typeof createInitialState> = {
      ...createInitialState(),
      activeSessionId: 'session-1',
    };
    state = eventReducer(state, { type: 'LOCAL_USER_PROMPT', text: 'Same prompt' });
    state = eventReducer(state, {
      type: 'QUEUE_LOCAL_PROMPT',
      id: 1,
      sessionId: 'session-1',
      text: 'Same prompt',
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'user.message',
        messageId: 'earlier-message',
        kind: 'task',
        text: 'Same prompt',
      },
    });

    expect(state.queuedPrompts).toEqual([{ id: 1, sessionId: 'session-1', text: 'Same prompt' }]);
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'Same prompt',
        messageId: 'earlier-message',
      }),
    ]);
  });

  test('queueing a prompt preserves the active Thought projection by identity', () => {
    const initial = createInitialState();
    const turns = [
      {
        blocks: [
          {
            id: 1,
            kind: 'tool_summary' as const,
            tools: [],
            totalElapsedMs: 2_000,
            createdAt: Date.now() - 2_000,
            summaryLine: '',
            active: true,
            hasThought: true,
            hasThinking: true,
          },
        ],
      },
    ];
    const state = {
      ...initial,
      activeSessionId: 'session-1',
      running: true,
      turns,
      currentThoughtSummaryId: 1,
      thoughtPhaseStatus: 'running' as const,
      currentModelRequestId: 'active-request',
    };

    const queued = eventReducer(state, {
      type: 'QUEUE_LOCAL_PROMPT',
      id: 1,
      sessionId: 'session-1',
      text: 'Queued prompt',
    });

    expect(queued.turns).toBe(turns);
    expect(queued.currentThoughtSummaryId).toBe(1);
    expect(queued.thoughtPhaseStatus).toBe('running');
    expect(queued.currentModelRequestId).toBe('active-request');
  });

  test('removes only an unacknowledged local prompt when submission fails', () => {
    let state = eventReducer(createInitialState(), { type: 'SET_RUNNING' });
    state = eventReducer(state, { type: 'LOCAL_USER_PROMPT', text: 'Not accepted' });
    state = eventReducer(state, { type: 'DROP_LOCAL_USER_PROMPT', text: 'Not accepted' });
    expect(state.turns).toEqual([]);
  });

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

  test('aggregates a proven read-only Shell command into the owning Thought', () => {
    const events: readonly RuntimeClientEvent[] = [
      { type: 'model.requested', requestId: 'request-explore' },
      {
        type: 'reasoning.activity',
        requestId: 'request-explore',
        state: 'completed',
        segmentId: 'reasoning-explore',
        text: 'Inspecting the project.',
      },
      {
        type: 'model.responded',
        requestId: 'request-explore',
        messageId: 'message-explore',
        durationMs: 1_000,
        toolCallCount: 3,
      },
      ...(['read-a', 'read-b'] as const).flatMap((toolId, index): RuntimeClientEvent[] => [
        {
          type: 'tool.queued',
          toolId,
          toolName: 'read_file',
          presentation: 'exploration',
          presentationGroupId: 'message-explore',
          arguments: { path: `file-${index}.ts` },
          summary: 'Queued.',
        },
        { type: 'tool.started', toolId },
        {
          type: 'tool.finished',
          toolId,
          toolName: 'read_file',
          presentation: 'exploration',
          result: { ok: true, exitCode: 0, stdout: 'content', stderr: '' },
          summary: 'Completed.',
        },
      ]),
      {
        type: 'tool.queued',
        toolId: 'shell-read',
        toolName: 'shell_execute',
        presentation: 'exploration',
        presentationGroupId: 'message-explore',
        arguments: { command: 'ls -1 && echo done' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'shell-read' },
      {
        type: 'tool.finished',
        toolId: 'shell-read',
        toolName: 'shell_execute',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: 'src\ndone', stderr: '' },
        summary: 'Completed.',
      },
    ];
    let state = createInitialState();
    for (const event of events) state = eventReducer(state, { type: 'RUNTIME_EVENT', event });

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'tool_summary',
        hasThought: true,
        hasThinking: true,
        modelMs: 1_000,
        summaryLine: 'read 2 files, ran 1 shell command',
        tools: [
          expect.objectContaining({ callId: 'read-a', status: 'done' }),
          expect.objectContaining({ callId: 'read-b', status: 'done' }),
          expect.objectContaining({ callId: 'shell-read', status: 'done' }),
        ],
      }),
    );
    expect(
      blocks.some((block) => block.kind === 'tool_card' && block.callId === 'shell-read'),
    ).toBe(false);
  });

  test('keeps terminal exploration and the following model reasoning in one Thought', () => {
    const events: readonly RuntimeClientEvent[] = [
      { type: 'model.requested', requestId: 'request-tools' },
      {
        type: 'model.responded',
        requestId: 'request-tools',
        messageId: 'message-tools',
        durationMs: 2_000,
        toolCallCount: 3,
      },
      ...(['read-a', 'read-b'] as const).flatMap((toolId, index): RuntimeClientEvent[] => [
        {
          type: 'tool.queued',
          toolId,
          toolName: 'read_file',
          presentation: 'exploration',
          presentationGroupId: 'message-tools',
          arguments: { path: `file-${index}.ts` },
          summary: 'Queued.',
        },
        { type: 'tool.started', toolId },
        {
          type: 'tool.finished',
          toolId,
          toolName: 'read_file',
          presentation: 'exploration',
          result: { ok: true, exitCode: 0, stdout: 'content', stderr: '' },
          summary: 'Completed.',
        },
      ]),
      {
        type: 'tool.queued',
        toolId: 'shell-read',
        toolName: 'shell_execute',
        presentation: 'exploration',
        presentationGroupId: 'message-tools',
        arguments: { command: 'ls -1' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'shell-read' },
      {
        type: 'tool.finished',
        toolId: 'shell-read',
        toolName: 'shell_execute',
        presentation: 'standalone',
        result: { ok: true, exitCode: 0, stdout: 'src', stderr: '' },
        summary: 'Completed.',
      },
      { type: 'model.requested', requestId: 'request-reasoning' },
      {
        type: 'reasoning.activity',
        requestId: 'request-reasoning',
        state: 'completed',
        segmentId: 'reasoning-after-tools',
        text: 'Summarizing the inspected project.',
      },
      {
        type: 'model.text_delta',
        requestId: 'request-reasoning',
        text: 'Project overview.',
      },
      {
        type: 'model.responded',
        requestId: 'request-reasoning',
        messageId: 'message-reasoning',
        durationMs: 12_000,
        toolCallCount: 0,
        summary: 'Project overview.',
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'tool_summary');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        active: false,
        hasThinking: true,
        modelMs: 12_000,
        summaryLine: 'read 2 files, ran 1 shell command',
        timeline: expect.arrayContaining([
          expect.objectContaining({
            kind: 'thinking',
            text: 'Summarizing the inspected project.',
          }),
        ]),
      }),
    );
    const answer = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'text' && block.content === 'Project overview.');
    expect(answer).toBeDefined();
    expect(answer?.kind === 'text' ? answer.thoughtContent : undefined).toBeUndefined();
    expect(answer?.kind === 'text' ? answer.thoughtElapsedMs : undefined).toBeUndefined();
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
    expect(summaries[0]?.result).toBeUndefined();
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

  test('keeps one live pure Thought until an incomplete answer reaches its terminal', () => {
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

    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({ kind: 'tool_summary', active: true, tools: [] }),
    ]);
    expect(state.thoughtPhaseStatus).toBe('running');

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

    // The incomplete answer is still hidden, but the single status-only
    // Thought remains live. Its provider reasoning is never message text.
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({ kind: 'tool_summary', active: true, tools: [] }),
    ]);
    expect(state.turns.flatMap((turn) => turn.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: 'text', content: trailingReasoning }),
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

  test('commits a buffered ordinary paragraph when terminal summary is omitted', () => {
    const requestId = 'request-terminal-without-summary';
    let state = createInitialState();
    const dispatch = (event: RuntimeClientEvent) => {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    };

    dispatch({ type: 'model.requested', requestId });
    dispatch({ type: 'model.text_delta', requestId, text: 'Queued turn completed.' });
    expect(state.turns.flatMap((turn) => turn.blocks)).toHaveLength(0);

    dispatch({
      type: 'model.responded',
      requestId,
      messageId: 'message-terminal-without-summary',
      toolCallCount: 0,
    });

    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'text',
        content: 'Queued turn completed.',
        streaming: false,
        modelRequestId: requestId,
      }),
    ]);
    expect(state.currentModelTextSource).toBeUndefined();
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

  test('keeps a structural answer classification-pending until the model terminal', () => {
    const requestId = 'request-visible-code-freezes-thought';
    let state = createInitialState();
    const dispatch = (event: RuntimeClientEvent) => {
      state = eventReducer(state, { type: 'RUNTIME_EVENT', event });
    };

    dispatch({ type: 'model.requested', requestId });
    dispatch({
      type: 'reasoning.activity',
      requestId,
      state: 'completed',
      segmentId: 'visible-code-reasoning',
      text: 'Preparing the example.',
    });
    dispatch({
      type: 'model.text_delta',
      requestId,
      text: '```ts\nconst visible = true;\nconst pending',
    });

    const visibleSummary = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(visibleSummary).toEqual(
      expect.objectContaining({ active: true, modelRequestId: requestId }),
    );
    expect(
      state.turns
        .flatMap((turn) => turn.blocks)
        .some(
          (block) =>
            block.kind === 'text' &&
            block.streaming === true &&
            block.responsePending === true &&
            block.content === '```ts\nconst visible = true;\n',
        ),
    ).toBe(true);

    dispatch({
      type: 'model.responded',
      requestId,
      messageId: 'message-visible-code-freezes-thought',
      durationMs: 8_000,
      toolCallCount: 0,
      summary: '```ts\nconst visible = true;\nconst pending = false;\n```',
    });

    const answer = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'text');
    expect(answer).toEqual(expect.objectContaining({ thoughtElapsedMs: 8_000 }));
    expect(state.turns.flatMap((turn) => turn.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: 'tool_summary' }),
    );
  });

  test('keeps complete final-response components mutable until the model terminal', () => {
    const events = [
      { type: 'model.requested', requestId: 'freeze-tools-request' },
      {
        type: 'model.responded',
        requestId: 'freeze-tools-request',
        messageId: 'freeze-tools-message',
        durationMs: 4_000,
        toolCallCount: 1,
      },
      {
        type: 'tool.queued',
        toolId: 'freeze-read',
        toolName: 'read_file',
        presentation: 'exploration',
        presentationGroupId: 'freeze-tools-message',
        arguments: { path: 'README.md' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'freeze-read' },
      {
        type: 'tool.finished',
        toolId: 'freeze-read',
        toolName: 'read_file',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'done', stderr: '' },
        summary: 'Completed.',
      },
      { type: 'model.requested', requestId: 'freeze-answer-request' },
      {
        type: 'reasoning.activity',
        requestId: 'freeze-answer-request',
        state: 'completed',
        segmentId: 'freeze-answer-reasoning',
        text: 'Preparing the answer.',
      },
      {
        type: 'model.text_delta',
        requestId: 'freeze-answer-request',
        text: 'Visible answer paragraph.\n\nTail',
      },
    ] satisfies RuntimeClientEvent[];
    const visible = events.reduce(
      (state, event) => eventReducer(state, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const visibleSummary = visible.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(visibleSummary).toEqual(
      expect.objectContaining({
        active: true,
        modelRequestId: 'freeze-answer-request',
      }),
    );
    expect(visibleSummary?.result).toBeUndefined();
    const visibleText = visible.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(visibleText).toEqual([
      expect.objectContaining({
        content: 'Visible answer paragraph.\n\n',
        streaming: false,
        responsePending: true,
      }),
    ]);
    expect(visible.turns.flatMap((turn) => turn.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: 'text', content: expect.stringContaining('Tail') }),
    );

    const terminal = eventReducer(visible, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.responded',
        requestId: 'freeze-answer-request',
        messageId: 'freeze-answer-message',
        durationMs: 15_000,
        toolCallCount: 0,
        summary: 'Visible answer paragraph.\n\nTail complete.',
      },
    });
    const terminalSummary = terminal.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(terminalSummary).toEqual(
      expect.objectContaining({ responsePending: false, result: 'done' }),
    );
    expect(terminalSummary?.pendingCaption).toBeUndefined();
    const terminalText = terminal.turns
      .flatMap((turn) => turn.blocks)
      .filter((block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text');
    expect(terminalText.map((block) => block.content).join('')).toBe(
      'Visible answer paragraph.\n\nTail complete.',
    );
    expect(terminalText.every((block) => block.responsePending !== true)).toBe(true);

    const completed = eventReducer(terminal, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'run.terminal',
        runId: 'freeze-answer-run',
        status: 'completed',
        summary: 'Visible answer paragraph.\n\nTail complete.',
        outcome: {
          status: 'completed',
          reasonCode: 'completed',
          safeRetry: false,
          recoveryEntry: 'none',
        },
      },
    });
    const completedText = completed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text');
    expect(completedText.map((block) => block.content).join('')).toBe(
      'Visible answer paragraph.\n\nTail complete.',
    );
  });

  test('removes classification-pending progress and continues one tool-bearing Thought', () => {
    const events = [
      { type: 'model.requested', requestId: 'rollback-tools-request' },
      {
        type: 'model.responded',
        requestId: 'rollback-tools-request',
        messageId: 'rollback-tools-message',
        durationMs: 4_000,
        toolCallCount: 1,
      },
      {
        type: 'tool.queued',
        toolId: 'rollback-read',
        toolName: 'read_file',
        presentation: 'exploration',
        presentationGroupId: 'rollback-tools-message',
        arguments: { path: 'README.md' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'rollback-read' },
      {
        type: 'tool.finished',
        toolId: 'rollback-read',
        toolName: 'read_file',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: 'done', stderr: '' },
        summary: 'Completed.',
      },
      { type: 'model.requested', requestId: 'rollback-narration-request' },
      {
        type: 'reasoning.activity',
        requestId: 'rollback-narration-request',
        state: 'completed',
        segmentId: 'rollback-narration-reasoning',
        text: 'Choosing another file.',
      },
      {
        type: 'model.text_delta',
        requestId: 'rollback-narration-request',
        text: 'I will inspect one more file.\n\nNext step',
      },
    ] satisfies RuntimeClientEvent[];
    const pending = events.reduce(
      (state, event) => eventReducer(state, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const pendingSummary = pending.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(pendingSummary).toEqual(
      expect.objectContaining({
        active: true,
        modelRequestId: 'rollback-narration-request',
      }),
    );
    const pendingText = pending.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'text');
    expect(pendingText).toEqual([
      expect.objectContaining({
        content: 'I will inspect one more file.\n\n',
        streaming: false,
        responsePending: true,
      }),
    ]);

    let toolBearing = eventReducer(pending, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.responded',
        requestId: 'rollback-narration-request',
        messageId: 'rollback-narration-message',
        durationMs: 7_000,
        toolCallCount: 1,
        summary: 'I will inspect one more file.\n\nNext step',
      },
    });
    toolBearing = eventReducer(toolBearing, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.queued',
        toolId: 'rollback-search',
        toolName: 'search_files',
        presentation: 'exploration',
        presentationGroupId: 'rollback-narration-message',
        arguments: { pattern: 'package.json' },
        summary: 'Queued.',
      },
    });
    toolBearing = eventReducer(toolBearing, {
      type: 'RUNTIME_EVENT',
      event: { type: 'tool.started', toolId: 'rollback-search' },
    });
    const blocks = toolBearing.turns.flatMap((turn) => turn.blocks);
    const summaries = blocks.filter((block) => block.kind === 'tool_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        id: pendingSummary?.id,
        active: true,
        tools: [
          expect.objectContaining({ callId: 'rollback-read', status: 'done' }),
          expect.objectContaining({ callId: 'rollback-search', status: 'running' }),
        ],
      }),
    );
    expect(blocks.filter((block) => block.kind === 'text')).toEqual([]);
    expect(blocks.map((block) => block.kind)).toEqual(['tool_summary']);
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

  test('keeps streamed narration separate when the tool lacks presentation identity', () => {
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
        kind: 'text',
        content: caption,
        modelRequestId: requestId,
        thoughtContent: 'Selecting the next search.',
        thoughtElapsedMs: 1_200,
      }),
      expect.objectContaining({
        kind: 'tool_summary',
        active: true,
        hasThought: false,
        summaryLine: 'searched 1 file pattern',
        tools: [expect.objectContaining({ callId: 'content-before-tool-terminal-search' })],
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
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({ kind: 'tool_summary', active: true, tools: [] }),
    ]);

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

  test('retains an unstarted rejection as a terminal diagnostic without claiming execution', () => {
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
    expect(state.turns.flatMap((turn) => turn.blocks)).toContainEqual(
      expect.objectContaining({
        kind: 'tool_card',
        callId: 'write-rejected',
        name: 'write_file',
        status: 'rejected',
        summary: 'Tool execution rejected.',
      }),
    );
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

  test('retains authoritative subagent duration, count, and bounded failure diagnostics', () => {
    let completed = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.started',
        subagentId: 'completed-child',
        role: 'explore',
        name: 'Inspect runtime',
      },
    });
    const started = completed.turns[0]?.blocks[0];
    expect(typeof (started?.kind === 'subagent' ? started.startedAt : undefined)).toBe('number');
    completed = eventReducer(completed, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.completed',
        subagentId: 'completed-child',
        summary: 'Inspection complete.',
        toolCallCount: 3,
        durationMs: 12_345,
      },
    });
    expect(completed.turns[0]?.blocks[0]).toEqual(
      expect.objectContaining({
        kind: 'subagent',
        status: 'done',
        toolCallCount: 3,
        durationMs: 12_345,
      }),
    );

    let failed = eventReducer(createInitialState(), {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.started',
        subagentId: 'failed-child',
        role: 'review',
        name: 'Review runtime',
      },
    });
    failed = eventReducer(failed, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'subagent.failed',
        subagentId: 'failed-child',
        summary: 'Model step failed.',
        toolCallCount: 2,
        durationMs: 9_000,
        diagnostic: { code: 'model_step_failed', stage: 'model_step' },
      },
    });
    expect(failed.turns[0]?.blocks[0]).toEqual(
      expect.objectContaining({
        kind: 'subagent',
        status: 'error',
        toolCallCount: 2,
        durationMs: 9_000,
        failureDiagnostic: { code: 'model_step_failed', stage: 'model_step' },
      }),
    );
  });

  test('keeps boundary text and concurrent subagents on unique block ids', () => {
    const dispatch = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = dispatch(createInitialState(), {
      type: 'model.requested',
      requestId: 'delegate-request',
    });
    state = dispatch(state, {
      type: 'reasoning.activity',
      requestId: 'delegate-request',
      state: 'completed',
      segmentId: 'delegate-reasoning',
      text: 'Choosing independent areas.',
    });
    state = dispatch(state, {
      type: 'model.responded',
      requestId: 'delegate-request',
      messageId: 'delegate-message',
      toolCallCount: 2,
      summary: 'I will delegate two independent inspections.',
    });
    for (const [subagentId, name] of [
      ['delegate-child-1', 'Inspect the runtime'],
      ['delegate-child-2', 'Inspect the tests'],
    ] as const) {
      state = dispatch(state, {
        type: 'subagent.started',
        subagentId,
        role: 'explore',
        name,
        concurrencyGroupId: 'delegate-batch',
      });
    }

    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    expect(blocks.filter((block) => block.kind === 'text')).toEqual([
      expect.objectContaining({ content: 'I will delegate two independent inspections.' }),
    ]);
    expect(blocks.filter((block) => block.kind === 'subagent')).toEqual([
      expect.objectContaining({
        subagentId: 'delegate-child-1',
        concurrencyGroupId: 'delegate-batch',
      }),
      expect.objectContaining({
        subagentId: 'delegate-child-2',
        concurrencyGroupId: 'delegate-batch',
      }),
    ]);
  });

  test('keeps incomplete tool-bearing narration inside the active Thought', () => {
    const dispatch = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = dispatch(createInitialState(), {
      type: 'model.requested',
      requestId: 'request-1',
    });
    state = dispatch(state, {
      type: 'reasoning.activity',
      requestId: 'request-1',
      state: 'streaming',
      segmentId: 'reasoning-1',
      text: 'Inspecting',
    });
    const summary = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(summary).toEqual(
      expect.objectContaining({
        kind: 'tool_summary',
        active: true,
        hasThinking: true,
      }),
    );
    expect(summary?.latestActivity).toBeUndefined();

    state = dispatch(state, {
      type: 'reasoning.activity',
      requestId: 'request-1',
      state: 'completed',
      segmentId: 'reasoning-1',
      text: 'Inspecting the relevant files.',
    });
    const completedReasoningSummary = state.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool_summary');
    expect(completedReasoningSummary?.latestActivity).toEqual({
      kind: 'thinking',
      text: 'Inspecting the relevant files.',
    });
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
        active: true,
        modelRequestId: 'request-1',
        pendingCaption: 'I found the first part; checking one more file.',
        tools: [],
      }),
    ]);

    state = dispatch(state, {
      type: 'tool.queued',
      toolId: 'read-1',
      presentationGroupId: 'message-1',
      toolName: 'read_file',
      presentation: 'exploration',
      arguments: { path: 'src/one.ts' },
      summary: 'Queued.',
    });
    state = dispatch(state, { type: 'tool.started', toolId: 'read-1' });
    blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: true,
        captions: ['I found the first part; checking one more file.'],
        tools: [expect.objectContaining({ callId: 'read-1' })],
      }),
    ]);
  });

  test('publishes the aggregate result when the last tool settles after a soft close', () => {
    const dispatch = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = dispatch(createInitialState(), {
      type: 'model.requested',
      requestId: 'soft-close-request',
    });
    state = dispatch(state, {
      type: 'model.responded',
      requestId: 'soft-close-request',
      messageId: 'soft-close-message',
      toolCallCount: 1,
    });
    state = dispatch(state, {
      type: 'tool.queued',
      toolId: 'soft-close-read',
      presentationGroupId: 'soft-close-message',
      toolName: 'read_file',
      presentation: 'exploration',
      arguments: { path: 'README.md' },
      summary: 'Queued.',
    });
    state = dispatch(state, { type: 'tool.started', toolId: 'soft-close-read' });
    state = dispatch(state, {
      type: 'tool.queued',
      toolId: 'soft-close-write',
      toolName: 'write_file',
      presentation: 'standalone',
      arguments: { path: 'notes.md', content: 'done' },
      summary: 'Queued.',
    });
    state = dispatch(state, { type: 'tool.started', toolId: 'soft-close-write' });

    let summary = state.turns
      .flatMap((turn) => turn.blocks)
      .find(
        (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
          block.kind === 'tool_summary',
      );
    expect(summary).toEqual(expect.objectContaining({ active: false, tools: [expect.anything()] }));
    expect(summary?.result).toBeUndefined();

    state = dispatch(state, {
      type: 'tool.finished',
      toolId: 'soft-close-read',
      toolName: 'read_file',
      presentation: 'exploration',
      result: { ok: true, exitCode: 0, stdout: '# README', stderr: '' },
      summary: 'Read complete.',
    });
    summary = state.turns
      .flatMap((turn) => turn.blocks)
      .find(
        (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
          block.kind === 'tool_summary',
      );
    expect(summary).toEqual(
      expect.objectContaining({ active: false, result: 'done', tools: [expect.anything()] }),
    );
  });

  test('continues terminal exploration into the following model reasoning', () => {
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
    expect(summaries[0]?.hasThinking).toBe(true);
    expect(summaries[0]?.timeline).toContainEqual(
      expect.objectContaining({ kind: 'thinking', text: 'Summarizing the project.' }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        content: 'Project overview.',
      }),
    );
  });

  test('keeps one exploration phase across adjacent model presentation identities', () => {
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
    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.kind === 'tool_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        modelRequestId: 'group-request-2',
        summaryLine: 'read 1 file',
        tools: [expect.objectContaining({ callId: 'group-read-1', status: 'running' })],
        timeline: expect.arrayContaining([
          expect.objectContaining({ kind: 'thinking', text: 'A distinct step.' }),
        ]),
      }),
    );
  });

  test('keeps terminal exploration when next reasoning overtakes model.requested', () => {
    const reduce = (state: ReturnType<typeof createInitialState>, event: RuntimeClientEvent) =>
      eventReducer(state, { type: 'RUNTIME_EVENT', event });
    let state = createInitialState();
    for (const event of [
      { type: 'model.requested', requestId: 'race-request-1' },
      {
        type: 'reasoning.activity',
        requestId: 'race-request-1',
        state: 'completed',
        segmentId: 'race-reasoning-1',
        text: 'Inspect the project entry points.',
      },
      {
        type: 'model.responded',
        requestId: 'race-request-1',
        messageId: 'race-message-1',
        durationMs: 2_000,
        toolCallCount: 1,
        summary: '先查看项目入口。',
      },
      {
        type: 'tool.queued',
        toolId: 'race-read-1',
        presentationGroupId: 'race-message-1',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: { path: 'README.md' },
        summary: 'Queued.',
      },
      { type: 'tool.started', toolId: 'race-read-1' },
      {
        type: 'tool.finished',
        toolId: 'race-read-1',
        toolName: 'read_file',
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: '# Project', stderr: '' },
        summary: 'Completed.',
      },
    ] satisfies RuntimeClientEvent[]) {
      state = reduce(state, event);
    }

    const original = state.turns
      .flatMap((turn) => turn.blocks)
      .find(
        (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
          block.kind === 'tool_summary',
      );
    expect(original).toEqual(expect.objectContaining({ active: true, summaryLine: 'read 1 file' }));

    // The ephemeral lane can overtake the durable requested notification.
    state = reduce(state, {
      type: 'reasoning.activity',
      requestId: 'race-request-2',
      state: 'completed',
      segmentId: 'race-reasoning-2',
      text: 'Continue with the package structure.',
    });
    state = reduce(state, { type: 'model.requested', requestId: 'race-request-2' });

    const summaries = state.turns
      .flatMap((turn) => turn.blocks)
      .filter(
        (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
          block.kind === 'tool_summary',
      );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        id: original?.id,
        active: true,
        modelRequestId: 'race-request-2',
        summaryLine: 'read 1 file',
        latestActivity: {
          kind: 'thinking',
          text: 'Continue with the package structure.',
        },
      }),
    );
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
    expect(activeThought).toEqual(
      expect.objectContaining({ active: false, hasThinking: true, tools: [] }),
    );
    expect(
      summaries
        .filter((block) => block.modelRequestId === undefined)
        .flatMap((block) => block.tools.map((tool) => tool.callId)),
    ).toEqual(['identity-missing', 'identity-mismatch']);
    expect(summaries.filter((block) => block.active)).toHaveLength(1);
  });

  test('keeps adjacent final reasoning with the preceding terminal exploration step', () => {
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
      expect(summaries[0]?.hasThinking).toBe(true);
      expect(summaries[0]?.timeline ?? []).toContainEqual(
        expect.objectContaining({ kind: 'thinking', text: 'Synthesizing the search results.' }),
      );
      expect(blocks).toContainEqual(
        expect.objectContaining({
          kind: 'text',
          content: 'POST_BASH_RESUME_DONE',
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
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        active: true,
        hasThought: false,
        summaryLine: 'searched 2 file patterns',
      }),
    );
    expect(summaries[0]!.tools).toHaveLength(2);
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

  test('consumes reasoning once across repeated approval and standalone-tool boundaries', () => {
    const approval = (interactionId: string, sessionRevision: number) =>
      ({
        type: 'approval.queued',
        queueSequence: sessionRevision,
        interaction: {
          kind: 'approval',
          interactionId,
          sessionRevision,
          generation: 0,
          grants: ['approve_once'],
        },
      }) satisfies RuntimeClientEvent;
    const events = [
      { type: 'model.requested', requestId: 'approval-batch-request' },
      {
        type: 'reasoning.activity',
        requestId: 'approval-batch-request',
        state: 'completed',
        segmentId: 'approval-batch-reasoning',
        text: 'Inspecting two independent commands.',
      },
      {
        type: 'model.text_delta',
        requestId: 'approval-batch-request',
        text: 'I checked the repository; next I will run two commands.',
      },
      {
        type: 'model.responded',
        requestId: 'approval-batch-request',
        messageId: 'approval-batch-message',
        durationMs: 4_012,
        toolCallCount: 2,
        summary: 'I checked the repository; next I will run two commands.',
      },
      ...(['approval-shell-1', 'approval-shell-2'] as const).map(
        (toolId) =>
          ({
            type: 'tool.queued',
            toolId,
            presentationGroupId: 'approval-batch-message',
            toolName: 'shell_execute',
            presentation: 'standalone',
            arguments: { command: 'git status --short' },
            summary: 'Queued.',
          }) satisfies RuntimeClientEvent,
      ),
      approval('approval-boundary-1', 1),
      {
        type: 'approval.granted',
        interactionId: 'approval-boundary-1',
        generation: 0,
      },
      { type: 'tool.started', toolId: 'approval-shell-1' },
      approval('approval-boundary-2', 2),
    ] satisfies RuntimeClientEvent[];

    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const blocks = state.turns.flatMap((turn) => turn.blocks);
    expect(blocks.filter((block) => block.kind === 'tool_summary')).toEqual([]);
    expect(blocks.filter((block) => block.kind === 'text')).toEqual([
      expect.objectContaining({
        content: 'I checked the repository; next I will run two commands.',
        thoughtContent: 'Inspecting two independent commands.',
        thoughtElapsedMs: 4_012,
      }),
    ]);
    expect(blocks.filter((block) => block.kind === 'tool_card')).toEqual([
      expect.objectContaining({ callId: 'approval-shell-1', status: 'running' }),
    ]);
    expect(state.currentModelReasoningRequestId).toBeUndefined();
    expect(state.currentModelReasoningText).toBeUndefined();
  });

  test('projects a live Thinking owner without exposing its reasoning as message text', () => {
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
    expect(state.turns.flatMap((turn) => turn.blocks)).toEqual([
      expect.objectContaining({
        kind: 'tool_summary',
        active: true,
        hasThinking: true,
        tools: [],
      }),
    ]);
    expect(state.currentModelReasoningText).toBe('Not committed yet.');
    expect(state.currentModelReasoningStreamed).toBe(true);
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
