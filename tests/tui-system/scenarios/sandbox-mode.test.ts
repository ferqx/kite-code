import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
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

    server.setResponses([]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    '/permissions marks full as disabled when sandbox config is off',
    async () => {
      await typeText(tui, '/permissions f');
      await waitForText(() => tui.outputSinceLastAction(), '未启用沙箱，Full 不可用', 10000);

      const suggestionOutput = stripAnsi(tui.viewport());
      expect(suggestionOutput).toContain('未启用沙箱，Full 不可用');

      const output = tui.viewport();
      expect(screenContains(output, '未启用沙箱，Full 不可用')).toBe(true);
      expect(screenContains(output, '完全权限')).toBe(false);
      await clearInput(tui, '/permissions f'.length);
    },
    TIMEOUT,
  );

  test(
    '/permissions reports that the development entry has no production admission',
    async () => {
      await typeText(tui, '/permissions');
      tui.write('\r');
      await waitForText(
        () => tui.outputSinceLastAction(),
        'Execution boundary: not admitted',
        10000,
      );

      expect(screenContains(tui.viewport(), 'Execution boundary: not admitted')).toBe(true);
      expect(
        screenContains(
          tui.viewport(),
          'Filesystem/network/protected-path/worktree/capability status: unavailable',
        ),
      ).toBe(true);
    },
    TIMEOUT,
  );
});
