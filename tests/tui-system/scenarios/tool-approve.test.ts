/**
 * PTY System Test — Tool Approve (A) Flow
 *
 * Verifies the full approve flow: tool call → approve → tool executes → agent continues.
 * Native sandbox enforcement is covered by smoke/native-sandbox.test.ts; this
 * deterministic scenario explicitly disables it and verifies the actual tool
 * result sent back to the model.
 * Also verifies block rendering for the reasoning and completed shell card.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60000;

describe('TUI PTY System — Tool Approve', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: { sandbox: { enabled: false } },
    });

    // Response #1: shell_execute tool call (needs approval in any mode)
    // Response #2: what the agent says AFTER the tool executes
    server.setResponses([
      {
        message: {
          reasoning_content: 'The user wants a tool approved. I will run a command.',
          content: 'I will run a quick command for you.',
          tool_calls: [
            {
              id: 'call_1',
              name: 'shell_execute',
              args: {
                command: 'bun -e "console.log(\'TUI_APPROVAL_EXECUTED\')"',
                description: 'emit deterministic approval marker',
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
              contentIncludes: ['TUI_APPROVAL_EXECUTED'],
              contentExcludes: ['sandbox_apply: Operation not permitted'],
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
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Approve (Enter) → Tool Executes → Agent Continues ─────────

  test(
    'approve (Enter, default "Yes") triggers tool execution and agent continues',
    async () => {
      await submitUserMessage(tui, server, 'Run a command for me', { timeout: 15000 });

      // Wait for approval block to render
      await waitForText(() => tui.viewport(), '› 允许一次', 15000);

      const beforeOutput = tui.viewport();
      expect(screenContains(beforeOutput, '授权执行命令')).toBe(true);
      expect(screenContains(beforeOutput, '允许一次')).toBe(true);
      expect(screenContains(beforeOutput, '拒绝')).toBe(true);

      // Approve the tool ("允许一次" is default selected at index 0, press Enter)
      const executionFrames = tui.markScreen();
      tui.write('\r');

      // The fixture serves the follow-up only after seeing the marker in the
      // tool result request, so this cannot pass on a failed sandbox launch.
      await waitForText(() => tui.outputSinceLastAction(), 'APPROVAL_FLOW_COMPLETE', 15000);

      const afterOutput = tui.viewport();
      const clean = stripAnsi(afterOutput);
      console.log('  output after approve (last 1500 chars):', clean.slice(-1500));

      const executionHistory = tui.screenFramesSince(executionFrames).join('\n');
      expect(screenContains(executionHistory, 'TUI_APPROVAL_EXECUTED')).toBe(true);
      expect(screenContains(executionHistory, 'exit: error')).toBe(false);
      expect(screenContains(executionHistory, 'sandbox_apply: Operation not permitted')).toBe(
        false,
      );
      expect(screenContains(afterOutput, 'APPROVAL_FLOW_COMPLETE')).toBe(true);

      // TUI should recover — prompt visible
      expect(screenContains(afterOutput, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
