import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import Footer from "../src/app/tui/Footer";
import Header from "../src/app/tui/Header";
import StatusBar from "../src/app/tui/StatusBar";
import StatsLine from "../src/app/tui/StatsLine";
import DiffPreview from "../src/app/tui/DiffPreview";
import StartupScreen from "../src/app/tui/components/StartupScreen";
import MarkdownBlock from "../src/app/tui/components/MarkdownBlock";
import HelpPanel from "../src/app/tui/components/HelpPanel";
import ModelSelector from "../src/app/tui/components/ModelSelector";
import ApprovalBlock from "../src/app/tui/components/ApprovalBlock";
import InputBlock from "../src/app/tui/components/InputBlock";
import InputLine from "../src/app/tui/components/InputLine";
import OutputArea from "../src/app/tui/OutputArea";
import App, { type AppProps } from "../src/app/tui/App";
import type { TuiState, OutputBlock, StatusState, FileChangeRecord } from "../src/app/tui/types";
import type { ToolApprovalPayload, UserInputPayload } from "../src/protocol/events";
import { TuiUserInputProvider } from "../src/app/tui/provider";
import type { UserInputProvider } from "../src/protocol/provider";

// ── Shared helpers ──

function fakeStatus(overrides: Partial<StatusState> = {}): StatusState {
  return {
    phase: "building",
    plan: null,
    authorization: "full_access",
    workspaceAccess: "write",
    cacheHitRate: 45,
    totalTokens: 1234,
    currentNode: "agent",
    modelName: "claude-opus",
    thinkingMode: "detailed",
    ...overrides,
  };
}

function fakeApproval(overrides: Partial<ToolApprovalPayload> = {}): ToolApprovalPayload {
  return {
    scope: "once",
    cwd: "/tmp",
    threadId: "test-thread",
    tool: "shell_execute",
    command: "npm test",
    risk: "execute_code",
    approvalHash: "abc123",
    summary: "Run unit tests",
    reason: "Agent wants to verify changes",
    expectedEffects: ["runs jest", "outputs results"],
    grantOptions: ["approve_once", "same_command", "full_access"],
    recommendedGrant: "approve_once",
    ...overrides,
  };
}

function fakeQuestion(overrides: Partial<UserInputPayload> = {}): UserInputPayload {
  return {
    question: "Which approach do you prefer?",
    options: [
      { id: "a", label: "Option A", description: "First approach" },
      { id: "b", label: "Option B", description: "Second approach" },
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

describe("Footer", () => {
  const footerProps = {
    status: fakeStatus(),
    running: false,
    compacting: false,
    thinkingVisible: true,
    timerKey: 0,
  };

  test("renders Footer with child content", () => {
    const { lastFrame } = render(<Footer {...footerProps}><Text>child content</Text></Footer>);
    expect(lastFrame()).toContain("child content");
  });

  test("renders empty Box when no children", () => {
    const { lastFrame } = render(<Footer {...footerProps} />);
    // Placeholder footer renders an empty Box
    expect(typeof lastFrame()).toBe("string");
  });
});

// ── Header ──

describe("Header", () => {
  test("renders OpenPX logo and product name", () => {
    const { lastFrame } = render(<Header running={false} />);
    const frame = lastFrame();
    expect(frame).toContain("OpenPX");
    // Cat ASCII art is present
    expect(frame).toContain("/\\_/\\");
    expect(frame).toContain("( = = )");
    expect(frame).toContain("> ~ <");
  });

  test("shows idle cat when not running and no error", () => {
    const { lastFrame } = render(<Header running={false} />);
    expect(lastFrame()).toContain("( = = )");
    expect(lastFrame()).toContain("> ~ <");
  });

  test("shows working cat when running", () => {
    const { lastFrame } = render(<Header running />);
    expect(lastFrame()).toContain("( ^ ^ )");
    expect(lastFrame()).toContain("> w <");
  });

  test("shows error cat when error is true", () => {
    const { lastFrame } = render(<Header running={false} error />);
    expect(lastFrame()).toContain("( T T )");
    expect(lastFrame()).toContain("> . <");
  });

  test("shows all usage hints", () => {
    const { lastFrame } = render(<Header running={false} />);
    const frame = lastFrame();
    expect(frame).toContain("? shortcuts");
    expect(frame).toContain("Ctrl+C exit");
    expect(frame).toContain("/ commands");
    expect(frame).toContain("! shell");
  });

  test("usage hints appear after cat ASCII", () => {
    const { lastFrame } = render(<Header running={false} />);
    const frame = lastFrame()!;
    const catIdx = frame.indexOf("/\\_/\\");
    const hintIdx = frame.indexOf("? shortcuts");
    expect(catIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(catIdx).toBeLessThan(hintIdx);
  });

  test("header is 4 rows", () => {
    const { lastFrame } = render(<Header running />);
    const lines = lastFrame()!.split("\n").filter(Boolean);
    expect(lines!.length).toBe(4);
  });
});

// ── StatusBar ──

describe("StatusBar", () => {
  test("shows Planning phase with ○ icon", () => {
    const status = fakeStatus({ phase: "planning" });
    const { lastFrame } = render(<StatusBar status={status} compacting={false} timerKey={0} onTick={noop} running />);
    expect(lastFrame()).toContain("Planning");
  });

  test("shows Building phase with ● icon", () => {
    const status = fakeStatus({ phase: "building" });
    const { lastFrame } = render(<StatusBar status={status} compacting={false} timerKey={0} onTick={noop} running />);
    expect(lastFrame()).toContain("Building");
  });

  test("shows plan progress when plan is active", () => {
    const status = fakeStatus({
      plan: {
        name: "Test", description: "", status: "in_progress",
        steps: [
          { step: "Init", status: "completed" },
          { step: "Build", status: "in_progress" },
        ],
      },
      currentNode: null,
    });
    const { lastFrame } = render(<StatusBar status={status} compacting={false} timerKey={0} onTick={noop} running />);
    expect(lastFrame()).toContain("Step 1/2: Build");
  });

  test("falls back to currentNode when no plan", () => {
    const status = fakeStatus({ plan: null, currentNode: "tools" });
    const { lastFrame } = render(<StatusBar status={status} compacting={false} timerKey={0} onTick={noop} running />);
    expect(lastFrame()).toContain("tools");
  });

  test("shows empty when no plan and no currentNode", () => {
    const status = fakeStatus({ plan: null, currentNode: null });
    const { lastFrame } = render(<StatusBar status={status} compacting={false} timerKey={0} onTick={noop} running />);
    expect(lastFrame()).not.toContain("—");
  });

  test("shows compacting indicator", () => {
    const status = fakeStatus();
    const { lastFrame } = render(<StatusBar status={status} compacting timerKey={0} onTick={noop} running />);
    expect(lastFrame()).toContain("Compacting");
  });

  test("status bar is single row", () => {
    const status = fakeStatus();
    const { lastFrame } = render(<StatusBar status={status} compacting={false} timerKey={0} onTick={noop} running />);
    const lines = lastFrame()!.split("\n").filter(Boolean);
    expect(lines!.length).toBe(1);
  });
});

describe("StatsLine", () => {
  test("shows model name", () => {
    const status = fakeStatus({ modelName: "gpt-5" });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("gpt-5");
  });

  test("shows thinking mode", () => {
    const status = fakeStatus({ thinkingMode: "detailed" });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("think: detailed");
  });

  test("shows cache hit rate", () => {
    const status = fakeStatus({ cacheHitRate: 75 });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("cache: 75%");
  });

  test("shows token count formatted", () => {
    const status = fakeStatus({ totalTokens: 10000 });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("10.0k");
  });

  test("shows [完全] for full_access auth", () => {
    const status = fakeStatus({ authorization: "full_access" });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("[完全]");
  });

  test("shows [安全] for default auth", () => {
    const status = fakeStatus({ authorization: "default" });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("[安全]");
  });

  test("shows rw for write access", () => {
    const status = fakeStatus({ workspaceAccess: "write" });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("rw");
  });

  test("shows ro for read-only access", () => {
    const status = fakeStatus({ workspaceAccess: "read-only" });
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={0} />);
    expect(lastFrame()).toContain("ro");
  });

  test("shows timer when running", () => {
    const status = fakeStatus();
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running elapsed={42} />);
    expect(lastFrame()).toContain("00:42");
  });

  test("hides timer when not running", () => {
    const status = fakeStatus();
    const { lastFrame } = render(<StatsLine status={status} thinkingVisible running={false} elapsed={0} />);
    expect(lastFrame()).not.toContain("│ 00:");
  });
});

// ── DiffPreview ──

describe("DiffPreview", () => {
  test("renders header and file changes", () => {
    const changes: FileChangeRecord[] = [
      { path: "src/foo.ts", kind: "add", linesAdded: 5 },
      { path: "src/bar.ts", kind: "delete", linesRemoved: 3 },
    ];
    const { lastFrame } = render(<DiffPreview changes={changes} />);
    const frame = lastFrame();
    expect(frame).toContain("File Changes");
    expect(frame).toContain("+ src/foo.ts");
    expect(frame).toContain("- src/bar.ts");
  });

  test("shows edit prefix for edit kind", () => {
    const changes: FileChangeRecord[] = [{ path: "src/baz.ts", kind: "edit", linesAdded: 2, linesRemoved: 1 }];
    const { lastFrame } = render(<DiffPreview changes={changes} />);
    expect(lastFrame()).toContain("~ src/baz.ts");
  });

  test("renders empty string for empty changes array", () => {
    const { lastFrame } = render(<DiffPreview changes={[]} />);
    expect(lastFrame()).toBe("");
  });
});

// ── MarkdownBlock ──

describe("MarkdownBlock", () => {
  test("renders plain text", () => {
    const { lastFrame } = render(<MarkdownBlock content="Hello world" />);
    expect(lastFrame()).toContain("Hello world");
  });

  test("renders # heading", () => {
    const { lastFrame } = render(<MarkdownBlock content="# Title" />);
    expect(lastFrame()).toContain("Title");
  });

  test("renders ## heading with dashes", () => {
    const { lastFrame } = render(<MarkdownBlock content="## Section" />);
    expect(lastFrame()).toContain("── Section ──");
  });

  test("renders ### heading", () => {
    const { lastFrame } = render(<MarkdownBlock content="### Subsection" />);
    expect(lastFrame()).toContain("Subsection");
  });

  test("renders list items with bullet", () => {
    const { lastFrame } = render(<MarkdownBlock content="- item one\n- item two" />);
    const frame = lastFrame();
    expect(frame).toContain("item one");
    expect(frame).toContain("item two");
  });

  test("renders blockquote", () => {
    const { lastFrame } = render(<MarkdownBlock content="> quoted text" />);
    expect(lastFrame()).toContain("quoted text");
  });

  test("renders code block with lang label and line prefix", () => {
    const { lastFrame } = render(
      <MarkdownBlock content={"```ts\nconst x = 1;\nreturn x;\n```"} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("┌─ ts ─");
    expect(frame).toContain("const x = 1");
  });

  test("renders empty lines as spacing", () => {
    const { lastFrame } = render(<MarkdownBlock content="line1\n\nline3" />);
    const lines = lastFrame()!.split("\n");
    // There should be content on multiple lines
    expect(lines!.some((l) => l.includes("line1"))).toBe(true);
    expect(lines!.some((l) => l.includes("line3"))).toBe(true);
  });

  test("renders inline bold", () => {
    const { lastFrame } = render(<MarkdownBlock content="normal **bold** text" />);
    expect(lastFrame()).toContain("bold");
    expect(lastFrame()).toContain("normal");
  });

  test("renders inline code", () => {
    const { lastFrame } = render(<MarkdownBlock content="use `code` here" />);
    expect(lastFrame()).toContain("code");
  });
});

// ── HelpPanel ──

describe("HelpPanel", () => {
  test("renders title and sections", () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame();
    expect(frame).toContain("快捷键");
    expect(frame).toContain("Actions");
    // Remaining sections may be clipped by maxHeight in test environment
  });

  test("shows key bindings", () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    const frame = lastFrame();
    expect(frame).toContain("Ctrl+C");
    expect(frame).toContain("Cancel / Stop generation");
  });

  test("shows close hint", () => {
    const { lastFrame } = render(<HelpPanel onClose={noop} />);
    expect(lastFrame()).toContain("Esc 关闭  ↑↓ 滚动");
  });
});

// ── ModelSelector ──

describe("ModelSelector", () => {
  test("renders title and model list", () => {
    const { lastFrame } = render(
      <ModelSelector currentModel="deepseek-chat" onSelect={noop} onClose={noop} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("选择模型");
    expect(frame).toContain("deepseek-v4-flash");
  });

  test("marks current model", () => {
    const { lastFrame } = render(
      <ModelSelector currentModel="deepseek-v4-flash" onSelect={noop} onClose={noop} />,
    );
    expect(lastFrame()).toContain("(current)");
  });

  test("shows navigation hints", () => {
    const { lastFrame } = render(
      <ModelSelector currentModel="deepseek-v4" onSelect={noop} onClose={noop} />,
    );
    expect(lastFrame()).toContain("导航");
    expect(lastFrame()).toContain("Esc 取消");
  });
});

// ── StartupScreen ──

describe("StartupScreen", () => {
  test("renders banner and model info", () => {
    const { lastFrame } = render(
      <StartupScreen modelName="claude-opus" workspace="/tmp/test-project" />,
    );
    const frame = lastFrame();
    expect(frame).toContain("openpx");
    expect(frame).toContain("claude-opus");
  });

  test("shows project name from workspace path", () => {
    const { lastFrame } = render(
      <StartupScreen modelName="deepseek" workspace="/home/user/my-project" />,
    );
    expect(lastFrame()).toContain("my-project");
  });

  test("shows workspace path", () => {
    const { lastFrame } = render(
      <StartupScreen modelName="gpt-4o" workspace="/home/user/my-project" />,
    );
    expect(lastFrame()).toContain("/home/user/my-project");
  });

  test("shows help tips", () => {
    const { lastFrame } = render(
      <StartupScreen modelName="claude" workspace="/tmp/ws" />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Type your task and press Enter to start");
    expect(frame).toContain("/help");
  });
});

// ── ApprovalBlock ──

describe("ApprovalBlock", () => {
  test("renders approval header and command", () => {
    const approval = fakeApproval({ command: "rm -rf /tmp/test" });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Approval");
    expect(frame).toContain("rm -rf /tmp/test");
  });

  test("shows risk level", () => {
    const approval = fakeApproval({ risk: "destructive" });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("destructive");
  });

  test("shows summary", () => {
    const approval = fakeApproval({ summary: "Delete temp files" });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("Delete temp files");
  });

  test("shows reason when present", () => {
    const approval = fakeApproval({ reason: "Cleanup needed" });
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("Cleanup needed");
  });

  test("shows all grant options", () => {
    const approval = fakeApproval();
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("[A]");
    expect(frame).toContain("[S]");
    expect(frame).toContain("[F]");
    expect(frame).toContain("[D]");
    expect(frame).toContain("Approve once");
    expect(frame).toContain("Same command");
    expect(frame).toContain("Full access");
    expect(frame).toContain("Deny");
  });

  test("shows keyboard hint", () => {
    const approval = fakeApproval();
    const { lastFrame } = render(
      <ApprovalBlock approval={approval} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("Press key to select");
  });
});

// ── InputBlock ──

describe("InputBlock", () => {
  test("renders question text", () => {
    const question = fakeQuestion({ question: "What now?" });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("What now?");
  });

  test("shows options list when options provided", () => {
    const question = fakeQuestion({
      options: [
        { id: "a", label: "Proceed", description: "Continue forward" },
        { id: "b", label: "Abort", description: "Stop here" },
      ],
    });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Proceed");
    expect(frame).toContain("Abort");
  });

  test("shows free text input when no options", () => {
    const question = fakeQuestion({ options: [], allow_free_text: true });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain(">");
  });

  test("shows context when provided", () => {
    const question = fakeQuestion({ context: "Here is some context" });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("Here is some context");
  });

  test("shows Tab hint when free text is allowed", () => {
    const question = fakeQuestion({ allow_free_text: true });
    const { lastFrame } = render(
      <InputBlock question={question} provider={fakeProvider()} onResolved={onResolved} />,
    );
    expect(lastFrame()).toContain("[Tab]");
  });
});

// ── InputLine ──

describe("InputLine", () => {
  test("renders prompt for prompt mode", () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("❯");
  });

  test("renders [A/S/F/D] for approval mode", () => {
    const { lastFrame } = render(
      <InputLine mode="approval" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("[A/S/F/D]");
  });

  test("renders ? for question mode", () => {
    const { lastFrame } = render(
      <InputLine mode="question" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("?");
  });

  test("shows disabled message when disabled", () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" onSubmit={noop} disabled workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("Waiting for response...");
  });

  test("shows placeholder text", () => {
    const { lastFrame } = render(
      <InputLine
        mode="prompt"
        onSubmit={noop}
        placeholder="Type here..."
        workspace={process.cwd()}
      />,
    );
    expect(lastFrame()).toContain("Type here...");
  });
});

// ── OutputArea ──

describe("OutputArea", () => {
  test("renders user block with chevron prefix", () => {
    const blocks: OutputBlock[] = [{ id: 1, kind: "user", content: "Hello agent" }];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("❯ Hello agent");
  });

  test("renders text block", () => {
    const blocks: OutputBlock[] = [{ id: 1, kind: "text", content: "Response text" }];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Response text");
  });

  test("renders reason block with toggle indicator", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "reason", content: "Thinking about it...", folded: false },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Thinking");
  });

  test("renders folded reason block", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "reason", content: "Hidden thoughts", folded: true },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Thinking...");
  });

  test("hides reason content when thinkingVisible is false", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "reason", content: "Secret", folded: true },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible={false} />,
    );
    expect(lastFrame()).toContain("Thinking...");
    expect(lastFrame()).not.toContain("Secret");
  });

  test("renders tool_card with running status", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "tool_card", callId: "c1", name: "shell_execute", args: {}, status: "running", summary: "", preview: "npm test" },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    const frame = lastFrame();
    expect(frame).toContain("shell_execute");
    expect(frame).toContain("npm test");
  });

  test("renders tool_card with done status, hides summary for success, shows elapsed", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "tool_card", callId: "c1", name: "read_file", args: {}, status: "done", summary: "OK", preview: "foo.ts", elapsedMs: 1234, detail: "Read foo.ts" },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    const frame = lastFrame();
    // Summary hidden for success
    expect(frame).not.toContain("OK");
    // Elapsed time now shown for all tools (not just shell_execute)
    expect(frame).toContain("1.2s");
  });

  test("renders tool_card with error status and shows summary", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "tool_card", callId: "c1", name: "shell_execute", args: {}, status: "error", summary: "command not found", elapsedMs: 100 },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    const frame = lastFrame();
    expect(frame).toContain("command not found");
    expect(frame).toContain("100ms");
  });

  test("renders tool_card with detail annotation", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "tool_card", callId: "c1", name: "edit_file", args: {}, status: "done", summary: "", detail: "+3 -2" },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    const frame = lastFrame();
    expect(frame).toContain("+3 -2");
  });

  test("renders file_change block", () => {
    const blocks: OutputBlock[] = [
      {
        id: 1, kind: "file_change",
        changes: [{ path: "src/a.ts", kind: "add", linesAdded: 10 }],
      },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    const frame = lastFrame();
    expect(frame).toContain("File Changes");
    expect(frame).toContain("+ src/a.ts");
    expect(frame).toContain("+10");
  });

  test("renders approval block with awaiting message", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "approval", approval: fakeApproval({ command: "npm publish" }) },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Awaiting approval");
    expect(lastFrame()).toContain("npm publish");
  });

  test("renders resolved approval block", () => {
    const blocks: OutputBlock[] = [
      {
        id: 1, kind: "approval",
        approval: fakeApproval(),
        resolved: { action: "full_access", grant: "full_access" },
      },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Approved (full access)");
  });

  test("renders denied approval block", () => {
    const blocks: OutputBlock[] = [
      {
        id: 1, kind: "approval",
        approval: fakeApproval(),
        resolved: { action: "denied" },
      },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Denied");
  });

  test("renders question block", () => {
    const blocks: OutputBlock[] = [
      { id: 1, kind: "question", question: fakeQuestion({ question: "Continue?" }) },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Question");
  });

  test("renders resolved question block", () => {
    const blocks: OutputBlock[] = [
      {
        id: 1, kind: "question",
        question: fakeQuestion(),
        resolved: "Yes please",
      },
    ];
    const { lastFrame } = render(
      <OutputArea blocks={blocks} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toContain("Yes please");
  });

  test("renders empty when no blocks", () => {
    const { lastFrame } = render(
      <OutputArea blocks={[]} onToggleReason={noop} thinkingVisible />,
    );
    expect(lastFrame()).toBe("");
  });
});

// ── App (main layout) ──

describe("App", () => {
  function fakeState(overrides: Partial<TuiState> = {}): TuiState {
    return {
      sessions: [],
      activeSessionId: null,
      blocks: [],
      nextBlockId: 1,
      interrupt: null,
      status: fakeStatus(),
      exited: false,
      running: false,
      compacting: false,
      runCount: 0,
      thinkingVisible: true,
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
      editorRequested: false,
      sessionError: false,
      loadingSession: false,
      ...overrides,
    };
  }

  test("renders Header with OpenPX before ActivityBar", () => {
    const state = fakeState();
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    const frame = lastFrame();
    // Header (OpenPX) should appear before ActivityBar (since it renders first in layout)
    const headerIdx = frame!.indexOf("OpenPX");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
  });

  test("shows HelpPanel when showHelp is true", () => {
    const state = fakeState({ showHelp: true });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(lastFrame()).toContain("快捷键");
  });

  test("hides HelpPanel when showHelp is false", () => {
    const state = fakeState({ showHelp: false });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(lastFrame()).not.toContain("快捷键");
  });

  test("shows ModelSelector when showModelSelector is true", () => {
    const state = fakeState({ showModelSelector: true });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(lastFrame()).toContain("选择模型");
  });

  test("shows ApprovalBlock when interrupt is approval", () => {
    const approval = fakeApproval();
    const state = fakeState({
      blocks: [{ id: 1, kind: "approval", approval }],
      interrupt: { kind: "approval", blockId: 1 },
    });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(lastFrame()).toContain("Approval");
  });

  test("shows InputBlock when interrupt is question", () => {
    const question = fakeQuestion();
    const state = fakeState({
      blocks: [{ id: 1, kind: "question", question }],
      interrupt: { kind: "input", blockId: 1 },
    });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(lastFrame()).toContain(question.question);
  });

  test("does not show ApprovalBlock when resolved", () => {
    const approval = fakeApproval();
    const state = fakeState({
      blocks: [
        { id: 1, kind: "approval", approval, resolved: { action: "approve", grant: "full_access" } },
      ],
      interrupt: { kind: "approval", blockId: 1 },
    });
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      />,
    );
    expect(lastFrame()).not.toContain("[A] Approve once");
  });

  test("renders children when provided", () => {
    const state = fakeState();
    const InputLine = require("../src/app/tui/components/InputLine").default;
    const { lastFrame } = render(
      <App
        state={state}
        dispatch={noop}
        onToggleReason={noop}
        provider={fakeProvider()}
      >
        <InputLine mode="prompt" onSubmit={noop} workspace={process.cwd()} />
      </App>,
    );
    // children InputLine should be rendered
    const frame = lastFrame();
    const promptIdx = frame!.indexOf(">");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
  });
});

// ── SubAgent block rendering ──
import SubAgentBlock from "../src/app/tui/components/SubAgentBlock";

describe("SubAgentBlock rendering", () => {
  test("renders running subagent block with steps", () => {
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "code" as const, task: "fix auth bug",
      status: "running" as const, summary: "", toolCallCount: 0, durationMs: 0,
      steps: [
        { toolName: "read_file", toolArgs: { path: "auth.ts" }, ok: true },
        { toolName: "edit_file", toolArgs: { path: "auth.ts" } },
      ],
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▸");
    expect(frame).toContain("Code");
    expect(frame).toContain("fix auth bug");
    expect(frame).toContain("read_file");
    expect(frame).toContain("edit_file");
    expect(frame).toContain("✓"); // ok: true on first step
  });

  test("renders done subagent block with summary", () => {
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "review" as const, task: "review PR #42",
      status: "done" as const, summary: "No critical issues found.\n2 warnings in auth.ts.", toolCallCount: 5, durationMs: 3200,
      steps: [],
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▼");
    expect(frame).toContain("Review");
    expect(frame).toContain("review PR #42");
    expect(frame).toContain("5 次工具调用");
    expect(frame).toContain("3.2s");
    expect(frame).toContain("No critical issues found");
  });

  test("renders error subagent block", () => {
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "explore" as const, task: "find refs",
      status: "error" as const, summary: "", toolCallCount: 0, durationMs: 0,
      error: "Sub-agent timed out after 1800000ms",
      steps: [],
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("Explore");
    expect(frame).toContain("timed out");
  });

  test("renders explore role icon and label correctly", () => {
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "explore" as const, task: "search all",
      status: "running" as const, summary: "", toolCallCount: 0, durationMs: 0,
      steps: [],
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("🔍");
    expect(frame).toContain("Explore");
  });

  test("long task text is truncated to first line in block", () => {
    const longTask = "find all usages of the UserService class across the entire codebase including tests\n\nDetailed instructions:\n- Check every file";
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "code" as const, task: longTask,
      status: "running" as const, summary: "", toolCallCount: 0, durationMs: 0,
      steps: [],
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    // First line should be visible
    expect(frame).toContain("find all usages of the UserService class");
    // Second line should NOT be visible
    expect(frame).not.toContain("Detailed instructions");
  });

  test("done block truncates long summaries", () => {
    const longSummary = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join("\n");
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "explore" as const, task: "search",
      status: "done" as const, summary: longSummary, toolCallCount: 3, durationMs: 1200,
      steps: [],
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Line 1");
    expect(frame).toContain("Line 8");
    expect(frame).toContain("已折叠");
    expect(frame).not.toContain("Line 9");
  });

  test("running block limits visible steps", () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({
      toolName: `step_${String(i + 1).padStart(2, "0")}`,
      toolArgs: {},
    }));
    const block = {
      id: 1, kind: "subagent" as const,
      subagentId: "sub-1", role: "code" as const, task: "fix bug",
      status: "running" as const, summary: "", toolCallCount: 0, durationMs: 0,
      steps,
    };
    const { lastFrame } = render(
      <SubAgentBlock block={block} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已折叠");
    expect(frame).toContain("step_15"); // last step should be visible
    expect(frame).toContain("step_06"); // within last 10
    expect(frame).not.toContain("step_05"); // too old, folded
  });
});
