/**
 * TUI E2E — Real Pipeline Tests
 *
 * Renders the actual TuiBootstrap component with only the LLM replaced by
 * a StreamingMockModel. The full production path is exercised:
 *
 *   stdin.write → InputLine → handleInput → runTask → SessionManager
 *   → SessionRuntime.runTask → runAgent → events → reducer → renderer
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";

const TIMEOUT = 60000;

// ── Helpers ──

function textResponse(content: string, delay = 50) {
  return [{ message: { content } as any, delay }];
}

function multiTurnResponses(...contents: string[]) {
  return contents.map((content) => ({ message: { content } as any, delay: 30 }));
}

// ── Shared TUI instance — Ink can only render once per process ──

let tui: TuiHarness;

describe("TUI E2E (Real Pipeline)", () => {

  beforeAll(async () => {
    // Responses consumed sequentially per agent turn.
    // Test order and message count:
    //   test 3: 1 msg → idx 0
    //   test 4: 1 msg → idx 1
    //   test 5: 1 msg → idx 2
    //   test 6: 1 msg → idx 3
    //   test 7: 2 msgs → idx 4-5
    //   test 8: 0 msgs
    //   test 9: 1 msg → idx 6 (error)
    //   test 10: 1 msg (model called 2x: tool + follow-up) → idx 7-8
    tui = await createTui({
      modelResponses: [
        textResponse("Got it!")[0],
        textResponse("Hello!")[0],
        textResponse("Done.")[0],
        textResponse("All done.")[0],
        textResponse("Hello! How can I help?")[0],
        textResponse("The answer is 42.")[0],
        { message: { content: "" } as any, error: "Network timeout", delay: 50 },
        {
          message: {
            content: "Let me read the file.",
            tool_calls: [{ id: "tc1", name: "read_file", args: { path: "test.txt" } }],
          } as any,
          delay: 30,
        },
        { message: { content: "File looks good." } as any, delay: 30 },
        textResponse("Reply A!")[0],
        textResponse("Reply B!")[0],
      ],
    });
  });

  afterAll(() => {
    tui?.unmount();
  });

  // ══════════════════════════════════════════════════════════
  // Startup & Render
  // ══════════════════════════════════════════════════════════

  test("renders without crash (output > 10 chars)", () => {
    const output = tui.getOutput();
    expect(output.length).toBeGreaterThan(10);
    expect(output.toLowerCase()).toContain("openpx");
  });

  test("auto-creates session — sidebar shows session entry", () => {
    expect(tui.getSessionCount()).toBeGreaterThanOrEqual(1);
    expect(tui.getOutput()).not.toContain("No sessions");
  });

  // ══════════════════════════════════════════════════════════
  // Send Message → Agent Response
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
  // Multi-turn conversation
  // ══════════════════════════════════════════════════════════

  test("multi-turn conversation: both turns produce responses", async () => {
    // Clear output first
    tui.stdin.write("/clear");
    await new Promise((r) => setTimeout(r, 100));
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 500));

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
  // Multiple sessions
  // ══════════════════════════════════════════════════════════

  test("creating new session increases sidebar count", async () => {
    const initial = tui.getSessionCount();

    tui.stdin.write("\x18"); // Ctrl+X → leader
    await new Promise((r) => setTimeout(r, 200));
    tui.stdin.write("n");    // 'n' → /new
    await new Promise((r) => setTimeout(r, 1000));

    expect(tui.getSessionCount()).toBeGreaterThanOrEqual(initial + 1);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Error handling
  // ══════════════════════════════════════════════════════════

  test("model error → TUI does not hang", async () => {
    // This consumes the error response
    await tui.sendMessage("do something");
    await tui.waitForIdle(15000);
    expect(tui.isRunning()).toBe(false);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Tool call
  // ══════════════════════════════════════════════════════════

  test("tool call renders in output", async () => {
    await tui.sendMessage("read test.txt");
    await tui.waitForIdle(15000);

    const output = tui.getOutput();
    expect(output).toContain("read_file");
    expect(output).toContain("File looks good");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Slash commands
  // ══════════════════════════════════════════════════════════

  test("/help shows keyboard shortcuts panel", async () => {
    tui.stdin.write("/help");
    await new Promise((r) => setTimeout(r, 100));
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).toContain("Shortcuts");

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
  // Session switching: arrow keys + Enter on sidebar
  // ══════════════════════════════════════════════════════════

  test("switch session via sidebar arrow keys + Enter loads message history", async () => {
    // Send message in session 1 (auto-created)
    await tui.sendMessage("SwitchMsgA");
    await tui.waitForText("Reply A!", 15000);

    // Create session 2 via Ctrl+X n
    tui.stdin.write("\x18");
    await new Promise((r) => setTimeout(r, 400));
    tui.stdin.write("n");
    await new Promise((r) => setTimeout(r, 1500));

    // Send message in session 2
    await tui.sendMessage("SwitchMsgB");
    await tui.waitForText("Reply B!", 15000);

    // Tab → focus sidebar (sidebarSelection=1, points to session 2)
    tui.stdin.write("\t");
    await new Promise((r) => setTimeout(r, 500));
    expect(tui.getOutput()).toContain("Sidebar focused");

    // UpArrow → select session 1 (sidebarSelection 1→0)
    tui.stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 300));

    // Enter → switch to session 1
    tui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 2000));

    const out = tui.getOutput();
    // Session 1 message history must be visible
    expect(out).toContain("SwitchMsgA");
    expect(out).toContain("Reply A!");
    // Focus must return to input
    expect(out).not.toContain("Sidebar focused");
  }, TIMEOUT);

});
