import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Sandbox Mode', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        sandbox: { enabled: false },
      },
    });

    server.setResponses([{ message: { content: 'spare' } }]);
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await sleep(300);
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test(
    '/mode full is disabled when sandbox config is off',
    async () => {
      await typeText(tui, '/mode f');
      await waitForText(() => tui.output(), '未启用沙箱，Full 不可用', 10000);

      const suggestionOutput = stripAnsi(tui.output());
      expect(suggestionOutput).toContain('未启用沙箱，Full 不可用');

      await typeText(tui, 'ull');
      tui.write('\r');
      await sleep(500);

      const output = tui.output();
      expect(screenContains(output, '未启用沙箱，Full 不可用')).toBe(true);
      expect(screenContains(output, '完全权限')).toBe(false);
    },
    TIMEOUT,
  );
});
