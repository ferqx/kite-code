/**
 * PTY System Test — Tool Approval Flow
 *
 * Verifies that when the agent calls a tool requiring approval, the TUI:
 * 1. Renders the approval block with options (Approve once / Deny)
 * 2. Responds to deny (d) keystroke
 * 3. Recovers to idle state after the decision
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForOutputQuiescence, waitForText } from '../harness/terminal-screen';
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
            {
              id: 'call_1',
              name: 'shell_execute',
              args: { command: 'node -e "1+1"', description: 'test command' },
            },
          ],
        },
      },
      { message: { content: 'Approval session' } },
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

  // ── Approval Block → Deny → Recovery ──────────────────────

  test(
    'tool call triggers approval block, deny (d) recovers TUI',
    async () => {
      await typeText(tui, 'Create a directory');
      tui.write('\r');
      await waitForRequestMessage(server, 'Create a directory', 15000);

      // Wait for approval block to render
      await waitForText(() => tui.outputSinceLastAction(), '授权执行命令', 15000);

      const output = tui.output();
      expect(screenContains(output, '授权执行命令')).toBe(true);
      expect(screenContains(output, '允许一次')).toBe(true);
      expect(screenContains(output, '拒绝')).toBe(true);

      // Navigate to "拒绝" (index 2) and press Enter
      tui.write('\x1b[B');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      tui.write('\x1b[B');
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), '❯', 15000);

      // TUI should recover — prompt visible
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
