/**
 * TUI E2E — Cursor Behavior Tests
 *
 * Validates cursor positioning during:
 *   1. Character insertion after left/right arrow navigation
 *   2. Ghost text (slash completion) rendered contiguously with input
 *   3. History navigation (up arrow) loads previous message
 *
 * Model calls: 2 (one per sendMessage in history tests).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTui, type TuiHarness } from "./render-tui";
import { ResponsePlan, text } from "./response-plan";

const TIMEOUT = 30000;

// ── Model responses for history tests ──

const plan = new ResponsePlan([
  { group: "history test 1", responses: [text("ok")] },
  { group: "history test 2", responses: [text("ok")] },
]);

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ANSI escape sequences for clean text matching. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Type a string character by character with delays. */
async function typeString(tui: TuiHarness, chars: string, charDelay = 30) {
  for (const ch of chars) {
    tui.stdin.write(ch);
    await sleep(charDelay);
  }
  await sleep(200);
}

/** Send a VT100 arrow key sequence. */
function arrowKey(dir: "up" | "down" | "left" | "right"): string {
  const code = { up: "A", down: "B", right: "C", left: "D" };
  return `\x1b[${code[dir]}`;
}

/** Send multiple backspace keys with render-cycle delays.
 *  Each backspace needs a full render cycle for cursorOffsetRef to advance,
 *  so we wait between each. */
async function clearInput(tui: TuiHarness, count = 80) {
  for (let i = 0; i < count; i++) {
    tui.stdin.write("\x7f");
    await sleep(40);
  }
  await sleep(200);
}

/** Send an arrow keypress and wait for the render cycle. */
async function pressArrow(tui: TuiHarness, dir: "up" | "down" | "left" | "right") {
  tui.stdin.write(arrowKey(dir));
  await sleep(120);
}

// ── Shared TUI instance ──

let tui: TuiHarness;

describe("TUI E2E — Cursor Behavior", () => {

  beforeAll(async () => {
    tui = await createTui({
      modelResponses: plan.flatten(),
    });
  });

  afterAll(() => {
    tui?.unmount();
  });

  // ══════════════════════════════════════════════════════════
  // Test 1: Slash completion — suggestions appear, ghost text contiguous
  // (Runs first to avoid input state accumulation from long-typing tests)
  // ══════════════════════════════════════════════════════════

  test("slash suggestion: dropdown appears and ghost text is contiguous", async () => {
    await clearInput(tui);

    // Type "/" to trigger slash suggestion dropdown
    tui.stdin.write("/");
    await sleep(300);

    // Suggestion dropdown should appear
    expect(stripAnsi(tui.getOutput())).toContain("命令匹配");

    // Complete the partial type: "/s" shows more specific suggestions
    tui.stdin.write("s");
    await sleep(300);

    const plain = stripAnsi(tui.getOutput());
    // Ghost text shows completion preview right after "/s"
    // e.g. "/sessions", "/setting" — contiguous, no cursor gap
    expect(plain).toMatch(/\/s[a-z]+/);

    // Dismiss suggestions
    tui.stdin.write("\x1b");
    await sleep(200);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Test 2: Left arrow + type — char inserted at cursor position
  // ══════════════════════════════════════════════════════════

  test("left arrow + type: char inserted at cursor position, not at end", async () => {
    await clearInput(tui);

    // Type a unique marker
    await typeString(tui, "CURTST");
    // Cursor at end (position 6): C U R T S T |

    // Left arrow 3 times → cursor at position 3: C U R | T S T
    await pressArrow(tui, "left");
    await pressArrow(tui, "left");
    await pressArrow(tui, "left");

    // Type 'X' at cursor position
    tui.stdin.write("X");
    await sleep(200);

    const plain = stripAnsi(tui.getOutput());
    // X should be inserted between R and T: CURXTST
    expect(plain).toContain("CURXTST");
    // Should NOT be appended at end: CURTSTX (old bug)
    expect(plain).not.toMatch(/CURTSTX/);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Test 2: Right arrow + type — char inserted at correct position
  // ══════════════════════════════════════════════════════════

  test("right arrow + type: char inserted at cursor position", async () => {
    await clearInput(tui);

    await typeString(tui, "ABCDEF");
    // Cursor at end (position 6)

    // Left arrow 4 times → position 2: A B | C D E F
    await pressArrow(tui, "left");
    await pressArrow(tui, "left");
    await pressArrow(tui, "left");
    await pressArrow(tui, "left");

    // Right arrow 1 time → position 3: A B C | D E F
    await pressArrow(tui, "right");

    // Type 'X' at cursor position
    tui.stdin.write("X");
    await sleep(200);

    const plain = stripAnsi(tui.getOutput());
    // X should be inserted between C and D: ABCXDEF
    expect(plain).toContain("ABCXDEF");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Test 3: Rapid multi-step navigation + typing
  // ══════════════════════════════════════════════════════════

  test("rapid nav + type: cursor stays correct through multiple operations", async () => {
    await clearInput(tui);

    // Step 1: Type base text
    await typeString(tui, "0123456789");
    // Cursor at end (position 10)

    // Step 2: Left arrow 5 times → position 5: 0 1 2 3 4 | 5 6 7 8 9
    for (let i = 0; i < 5; i++) {
      await pressArrow(tui, "left");
    }

    // Step 3: Type "XX" at position 5
    tui.stdin.write("X");
    await sleep(60);
    tui.stdin.write("X");
    await sleep(200);

    let plain = stripAnsi(tui.getOutput());
    expect(plain).toContain("01234XX56789");

    // Step 4: Right arrow 3 times
    // After insertion "01234XX56789":
    //   0(0) 1(1) 2(2) 3(3) 4(4) X(5) X(6) 5(7) 6(8) 7(9) 8(10) 9(11)
    //   Cursor at position 7 (after the two X's, before "5").
    //   Right ×3 → position 10: between "7" and "8"
    for (let i = 0; i < 3; i++) {
      await pressArrow(tui, "right");
    }

    // Step 5: Type "Y" at position 10
    tui.stdin.write("Y");
    await sleep(200);

    plain = stripAnsi(tui.getOutput());
    expect(plain).toContain("01234XX567Y89");

    await clearInput(tui);
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Test 5: History navigation — up arrow loads previous message
  // ══════════════════════════════════════════════════════════

  test("history navigation (up arrow) loads previous message into input", async () => {
    // Send a message to populate history
    await tui.sendMessage("hist-msg-001");
    await tui.waitForIdle(10000);

    // Clear input, type some text, then navigate history
    await clearInput(tui);
    await typeString(tui, "temporary");
    await pressArrow(tui, "up");

    const output = stripAnsi(tui.getOutput());
    // The history message replaces the temporary text
    expect(output).toContain("hist-msg-001");
  }, TIMEOUT);

  // ══════════════════════════════════════════════════════════
  // Test 6: History — navigate past end clears input
  // ══════════════════════════════════════════════════════════

  test("history: up then down past end clears input", async () => {
    await tui.sendMessage("hist-msg-002");
    await tui.waitForIdle(10000);

    await clearInput(tui);
    await typeString(tui, "placeholder-text");

    // Up → shows latest history entry
    await pressArrow(tui, "up");

    let output = stripAnsi(tui.getOutput());
    expect(output).toContain("hist-msg-002");

    // Down → when at latest entry, clears input
    await pressArrow(tui, "down");

    output = stripAnsi(tui.getOutput());
    // "placeholder-text" should NOT be in the input anymore
    // (down from latest history entry resets the input)
    expect(output).not.toContain("placeholder-text");
  }, TIMEOUT);

});

// ═══════════════════════════════════════════════════════════════
// Tests: Input line must not duplicate when output area has content
// ═══════════════════════════════════════════════════════════════

/**
 * Regression test: when messages are present in the output area,
 * typing in the input line MUST NOT produce duplicate `❯` lines.
 * The bug was caused by <Static> + incrementalRendering cursor race.
 */
describe("TUI E2E — No duplicate input when output has content", () => {
  const dupPlan = new ResponsePlan([
    { group: "fill output", responses: [
      text("Here is a response with some text to fill up the output area so we can verify the input line does not duplicate."),
    ]},
  ]);

  let tui: TuiHarness;

  beforeAll(async () => {
    tui = await createTui({ modelResponses: dupPlan.flatten() });
  });

  afterAll(() => {
    tui?.unmount();
  });

  test("typing after agent response: no duplicate ❯ below StatsLine", async () => {
    // Send a message to fill the output area
    await tui.sendMessage("hello agent");
    await tui.waitForIdle(10000);

    // Clear input, then type some text WITHOUT submitting
    await clearInput(tui);
    await typeString(tui, "no-dup-test");

    const output = stripAnsi(tui.getOutput());

    // The unique typed text must appear exactly once in the output.
    // If it appears twice, the input line was duplicated (the bug).
    const matches = output.split("\n").filter((l) => l.includes("no-dup-test"));
    expect(matches.length).toBe(1);

    // Also verify: no ❯ line exists BELOW the StatsLine
    const statsIndex = output.indexOf("│ think:");
    const afterStats = output.slice(statsIndex + 1);
    const afterLines = afterStats.split("\n").filter((l) => l.trimStart().startsWith("❯"));
    expect(afterLines.length).toBe(0);
  }, TIMEOUT);
});
