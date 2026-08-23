import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteRuntimeStorePathForV2 } from '@kite/runtime-storage-sqlite';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — Keyless Runtime Cutover', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({ configOverrides: { sandbox: { enabled: false } } });
    const runtimeRoot = join(workspace.home, '.kite-code');
    writeFileSync(join(runtimeRoot, 'project-identities-v1.json'), '{"legacy":true}\n');
    writeFileSync(join(runtimeRoot, 'checkpoints.runtime-v5.db'), 'legacy-header-shim');
    server.setResponses([]);
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  step('starts a fresh target epoch without rewriting legacy header-shim files', async () => {
    const output = await waitForText(() => tui.viewport(), 'workspace', 10_000);
    const installationRoot = join(workspace.home, '.kite-code');

    expect(screenContains(output, '❯')).toBe(true);
    expect(screenContains(output, 'Runtime authority evidence exists')).toBe(false);
    expect(existsSync(join(installationRoot, 'runtime-authority.key'))).toBe(false);
    expect(existsSync(join(installationRoot, 'project-identities-state26-store5-v2.json'))).toBe(
      false,
    );
    expect(
      existsSync(sqliteRuntimeStorePathForV2(join(installationRoot, 'checkpoints.sqlite'))),
    ).toBe(true);
    expect(readFileSync(join(installationRoot, 'project-identities-v1.json'), 'utf8')).toBe(
      '{"legacy":true}\n',
    );
    expect(readFileSync(join(installationRoot, 'checkpoints.runtime-v5.db'), 'utf8')).toBe(
      'legacy-header-shim',
    );
  });

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
