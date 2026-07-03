/**
 * PTY System Test — Idle Recovery after Agent Completes
 *
 * Verifies that after the agent finishes responding (no tool calls, no interrupts),
 * the TUI returns to idle state with the prompt visible for new input.
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts
 * and approval.test.ts. Without warmup, model calls are silently skipped.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Idle Summary', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: simple text response with no tool calls — agent completes
    // Response #2: spare for generateSessionName wrap-around
    server.setResponses([
      { message: { content: 'Hello! I completed my task.' }, delay: 50 },
      { message: { content: 'Idle spare' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    await waitForText(() => tui.output(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
    tui.setRawMode(true);
    // Allow raw mode transition to settle before sending keystrokes
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    tui?.kill();
    server?.stop();
    workspace?.cleanup();
  });

  // ── Text Input ────────────────────────────────────────────

  test(
    'individual keystrokes reach TUI input line',
    async () => {
      // In raw mode, individual bytes go directly to child stdin.
      // Send chars one at a time with delays matching human typing speed.
      const text = 'hello';
      await typeText(tui, text, 80);
      // Allow Ink to re-render the input state
      await sleep(400);

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after typing:', clean.slice(-300));
      // The typed text should appear in the input area
      // (CtrlSafeTextInput renders the current value near the prompt)
      expect(clean).toContain(text);

      await clearInput(tui, text.length);
    },
    TIMEOUT,
  );

  // ── Empty Enter ───────────────────────────────────────────

  test(
    'empty Enter (no text) does not submit a message',
    async () => {
      const before = server.getRequestCount();
      // Send Enter with empty input
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      // TUI should still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);
      expect(server.getRequestCount()).toBe(before);
    },
    TIMEOUT,
  );

  // ── Agent Completes → Idle Recovery ────────────────────────

  test(
    'agent finishes simple task and returns to idle state',
    async () => {
      await typeText(tui, 'Do a simple task');
      tui.write('\r');
      await waitForRequestMessage(server, 'Do a simple task', 15000);

      // Wait for the agent response to appear
      await waitForText(() => tui.output(), 'Hello! I completed my task.', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Do a simple task')).toBe(true);
      expect(screenContains(output, 'Hello! I completed my task.')).toBe(true);

      // Wait for agent to fully settle and TUI to return to idle
      await sleep(2000);

      // TUI should be idle — prompt visible, ready for next input
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
