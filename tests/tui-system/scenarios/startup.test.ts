/**
 * PTY System Test — TUI Startup Smoke Test
 *
 * Verifies the TUI can start in a real PTY, render the prompt,
 * and accept basic keyboard input.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { sqliteRuntimeStorePath } from '@kite-ai/runtime-storage-sqlite';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, screenHasSessionRow, waitForCondition } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — Startup', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({ configOverrides: { sandbox: { enabled: false } } });
    workspace.env.CI = 'true';

    // Seed an incompatible Runtime Store so startup listSessions() fails in a
    // deterministic way without making the TUI process itself fail to mount.
    const runtimeStorePath = sqliteRuntimeStorePath(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const database = new Database(runtimeStorePath);
    database.run('CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.run("INSERT INTO runtime_store_meta (key, value) VALUES ('format_version', '999')");
    database.close();

    server.setResponses([]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step(
    'keeps the fresh session interactive while silently ignoring an unknown historical Store',
    async () => {
      // spawnReadyTui already proves the complete brand/model/prompt surface
      // and focused empty input in one frame. Exercise that input after the
      // asynchronous Store discovery instead of requiring Windows ConPTY to
      // retain the header and prompt in the same 40-row viewport repaint.
      await submitCommand(tui, '/resume');
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '会话列表') &&
            screenHasSessionRow(viewport, 'tui-', { selected: true, active: true })
          );
        },
        'fresh current session row after the incompatible historical Store is ignored',
        10_000,
      );
      const output = tui.viewport();
      expect(screenContains(output, '历史会话服务不可用')).toBe(false);
      expect(screenContains(output, '请输入 /resume 重试')).toBe(false);
      expect(screenContains(output, '无法加载历史会话')).toBe(false);
      expect(screenContains(output, 'RuntimeStore format')).toBe(false);
      tui.write('\x1b');
    },
    TIMEOUT,
  );

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
