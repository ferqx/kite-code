import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import OutputArea, { useStaticContent } from '../src/tui/OutputArea';
import { projectOutputBlockTimelineItem } from '../src/tui/presentation/timeline';
import { deriveToolSummaryResult } from '../src/tui/reducers/tool-summary-result';
import { getDarkTheme, ThemeContext } from '../src/tui/theme';
import type { OutputBlock } from '../src/tui/types';

type ToolStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout' | 'exhausted';

const isBlockSettledInRun = (block: OutputBlock): boolean =>
  projectOutputBlockTimelineItem(block).state === 'sealed';

function textBlock(
  id: number,
  content: string,
  extra: Partial<Extract<OutputBlock, { kind: 'text' }>> = {},
): OutputBlock {
  return {
    id,
    kind: 'text',
    content,
    streaming: false,
    presentationState: extra.presentationState ?? (extra.streaming ? 'live' : 'sealed'),
    ...extra,
  };
}
function toolBlock(id: number, status: ToolStatus): OutputBlock {
  return {
    id,
    kind: 'tool_card',
    callId: `c${id}`,
    name: 'write_file',
    args: { path: '/tmp/x.txt' },
    status,
    presentationState: ['done', 'error', 'cancelled', 'timeout', 'exhausted'].includes(status)
      ? 'sealed'
      : 'live',
    summary: status === 'done' ? 'Wrote /tmp/x.txt' : '',
  } as OutputBlock;
}

function subagentBlock(
  id: number,
  status: Extract<OutputBlock, { kind: 'subagent' }>['status'],
  concurrencyGroupId?: string,
): Extract<OutputBlock, { kind: 'subagent' }> {
  return {
    id,
    kind: 'subagent',
    subagentId: `s${id}`,
    role: 'explore',
    task: `task ${id}`,
    status,
    presentationState:
      concurrencyGroupId == null &&
      (status === 'done' || status === 'error' || status === 'cancelled')
        ? 'sealed'
        : 'live',
    summary: '',
    toolCallCount: 0,
    durationMs: 10,
    steps: [],
    ...(concurrencyGroupId != null ? { concurrencyGroupId } : {}),
  };
}

function renderArea(staticBlocks: OutputBlock[], dynamicBlocks: OutputBlock[]) {
  return render(
    React.createElement(
      ThemeContext.Provider,
      { value: getDarkTheme('blue') },
      React.createElement(OutputArea, {
        staticItems: [{ __header: true }, ...staticBlocks],
        staticKey: 's-1',
        staticHeader: React.createElement(Text, null, 'HEADER'),
        mergedStaticBlocks: staticBlocks,
        activeDynamicBlocks: dynamicBlocks,
        onToggleReason: () => {},
        onToggleToolExpand: () => {},
        onToggleSubagentExpand: () => {},
        overlayActive: false,
        awaitingApproval: false,
        awaitingInput: false,
        columns: 100,
      }),
    ),
  );
}

function PromotionHarness({ blocks }: { blocks: OutputBlock[] }) {
  const projection = useStaticContent({
    turns: [{ blocks }],
    running: true,
    sessionKey: 1,
    header: React.createElement(Text, null, 'HEADER'),
  });
  return React.createElement(OutputArea, {
    ...projection,
    onToggleReason: () => {},
    onToggleSubagentExpand: () => {},
    columns: 100,
  });
}

function SplitHarness({ blocks, running }: { blocks: OutputBlock[]; running: boolean }) {
  const projection = useStaticContent({
    turns: [{ blocks }],
    running,
    sessionKey: 2,
    header: React.createElement(Text, null, 'HEADER'),
  });
  return React.createElement(
    Text,
    null,
    `static:${projection.mergedStaticBlocks.map((block) => block.id).join(',')};dynamic:${projection.activeDynamicBlocks.map((block) => block.id).join(',')}`,
  );
}

function TurnSplitHarness({
  turns,
  running,
}: {
  turns: Array<{ blocks: OutputBlock[] }>;
  running: boolean;
}) {
  const projection = useStaticContent({
    turns,
    running,
    sessionKey: 3,
    header: React.createElement(Text, null, 'HEADER'),
  });
  return React.createElement(
    Text,
    null,
    `static:${projection.mergedStaticBlocks.map((block) => block.id).join(',')};dynamic:${projection.activeDynamicBlocks.map((block) => block.id).join(',')}`,
  );
}

describe('deriveToolSummaryResult', () => {
  const entry = (
    callId: string,
    status: ToolStatus,
  ): Extract<OutputBlock, { kind: 'tool_summary' }>['tools'][number] => ({
    callId,
    name: 'read_file',
    args: { path: `${callId}.md` },
    ok: status === 'done',
    status,
    summary: status,
  });

  test('waits for a non-empty aggregate to become fully terminal', () => {
    expect(deriveToolSummaryResult([])).toBeUndefined();
    expect(deriveToolSummaryResult([entry('failed', 'error'), entry('live', 'running')])).toBe(
      undefined,
    );
  });

  test('reduces the final aggregate outcome only after every child is terminal', () => {
    expect(deriveToolSummaryResult([entry('done', 'done')])).toBe('done');
    expect(deriveToolSummaryResult([entry('failed', 'error'), entry('done', 'done')])).toBe(
      'error',
    );
    expect(deriveToolSummaryResult([entry('cancelled', 'cancelled'), entry('done', 'done')])).toBe(
      'cancelled',
    );
  });
});

describe('isBlockSettledInRun', () => {
  test('settles a finished non-exploration tool card', () => {
    const blocks = [toolBlock(1, 'done') as OutputBlock, textBlock(2, 'answer')];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(true);
  });

  test('settles a terminal standalone Shell card', () => {
    const shell: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'shell-1',
      name: 'shell_execute',
      args: { intent: 'inspect', command: 'rg pattern src' },
      status: 'done',
      presentationState: 'sealed',
      summary: 'Completed.',
    };
    expect(isBlockSettledInRun(shell)).toBe(true);
  });

  test('fails closed when a block has no projector lifecycle marker', () => {
    const unmarked = {
      id: 1,
      kind: 'tool_card' as const,
      callId: 'unmarked-tool',
      name: 'shell_execute',
      args: { command: 'echo done' },
      status: 'done' as const,
      summary: 'Completed.',
    } satisfies OutputBlock;
    expect(isBlockSettledInRun(unmarked)).toBe(false);
  });

  test('running tool card is NOT settled', () => {
    const blocks = [toolBlock(1, 'running') as OutputBlock];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);
  });

  test('queued tool card is NOT settled', () => {
    const blocks = [toolBlock(1, 'queued') as OutputBlock];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);
  });

  test('streaming text is NOT settled', () => {
    const blocks = [textBlock(1, 'partial', { streaming: true })];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);
  });

  test('completed ordinary text is settled immediately', () => {
    const blocks = [textBlock(1, 'done'), toolBlock(2, 'done') as OutputBlock];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(true);
  });

  test('the last terminal text component is settled', () => {
    const blocks = [textBlock(1, 'a'), textBlock(2, 'b')];
    expect(isBlockSettledInRun(blocks[1]!)).toBe(true);
  });

  test('promotes terminal components while retaining only the mutable structural tail', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'long answer', presentationState: 'sealed' },
      ...Array.from({ length: 100 }, (_, index) => textBlock(index + 2, `paragraph ${index}\n\n`)),
      textBlock(102, '```ts\nconst partial = true;\n', {
        streaming: true,
        streamingComponent: 'code',
        streamingSource: '```ts\nconst partial = true;\nconst unfinished',
      }),
    ];
    let split = 0;
    while (split < blocks.length && isBlockSettledInRun(blocks[split]!)) {
      split += 1;
    }

    expect(blocks.slice(0, split)).toHaveLength(101);
    expect(blocks.slice(split).map((block) => block.id)).toEqual([102]);
  });

  test('a newly submitted user block stays dynamic until a following block arrives', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'hi', presentationState: 'live' },
    ];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);

    const withResponse = [
      { ...blocks[0]!, presentationState: 'sealed' as const },
      textBlock(2, 'answer'),
    ];
    expect(isBlockSettledInRun(withResponse[0]!)).toBe(true);
  });

  test('settles a completed subagent so it cannot pin later answer text', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'subagent',
        subagentId: 's1',
        role: 'explore',
        task: 't',
        status: 'done',
        presentationState: 'sealed',
        summary: '',
        toolCallCount: 1,
        durationMs: 5,
        steps: [],
      },
      ...Array.from({ length: 100 }, (_, index) => textBlock(index + 2, `paragraph ${index}`)),
    ];
    let split = 0;
    while (split < blocks.length && isBlockSettledInRun(blocks[split]!)) {
      split += 1;
    }
    expect(split).toBe(blocks.length);
  });

  test('holds an early concurrent child out of Static until every sibling settles', () => {
    const blocks: OutputBlock[] = [
      subagentBlock(1, 'done', 'batch-1'),
      subagentBlock(2, 'running', 'batch-1'),
      subagentBlock(3, 'done', 'batch-1'),
    ];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);

    const settled = blocks.map((block) =>
      block.kind === 'subagent'
        ? { ...block, status: 'done' as const, presentationState: 'sealed' as const }
        : block,
    );
    expect(isBlockSettledInRun(settled[0]!)).toBe(true);
    expect(isBlockSettledInRun(settled[1]!)).toBe(true);
    expect(isBlockSettledInRun(settled[2]!)).toBe(true);
  });

  test('settles a resolved approval so it cannot pin later answer text', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'approval',
        approval: {
          scope: 'once',
          cwd: '/tmp',
          threadId: 'thread-1',
          tool: 'shell_execute',
          command: 'echo ok',
          risk: 'execute_code',
          approvalHash: 'approval-1',
          summary: 'Run command',
          reason: 'test',
          expectedEffects: ['prints output'],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
        resolved: { action: 'approved' },
        presentationState: 'sealed',
      },
      ...Array.from({ length: 100 }, (_, index) => textBlock(index + 2, `paragraph ${index}`)),
    ];
    let split = 0;
    while (split < blocks.length && isBlockSettledInRun(blocks[split]!)) {
      split += 1;
    }
    expect(split).toBe(blocks.length);
  });

  test('settles resolved questions and inert presentation-only blocks', () => {
    const reason: OutputBlock = {
      id: 1,
      kind: 'reason',
      content: 'hidden',
      folded: true,
      presentationState: 'sealed',
    };
    const fileChange: OutputBlock = {
      id: 2,
      kind: 'file_change',
      changes: [],
      presentationState: 'sealed',
    };
    const question: OutputBlock = {
      id: 3,
      kind: 'question',
      question: { question: 'Continue?', options: [], allow_free_text: true },
      resolved: 'yes',
      presentationState: 'sealed',
    };
    expect(isBlockSettledInRun(reason)).toBe(true);
    expect(isBlockSettledInRun(fileChange)).toBe(true);
    expect(isBlockSettledInRun(question)).toBe(true);
    expect(
      isBlockSettledInRun({ ...question, resolved: undefined, presentationState: 'live' }),
    ).toBe(false);
  });

  test('active tool_summary is NOT settled', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_summary',
        tools: [],
        totalElapsedMs: 5,
        createdAt: 1,
        summaryLine: 'x',
        active: true,
        hasThought: false,
        presentationState: 'live',
      },
    ];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);
  });

  test('an active aggregate never enters Static even if it carries a stale result', () => {
    const summary: Extract<OutputBlock, { kind: 'tool_summary' }> = {
      id: 1,
      kind: 'tool_summary',
      tools: [
        {
          callId: 'read-1',
          name: 'read_file',
          args: { path: 'README.md' },
          ok: true,
          status: 'done',
          summary: 'Read complete.',
        },
      ],
      totalElapsedMs: 5,
      createdAt: 1,
      summaryLine: 'read 1 file',
      active: true,
      result: 'done',
      hasThought: true,
      presentationState: 'live',
    };

    expect(isBlockSettledInRun(summary)).toBe(false);
    expect(
      isBlockSettledInRun({
        ...summary,
        active: false,
        result: undefined,
        presentationState: 'live',
      }),
    ).toBe(false);
    expect(isBlockSettledInRun({ ...summary, active: false, presentationState: 'sealed' })).toBe(
      true,
    );
  });

  test('soft-closed Thought stays dynamic until the reducer publishes its overall result', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_summary',
        tools: [],
        totalElapsedMs: 5,
        createdAt: 1,
        summaryLine: 'x',
        active: false,
        hasThought: true,
        presentationState: 'live',
      },
      textBlock(2, 'pending answer', {
        modelRequestId: 'request-1',
        modelTerminal: false,
        presentationState: 'live',
      }),
    ];
    expect(isBlockSettledInRun(blocks[0]!)).toBe(false);
    expect(isBlockSettledInRun(blocks[1]!)).toBe(false);
    const summary = blocks[0] as Extract<OutputBlock, { kind: 'tool_summary' }>;
    expect(isBlockSettledInRun({ ...summary, result: 'done', presentationState: 'sealed' })).toBe(
      true,
    );
  });

  test('a terminal result completes only a closed aggregate', () => {
    const base: Extract<OutputBlock, { kind: 'tool_summary' }> = {
      id: 1,
      kind: 'tool_summary',
      tools: [
        {
          callId: 'read-1',
          name: 'read_file',
          args: { path: 'README.md' },
          ok: true,
          status: 'done',
          summary: 'Read complete.',
        },
      ],
      totalElapsedMs: 5,
      createdAt: 1,
      summaryLine: 'read 1 file',
      active: false,
      hasThought: true,
    };

    expect(isBlockSettledInRun(base)).toBe(false);
    expect(isBlockSettledInRun({ ...base, result: 'done', presentationState: 'sealed' })).toBe(
      true,
    );
    expect(isBlockSettledInRun({ ...base, result: 'error', presentationState: 'sealed' })).toBe(
      true,
    );
    expect(isBlockSettledInRun({ ...base, result: 'cancelled', presentationState: 'sealed' })).toBe(
      true,
    );
  });
});

describe('promotion does not duplicate output', () => {
  test('commits the final aggregate instead of the previously painted Thinking frame', () => {
    const user: Extract<OutputBlock, { kind: 'user' }> = {
      id: 1,
      kind: 'user',
      content: 'inspect this',
      presentationState: 'sealed',
    };
    const thinking: Extract<OutputBlock, { kind: 'tool_summary' }> = {
      id: 2,
      kind: 'tool_summary',
      tools: [],
      totalElapsedMs: 2_000,
      createdAt: 1,
      summaryLine: '',
      active: true,
      result: 'done',
      hasThought: true,
      hasThinking: true,
      presentationState: 'live',
    };
    const view = render(
      React.createElement(
        ThemeContext.Provider,
        { value: getDarkTheme('blue') },
        React.createElement(PromotionHarness, { blocks: [user, thinking] }),
      ),
    );
    expect(view.lastFrame()).toContain('Thinking 2s');

    const completed: Extract<OutputBlock, { kind: 'tool_summary' }> = {
      ...thinking,
      tools: [
        {
          callId: 'search-1',
          name: 'search_files',
          args: { pattern: 'README.md' },
          ok: true,
          status: 'done',
          summary: 'Found README.md.',
        },
      ],
      summaryLine: 'searched 1 file pattern',
      active: false,
      result: 'done',
      presentationState: 'sealed',
    };
    view.rerender(
      React.createElement(
        ThemeContext.Provider,
        { value: getDarkTheme('blue') },
        React.createElement(PromotionHarness, {
          blocks: [user, completed, textBlock(3, 'Summary complete.')],
        }),
      ),
    );

    expect(view.lastFrame()?.match(/Thinking /g)).toHaveLength(1);
    expect(view.lastFrame()).toContain('Thinking 2s · searched 1 file pattern');
    expect(view.lastFrame()).toContain('Summary complete.');
  });

  test('promotes a result-bearing Thought together with its terminal answer', () => {
    const completedTurn = {
      blocks: [
        {
          id: 1,
          kind: 'user' as const,
          content: 'inspect this',
          presentationState: 'sealed',
        },
        {
          id: 2,
          kind: 'tool_summary' as const,
          tools: [
            {
              callId: 'read-1',
              name: 'read_file',
              args: { path: 'README.md' },
              ok: true,
              status: 'done' as const,
              summary: 'Read complete.',
            },
          ],
          totalElapsedMs: 18_000,
          modelMs: 18_000,
          createdAt: 1,
          summaryLine: 'read 1 file',
          active: false,
          result: 'done' as const,
          hasThought: true,
          hasThinking: true,
          presentationState: 'sealed',
        },
        textBlock(3, 'Summary complete.'),
      ] satisfies OutputBlock[],
    };
    const view = render(
      React.createElement(TurnSplitHarness, { turns: [completedTurn], running: true }),
    );
    expect(view.lastFrame()).toContain('static:1,2,3;dynamic:');
  });

  test('promotes a terminal Thought on the cancellation frame', () => {
    const user: Extract<OutputBlock, { kind: 'user' }> = {
      id: 1,
      kind: 'user',
      content: 'inspect this',
      presentationState: 'sealed',
    };
    const thinking: Extract<OutputBlock, { kind: 'tool_summary' }> = {
      id: 2,
      kind: 'tool_summary',
      tools: [],
      totalElapsedMs: 5,
      createdAt: 1,
      summaryLine: '',
      active: true,
      hasThought: true,
      hasThinking: true,
      presentationState: 'live',
    };
    const view = render(
      React.createElement(SplitHarness, { blocks: [user, thinking], running: true }),
    );
    expect(view.lastFrame()).toContain('static:1;dynamic:2');

    view.rerender(
      React.createElement(SplitHarness, {
        blocks: [
          { ...user },
          { ...thinking, active: false, result: 'cancelled', presentationState: 'sealed' },
        ],
        running: false,
      }),
    );

    expect(view.lastFrame()).toContain('static:1,2;dynamic:');
  });

  test('promotes the real dynamic sibling group to one Static item in the same mount', () => {
    const early: OutputBlock[] = [
      subagentBlock(1, 'done', 'batch-1'),
      subagentBlock(2, 'running', 'batch-1'),
      subagentBlock(3, 'running', 'batch-1'),
    ];
    const view = render(
      React.createElement(
        ThemeContext.Provider,
        { value: getDarkTheme('blue') },
        React.createElement(PromotionHarness, { blocks: early }),
      ),
    );
    expect(view.lastFrame()).toContain('Delegating · 3 agents');

    const settled = early.map((block) =>
      block.kind === 'subagent'
        ? { ...block, status: 'done' as const, presentationState: 'sealed' as const }
        : block,
    );
    view.rerender(
      React.createElement(
        ThemeContext.Provider,
        { value: getDarkTheme('blue') },
        React.createElement(PromotionHarness, { blocks: settled }),
      ),
    );
    expect(view.lastFrame()?.match(/Delegated · 3 agents/g)).toHaveLength(1);

    view.rerender(
      React.createElement(
        ThemeContext.Provider,
        { value: getDarkTheme('blue') },
        React.createElement(PromotionHarness, {
          blocks: [...settled, textBlock(4, 'successor answer')],
        }),
      ),
    );
    expect(view.lastFrame()?.match(/Delegated · 3 agents/g)).toHaveLength(1);
    expect(view.lastFrame()).toContain('successor answer');
  });

  test('keeps a terminal sibling group Static when a queued successor is accepted', () => {
    const settled: OutputBlock[] = [
      {
        ...subagentBlock(1, 'done', 'queued-successor-batch'),
        presentationState: 'sealed',
      },
      {
        ...subagentBlock(2, 'done', 'queued-successor-batch'),
        presentationState: 'sealed',
      },
    ];
    const view = render(
      React.createElement(TurnSplitHarness, {
        turns: [{ blocks: settled }],
        running: true,
      }),
    );
    expect(view.lastFrame()).toContain('static:1,2;dynamic:');

    // The predecessor terminal arrives while the locally queued prompt waits.
    view.rerender(
      React.createElement(TurnSplitHarness, {
        turns: [{ blocks: settled }],
        running: false,
      }),
    );
    expect(view.lastFrame()).toContain('static:1,2;dynamic:');

    // ACCEPT_QUEUED_PROMPT atomically starts the run and appends the local
    // successor turn; a durable user.message that wins the race also creates
    // this turn before the acceptance receipt is reduced.
    const successorTurn: { blocks: OutputBlock[] } = {
      blocks: [
        {
          id: 3,
          kind: 'user' as const,
          content: 'queued successor',
          presentationState: 'live' as const,
        },
      ],
    };
    view.rerender(
      React.createElement(TurnSplitHarness, {
        turns: [{ blocks: settled }, successorTurn],
        running: true,
      }),
    );
    expect(view.lastFrame()).toContain('static:1,2;dynamic:3');
  });

  test('renders a settled concurrent child batch as one Static summary', () => {
    const group: OutputBlock[] = [
      subagentBlock(1, 'done', 'batch-1'),
      subagentBlock(2, 'done', 'batch-1'),
      subagentBlock(3, 'done', 'batch-1'),
    ];
    const { lastFrame } = renderArea(group, []);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Delegated · 3 agents · 3 succeeded');
    expect(frame.match(/Delegated/g)).toHaveLength(1);
    expect(frame).not.toContain('task 1');
  });

  test('labels settled child outcomes without calling failed children complete', () => {
    const group: OutputBlock[] = [
      subagentBlock(1, 'done', 'batch-1'),
      subagentBlock(2, 'error', 'batch-1'),
      subagentBlock(3, 'error', 'batch-1'),
    ];
    const { lastFrame } = renderArea(group, []);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Delegated · 3 agents · 1 succeeded · 2 failed');
    expect(frame).not.toContain('3 done');
  });

  test('dynamic tool card moved to Static renders once', () => {
    const doneTool = toolBlock(7, 'done') as OutputBlock;
    // Before promotion: tool card is in dynamic tree
    const before = renderArea([], [doneTool]);
    const beforeFrame = before.lastFrame() ?? '';
    const countBefore = beforeFrame.split('Create').length - 1;

    // After promotion: tool card moved to Static
    const after = renderArea([doneTool], []);
    const afterFrame = after.lastFrame() ?? '';
    const countAfter = afterFrame.split('Create').length - 1;

    expect(countBefore).toBe(1);
    expect(countAfter).toBe(1);
  });

  test('mixed turn: settled prefix + live tail render in order', () => {
    const settled = [textBlock(1, '已完成段落')];
    const live = [textBlock(2, '流式内容', { streaming: true })];
    const { lastFrame } = renderArea(settled, live);
    const frame = lastFrame() ?? '';
    const idxDone = frame.indexOf('已完成段落');
    const idxLive = frame.indexOf('流式内容');
    expect(idxDone).toBeGreaterThan(0);
    expect(idxLive).toBeGreaterThan(idxDone);
  });
});
