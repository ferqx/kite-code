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
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Approval Escape', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: { interactionMode: 'accept_edits' },
    });
    externalFile = join(workspace.home, 'approval-escape-external.txt');

    // Response #1: an external write_file call that needs approval on every
    // platform, including Linux CI hosts without a native Shell sandbox.
    // Response #2: normal response for the second user message after Escape cancel
    server.setResponses([
      {
        toolContinuation: 'aborted',
        message: {
          content: 'I will create a directory for you.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'write_file',
              args: {
                path: externalFile,
                content: 'This write must be cancelled by Escape.',
              },
            },
          ],
        },
      },
      { message: { content: 'Second message received after cancel.' } },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Approval → Escape → Cancel & Recover → Send Again ────

  test(
    'Escape cancels approval, TUI goes idle, can send new message',
    async () => {
      // Send first message to trigger tool approval
      await submitUserMessage(tui, server, 'Create a directory', { timeout: 15000 });

      // Wait for approval block to render
      await waitForText(() => tui.viewport(), '工具授权', 15000);

      const beforeOutput = tui.viewport();
      expect(screenContains(beforeOutput, '工具授权')).toBe(true);
      expect(screenContains(beforeOutput, '允许一次')).toBe(true);
      expect(screenContains(beforeOutput, '拒绝')).toBe(true);
      expect(screenContains(beforeOutput, 'Working')).toBe(false);

      // Press Escape to cancel the approval
      tui.write('\x1b');
      await waitForTuiReady(tui);

      // TUI should recover — prompt visible (approval cancelled)
      const afterOutput = tui.viewport();
      expect(screenContains(afterOutput, '❯')).toBe(true);

      // Now send a second message — verify agent responds normally after cancel
      const msg = 'Second message';
      await submitUserMessage(tui, server, msg, { timeout: 15000 });

      // Wait for the agent's response
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Second message received after cancel.',
        15000,
      );

      const finalOutput = tui.viewport();
      expect(screenContains(finalOutput, 'Second message received after cancel.')).toBe(true);
      // TUI should still be idle with prompt visible after agent responds
      expect(screenContains(finalOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

describe('TUI PTY System — Approval Ctrl+C', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let externalFile: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: { interactionMode: 'accept_edits' },
    });
    externalFile = join(workspace.home, 'approval-ctrl-c-external.txt');
    server.setResponses([
      {
        toolContinuation: 'aborted',
        message: {
          content: 'I will run the requested command.',
          tool_calls: [
            {
              id: 'call_ctrl_c',
              name: 'write_file',
              args: {
                path: externalFile,
                content: 'This write must be cancelled by Ctrl+C.',
              },
            },
          ],
        },
      },
      { message: { content: 'Still alive after approval Ctrl+C.' } },
    ]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'Ctrl+C cancels approval without exiting the TUI',
    async () => {
      await submitUserMessage(tui, server, 'Run a command', { timeout: 15000 });
      await waitForText(() => tui.viewport(), '工具授权', 15000);
      expect(screenContains(tui.viewport(), 'Working')).toBe(false);

      tui.write('\x03');
      await waitForTuiReady(tui);

      await submitUserMessage(tui, server, 'Are you still alive?', { timeout: 15000 });
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Still alive after approval Ctrl+C.',
        15000,
      );
      expect(screenContains(tui.viewport(), 'Still alive after approval Ctrl+C.')).toBe(true);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
