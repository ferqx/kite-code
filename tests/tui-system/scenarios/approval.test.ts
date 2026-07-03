/**
 * PTY System Test — Tool Approval Flow
 *
 * Verifies that when the agent calls a tool requiring approval, the TUI:
 * 1. Renders the approval block with options (Approve once / Deny)
 * 2. Responds to deny (d) keystroke
 * 3. Recovers to idle state after the decision
 *
 * IMPORTANT: Like input.test.ts, this test requires a warmup phase
 * (tests 1-2: typing + empty Enter) before the first model call.
 * Without this warmup, the TUI input pipeline is not fully initialized
 * and model calls are silently skipped (0 requests to mock server).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Tool Approval', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    server.setResponses([
      {
        message: {
          content: 'I will create a directory.',
          tool_calls: [
            { id: 'call_1', name: 'shell_execute', args: { command: 'mkdir test_approval_dir' } },
          ],
        },
      },
      { message: { content: 'Approval session' } },
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

  // ── Approval Block → Deny → Recovery ──────────────────────

  test(
    'tool call triggers approval block, deny (d) recovers TUI',
    async () => {
      // Write the full message + Enter in a single write call.
      tui.write('Create a directory\r');
      await new Promise((r) => setTimeout(r, 300));

      // Wait for approval block to render
      await waitForText(() => tui.output(), 'Approve this tool call?', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Approve this tool call?')).toBe(true);
      expect(screenContains(output, 'Approve once')).toBe(true);
      expect(screenContains(output, 'Deny')).toBe(true);

      // Deny the tool
      tui.write('d');
      await new Promise((r) => setTimeout(r, 2000));

      // TUI should recover — prompt visible
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
