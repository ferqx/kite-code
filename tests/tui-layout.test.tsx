import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import App from '../src/app/tui/App';
import ApprovalBlock from '../src/app/tui/components/ApprovalBlock';
import BlockRenderer from '../src/app/tui/components/BlockRenderer';
import HelpPanel from '../src/app/tui/components/HelpPanel';
import InputBlock from '../src/app/tui/components/InputBlock';
import InputLine from '../src/app/tui/components/InputLine';
import MarkdownBlock from '../src/app/tui/components/MarkdownBlock';
import ModelSelector from '../src/app/tui/components/ModelSelector';
import PlanReviewBlock from '../src/app/tui/components/PlanReviewBlock';
import StartupScreen from '../src/app/tui/components/StartupScreen';
import SubAgentBlock from '../src/app/tui/components/SubAgentBlock';
import TaskProgressBlock from '../src/app/tui/components/TaskProgressBlock';
import DiffPreview from '../src/app/tui/DiffPreview';
import Footer from '../src/app/tui/Footer';
import Header from '../src/app/tui/Header';
import OutputArea, { useStaticContent } from '../src/app/tui/OutputArea';
import { TuiUserInputProvider } from '../src/app/tui/provider';
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
import type { AgentPlan, ToolApprovalPayload, UserInputPayload } from '../src/protocol/events';

// ── Shared helpers ──

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
  return new TuiUserInputProvider(() => {});
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
});

// ── Header ──

describe('Header', () => {
  test('renders Kite Code logo and product name', () => {
    const { lastFrame } = render(<Header running={false} />);
    const frame = lastFrame();
    expect(frame).toContain('Kite Code');
    // Cat ASCII art is present
    expect(frame).toContain('/\\_/\\');
    expect(frame).toContain('( = = )');
    expect(frame).toContain('> ~ <');
  });

  test('shows idle cat when not running and no error', () => {
    const { lastFrame } = render(<Header running={false} />);
    expect(lastFrame()).toContain('( = = )');
    expect(lastFrame()).toContain('> ~ <');
  });

  test('shows working cat when running', () => {
    const { lastFrame } = render(<Header running />);
    expect(lastFrame()).toContain('( ^ ^ )');
    expect(lastFrame()).toContain('> w <');
  });

  test('shows error cat when error is true', () => {
    const { lastFrame } = render(<Header running={false} error />);
    expect(lastFrame()).toContain('( T T )');
    expect(lastFrame()).toContain('> . <');
  });

  test('shows all usage hints', () => {
    const { lastFrame } = render(<Header running={false} />);
    const frame = lastFrame();
    expect(frame).toContain('/help shortcuts');
    expect(frame).toContain('Ctrl+C exit');
    expect(frame).toContain('/ commands');
  });

  test('usage hints appear after cat ASCII', () => {
    const { lastFrame } = render(<Header running={false} />);
    const frame = lastFrame()!;
    const catIdx = frame.indexOf('/\\_/\\');
    const hintIdx = frame.indexOf('/help shortcuts');
    expect(catIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(catIdx).toBeLessThan(hintIdx);
  });

  test('header is 3 rows (cat art + hints on middle line)', () => {
    const { lastFrame } = render(<Header running />);
    const lines = lastFrame()?.split('\n').filter(Boolean);
    expect(lines?.length).toBe(3);
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

  test('shows elapsed time and run token delta without raw tool detail', () => {
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
    expect(frame).toContain('+189 tokens');
    // Tool detail lives in blocks, not in the status line
    expect(frame).not.toContain('StatusBar');
  });

  test('keeps idle planning mode hint', () => {
    const status = fakeStatus({ phase: 'planning' });
    const { lastFrame } = render(
      <StatusBar
        status={status}
        runStatus={fakeRunStatus({ phase: 'thinking', verb: 'Planning' })}
        timerKey={0}
        running={false}
      />,
    );
    expect(lastFrame()).toContain('Shift+Tab to exit');
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
    const status = fakeStatus({ modelProvider: 'deepseek', thinkingMode: 'detailed' });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('effort: detailed');
  });

  test('shows cache hit rate', () => {
    const status = fakeStatus({
      modelProvider: 'deepseek',
      cacheHitTokens: 75,
      cacheMissTokens: 25,
      totalTokens: 1200,
    });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('cache: 75%');
  });

  test('shows token count formatted', () => {
    const status = fakeStatus({ totalTokens: 10000 });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('10.0k');
  });

  test('shows [完全] for full_access auth', () => {
    const status = fakeStatus({ authorization: 'full_access' });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('[完全]');
  });

  test('shows [安全] for default auth', () => {
    const status = fakeStatus({ authorization: 'default' });
    const { lastFrame } = render(<StatsLine status={status} running />);
    expect(lastFrame()).toContain('[安全]');
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
});

// ── HelpPanel ──

describe('HelpPanel', () => {
  test('renders title and sections', () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame();
    expect(frame).toContain('快捷键');
    expect(frame).toContain('斜杠命令');
  });

  test('shows key bindings', () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame();
    expect(frame).toContain('Ctrl+C');
    expect(frame).toContain('中断运行 / 双按退出');
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
      <ModelSelector currentModel="deepseek-chat" onSelect={noop} onClose={noop} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('选择模型');
    expect(frame).toContain('deepseek-v4-flash');
  });

  test('marks current model with ●', () => {
    const { lastFrame } = render(
      <ModelSelector currentModel="deepseek-v4-flash" onSelect={noop} onClose={noop} />,
    );
    expect(lastFrame()).toContain('●');
  });

  test('shows navigation hints', () => {
    const { lastFrame } = render(
      <ModelSelector currentModel="deepseek-v4" onSelect={noop} onClose={noop} />,
    );
    expect(lastFrame()).toContain('导航');
    expect(lastFrame()).toContain('Esc 取消');
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
  test('renders compact approval prompt without repeating tool command', () => {
    const approval = fakeApproval({
      command: 'rm -rf /tmp/test',
      summary: 'Delete temp files',
      risk: 'destructive',
    });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Approve this tool call?');
    expect(frame).not.toContain('● Bash');
    expect(frame).not.toContain('rm -rf /tmp/test');
    expect(frame).not.toContain('Delete temp files');
    expect(frame).not.toContain('destructive');
  });

  test('shows all grant options with labels', () => {
    const approval = fakeApproval();
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Approve once');
    expect(frame).toContain('Approve same command');
    expect(frame).toContain('Approve all');
    expect(frame).toContain('Deny');
  });

  test('uses a simple top divider instead of a rounded border', () => {
    const approval = fakeApproval();
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('────────────────────────────────────────');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');
    expect(frame).not.toContain('│');
  });

  test('non‑shell tools only show approve and deny', () => {
    const approval = fakeApproval({ tool: 'write_file', grantOptions: ['approve_once'] });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Approve once');
    expect(frame).toContain('Deny');
    expect(frame).not.toContain('Approve same command');
    expect(frame).not.toContain('Approve all');
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
    expect(lastFrame()).toContain('Tab type freely');
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
    expect(frame).not.toContain('▶');
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
    expect(frame).toContain('▶');
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
    expect(frame).toContain('Yes, and use auto mode');
    expect(frame).toContain('(Recommended)');
    expect(frame).toContain('Yes, manually approve edits');
    expect(frame).toContain('Tell Agent what to change');
  });

  test('shows option descriptions', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock plan={plan} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Plan executes without further approvals');
    expect(frame).toContain('Each file edit requires confirmation');
    expect(frame).toContain('Provide feedback to revise the plan');
  });

  test('shows quick key hint', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock plan={plan} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain('a/m/t quick key');
  });

  test('renders plan review confirmation bar', () => {
    const plan = fakePlan();
    const { lastFrame } = render(
      <PlanReviewBlock plan={plan} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    // 方案内容移至 OutputArea tool_card Markdown 渲染，Footer 仅显示确认操作条
    // Plan content moved to OutputArea tool_card Markdown; Footer only shows confirmation bar
    expect(frame).toContain('Review the plan above');
    expect(frame).toContain('Yes, and use auto mode');
    expect(frame).toContain('Yes, manually approve edits');
    expect(frame).toContain('Tell Agent what to change');
  });
});

// ── InputLine plan mode ──

describe('InputLine plan mode', () => {
  test('shows plan mode prompt and indicator when planMode=true', () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" planMode={true} onSubmit={noop} workspace="/test" />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Plan mode');
    expect(frame).toContain('Shift+Tab');
    expect(frame).toContain('≻◷');
  });

  test('shows normal prompt when planMode=false', () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" planMode={false} onSubmit={noop} workspace="/test" />,
    );
    const frame = lastFrame();
    expect(frame).toContain('❯');
    expect(frame).not.toContain('Plan mode');
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

  test('renders reason block as null (hidden)', () => {
    const block: OutputBlock = { id: 1, kind: 'reason', content: 'thinking', folded: false };
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

  test('renders file_change block', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'file_change',
      changes: [{ path: 'src/a.ts', kind: 'add', linesAdded: 5 }],
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toContain('src/a.ts');
  });

  test('renders resolved question block', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'question',
      question: { question: 'hello', options: [], allow_free_text: true },
      resolved: 'yes',
    };
    const { lastFrame } = render(
      <BlockRenderer columns={80} block={block} isFocused={false} index={0} />,
    );
    expect(lastFrame()).toContain('Answered');
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

  test('renders tool_summary error details', () => {
    const block: OutputBlock = {
      id: 1,
      kind: 'tool_summary',
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'searched 1 file pattern',
      active: false,
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

    expect(lastFrame()).toContain('Find package.json');
    expect(lastFrame()).toContain('search command failed');
  });

  test('renders running tool_summary thinking preview', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: { kind: 'thinking', text: 'checking current Thought boundaries' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
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

    expect(lastFrame()).toContain('Thinking checking current Thought boundaries');
  });

  test('keeps running tool_summary thinking preview when latest visible activity is a tool', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: true,
      latestActivity: { kind: 'thinking', text: 'reviewing the project conventions' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 3 files',
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

    expect(frame).toContain('Thinking reviewing the project conventions');
    expect(frame).toContain('Read README.md');
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

    expect(frame).toContain('├─ Read CLAUDE.md [lines 1-126 / 126]');
    expect(frame).toContain('└─ 运行中');
    expect(frame).not.toContain('\n   Read CLAUDE.md');
  });

  test('truncates long running tool_summary thinking preview', () => {
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
      <BlockRenderer columns={50} block={block} isFocused={false} index={0} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Thinking');
    expect(frame).toContain('…');
    expect(frame).not.toContain(longThought);
  });

  test('omits thinking preview after tool_summary settles', () => {
    const block = {
      id: 1,
      kind: 'tool_summary',
      active: false,
      latestActivity: { kind: 'thinking', text: 'hidden after settle' },
      createdAt: Date.now() - 1000,
      totalElapsedMs: 1000,
      summaryLine: 'read 1 file',
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

    expect(lastFrame()).not.toContain('hidden after settle');
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

    expect(frame).toContain('Thought for 1s, read 1 file');
    expect(frame).toContain('等待工具结果');
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
      { id: 1, kind: 'user', content: 'hello world', _marker: 'hello world' } as any,
      { id: 2, kind: 'text', content: '__BLOCK_1__', _marker: '__BLOCK_1__' } as any,
      1,
    );
  });

  test('text → tool_card', () => {
    assertGap(
      { id: 1, kind: 'text', content: '__BLOCK_0__', _marker: '__BLOCK_0__' } as any,
      {
        id: 2,
        kind: 'tool_card',
        callId: 'c1',
        name: 'read_file',
        args: {},
        status: 'done',
        summary: 'done',
        _marker: 'Read',
      } as any,
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
      } as any,
      {
        id: 2,
        kind: 'tool_card',
        callId: 'c2',
        name: 'tool_b',
        args: {},
        status: 'done',
        summary: 'ok',
        _marker: 'tool_b',
      } as any,
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
        _marker: 'Bash',
      } as any,
      { id: 2, kind: 'text', content: '__BLOCK_1__', _marker: '__BLOCK_1__' } as any,
      1,
    );
  });

  test('text → file_change', () => {
    assertGap(
      { id: 1, kind: 'text', content: '__BLOCK_0__', _marker: '__BLOCK_0__' } as any,
      {
        id: 2,
        kind: 'file_change',
        changes: [{ path: 'f.ts', kind: 'add' }],
        _marker: 'File Changes',
      } as any,
      1,
    );
  });

  test('file_change → text', () => {
    assertGap(
      {
        id: 1,
        kind: 'file_change',
        changes: [{ path: 'f.ts', kind: 'add' }],
        _marker: 'f.ts',
      } as any,
      { id: 2, kind: 'text', content: '__BLOCK_1__', _marker: '__BLOCK_1__' } as any,
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
      } as any,
      { id: 2, kind: 'text', content: '__BLOCK_1__', _marker: '__BLOCK_1__' } as any,
      2, // subagent status line adds one extra line between header marker and next block
    );
  });

  test('slash command user → text (tight)', () => {
    assertGap(
      { id: 1, kind: 'user', content: '/theme blue', _marker: '/theme blue' } as any,
      { id: 2, kind: 'text', content: '__SLASH_RSLT__', _marker: '__SLASH_RSLT__' } as any,
      0,
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
      { id: 2, kind: 'text', content: '- item one\n- item two\n\n- item after blank\n- item four' },
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
    expect(frame).toContain('0s');
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

  test('renders file_change block', () => {
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
    const frame = lastFrame();
    expect(frame).toContain('File Changes');
    expect(frame).toContain('+ src/a.ts');
    expect(frame).toContain('+10');
  });

  test('approval block renders nothing (UI in Footer)', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'approval', approval: fakeApproval({ command: 'npm publish' }) },
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
    expect(frame).toContain('Thought');
    expect(frame).toContain('index.ts');
  });

  test('resolved approval block shows confirmation for scrollback', () => {
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
    expect(lastFrame()).toContain('Approved');
  });

  test('denied approval block shows rejection for scrollback', () => {
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
    expect(lastFrame()).toContain('Rejected');
  });

  test('renders question text for unresolved question (scrollback marker)', () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: 'question', question: fakeQuestion({ question: 'Continue?' }) },
    ];
    const { lastFrame } = render(
      <OutputAreaTestWrap running={false} turns={[{ blocks }]} onToggleReason={noop} />,
    );
    // 显示实际问题文本作为 scrollback 标记 / Shows actual question text as scrollback marker
    expect(lastFrame()).toContain('Continue?');
  });

  test('renders resolved question block', () => {
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
    expect(lastFrame()).toContain('Yes please');
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
      showSessions: false,
      showMcp: false,
      showRewind: false,
      checkpoints: [],
      rewindCounter: 0,
      pendingSkills: [],
      skillManifests: [],
      ctrlCPressed: false,
      sessionKey: 0,
      exitRequested: false,
      sessionError: false,
      loadingSessionId: null,
      explorationSummaryIds: {},
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

  test('shows ApprovalBlock when interrupt is approval', () => {
    const approval = fakeApproval();
    const state = fakeState({
      running: true,
      runStartTime: Date.now() - 28_000,
      turns: [{ blocks: [{ id: 1, kind: 'approval', approval }] }],
      interrupt: { kind: 'approval', blockId: 1 },
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approve this tool call?');
    expect(frame).toContain('Approve once');
    expect(frame).not.toContain('Waiting...');
  });

  test('hides run status once final assistant text is visible', () => {
    const state = fakeState({
      running: true,
      runStartTime: Date.now() - 2_000,
      turns: [{ blocks: [{ id: 1, kind: 'text', content: 'Done. Here is the result.' }] }],
    });
    const { lastFrame } = render(
      <App state={state} dispatch={noop} onToggleReason={noop} provider={fakeProvider()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Done. Here is the result.');
    expect(frame).not.toContain('Thinking...');
    expect(frame).not.toContain('Running...');
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
    expect(lastFrame()).toContain(question.question);
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
      interrupt: { kind: 'approval', blockId: 1 },
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
    const promptIdx = frame?.indexOf('>');
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
        { toolName: 'read_file', toolArgs: { path: 'auth.ts' }, ok: true },
        { toolName: 'edit_file', toolArgs: { path: 'auth.ts' } },
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
      steps: [{ toolName: 'read_file', toolArgs: {} }],
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
