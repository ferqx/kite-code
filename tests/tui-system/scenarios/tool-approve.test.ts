/**
 * PTY System Test — Tool Approve (A) Flow
 *
 * Verifies the full approve flow: tool call → approve → tool executes → agent continues.
 * Native Shell sandbox enforcement is covered separately. This deterministic
 * scenario uses an external file mutation so approval can be exercised without
 * weakening restricted-mode Shell admission when no sandbox backend exists.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60000;

describe('TUI PTY System — Tool Approve', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let approvalMarkerPath: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        interactionMode: 'accept_edits',
        sandbox: { enabled: false },
      },
    });
    approvalMarkerPath = join(workspace.home, 'kite-tui-approval-marker.txt');

    // Response #1: a known external-scope file mutation. This exact invocation
    // takes the approval route and, once approved, executes without asking the
    // model to issue it again.
    // Response #2: what the agent says AFTER the tool executes
    server.setResponses([
      {
        message: {
          reasoning_content: 'The user wants a tool approved. I will run a command.',
          content: 'I will run a quick command for you.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'write_file',
              args: {
                path: approvalMarkerPath,
                content: 'TUI_APPROVAL_EXECUTED\n',
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'call_1',
              contentIncludes: ['kite-tui-approval-marker.txt'],
            },
          ],
        },
        message: { content: 'APPROVAL_FLOW_COMPLETE' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    // Wait for TUI fully rendered
    // Enable raw mode so individual characters reach the child immediately
    // (in canonical/line-buffered mode, input only arrives after CRLF)
  });

  afterAll(async () => {
    rmSync(approvalMarkerPath, { force: true });
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Approve (Enter) → Tool Executes → Agent Continues ─────────

  test(
    'approve (Enter, default "Yes") triggers tool execution and agent continues',
    async () => {
      await submitUserMessage(tui, server, 'Run a command for me', { timeout: 15000 });

      // Wait for approval block to render
      await waitForText(() => tui.viewport(), '工具授权', 15000);

      const beforeOutput = tui.viewport();
      expect(screenContains(beforeOutput, '工具授权')).toBe(true);
      expect(screenContains(beforeOutput, '允许一次')).toBe(true);
      expect(screenContains(beforeOutput, '拒绝')).toBe(true);

      // Approve the tool ("允许一次" is default selected at index 0, press Enter)
      const executionFrames = tui.markScreen();
      tui.write('\r');
      // The fixture serves the follow-up only after seeing the marker in the
      // tool result request, so this cannot pass on a skipped file mutation.
      await waitForText(() => tui.outputSinceLastAction(), 'APPROVAL_FLOW_COMPLETE', 15000);
      await waitForTuiReady(tui);

      const afterOutput = tui.viewport();
      const clean = stripAnsi(afterOutput);
      console.log('  output after approve (last 1500 chars):', clean.slice(-1500));

      const executionHistory = tui.screenFramesSince(executionFrames).join('\n');
      // The filesystem assertion and follow-up model request prove execution.
      // File contents stay outside the closed Runtime Client presentation surface.
      expect(screenContains(executionHistory, 'TUI_APPROVAL_EXECUTED')).toBe(false);
      expect(screenContains(executionHistory, 'exit: error')).toBe(false);
      expect(screenContains(executionHistory, '已取消')).toBe(false);
      expect(screenContains(executionHistory, 'cancelled')).toBe(false);
      expect(readFileSync(approvalMarkerPath, 'utf8')).toBe('TUI_APPROVAL_EXECUTED\n');
      expect(screenContains(afterOutput, 'APPROVAL_FLOW_COMPLETE')).toBe(true);
      expect(clean.match(/APPROVAL_FLOW_COMPLETE/g) ?? []).toHaveLength(1);
      expect(clean.match(/Workspace file changed\./g) ?? []).toHaveLength(1);

      // TUI should recover — prompt visible
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
