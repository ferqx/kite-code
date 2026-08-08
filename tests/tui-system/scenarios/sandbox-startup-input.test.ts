import { afterAll, beforeAll, describe, test } from 'bun:test';
import { resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;

describe('TUI PTY System - background sandbox startup', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    workspace.env.CI = 'true';
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      entryPath: resolve(import.meta.dir, '..', 'fixtures', 'deferred-sandbox-tui.tsx'),
      mockServer: server,
      workspace,
    });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps the prompt editable while sandbox preparation is still pending',
    async () => {
      const text = 'sandbox is warming';
      await typeText(tui, text);
      await clearInput(tui, text.length);
    },
    TIMEOUT,
  );
});
