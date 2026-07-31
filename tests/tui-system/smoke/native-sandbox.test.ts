import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { detectSandboxBackend } from '@/core/sandbox';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
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

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui.outputSinceLastAction(), '❯', 15_000);
    tui.setRawMode(true);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  nativeSandboxSmoke(
    'full_access auto-approves subsequent shell calls on a real native backend',
    async () => {
      expect(detectSandboxBackend()).not.toBe('none');

      await submitCommand(tui, '/permissions full');
      await waitForText(() => tui.outputSinceLastAction(), '完全权限', 10_000);
      await submitUserMessage(tui, server, 'Full access test', { timeout: 15_000 });
      await waitForText(() => tui.outputSinceLastAction(), 'OK, full_access confirmed.', 20_000);

      const output = tui.outputSinceLastAction();
      expect(screenContains(output, 'OK, full_access confirmed.')).toBe(true);
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
