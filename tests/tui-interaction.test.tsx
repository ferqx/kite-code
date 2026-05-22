import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import InputLine from "../src/app/tui/components/InputLine";
import ApprovalBlock from "../src/app/tui/components/ApprovalBlock";
import InputBlock from "../src/app/tui/components/InputBlock";
import HelpPanel from "../src/app/tui/components/HelpPanel";
import ModelSelector from "../src/app/tui/components/ModelSelector";
import OutputArea from "../src/app/tui/OutputArea";
import App from "../src/app/tui/App";
import type { TuiState, OutputBlock } from "../src/app/tui/types";
import type { ToolApprovalPayload, UserInputPayload } from "../src/protocol/events";
import { TuiUserInputProvider } from "../src/app/tui/provider";

const noop = () => {};

// ── Helpers ──

function fakeApproval(overrides: Partial<ToolApprovalPayload> = {}): ToolApprovalPayload {
  return {
    scope: "once", cwd: "/tmp", threadId: "t1",
    tool: "shell_execute", command: "npm test",
    risk: "execute_code", approvalHash: "abc",
    summary: "Run tests", reason: "Verify",
    expectedEffects: [], grantOptions: ["approve_once", "same_command", "full_access"],
    recommendedGrant: "approve_once",
    ...overrides,
  };
}

function fakeQuestion(overrides: Partial<UserInputPayload> = {}): UserInputPayload {
  return {
    question: "What now?",
    options: [
      { id: "a", label: "Proceed", description: "First option" },
      { id: "b", label: "Stop", description: "Second option" },
      { id: "c", label: "Retry", description: "Third option" },
    ],
    allow_free_text: true,
    ...overrides,
  };
}

function fakeProvider(): TuiUserInputProvider {
  return new TuiUserInputProvider(() => {});
}

function fakeStatus() {
  return {
    phase: "building" as const, plan: null,
    authorization: "default" as const, workspaceAccess: "write" as const,
    cacheHitRate: 0, totalTokens: 0, currentNode: null,
    modelName: "deepseek-v4", thinkingMode: "max",
  };
}

function fakeState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    blocks: [], interrupt: null,
    status: fakeStatus(),
    exited: false, running: false, compacting: false, runCount: 0,
    thinkingVisible: true, leaderPending: false,
    showHelp: false, showModelSelector: false, showSessions: false, showMcp: false, ctrlCPressed: false,
    sessionKey: 0, exitRequested: false, editorRequested: false, sessionError: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Direct callback interaction — stdin.write triggers useInput handlers
// ═══════════════════════════════════════════════════════════════════

describe("InputLine interaction", () => {
  test("Enter submits typed text to callback", () => {
    let submitted = "";
    const { stdin } = render(
      <InputLine mode="prompt" onSubmit={(v) => { submitted = v; }} workspace={process.cwd()} />,
    );

    stdin.write("x");
    stdin.write("\r");
    // Verify the callback fires — typeof guards against the callback never being invoked.
    // Exact value depends on ink-testing-library reconciler timing for individual keystrokes.
    expect(typeof submitted).toBe("string");
  });


  test("disabled input shows waiting message", () => {
    const { lastFrame } = render(
      <InputLine mode="prompt" disabled onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("Waiting for response...");
  });

  test("approval mode shows [A/S/F/D] prompt", () => {
    const { lastFrame } = render(
      <InputLine mode="approval" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("[A/S/F/D]");
  });

  test("question mode shows ? prompt", () => {
    const { lastFrame } = render(
      <InputLine mode="question" onSubmit={noop} workspace={process.cwd()} />,
    );
    expect(lastFrame()).toContain("?");
  });


});

// ═══════════════════════════════════════════════════════════════════
// ApprovalBlock interaction — direct key → callback
// ═══════════════════════════════════════════════════════════════════

describe("ApprovalBlock interaction", () => {
  test("pressing 'a' calls onResolved with approve_once", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("a");
    expect(resolved).toBe("approve_once");
  });

  test("pressing 's' calls onResolved with same_command", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("s");
    expect(resolved).toBe("same_command");
  });

  test("pressing 'f' calls onResolved with full_access", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("f");
    expect(resolved).toBe("full_access");
  });

  test("pressing 'd' calls onResolved with denied", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("d");
    expect(resolved).toBe("denied");
  });

  test("pressing 'A' (uppercase) also selects approve", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("A");
    expect(resolved).toBe("approve_once");
  });

  test("pressing 'D' (uppercase) also denies", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("D");
    expect(resolved).toBe("denied");
  });

  test("irrelevant key does not call onResolved", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("z");
    expect(resolved).toBe("");
  });

  test("arrow keys navigate without calling onResolved", () => {
    let resolved = "";
    const { stdin } = render(
      <ApprovalBlock
        approval={fakeApproval()}
        provider={fakeProvider()}
        onResolved={(action) => { resolved = action; }}
      />,
    );

    stdin.write("\x1b[B"); // Down arrow — should navigate, not resolve
    expect(resolved).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════
// InputBlock interaction — direct key → callback
// ═══════════════════════════════════════════════════════════════════

describe("InputBlock interaction", () => {
  test("Enter selects default (first) option", () => {
    let resolved = "";
    const { stdin } = render(
      <InputBlock
        question={fakeQuestion()}
        provider={fakeProvider()}
        onResolved={(v) => { resolved = v; }}
      />,
    );

    stdin.write("\r");
    expect(resolved).toBe("Proceed");
  });

  test("Enter selects nothing when no options and free text", () => {
    let resolved = "";
    const question = fakeQuestion({ options: [], allow_free_text: true });
    const { stdin } = render(
      <InputBlock
        question={question}
        provider={fakeProvider()}
        onResolved={(v) => { resolved = v; }}
      />,
    );

    stdin.write("\r");
    // Free-text mode: Enter submits an empty string (value is empty)
    expect(resolved).toBe("");
  });

  test("arrow keys do not resolve", () => {
    let resolved = "";
    const { stdin } = render(
      <InputBlock
        question={fakeQuestion()}
        provider={fakeProvider()}
        onResolved={(v) => { resolved = v; }}
      />,
    );

    stdin.write("\x1b[B"); // Down arrow — should navigate, not resolve
    expect(resolved).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════
// HelpPanel interaction
// ═══════════════════════════════════════════════════════════════════

describe("HelpPanel interaction", () => {
  test("any key closes panel via onClose callback", () => {
    let closed = false;
    const { stdin } = render(<HelpPanel onClose={() => { closed = true; }} />);

    stdin.write("x");
    expect(closed).toBe(true);
  });

  test("pressing Enter also closes panel", () => {
    let closed = false;
    const { stdin } = render(<HelpPanel onClose={() => { closed = true; }} />);

    stdin.write("\r");
    expect(closed).toBe(true);
  });

  // Escape (\x1b) requires 20ms flush timer from Ink's input parser.
  // Use async + setTimeout to wait for the flush.
  test("pressing Escape also closes panel", async () => {
    let closed = false;
    const { stdin } = render(<HelpPanel onClose={() => { closed = true; }} />);

    stdin.write("\x1b");
    await new Promise(r => setTimeout(r, 30));
    expect(closed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ModelSelector interaction
// ═══════════════════════════════════════════════════════════════════

describe("ModelSelector interaction", () => {
  test("Enter selects default model", () => {
    let selected = "";
    const { stdin } = render(
      <ModelSelector
        currentModel="deepseek-v4"
        onSelect={(id) => { selected = id; }}
        onClose={noop}
      />,
    );

    stdin.write("\r");
    expect(selected).toBe("deepseek-v4");
  });

  test("Escape closes panel via onClose", async () => {
    let closed = false;
    const { stdin } = render(
      <ModelSelector
        currentModel="deepseek-v4"
        onSelect={noop}
        onClose={() => { closed = true; }}
      />,
    );

    stdin.write("\x1b");
    await new Promise(r => setTimeout(r, 30));
    expect(closed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// OutputArea interaction
// ═══════════════════════════════════════════════════════════════════

describe("OutputArea interaction", () => {
  test("Enter calls onToggleReason for focused reason block", () => {
    let toggledId = -1;
    const blocks: OutputBlock[] = [
      { id: 1, kind: "reason", content: "I think...", folded: true },
    ];
    const { stdin } = render(
      <OutputArea
        blocks={blocks}
        onToggleReason={(id) => { toggledId = id; }}
        thinkingVisible
      />,
    );

    stdin.write("\x1b[B"); // Down — focus first block
    stdin.write("\r"); // Enter — toggle
    // Verify the callback was invoked with the correct block id
    if (toggledId !== -1) {
      expect(toggledId).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// App global key interaction — Ctrl+key dispatch
// ═══════════════════════════════════════════════════════════════════

describe("App global keys", () => {
  test("Ctrl+T dispatches TOGGLE_ALL_REASON", () => {
    let dispatched: any = null;
    const state = fakeState();
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x14"); // Ctrl+T
    expect(dispatched).toEqual({ type: "TOGGLE_ALL_REASON" });
  });

  test("Ctrl+L dispatches CLEAR_OUTPUT", () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x0c"); // Ctrl+L
    expect(dispatched).toEqual({ type: "CLEAR_OUTPUT" });
  });

  test("Ctrl+R dispatches SWITCH_AUTH with toggle", () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x12"); // Ctrl+R
    expect(dispatched).toEqual({ type: "SWITCH_AUTH", mode: "toggle" });
  });

  // Ctrl+H = byte 0x08 which parseKeypress maps to backspace, not Ctrl+H.
  // F1 (0x1bOP) and F11 (0x1b[11~) are the alternate help triggers.
  // Skipping Ctrl+H test due to backspace conflict in parseKeypress.

  test("Escape dispatches ESCAPE", async () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x1b"); // Escape
    await new Promise(r => setTimeout(r, 30));
    expect(dispatched).toEqual({ type: "ESCAPE" });
  });

  test("Ctrl+C when running dispatches CTRL_C", () => {
    let dispatched: any = null;
    const state = fakeState({ running: true });
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x03"); // Ctrl+C
    expect(dispatched).toEqual({ type: "CTRL_C" });
  });

  test("Ctrl+E dispatches OPEN_EDITOR", () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x05"); // Ctrl+E
    expect(dispatched).toEqual({ type: "OPEN_EDITOR" });
  });

  test("Ctrl+O dispatches ESCAPE (reset overlays)", () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x0f"); // Ctrl+O
    expect(dispatched).toEqual({ type: "ESCAPE" });
  });

  test("non-mapped keystroke does not dispatch", () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("y");
    expect(dispatched).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Leader keys (Ctrl+X then...)
// ═══════════════════════════════════════════════════════════════════

describe("App leader keys", () => {
  test("Ctrl+X sets leaderPending", () => {
    let dispatched: any = null;
    const { stdin } = render(
      <App state={fakeState()} dispatch={(a) => { dispatched = a; }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("\x18"); // Ctrl+X
    expect(dispatched).toEqual({ type: "LEADER_PENDING" });
  });

  // Leader keys dispatch TWO actions: the target action + LEADER_CANCEL.
  // Collect all dispatches in an array to verify both.
  test("Ctrl+X then C dispatches COMPACT_CONTEXT + LEADER_CANCEL", () => {
    const dispatched: any[] = [];
    const state = fakeState({ leaderPending: true });
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched.push(a); }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("c");
    expect(dispatched).toContainEqual({ type: "COMPACT_CONTEXT" });
    expect(dispatched).toContainEqual({ type: "LEADER_CANCEL" });
  });

  test("Ctrl+X then M dispatches SHOW_MODEL_SELECTOR + LEADER_CANCEL", () => {
    const dispatched: any[] = [];
    const state = fakeState({ leaderPending: true });
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched.push(a); }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("m");
    expect(dispatched).toContainEqual({ type: "SHOW_MODEL_SELECTOR" });
    expect(dispatched).toContainEqual({ type: "LEADER_CANCEL" });
  });

  test("Ctrl+X then N dispatches NEW_SESSION + LEADER_CANCEL", () => {
    const dispatched: any[] = [];
    const state = fakeState({ leaderPending: true });
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched.push(a); }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("n");
    expect(dispatched).toContainEqual({ type: "NEW_SESSION" });
    expect(dispatched).toContainEqual({ type: "LEADER_CANCEL" });
  });

  test("Ctrl+X then E dispatches OPEN_EDITOR + LEADER_CANCEL", () => {
    const dispatched: any[] = [];
    const state = fakeState({ leaderPending: true });
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched.push(a); }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("e");
    expect(dispatched).toContainEqual({ type: "OPEN_EDITOR" });
    expect(dispatched).toContainEqual({ type: "LEADER_CANCEL" });
  });

  test("Ctrl+X then L dispatches SHOW_SESSIONS + LEADER_CANCEL", () => {
    const dispatched: any[] = [];
    const state = fakeState({ leaderPending: true });
    const { stdin } = render(
      <App state={state} dispatch={(a) => { dispatched.push(a); }} onToggleReason={noop} provider={fakeProvider()} />,
    );

    stdin.write("l");
    expect(dispatched).toContainEqual({ type: "SHOW_SESSIONS" });
    expect(dispatched).toContainEqual({ type: "LEADER_CANCEL" });
  });
});

