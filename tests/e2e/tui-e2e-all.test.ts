import { describe, test, expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import { runRealAgentE2E } from "./real-agent";
import { verifyScenario } from "./helpers";
import * as AV from "./scenarios/approval-variants";
import * as QV from "./scenarios/question-variants";
import * as AM from "./scenarios/agent-messages";
import * as TF from "./scenarios/tool-flow";
import * as SD from "./scenarios/state-display";
import * as IF from "./scenarios/input-flow";
import * as FS from "./scenarios/failure-scenarios";
import * as SC from "./scenarios/slash-commands";
import * as KS from "./scenarios/keyboard-shortcuts";
import * as SS from "./scenarios/settings-session";
import * as VP from "./scenarios/viewport-culling";
import * as RC from "./scenarios/real-agent-conversation";

const UPDATE = Bun.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "true";

const label = UPDATE ? "[UPDATE]" : "[VERIFY]";

// ══════════════════════════════════════════════════════════
// Enhanced verification helper
// ══════════════════════════════════════════════════════════

function verify(name: string, s: { scenario: any; expectations: any[] }, count: number) {
  return verifyScenario(name, s.scenario, count, s.expectations);
}

// ══════════════════════════════════════════════════════════
// Approval variants
// ══════════════════════════════════════════════════════════

describe(`${label} Approval variants`, () => {
  test("approve_once", async () => {
    await verifyScenario("approval-variants-approve-once", AV.approveOnce, 2).verifyAll();
  });
  test("same_command", async () => {
    await verifyScenario("approval-variants-same-command", AV.approveSameCommand, 2).verifyAll();
  });
  test("full_access", async () => {
    await verifyScenario("approval-variants-full-access", AV.approveFullAccess, 2).verifyAll();
  });
  test("deny approval", async () => {
    await verifyScenario("approval-variants-deny", AV.denyApproval, 2).verifyAll();
  });
  test("write_file approval with text", async () => {
    await verifyScenario("approval-variants-write-file", AV.approveWriteFile, 2).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Question / Input variants
// ══════════════════════════════════════════════════════════

describe(`${label} Question variants`, () => {
  test("options only", async () => {
    await verifyScenario("question-variants-options", QV.questionOptions, 2).verifyAll();
  });
  test("free text only", async () => {
    await verifyScenario("question-variants-free-text", QV.questionFreeText, 2).verifyAll();
  });
  test("options + free text", async () => {
    await verifyScenario("question-variants-options-free-text", QV.questionOptionsAndFreeText, 2).verifyAll();
  });
  test("with context text", async () => {
    await verifyScenario("question-variants-context", QV.questionWithContext, 2).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Agent message types
// ══════════════════════════════════════════════════════════

describe(`${label} Agent messages`, () => {
  test("plain text output", async () => {
    await verifyScenario("agent-messages-plain-text", AM.plainText, 1).verifyAll();
  });
  test("reason (thinking) blocks", async () => {
    await verifyScenario("agent-messages-reason", AM.reasonBlock, 1).verifyAll();
  });
  test("long multi-block text", async () => {
    await verifyScenario("agent-messages-long-text", AM.longTextResponse, 1).verifyAll();
  });
  test("mixed reason and text", async () => {
    await verifyScenario("agent-messages-mixed", AM.mixedReasonAndText, 1).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Tool flow
// ══════════════════════════════════════════════════════════

describe(`${label} Tool flow`, () => {
  test("tool call without approval", async () => {
    await verifyScenario("tool-flow-no-approval", TF.toolCallNoApproval, 1).verifyAll();
  });
  test("multiple tool calls", async () => {
    await verifyScenario("tool-flow-multi", TF.multiToolCalls, 1).verifyAll();
  });
  test("tool with error", async () => {
    await verifyScenario("tool-flow-error", TF.toolError, 2).verifyAll();
  });
  test("mixed blocks with approval", async () => {
    await verifyScenario("tool-flow-mixed", TF.mixedBlocks, 2).verifyAll();
  });
  test("plan update tool", async () => {
    await verifyScenario("tool-flow-plan", TF.planUpdate, 1).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// State display
// ══════════════════════════════════════════════════════════

describe(`${label} State display`, () => {
  test("empty session", async () => {
    await verifyScenario("state-display-empty", SD.emptySession, 1).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Lifecycle events (error, retry, compaction, file-change, state-change, cache)
// ══════════════════════════════════════════════════════════

describe(`${label} Lifecycle events`, () => {
  test("error event renders in output", async () => {
    const result = await runTuiE2E({
      terminalWidth: 120,
      freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
      steps: [
        { type: "error", message: "Failed to parse response from model" },
        { type: "agent-done" },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(1);
    // Content verification: error message visible in output
    expect(result.snapshots[0].ansi).toContain("Error");
  });

  test("retry event renders", async () => {
    const result = await runTuiE2E({
      terminalWidth: 120,
      freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
      steps: [
        { type: "retry", attempt: 1, reason: "Connection timeout" },
        { type: "agent-done" },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.snapshots[0].ansi).toContain("Retry");
  });

  test("compaction begin/end", async () => {
    const result = await runTuiE2E({
      terminalWidth: 120,
      freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
      steps: [
        { type: "compact", reason: "Context budget exceeded", summary: "Compacted 5 messages → 1 summary" },
        { type: "agent-done" },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.snapshots[0].ansi).toContain("Compacting");
  });

  test("file change events coalesce", async () => {
    const result = await runTuiE2E({
      terminalWidth: 120,
      freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
      steps: [
        { type: "file-change", path: "src/utils.ts", kind: "add", linesAdded: 15 },
        { type: "file-change", path: "src/index.ts", kind: "edit", linesAdded: 3, linesRemoved: 1 },
        { type: "agent-done" },
      ],
    });
    expect(result.pass).toBe(true);
    // File changes render
    expect(result.snapshots[0].ansi).toContain("File Changes");
    expect(result.snapshots[0].ansi).toContain("src/utils.ts");
    expect(result.snapshots[0].ansi).toContain("src/index.ts");
  });

  test("state change events", async () => {
    const result = await runTuiE2E({
      terminalWidth: 120,
      freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
      steps: [
        { type: "state-change", phase: "planning" },
        { type: "agent-text", text: "Planning active." },
        { type: "state-change", phase: "building" },
        { type: "agent-text", text: "Building active." },
        { type: "agent-done" },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.snapshots[0].ansi).toContain("Planning active");
    expect(result.snapshots[0].ansi).toContain("Building active");
  });

  test("cache metrics events update status", async () => {
    const result = await runTuiE2E({
      terminalWidth: 120,
      freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
      steps: [
        { type: "cache-metrics", hitRate: 75, inputTokens: 500, outputTokens: 200 },
        { type: "agent-done" },
      ],
    });
    expect(result.pass).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// Input flow (simulate-input via stdin)
// ══════════════════════════════════════════════════════════

describe(`${label} Input flow`, () => {
  test("basic input → reply", async () => {
    await verifyScenario("input-flow-basic", IF.basicInputReply, 1).verifyAll();
  });

  test("input → tool call → approval", async () => {
    await verifyScenario("input-flow-tool-approval", IF.inputToolApproval, 2).verifyAll();
  });

  test("input → tool call → full_access", async () => {
    await verifyScenario("input-flow-full-access", IF.inputFullAccess, 2).verifyAll();
  });

  test("multi-turn conversation", async () => {
    await verifyScenario("input-flow-multi-turn", IF.multiTurn, 2).verifyAll();
  });

  test("Ctrl+C interrupt during running", async () => {
    await verifyScenario("input-flow-ctrl-c", IF.ctrlCInterrupt, 1).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Failure scenarios
// ══════════════════════════════════════════════════════════

describe(`${label} Failure scenarios`, () => {
  test("agent error mid-response", async () => {
    await verifyScenario("failure-agent-error", FS.agentError, 1).verifyAll();
  });

  test("operation retry (connection timeout)", async () => {
    await verifyScenario("failure-retry", FS.operationRetry, 1).verifyAll();
  });

  test("model API retry (rate limit)", async () => {
    await verifyScenario("failure-model-retry", FS.modelRetry, 1).verifyAll();
  });

  test("multiple model retries then success", async () => {
    await verifyScenario("failure-model-retries-success", FS.modelRetriesThenSuccess, 1).verifyAll();
  });

  test("tool execution error (shell non-zero exit)", async () => {
    await verifyScenario("failure-tool-error", FS.toolExecutionError, 2).verifyAll();
  });

  test("error then successful recovery", async () => {
    await verifyScenario("failure-recovery", FS.errorRecovery, 2).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Slash commands (dispatch → render pipeline)
// ══════════════════════════════════════════════════════════

describe(`${label} Slash commands`, () => {
  test("/help shows keyboard shortcuts panel", async () => {
    await verify("slash-help", SC.slashHelp, 1).verifyAll();
  });

  test("/setting shows current configuration", async () => {
    await verify("slash-setting", SC.slashSetting, 1).verifyAll();
  });

  test("/clear removes all output blocks", async () => {
    await verify("slash-clear", SC.slashClear, 2).verifyAll();
  });

  test("/thinking shows then hides reasoning", async () => {
    await verify("slash-thinking", SC.slashThinking, 3).verifyAll();
  });

  test("/auth switches authorization mode", async () => {
    await verify("slash-auth", SC.slashAuth, 1).verifyAll();
  });

  test("/model list displays available models", async () => {
    await verify("slash-model-list", SC.slashModelList, 1).verifyAll();
  });

  test("/plan switches to planning phase", async () => {
    await verify("slash-plan", SC.slashPlan, 1).verifyAll();
  });

  test("/compact requests context compaction", async () => {
    await verify("slash-compact", SC.slashCompact, 1).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Keyboard shortcuts
// ══════════════════════════════════════════════════════════

describe(`${label} Keyboard shortcuts`, () => {
  test("Ctrl+H shows help", async () => {
    await verify("kb-ctrl-h", KS.ctrlHShowHelp, 1).verifyAll();
  });

  test("Esc closes help", async () => {
    await verify("kb-esc-close-help", KS.escCloseHelp, 2).verifyAll();
  });

  test("Ctrl+L clears output", async () => {
    await verify("kb-ctrl-l", KS.ctrlLClearOutput, 2).verifyAll();
  });

  test("Ctrl+T expands/collapses all reasoning", async () => {
    await verify("kb-ctrl-t", KS.ctrlTToggleAllReason, 2).verifyAll();
  });

  test("Ctrl+R toggles authorization", async () => {
    await verify("kb-ctrl-r", KS.ctrlRToggleAuth, 1).verifyAll();
  });

  test("Ctrl+C first press sets ctrlCPressed", async () => {
    await verify("kb-ctrl-c-first", KS.ctrlCFirstPress, 1).verifyAll();
  });

  test("Ctrl+C second press sets exitRequested", async () => {
    await verify("kb-ctrl-c-second", KS.ctrlCSecondPress, 1).verifyAll();
  });

  test("Leader key cancel (Ctrl+X Esc)", async () => {
    await verify("kb-leader-cancel", KS.leaderCancel, 1).verifyAll();
  });

  test("Leader key new session (Ctrl+X N)", async () => {
    await verify("kb-leader-new-session", KS.leaderNewSession, 2).verifyAll();
  });

  test("Ctrl+O escape resets overlays", async () => {
    await verify("kb-ctrl-o", KS.ctrlOEscape, 1).verifyAll();
  });

  test("Enter expands folded reason block", async () => {
    await verify("kb-enter-expand-reason", KS.enterExpandReason, 2).verifyAll();
  });

  test("Enter collapses expanded reason block", async () => {
    await verify("kb-enter-collapse-reason", KS.enterCollapseReason, 3).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Settings, session, and exit
// ══════════════════════════════════════════════════════════

describe(`${label} Settings & Session`, () => {
  test("list models", async () => {
    await verify("settings-model-list", SS.modelList, 1).verifyAll();
  });

  test("list sessions shows stub", async () => {
    await verify("settings-sessions", SS.sessionsList, 1).verifyAll();
  });

  test("model selector → select model", async () => {
    await verify("settings-model-selector", SS.modelSelector, 1).verifyAll();
  });

  test("new session clears blocks", async () => {
    await verify("settings-new-session", SS.newSession, 2).verifyAll();
  });

  test("exit flow (Ctrl+C twice)", async () => {
    await verify("settings-exit", SS.exitFlow, 1).verifyAll();
  });

  test("export session confirmation", async () => {
    await verify("settings-export", SS.exportSession, 1).verifyAll();
  });

  test("external editor open/close", async () => {
    await verify("settings-editor", SS.externalEditor, 1).verifyAll();
  });
});

// ══════════════════════════════════════════════════════════
// Real agent e2e (mock model via runAgent)
// ══════════════════════════════════════════════════════════

describe(`${label} Real agent (mock LLM)`, () => {
  test("simple text response renders in TUI", async () => {
    await runRealAgentE2E("real-simple-text", RC.simpleTextResponse);
  }, 20000);

  test("tool call auto-approved renders in TUI", async () => {
    await runRealAgentE2E("real-tool-call", RC.toolCallAutoApprove);
  }, 20000);

  test("model error completes without hanging", async () => {
    await runRealAgentE2E("real-model-error", RC.modelError);
  }, 20000);

  test("multi-turn conversation response visible", async () => {
    await runRealAgentE2E("real-multi-turn", RC.multiTurnSimple);
  }, 20000);

  test("empty response completes without stall", async () => {
    await runRealAgentE2E("real-empty", RC.emptyResponse);
  }, 20000);
});

// ══════════════════════════════════════════════════════════
// Viewport culling regression tests
// ══════════════════════════════════════════════════════════

describe(`${label} No viewport culling`, () => {
  test("all blocks visible with many blocks + long text", async () => {
    await verify("vp-all-visible", VP.noCullingAllBlocksVisible, 1).verifyAll();
  });

  test("tool cards visible even with long text responses", async () => {
    await verify("vp-tools-visible", VP.allBlocksVisibleWithLongText, 1).verifyAll();
  });

  test("default rendering shows all content", async () => {
    await verify("vp-default", VP.defaultViewportWorks, 1).verifyAll();
  });
});
