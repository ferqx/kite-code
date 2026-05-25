/**
 * TUI E2E — Startup & Core Regression Tests (P0)
 *
 * Tests the real TuiBootstrap pipeline with a StreamingMockModel.
 * Uses ResponsePlan to track and verify model call consumption.
 *
 * Coverage:
 *   1. Startup & Render (2 tests)
 *   2. Send Message → Agent Response (4 tests)
 *   3. Multi-turn Conversation (1 test)
 *   4. Tool Call (1 test)
 *   5. Error Handling (1 test)
 *   6. Slash Commands (2 tests: /help, /setting)
 *   7. Session Switching — Block Preservation (2 tests)
 *   8. Keyboard Protocol — Arrow Keys (1 test)
 *   9. Interrupt & Recovery (2 tests: Ctrl+C interrupt, recovery)
 *  10. Escape Overlay Handling (1 test)
 *  11. Double Ctrl+C Exit (1 test, last — monkey-patches process.exit)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text, modelError, toolCall } from "./response-plan";

const TIMEOUT = 60000;

// ── Response Plan ──
//
// Each sendMessage() call consumes one _generate call, except tool calls which
// consume two (tool_call + follow-up).
//
// Test execution order and model call consumption:
//   [no call]  1. renders without crash
//   [no call]  2. auto-creates session
//   [1 call]   3. "unique-test-msg-42" — user block appears
//   [1 call]   4. "hello" — agent text visible
//   [1 call]   5. "do task" — returns to idle
//   [1 call]   6. "task" — exit summary
//   [1 call]   7. multi-turn "Hi"
//   [1 call]   8. multi-turn "What is the answer?"
//   [2 call]   9. "read test.txt" — tool call + follow-up
//   [1 call]  10. "do something" — model error
//   [no call] 11. /help
//   [no call] 12. /setting
//   [1 call]  13. "SwitchMsgA" — session switch back
//   [1 call]  14. "SwitchMsgB" — session switch back
//   [1 call]  15. "NewSessionMsg" — new session active marker
//   [no call] 16. arrow key sequence
//   [1 call]  17. "cancel test" — Ctrl+C interrupt (200ms delay)
//   [1 call]  18. "hello again" — recovery after Ctrl+C
//   [no call] 19. escape overlay handling
//   [no call] 20. double Ctrl+C exit (LAST)
//
// Total consumed: 14

const plan = new ResponsePlan([
  { group: "send msg 1 (user block)",     responses: [text("Got it!")] },
  { group: "send msg 2 (agent text)",     responses: [text("Hello!")] },
  { group: "send msg 3 (idle state)",     responses: [text("Done.")] },
  { group: "send msg 4 (exit summary)",   responses: [text("All done.")] },
  { group: "multi-turn turn 1",           responses: [text("Hello! How can I help?")] },
  { group: "multi-turn turn 2",           responses: [text("The answer is 42.")] },
  { group: "tool test",                   responses: [toolCall("read_file", { path: "test.txt" }), text("File looks good.")] },
  { group: "error test",                  responses: [modelError("Network timeout")] },
  { group: "session switch A",            responses: [text("Reply A!")] },
  { group: "session switch B",            responses: [text("Reply B!")] },
  { group: "new session msg",             responses: [text("New session reply!")] },
  { group: "ctrl+c interrupt",            responses: [text("Processing cancel test...", 200)] },
  { group: "recovery after ctrl+c",       responses: [text("Recovery successful!")] },
]);

// ── Shared TUI instance (Ink can only render once per process) ──

let tui: TuiHarness;

// ── Helpers ──

/** Clear the TextInput buffer by sending backspace characters.
 *  Ink's TextInput may retain characters from global keybindings
 *  (e.g. "n" from Ctrl+X n or "l" from Ctrl+X l) that weren't
 *  intercepted by the overlayActive guard. */
function clearInputBuffer() {
  // Send 10 backspaces to clear any leftover characters
  for (let i = 0; i < 10; i++) {
    tui.stdin.write("\x7f");
  }
}

// ── Process.exit guard for double Ctrl+C test ──

function patchProcessExit(): { restore: () => void; exitCode: () => number } {
  const origExit = process.exit;
  let code = -1;
  process.exit = ((c?: number) => { code = c ?? 0; }) as any;
  return {
    restore: () => { process.exit = origExit; },
    exitCode: () => code,
  };
}

describe("TUI E2E — Startup & Core Regression (P0)", () => {

  beforeAll(async () => {
    tui = await createTui({
      modelResponses: plan.flatten(),
      workspaceFiles: { "test.txt": "hello world\n" },
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
  // 1. Startup & Render
  // ══════════════════════════════════════════════════════════

  test("renders without crash (output > 10 chars)", () => {
    const output = tui.getOutput();
    expect(output.length).toBeGreaterThan(10);
    const lower = output.toLowerCase();
    expect(
      lower.includes("openpx") || lower.includes("( = = )") || lower.includes("( ^ ^ )"),
    ).toBe(true);
  });

  test("auto-creates session — sidebar shows session entry", () => {
    expect(tui.getSessionCount()).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════════
  // 2. Send Message → Agent Response
  // ══════════════════════════════════════════════════════════

  test("send message → user message block appears in output", async () => {
    await tui.sendMessage("unique-test-msg-42");
    await tui.waitForIdle(15000);
    expect(tui.getOutput()).toContain("unique-test-msg-42");
  }, TIMEOUT);

  test("send message → agent responds with text visible in output", async () => {
    await tui.sendMessage("hello");
    await tui.waitForText("Hello!", 15000);
    expect(tui.getOutput()).toContain("Hello!");
  }, TIMEOUT);

  test("send message → returns to idle state after agent finishes", async () => {
    await tui.sendMessage("do task");
    await tui.waitForIdle(15000);
    expect(tui.isRunning()).toBe(false);
  }, TIMEOUT);

  test("exit summary appears after agent finishes", async () => {
    await tui.sendMessage("task");
    await tui.waitForIdle(10000);
    expect(tui.getOutput()).toContain("──");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 3. Multi-turn Conversation
  // ══════════════════════════════════════════════════════════

  test("multi-turn conversation: both turns produce responses", async () => {
    // Clear output first via Ctrl+L to keep the output readable
    tui.stdin.write("\x0c"); // Ctrl+L → CLEAR_OUTPUT
    await new Promise((r) => setTimeout(r, 300));

    // Turn 1
    await tui.sendMessage("Hi");
    await tui.waitForIdle(10000);
    expect(tui.getOutput()).toContain("Hello! How can I help?");

    // Turn 2
    await tui.sendMessage("What is the answer?");
    await tui.waitForIdle(10000);

    const output = tui.getOutput();
    expect(output).toContain("The answer is 42.");
    expect(output).toContain("Hi");
    expect(output).toContain("What is the answer?");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 4. Tool Call
  // ══════════════════════════════════════════════════════════

  test("tool call renders in output", async () => {
    await tui.sendMessage("read test.txt");
    await tui.waitForIdle(15000);

    const output = tui.getOutput();
    expect(output).toContain("read_file");
    expect(output).toContain("File looks good");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 5. Error Handling
  // ══════════════════════════════════════════════════════════

  test("model error → TUI does not hang, returns to idle", async () => {
    await tui.sendMessage("do something");
    await tui.waitForIdle(15000);
    expect(tui.isRunning()).toBe(false);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 6. Slash Commands
  // ══════════════════════════════════════════════════════════

  test("/help shows keyboard shortcuts panel", async () => {
    tui.stdin.write("/help");
    await new Promise((r) => setTimeout(r, 100));
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).toContain("Keyboard Shortcuts");

    // Dismiss HelpPanel
    tui.stdin.write("\x1b"); // Escape
    await new Promise((r) => setTimeout(r, 300));
  }, TIMEOUT);

  test("/setting shows current configuration", async () => {
    tui.stdin.write("/setting");
    await new Promise((r) => setTimeout(r, 100));
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).toContain("Current Settings");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 7. Session Switching — Block Preservation
  // ══════════════════════════════════════════════════════════

  test("switch session via sidebar arrow keys + Enter loads message history", async () => {
    // Send message in session 1 (auto-created at startup)
    await tui.sendMessage("SwitchMsgA");
    await tui.waitForText("Reply A!", 15000);

    // Session count should be >= 1
    expect(tui.getSessionCount()).toBeGreaterThanOrEqual(1);

    // Create session 2 via Ctrl+X n
    tui.stdin.write("\x18"); // Ctrl+X → leader
    await new Promise((r) => setTimeout(r, 400));
    tui.stdin.write("n");
    await new Promise((r) => setTimeout(r, 1500));

    // Session count should have increased
    const countAfterCreate = tui.getSessionCount();
    expect(countAfterCreate).toBeGreaterThanOrEqual(2);

    // Send message in session 2
    await tui.sendMessage("SwitchMsgB");
    await tui.waitForText("Reply B!", 15000);

    // Tab → focus sidebar
    tui.stdin.write("\t");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.isSidebarFocused()).toBe(true);

    // UpArrow → select session 1
    tui.stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 300));

    // Enter → switch to session 1
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 2000));

    const out = tui.getOutput();
    // Session 1 message history must be visible (block preservation)
    expect(out).toContain("SwitchMsgA");
    expect(out).toContain("Reply A!");
    // Focus must return to input
    expect(tui.isSidebarFocused()).toBe(false);
  }, TIMEOUT);

  test("new session: active marker follows, message goes to right session", async () => {
    // Create another new session via Ctrl+X n
    tui.stdin.write("\x18"); // Ctrl+X → leader
    await new Promise((r) => setTimeout(r, 400));
    tui.stdin.write("n");
    await new Promise((r) => setTimeout(r, 1500));

    // Send message to the new session
    await tui.sendMessage("NewSessionMsg");
    await tui.waitForText("New session reply!", 15000);

    const output = tui.getOutput();
    expect(output).toContain("NewSessionMsg");
    expect(output).toContain("New session reply!");

    // Clean input buffer from "n" typed by Leader key (so subsequent
    // tests don't inherit stray characters in the TextInput buffer)
    clearInputBuffer();
    await new Promise((r) => setTimeout(r, 100));
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 8. Keyboard Protocol — Arrow Keys (mis-parse regression)
  // ══════════════════════════════════════════════════════════

  test("arrow key sequence Tab→Up→Down→Enter doesn't mis-parse", async () => {
    // This test sends a known sequence that could be mis-parsed by
    // Kitty keyboard protocol or terminal input handling.
    // We verify the TUI remains responsive after the sequence.

    // Tab → focus sidebar
    tui.stdin.write("\t");
    await new Promise((r) => setTimeout(r, 300));

    // UpArrow → navigate up in sidebar
    tui.stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 200));

    // DownArrow → navigate back down
    tui.stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 200));

    // Enter → switch to selected session
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 800));

    // After the sequence, the TUI should still be functional.
    // Verify output is non-empty and no crash has occurred.
    const output = tui.getOutput();
    expect(output.length).toBeGreaterThan(10);
    // Focus should eventually return to input area after session switch
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.isSidebarFocused()).toBe(false);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 9. Interrupt & Recovery
  // ══════════════════════════════════════════════════════════

  test("Ctrl+C during agent run → interrupts, TUI recovers to idle", async () => {
    // Use a response with delay (200ms) so Ctrl+C arrives during model generation
    await tui.sendMessage("cancel test");
    await tui.waitForRunning(5000);
    // Small additional delay to ensure model call is in-flight
    await new Promise((r) => setTimeout(r, 100));
    // Send Ctrl+C
    tui.stdin.write("\x03");
    // Wait for agent to stop
    await tui.waitForRunningGone(15000);
    // TUI should be responsive (not hanging)
    expect(tui.isRunning()).toBe(false);
  }, TIMEOUT);

  test("recovery: TUI accepts new message after Ctrl+C interruption", async () => {
    // After the Ctrl+C interrupt, verify the TUI can accept and process
    // new messages normally.
    await tui.waitForIdle(5000);
    await tui.sendMessage("hello again");
    await tui.waitForText("Recovery successful!", 15000);
    expect(tui.getOutput()).toContain("Recovery successful!");
    expect(tui.isRunning()).toBe(false);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 10. Escape — Overlay Dismissal
  // ══════════════════════════════════════════════════════════

  test("Escape dismisses HelpPanel and SessionSelector individually", async () => {
    // Dismiss any lingering overlays first
    tui.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 300));

    // ── HelpPanel ──
    tui.stdin.write("/help");
    await new Promise((r) => setTimeout(r, 100));
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).toContain("Keyboard Shortcuts");

    // Escape dismisses HelpPanel
    tui.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).not.toContain("Keyboard Shortcuts");

    // ── SessionSelector ──
    // Clear input buffer before leader keys (backspace any leftover chars)
    clearInputBuffer();
    await new Promise((r) => setTimeout(r, 100));

    tui.stdin.write("\x18"); // Ctrl+X → leader
    await new Promise((r) => setTimeout(r, 400));
    tui.stdin.write("l");
    await new Promise((r) => setTimeout(r, 600));
    expect(tui.getOutput()).toContain("会话列表");

    // Escape dismisses SessionSelector
    tui.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).not.toContain("会话列表");

    // Clean up input buffer (leader "l" may have typed into TextInput)
    clearInputBuffer();
    await new Promise((r) => setTimeout(r, 100));
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // 11. Double Ctrl+C Exit (LAST — monkey-patches process.exit)
  // ══════════════════════════════════════════════════════════

  test("double Ctrl+C triggers exit (process.exit(0))", async () => {
    // Monkey-patch process.exit to prevent actual process death.
    // We verify the exit code is 0 without killing the test runner.
    const guard = patchProcessExit();

    try {
      // Allow the overlay-dismissal Escape events from the previous test
      // to fully propagate before pressing Ctrl+C
      await new Promise((r) => setTimeout(r, 1000));

      // First Ctrl+C — when idle, this just sets ctrlCPressed=true
      tui.stdin.write("\x03");
      await new Promise((r) => setTimeout(r, 300));

      // Second Ctrl+C — ctrlCPressed was true, so this sets exitRequested=true
      // which triggers the React useEffect calling process.exit(0)
      tui.stdin.write("\x03");
      await new Promise((r) => setTimeout(r, 500));

      expect(guard.exitCode()).toBe(0);
    } finally {
      guard.restore();
    }
  }, TIMEOUT);

});
