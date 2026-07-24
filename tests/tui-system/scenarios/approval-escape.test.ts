/**
 * PTY System Test — Tool Approval Escape to Cancel
 *
 * Verifies that when an approval prompt is active (tool_call requiring approval),
 * pressing Escape cancels the interrupt and the TUI recovers to idle state,
 * and the user can continue with a new message.
 *
 * Complements:
 *   - approval.test.ts (deny via `d` key)
 *   - tool-approve.test.ts (approve via `a` key)
 *   - ask-user-esc.test.ts (escape to cancel ask_user interrupt)
 *
 * IMPORTANT: Follows the same 3-test warmup pattern as input.test.ts
 * and approval.test.ts. Without warmup, model calls are silently skipped.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

describe('TUI PTY System — Approval Escape', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Response #1: shell_execute tool call that needs approval
    // Response #2: normal response for the second user message after Escape cancel
    // Response #3-6: spares for generateSessionName + potential retries
    server.setResponses([
      {
        message: {
          content: 'I will create a directory for you.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'shell_execute',
              args: { command: 'node -e "1+1"', description: 'test escape approval' },
            },
          ],
        },
      },
      { message: { content: 'Second message received after cancel.' } },
      { message: { content: 'Spare 1' } },
      { message: { content: 'Spare 2' } },
      { message: { content: 'Spare 3' } },
      { message: { content: 'Spare 4' } },
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

  // ── Approval → Escape → Cancel & Recover → Send Again ────

  test(
    'Escape cancels approval, TUI goes idle, can send new message',
    async () => {
      // Send first message to trigger tool approval
      await typeText(tui, 'Create a directory');
      tui.write('\r');
      await waitForRequestMessage(server, 'Create a directory', 15000);

      // Wait for approval block to render
      await waitForText(() => tui.output(), '授权执行命令', 15000);

      const beforeOutput = tui.output();
      expect(screenContains(beforeOutput, '授权执行命令')).toBe(true);
      expect(screenContains(beforeOutput, '允许一次')).toBe(true);
      expect(screenContains(beforeOutput, '拒绝')).toBe(true);

      // Press Escape to cancel the approval
      tui.write('\x1b');
      await sleep(2000);

      // TUI should recover — prompt visible (approval cancelled)
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);

      // Now send a second message — verify agent responds normally after cancel
      const msg = 'Second message';
      await typeText(tui, msg);
      tui.write('\r');
      await waitForRequestMessage(server, msg, 15000);

      // Wait for the agent's response
      await waitForText(() => tui.output(), 'Second message received after cancel.', 15000);

      const finalOutput = tui.output();
      expect(screenContains(finalOutput, 'Second message received after cancel.')).toBe(true);
      // TUI should still be idle with prompt visible after agent responds
      expect(screenContains(finalOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
