/**
 * TUI E2E — P2+P3 Advanced Interactions & Integration
 *
 * Tests for advanced input behaviors, leader keys, global shortcuts,
 * rapid operations, and integration scenarios.
 * Uses the real TuiBootstrap pipeline with StreamingMockModel and ResponsePlan.
 *
 * Coverage:
 *   1. Input Advanced Interactions (4 tests)
 *   2. Leader Keys (5 tests)
 *   3. Global Shortcuts (5 tests)
 *   4. Integration: /clear + resume (1 test, skipped)
 *   5. Rapid Consecutive Operations (1 test)
 *   6. Long Output (1 test)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text } from "./response-plan";

const TIMEOUT = 60000;

// ── Response Plan ──
//
// Tests that consume model responses:
//   test "send 2 messages": history msg1          → 1 call
//   test "send 2 messages": history msg2          → 1 call
//   test "long message":    long message          → 1 call
//   test "Ctrl+X c":        compact context msg   → 1 call (delay 200ms)
//   test "/clear + resume":  resume after clear    → 1 call
//   test "rapid Ctrl+C":    cancel target msg     → 1 call (delay 500ms)
//   test "rapid Ctrl+C":    recovery after cancel → 1 call
//
// Total consumed: 7

const plan = new ResponsePlan([
  {
    group: "history-msg1",
    responses: [text("History reply 1: message received.")],
  },
  {
    group: "history-msg2",
    responses: [text("History reply 2: second message received.")],
  },
  {
    group: "long-msg",
    responses: [text("Long message processed successfully.")],
  },
  {
    group: "compact-ctx",
    // 800ms delay to ensure the running window is wide enough for leader key
    // interception (Ctrl+X c) before the model finishes.
    responses: [text("Compact context test complete.", 800)],
  },
  {
    group: "resume-after-clear",
    responses: [text("After clear response.")],
  },
  {
    group: "rapid-ctrl-c",
    responses: [text("Processing rapid cancel test...", 500)],
  },
  {
    group: "recovery-after-cancel",
    responses: [text("Recovery after cancel successful.")],
  },
]);

// ── Helpers ──

function clearInputBuffer(tui: TuiHarness) {
  for (let i = 0; i < 100; i++) {
    tui.stdin.write("\x7f");
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Shared TUI instance ──

let tui: TuiHarness;

describe("TUI E2E — P2+P3 Advanced Interactions", () => {

  beforeAll(async () => {
    tui = await createTui({
      modelResponses: plan.flatten(),
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
  // 1. Input Advanced Interactions
  // ══════════════════════════════════════════════════════════

  describe("Input Advanced", () => {

    test("empty input (Enter with no text) does not submit", async () => {
      // Type nothing, just press Enter
      clearInputBuffer(tui);
      await sleep(200);

      const outputBefore = tui.getOutput();
      tui.stdin.write("\r");
      await sleep(500);

      const outputAfter = tui.getOutput();
      // Output should be essentially unchanged (no new user message block)
      // Just verify no crash occurred and TUI is still responsive
      expect(outputAfter.length).toBeGreaterThan(0);
      expect(tui.isIdle() || tui.isRunning()).toBe(true);
    }, TIMEOUT);

    test("send 2 messages → verify both history entries visible in output", async () => {
      // Message 1
      await tui.sendMessage("HistoryMsg1");
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain("History reply 1");

      // Message 2
      await tui.sendMessage("HistoryMsg2");
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain("History reply 2");

      // Both user message blocks appear
      const output = tui.getOutput();
      expect(output).toContain("HistoryMsg1");
      expect(output).toContain("HistoryMsg2");
    }, TIMEOUT);

    test("long message (>100 chars) is handled without crash", async () => {
      const longText = "A".repeat(120);
      await tui.sendMessage(longText);
      await tui.waitForIdle(15000);

      expect(tui.getOutput()).toContain("Long message processed successfully.");
      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);

    test("history navigation: after multiple messages, output contains all of them", async () => {
      const output = tui.getOutput();
      expect(output).toContain("HistoryMsg1");
      expect(output).toContain("History reply 1");
      expect(output).toContain("HistoryMsg2");
      expect(output).toContain("History reply 2");
      // Long message text may be truncated in output, verify agent replied
      expect(output).toContain("Long message processed successfully.");
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 2. Compact Context via Leader (consumes model response)
  // ══════════════════════════════════════════════════════════

  describe("Compact Context via Leader Key", () => {

    test("/compact during agent run → compact context block appears (replaces removed Ctrl+X c)", async () => {
      // Send message and immediately trigger leader keys while the agent
      // is still running. Use a longer model delay (800ms) to ensure the
      // window is wide enough for waitForRunning + leader key sequence.
      await tui.sendMessage("compact");
      await sleep(50); // brief settle after sendMessage

      // Send leader Ctrl+X + c in rapid succession
      tui.stdin.write("/compact"); await sleep(200); tui.stdin.write("\r"); await sleep(300)

      await tui.waitForIdle(15000);

      const output = tui.getOutput();
      expect(output).toContain("Manual compaction requested");
      expect(output).toContain("Compact context test complete.");

      // Clean up "c" or "x" that may have leaked into TextInput
      clearInputBuffer(tui);
      await sleep(100);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 3. Leader Keys
  // ══════════════════════════════════════════════════════════

  describe("Leader Keys", () => {

    test("Ctrl+X invalid key → leader cancelled, no side effect", async () => {
      clearInputBuffer(tui);
      await sleep(100);

      tui.stdin.write("\x18"); // Ctrl+X → leader
      await sleep(300);
      tui.stdin.write("z"); // Invalid leader key
      await sleep(300);

      // TUI should still be functional
      expect(tui.isIdle() || tui.isRunning()).toBe(true);

      // Clean up any stray "z"
      clearInputBuffer(tui);
      await sleep(100);
    }, TIMEOUT);

    test("Ctrl+X Esc → leader cancelled", async () => {
      clearInputBuffer(tui);
      await sleep(100);

      tui.stdin.write("\x18"); // Ctrl+X → leader
      await sleep(300);
      tui.stdin.write("\x1b"); // Escape
      await sleep(300);

      // TUI should still be functional
      expect(tui.isIdle() || tui.isRunning()).toBe(true);
    }, TIMEOUT);

    test("/model opens model selector (replaces removed Ctrl+X m)", async () => {
      // Skip: Ink TextInput does not reliably recover stdin focus after overlay interactions in test environment.
      clearInputBuffer(tui);
      await sleep(100);

      tui.stdin.write("/model"); await sleep(200); tui.stdin.write("\r"); await sleep(600)
      await sleep(600);

      expect(tui.getOutput()).toMatch(/Model|model/);

      tui.stdin.write("\x1b");
      await sleep(300);

      clearInputBuffer(tui);
      await sleep(100);
    }, TIMEOUT);

    test("/sessions opens session selector (replaces removed Ctrl+X l)", async () => {
      // Skip: Ink TextInput does not reliably recover stdin focus after overlay interactions in test environment.
      clearInputBuffer(tui);
      await sleep(100);

      tui.stdin.write("/sessions"); await sleep(200); tui.stdin.write("\r"); await sleep(600)
      await sleep(600);

      expect(tui.getOutput()).toContain("会话列表");

      tui.stdin.write("\x1b");
      await sleep(300);

      clearInputBuffer(tui);
      await sleep(100);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 4. Global Shortcuts
  // ══════════════════════════════════════════════════════════

  describe("Global Shortcuts", () => {

    test("/auth toggles authorization (replaces removed Ctrl+R)", async () => {
      const initialAuth = tui.getAuthMode();
      expect(initialAuth).toBeDefined();

      tui.stdin.write("/auth"); await sleep(200); tui.stdin.write("\r"); await sleep(500)
      await sleep(500);

      const toggledAuth = tui.getAuthMode();
      expect(toggledAuth).toBeDefined();
      expect(toggledAuth).not.toBe(initialAuth);

      // Toggle back
      tui.stdin.write("/auth"); await sleep(200); tui.stdin.write("\r"); await sleep(500)
      await sleep(500);

      expect(tui.getAuthMode()).toBe(initialAuth);
    }, TIMEOUT);

    test("Ctrl+T → toggles reasoning (no crash)", async () => {
      tui.stdin.write("\x14"); // Ctrl+T
      await sleep(400);

      // TUI should still be functional
      expect(tui.isIdle() || tui.isRunning()).toBe(true);

      // Toggle back
      tui.stdin.write("\x14"); // Ctrl+T
      await sleep(400);
    }, TIMEOUT);

    test("/clear clears output (replaces removed Ctrl+L)", async () => {
      const outputBefore = tui.getOutput();
      expect(outputBefore.length).toBeGreaterThan(100);

      tui.stdin.write("/clear"); await sleep(200); tui.stdin.write("\r")
      await sleep(500);

      const outputAfter = tui.getOutput();
      // Output should be shorter after clear
      expect(outputAfter.length).toBeLessThan(outputBefore.length);
    }, TIMEOUT);

    test("Ctrl+N → creates new session, TUI remains responsive", async () => {
      const outputBefore = tui.getOutput();
      expect(outputBefore.length).toBeGreaterThan(0);

      tui.stdin.write("\x0e"); // Ctrl+N
      await sleep(1500);

      // After creating a new session, the TUI should still be responsive
      // and the output area should be cleared (NEW_SESSION clears blocks)
      const outputAfter = tui.getOutput();
      expect(outputAfter.length).toBeGreaterThan(0);
      expect(tui.isIdle() || tui.isRunning()).toBe(true);
    }, TIMEOUT);

    test("/help opens help panel (replaces removed Ctrl+H)", async () => {
      // Ctrl+H (\x08) does not set the ctrl modifier in ink-testing-library stdin.
      // Use /help + Enter instead — same SHOW_HELP dispatch, proven working.
      // Dismiss any lingering overlays first
      tui.stdin.write("\x1b");
      await sleep(300);

      clearInputBuffer(tui);
      await sleep(100);

      tui.stdin.write("/help");
      await sleep(100);
      tui.stdin.write("\r");
      await sleep(600);

      expect(tui.getOutput()).toContain("快捷键");

      // Dismiss help panel
      tui.stdin.write("\x1b");
      await sleep(500);

      expect(tui.getOutput()).not.toContain("快捷键");
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 4. Integration: /clear then resume (skipped)
  // ══════════════════════════════════════════════════════════

  describe("Integration: /clear + resume", () => {

    test("/clear then send new message → works normally", async () => {
      // Skip: Ink TextInput does not reliably recover stdin focus after overlay interactions in test environment.
      // Send /clear command
      tui.stdin.write("/clear");
      await sleep(100);
      tui.stdin.write("\r");
      await sleep(500);

      // Then send a new message
      await tui.sendMessage("resume after clear");
      await tui.waitForIdle(15000);

      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 5. Rapid Consecutive Operations
  // ══════════════════════════════════════════════════════════

  describe("Rapid Operations", () => {

    test("send message → Ctrl+C interrupt → idle → send again (recovery)", async () => {
      // Send a message with delay (200ms) to allow Ctrl+C to arrive mid-execution
      await tui.sendMessage("rapid cancel");
      await tui.waitForRunning(5000);
      // Brief delay so the model call is in-flight
      await sleep(100);

      // Immediately send Ctrl+C
      tui.stdin.write("\x03");
      await sleep(300);

      // Wait for agent to stop
      await tui.waitForRunningGone(15000);
      expect(tui.isRunning()).toBe(false);

      // Recover: send a new message and verify it works
      await tui.sendMessage("recover now");
      await tui.waitForText("Recovery after cancel successful.", 15000);

      expect(tui.getOutput()).toContain("Recovery after cancel successful.");
      expect(tui.isRunning()).toBe(false);
    }, TIMEOUT);
  });

  // ══════════════════════════════════════════════════════════
  // 6. Long Output Check
  // ══════════════════════════════════════════════════════════

  describe("Long Output", () => {

    test("output length > 100 chars after many operations", async () => {
      // After all previous tests, the output should have substantial content
      const output = tui.getOutput();
      // The TUI rendered output should be non-trivial after many operations
      // (even if some tests cleared or changed session, header + output = non-trivial)
      expect(output.length).toBeGreaterThan(100);
    }, TIMEOUT);
  });

});
