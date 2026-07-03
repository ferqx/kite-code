/**
 * PTY System Test — ask_user Question Flow
 *
 * Verifies that when the agent calls ask_user, the TUI:
 * 1. Renders the question with options in the footer area
 * 2. Accepts Enter to select the recommended/default option
 * 3. Recovers to idle state after answering
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts
 * and approval.test.ts. Without warmup, model calls are silently skipped.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — ask_user', () => {
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
                question: 'What is your favorite color?',
                options: [
                  { id: 'blue', label: 'Blue' },
                  { id: 'red', label: 'Red' },
                ],
                recommended: 'blue',
              },
            },
          ],
        },
      },
      { message: { content: 'Ask test session' } },
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
      for (const ch of text) {
        tui.write(ch);
        await new Promise((r) => setTimeout(r, 80));
      }
      // Allow Ink to re-render the input state
      await new Promise((r) => setTimeout(r, 400));

      const output = tui.output();
      const clean = stripAnsi(output);
      console.log('  output after typing:', clean.slice(-300));
      // The typed text should appear in the input area
      // (CtrlSafeTextInput renders the current value near the prompt)
      expect(clean).toContain(text);
    },
    TIMEOUT,
  );

  // ── Empty Enter ───────────────────────────────────────────

  test(
    'empty Enter (no text) does not submit a message',
    async () => {
      // Send Enter with empty input
      tui.write('\r');
      await new Promise((r) => setTimeout(r, 500));

      const output = tui.output();
      // TUI should still be alive with prompt
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── ask_user Question → Enter to accept default ────────────

  test(
    'ask_user renders question, Enter accepts default and recovers',
    async () => {
      tui.write('Ask me a question\r');
      await new Promise((r) => setTimeout(r, 300));

      // Wait for the question to appear in the TUI output
      await waitForText(() => tui.output(), 'What is your favorite color?', 15000);

      const output = tui.output();
      expect(screenContains(output, 'What is your favorite color?')).toBe(true);
      // Options should be visible
      expect(screenContains(output, 'Blue')).toBe(true);
      expect(screenContains(output, 'Red')).toBe(true);

      // Press Enter to accept the recommended/default option (Blue, index 0)
      tui.write('\r');
      await new Promise((r) => setTimeout(r, 2000));

      // TUI should recover — prompt visible
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
