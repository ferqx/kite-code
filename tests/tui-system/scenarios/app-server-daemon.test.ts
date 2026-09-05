import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedLocalAppServerDaemon } from '../../../scripts/release/app-server-daemon';
import { cleanupTuiSystemFixtures, stopTuiSystemServer } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — explicit App Server daemon', () => {
  let tui: PtyProcess | undefined;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let daemon: ReturnType<typeof createManagedLocalAppServerDaemon>;

  beforeEach(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    const sourceWebStaticRoot = join(workspace.home, 'daemon-web');
    mkdirSync(join(sourceWebStaticRoot, 'api-docs'), { recursive: true });
    mkdirSync(join(sourceWebStaticRoot, 'assets'), { recursive: true });
    writeFileSync(join(sourceWebStaticRoot, 'index.html'), '<html>Kite daemon</html>');
    writeFileSync(join(sourceWebStaticRoot, 'api-docs', 'openapi.json'), '{}');
    writeFileSync(join(sourceWebStaticRoot, 'assets', 'app.js'), 'export {};');
    daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', join(workspace.home, '.kite-code')],
      systemHome: workspace.home,
      executableMode: 'source',
      sourceWebStaticRoot,
    });
    await daemon.start(workspace.workspace);
  });

  afterEach(async () => {
    await cleanupTuiSystemFixtures({
      tuis: tui ? [tui] : [],
      servers: [daemon],
      mockServers: [server],
      workspaces: [workspace],
    });
  });

  test('connects only when selected and disconnect does not stop the daemon', async () => {
    server.setResponses([{ message: { content: 'DAEMON_TUI_DONE' } }]);
    const endpoint =
      daemon.endpoint.kind === 'unix' ? daemon.endpoint.socket : daemon.endpoint.pipeName;
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      args: ['--server', endpoint],
    });
    await submitUserMessage(tui, server, 'Use the explicit daemon', { timeout: 15_000 });
    await waitForText(() => tui!.viewport(), 'DAEMON_TUI_DONE', 20_000);
    await submitCommand(tui, '/status');
    await waitForText(() => tui!.viewport(), `传输: ${daemon.endpoint.kind}`, 10_000);
    expect(screenContains(tui.viewport(), 'Service PID')).toBe(false);

    await submitCommand(tui, '/exit');
    await tui.waitForExit();
    expect(await daemon.status()).toMatchObject({ state: 'ready' });
  }, 30_000);

  test('explicit stop cancels an active daemon turn and removes the endpoint', async () => {
    server.setResponses([{ message: { content: 'SHOULD_NOT_COMPLETE' }, delay: 10_000 }]);
    const endpoint =
      daemon.endpoint.kind === 'unix' ? daemon.endpoint.socket : daemon.endpoint.pipeName;
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      args: ['--server', endpoint],
    });
    await submitUserMessage(tui, server, 'Keep the daemon busy', { timeout: 15_000 });
    await waitForCondition(
      () => server.getRequestCount() === 1,
      'the daemon-owned model request to start',
      10_000,
    );

    expect(await stopTuiSystemServer(daemon)).toMatchObject({ state: 'absent' });
    expect(screenContains(tui.viewport(), 'SHOULD_NOT_COMPLETE')).toBe(false);
  }, 30_000);
});
