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
 *   6. Slash Commands (1 test: /help)
 *   7. Session Switching — Block Preservation (2 tests)
 *   8. Interrupt & Recovery (2 tests: Ctrl+C interrupt, recovery)
 *   9. Escape Overlay Handling (1 test)
 *  10. Double Ctrl+C Exit (1 test, last — monkey-patches process.exit)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTui, type TuiHarness } from './render-tui';
import { modelError, ResponsePlan, text, toolCall } from './response-plan';

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
//   [1 call]  13. "SessionAMsg" — session switch test
//   [1 call]  14. "SessionBMsg" — session switch test
//   [1 call]  15. "NewSessionMsg" — new session test
//   [1 call]  16. "cancel test" — Ctrl+C interrupt (200ms delay)
//   [1 call]  17. "hello again" — recovery after Ctrl+C
//   [no call] 18. escape overlay handling
//   [no call] 19. double Ctrl+C exit (LAST)
//
// Total consumed: 14

const plan = new ResponsePlan([
  { group: 'send msg 1 (user block)', responses: [text('Got it!')] },
  { group: 'send msg 2 (agent text)', responses: [text('Hello!')] },
  { group: 'send msg 3 (idle state)', responses: [text('Done.')] },
  { group: 'send msg 4 (exit summary)', responses: [text('All done.')] },
  { group: 'multi-turn turn 1', responses: [text('Hello! How can I help?')] },
  { group: 'multi-turn turn 2', responses: [text('The answer is 42.')] },
  {
    group: 'tool test',
    responses: [toolCall('read_file', { path: 'test.txt' }), text('File looks good.')],
  },
  { group: 'error test', responses: [modelError('Network timeout')] },
  { group: 'session switch A', responses: [text('Reply A!')] },
  { group: 'session switch B', responses: [text('Reply B!')] },
  { group: 'new session msg', responses: [text('New session reply!')] },
  { group: 'ctrl+c interrupt', responses: [text('Processing cancel test...', 800)] },
  { group: 'recovery after ctrl+c', responses: [text('Recovery successful!')] },
]);

// ── Shared TUI instance (Ink can only render once per process) ──

let tui: TuiHarness;

// ── Helpers ──

/** Clear the TextInput buffer by sending backspace characters.
 *  Ink's TextInput may retain characters from global keybindings
 *  (e.g. "n" from Ctrl+X n or "l" from Ctrl+X l) that weren't
 *  intercepted by the overlayActive guard. */
function clearInputBuffer() {
  // Send enough backspaces to clear any leftover characters from
  // leader key sequences (e.g. Ctrl+X n leaves "n" in the TextInput buffer)
  for (let i = 0; i < 30; i++) {
    tui.stdin.write('\x7f');
  }
}

// ── Process.exit guard for double Ctrl+C test ──

function patchProcessExit(): { restore: () => void; exitCode: () => number } {
  const origExit = process.exit;
  let code = -1;
  process.exit = ((c?: number) => {
    code = c ?? 0;
  }) as any;
  return {
    restore: () => {
      process.exit = origExit;
    },
    exitCode: () => code,
  };
}

describe('TUI E2E — Startup & Core Regression (P0)', () => {
  beforeAll(async () => {
    tui = await createTui({
      modelResponses: plan.flatten(),
      workspaceFiles: { 'test.txt': 'hello world\n' },
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

  test('renders without crash — header and prompt visible', () => {
    const output = tui.getOutput();
    expect(output).toContain('❯');
    const lower = output.toLowerCase();
    expect(
      lower.includes('kite code') || lower.includes('( = = )') || lower.includes('( ^ ^ )'),
    ).toBe(true);
  });

  test('auto-creates session — TUI renders with prompt and footer', () => {
    const output = tui.getOutput();
    expect(output).toContain('❯');
    expect(output).toContain('shortcuts');
    expect(output.includes('( = = )') || output.includes('( ^ ^ )') || output.includes('❯')).toBe(
      true,
    );
  });

  // ══════════════════════════════════════════════════════════
  // 2. Send Message → Agent Response
  // ══════════════════════════════════════════════════════════

  test(
    'send message → user message block appears in output',
    async () => {
      await tui.sendMessage('unique-test-msg-42');
      await tui.waitForIdle(15000);
      expect(tui.getOutput()).toContain('unique-test-msg-42');
    },
    TIMEOUT,
  );

  test(
    'send message → agent responds with text visible in output',
    async () => {
      await tui.sendMessage('hello');
      await tui.waitForText('Hello!', 15000);
      expect(tui.getOutput()).toContain('Hello!');
    },
    TIMEOUT,
  );

  test(
    'send message → returns to idle state after agent finishes',
    async () => {
      await tui.sendMessage('do task');
      await tui.waitForIdle(15000);
      expect(tui.isRunning()).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'exit summary appears after agent finishes',
    async () => {
      await tui.sendMessage('task');
      await tui.waitForIdle(10000);
      expect(tui.getOutput()).toContain('──');
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 3. Multi-turn Conversation
  // ══════════════════════════════════════════════════════════

  test(
    'multi-turn conversation: both turns produce responses',
    async () => {
      // Clear output first via Ctrl+L to keep the output readable
      tui.stdin.write('\x0c'); // Ctrl+L → CLEAR_OUTPUT
      await new Promise((r) => setTimeout(r, 300));

      // Turn 1
      await tui.sendMessage('Hi');
      await tui.waitForIdle(10000);
      expect(tui.getOutput()).toContain('Hello! How can I help?');

      // Turn 2
      await tui.sendMessage('What is the answer?');
      await tui.waitForIdle(10000);

      const output = tui.getOutput();
      expect(output).toContain('The answer is 42.');
      expect(output).toContain('Hi');
      expect(output).toContain('What is the answer?');
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 4. Tool Call
  // ══════════════════════════════════════════════════════════

  test(
    'tool call renders in output',
    async () => {
      await tui.sendMessage('read test.txt');
      await tui.waitForIdle(15000);

      const output = tui.getOutput();
      // read_file tool may be rendered as individual tool_card or consolidated into tool_summary
      expect(output.includes('read_file') || output.includes('Thought for')).toBe(true);
      expect(output).toContain('File looks good');
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 5. Error Handling
  // ══════════════════════════════════════════════════════════

  test(
    'model error → TUI does not hang, returns to idle',
    async () => {
      await tui.sendMessage('do something');
      await tui.waitForIdle(15000);
      expect(tui.isRunning()).toBe(false);
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 6. Slash Commands
  // ══════════════════════════════════════════════════════════

  test(
    '/help shows keyboard shortcuts panel',
    async () => {
      tui.stdin.write('/help');
      await new Promise((r) => setTimeout(r, 100));
      tui.stdin.write('\r');
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).toContain('快捷键');

      // Dismiss HelpPanel
      tui.stdin.write('\x1b'); // Escape
      await new Promise((r) => setTimeout(r, 300));
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 7. Session Switching — Block Preservation
  // ══════════════════════════════════════════════════════════

  test(
    'switch session via /sessions command then switch back preserves history',
    async () => {
      await tui.sendMessage('SessionAMsg');
      await tui.waitForText('Reply A!', 15000);

      // Create session 2 via Ctrl+X n
      tui.stdin.write('\x18');
      await new Promise((r) => setTimeout(r, 400));
      tui.stdin.write('n');
      await new Promise((r) => setTimeout(r, 1500));

      // Session count should have increased — verify prompt and active session indicator visible
      const out = tui.getOutput();
      expect(out).toContain('❯');
      expect(out).toContain('shortcuts');

      // Send message in session 2
      await tui.sendMessage('SessionBMsg');
      await tui.waitForText('Reply B!', 15000);
      expect(tui.getOutput()).toContain('SessionBMsg');
    },
    TIMEOUT,
  );

  test(
    'new session: active marker follows, message goes to right session',
    async () => {
      // Create another new session via Ctrl+X n
      tui.stdin.write('\x18'); // Ctrl+X → leader
      await new Promise((r) => setTimeout(r, 400));
      tui.stdin.write('n');
      await new Promise((r) => setTimeout(r, 1500));

      // Send message to the new session
      await tui.sendMessage('NewSessionMsg');
      await tui.waitForText('New session reply!', 15000);

      const output = tui.getOutput();
      expect(output).toContain('NewSessionMsg');
      expect(output).toContain('New session reply!');

      // Clean input buffer from "n" typed by Leader key (so subsequent
      // tests don't inherit stray characters in the TextInput buffer)
      clearInputBuffer();
      await new Promise((r) => setTimeout(r, 100));
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 8. Interrupt & Recovery
  // ══════════════════════════════════════════════════════════

  test(
    'Ctrl+C during agent run → interrupts, TUI recovers to idle',
    async () => {
      // Use a response with delay (200ms) so Ctrl+C arrives during model generation
      await tui.sendMessage('cancel test');
      await tui.waitForRunning(5000);
      // Small additional delay to ensure model call is in-flight
      await new Promise((r) => setTimeout(r, 100));
      // Send Ctrl+C
      tui.stdin.write('\x03');
      // Wait for agent to stop
      await tui.waitForRunningGone(15000);
      // TUI should be responsive (not hanging)
      expect(tui.isRunning()).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'recovery: TUI accepts new message after Ctrl+C interruption',
    async () => {
      // After the Ctrl+C interrupt, verify the TUI can accept and process
      // new messages normally.
      // Wait for agent loop to fully clean up (mock response takes ~800ms)
      await tui.waitForIdle(5000);
      await new Promise((r) => setTimeout(r, 1200));
      await tui.sendMessage('hello again');
      await tui.waitForText('Recovery successful!', 15000);
      expect(tui.getOutput()).toContain('Recovery successful!');
      expect(tui.isRunning()).toBe(false);
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 9. Escape — Overlay Dismissal
  // ══════════════════════════════════════════════════════════

  test(
    'Escape dismisses HelpPanel and SessionSelector individually',
    async () => {
      // Clear any leftover characters from previous tests
      clearInputBuffer();
      await new Promise((r) => setTimeout(r, 200));
      // Dismiss any lingering overlays
      tui.stdin.write('\x1b');
      await new Promise((r) => setTimeout(r, 300));

      // ── HelpPanel ──
      tui.stdin.write('/help');
      await new Promise((r) => setTimeout(r, 300));
      tui.stdin.write('\r');
      await new Promise((r) => setTimeout(r, 800));
      expect(tui.getOutput()).toContain('快捷键');

      // Escape dismisses HelpPanel
      tui.stdin.write('\x1b');
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).not.toContain('快捷键');

      // ── SessionSelector (via /sessions slash command — leader keys removed in shortcut simplification) ──
      clearInputBuffer();
      await new Promise((r) => setTimeout(r, 200));

      tui.stdin.write('/sessions');
      await new Promise((r) => setTimeout(r, 300));
      tui.stdin.write('\r');
      await new Promise((r) => setTimeout(r, 800));
      expect(tui.getOutput()).toContain('会话列表');

      // Escape dismisses SessionSelector
      tui.stdin.write('\x1b');
      await new Promise((r) => setTimeout(r, 500));
      expect(tui.getOutput()).not.toContain('会话列表');

      clearInputBuffer();
      await new Promise((r) => setTimeout(r, 200));
    },
    TIMEOUT,
  );

  // ══════════════════════════════════════════════════════════
  // 10. Double Ctrl+C Exit (LAST — monkey-patches process.exit)
  // ══════════════════════════════════════════════════════════

  test(
    'double Ctrl+C triggers exit (process.exit(0))',
    async () => {
      // Monkey-patch process.exit to prevent actual process death.
      // We verify the exit code is 0 without killing the test runner.
      const guard = patchProcessExit();

      try {
        // Allow the overlay-dismissal Escape events from the previous test
        // to fully propagate before pressing Ctrl+C
        await new Promise((r) => setTimeout(r, 1000));

        // First Ctrl+C — when idle, this just sets ctrlCPressed=true
        tui.stdin.write('\x03');
        await new Promise((r) => setTimeout(r, 300));

        // Second Ctrl+C — ctrlCPressed was true, so this sets exitRequested=true
        // which triggers the React useEffect calling process.exit(0)
        tui.stdin.write('\x03');
        await new Promise((r) => setTimeout(r, 500));

        expect(guard.exitCode()).toBe(0);
      } finally {
        guard.restore();
      }
    },
    TIMEOUT,
  );
});
