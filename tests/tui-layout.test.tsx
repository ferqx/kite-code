import { describe, expect, test } from 'bun:test';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import App from '../src/app/tui/App';
import ApprovalBlock from '../src/app/tui/components/ApprovalBlock';
import BlockRenderer, {
  MAX_USER_MESSAGE_LINES,
  visibleUserMessageLines,
} from '../src/app/tui/components/BlockRenderer';
import HelpPanel from '../src/app/tui/components/HelpPanel';
import InputBlock from '../src/app/tui/components/InputBlock';
import InputLine from '../src/app/tui/components/InputLine';
import MarkdownBlock, {
  groupLines,
  updateMarkdownParseCache,
} from '../src/app/tui/components/MarkdownBlock';
import ModelSelector, { modelOptionId } from '../src/app/tui/components/ModelSelector';
import PlanReviewBlock from '../src/app/tui/components/PlanReviewBlock';
import { SPINNER, spinnerIndexForElapsed } from '../src/app/tui/components/render-utils';
import StartupScreen from '../src/app/tui/components/StartupScreen';
import SubAgentBlock from '../src/app/tui/components/SubAgentBlock';
import TaskProgressBlock from '../src/app/tui/components/TaskProgressBlock';
import DiffPreview from '../src/app/tui/DiffPreview';
import Footer from '../src/app/tui/Footer';
import Header, { formatHeaderWorkspace } from '../src/app/tui/Header';
import { createInitialState } from '../src/app/tui/initialState';
import OutputArea, { useStaticContent } from '../src/app/tui/OutputArea';
import { TuiUserInputProvider } from '../src/app/tui/provider';
import { type Action, eventReducer as canonicalEventReducer } from '../src/app/tui/reducers';
import type { RunStatusSnapshot } from '../src/app/tui/run-status';
import StatsLine from '../src/app/tui/StatsLine';
import StatusBar from '../src/app/tui/StatusBar';
import type {
  FileChangeRecord,
  OutputBlock,
  StatusState,
  TuiState,
  Turn,
} from '../src/app/tui/types';
import type { RuntimeEvent } from '../src/core/runtime/events';
import { decodeHistoricalToolOutcomeEventV1 } from '../src/core/runtime/tool-outcome-events';
import type { AgentPlan, ToolApprovalPayload, UserInputPayload } from '../src/protocol/events';

// ── Shared helpers ──

function eventReducer(state: TuiState, action: Action): TuiState {
  return canonicalEventReducer(
    state,
    action.type === 'RUNTIME_EVENT'
      ? { ...action, event: decodeHistoricalToolOutcomeEventV1(action.event) }
      : action,
  );
}

function fakeStatus(overrides: Partial<StatusState> = {}): StatusState {
  return {
    phase: 'building',
    plan: null,
    pendingPlan: null,
    authorization: 'full_access',
    workspaceAccess: 'write',
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0.45,
    totalTokens: 1234,
    currentNode: 'agent',
    modelProvider: 'anthropic',
    modelName: 'claude-opus',
    thinkingMode: 'detailed',
    retryState: null,
    ...overrides,
  };
}

function fakeRunStatus(overrides: Partial<RunStatusSnapshot> = {}): RunStatusSnapshot {
  return {
    phase: 'working',
    verb: 'Running',
    tone: 'success',
    elapsedMs: 28_000,
    runTokenDelta: 189,
    retry: null,
    waiting: null,
    ...overrides,
  };
}

describe('spinner timing', () => {
  test('derives frames deterministically from elapsed time', () => {
    expect(SPINNER[spinnerIndexForElapsed(0)]).toBe('● ');
    expect(SPINNER[spinnerIndexForElapsed(120)]).toBe('● ');
    expect(SPINNER[spinnerIndexForElapsed(SPINNER.length * 1000)]).toBe('● ');
  });
});

function fakeApproval(overrides: Partial<ToolApprovalPayload> = {}): ToolApprovalPayload {
  return {
    scope: 'once',
    cwd: '/tmp',
    threadId: 'test-thread',
    tool: 'shell_execute',
    command: 'npm test',
    risk: 'execute_code',
    approvalHash: 'abc123',
    summary: 'Run unit tests',
    reason: 'Agent wants to verify changes',
    expectedEffects: ['runs jest', 'outputs results'],
    grantOptions: ['approve_once', 'same_command', 'full_access'],
    recommendedGrant: 'approve_once',
    ...overrides,
  };
}

function fakeQuestion(overrides: Partial<UserInputPayload> = {}): UserInputPayload {
  return {
    question: 'Which approach do you prefer?',
    options: [
      { id: 'a', label: 'Option A', description: 'First approach' },
      { id: 'b', label: 'Option B', description: 'Second approach' },
    ],
    allow_free_text: true,
    ...overrides,
  };
}

function fakeProvider(): TuiUserInputProvider {
  return new TuiUserInputProvider();
}

const onResolved = () => {};
const noop = () => {};

// ── Footer ──

describe('Footer', () => {
  const footerProps = {
    status: fakeStatus(),
    running: false,
    thinkingVisible: true,
    timerKey: 0,
  };

  test('renders Footer with child content', () => {
    const { lastFrame } = render(
      <Footer {...footerProps}>
        <Text>child content</Text>
      </Footer>,
    );
    expect(lastFrame()).toContain('child content');
  });

  test('renders empty Box when no children', () => {
    const { lastFrame } = render(<Footer {...footerProps} />);
    // Placeholder footer renders an empty Box
    expect(typeof lastFrame()).toBe('string');
  });

  test('hides global status while keeping blocking interaction content', () => {
    const { lastFrame } = render(
      <Footer {...footerProps} interactionMode="accept_edits" hideGlobalStatus>
        <Text>blocking interaction</Text>
      </Footer>,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('blocking interaction');
    expect(frame).not.toContain('claude-opus');
    expect(frame).not.toContain('[接受编辑]');
  });
});

// ── Header ──

describe('Header', () => {
  test('renders the branded session startup card', () => {
    const { lastFrame } = render(
      <Header modelName="gpt-5.6" thinkingMode="low" workspace="/tmp/kite-code" columns={60} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('──◆ Kite Code');
    expect(frame).toContain('gpt-5.6 low');
    expect(frame).not.toContain('/model');
    expect(frame).toContain('/tmp/kite-code');
    expect(frame).toContain('│ model');
    expect(frame).toContain('│ workspace');
    expect(frame).not.toContain('/\\_/\\');
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
  });

  test('uses a six-row rounded startup header', () => {
    const { lastFrame } = render(
      <Header modelName="gpt-5.6" thinkingMode="low" workspace="/tmp/kite-code" columns={60} />,
    );
    expect(lastFrame()?.split('\n')).toHaveLength(6);
  });

  test('caps the startup card at 60 columns on wide terminals', () => {
    const { lastFrame } = render(
      <Header modelName="gpt-5.6" thinkingMode="low" workspace="/tmp/kite-code" columns={120} />,
    );
    expect(
      lastFrame()
        ?.split('\n')
        .every((line) => stringWidth(line) <= 60),
    ).toBe(true);
  });

  test('contracts the home directory in the workspace snapshot', () => {
    expect(formatHeaderWorkspace('/Users/test/Code/ai/kite-code', '/Users/test')).toBe(
      '~/Code/ai/kite-code',
    );
  });

  test('hides secondary model details on narrow terminals', () => {
    const { lastFrame } = render(
      <Header
        modelName="gpt-5.6"
        thinkingMode="low"
        workspace="/a/very/long/workspace/path/kite-code"
        columns={36}
      />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('gpt-5.6');
    expect(frame).not.toContain(' low');
    expect(frame).not.toContain('/model');
    expect(frame).toContain('…');
    expect(frame.split('\n').every((line) => stringWidth(line) <= 36)).toBe(true);
  });

  test('hides thinking mode only when model configuration disables reasoning', () => {
    const { lastFrame } = render(
      <Header
        modelName="gpt-5.6"
        thinkingMode="low"
        reasoningEnabled={false}
        workspace="/tmp/kite-code"
        columns={60}
      />,
    );
    expect(lastFrame()).not.toContain(' low');
  });
});

// ── StatusBar ──

describe('StatusBar', () => {
  test('shows the derived run verb with working phase prefix', () => {
    const { lastFrame } = render(
      <StatusBar
        status={fakeStatus({ phase: 'building' })}
        runStatus={fakeRunStatus({ phase: 'working', verb: 'Running' })}
        timerKey={0}
        running
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running');
    expect(frame).not.toContain('Building');
  });

  test('shows elapsed time without raw tool detail', () => {
    const { lastFrame } = render(
      <StatusBar
        status={fakeStatus()}
        runStatus={fakeRunStatus({
          phase: 'working',
          verb: 'Locating',
          elapsedMs: 28_000,
          runTokenDelta: 189,
        })}
        timerKey={0}
        running
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Locating');
    expect(frame).toContain('28s');
    // Tool detail lives in blocks, not in the status line
    expect(frame).not.toContain('StatusBar');
  });

  test('status bar hides when idle and not planning', () => {
    const status = fakeStatus({ phase: 'building' });
    const { lastFrame } = render(
      <StatusBar
        status={status}
        runStatus={fakeRunStatus({ phase: 'thinking', verb: 'Planning' })}
        timerKey={0}
        running={false}
      />,
    );
    // StatusBar returns null when idle and not in a special phase
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Shift+Tab');
    expect(frame).not.toContain('*');
  });

  test('status bar is single row', () => {
    const status = fakeStatus();
    const { lastFrame } = render(
      <StatusBar status={status} runStatus={fakeRunStatus()} timerKey={0} running />,
    );
    const lines = lastFrame()?.split('\n').filter(Boolean);
    expect(lines?.length).toBe(1);
  });
});

describe('StatsLine', () => {
  test('shows model name', () => {
    const status = fakeStatus({ modelName: 'gpt-5' });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('gpt-5');
  });

  test('shows thinking mode', () => {
    const status = fakeStatus({
      modelProvider: 'deepseek',
      thinkingMode: 'detailed',
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('detailed');
  });

  test('shows thinking mode for a compatible or custom provider route', () => {
    const status = fakeStatus({
      modelProvider: 'openai_compatible',
      modelName: 'deepseek-v4-flash',
      thinkingMode: 'high',
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('deepseek-v4-flash high');
  });

  test('hides thinking mode when model configuration explicitly disables reasoning', () => {
    const status = fakeStatus({ thinkingMode: 'high', reasoningEnabled: false });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).not.toContain('high');
  });

  test('shows thinking mode without effort: prefix', () => {
    const status = fakeStatus({
      modelProvider: 'deepseek',
      thinkingMode: 'medium',
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    // Should show just "medium" without "effort: " prefix
    expect(lastFrame()).not.toContain('effort:');
    expect(lastFrame()).toContain('medium');
  });

  test('shows plan mode info when planMode=true', () => {
    const status = fakeStatus();
    const { lastFrame } = render(<StatsLine status={status} planMode running />);
    const frame = lastFrame();
    // Only Shift+Tab hint in StatsLine; plan name moved to InputLine top separator
    expect(frame).toContain('Shift+Tab to exit');
    expect(frame).not.toContain('Plan');
  });

  test('shows cache hit rate', () => {
    const status = fakeStatus({
      modelProvider: 'deepseek',
      cacheHitTokens: 75,
      cacheMissTokens: 25,
      totalTokens: 1200,
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('75% cache');
  });

  test('shows token count formatted', () => {
    const status = fakeStatus({ totalTokens: 10000 });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('10.0k');
  });

  test('shows [自动审批] for auto mode', () => {
    const status = fakeStatus({ authorization: 'default' });
    const { lastFrame } = render(<StatsLine status={status} running interactionMode="auto" />);
    expect(lastFrame()).toContain('[自动审批]');
  });

  test('shows [完全权限] for full mode', () => {
    const status = fakeStatus({ authorization: 'full_access' });
    const { lastFrame } = render(<StatsLine status={status} running interactionMode="full" />);
    expect(lastFrame()).toContain('[完全权限]');
  });

  test('shows no label for accept_edits mode (default)', () => {
    const status = fakeStatus({ authorization: 'default' });
    const { lastFrame } = render(
      <StatsLine status={status} running interactionMode="accept_edits" />,
    );
    expect(lastFrame()).not.toContain('[安全]');
    expect(lastFrame()).not.toContain('[完全]');
    expect(lastFrame()).not.toContain('[自动审批]');
    expect(lastFrame()).not.toContain('[完全权限]');
  });

  test('does not infer context percentage from a known model name', () => {
    const status = fakeStatus({
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-flash',
      totalTokens: 39321,
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/\d+% context/);
    expect(frame).toContain('39.3k');
  });

  test('falls back to absolute token count when model has no contextWindow', () => {
    const status = fakeStatus({
      modelProvider: 'anthropic',
      modelName: 'claude-opus',
      totalTokens: 10000,
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    // claude-opus is not in default models, so no contextWindow — falls back to absolute
    expect(lastFrame()).toContain('10.0k');
  });

  test('uses the Core context estimate instead of cumulative usage when utilization is unknown', () => {
    const status = fakeStatus({
      totalTokens: 11_500,
      contextSnapshot: {
        estimate: {
          systemTokens: 5_000,
          toolSchemaTokens: 4_000,
          transcriptTokens: 16_824,
          summaryTokens: 0,
          dynamicRuntimeTokens: 200,
          framingTokens: 100,
          totalInputTokens: 26_124,
        },
        status: 'unknown',
      },
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('26.1k');
    expect(lastFrame()).not.toContain('11.5k');
  });

  test('shows context utilization only from the Core snapshot', () => {
    const status = fakeStatus({
      totalTokens: 10_000,
      contextSnapshot: {
        estimate: {
          systemTokens: 100,
          toolSchemaTokens: 100,
          transcriptTokens: 7_000,
          summaryTokens: 0,
          dynamicRuntimeTokens: 100,
          framingTokens: 200,
          totalInputTokens: 7_500,
        },
        usableInputTokens: 10_000,
        utilization: 0.75,
        status: 'warning',
      },
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('75% context');
    expect(lastFrame()).not.toContain('10.0k');
  });

  test('does not show a historical compaction reduction percentage', () => {
    const status = fakeStatus({
      totalTokens: 11_500,
      contextSnapshot: {
        estimate: {
          systemTokens: 100,
          toolSchemaTokens: 100,
          transcriptTokens: 8_500,
          summaryTokens: 200,
          dynamicRuntimeTokens: 100,
          framingTokens: 100,
          totalInputTokens: 9_100,
        },
        usableInputTokens: 10_000,
        utilization: 0.91,
        status: 'compact_due',
        inputTokensBefore: 100_000,
        inputTokensAfter: 9_000,
      },
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).not.toContain('compacted');
  });

  test('does not show ro/rw indicator (workspace access always write)', () => {
    const status = fakeStatus({ workspaceAccess: 'write' });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).not.toContain('ro');
    expect(lastFrame()).not.toContain('rw');
  });
});

// ── DiffPreview ──

describe('DiffPreview', () => {
  test('renders header and file changes', () => {
    const changes: FileChangeRecord[] = [
      { path: 'src/foo.ts', kind: 'add', linesAdded: 5 },
      { path: 'src/bar.ts', kind: 'delete', linesRemoved: 3 },
    ];
    const { lastFrame } = render(<DiffPreview changes={changes} />);
    const frame = lastFrame();
    expect(frame).toContain('File Changes');
    expect(frame).toContain('+ src/foo.ts');
    expect(frame).toContain('- src/bar.ts');
  });

  test('shows edit prefix for edit kind', () => {
    const changes: FileChangeRecord[] = [
      { path: 'src/baz.ts', kind: 'edit', linesAdded: 2, linesRemoved: 1 },
    ];
    const { lastFrame } = render(<DiffPreview changes={changes} />);
    expect(lastFrame()).toContain('~ src/baz.ts');
  });

  test('renders empty string for empty changes array', () => {
    const { lastFrame } = render(<DiffPreview changes={[]} />);
    expect(lastFrame()).toBe('');
  });
});

// ── MarkdownBlock ──

describe('MarkdownBlock', () => {
  test('renders plain text', () => {
    const { lastFrame } = render(<MarkdownBlock content="Hello world" />);
    expect(lastFrame()).toContain('Hello world');
  });

  test('renders # heading', () => {
    const { lastFrame } = render(<MarkdownBlock content="# Title" />);
    expect(lastFrame()).toContain('Title');
  });

  test('renders ## heading with dashes', () => {
    const { lastFrame } = render(<MarkdownBlock content="## Section" />);
    expect(lastFrame()).toContain('── Section ──');
  });

  test('renders ### heading', () => {
    const { lastFrame } = render(<MarkdownBlock content="### Subsection" />);
    expect(lastFrame()).toContain('Subsection');
  });

  test('renders list items with bullet', () => {
    const { lastFrame } = render(<MarkdownBlock content="- item one\n- item two" />);
    const frame = lastFrame();
    expect(frame).toContain('item one');
    expect(frame).toContain('item two');
  });

  test('renders blockquote', () => {
    const { lastFrame } = render(<MarkdownBlock content="> quoted text" />);
    expect(lastFrame()).toContain('quoted text');
  });

  test('renders code block with lang label and line prefix', () => {
    const { lastFrame } = render(<MarkdownBlock content={'```ts\nconst x = 1;\nreturn x;\n```'} />);
    const frame = lastFrame();
    expect(frame).toContain('┌─ ts ─');
    expect(frame).toContain('const x = 1');
  });

  test('renders empty lines as spacing', () => {
    const { lastFrame } = render(<MarkdownBlock content="line1\n\nline3" />);
    const lines = lastFrame()?.split('\n');
    // There should be content on multiple lines
    expect(lines?.some((l) => l.includes('line1'))).toBe(true);
    expect(lines?.some((l) => l.includes('line3'))).toBe(true);
  });

  test('renders inline bold', () => {
    const { lastFrame } = render(<MarkdownBlock content="normal **bold** text" />);
    expect(lastFrame()).toContain('bold');
    expect(lastFrame()).toContain('normal');
  });

  test('renders inline code', () => {
    const { lastFrame } = render(<MarkdownBlock content="use `code` here" />);
    expect(lastFrame()).toContain('code');
  });

  test('renders nested unordered list with indentation', () => {
    const { lastFrame } = render(<MarkdownBlock content="- one\n  - nested" />);
    expect(lastFrame()).toContain('nested');
  });

  test('renders task list checkbox', () => {
    const { lastFrame } = render(<MarkdownBlock content="- [x] done" />);
    expect(lastFrame()).toContain('done');
  });

  test('renders blockquote with left bar', () => {
    const { lastFrame } = render(<MarkdownBlock content="> quote" />);
    expect(lastFrame()).toContain('quote');
  });

  test('renders code block top border across full width', () => {
    const { lastFrame } = render(<MarkdownBlock content={'```ts\nx\n```'} />);
    expect(lastFrame()).toContain('┌─ ts ─');
  });

  test('keeps earlier Markdown components stable while the tail grows', () => {
    const view = render(<MarkdownBlock content={'# Result\n\nFirst paragraph'} />);
    view.rerender(
      <MarkdownBlock
        content={'# Result\n\nFirst paragraph\n\n- item one\n- item two\n\n```ts\nconst x = 1\n```'}
      />,
    );

    const frame = view.lastFrame();
    expect(frame).toContain('Result');
    expect(frame).toContain('First paragraph');
    expect(frame).toContain('item one');
    expect(frame).toContain('item two');
    expect(frame).toContain('┌─ ts ─');
    expect(frame).toContain('const x = 1');
  });

  test('incremental parsing preserves completed prefix group identities', () => {
    const first = updateMarkdownParseCache(
      undefined,
      '# Result\n\nFirst paragraph\n\nSecond paragraph',
    );
    const next = updateMarkdownParseCache(
      first,
      '# Result\n\nFirst paragraph\n\nSecond paragraph grows',
    );

    expect(next.groups.slice(0, -1)).toEqual(first.groups.slice(0, -1));
    expect(next.groups[0]).toBe(first.groups[0]);
    expect(next.groups[1]).toBe(first.groups[1]);
    expect(next.groups[2]).toBe(first.groups[2]);
    expect(next.groups.at(-1)).not.toBe(first.groups.at(-1));
  });

  test('incremental parsing reparses the tail when a pipe row becomes a table', () => {
    const first = updateMarkdownParseCache(undefined, 'Intro\n\n| Name | Value |');
    const next = updateMarkdownParseCache(
      first,
      'Intro\n\n| Name | Value |\n| --- | --- |\n| streaming | stable |',
    );

    expect(next.groups[0]).toBe(first.groups[0]);
    expect(next.groups.at(-1)).toMatchObject({
      kind: 'table',
      startIndex: 2,
    });
  });

  test('promotes a growing pipe sequence into one table component', () => {
    const view = render(<MarkdownBlock content="| Name | Value |" />);
    view.rerender(
      <MarkdownBlock content={'| Name | Value |\n| --- | --- |\n| streaming | stable |'} />,
    );

    const frame = view.lastFrame();
    expect(frame).toContain('Name');
    expect(frame).toContain('Value');
    expect(frame).toContain('streaming');
    expect(frame).toContain('stable');
  });

  test('renders inline Markdown as visible table-cell text', () => {
    const { lastFrame } = render(
      <MarkdownBlock
        content={
          '| 任务 | 改动范围 | 工作量 |\n| --- | --- | --- |\n| **A1. web\\_search 工具** | 新增 `web-search.ts`，通过 **MCP** 搜索。 | 中 |'
        }
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('A1. web_search 工具');
    expect(frame).toContain('新增 web-search.ts，通过 MCP 搜索。');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`');
    expect(frame).not.toContain('\\_');
  });

  test('keeps escaped and code-span pipes inside their table cells', () => {
    const { lastFrame } = render(
      <MarkdownBlock
        content={'| A | B |\n| --- | --- |\n| x \\| y | first |\n| `left | right` | second |'}
        maxWidth={80}
      />,
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lines).toContain('│ x | y        │ first  │');
    expect(lines).toContain('│ left | right │ second │');
    expect(lines.every((line) => (line.match(/│/g)?.length ?? 0) <= 3)).toBe(true);
  });

  test('keeps tables within the Markdown container width', () => {
    const { lastFrame } = render(
      <MarkdownBlock
        content={'| Header | Value |\n| --- | --- |\n| abcdefghijklmnop | 1234567890 |'}
        maxWidth={20}
      />,
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((line) => stringWidth(line) <= 20)).toBe(true);
  });

  test('keeps wide graphemes inside one-column cells in an extremely narrow table', () => {
    const { lastFrame } = render(
      <MarkdownBlock content={'| 一 | B |\n| --- | --- |\n| 汉 | 👨‍👩‍👧‍👦 |'} maxWidth={9} />,
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lines.every((line) => stringWidth(line) <= 9)).toBe(true);
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1);
    expect(lastFrame()).toContain('…');
  });

  test('preserves table link destinations and Unicode border alignment', () => {
    const { lastFrame } = render(
      <MarkdownBlock
        content={
          '| 名称 | 值 |\n| --- | --- |\n| **文档** | [打开](https://example.com) |\n| emoji | 👨‍👩‍👧‍👦 é |'
        }
        maxWidth={50}
      />,
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lastFrame()).toContain('打开 (https://example.com)');
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1);
  });

  test('groups consecutive plain lines into logical paragraphs', () => {
    expect(groupLines(['first line', 'continued line', '', 'second paragraph'])).toEqual([
      {
        kind: 'paragraph',
        lines: ['first line', 'continued line'],
        startIndex: 0,
      },
      { kind: 'single', line: '', index: 2 },
      {
        kind: 'paragraph',
        lines: ['second paragraph'],
        startIndex: 3,
      },
    ]);
  });

  test('renders a multi-line paragraph through one text node while preserving line breaks', () => {
    const { lastFrame } = render(
      <MarkdownBlock content={'first **bold** line\nsecond `code` line\nthird line'} />,
    );

    expect(lastFrame()?.split('\n')).toEqual(['first bold line', 'second code line', 'third line']);
  });

  test('keeps paragraph boundaries around Markdown structures', () => {
    expect(
      groupLines([
        'intro',
        'continues',
        '',
        '- item',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        'outro',
      ]).map((group) => group.kind),
    ).toEqual(['paragraph', 'single', 'list', 'single', 'table', 'single', 'paragraph']);
  });

  test('grows table, code, list, and quote components by stable child rows', () => {
    const view = render(
      <MarkdownBlock
        content={
          '| Name | Value |\n| --- | --- |\n| first | one |\n\n```ts\nconst one = 1\n```\n\n- first\n\n> first'
        }
      />,
    );
    view.rerender(
      <MarkdownBlock
        content={
          '| Name | Value |\n| --- | --- |\n| first | one |\n| second | two |\n\n```ts\nconst one = 1\nconst two = 2\n```\n\n- first\n- second\n\n> first\n> second'
        }
      />,
    );

    const frame = view.lastFrame();
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    expect(frame).toContain('const one = 1');
    expect(frame).toContain('const two = 2');
    expect(frame?.match(/•/g)).toHaveLength(2);
    expect(frame?.match(/▎/g)).toHaveLength(2);
  });

  test('reflows all table rows when a new cell expands a column width', () => {
    const view = render(
      <MarkdownBlock content={'| A | B |\n| --- | --- |\n| x | y |'} maxWidth={80} />,
    );
    view.rerender(
      <MarkdownBlock
        content={'| A | B |\n| --- | --- |\n| x | y |\n| much-longer-value | z |'}
        maxWidth={80}
      />,
    );

    const lines = view.lastFrame()?.split('\n') ?? [];
    expect(lines.some((line) => line.includes('much-longer-value'))).toBe(true);
    expect(lines.filter((line) => line.startsWith('│'))).toHaveLength(3);
  });
});

// ── HelpPanel ──

describe('HelpPanel', () => {
  test('renders title and sections', () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame();
    expect(frame).toContain('── 快捷键');
    expect(frame).not.toContain('◆ Kite Code');
    expect(frame).toContain('快捷键');
    expect(frame).toContain('斜杠命令');
  });

  test('shows key bindings', () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame();
    expect(frame).toContain('Ctrl+C');
    expect(frame).toContain('中断运行 / 双按退出');
  });

  test('uses the shared command metadata for complete and accurate help', () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('/context');
    expect(frame).toContain('/rewind');
    expect(frame).toContain('/export');
    expect(frame).toContain('accept_edits/auto');
    expect(frame).not.toContain('ask/auto');
  });

  test('keeps full unavailable for the restricted-token backend', () => {
    const { lastFrame } = render(
      <HelpPanel onClose={noop} sandboxBackend="windows_restricted_token" />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('accept_edits/auto');
    expect(frame).not.toContain('accept_edits/auto/full');
  });

  test('shows close hint', () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    expect(lastFrame()).toContain('Esc 关闭');
  });
});

// ── ModelSelector ──

describe('ModelSelector', () => {
  test('renders title and model list', () => {
    const { lastFrame } = render(
      <ModelSelector
        currentModel="deepseek-chat"
        currentProvider="deepseek"
        onSelect={noop}
        onClose={noop}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('── 选择模型');
    expect(frame).not.toContain('◆ Kite Code');
    expect(frame).toContain('选择模型');
    expect(frame).toContain('deepseek-v4-flash');
  });

  test('marks the current model in the fixed status column', () => {
    const { lastFrame } = render(
      <ModelSelector
        currentModel="deepseek-v4-flash"
        currentProvider="deepseek"
        onSelect={noop}
        onClose={noop}
      />,
    );
    expect(lastFrame()).toContain('当前');
  });

  test('keeps a short list compact within the available overlay space', () => {
    const { lastFrame } = render(
      <Box flexDirection="column" height={20}>
        <ModelSelector
          currentModel="model-a"
          currentProvider="provider"
          models={[
            { provider: 'provider', name: 'model-a', isDefault: true },
            { provider: 'provider', name: 'model-b', isDefault: false },
          ]}
          onSelect={noop}
          onClose={noop}
        />
      </Box>,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const lastModelIndex = lines.findIndex((line) => line.includes('model-b'));
    const shortcutIndex = lines.findIndex((line) => line.includes('↑↓ 导航'));

    expect(lastModelIndex).toBeGreaterThan(-1);
    expect(shortcutIndex).toBeGreaterThan(lastModelIndex);
    expect(
      lines.slice(lastModelIndex + 1, shortcutIndex).filter((line) => line.trim() === ''),
    ).toHaveLength(1);
  });

  test('distinguishes same-named models from different providers', () => {
    const models = [
      { provider: 'deepseek', name: 'deepseek-v4-flash', isDefault: true },
      { provider: 'gateway', name: 'deepseek-v4-flash', isDefault: false },
    ];
    expect(new Set(models.map(modelOptionId)).size).toBe(models.length);

    const { lastFrame } = render(
      <ModelSelector
        currentModel="deepseek-v4-flash"
        currentProvider="gateway"
        models={models}
        onSelect={noop}
        onClose={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('deepseek');
    expect(frame).toContain('gateway');
    expect(frame).toContain('deepseek-v4-flash');
    expect(frame).not.toContain('default');
    expect(frame).toContain('当前');
    const lines = frame.split('\n');
    const deepseekLine = lines.findIndex((line) => line.trim() === 'deepseek');
    const gatewayLine = lines.findIndex((line) => line.trim() === 'gateway');
    const deepseekModelLine = lines[deepseekLine + 1] ?? '';
    const gatewayModelLine = lines[gatewayLine + 1] ?? '';
    expect(deepseekModelLine).toContain('deepseek-v4-flash');
    expect(lines[deepseekLine]?.indexOf('deepseek')).toBe(
      deepseekModelLine.indexOf('deepseek-v4-flash'),
    );
    expect(lines[gatewayLine - 1]?.trim()).toBe('');
    expect(gatewayModelLine).toContain('deepseek-v4-flash');
    expect(lines[gatewayLine]?.indexOf('gateway')).toBe(
      gatewayModelLine.indexOf('deepseek-v4-flash'),
    );
  });

  test('keeps model navigation reversible after scrolling through provider groups', async () => {
    const models = Array.from({ length: 20 }, (_, index) => ({
      provider: `provider-${Math.floor(index / 2)}`,
      name: `model-${index}`,
      isDefault: false,
    }));
    const selected: string[] = [];
    const { lastFrame, stdin } = render(
      <ModelSelector
        currentModel="model-0"
        currentProvider="provider-0"
        models={models}
        onSelect={(model) => selected.push(model.name)}
        onClose={noop}
      />,
    );

    for (let index = 0; index < 19; index++) stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastFrame()).toContain('model-19');
    stdin.write('\r');
    expect(selected).toEqual(['model-19']);

    const secondSelection: string[] = [];
    const secondRender = render(
      <ModelSelector
        currentModel="model-0"
        currentProvider="provider-0"
        models={models}
        onSelect={(model) => secondSelection.push(model.name)}
        onClose={noop}
      />,
    );
    for (let index = 0; index < 19; index++) secondRender.stdin.write('\u001b[B');
    for (let index = 0; index < 19; index++) secondRender.stdin.write('\u001b[A');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondRender.lastFrame()).toContain('provider-0');
    secondRender.stdin.write('\r');

    expect(secondSelection).toEqual(['model-0']);
  });

  test('shows navigation hints', () => {
    const { lastFrame } = render(
      <ModelSelector
        currentModel="deepseek-v4"
        currentProvider="deepseek"
        onSelect={noop}
        onClose={noop}
      />,
    );
    expect(lastFrame()).toContain('导航');
    expect(lastFrame()).toContain('Esc 关闭');
  });
});

// ── StartupScreen ──

describe('StartupScreen', () => {
  test('renders banner and model info', () => {
    const { lastFrame } = render(
      <StartupScreen modelName="claude-opus" workspace="/tmp/test-project" />,
    );
    const frame = lastFrame();
    expect(frame).toContain('kite code');
    expect(frame).toContain('claude-opus');
  });

  test('shows project name from workspace path', () => {
    const { lastFrame } = render(
      <StartupScreen modelName="deepseek" workspace="/tmp/my-project" />,
    );
    expect(lastFrame()).toContain('my-project');
  });

  test('shows workspace path', () => {
    const { lastFrame } = render(<StartupScreen modelName="gpt-4o" workspace="/tmp/my-project" />);
    expect(lastFrame()).toContain('/tmp/my-project');
  });

  test('shows help tips', () => {
    const { lastFrame } = render(<StartupScreen modelName="claude" workspace="/tmp/ws" />);
    const frame = lastFrame();
    expect(frame).toContain('Type your task and press Enter to start');
    expect(frame).toContain('/help');
  });
});

// ── ApprovalBlock ──

describe('ApprovalBlock', () => {
  test('renders the pending command as a separate approval subject', () => {
    const approval = fakeApproval({
      command: 'rm -rf /tmp/test',
      summary: 'Delete temp files',
      risk: 'destructive',
    });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('── Shell · 工具授权');
    expect(frame).toContain('│ rm -rf /tmp/test');
    const lines = frame.split('\n').map((line) => line.trim());
    expect(lines).not.toContain('执行命令');
    expect(lines).not.toContain('调用工具');
    expect(frame).not.toContain('● Bash');
    expect(frame).not.toContain('Delete temp files');
    expect(frame).not.toContain('destructive');
  });

  test('normalizes a multiline approval command inside the command block', () => {
    const approval = fakeApproval({
      command: 'bun run typecheck 2>\\\n  /tmp/typecheck.log',
    });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );

    expect(lastFrame()).toContain('│ bun run typecheck 2>\\ /tmp/typecheck.log');
  });

  test('shows three grant options', () => {
    const approval = fakeApproval();
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('允许一次');
    expect(frame).toContain('仅批准本次执行');
    expect(frame).toContain('本次会话允许');
    expect(frame).toContain('相同命令在本次会话中不再询问');
    expect(frame).toContain('拒绝');
    expect(frame).toContain('不执行命令并结束当前轮次');
  });

  test('keeps one blank row between the subject, every decision, and shortcuts', () => {
    const { lastFrame } = render(
      <ApprovalBlock approval={fakeApproval()} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const command = lines.findIndex((line) => line.includes('│ npm test'));
    const allowOnce = lines.findIndex((line) => line.includes('❯ 允许一次'));
    const allowSession = lines.findIndex((line) => line.includes('本次会话允许'));
    const deny = lines.findIndex((line) => line.trim() === '拒绝');
    const shortcuts = lines.findIndex((line) => line.includes('↑↓ 导航'));

    expect(lines[command + 1]?.trim()).toBe('');
    expect(lines[allowOnce + 2]?.trim()).toBe('');
    expect(lines[allowSession + 2]?.trim()).toBe('');
    expect(lines[deny + 2]?.trim()).toBe('');
    expect(lines[deny + 3]).toContain('─');
    expect(shortcuts).toBe(deny + 4);
  });

  test('uses a simple top divider instead of a rounded border', () => {
    const approval = fakeApproval();
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('── Shell · 工具授权');
    expect(frame).toContain('❯ 允许一次');
    expect(frame).toContain('────────────────────────────────────────');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');
    expect(frame).toContain('│ npm test');
  });

  test('non-shell tools only show grants declared by the approval payload', () => {
    const approval = fakeApproval({
      tool: 'write_file',
      grantOptions: ['approve_once'],
    });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('── 文件编辑 · 工具授权');
    expect(frame).toContain('允许一次');
    expect(frame).not.toContain('本次会话允许');
    expect(frame).toContain('拒绝');
  });

  test('recognizes raw terminal arrow sequences when selecting a grant', async () => {
    const resolved: Array<{ action: string; grant?: string }> = [];
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action, grant) => resolved.push({ action, grant })}
      />,
    );

    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(resolved).toEqual([{ action: 'approve', grant: 'same_command' }]);
  });
});

// ── InputBlock ──

describe('InputBlock', () => {
  test('renders question text', () => {
    const question = fakeQuestion({ question: 'What now?' });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain('What now?');
  });

  test('shows options list when options provided', () => {
    const question = fakeQuestion({
      options: [
        { id: 'a', label: 'Proceed', description: 'Continue forward' },
        { id: 'b', label: 'Abort', description: 'Stop here' },
      ],
    });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Proceed');
    expect(frame).toContain('Abort');
    const lines = (frame ?? '').split('\n');
    const titleRow = lines.findIndex((line) =>
      line.includes('── 需要你的回答 · Which approach do you prefer?'),
    );
    const firstOption = lines.findIndex((line) => line.includes('❯ 1. Proceed'));
    expect(firstOption).toBe(titleRow + 2);
    expect(lines[titleRow + 1]?.trim()).toBe('');
    expect(frame).not.toContain('? Which approach do you prefer?');
  });

  test('keeps the options list while rendering inline input for Other', async () => {
    const question = fakeQuestion({ allow_free_text: true });
    let resolved: string | undefined;
    const { lastFrame, stdin } = render(
      <InputBlock
        question={question}
        provider={fakeProvider()}
        onResolved={(answer) => {
          resolved = answer;
        }}
      />,
    );

    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastFrame()).toContain('Option A');
    expect(lastFrame()).toContain('Option B');
    expect(lastFrame()).toContain('其他（自定义输入）');

    stdin.write('my custom answer');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('my custom answer');
    expect(lastFrame()).toContain('Option A');
    expect(lastFrame()).toContain('Option B');

    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe('my custom answer');
  });

  test('shows free text input when no options', () => {
    const question = fakeQuestion({ options: [], allow_free_text: true });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain('>');
  });

  test('shows context when provided', () => {
    const question = fakeQuestion({ context: 'Here is some context' });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain('Here is some context');
  });

  test('shows Tab hint when free text is allowed', () => {
    const question = fakeQuestion({ allow_free_text: true });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain('Tab 自定义输入');
  });

  test('uses the shared borderless interaction frame and choice marker', () => {
    const question = fakeQuestion({ allow_free_text: true });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('── 需要你的回答');
    expect(frame).toContain('❯ 1.');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');
  });

  test('moves the inline custom input selection with Tab', async () => {
    const question = fakeQuestion({ allow_free_text: true });
    const { lastFrame, stdin } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );

    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('Tab 返回选项');
    expect(lastFrame()).toContain('其他（自定义输入）');
    expect(lastFrame()).toContain('Option A');

    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('Tab 自定义输入');
    expect(lastFrame()).toContain('❯ 1. Option A');
  });

  test('renders a single structured question without a step bar', () => {
    const question = fakeQuestion({
      questions: [
        {
          id: 'scope',
          question: 'Choose a scope',
          options: [{ id: 'small', label: 'Small' }],
          allow_free_text: true,
        },
      ],
    });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('── 需要你的回答 · Choose a scope');
    expect(frame).toContain('❯ 1. Small');
    expect(frame).not.toContain('1/1');
    expect(frame).not.toContain('✔ Submit');
    expect(frame.match(/Choose a scope/g)).toHaveLength(1);
  });

  test('hides the multi-question test prefix from the current title', () => {
    const question = fakeQuestion({
      questions: [
        {
          id: 'purpose',
          question: '多问题测试 2：当前项目 kite-code 的主要用途是什么？',
          options: [
            { id: 'dev', label: '软件开发', description: '用于开发软件。' },
            { id: 'docs', label: '文档管理', description: '用于管理文档。' },
          ],
          allow_free_text: true,
        },
      ],
    });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('── 需要你的回答 · 当前项目 kite-code 的主要用途是什么？');
    expect(frame).not.toContain('多问题测试 2：');
  });

  test('puts the current multi-question title in the frame and omits the step bar', () => {
    const question = fakeQuestion({
      question: 'Batch questions',
      questions: [
        {
          id: 'language',
          question: 'Choose language',
          options: [
            { id: 'ts', label: 'TypeScript', description: 'Use TypeScript.' },
            { id: 'py', label: 'Python', description: 'Use Python.' },
          ],
          allow_free_text: true,
        },
        {
          id: 'framework',
          question: 'Choose framework',
          options: [
            { id: 'react', label: 'React', description: 'Use React.' },
            { id: 'vue', label: 'Vue', description: 'Use Vue.' },
          ],
          allow_free_text: true,
        },
      ],
    });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('── 需要你的回答 · Choose language');
    expect(frame).toContain('1 / 2');
    expect(frame).not.toContain('? Batch questions');
    expect(frame).not.toContain('← ☐');
    expect(frame.match(/Choose language/g)).toHaveLength(1);
  });

  test('keeps the multi-question options list while entering inline custom input', async () => {
    const question = fakeQuestion({
      questions: [
        {
          id: 'first',
          question: 'First question',
          options: [{ id: 'one', label: 'First option' }],
          allow_free_text: true,
        },
        {
          id: 'second',
          question: 'Second question',
          options: [{ id: 'two', label: 'Second option' }],
          allow_free_text: true,
        },
      ],
    });
    const { lastFrame, stdin } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );

    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('First option');
    expect(lastFrame()).toContain('其他（自定义输入）');

    stdin.write('custom first answer');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('First option');
    expect(lastFrame()).toContain('custom first answer');

    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('需要你的回答 · Second question');
    expect(lastFrame()).toContain('Second option');
  });

  test('returns from single-question free-text mode to options with Tab', async () => {
    const question = fakeQuestion({
      questions: [
        {
          id: 'scope',
          question: 'Choose a scope',
          options: [{ id: 'small', label: 'Small' }],
          allow_free_text: true,
        },
      ],
    });
    const { lastFrame, stdin } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );

    expect(lastFrame()).toContain('── 需要你的回答 · Choose a scope');
    expect(lastFrame()).not.toContain('1/1');
    expect(lastFrame()).not.toContain('✔ Submit');

    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('Tab 返回选项');

    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('Tab 自定义输入');
  });
});

// ── PlanReviewBlock ──

function fakePlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    name: 'Test Plan',
    description: 'A test plan description',
    status: 'pending',
    steps: [
      { step: 'Step one', status: 'pending' },
      { step: 'Step two', status: 'pending' },
    ],
    ...overrides,
  };
}

describe('TaskProgressBlock', () => {
  test('renders nothing when steps is empty', () => {
    const plan = fakePlan({ steps: [] });
    const { lastFrame } = render(<TaskProgressBlock plan={plan} />);
    const frame = lastFrame();
    // 组件应返回 null — 输出中不存在任何步骤图标或步骤名称
    expect(frame).not.toContain('Step one');
    expect(frame).not.toContain('✓');
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('○');
  });

  test('renders step icons matching status', () => {
    const plan = fakePlan({
      steps: [
        { step: 'Done step', status: 'completed' },
        { step: 'Active step', status: 'in_progress' },
        { step: 'Waiting step', status: 'pending' },
      ],
    });
    const { lastFrame } = render(<TaskProgressBlock plan={plan} />);
    const frame = lastFrame();
    expect(frame).toContain('✓');
    expect(frame).toContain('●');
    expect(frame).toContain('○');
  });

  test('renders step names in order', () => {
    const plan = fakePlan({
      steps: [
        { step: 'First step', status: 'completed' },
        { step: 'Second step', status: 'pending' },
      ],
    });
    const { lastFrame } = render(<TaskProgressBlock plan={plan} />);
    const frame = lastFrame() ?? '';
    const firstIdx = frame.indexOf('First step');
    const secondIdx = frame.indexOf('Second step');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

describe('PlanReviewBlock', () => {
  test('renders three options with recommended tag', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock plan={plan} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('在 Auto 模式下开始执行');
    expect(frame).toContain('在接受编辑模式下开始执行');
    expect(frame).toContain('（推荐）');
    expect(frame).toContain('携带反馈继续规划');
  });

  test('shows option descriptions', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock plan={plan} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('自动审核非破坏性操作');
    expect(frame).toContain('输入反馈，让方案继续调整');
  });

  test('shows quick key hint', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock plan={plan} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain('↑↓ 导航');
    expect(lastFrame()).toContain('Enter 确认');
    expect(lastFrame()).toContain('Esc 取消');
  });

  test('notifies the UI when a review option is selected', () => {
    const resolved: string[] = [];
    const { stdin } = render(
      <PlanReviewBlock
        plan={fakePlan()}
        provider={fakeProvider()}
        onResolved={(action) => resolved.push(action)}
      />,
    );

    stdin.write('\r');

    expect(resolved).toEqual(['approved_auto']);
  });

  test('submits plan feedback exactly once', async () => {
    const resolved: Array<{ action: string; feedback?: string }> = [];
    const { stdin } = render(
      <PlanReviewBlock
        plan={fakePlan()}
        provider={fakeProvider()}
        onResolved={(action, feedback) => resolved.push({ action, feedback })}
      />,
    );

    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write('Please revise');
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(resolved).toEqual([{ action: 'supplemented', feedback: 'Please revise' }]);
  });

  test('renders plan review confirmation bar', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock
        plan={plan}
        artifact={{
          artifactId: 'artifact-1',
          taskId: 'task-1',
          planId: 'plan-1',
          version: 1,
          fileName: 'v1.md',
          relativePath: '.kite-code/plans/task-1/plan-1/v1.md',
          displayPath: '/Users/test/.kite-code/plans/task-1/plan-1/v1.md',
          structuralDigest: 'digest-1',
          byteLength: 100,
        }}
        provider={fakeProvider()}
        onResolved={onResolved}
      />,
    );
    const frame = lastFrame();
    // 方案内容移至 OutputArea tool_card Markdown 渲染，Footer 仅显示确认操作条
    // Plan content moved to OutputArea tool_card Markdown; Footer only shows confirmation bar
    expect(frame).toContain('请审核上方方案');
    expect(frame).toContain('在 Auto 模式下开始执行');
    expect(frame).toContain('在接受编辑模式下开始执行');
    expect(frame).toContain('携带反馈继续规划');
    expect(frame).not.toContain('Plan document:');
  });

  test('uses the shared borderless frame and choice list', () => {
    const { lastFrame } = render(
      <PlanReviewBlock plan={fakePlan()} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('── 方案审核');
    expect(frame).toContain('❯ 1.');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');
  });
});

// ── InputLine plan mode ──

describe('InputLine plan mode', () => {
  test('shows plan name in top separator when planMode=true', () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" planMode={true} onSubmit={noop} workspace="/test" />,
    );
    const frame = lastFrame();
    // Plan name is embedded at the right of the top separator (lowercase)
    expect(frame).toContain('plan');
    // Bottom separator and prompt remain normal
    expect(frame).not.toContain('Shift+Tab');
  });

  test('shows custom planName in top separator', () => {
    const { lastFrame } = render(
      <InputLine
        mode="prompt"
        planMode={true}
        planName="my-feature"
        onSubmit={noop}
        workspace="/test"
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('my-feature');
  });

  test('shows normal prompt when planMode=false', () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" planMode={false} onSubmit={noop} workspace="/test" />,
    );
    const frame = lastFrame();
    expect(frame).toContain('❯');
    // No plan text in separators
    expect(frame).not.toContain('plan');
  });
});

// ── InputLine ──

describe('InputLine', () => {
  test('renders prompt for prompt mode', () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain('❯');
  });

  test('renders [A/S/F/D] for approval mode', () => {
    const { lastFrame } = render(
      <InputLine mode="approval" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain('select');
  });

  test('renders ? for question mode', () => {
    const { lastFrame } = render(
      <InputLine mode="question" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain('?');
  });

  test('shows disabled message when disabled', () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" onSubmit={noop} disabled workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain('Waiting for response...');
  });

  test('shows placeholder text', () => {
    const { lastFrame } = render(
      <InputLine
        mode="prompt"
        onSubmit={noop}
        placeholder="Type here..."
        workspace={process.cwd()}
      />,
    );
    expect(lastFrame()).toContain('Type here...');
  });
});

// ── OutputArea ──

// Test wrapper: bridges old OutputArea API (running + turns) to the OutputArea component.
function OutputAreaTestWrap({
  running,
  turns,
  onToggleReason,
  awaitingApproval = false,
}: {
  running: boolean;
  turns: { blocks: OutputBlock[] }[];
  onToggleReason: () => void;
  awaitingApproval?: boolean;
}) {
  const {
    staticItems,
    staticKey,
    header: staticHeader,
    mergedStaticBlocks,
    activeDynamicBlocks,
  } = useStaticContent({
    turns: turns as Turn[],
    running,
    sessionKey: 0,
    header: null,
  });
  return (
    <OutputArea
      staticItems={staticItems}
      staticKey={staticKey}
      staticHeader={staticHeader}
      activeDynamicBlocks={activeDynamicBlocks}
      mergedStaticBlocks={mergedStaticBlocks}
      onToggleReason={onToggleReason}
      awaitingApproval={awaitingApproval}
      columns={80}
    />
  );
}

describe('successor turn rendering', () => {
  test('keeps a successor shell card dynamic after the previous turn was cancelled', () => {
    const cancelled: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'cancelled-shell',
      name: 'shell_execute',
      args: { command: 'curl old' },
      status: 'cancelled',
      summary: 'Cancelled',
    };
    const successor: OutputBlock = {
      id: 3,
      kind: 'tool_card',
      callId: 'successor-shell',
      name: 'shell_execute',
      args: { command: 'curl new' },
      status: 'running',
      summary: '',
      preview: 'curl new',
      startedAt: Date.now(),
      liveOutput: 'first live line',
    };
    const view = render(
      <OutputAreaTestWrap
        running={false}
        turns={[{ blocks: [cancelled] }]}
        onToggleReason={noop}
      />,
    );

    view.rerender(
      <OutputAreaTestWrap
        running={true}
        turns={[
          { blocks: [cancelled] },
          { blocks: [{ id: 2, kind: 'user', content: '请继续' }, successor] },
        ]}
        onToggleReason={noop}
      />,
    );

    expect(view.lastFrame()).toContain('first live line');

    view.rerender(
      <OutputAreaTestWrap
        running={true}
        turns={[
          { blocks: [cancelled] },
          {
            blocks: [
              { id: 2, kind: 'user', content: '请继续' },
              { ...successor, liveOutput: 'second live line' },
            ],
          },
        ]}
        onToggleReason={noop}
      />,
    );

    expect(view.lastFrame()).toContain('second live line');
    expect(view.lastFrame()).not.toContain('first live line');
  });
});

describe('BlockRenderer', () => {
  test('renders text block', () => {
    const block: OutputBlock = { id: 1, kind: 'text', content: 'Hello world' };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toContain('Hello world');
  });

  test('renders user block', () => {
    const block: OutputBlock = { id: 1, kind: 'user', content: 'ls -la' };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toContain('ls -la');
  });

  test('renders a rejected shell approval as one cancelled status line', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'shell-rejected',
      name: 'shell_execute',
      args: { command: 'echo should-not-run' },
      status: 'cancelled',
      summary: 'Tool approval cancelled by user.',
      expanded: true,
    };
    const frame =
      render(
        <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
      ).lastFrame() ?? '';

    expect(frame).toContain('Tool approval cancelled by user.');
    expect(frame).not.toContain('exit:');
    expect(frame.split('Tool approval cancelled by user.')).toHaveLength(2);
  });

  test('limits a large user message to thirty content lines while keeping both ends', () => {
    const content = Array.from({ length: 40 }, (_, index) => `line-${index}`).join('\n');
    const block: OutputBlock = { id: 1, kind: 'user', content };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const lines = visibleUserMessageLines(content, 80);
    expect(lines).toHaveLength(MAX_USER_MESSAGE_LINES + 1);
    expect(lines.filter((line) => !line.startsWith('【已省略 '))).toHaveLength(
      MAX_USER_MESSAGE_LINES,
    );
    expect(lines[0]).toContain('line-0');
    expect(lines.at(-1)).toBe('line-39');
    expect(lines).toContain('【已省略 10 行】');
    expect(lines).not.toContain('');
    expect(lastFrame()).toContain('❯ line-0');
    expect(lastFrame()).toContain('【已省略 10 行】');
    expect(lastFrame()).toContain('line-39');
  });

  test('renders reason block as null (hidden)', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'reason',
      content: 'thinking',
      folded: false,
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toBe('');
  });

  test('renders running tool_card', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'read_file',
      args: {},
      status: 'running',
      summary: '',
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toContain('Read');
  });

  test('renders queued tool_card as waiting instead of spinning', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'bun test' },
      status: 'queued',
      summary: '',
      preview: 'bun test',
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame();
    expect(frame).toContain('Bash');
    expect(frame).toContain('(queued)');
    expect(frame).not.toContain('⠋');
  });

  test('running tool_card renders the initial spinner frame', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'sleep 1' },
      status: 'running',
      summary: '',
      startedAt: Date.now(),
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    expect(lastFrame()).toContain('●');
  });

  test('running shell tool_card renders liveOutput', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'echo hello' },
      status: 'running',
      summary: '',
      startedAt: Date.now(),
      liveOutput: 'hello world',
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame();
    expect(frame).toContain('Bash');
    expect(frame).toContain('⎿   hello world');
  });

  test('renders all structured answers for a completed five-question ask_user card', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'ask-1',
      name: 'ask_user',
      args: {
        questions: [
          { id: 'scope', question: 'Scope?' },
          { id: 'priority', question: 'Priority?' },
          { id: 'timeline', question: 'Timeline?' },
          { id: 'owner', question: 'Owner?' },
          { id: 'rollout', question: 'Rollout?' },
        ],
      },
      status: 'done',
      summary: '',
      expanded: true,
      userInput: {
        answer: 'Small scope',
        answers: {
          scope: 'Small scope',
          priority: 'Reliability',
          timeline: 'This week',
          owner: 'Platform team',
          rollout: 'Staged rollout',
        },
      },
    };

    const { lastFrame } = render(
      <BlockRenderer columns={120} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    for (const label of [
      'Small scope',
      'Reliability',
      'This week',
      'Platform team',
      'Staged rollout',
    ]) {
      expect(frame).toContain(label);
    }
    expect(frame).not.toContain('(no answer)');
    expect(frame).not.toContain('Step1');
    expect(frame).not.toContain('Step2');
  });

  test('uses question indexes for structured ask_user answers without explicit IDs', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'ask-2',
      name: 'ask_user',
      args: {
        questions: [{ question: 'First?' }, { question: 'Second?' }],
      },
      status: 'done',
      summary: '',
      expanded: true,
      userInput: {
        answer: 'First answer',
        answers: { '0': 'First answer', '1': 'Second answer' },
      },
    };

    const { lastFrame } = render(
      <BlockRenderer columns={120} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('First answer');
    expect(frame).toContain('Second answer');
    expect(frame).not.toContain('(no answer)');
    expect(frame).not.toContain('Step1');
    expect(frame).not.toContain('Step2');
  });

  test('renders a single structured ask_user answer without a step prefix', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'ask-single',
      name: 'ask_user',
      args: { questions: [{ id: 'scope', question: 'Scope?' }] },
      status: 'done',
      summary: '',
      expanded: true,
      userInput: { answer: 'Small scope', answers: { scope: 'Small scope' } },
    };

    const { lastFrame } = render(
      <BlockRenderer columns={120} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Scope?');
    expect(frame).toContain('Small scope');
    expect(frame).not.toContain('Step1');
  });

  test('retains plain-text summary fallback for ask_user answers', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'ask-legacy',
      name: 'ask_user',
      args: {
        questions: [
          { id: 'first', question: 'First?' },
          { id: 'second', question: 'Second?' },
        ],
      },
      status: 'done',
      summary: 'first: Legacy first\nsecond: Legacy second',
      expanded: true,
    };

    const { lastFrame } = render(
      <BlockRenderer columns={120} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Legacy first');
    expect(frame).toContain('Legacy second');
    expect(frame).not.toContain('(no answer)');
  });

  test('renders ask_user schema failures as errors instead of user answers', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'ask-invalid',
      name: 'ask_user',
      args: {
        questions: [{ question: 'Choose a scope?' }],
      },
      status: 'error',
      summary: 'questions.0.options: Too big: expected array to have <=3 items',
      expanded: true,
    };

    const { lastFrame } = render(
      <BlockRenderer columns={120} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('questions.0.options: Too big');
    expect(frame).not.toContain('User:');
    expect(frame).not.toContain('(no answer)');
  });

  test('timed out shell tool_card does not render as exit error', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'npm run tui' },
      status: 'timeout',
      summary: Array.from({ length: 12 }, (_, i) => `startup line ${i + 1}`).join('\n'),
      elapsedMs: 10_000,
      timeoutMs: 5000,
      expanded: true,
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame();
    expect(frame).toContain('startup line 1');
    expect(frame).toContain('startup line 12');
    expect(frame).toContain('… +2 lines');
    expect(frame).toContain('timed out after 5000ms');
    expect(frame).not.toContain('exit: error');
  });

  test('cancelled shell tool_card keeps its command and renders only a cancelled footer', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'bun test' },
      status: 'cancelled',
      summary: 'Cancelled',
      detail: 'Ran: bun test',
      expanded: true,
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ran: bun test');
    expect(frame).toContain('cancelled');
    expect(frame).not.toContain('exit: 0');
    expect(frame.match(/Cancelled/g) ?? []).toHaveLength(0);
  });

  test('collapsed cancelled shell keeps its terminal footer visible without expanding output', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'curl https://example.test' },
      status: 'cancelled',
      summary: 'Cancelled',
      detail: 'Ran: curl https://example.test',
      liveOutput: 'partial response body',
      expanded: false,
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ran: curl https://example.test');
    expect(frame).toContain('cancelled');
    expect(frame).not.toContain('partial response body');
  });

  test('expanded cancelled shell retains live output above its terminal footer', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'c1',
      name: 'shell_execute',
      args: { command: 'curl https://example.test' },
      status: 'cancelled',
      summary: 'Cancelled',
      detail: 'Ran: curl https://example.test',
      liveOutput: 'partial response body',
      expanded: true,
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('partial response body');
    expect(frame).toContain('cancelled');
  });

  test('live and replay cancellation render the same collapsed shell outcome', () => {
    const activeCard: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'shell-1',
      name: 'shell_execute',
      args: { command: 'curl https://example.test' },
      status: 'running',
      summary: '',
      detail: 'Ran: curl https://example.test',
      liveOutput: 'partial response body',
      expanded: false,
    };
    const initial: TuiState = {
      ...createInitialState(),
      running: true,
      turns: [{ blocks: [activeCard] }],
      nextBlockId: 2,
    };

    const live = eventReducer(initial, { type: 'ESCAPE' });
    let replay = eventReducer(initial, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'tool.cancelled',
        toolCallId: 'shell-1',
        reason: 'Cancelled by user.',
      },
    });
    replay = eventReducer(replay, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'turn.aborted',
        turnId: 'turn-1',
        reason: 'Cancelled by user.',
        cause: 'user',
      },
    });

    const liveCard = live.turns[0]!.blocks[0]!;
    const replayCard = replay.turns[0]!.blocks[0]!;
    expect(replayCard).toEqual(liveCard);
    const liveRender = render(
      <BlockRenderer columns={80} block={liveCard} isFocused={false} index={0} />,
    );
    const replayRender = render(
      <BlockRenderer columns={80} block={replayCard} isFocused={false} index={0} />,
    );

    expect(replayRender.lastFrame()).toBe(liveRender.lastFrame());
    expect(liveRender.lastFrame()).toContain('cancelled');
  });
  test('file_change block is rendered by tool_card, not BlockRenderer', () => {
    // sandbox 合并后 file_change 由 tool_card 渲染，BlockRenderer 返回 null
    const block: OutputBlock = {
      id: 1,
      kind: 'file_change',
      changes: [{ path: 'src/a.ts', kind: 'add', linesAdded: 5 }],
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    // BlockRenderer 返回 null，输出为空
    expect(lastFrame()).toBe('');
  });

  test('question block is rendered by tool_card, not BlockRenderer', () => {
    // sandbox 合并后 question 由 tool_card 渲染，BlockRenderer 返回 null
    const block: OutputBlock = {
      id: 1,
      kind: 'question',
      question: { question: 'hello', options: [], allow_free_text: true },
      resolved: 'yes',
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    // BlockRenderer 返回 null，输出为空
    expect(lastFrame()).toBe('');
  });

  test('renders subagent block', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'subagent',
      subagentId: 's1',
      role: 'explore',
      task: 'find files',
      status: 'done',
      summary: 'Found 3 files',
      toolCallCount: 2,
      durationMs: 500,
      steps: [],
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toContain('find files');
  });

  test('collapses settled tool_summary errors to the summary line', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_summary',
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'searched 1 file pattern',
      active: false,
      hasThought: false,
      tools: [
        {
          callId: 'c1',
          name: 'search_files',
          args: { pattern: 'package.json' },
          ok: false,
          summary: 'search command failed',
          status: 'error',
        },
      ],
    };
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );

    expect(lastFrame()).toContain('searched 1 file pattern');
    expect(lastFrame()).not.toContain('Find package.json');
    expect(lastFrame()).not.toContain('search command failed');
  });

  test('phase block renders confirmed captions and pending caption at the top (ADR-0030)', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      createdAt: Date.now() - 13000,
      totalElapsedMs: 13000,
      modelMs: 13000,
      summaryLine: 'read 2 files',
      hasThought: true,
      hasThinking: true,
      captions: ['让我系统地阅读 TUI 模块的核心文件。'],
      pendingCaption: 'Now the remaining pieces.',
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          ok: true,
          summary: 'ok',
          status: 'done',
        },
        {
          callId: 'c2',
          name: 'read_file',
          args: { path: 'src/app/tui/types.ts' },
          ok: false,
          summary: '',
          status: 'running',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    // 标题行 = 累加时长 + 合并统计；旁白位于标题之下、步骤树之上
    expect(frame).toContain('Thought for 13s · read 2 files');
    expect(frame).toContain('让我系统地阅读 TUI 模块的核心文件。');
    expect(frame).toContain('Now the remaining pieces.');
    const captionIdx = frame.indexOf('让我系统地阅读');
    const headerIdx = frame.indexOf('Thought for 13s');
    const stepsIdx = frame.indexOf('Read App.tsx');
    expect(captionIdx).toBeGreaterThan(headerIdx);
    expect(captionIdx).toBeLessThan(stepsIdx);
  });

  test('Thinking phase shows the active reasoning preview', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: {
        kind: 'thinking',
        text: 'checking current Thought boundaries',
      },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'thinking',
      hasThought: true,
      tools: [],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thought for 1s');
    expect(frame).toContain('checking current Thought boundaries');
    expect(frame).not.toContain('├─ Read');
  });

  test('awaiting-terminal Thought collapses details as soon as answer text starts', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      responsePending: true,
      latestActivity: {
        kind: 'thinking',
        text: 'the complete reasoning stream appears atomically',
      },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'thinking',
      hasThought: true,
      hasThinking: true,
      tools: [
        {
          callId: 'read-1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          status: 'done',
          ok: true,
          summary: 'Read App.tsx',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thought for 1s');
    expect(frame).not.toContain('the complete reasoning stream appears atomically');
    expect(frame).not.toContain('Read App.tsx');
    expect(frame).not.toContain('●');
  });

  test('Thought activity window shows the first five reasoning lines and an ellipsis', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: {
        kind: 'thinking',
        text: 'reason one\nreason two\nreason three\nreason four\nreason five\nreason six',
      },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'thinking',
      hasThought: true,
      hasThinking: true,
      tools: [],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const frame =
      render(
        <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
      ).lastFrame() ?? '';

    for (const line of ['one', 'two', 'three', 'four', 'five']) {
      expect(frame).toContain(`reason ${line}`);
    }
    expect(frame).not.toContain('reason six');
    expect(frame).toContain('...');
  });

  test('Thought activity window removes blank lines before taking the head', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: {
        kind: 'thinking',
        text: [
          'kept first line',
          '',
          '   ',
          'kept second line   ',
          '',
          'kept third line',
          'kept fourth line',
          '',
          'kept fifth line',
          'discarded sixth line',
          '',
        ].join('\n'),
      },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'thinking',
      hasThought: true,
      hasThinking: true,
      tools: [],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const frame =
      render(
        <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
      ).lastFrame() ?? '';

    for (const line of ['first', 'second', 'third', 'fourth', 'fifth']) {
      expect(frame).toContain(`kept ${line} line`);
    }
    expect(frame).not.toContain('discarded sixth line');
    expect(frame).toContain('...');
    expect(frame).not.toMatch(/\n\s*\n/u);
  });

  test('latest tool activity replaces the reasoning window', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: { kind: 'tool', callId: 'c1' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
      hasThought: true,
      hasThinking: true,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'README.md' },
          ok: false,
          summary: '',
          status: 'running',
        },
      ],
      timeline: [{ seq: 1, kind: 'thinking', text: 'reasoning must be hidden' }],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const frame =
      render(
        <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
      ).lastFrame() ?? '';

    expect(frame).toContain('└─ Read README.md');
    expect(frame).not.toContain('reasoning must be hidden');
  });

  test('keeps running tool_summary thinking preview when latest visible activity is a tool', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: {
        kind: 'thinking',
        text: 'reviewing the project conventions',
      },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 3 files',
      hasThought: true,
      hasThinking: true,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'package.json' },
          ok: true,
          summary: 'ok',
          status: 'done',
        },
        {
          callId: 'c2',
          name: 'read_file',
          args: { path: 'CLAUDE.md' },
          ok: true,
          summary: 'ok',
          status: 'done',
        },
        {
          callId: 'c3',
          name: 'read_file',
          args: { path: 'README.md' },
          ok: false,
          summary: '',
          status: 'running',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('reviewing the project conventions');
    expect(frame).not.toContain('Read README.md');
    // 思考块标题 = "Thought for Xs · <工具统计>"（· 分隔，规则 22）
    expect(frame).toContain('Thought for 1s · read 3 files');
  });

  test('thinking block header appends tool stats and truncates them to fit narrow terminals', () => {
    const tools = ['README.md', 'package.json', 'CLAUDE.md'].map((path, i) => ({
      callId: `c${i + 1}`,
      name: 'read_file',
      args: { path },
      ok: true,
      summary: 'ok',
      status: 'done' as const,
    }));
    const wide = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      createdAt: Date.now() - 2000,
      totalElapsedMs: 2000,
      summaryLine: 'read 3 files, searched for 2 patterns',
      hasThought: true,
      hasThinking: true,
      result: 'done' as const,
      tools,
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;

    // 宽终端：完整后缀 "Thought for Xs · <统计>"
    const wideFrame =
      render(
        <BlockRenderer columns={100} block={wide} isFocused={false} index={0} />,
      ).lastFrame() ?? '';
    expect(wideFrame).toContain('  Thought for 2s · read 3 files, searched for 2 patterns');
    expect(wideFrame).not.toContain('●');

    // 窄终端：前缀完整保留，统计后缀按宽度截断（… 省略号）
    const narrowFrame =
      render(<BlockRenderer columns={40} block={wide} isFocused={false} index={0} />).lastFrame() ??
      '';
    expect(narrowFrame).toContain('Thought for 2s · read 3 files, search…');
    expect(narrowFrame).not.toContain('searched for 2 patterns');

    // 极窄终端：后缀整体省略，不留孤悬分隔符
    const tinyFrame =
      render(<BlockRenderer columns={18} block={wide} isFocused={false} index={0} />).lastFrame() ??
      '';
    expect(tinyFrame).toContain('Thought for 2s');
    expect(tinyFrame).not.toContain('●');
  });

  test('renders running tool_summary tree without duplicating latest tool preview', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: { kind: 'tool', callId: 'c1' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
      hasThought: false,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'CLAUDE.md', start: 1, end: 126, totalLines: 126 },
          ok: true,
          summary: 'ok',
          status: 'done',
          totalLines: 126,
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('└─ Read CLAUDE.md [lines 1-126 / 126]');
    expect(frame).not.toContain('└─ 运行中');
    expect(frame).not.toContain('\n   Read CLAUDE.md');
  });

  test('latest reasoning activity hides tool steps and uses the full activity window', () => {
    const longThought =
      'this is a very long thinking preview that should not spill across the entire terminal width';
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: { kind: 'thinking', text: longThought },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
      hasThought: true,
      hasThinking: true,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          ok: false,
          summary: '',
          status: 'running',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={50} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('this is a very long thinking');
    expect(frame).not.toContain('运行中');
    expect(frame).not.toContain('Read App.tsx');
  });

  test('shows active reasoning while the cycle continues', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: {
        kind: 'thinking',
        text: 'still thinking after tools done',
      },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
      hasThought: true,
      hasThinking: true,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          ok: true,
          summary: 'ok',
          status: 'done',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('still thinking after tools done');
    expect(frame).not.toContain('Read App.tsx');
  });

  test('keeps only the Thought summary after a tool_summary settles', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      latestActivity: { kind: 'thinking', text: 'hidden after settle' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
      hasThought: true,
      hasThinking: true,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          ok: true,
          summary: 'ok',
          status: 'done',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('  Thought for 1s · read 1 file');
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('hidden after settle');
    expect(frame).not.toContain('Read App.tsx');
    expect(frame).not.toContain('└─ 完成');
  });

  test('settled non-thinking tool summary removes its activity dot', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
      hasThought: false,
      hasThinking: false,
      result: 'done' as const,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          ok: true,
          summary: 'ok',
          status: 'done',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );

    expect(lastFrame()).toContain('  read 1 file');
    expect(lastFrame()).not.toContain('●');
  });

  test('settled pure-thinking Thought hides reasoning and has no status dot', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      createdAt: Date.now() - 3000,
      totalElapsedMs: 3000,
      summaryLine: 'thinking',
      hasThought: true,
      hasThinking: true,
      result: 'done' as const,
      tools: [],
      timeline: [{ seq: 1, kind: 'thinking' as const, text: 'hidden after settle' }],
      nextTimelineSeq: 2,
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    // 单行形态：只有 "Thought for 3s"，无圆点、无步骤树、无 footer
    expect(frame).toContain('Thought for 3s');
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('hidden after settle');
    expect(frame).not.toContain('完成');
    // ● 保留给有状态的行；纯思考 settle 后无状态，不渲染圆点，
    // 但保留两个空格列位，文字起始列与工具块名字列对齐
    expect(frame).toContain('  Thought for 3s');
    expect(frame.split('\n').filter((l) => l.trim())).toHaveLength(1);
  });

  test('text block with thoughtElapsedMs renders merged Thought header above content (ADR-0026)', () => {
    const block = {
      id: 1,
      kind: 'text',
      content: '── TUI 模块全面解析 ──',
      thoughtElapsedMs: 24_000,
      thoughtContent: 'internal reasoning must stay hidden',
    } as Extract<OutputBlock, { kind: 'text' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    // 题头 + 正文同一块：无圆点，中间固定保留一行
    expect(frame).toContain('Thought for 24s');
    expect(frame).toContain('── TUI 模块全面解析 ──');
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('internal reasoning must stay hidden');
    const lines = frame.split('\n');
    const headerIndex = lines.findIndex((line) => line.includes('Thought for 24s'));
    const contentIndex = lines.findIndex((line) => line.includes('TUI 模块全面解析'));
    expect(contentIndex - headerIndex).toBe(2);
    // 题头两空格缩进，文字起始列与工具块名字列对齐
    expect(frame).toContain('  Thought for 24s');
  });

  test('text block without thoughtElapsedMs renders no Thought header', () => {
    const block = {
      id: 1,
      kind: 'text',
      content: 'plain answer',
    } as Extract<OutputBlock, { kind: 'text' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame() ?? '').not.toContain('Thought for');
  });

  test('running pure-thinking Thought shows the blink dot without a running footer', async () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: { kind: 'thinking', text: 'reviewing the layout rules' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'thinking',
      hasThought: true,
      hasThinking: true,
      tools: [],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );

    // 进行中首帧显示实心 ●（颜色为主题暗 dt.dim，ink-testing-library
    // 剥离 ANSI 颜色码），与 settle 白点同位置同宽度，无列位移
    expect(lastFrame()).toContain('● Thought for 1s');
    expect(lastFrame()).toContain('reviewing the layout rules');
    expect(lastFrame()).not.toContain('├─ Thinking');
    expect(lastFrame()).not.toContain('运行中');

    // 显隐闪烁：约 1000ms 后圆点隐藏（渲染为两个空格，行宽不变）
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(lastFrame()).not.toContain('●');
    expect(lastFrame()).toContain('Thought for 1s');
  });

  test('stops showing running Thought state after a boundary even if a tool is still pending', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      latestActivity: { kind: 'tool', callId: 'c1' },
      createdAt: Date.now() - 10_000,
      totalElapsedMs: 1200,
      summaryLine: 'read 1 file',
      hasThought: false,
      tools: [
        {
          callId: 'c1',
          name: 'read_file',
          args: { path: 'src/app/tui/App.tsx' },
          ok: false,
          summary: '',
          status: 'running',
        },
      ],
    } as Extract<OutputBlock, { kind: 'tool_summary' }>;
    const { lastFrame } = render(
      <BlockRenderer columns={100} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('read 1 file');
    expect(frame).not.toContain('等待工具结果');
    expect(frame).not.toContain('运行中');
    expect(frame).not.toContain('10s');
  });
});

describe('Block spacing', () => {
  /**
   * Helper: render two blocks and check there's exactly 1 blank line between them.
   */
  function assertGap(prev: OutputBlock, next: OutputBlock, expectedGap: number) {
    const blocks: OutputBlock[] = [prev, next];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    // Find last content line of prev block and first content line of next block
    // Use a unique marker for each block
    const markers = getBlockMarkers(blocks);
    expect(markers.length).toBe(2);
    const firstIdx = lines.findIndex((l) => l.includes(markers[0]!));
    const secondIdx = lines.findIndex((l) => l.includes(markers[1]!));
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);

    const gap = secondIdx - firstIdx - 1;
    if (gap !== expectedGap) {
      throw new Error(
        `${prev.kind}\u2192${next.kind}: expected ${expectedGap} blank line(s), got ${gap}\n` +
          lines
            .slice(Math.max(0, firstIdx - 1), secondIdx + 2)
            .map((l, _j) => l || '(empty)')
            .join('\n'),
      );
    }
  }

  /** Get a unique content marker for each block to locate it in output */
  function getBlockMarkers(blocks: (OutputBlock & { _marker?: string })[]): string[] {
    return blocks.map((b, i) => b._marker ?? `__BLOCK_${i}__`);
  }

  test('user → text', () => {
    assertGap(
      {
        id: 1,
        kind: 'user',
        content: 'hello world',
        _marker: 'hello world',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'text',
        content: '__BLOCK_1__',
        _marker: '__BLOCK_1__',
      } as unknown as OutputBlock,
      1,
    );
  });

  test('text → tool_card', () => {
    assertGap(
      {
        id: 1,
        kind: 'text',
        content: '__BLOCK_0__',
        _marker: '__BLOCK_0__',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'tool_card',
        callId: 'c1',
        name: 'read_file',
        args: {},
        status: 'done',
        summary: 'done',
        _marker: 'Read',
      } as unknown as OutputBlock,
      1,
    );
  });

  test('tool_card → tool_card', () => {
    assertGap(
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c1',
        name: 'tool_a',
        args: {},
        status: 'done',
        summary: 'ok',
        _marker: 'tool_a',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'tool_card',
        callId: 'c2',
        name: 'tool_b',
        args: {},
        status: 'done',
        summary: 'ok',
        _marker: 'tool_b',
      } as unknown as OutputBlock,
      1,
    );
  });

  test('tool_card → text', () => {
    assertGap(
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c1',
        name: 'shell_execute',
        args: {},
        status: 'done',
        summary: 'result',
        _marker: 'exit: 0',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'text',
        content: '__BLOCK_1__',
        _marker: '__BLOCK_1__',
      } as unknown as OutputBlock,
      1,
    );
  });

  // file_change 由 tool_card 渲染，BlockRenderer 返回 null，间距测试已不适用。
  // file_change is rendered by tool_card, BlockRenderer returns null — spacing is covered by tool_card tests.
  test('text → file_change is no‑op (file_change rendered by tool_card)', () => {
    // file_change 不再通过 BlockRenderer 渲染，应在 tool_card 之间验证间距
    assertGap(
      {
        id: 1,
        kind: 'text',
        content: '__BLOCK_0__',
        _marker: '__BLOCK_0__',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'tool_card',
        callId: 'c-fc',
        name: 'read_file',
        args: {},
        status: 'done',
        summary: 'done',
        _marker: 'Read',
      } as unknown as OutputBlock,
      1,
    );
  });

  // file_change 由 tool_card 渲染，BlockRenderer 返回 null，间距测试已不适用。
  test('tool_card (as file_change) → text', () => {
    assertGap(
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c-fc2',
        name: 'read_file',
        args: {},
        status: 'done',
        summary: 'done',
        _marker: 'Read',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'text',
        content: '__BLOCK_1__',
        _marker: '__BLOCK_1__',
      } as unknown as OutputBlock,
      1,
    );
  });

  test('subagent → text', () => {
    assertGap(
      {
        id: 1,
        kind: 'subagent',
        subagentId: 's1',
        role: 'explore',
        task: 'find',
        status: 'done',
        summary: 'ok',
        toolCallCount: 1,
        durationMs: 100,
        steps: [],
        _marker: 'find',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'text',
        content: '__BLOCK_1__',
        _marker: '__BLOCK_1__',
      } as unknown as OutputBlock,
      2, // subagent status line adds one extra line between header marker and next block
    );
  });

  test('slash command user → text (tight)', () => {
    assertGap(
      {
        id: 1,
        kind: 'user',
        content: '/theme blue',
        _marker: '/theme blue',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'text',
        content: '__SLASH_RSLT__',
        _marker: '__SLASH_RSLT__',
      } as unknown as OutputBlock,
      0,
    );
  });

  test('consecutive slash command user blocks keep the normal gap', () => {
    assertGap(
      {
        id: 1,
        kind: 'user',
        content: '/compact first',
        _marker: '/compact first',
      } as unknown as OutputBlock,
      {
        id: 2,
        kind: 'user',
        content: '/compact second',
        _marker: '/compact second',
      } as unknown as OutputBlock,
      1,
    );
  });

  test('consecutive text in same block has 1-line paragraph gap', () => {
    // Two paragraphs in the same text block separated by \n\n
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'hello' },
      { id: 2, kind: 'text', content: 'Paragraph one.\n\nParagraph two.' },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    const p1 = lines.findIndex((l) => l.includes('Paragraph one'));
    const p2 = lines.findIndex((l) => l.includes('Paragraph two'));
    expect(p1).toBeGreaterThan(-1);
    expect(p2).toBeGreaterThan(-1);
    expect(p2 - p1).toBe(2); // 1 blank line between paragraphs
  });

  test('consecutive bullet items have 0 gap', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'list' },
      {
        id: 2,
        kind: 'text',
        content: '- item one\n- item two\n\n- item after blank\n- item four',
      },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    // item one and item two should be consecutive (no gap)
    const i1 = lines.findIndex((l) => l.includes('item one'));
    const i2 = lines.findIndex((l) => l.includes('item two'));
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(-1);
    expect(i2 - i1).toBe(1); // consecutive, no blank line

    // item after blank and item four: the blank line in markdown should NOT create a gap
    const i3 = lines.findIndex((l) => l.includes('item after blank'));
    const i4 = lines.findIndex((l) => l.includes('item four'));
    expect(i3).toBeGreaterThan(-1);
    expect(i4).toBeGreaterThan(-1);
    expect(i4 - i3).toBe(1); // consecutive, no blank line
  });

  test('separately committed list item blocks have no block gap', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'list' },
      { id: 2, kind: 'text', content: '1. first item\n' },
      { id: 3, kind: 'text', content: '2. second item\n' },
      { id: 4, kind: 'text', content: '3. third item' },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const first = lines.findIndex((line) => line.includes('first item'));
    const second = lines.findIndex((line) => line.includes('second item'));
    const third = lines.findIndex((line) => line.includes('third item'));

    expect(second - first).toBe(1);
    expect(third - second).toBe(1);
  });

  test('keeps a normal block gap around a progressively rendered list', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'text', content: 'Introduction.' },
      { id: 2, kind: 'text', content: '- first item\n' },
      { id: 3, kind: 'text', content: '- second item\n' },
      { id: 4, kind: 'text', content: 'Conclusion.' },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const intro = lines.findIndex((line) => line.includes('Introduction.'));
    const first = lines.findIndex((line) => line.includes('first item'));
    const second = lines.findIndex((line) => line.includes('second item'));
    const conclusion = lines.findIndex((line) => line.includes('Conclusion.'));

    expect(first - intro).toBe(2);
    expect(second - first).toBe(1);
    expect(conclusion - second).toBe(2);
  });

  test('joins a streamed item after a mixed block whose final component is a list', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'text',
        content: '应用层在 src/app/：\n\n- tui/ — React Ink TUI 主界面\n',
      },
      { id: 2, kind: 'text', content: '- cli/ — Headless CLI\n' },
      { id: 3, kind: 'text', content: '- web-server/ — Hono Web 服务' },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const tui = lines.findIndex((line) => line.includes('tui/'));
    const cli = lines.findIndex((line) => line.includes('cli/'));
    const web = lines.findIndex((line) => line.includes('web-server/'));

    expect(cli - tui).toBe(1);
    expect(web - cli).toBe(1);
  });

  test('slash command user block has 0 gap to result', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: '/theme blue' },
      { id: 2, kind: 'text', content: '  ⎿  Theme set to blue' },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    const cmd = lines.findIndex((l) => l.includes('/theme blue'));
    const result = lines.findIndex((l) => l.includes('Theme set to blue'));
    expect(cmd).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(-1);
    expect(result - cmd).toBe(1); // 0 gap, immediate next line
  });

  test('streaming text after user has 1-line gap (dynamic tree path)', () => {
    // Simulate a new agent response: user message followed by streaming text.
    // With running=true, these blocks stay in the dynamic tree (OutputArea).
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'hello' },
      { id: 2, kind: 'text', content: 'Hi there', streaming: true },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={true} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    const userLine = lines.findIndex((l) => l.includes('❯ hello'));
    const textLine = lines.findIndex((l) => l.includes('Hi there'));
    expect(userLine).toBeGreaterThan(-1);
    expect(textLine).toBeGreaterThan(-1);
    expect(textLine - userLine).toBe(2); // 1 blank line between them
  });

  test('multi-paragraph streaming text has paragraph gaps', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'user', content: 'intro' },
      {
        id: 2,
        kind: 'text',
        content: 'First paragraph.\n\nSecond paragraph.\n\nThird.',
        streaming: true,
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={true} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    const p1 = lines.findIndex((l) => l.includes('First paragraph'));
    const p2 = lines.findIndex((l) => l.includes('Second paragraph'));
    const p3 = lines.findIndex((l) => l.includes('Third'));
    expect(p1).toBeGreaterThan(-1);
    expect(p2).toBeGreaterThan(-1);
    expect(p3).toBeGreaterThan(-1);
    expect(p2 - p1).toBe(2); // 1 blank line between paragraphs
    expect(p3 - p2).toBe(2);
  });
});

describe('OutputArea', () => {
  test('renders capability search as a matched Provider · Tool tree', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'search-1',
        name: 'tool_search',
        args: { query: 'LangGraph documentation' },
      },
      { type: 'tool.started', toolCallId: 'search-1' },
      {
        type: 'tool.finished',
        toolCallId: 'search-1',
        name: 'tool_search',
        result: {
          ok: true,
          command: 'tool_search',
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            candidate_count: 2,
            candidates: [
              {
                kind: 'mcp_tool',
                name: 'search_docs_by_lang_chain',
                provider: 'langchian',
              },
              { kind: 'mcp_tool', name: 'search_reference', provider: 'docs' },
            ],
          }),
          stderr: '',
        },
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('● Searched for tools');
    expect(frame).toContain('├ langchian · search_docs_by_lang_chain');
    expect(frame).toContain('└ docs · search_reference');
    expect(frame).not.toContain('candidate_count');
  });

  test('renders a stable empty capability search result', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'search-empty',
        name: 'tool_search',
        args: { query: 'missing capability' },
      },
      {
        type: 'tool.finished',
        toolCallId: 'search-empty',
        name: 'tool_search',
        result: {
          ok: true,
          command: 'tool_search',
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            candidate_count: 0,
            candidates: [],
          }),
          stderr: '',
        },
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );

    expect(lastFrame()).toContain('● No matching tools found');
  });

  test('renders last-known MCP inventory names during a catalog revision transition', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'search-transition',
        name: 'tool_search',
        args: { query: 'available MCP tools' },
      },
      {
        type: 'tool.finished',
        toolCallId: 'search-transition',
        name: 'tool_search',
        result: {
          ok: true,
          command: 'tool_search',
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            candidate_count: 1,
            executable_candidate_count: 0,
            candidates: [
              {
                kind: 'mcp_tool',
                name: 'search_docs_by_lang_chain',
                provider: 'langchian',
                catalog_status: 'last_known',
              },
            ],
          }),
          stderr: '',
        },
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('● Searched for tools');
    expect(frame).toContain('└ langchian · search_docs_by_lang_chain');
    expect(frame).not.toContain('No matching tools found');
    expect(frame).not.toContain('catalog_status');
  });

  test('renders a failed capability search without exposing raw protocol output', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'search-failed',
        name: 'tool_search',
        args: { query: 'documentation' },
      },
      {
        type: 'tool.failed',
        toolCallId: 'search-failed',
        failure: {
          kind: 'tool_invalid_args',
          message: 'Capability search is temporarily unavailable.',
          retryable: true,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: false,
        },
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );

    expect(lastFrame()).toContain('● Tool search failed');
  });

  test('renders MCP executable names as Provider · Tool', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'mcp-1',
        name: 'mcp__langchian__search_docs_by_lang_chain',
        args: { query: 'LangGraph' },
      },
      {
        type: 'tool.started',
        toolCallId: 'mcp-1',
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const { lastFrame } = render(
      <OutputAreaTestWrap running={true} turns={state.turns} onToggleReason={noop} />,
    );

    expect(lastFrame()).toContain('langchian · search_docs_by_lang_chain');
    expect(lastFrame()).not.toContain('mcp__langchian__');
  });

  test('renders MCP resource discovery as a Provider · URI tree', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool.queued',
        toolCallId: 'resources-1',
        name: 'list_mcp_resources',
        args: {},
      },
      {
        type: 'tool.finished',
        toolCallId: 'resources-1',
        name: 'list_mcp_resources',
        result: {
          ok: true,
          command: 'list_mcp_resources',
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            resource_count: 2,
            resources: [
              {
                server: 'langchian',
                uri: 'docs://langgraph/overview',
                name: 'Overview',
              },
              {
                server: 'langchian',
                uri: 'docs://langgraph/persistence',
                name: 'Persistence',
              },
            ],
            truncated: false,
          }),
          stderr: '',
        },
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('● Listed MCP resources');
    expect(frame).toContain('├ langchian · docs://langgraph/overview');
    expect(frame).toContain('└ langchian · docs://langgraph/persistence');
    expect(frame).not.toContain('resource_count');
  });

  test('renders the message list produced exclusively from RuntimeEvents', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'user.message_appended',
        messageId: 'u-1',
        content: 'Inspect the runtime bridge',
      },
      {
        type: 'model.responded',
        messageId: 'm-1',
        reasoningText: 'I will inspect the renderer.',
        text: 'The runtime bridge is connected.',
      },
      {
        type: 'tool.queued',
        toolCallId: 'tool-1',
        name: 'shell_execute',
        args: { command: 'echo runtime-bridge' },
      },
      { type: 'tool.started', toolCallId: 'tool-1' },
      {
        type: 'tool.finished',
        toolCallId: 'tool-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'echo runtime-bridge',
          exitCode: 0,
          stdout: 'runtime-bridge',
          stderr: '',
        },
      },
      {
        type: 'run.error',
        message: 'temporary network issue',
        recoverable: true,
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('❯ Inspect the runtime bridge');
    expect(frame).toContain('The runtime bridge is connected.');
    expect(frame).toContain('Bash');
    expect(frame).toContain('echo runtime-bridge');
    expect(frame).toContain('⟳ Recoverable error: temporary network issue');
    expect(frame.indexOf('Inspect the runtime bridge')).toBeLessThan(
      frame.indexOf('The runtime bridge is connected.'),
    );
    expect(frame).not.toContain('I will inspect the renderer.');
  });

  test('renders a completed subagent card produced from RuntimeEvents', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'subagent.started',
        subagent: {
          id: 'subagent-1',
          role: 'explore',
          task: 'Locate runtime event consumers',
        },
      },
      {
        type: 'subagent.step',
        subagent: {
          id: 'subagent-1',
          toolName: 'read_file',
          toolArgs: { path: 'src/app/tui/session-manager.ts' },
        },
      },
      {
        type: 'subagent.tool_result',
        subagent: {
          id: 'subagent-1',
          toolName: 'read_file',
          ok: true,
          summary: 'found route',
        },
      },
      {
        type: 'subagent.completed',
        subagent: {
          id: 'subagent-1',
          summary: 'Found one RuntimeEvent route.',
          toolCallCount: 1,
          durationMs: 42,
        },
      },
    ];
    const state = events.reduce(
      (current, event) => eventReducer(current, { type: 'RUNTIME_EVENT', event }),
      createInitialState(),
    );

    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={state.turns} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Explore');
    expect(frame).toContain('Locate runtime event consumers');
    expect(frame).toContain('Read session-manager.ts');
    expect(frame).toContain('done!');
  });

  test('renders user block with chevron prefix', () => {
    const blocks: OutputBlock[] = [{ id: 1, kind: 'user', content: 'Hello agent' }];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    expect(lastFrame()).toContain('❯ Hello agent');
  });

  test('renders text block', () => {
    const blocks: OutputBlock[] = [{ id: 1, kind: 'text', content: 'Response text' }];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    expect(lastFrame()).toContain('Response text');
  });

  test('hides reason blocks in output', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'reason', content: 'Thinking about it...', folded: false },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // Reason blocks are hidden from message list
    expect(lastFrame()).not.toContain('Thinking');
  });

  test('hides folded reason blocks in output', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'reason', content: 'Hidden thoughts', folded: true },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // Reason blocks are hidden from message list
    expect(lastFrame()).not.toContain('Thinking');
  });

  test('renders tool_card with running status', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c1',
        name: 'shell_execute',
        args: {},
        status: 'running',
        summary: '',
        preview: 'npm test',
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Bash');
    expect(frame).toContain('npm test');
  });

  test('renders tool_card with done status, hides summary for success, shows elapsed', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c1',
        name: 'read_file',
        args: {},
        status: 'done',
        summary: 'OK',
        preview: 'foo.ts',
        elapsedMs: 1234,
        detail: 'Read foo.ts',
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame();
    // Summary hidden for success
    expect(frame).not.toContain('OK');
    // Non-shell tools don't show elapsed time
    expect(frame).not.toContain('1.2s');
  });

  test('renders tool_card with error status and shows summary', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c1',
        name: 'shell_execute',
        args: {},
        status: 'error',
        summary: 'command not found',
        elapsedMs: 100,
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('command not found');
    expect(frame).toContain('1s');
  });

  test('renders tool_card with detail annotation', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_card',
        callId: 'c1',
        name: 'edit_file',
        args: {},
        status: 'done',
        summary: '',
        detail: '+3 -2',
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('+3 -2');
  });

  test('file_change block is rendered by tool_card, not OutputArea directly', () => {
    // sandbox 合并后 file_change 由 tool_card 渲染，BlockRenderer 返回 null
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'file_change',
        changes: [{ path: 'src/a.ts', kind: 'add', linesAdded: 10 }],
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // BlockRenderer 返回 null，OutputArea 输出为空
    expect(lastFrame()).toBe('');
  });

  test('approval block renders nothing (UI in Footer)', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'approval',
        approval: fakeApproval({ command: 'npm publish' }),
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // Approval UI is in Footer, output area returns null
    expect(lastFrame()).not.toContain('Awaiting approval');
    expect(lastFrame()).not.toContain('npm publish');
  });

  test('hides dynamic blocks after the approval tool while awaiting approval', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_card',
        callId: 'shell-1',
        name: 'shell_execute',
        args: { command: 'find src -type f | sort' },
        status: 'running',
        summary: '',
        preview: 'find src -type f | sort',
      },
      {
        id: 2,
        kind: 'tool_summary',
        active: false,
        createdAt: Date.now() - 1000,
        totalElapsedMs: 1000,
        summaryLine: 'read 2 files',
        hasThought: false,
        tools: [
          {
            callId: 'read-1',
            name: 'read_file',
            args: { path: 'index.ts' },
            ok: false,
            summary: '',
            status: 'running',
          },
          {
            callId: 'read-2',
            name: 'read_file',
            args: { path: 'CLAUDE.md', start: 1, end: 60 },
            ok: false,
            summary: '',
            status: 'running',
          },
        ],
      },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running awaitingApproval turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Bash');
    expect(frame).toContain('find src -type f | sort');
    expect(frame).toContain('awaiting approval');
    expect(frame).not.toContain('Thought');
    expect(frame).not.toContain('index.ts');
    expect(frame).not.toContain('CLAUDE.md');
    expect(frame).not.toContain('等待工具结果');
  });

  test('shows dynamic blocks after the approval tool once approval wait is over', () => {
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'tool_card',
        callId: 'shell-1',
        name: 'shell_execute',
        args: { command: 'find src -type f | sort' },
        status: 'running',
        summary: '',
        preview: 'find src -type f | sort',
      },
      {
        id: 2,
        kind: 'tool_summary',
        active: false,
        createdAt: Date.now() - 1000,
        totalElapsedMs: 1000,
        summaryLine: 'read 1 file',
        hasThought: false,
        tools: [
          {
            callId: 'read-1',
            name: 'read_file',
            args: { path: 'index.ts' },
            ok: false,
            summary: '',
            status: 'running',
          },
        ],
      },
    ];

    const { lastFrame } = render(
      <OutputAreaTestWrap running turns={[{ blocks }]} onToggleReason={noop} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Bash');
    expect(frame).toContain('read 1 file');
    expect(frame).not.toContain('index.ts');
  });

  test('does not apply an execution-frontier filter to blocks already materialized by the reducer', () => {
    const runningShell: OutputBlock = {
      id: 1,
      kind: 'tool_card',
      callId: 'shell-1',
      name: 'shell_execute',
      args: { command: 'bun test' },
      status: 'running',
      summary: '',
      preview: 'bun test',
    };
    const queuedThought: OutputBlock = {
      id: 2,
      kind: 'tool_summary',
      active: true,
      createdAt: Date.now() - 3000,
      totalElapsedMs: 0,
      summaryLine: 'read 1 file, searched 2 file patterns',
      hasThought: false,
      tools: [
        {
          callId: 'read-1',
          name: 'read_file',
          args: { path: 'README.md' },
          ok: false,
          summary: '',
          status: 'queued',
        },
        {
          callId: 'search-1',
          name: 'search_files',
          args: { pattern: '*.ts' },
          ok: false,
          summary: '',
          status: 'queued',
        },
      ],
    };

    const { lastFrame, rerender } = render(
      <OutputAreaTestWrap
        running
        turns={[{ blocks: [runningShell, queuedThought] }]}
        onToggleReason={noop}
      />,
    );

    expect(lastFrame()).toContain('bun test');
    expect(lastFrame()).toContain('read 1 file');

    const startedThought: OutputBlock = {
      ...queuedThought,
      tools: [{ ...queuedThought.tools[0]!, status: 'running' }, queuedThought.tools[1]!],
    };
    rerender(
      <OutputAreaTestWrap
        running
        turns={[{ blocks: [runningShell, startedThought] }]}
        onToggleReason={noop}
      />,
    );

    expect(lastFrame()).toContain('read 1 file');
  });

  test('resolved approval block is rendered by tool_card, not OutputArea', () => {
    // sandbox 合并后 approval 由 tool_card + Footer 渲染，BlockRenderer 返回 null
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'approval',
        approval: fakeApproval(),
        resolved: { action: 'approve', grant: 'full_access' },
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // BlockRenderer 返回 null，OutputArea 输出为空
    expect(lastFrame()).toBe('');
  });

  test('denied approval block is rendered by tool_card, not OutputArea', () => {
    // sandbox 合并后 approval 由 tool_card + Footer 渲染，BlockRenderer 返回 null
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'approval',
        approval: fakeApproval(),
        resolved: { action: 'reject' },
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // BlockRenderer 返回 null，OutputArea 输出为空
    expect(lastFrame()).toBe('');
  });

  test('question block is rendered by tool_card, not OutputArea (unresolved)', () => {
    // sandbox 合并后 question 由 tool_card 渲染，BlockRenderer 返回 null
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'question',
        question: fakeQuestion({ question: 'Continue?' }),
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // BlockRenderer 返回 null，OutputArea 输出为空
    expect(lastFrame()).toBe('');
  });

  test('question block is rendered by tool_card, not OutputArea (resolved)', () => {
    // sandbox 合并后 question 由 tool_card 渲染，BlockRenderer 返回 null
    const blocks: OutputBlock[] = [
      {
        id: 1,
        kind: 'question',
        question: fakeQuestion(),
        resolved: 'Yes please',
      },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // BlockRenderer 返回 null，OutputArea 输出为空
    expect(lastFrame()).toBe('');
  });

  test('renders empty when no blocks', () => {
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[]} onToggleReason={noop} />,
    );
    expect(lastFrame()).toBe('');
  });
});

// ── App (main layout) ──

describe('App', () => {
  function fakeState(overrides: Partial<TuiState> = {}): TuiState {
    return {
      sessions: [],
      activeSessionId: null,
      turns: [],
      nextBlockId: 1,
      interrupt: null,
      status: fakeStatus(),
      exited: false,
      running: false,
      runCount: 0,
      showHelp: false,
      showModelSelector: false,
      showPermissionSelector: false,
      showEffortSelector: false,
      showThemeSelector: false,
      showSessions: false,
      showMcp: false,
      showRewind: false,
      checkpoints: [],
      skillManifests: [],
      ctrlCPressed: false,
      sessionKey: 0,
      exitRequested: false,
      sessionError: false,
      loadingSessionId: null,
      sessionServiceUnavailable: false,
      explorationSummaryIds: {},
      pendingToolCalls: {},
      interactionMode: 'accept_edits',
      ...overrides,
    };
  }

  test('renders Header with Kite Code before ActivityBar', () => {
    const state = fakeState();
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame();
    // Header (Kite Code) should appear before ActivityBar (since it renders first in layout)
    const headerIdx = frame?.indexOf('Kite Code');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
  });

  test('shows HelpPanel when showHelp is true', () => {
    const state = fakeState({ showHelp: true });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    expect(lastFrame()).toContain('快捷键');
  });

  test('hides HelpPanel when showHelp is false', () => {
    const state = fakeState({ showHelp: false });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    expect(lastFrame()).not.toContain('快捷键');
  });

  test('shows ModelSelector when showModelSelector is true', () => {
    const state = fakeState({ showModelSelector: true });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    expect(lastFrame()).toContain('选择模型');
  });

  test('shows PermissionSelector when showPermissionSelector is true', () => {
    const state = fakeState({ showPermissionSelector: true });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()}>
        <Text>permission-input-marker</Text>
      </App>,
    );
    expect(lastFrame()).toContain('选择权限模式');
    expect(lastFrame()).toContain('接受编辑');
    expect(lastFrame()).toContain('自动审批');
    expect(lastFrame()).not.toContain('permission-input-marker');
    expect(lastFrame()?.match(/claude-opus/g) ?? []).toHaveLength(1);
  });

  test('refreshes the header and Footer when thinking effort changes', () => {
    const before = fakeState({
      status: fakeStatus({ modelProvider: 'deepseek', thinkingMode: 'max' }),
    });
    const view = render(
      <App state={before} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    expect(view.lastFrame()).toContain('max');

    const after = fakeState({
      status: fakeStatus({ modelProvider: 'deepseek', thinkingMode: 'high' }),
    });
    // Header is an Ink <Static> item. TuiApp remounts App after a visible
    // model/effort change so the terminal receives a fresh Header frame.
    view.rerender(
      <App
        key="refreshed-header"
        state={after}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(view.lastFrame()?.match(/high/g) ?? []).toHaveLength(2);
  });

  test('hides the Footer for every slash-command Overlay', () => {
    for (const overlay of [
      { showHelp: true },
      { showModelSelector: true },
      { showPermissionSelector: true },
      { showEffortSelector: true },
      { showThemeSelector: true },
      { showSessions: true },
      { showMcp: true },
      { showRewind: true },
    ]) {
      const { lastFrame, unmount } = render(
        <App
          state={fakeState(overlay)}
          dispatch={noop}
          onToggleReason={noop}
          provider={fakeProvider()}
        >
          <Text>footer-input-marker</Text>
        </App>,
      );
      expect(lastFrame()).not.toContain('footer-input-marker');
      unmount();
    }
  });

  test('hides slash suggestions while PermissionSelector is open', () => {
    const state = fakeState({ showPermissionSelector: true });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
        slashSuggestion={{
          kind: 'command',
          partial: 'permissions',
          selectedIndex: 0,
          items: [
            {
              command: 'permissions',
              aliases: [],
              description: '设置权限模式',
            },
          ],
        }}
      />,
    );
    expect(lastFrame()).toContain('选择权限模式');
    expect(lastFrame()).not.toContain('命令匹配');
  });

  test('hides slash suggestions while an approval interrupt is open', () => {
    const state = fakeState({
      interrupt: { kind: 'approval', approval: fakeApproval() },
    });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
        slashSuggestion={{
          kind: 'command',
          partial: 'permissions',
          selectedIndex: 0,
          items: [
            {
              command: 'permissions',
              aliases: [],
              description: '设置权限模式',
            },
          ],
        }}
      />,
    );
    expect(lastFrame()).toContain('工具授权');
    expect(lastFrame()).not.toContain('命令匹配');
  });

  test('gives an interrupt priority over a stale selector', () => {
    const state = fakeState({
      showPermissionSelector: true,
      interrupt: { kind: 'approval', approval: fakeApproval() },
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    expect(lastFrame()).toContain('工具授权');
    expect(lastFrame()).not.toContain('选择权限模式');
  });

  test('persists a model selection before applying it to the current TUI state', async () => {
    const state = fakeState({
      showModelSelector: true,
      status: fakeStatus({
        modelProvider: 'deepseek',
        modelName: 'deepseek-v4-flash',
      }),
    });
    const persisted: Array<[string, string]> = [];
    const actions: Action[] = [];
    const { stdin } = render(
      <App
        state={state}
        dispatch={(action) => actions.push(action)}
        onToggleReason={noop}
        provider={fakeProvider()}
        availableModels={[
          { provider: 'deepseek', name: 'deepseek-v4-flash', isDefault: true },
          {
            provider: 'opencode_go',
            name: 'deepseek-v4-flash',
            isDefault: false,
          },
        ]}
        persistModelSelection={(provider, modelName) => {
          persisted.push([provider, modelName]);
          return true;
        }}
      />,
    );

    stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(persisted).toEqual([['opencode_go', 'deepseek-v4-flash']]);
    expect(actions).toContainEqual({
      type: 'SELECT_MODEL',
      provider: 'opencode_go',
      modelName: 'deepseek-v4-flash',
    });
  });

  test('shows ApprovalBlock when interrupt is approval', () => {
    const approval = fakeApproval();
    const state = fakeState({
      running: true,
      runStartTime: Date.now() - 28_000,
      turns: [],
      interrupt: { kind: 'approval', approval },
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('工具授权');
    expect(frame).toContain('允许一次');
    expect(frame).not.toContain('Waiting...');
    expect(frame.match(/claude-opus/g)).toHaveLength(1);
    expect(frame).not.toContain('[接受编辑]');
  });

  test('hides run status once final assistant text is visible', () => {
    const state = fakeState({
      running: true,
      runStartTime: Date.now() - 2_000,
      turns: [
        {
          blocks: [{ id: 1, kind: 'text', content: 'Done. Here is the result.' }],
        },
      ],
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Done. Here is the result.');
    expect(frame).not.toContain('Thinking...');
    expect(frame).not.toContain('Running...');
  });

  test('keeps run status visible while interstitial text is streaming after tools', () => {
    const state = fakeState({
      running: true,
      runStartTime: Date.now() - 2_000,
      turns: [
        {
          blocks: [
            {
              id: 1,
              kind: 'tool_card',
              callId: 'create-1',
              name: 'write_file',
              args: { path: 'apps/web/drizzle.config.ts' },
              status: 'done',
              summary: 'created',
            },
            {
              id: 2,
              kind: 'text',
              content: '配置完成。安装依赖，同时并行创建核心代码文件。',
              streaming: true,
            },
          ],
        },
      ],
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('配置完成。安装依赖');
    expect(frame).toContain('Working');
  });

  test('shows InputBlock when interrupt is question', () => {
    const question = fakeQuestion();
    const state = fakeState({
      turns: [{ blocks: [{ id: 1, kind: 'question', question }] }],
      interrupt: { kind: 'input', blockId: 1 },
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(question.question);
    expect(frame.match(/claude-opus/g)).toHaveLength(1);
    expect(frame).not.toContain('[接受编辑]');
  });

  test('hides global status while reviewing a plan', () => {
    const state = fakeState({
      interrupt: { kind: 'plan_review', plan: fakePlan() },
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('方案审核');
    expect(frame.match(/claude-opus/g)).toHaveLength(1);
    expect(frame).not.toContain('[接受编辑]');
  });

  test('does not show ApprovalBlock when resolved', () => {
    const approval = fakeApproval();
    const state = fakeState({
      turns: [
        {
          blocks: [
            {
              id: 1,
              kind: 'approval',
              approval,
              resolved: { action: 'approve', grant: 'full_access' },
            },
          ],
        },
      ],
      interrupt: null,
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    expect(lastFrame()).not.toContain('[A]approve');
  });

  test('renders children when provided', () => {
    const state = fakeState();
    const InputLine = require('../src/app/tui/components/InputLine').default;
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()}>
        <InputLine mode="prompt" onSubmit={noop} workspace={process.cwd()} />
      </App>,
    );
    // children InputLine should be rendered
    const frame = lastFrame();
    const promptIdx = frame?.indexOf('❯');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
  });
});

// ── SubAgent block rendering ──

describe('SubAgentBlock rendering', () => {
  test('renders running subagent block with steps', () => {
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'code' as const,
      task: 'fix auth bug',
      status: 'running' as const,
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      steps: [
        {
          toolName: 'read_file',
          toolArgs: { path: 'auth.ts' },
          status: 'success' as const,
          ok: true,
        },
        {
          toolName: 'edit_file',
          toolArgs: { path: 'auth.ts' },
          status: 'success' as const,
        },
      ],
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Code');
    expect(frame).toContain('fix auth bug');
    expect(frame).toContain('Read');
    expect(frame).toContain('Update');
    expect(frame).not.toContain('✓');
  });

  test('running subagent renders the initial spinner frame', () => {
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'code' as const,
      task: 'fix auth bug',
      status: 'running' as const,
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
      startedAt: Date.now(),
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);

    expect(lastFrame()).toContain('●');
  });

  test('renders done subagent block', () => {
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'review' as const,
      task: 'review PR #42',
      status: 'done' as const,
      summary: 'No critical issues found.\n2 warnings in auth.ts.',
      toolCallCount: 5,
      durationMs: 3200,
      steps: [],
      expanded: true,
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('●');
    expect(frame).toContain('Review');
    expect(frame).toContain('review PR #42');
    expect(frame).toContain('3s');
    // Tool call count is not in header — only in status bar via events
    expect(frame).not.toContain('No critical issues found');
  });

  test('renders error subagent block', () => {
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'explore' as const,
      task: 'find refs',
      status: 'error' as const,
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      error: 'Sub-agent timed out after 1800000ms',
      steps: [],
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('●');
    expect(frame).toContain('Explore');
    expect(frame).toContain('timed out');
  });

  test('renders explore role label correctly', () => {
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'explore' as const,
      task: 'search all',
      status: 'running' as const,
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Explore');
  });

  test('long task text is truncated to first line in block', () => {
    const longTask =
      'find all usages of the UserService class across the entire codebase including tests\n\nDetailed instructions:\n- Check every file';
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'code' as const,
      task: longTask,
      status: 'running' as const,
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    // First line should be visible
    expect(frame).toContain('find all usages of the UserService class');
    // Second line should NOT be visible
    expect(frame).not.toContain('Detailed instructions');
  });

  test('done block shows done! after steps', () => {
    const longSummary = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join('\n');
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'explore' as const,
      task: 'search',
      status: 'done' as const,
      summary: longSummary,
      toolCallCount: 3,
      durationMs: 1200,
      steps: [{ toolName: 'read_file', toolArgs: {}, status: 'success' as const }],
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    // Summary text should NOT be rendered in the message list
    expect(frame).not.toContain('Line 1');
    // Should show the header and done! marker
    expect(frame).toContain('●');
    expect(frame).toContain('done!');
  });

  test('running block limits visible steps', () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({
      status: 'pending' as const,
      toolName: `step_${String(i + 1).padStart(2, '0')}`,
      toolArgs: {},
    }));
    const block = {
      id: 1,
      kind: 'subagent' as const,
      subagentId: 'sub-1',
      role: 'code' as const,
      task: 'fix bug',
      status: 'running' as const,
      summary: '',
      toolCallCount: 0,
      durationMs: 0,
      steps,
    };
    const { lastFrame } = render(<SubAgentBlock block={block} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('已折叠');
    expect(frame).toContain('step_15'); // last step should be visible
    expect(frame).toContain('step_11'); // within last 5 (MAX_RUNNING_STEPS = 5)
    expect(frame).not.toContain('step_10'); // too old, folded
  });
});
