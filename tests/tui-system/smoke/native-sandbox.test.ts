import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { detectSandboxBackend } from '@/core/sandbox';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60_000;
const nativeSandboxSmoke = process.env.KITE_RUN_NATIVE_SANDBOX_SMOKE === '1' ? test : test.skip;

describe('TUI PTY native sandbox smoke', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'I will echo a marker.',
          tool_calls: [
            {
              id: 'call_fa1',
              name: 'shell_execute',
              args: {
                command: 'bun -e "console.log(\'NATIVE_SANDBOX_FIRST\')"',
                description: 'first native sandbox marker',
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_fa1', contentIncludes: ['NATIVE_SANDBOX_FIRST'] }],
        },
        message: {
          content: 'FA_DONE: all tools passed.',
          tool_calls: [
            {
              id: 'call_fa2',
              name: 'shell_execute',
              args: {
                command: 'bun -e "console.log(\'NATIVE_SANDBOX_SECOND\')"',
                description: 'second native sandbox marker',
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_fa2', contentIncludes: ['NATIVE_SANDBOX_SECOND'] }],
        },
        message: { content: 'NATIVE_SANDBOX_FLOW_COMPLETE' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  nativeSandboxSmoke(
    'full_access auto-approves subsequent shell calls on a real native backend',
    async () => {
      expect(detectSandboxBackend()).not.toBe('none');

      await submitCommand(tui, '/permissions full');
      await waitForText(() => tui.outputSinceLastAction(), '完全权限', 10_000);
      const executionFrames = tui.markScreen();
      await submitUserMessage(tui, server, 'Full access test', { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), 'NATIVE_SANDBOX_FLOW_COMPLETE', 20_000);

      const output = tui.viewport();
      const executionHistory = tui.screenFramesSince(executionFrames).join('\n');
      expect(screenContains(executionHistory, 'NATIVE_SANDBOX_FIRST')).toBe(true);
      expect(screenContains(executionHistory, 'NATIVE_SANDBOX_SECOND')).toBe(true);
      expect(screenContains(executionHistory, 'exit: error')).toBe(false);
      expect(screenContains(output, 'NATIVE_SANDBOX_FLOW_COMPLETE')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
