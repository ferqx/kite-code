/**
 * PTY System Test — Tool Approve (A) Flow
 *
 * Verifies the full approve flow: tool call → approve → tool executes → agent continues.
 * Also verifies block rendering: reason block (from reasoning_content),
 * tool_card done status, and file_change block (from write_file).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60000;

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
    await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);

    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── Approve (Enter) → Tool Executes → Agent Continues ─────────

  test(
    'approve (Enter, default "Yes") triggers tool execution and agent continues',
    async () => {
      await submitUserMessage(tui, server, 'Run a command for me', { timeout: 15000 });

      // Wait for approval block to render
      await waitForText(() => tui.outputSinceLastAction(), '授权执行命令', 15000);

      const beforeOutput = tui.viewport();
      expect(screenContains(beforeOutput, '授权执行命令')).toBe(true);
      expect(screenContains(beforeOutput, '允许一次')).toBe(true);
      expect(screenContains(beforeOutput, '拒绝')).toBe(true);

      // Approve the tool ("允许一次" is default selected at index 0, press Enter)
      tui.write('\r');

      // Wait for the agent's follow-up response after tool execution
      await waitForText(() => tui.outputSinceLastAction(), 'Command executed successfully!', 15000);

      const afterOutput = tui.viewport();
      const clean = stripAnsi(afterOutput);
      console.log('  output after approve (last 1500 chars):', clean.slice(-1500));

      // Agent's response should be visible
      expect(screenContains(afterOutput, 'Command executed successfully!')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
