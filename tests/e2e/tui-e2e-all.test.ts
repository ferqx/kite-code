import { describe, test, expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import { verifyScenario } from "./helpers";
import * as AV from "./scenarios/approval-variants";
import * as QV from "./scenarios/question-variants";
import * as AM from "./scenarios/agent-messages";
import * as TF from "./scenarios/tool-flow";
import * as SD from "./scenarios/state-display";

const UPDATE = Bun.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "true";

const label = UPDATE ? "[UPDATE]" : "[VERIFY]";

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
