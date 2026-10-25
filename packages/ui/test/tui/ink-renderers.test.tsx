import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import ConcurrentSubAgentBlock from '../../src/tui/ink/ConcurrentSubAgentBlock';
import MarkdownBlock, { updateMarkdownParseCache } from '../../src/tui/ink/MarkdownBlock';
import SubAgentBlock from '../../src/tui/ink/SubAgentBlock';
import TaskProgressBlock from '../../src/tui/ink/TaskProgressBlock';
import ToolCardBlock from '../../src/tui/ink/ToolCardBlock';
import ToolSummaryBlock from '../../src/tui/ink/ToolSummaryBlock';
import type { OutputBlock } from '../../src/tui/ink/types';

test('original Markdown code fences and table borders retain contents with terminal widths', () => {
  const view = render(
    <MarkdownBlock
      content={
        '```ts\nconst value = 1;\n```\n\n| 名称 | Value |\n| --- | --- |\n| 测试 | **complete** |'
      }
      maxWidth={50}
    />,
  );
  try {
    const frame = view.lastFrame()!;
    expect(frame).toContain('┌─ ts ');
    expect(frame).toContain('const value = 1;');
    expect(frame).toContain('┬');
    expect(frame).toContain('┼');
    expect(frame).toContain('名称');
    expect(frame).toContain('complete');
    expect(frame).not.toContain('**complete**');
  } finally {
    view.unmount();
  }
});

test('incremental Markdown retains closed group identities while only the tail grows', () => {
  const first = updateMarkdownParseCache(
    undefined,
    '## Original\n\nfirst paragraph\n\n```ts\nconst x = 1;',
  );
  const next = updateMarkdownParseCache(
    first,
    '## Original\n\nfirst paragraph\n\n```ts\nconst x = 1;\nconst y = 2;',
  );
  expect(next.groups[0]).toBe(first.groups[0]);
  expect(next.groups.at(-1)).toMatchObject({
    kind: 'code',
    lines: ['const x = 1;', 'const y = 2;'],
  });
});

const tool = (
  extra: Partial<Extract<OutputBlock, { kind: 'tool_card' }>> = {},
): Extract<OutputBlock, { kind: 'tool_card' }> => ({
  id: 1,
  kind: 'tool_card',
  callId: 'original',
  name: 'shell_execute',
  args: { command: 'echo original' },
  status: 'running',
  summary: '',
  ...extra,
});

test('generic result previews mark character and line clipping without splitting a Unicode scalar', () => {
  for (const summary of [
    `${'x'.repeat(299)}🙂RESULT_TAIL`,
    `${'x'.repeat(299)}👨‍👩‍👧‍👦RESULT_TAIL`,
    `first\n${'x'.repeat(199)}🙂RESULT_TAIL`,
    Array.from({ length: 6 }, (_, index) => `line-${index}`).join('\n'),
  ]) {
    const view = render(
      <ToolCardBlock
        block={tool({ name: 'planning.read', status: 'done', summary, expanded: true })}
        columns={120}
      />,
    );
    try {
      expect(view.lastFrame()).toContain('Ctrl+E');
      expect(view.lastFrame()).not.toContain('RESULT_TAIL');
      expect(view.lastFrame()).not.toContain('👨');
      expect(view.lastFrame()).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    } finally {
      view.unmount();
    }
  }
  const view = render(
    <ToolCardBlock
      block={tool({
        name: 'planning.read',
        status: 'done',
        summary: 'x'.repeat(300),
        expanded: true,
      })}
      columns={120}
    />,
  );
  try {
    expect(view.lastFrame()).not.toContain('Ctrl+E');
  } finally {
    view.unmount();
  }
});
test('original Shell card follows five-line tail and retains settled status when collapsed', () => {
  const view = render(
    <ToolCardBlock
      block={tool({
        liveOutput: Array.from({ length: 9 }, (_, i) => `line-${i}`).join('\n'),
        liveTotalLines: 9,
      })}
      columns={80}
    />,
  );
  try {
    const frame = view.lastFrame()!;
    expect(frame).toContain('Bash');
    expect(frame).toContain('… +4 lines');
    expect(frame).not.toContain('line-0');
    expect(frame).toContain('line-4');
    expect(frame).toContain('line-8');
  } finally {
    view.unmount();
  }
  const done = render(
    <ToolCardBlock
      block={tool({ status: 'done', summary: 'original output', expanded: false, elapsedMs: 1000 })}
      columns={80}
    />,
  );
  try {
    expect(done.lastFrame()).not.toContain('original output');
    expect(done.lastFrame()).toContain('1s');
  } finally {
    done.unmount();
  }
});

test('original file tool renderer preserves full diff rows and tool-specific friendly name', () => {
  const view = render(
    <ToolCardBlock
      block={tool({
        name: 'edit_file',
        args: { path: 'src/original.ts' },
        status: 'done',
        summary: 'Added 1, removed 1\n1 -before\n1 +after',
        expanded: true,
      })}
      columns={80}
    />,
  );
  try {
    expect(view.lastFrame()).toContain('Update');
    expect(view.lastFrame()).toContain('1 -before');
    expect(view.lastFrame()).toContain('1 +after');
  } finally {
    view.unmount();
  }
});

test('failed and active questions keep distinct call states without inventing an unanswered result', () => {
  const args = { questions: [{ question: 'Exact original question', options: [] }] };
  const view = render(
    <ToolCardBlock
      block={tool({
        name: 'ask_user',
        args,
        status: 'error',
        summary: 'invalid_tool_arguments',
        expanded: true,
      })}
      columns={120}
    />,
  );
  try {
    expect(view.lastFrame()).toContain('Question parameters invalid; no question opened');
    expect(view.lastFrame()).toContain('invalid_tool_arguments');
    expect(view.lastFrame()).toContain('Exact original question');
    view.rerender(
      <ToolCardBlock
        block={tool({
          callId: 'second-original',
          name: 'ask_user',
          args,
          status: 'running',
          expanded: true,
        })}
        columns={120}
        awaitingInput
      />,
    );
    expect(view.lastFrame()).toContain('(awaiting input)');
    expect(view.lastFrame()).not.toContain('invalid_tool_arguments');
    expect(view.lastFrame()).not.toContain('(no answer)');
  } finally {
    view.unmount();
  }
});

const child = (id: string): Extract<OutputBlock, { kind: 'subagent' }> => ({
  id: Number(id),
  kind: 'subagent',
  subagentId: id,
  role: 'explore',
  task: 'Original task',
  status: 'done',
  summary: 'done',
  toolCallCount: 1,
  durationMs: 1000,
  steps: [
    {
      stepId: `step-${id}`,
      toolCallId: `call-${id}`,
      toolName: 'read_file',
      toolArgs: { path: 'src/original.ts' },
      status: 'success',
    },
  ],
});
test('original child activity tree and explicit concurrent group have distinct layouts', () => {
  const view = render(<SubAgentBlock block={child('1')} columns={80} />);
  try {
    expect(view.lastFrame()).toContain('Original task');
    expect(view.lastFrame()).toContain('├─');
    expect(view.lastFrame()).toContain('└─');
    expect(view.lastFrame()).toContain('original.ts');
  } finally {
    view.unmount();
  }
  const group = render(<ConcurrentSubAgentBlock blocks={[child('1'), child('2')]} columns={80} />);
  try {
    expect(group.lastFrame()).toContain('2 agents');
  } finally {
    group.unmount();
  }
});

test('original thought summary and plan progress use compact activity windows', () => {
  const block: Extract<OutputBlock, { kind: 'tool_summary' }> = {
    id: 3,
    kind: 'tool_summary',
    tools: [],
    totalElapsedMs: 1000,
    createdAt: 1,
    summaryLine: 'read 2 files',
    active: false,
    hasThought: true,
    hasThinking: true,
    result: 'done',
  };
  const thought = render(<ToolSummaryBlock block={block} columns={80} />);
  try {
    expect(thought.lastFrame()).toContain('Thinking 1s');
  } finally {
    thought.unmount();
  }
  const plan = render(
    <TaskProgressBlock
      plan={{
        steps: Array.from({ length: 9 }, (_, i) => ({
          step: `step ${i + 1}`,
          status: i === 4 ? 'in_progress' : 'pending',
        })),
      }}
    />,
  );
  try {
    expect(plan.lastFrame()).toContain('● 5. step 5');
    expect(plan.lastFrame()).not.toContain('○ 1. step 1');
    expect(plan.lastFrame()).toContain('later steps');
  } finally {
    plan.unmount();
  }
});

test('original user bubble preserves literal Markdown and bounds long prompts by head and tail', async () => {
  const { default: UserMessageBlock, visibleUserMessageLines } = await import(
    '../../src/tui/ink/UserMessageBlock'
  );
  const view = render(<UserMessageBlock content="**literal prompt**" columns={80} />);
  try {
    expect(view.lastFrame()).toContain('❯ **literal prompt**');
  } finally {
    view.unmount();
  }
  const lines = visibleUserMessageLines(
    Array.from({ length: 50 }, (_, i) => `original-line-${i}`).join('\n'),
    80,
  );
  expect(lines).toHaveLength(31);
  expect(lines[0]).toBe('❯ original-line-0');
  expect(lines[15]).toBe('【已省略 20 行】');
  expect(lines.at(-1)).toBe('original-line-49');
});

test('missing source timing never becomes a fabricated one-second tool or child duration', () => {
  const running = render(<ToolCardBlock block={tool()} columns={80} />);
  try {
    expect(running.lastFrame()).not.toContain('(1s)');
  } finally {
    running.unmount();
  }
  const withoutTiming = { ...child('1'), durationMs: undefined };
  const settled = render(<SubAgentBlock block={withoutTiming} columns={80} />);
  try {
    expect(settled.lastFrame()).toContain('done!');
    expect(settled.lastFrame()).not.toContain('(1s)');
  } finally {
    settled.unmount();
  }
  const group = render(
    <ConcurrentSubAgentBlock blocks={[withoutTiming, child('2')]} columns={80} />,
  );
  try {
    expect(group.lastFrame()).toContain('2 agents');
    expect(group.lastFrame()).not.toContain(' · 1s');
    expect(group.lastFrame()).not.toContain('NaN');
  } finally {
    group.unmount();
  }
  const thought = render(
    <ToolSummaryBlock
      block={{
        id: 3,
        kind: 'tool_summary',
        tools: [],
        createdAt: 1,
        summaryLine: '',
        active: false,
        hasThought: true,
        hasThinking: true,
      }}
      columns={80}
    />,
  );
  try {
    expect(thought.lastFrame()).toContain('Thinking');
    expect(thought.lastFrame()).not.toContain('1s');
    expect(thought.lastFrame()).not.toContain('NaN');
  } finally {
    thought.unmount();
  }
});

for (const approvalState of [
  'auto_checking',
  'queued_auto_check',
  'auto_reviewing',
  'queued_auto_review',
] as const)
  test(`automatic check ${approvalState} remains visible in single and concurrent child renderers`, () => {
    const block = {
      ...child('1'),
      status: 'running' as const,
      awaitingApproval: true,
      approvalState,
    };
    const expected =
      approvalState === 'auto_checking' || approvalState === 'auto_reviewing'
        ? '自动审核中'
        : '等待自动审核';
    const single = render(<SubAgentBlock block={block} columns={100} />);
    const concurrent = render(<ConcurrentSubAgentBlock blocks={[block]} columns={100} />);
    try {
      expect(single.lastFrame()).toContain(expected);
      expect(concurrent.lastFrame()).toContain(expected);
    } finally {
      single.unmount();
      concurrent.unmount();
    }
  });

for (const field of ['checkFailure', 'reviewFailure'] as const)
  test(`tool ${field} preserves the automatic-check failure reason`, () => {
    const view = render(
      <ToolCardBlock block={tool({ [field]: 'exact checker failure' })} columns={100} />,
    );
    try {
      expect(view.lastFrame()).toContain('auto-check: exact checker failure');
      expect(view.lastFrame()).not.toContain('auto-review');
    } finally {
      view.unmount();
    }
  });
