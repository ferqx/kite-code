/**
 * PTY System Test — TUI Startup Smoke Test
 *
 * Verifies the TUI can start in a real PTY, render the prompt,
 * and accept basic keyboard input.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { sqliteRuntimeStorePath } from '@kite/runtime-storage-sqlite';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;

async function waitForCompleteStartupSurface(tui: PtyProcess): Promise<string> {
  let readyViewport = '';
  await waitForCondition(
    () => {
      const viewport = tui.viewport();
      if (
        !screenContains(viewport, 'workspace') ||
        !screenContains(viewport, '❯') ||
        !screenContains(viewport, 'Kite Code') ||
        !screenContains(viewport, 'mock-model') ||
        screenContains(viewport, '/model')
      ) {
        return false;
      }
      readyViewport = viewport;
      return true;
    },
    'complete startup prompt surface',
    10_000,
  );
  return readyViewport;
}

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
    'renders the prompt, footer, and Kite Code branding in a CI-backed PTY',
    async () => {
      // The initial readiness receipt can be followed by the asynchronous
      // incompatible-Store projection. Observe one complete current viewport
      // without replaying the one-shot input focus handshake or using raw
      // cumulative output as a prompt receipt.
      const output = await waitForCompleteStartupSurface(tui);
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, 'Kite Code')).toBe(true);
      expect(screenContains(output, 'mock-model')).toBe(true);
      expect(screenContains(output, '/model')).toBe(false);
    },
    TIMEOUT,
  );

  step(
    'silently ignores an unknown historical Store without blocking the fresh session',
    async () => {
      const output = await waitForCompleteStartupSurface(tui);
      expect(screenContains(output, '❯')).toBe(true);
      expect(screenContains(output, '历史会话服务不可用')).toBe(false);
      expect(screenContains(output, '请输入 /resume 重试')).toBe(false);
      expect(screenContains(output, 'RuntimeStore format')).toBe(false);
      expect(screenContains(output, '999')).toBe(false);
    },
    TIMEOUT,
  );

  step(
    'shows an empty normal selector without exposing the ignored Store marker',
    async () => {
      await submitCommand(tui, '/resume');
      const output = await waitForText(() => tui.viewport(), '暂无历史会话', 10_000);
      expect(screenContains(output, '无法加载历史会话')).toBe(false);
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
