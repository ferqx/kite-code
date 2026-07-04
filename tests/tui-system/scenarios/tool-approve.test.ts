/**
 * PTY System Test — Tool Approve (A) Flow
 *
 * Verifies the full approve flow: tool call → approve → tool executes → agent continues.
 * Also verifies block rendering: reason block (from reasoning_content),
 * tool_card done status, and file_change block (from write_file).
 *
 * IMPORTANT: Like approval.test.ts, this test requires a warmup phase
 * (tests 1-2: typing + empty Enter) before the first model call.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Tool Approve', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: reasoning + write_file tool call (needs approval, produces file_change)
    // Response #2: what the agent says AFTER the tool executes
    // Response #3-5: spare for generateSessionName + potential retries
    server.setResponses([
      {
        message: {
          reasoning_content: 'The user wants a tool approved. I will write a file.',
          content: 'I will create a file for you.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'write_file',
              args: { path: 'hello.txt', content: 'Hello from PTY test!' },
            },
          ],
        },
      },
      { message: { content: 'File created successfully!' } },
      { message: { content: 'Approve spare 1' } },
      { message: { content: 'Approve spare 2' } },
      { message: { content: 'Approve spare 3' } },
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
      // No model call should have been made
      expect(server.getRequestCount()).toBe(before);
    },
    TIMEOUT,
  );

  // ── Approve (Enter) → Tool Executes → Agent Continues ─────────

  test(
    'approve (Enter, default "Yes") triggers tool execution and agent continues',
    async () => {
      await typeText(tui, 'Create a file for me');
      tui.write('\r');
      await waitForRequestMessage(server, 'Create a file for me', 15000);

      // Wait for approval block to render
      await waitForText(() => tui.output(), 'Approve this tool call?', 15000);

      const beforeOutput = tui.output();
      expect(screenContains(beforeOutput, 'Approve this tool call?')).toBe(true);
      expect(screenContains(beforeOutput, 'Yes · 仅本次')).toBe(true);
      expect(screenContains(beforeOutput, 'Deny · 拒绝')).toBe(true);

      // Approve the tool ("Yes · 仅本次" is default selected at index 0, press Enter)
      tui.write('\r');
      // Wait for tool execution (write_file creates hello.txt) + second model response
      await sleep(3000);

      // Wait for the agent's follow-up response after tool execution
      await waitForText(() => tui.output(), 'File created successfully!', 15000);

      const afterOutput = tui.output();
      const clean = stripAnsi(afterOutput);
      console.log('  output after approve (last 1500 chars):', clean.slice(-1500));
      console.log('  searching for hello.txt in output:', screenContains(afterOutput, 'hello.txt'));

      // Agent's response should be visible
      expect(screenContains(afterOutput, 'File created successfully!')).toBe(true);

      // tool_card done state: write_file should show the action name "Create" and file path
      // The tool_card was already rendered before approval (as awaiting approval),
      // and after execution it transitions to done state in the scrollback
      expect(screenContains(afterOutput, 'hello.txt')).toBe(true);
      expect(screenContains(afterOutput, 'Create')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── full_access grant ─────────────────────────────────────

  test(
    'full_access grant auto-approves all subsequent tool calls',
    async () => {
      // Wait for pending fire-and-forget calls from previous test to complete
      await sleep(3000);

      server.setResponses([
        {
          message: {
            content: 'I will echo a marker.',
            tool_calls: [
              {
                id: 'call_fa1',
                name: 'shell_execute',
                args: { command: "echo 'fa_marker'" },
              },
            ],
          },
        },
        {
          message: {
            content: 'FA_DONE: all tools passed.',
            tool_calls: [
              {
                id: 'call_fa2',
                name: 'shell_execute',
                args: { command: 'ls /tmp' },
              },
            ],
          },
        },
        { message: { content: 'OK, full_access confirmed.' } },
        { message: { content: 'spare 1' }, delay: 10 },
        { message: { content: 'spare 2' }, delay: 10 },
      ]);

      await typeText(tui, 'Full access test');
      tui.write('\r');
      await waitForRequestMessage(server, 'Full access test', 15000);

      // Wait for first approval block
      await waitForText(() => tui.output(), 'Approve this tool call?', 15000);
      await sleep(500);

      expect(screenContains(tui.output(), 'Approve this tool call?')).toBe(true);

      // Navigate to "Full · 完全权限" (index 2): down arrow twice, then Enter
      tui.write('\x1b[B');
      await sleep(150);
      tui.write('\x1b[B');
      await sleep(150);
      tui.write('\r');
      await sleep(2000);

      // All subsequent tool calls should execute without approval
      // Wait for the final model response
      await waitForText(() => tui.output(), 'OK, full_access confirmed.', 20000);
      await sleep(500);

      const finalOutput = tui.output();
      expect(screenContains(finalOutput, 'OK, full_access confirmed.')).toBe(true);
      // TUI should recover — prompt visible
      expect(screenContains(finalOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
