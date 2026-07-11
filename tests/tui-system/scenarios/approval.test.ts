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
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

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

  // ── Approval Block → Deny → Recovery ──────────────────────

  test(
    'tool call triggers approval block, deny (d) recovers TUI',
    async () => {
      await typeText(tui, 'Create a directory');
      tui.write('\r');
      await waitForRequestMessage(server, 'Create a directory', 15000);

      // Wait for approval block to render
      await waitForText(() => tui.output(), 'Approve this tool call?', 15000);

      const output = tui.output();
      expect(screenContains(output, 'Approve this tool call?')).toBe(true);
      expect(screenContains(output, 'Yes · 仅本次')).toBe(true);
      expect(screenContains(output, 'Deny · 拒绝')).toBe(true);

      // Navigate to "Deny · 拒绝" (index 3) and press Enter
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\r');
      await sleep(2000);

      // TUI should recover — prompt visible
      const afterOutput = tui.output();
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
