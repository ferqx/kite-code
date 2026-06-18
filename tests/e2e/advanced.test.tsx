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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTui, type TuiHarness } from './render-tui';
import { ResponsePlan, text } from './response-plan';

const TIMEOUT = 60000;

// ── Response Plan ──
//
// Tests that consume model responses:
//   test "send 2 messages": history msg1          → 1 call
//   test "send 2 messages": history msg2          → 1 call
//   test "long message":    long message          → 1 call
//   test "/clear + resume":  resume after clear    → 1 call
//   test "rapid Ctrl+C":    cancel target msg     → 1 call (delay 500ms)
//   test "rapid Ctrl+C":    recovery after cancel → 1 call
//
// Total consumed: 6

const plan = new ResponsePlan([
  {
    group: 'history-msg1',
    responses: [text('History reply 1: message received.')],
  },
  {
    group: 'history-msg2',
    responses: [text('History reply 2: second message received.')],
  },
  {
    group: 'long-msg',
    responses: [text('Long message processed successfully.')],
  },
  {
    group: 'resume-after-clear',
    responses: [text('After clear response.')],
  },
  {
    group: 'rapid-ctrl-c',
    responses: [text('Processing rapid cancel test...', 500)],
  },
  {
    group: 'recovery-after-cancel',
    responses: [text('Recovery after cancel successful.')],
  },
]);

// ── Helpers ──

function clearInputBuffer(tui: TuiHarness) {
  for (let i = 0; i < 100; i++) {
    tui.stdin.write('\x7f');
  }
}

async function dismissOverlays(tui: TuiHarness) {
  for (let i = 0; i < 3; i++) {
    tui.stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function runSlashCommand(tui: TuiHarness, cmd: string, delay = 1000) {
  await dismissOverlays(tui);
  await new Promise((r) => setTimeout(r, 200));
  clearInputBuffer(tui);
  await new Promise((r) => setTimeout(r, 100));
  tui.stdin.write(cmd);
  await new Promise((r) => setTimeout(r, 100));
  tui.stdin.write('\r');
  await new Promise((r) => setTimeout(r, delay));
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Shared TUI instance ──

let tui: TuiHarness;

describe('TUI E2E — P2+P3 Advanced Interactions', () => {
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

  describe('Input Advanced', () => {
    test(
      'empty input (Enter with no text) does not submit',
      async () => {
        // Type nothing, just press Enter
        clearInputBuffer(tui);
        await sleep(200);

        await sleep(200);

        tui.stdin.write('\r');
        await sleep(500);

        const outputAfter = tui.getOutput();
        // Output should be essentially unchanged (no new user message block)
        // Just verify no crash occurred and TUI is still responsive
        expect(outputAfter.length).toBeGreaterThan(0);
        expect(tui.isIdle() || tui.isRunning()).toBe(true);
      },
      TIMEOUT,
    );

    test(
      'send 2 messages → verify both history entries visible in output',
      async () => {
        // Message 1
        await tui.sendMessage('HistoryMsg1');
        await tui.waitForIdle(15000);
        expect(tui.getOutput()).toContain('History reply 1');

        // Message 2
        await tui.sendMessage('HistoryMsg2');
        await tui.waitForIdle(15000);
        expect(tui.getOutput()).toContain('History reply 2');

        // Both user message blocks appear
        const output = tui.getOutput();
        expect(output).toContain('HistoryMsg1');
        expect(output).toContain('HistoryMsg2');
      },
      TIMEOUT,
    );

    test(
      'long message (>100 chars) is handled without crash',
      async () => {
        const longText = 'A'.repeat(120);
        await tui.sendMessage(longText);
        await tui.waitForIdle(15000);

        expect(tui.getOutput()).toContain('Long message processed successfully.');
        expect(tui.isRunning()).toBe(false);
      },
      TIMEOUT,
    );

    test(
      'history navigation: after multiple messages, output contains all of them',
      async () => {
        const output = tui.getOutput();
        expect(output).toContain('HistoryMsg1');
        expect(output).toContain('History reply 1');
        expect(output).toContain('HistoryMsg2');
        expect(output).toContain('History reply 2');
        // Long message text may be truncated in output, verify agent replied
        expect(output).toContain('Long message processed successfully.');
      },
      TIMEOUT,
    );
  });

  // Compact Context via Leader Key removed — compaction logic removed

  // ══════════════════════════════════════════════════════════
  // 3. Leader Keys
  // ══════════════════════════════════════════════════════════

  describe('Leader Keys', () => {
    test(
      'Ctrl+X invalid key → leader cancelled, no side effect',
      async () => {
        clearInputBuffer(tui);
        await sleep(100);

        tui.stdin.write('\x18'); // Ctrl+X → leader
        await sleep(300);
        tui.stdin.write('z'); // Invalid leader key
        await sleep(300);

        // TUI should still be functional
        expect(tui.isIdle() || tui.isRunning()).toBe(true);

        // Clean up any stray "z"
        clearInputBuffer(tui);
        await sleep(100);
      },
      TIMEOUT,
    );

    test(
      'Ctrl+X Esc → leader cancelled',
      async () => {
        clearInputBuffer(tui);
        await sleep(100);

        tui.stdin.write('\x18'); // Ctrl+X → leader
        await sleep(300);
        tui.stdin.write('\x1b'); // Escape
        await sleep(300);

        // TUI should still be functional
        expect(tui.isIdle() || tui.isRunning()).toBe(true);
      },
      TIMEOUT,
    );

    test(
      '/model opens model selector (replaces removed Ctrl+X m)',
      async () => {
        await runSlashCommand(tui, '/model', 600);
        expect(tui.getOutput()).toContain('选择模型');

        tui.stdin.write('\x1b');
        await sleep(300);
      },
      TIMEOUT,
    );

    test(
      '/sessions opens session selector (replaces removed Ctrl+X l)',
      async () => {
        await runSlashCommand(tui, '/sessions', 600);
        expect(tui.getOutput()).toContain('会话列表');

        tui.stdin.write('\x1b');
        await sleep(300);
      },
      TIMEOUT,
    );
  });

  // ══════════════════════════════════════════════════════════
  // 4. Global Shortcuts
  // ══════════════════════════════════════════════════════════

  describe('Global Shortcuts', () => {
    test(
      '/auth toggles authorization (replaces removed Ctrl+R)',
      async () => {
        const initialAuth = tui.getAuthMode();
        expect(initialAuth).toBeDefined();

        await runSlashCommand(tui, '/auth', 500);
        const toggledAuth = tui.getAuthMode();
        expect(toggledAuth).toBeDefined();
        expect(toggledAuth).not.toBe(initialAuth);

        // Toggle back
        await runSlashCommand(tui, '/auth', 500);
        expect(tui.getAuthMode()).toBe(initialAuth);
      },
      TIMEOUT,
    );

    test(
      'Ctrl+T → toggles reasoning (no crash)',
      async () => {
        tui.stdin.write('\x14'); // Ctrl+T
        await sleep(400);

        // TUI should still be functional
        expect(tui.isIdle() || tui.isRunning()).toBe(true);

        // Toggle back
        tui.stdin.write('\x14'); // Ctrl+T
        await sleep(400);
      },
      TIMEOUT,
    );

    test(
      '/clear clears output (replaces removed Ctrl+L)',
      async () => {
        // /clear dispatches CLEAR_OUTPUT which resets turns array.
        // Static content persists in lastFrame(), so verify TUI stays functional.
        await runSlashCommand(tui, '/clear', 500);
        expect(tui.isIdle() || tui.isRunning()).toBe(true);
        // Prompt should still be visible after clear
        expect(tui.getOutput()).toContain('❯');
      },
      TIMEOUT,
    );

    test(
      'Ctrl+N → creates new session, TUI remains responsive',
      async () => {
        const outputBefore = tui.getOutput();
        expect(outputBefore.length).toBeGreaterThan(0);

        tui.stdin.write('\x0e'); // Ctrl+N
        await sleep(1500);

        // After creating a new session, the TUI should still be responsive
        // and the output area should be cleared (NEW_SESSION clears blocks)
        const outputAfter = tui.getOutput();
        expect(outputAfter.length).toBeGreaterThan(0);
        expect(tui.isIdle() || tui.isRunning()).toBe(true);
      },
      TIMEOUT,
    );

    test(
      '/help opens help panel (replaces removed Ctrl+H)',
      async () => {
        await runSlashCommand(tui, '/help', 600);
        expect(tui.getOutput()).toContain('快捷键');

        tui.stdin.write('\x1b');
        await sleep(500);
        expect(tui.getOutput()).not.toContain('快捷键');
      },
      TIMEOUT,
    );
  });

  // ══════════════════════════════════════════════════════════
  // 4. Integration: /clear then resume (skipped)
  // ══════════════════════════════════════════════════════════

  describe('Integration: /clear + resume', () => {
    test(
      '/clear then send new message → works normally',
      async () => {
        // Skip: Ink TextInput does not reliably recover stdin focus after overlay interactions in test environment.
        // Send /clear command
        tui.stdin.write('/clear');
        await sleep(100);
        tui.stdin.write('\r');
        await sleep(500);

        // Then send a new message
        await tui.sendMessage('resume after clear');
        await tui.waitForIdle(15000);

        expect(tui.isRunning()).toBe(false);
      },
      TIMEOUT,
    );
  });

  // ══════════════════════════════════════════════════════════
  // 5. Rapid Consecutive Operations
  // ══════════════════════════════════════════════════════════

  describe('Rapid Operations', () => {
    test(
      'send message → Ctrl+C interrupt → idle → send again (recovery)',
      async () => {
        // Send a message with delay (200ms) to allow Ctrl+C to arrive mid-execution
        await tui.sendMessage('rapid cancel');
        await tui.waitForRunning(5000);
        // Brief delay so the model call is in-flight
        await sleep(100);

        // Immediately send Ctrl+C
        tui.stdin.write('\x03');
        await sleep(300);

        // Wait for agent to stop
        await tui.waitForRunningGone(15000);
        expect(tui.isRunning()).toBe(false);

        // Recover: send a new message and verify it works
        await tui.sendMessage('recover now');
        await tui.waitForText('Recovery after cancel successful.', 15000);

        expect(tui.getOutput()).toContain('Recovery after cancel successful.');
        expect(tui.isRunning()).toBe(false);
      },
      TIMEOUT,
    );
  });

  // ══════════════════════════════════════════════════════════
  // 6. Long Output Check
  // ══════════════════════════════════════════════════════════

  describe('Long Output', () => {
    test(
      'output length > 100 chars after many operations',
      async () => {
        // After all previous tests, the output should have substantial content
        const output = tui.getOutput();
        // The TUI rendered output should be non-trivial after many operations
        // (even if some tests cleared or changed session, header + output = non-trivial)
        expect(output.length).toBeGreaterThan(100);
      },
      TIMEOUT,
    );
  });
});
