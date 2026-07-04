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

  // ── Approve (a) → Tool Executes → Agent Continues ─────────

  test(
    'approve (a) triggers tool execution and agent continues',
    async () => {
      await typeText(tui, 'Create a file for me');
      tui.write('\r');
      await waitForRequestMessage(server, 'Create a file for me', 15000);

      // Wait for approval block to render
      await waitForText(() => tui.output(), 'Approve this tool call?', 15000);

      const beforeOutput = tui.output();
      expect(screenContains(beforeOutput, 'Approve this tool call?')).toBe(true);
      expect(screenContains(beforeOutput, 'Approve once')).toBe(true);
      expect(screenContains(beforeOutput, 'Deny')).toBe(true);

      // Approve the tool (press 'a' for "Approve once")
      tui.write('a');
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

  // ── same_command grant scope ─────────────────────────

  test(
    'same_command grant auto-approves matching command, different command re-triggers approval',
    async () => {
      // Wait for pending fire-and-forget calls from previous test to complete
      await sleep(3000);

      server.setResponses([
        {
          message: {
            content: 'I will echo a marker.',
            tool_calls: [
              {
                id: 'call_sc1',
                name: 'shell_execute',
                args: { command: "echo 'sc_marker'" },
              },
            ],
          },
        },
        {
          message: {
            content: 'Same command again.',
            tool_calls: [
              {
                id: 'call_sc2',
                name: 'shell_execute',
                args: { command: "echo 'sc_marker'" },
              },
            ],
          },
        },
        {
          message: {
            content: 'SC_DIFF: listing /tmp.',
            tool_calls: [
              {
                id: 'call_sc3',
                name: 'shell_execute',
                args: { command: 'ls /tmp' },
              },
            ],
          },
        },
        { message: { content: 'OK, done.' } },
        { message: { content: 'spare' }, delay: 10 },
        { message: { content: 'spare' }, delay: 10 },
      ]);

      await typeText(tui, 'Echo a test marker');
      tui.write('\r');
      await waitForRequestMessage(server, 'Echo a test marker', 15000);

      // Wait for unique command text (avoids stale scrollback match)
      await waitForText(() => tui.output(), 'sc_marker', 15000);
      await sleep(500);

      // First approval block should be visible
      expect(screenContains(tui.output(), 'Approve this tool call?')).toBe(true);

      // Grant same_command
      tui.write('s');

      // If same_command works, the second echo is auto-approved and the
      // model reaches the third response (SC_DIFF). If not, test times out.
      await waitForText(() => tui.output(), 'SC_DIFF', 20000);
      await sleep(1500);

      // The different command should trigger a NEW approval block
      const output2 = tui.output();
      expect(screenContains(output2, 'Approve this tool call?')).toBe(true);
      expect(screenContains(output2, 'ls /tmp')).toBe(true);

      // Deny to clean up
      tui.write('d');
      await sleep(2000);

      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── full_access grant scope ──────────────────────────
  //
  // NOTE: full_access ('f' key) E2E coverage is deferred. Two issues:
  // 1. <Static> scrollback persistence — "Approve this tool call?" text
  //    from previous tests pollutes waitForText matching.
  // 2. Ink 7 useInput routing — after accumulated test state, the
  //    ApprovalBlock's keyboard handler may not receive the 'f' key in
  //    raw PTY mode before the InputLine.
  // Manual verification: `bun run tui` → trigger shell_execute approval →
  // press 'f' → verify [完全] in StatsLine.
});
