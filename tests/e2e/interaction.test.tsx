/**
 * TUI E2E — P1 Key User Workflows
 *
 * Tests for approval flows, agent questions, slash commands, suggestion
 * dropdowns, and file search. Uses the real
 * TuiBootstrap pipeline with StreamingMockModel and ResponsePlan.
 *
 * Coverage:
 *   1. Tool Approval Flow (3 tests)
 *   2. Agent Question Flow (2 tests)
 *   3. Slash Suggestion Dropdown (3 tests)
 *   4. Slash Commands (10 tests)
 *   5. @File Search (2 tests)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text, toolCall } from "./response-plan";

const TIMEOUT = 60000;

// ── Response Plan ──
//
// Tests that consume model responses:
//   2. Approval — approve (A):  tool_call + follow-up = 2 calls
//   3. Approval — deny (D):     tool_call + follow-up = 2 calls
//   5. Ask_user — answer:       tool_call + follow-up = 2 calls
//   6. Ask_user — Esc cancel:   tool_call only = 1 call (no follow-up)
//
// Total consumed: 7

const plan = new ResponsePlan([
  {
    group: "approval-approve",
    responses: [
      toolCall("shell_execute", { command: "mkdir test-dir-1", description: "Create test directory" }, "Creating directory...", 30),
      text("Directory test-dir-1 created successfully.", 50),
    ],
  },
  {
    group: "approval-deny",
    responses: [
      toolCall("shell_execute", { command: "mkdir test-dir-2", description: "Create another test directory" }, "Creating another directory...", 30),
      text("Got it, skipped the mkdir command.", 50),
    ],
  },
  {
    group: "ask_user-answer",
    responses: [
      toolCall(
        "ask_user",
        {
          question: "Which approach do you prefer?",
          options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
        },
        "Let me ask the user.",
        30,
      ),
      text("User selected Option A. Proceeding with that approach.", 50),
    ],
  },
  {
    group: "ask_user-esc",
    responses: [
      toolCall(
        "ask_user",
        {
          question: "What API key format should I use?",
          options: [{ id: "env", label: "from .env" }, { id: "inline", label: "inline" }],
          allow_free_text: true,
        },
        "Let me clarify.",
        30,
      ),
    ],
  },
]);

// ── Helpers ──

function clearInputBuffer(tui: TuiHarness) {
  for (let i = 0; i < 30; i++) {
    tui.stdin.write("\x7f");
  }
}

async function runSlashCommand(tui: TuiHarness, cmd: string, delay = 1000) {
  await dismissOverlays(tui);
  await new Promise((r) => setTimeout(r, 200));
  clearInputBuffer(tui);
  await new Promise((r) => setTimeout(r, 100));
  tui.stdin.write(cmd);
  await new Promise((r) => setTimeout(r, 100));
  tui.stdin.write("\r");
  await new Promise((r) => setTimeout(r, delay));
}

async function dismissOverlays(tui: TuiHarness) {
  for (let i = 0; i < 3; i++) {
    tui.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── Shared TUI instance ──

let tui: TuiHarness;

describe("TUI E2E — P1 Key User Workflows", () => {

  beforeAll(async () => {
    tui = await createTui({
      modelResponses: plan.flatten(),
      workspaceFiles: { "package.json": "{}", "README.md": "# test" },
    });
  });

  afterAll(() => {
    try {
      plan.verify(tui.getCallCount());
    } finally {
      tui?.unmount();
    }
  });

  // ══════════════════════════════════════════════════════════
  // 1. Tool Approval Flow
  // ══════════════════════════════════════════════════════════

  describe("Tool Approval Flow", () => {

    test("approval block appears → approve (A) → tool executes → agent continues", async () => {
      await tui.sendMessage("create directory test-dir-1");
      await tui.waitForApproval(15000);
      expect(tui.getOutput()).toContain("[A]");

      await tui.approve("A");
      await tui.waitForIdle(15000);

      const output = tui.getOutput();
      expect(output).toContain("shell_execute");
      expect(output).toContain("Directory test-dir-1 created successfully");
    }, TIMEOUT);

    test("approval block appears → deny (D) → tool cancelled", async () => {
      await tui.sendMessage("create directory test-dir-2");
      await tui.waitForApproval(15000);
      expect(tui.getOutput()).toContain("[A]");

      await tui.approve("D");
      await tui.waitForIdle(15000);

      expect(tui.getOutput()).toContain("Got it, skipped the mkdir command");
    }, TIMEOUT);

    test("Ctrl+R switches to full_access → verify auth mode changes", async () => {
      expect(tui.getAuthMode()).toBe("default");

      tui.stdin.write("\x12"); // Ctrl+R
      await new Promise((r) => setTimeout(r, 500));

      expect(tui.getAuthMode()).toBe("full_access");

      tui.stdin.write("\x12"); // Ctrl+R
      await new Promise((r) => setTimeout(r, 500));

      expect(tui.getAuthMode()).toBe("default");
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 2. Agent Question Flow
  // ══════════════════════════════════════════════════════════

  describe("Agent Question Flow", () => {

    test("agent asks question → user answers → agent continues", async () => {
      await tui.sendMessage("please ask me a question");
      await tui.waitForQuestion(15000);

      const output = tui.getOutput();
      expect(output).toContain("Which approach do you prefer?");
      expect(output).toContain("Option A");

      await tui.answerQuestion("a");
      await tui.waitForIdle(15000);

      expect(tui.getOutput()).toContain("User selected Option A");
    }, TIMEOUT);

    test("question waiting → Esc cancels → interrupt cleared", async () => {
      await tui.sendMessage("clarify your question");
      await tui.waitForQuestion(15000);

      expect(tui.getOutput()).toContain("What API key format should I use?");

      tui.stdin.write("\x1b");
      await tui.waitForIdle(15000);

      expect(tui.getOutput()).toContain("Question cancelled");
      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 3. Slash Suggestion Dropdown (before slash commands — slashes break stdout)
  // ══════════════════════════════════════════════════════════

  describe("Slash Suggestion Dropdown", () => {

    test("typing / triggers suggestion dropdown", async () => {
      clearInputBuffer(tui);
      await new Promise((r) => setTimeout(r, 100));

      tui.stdin.write("/");
      await new Promise((r) => setTimeout(r, 500));

      expect(tui.getOutput()).toMatch(/Commands/);

      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 200));
    }, TIMEOUT);

    test("Esc dismisses dropdown", async () => {
      clearInputBuffer(tui);
      await new Promise((r) => setTimeout(r, 100));

      tui.stdin.write("/");
      await new Promise((r) => setTimeout(r, 400));
      expect(tui.getOutput()).toMatch(/Commands/);

      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 400));
      expect(tui.getOutput()).not.toMatch(/Commands/);
    }, TIMEOUT);

    test("typing /m shows model commands → Tab completes", async () => {
      clearInputBuffer(tui);
      await new Promise((r) => setTimeout(r, 100));

      tui.stdin.write("/");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("m");
      await new Promise((r) => setTimeout(r, 400));

      expect(tui.getOutput()).toMatch(/model/);

      tui.stdin.write("\t");
      await new Promise((r) => setTimeout(r, 300));

      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 200));

      clearInputBuffer(tui);
      await new Promise((r) => setTimeout(r, 100));
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 4. Slash Commands
  // ══════════════════════════════════════════════════════════

  describe("Slash Commands", () => {

    test("/help → panel appears → Esc closes", async () => {
      await runSlashCommand(tui, "/help", 500);
      expect(tui.getOutput()).toContain("Keyboard Shortcuts");

      tui.stdin.write("\x1b");
      await tui.waitForOverlayGone("Keyboard Shortcuts", 3000);
      await new Promise((r) => setTimeout(r, 300));
    }, TIMEOUT);

    test("/model → model selector appears → Esc closes", async () => {
      await runSlashCommand(tui, "/model", 500);
      expect(tui.getOutput()).toContain("Model");

      tui.stdin.write("\x1b");
      await tui.waitForOverlayGone("Select Model", 3000);
      await new Promise((r) => setTimeout(r, 300));
    }, TIMEOUT);

    test("/model list → model list in output", async () => {
      await runSlashCommand(tui, "/model list", 500);
      expect(tui.getOutput()).toMatch(/Model|model/);
    }, TIMEOUT);

    test("/model deepseek-v3 → switches model directly", async () => {
      await runSlashCommand(tui, "/model deepseek-v3", 500);
      expect(tui.getOutput()).toMatch(/deepseek-v3|DeepSeek V3/);
    }, TIMEOUT);

    test("/plan → switches to planning phase → auth set to default", async () => {
      await runSlashCommand(tui, "/plan", 500);
      expect(tui.getAuthMode()).toBe("default");
    }, TIMEOUT);

    test("/auth → toggles authorization mode", async () => {
      const initialAuth = tui.getAuthMode();
      expect(initialAuth).toBeDefined();

      await runSlashCommand(tui, "/auth", 500);

      const toggledAuth = tui.getAuthMode();
      expect(toggledAuth).toBeDefined();
      expect(toggledAuth).not.toBe(initialAuth);

      await runSlashCommand(tui, "/auth", 500);
      expect(tui.getAuthMode()).toBe(initialAuth);
    }, TIMEOUT);

    test("/clear → clears output area", async () => {
      const outputBefore = tui.getOutput();
      expect(outputBefore.length).toBeGreaterThan(50);

      await runSlashCommand(tui, "/clear", 500);

      const outputAfter = tui.getOutput();
      expect(outputAfter.length).toBeLessThan(outputBefore.length);
    }, TIMEOUT);

    test("/thinking → toggles reasoning visibility (no crash)", async () => {
      await runSlashCommand(tui, "/thinking", 500);
      expect(tui.isIdle() || tui.isRunning()).toBe(true);

      await runSlashCommand(tui, "/thinking", 500);
    }, TIMEOUT);

    test("/sessions → opens session selector → Esc closes", async () => {
      await runSlashCommand(tui, "/sessions", 500);
      expect(tui.getOutput()).toContain("会话列表");

      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getOutput()).not.toContain("会话列表");
    }, TIMEOUT);

    test("/new → creates new session → TUI remains responsive", async () => {
      await runSlashCommand(tui, "/new", 1500);

      // Verify TUI is still functional and not showing "No sessions"
      const output = tui.getOutput();
      expect(output).not.toContain("No sessions");
      expect(tui.isIdle() || tui.isRunning()).toBe(true);
    }, TIMEOUT);

    test("/setting → shows Current Settings", async () => {
      await runSlashCommand(tui, "/setting", 500);
      expect(tui.getOutput()).toContain("Current Settings");
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 5. @File Search (after slash commands — stdin may be broken, run last)
  // ══════════════════════════════════════════════════════════

  describe("@File Search", () => {

    test("typing @ triggers file search dropdown", async () => {
      clearInputBuffer(tui);
      await new Promise((r) => setTimeout(r, 200));

      tui.stdin.write("@");
      await new Promise((r) => setTimeout(r, 800));

      expect(tui.getOutput()).toMatch(/Files matching/);

      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 200));
    }, TIMEOUT);

    test("typing @package shows filtered results → Esc dismisses", async () => {
      clearInputBuffer(tui);
      await new Promise((r) => setTimeout(r, 100));

      tui.stdin.write("@");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("p");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("a");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("c");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("k");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("a");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("g");
      await new Promise((r) => setTimeout(r, 50));
      tui.stdin.write("e");
      await new Promise((r) => setTimeout(r, 400));

      const output = tui.getOutput();
      expect(output).toMatch(/Files matching/);
      expect(output).toMatch(/package\.json/);

      tui.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
      expect(tui.getOutput()).not.toMatch(/Files matching/);
    }, TIMEOUT);
  });

});
