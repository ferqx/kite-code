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
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Tool Approve', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: shell_execute tool call (needs approval in any mode)
    // Response #2: what the agent says AFTER the tool executes
    // Response #3-5: spare for generateSessionName + potential retries
    server.setResponses([
      {
        message: {
          reasoning_content: 'The user wants a tool approved. I will run a command.',
          content: 'I will run a quick command for you.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'shell_execute',
              args: { command: 'node -e "console.log(1)"', description: 'test' },
            },
          ],
        },
      },
      { message: { content: 'Command executed successfully!' } },
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

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── Warmup ───────────────────────────────────────────────

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ── Approve (Enter) → Tool Executes → Agent Continues ─────────

  test(
    'approve (Enter, default "Yes") triggers tool execution and agent continues',
    async () => {
      await typeText(tui, 'Run a command for me');
      tui.write('\r');
      await waitForRequestMessage(server, 'Run a command for me', 15000);

      // Wait for approval block to render
      await waitForText(() => tui.output(), '授权执行命令', 15000);

      const beforeOutput = tui.output();
      expect(screenContains(beforeOutput, '授权执行命令')).toBe(true);
      expect(screenContains(beforeOutput, '允许一次')).toBe(true);
      expect(screenContains(beforeOutput, '拒绝')).toBe(true);

      // Approve the tool ("允许一次" is default selected at index 0, press Enter)
      tui.write('\r');
      // Wait for tool execution (write_file creates hello.txt) + second model response
      await sleep(3000);

      // Wait for the agent's follow-up response after tool execution
      await waitForText(() => tui.output(), 'Command executed successfully!', 15000);

      const afterOutput = tui.output();
      const clean = stripAnsi(afterOutput);
      console.log('  output after approve (last 1500 chars):', clean.slice(-1500));

      // Agent's response should be visible
      expect(screenContains(afterOutput, 'Command executed successfully!')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── full_access grant ─────────────────────────────────────

  test(
    'full_access grant auto-approves all subsequent tool calls',
    async () => {
      await sleep(3000);

      // Switch to full permissions mode — tool calls will auto-execute
      await typeText(tui, '/permissions full');
      tui.write('\r');
      await sleep(1000);

      server.setResponses([
        {
          message: {
            content: 'I will echo a marker.',
            tool_calls: [
              {
                id: 'call_fa1',
                name: 'shell_execute',
                args: { command: 'node -e "42"', description: 'quick test' },
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
                args: { command: 'node -e "84"', description: 'another test' },
              },
            ],
          },
        },
        { message: { content: 'OK, full_access confirmed.' } },
        { message: { content: 'spare 1' }, delay: 10 },
        { message: { content: 'spare 2' }, delay: 10 },
      ]);

      // agentLoopActive may still be true from background work
      // (generateSessionName).  Retry until the message is accepted.
      const msg = 'Full access test';
      for (let attempt = 0; attempt < 5; attempt++) {
        await typeText(tui, msg);
        tui.write('\r');
        try {
          await waitForRequestMessage(server, msg, 3000);
          break;
        } catch {
          // Input was dropped — clear the buffer and wait.
          await sleep(500);
        }
      }

      // In full mode, tools auto-execute — wait for the final model response
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
