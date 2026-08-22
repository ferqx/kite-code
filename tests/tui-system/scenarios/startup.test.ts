/**
 * PTY System Test — TUI Startup Smoke Test
 *
 * Verifies the TUI can start in a real PTY, render the prompt,
 * and accept basic keyboard input.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { sqliteRuntimeStorePathForV2 } from '@kite/runtime-storage-sqlite';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
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
    const runtimeStorePath = sqliteRuntimeStorePathForV2(
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
    'renders the prompt, footer, and Kite Code branding in a CI-backed PTY',
    async () => {
      const output = await waitForText(() => tui.viewport(), 'workspace', 10_000);
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, 'Kite Code')).toBe(true);
      expect(screenContains(output, 'mock-model')).toBe(true);
      expect(screenContains(output, '/model')).toBe(false);
    },
    TIMEOUT,
  );

  step(
    'reports historical session loading failure through normal TUI rendering',
    async () => {
      const output = await waitForText(() => tui.scrollback(), '历史会话服务不可用', 10_000);
      expect(screenContains(output, '已创建新会话')).toBe(false);
      expect(screenContains(output, '请输入 /resume 重试')).toBe(true);
      expect(screenContains(output, '/new 明确创建会话')).toBe(false);
      expect(screenContains(output, 'RuntimeStore format')).toBe(false);
      expect(screenContains(output, '999')).toBe(false);
    },
    TIMEOUT,
  );

  step(
    'does not expose the underlying session-list error in the sessions overlay',
    async () => {
      await submitCommand(tui, '/resume');
      const output = await waitForText(() => tui.viewport(), '无法加载历史会话', 10_000);
      expect(screenContains(output, 'RuntimeStore format')).toBe(false);
      expect(screenContains(output, '999')).toBe(false);
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
