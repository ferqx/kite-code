/**
 * PTY System Test — ask_user Escape to Cancel
 *
 * Verifies that when an ask_user question is active, pressing Escape
 * cancels the interrupt and the TUI recovers to idle state.
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

describe('TUI PTY System — ask_user Escape', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: ask_user tool call — triggers need_input interrupt
    // Response #2: spare for generateSessionName wrap-around
    server.setResponses([
      {
        message: {
          content: 'Let me ask you something.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'ask_user',
              args: {
                question: 'What is your preferred programming language?',
                options: [
                  { id: 'ts', label: 'TypeScript' },
                  { id: 'py', label: 'Python' },
                ],
                recommended: 'ts',
              },
            },
          ],
        },
      },
      { message: { content: 'Ask esc spare' } },
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

  // ── ask_user Question → Escape → Cancel & Recover ──────────

  test(
    'ask_user renders question, Escape cancels and recovers TUI',
    async () => {
      await typeText(tui, 'Ask a question');
      tui.write('\r');
      await waitForRequestMessage(server, 'Ask a question', 15000);

      // Wait for the question to appear in the TUI output
      await waitForText(() => tui.output(), 'What is your preferred programming language?', 15000);

      const output = tui.output();
      expect(screenContains(output, 'What is your preferred programming language?')).toBe(true);
      // Options should be visible
      expect(screenContains(output, 'TypeScript')).toBe(true);
      expect(screenContains(output, 'Python')).toBe(true);

      // Press Escape to cancel the ask_user interrupt
      tui.write('\x1b');
      await sleep(2000);

      // TUI should recover — prompt visible (question cancelled)
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
