import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildOriginalDaemonCandidate,
  createOriginalDaemonHost,
  releaseOriginalDaemonFixture,
} from '../fixtures/original-daemon-host';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — explicit App Server daemon', () => {
  let tui: PtyProcess | undefined;
  let second: PtyProcess | undefined;
  let candidate: Awaited<ReturnType<typeof buildOriginalDaemonCandidate>>;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let daemon: ReturnType<typeof createOriginalDaemonHost>;
  beforeEach(async () => {
    candidate = await buildOriginalDaemonCandidate();
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        provider: { mock: { baseURL: server.baseURL } },
        model: { default: { provider: 'mock', name: 'mock-model' } },
      },
    });
    tui = undefined;
    second = undefined;
    daemon = createOriginalDaemonHost({
      candidate: candidate.selected,
      endpointRoot: candidate.root,
      home: workspace.home,
      workspace: workspace.workspace,
    });
    await daemon.start();
    const authenticated = await daemon.verifyAuthentication();
    expect(authenticated.profile).toEqual(daemon.profile);
    expect(authenticated.buildId).toBe(candidate.selected.buildId);
    expect(authenticated.apiMajor).toBe(1);
  }, 70_000);

  afterEach(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui, second],
      servers: [daemon],
      mockServers: [server],
    });
    // Only remove the isolated Profile after the public stop proved all own births dead.
    releaseOriginalDaemonFixture({ candidate, daemon, workspace });
  });

  test('connects only when selected and disconnect does not stop the daemon', async () => {
    server.setResponses([{ message: { content: 'DAEMON_TUI_DONE' } }]);
    const endpoint = daemon.endpoint.socket;
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      args: ['--server', endpoint],
    });
    await submitUserMessage(tui, server, 'Use the explicit daemon', { timeout: 15_000 });
    await waitForText(() => tui!.viewport(), 'DAEMON_TUI_DONE', 20_000);
    const observer = await daemon.connect();
    let sessionId: string | undefined;
    let sessionTitle: string | undefined;
    try {
      for (const session of await observer.client.listAllSessions()) {
        const view = await observer.client.getView(session.id);
        if (
          view.messages.some(
            (message) => message.role === 'user' && message.content === 'Use the explicit daemon',
          )
        ) {
          sessionId = session.id;
          sessionTitle = session.title;
        }
      }
      expect(sessionId).toBeDefined();
      expect(observer.info.profile).toEqual(daemon.profile);
    } finally {
      observer.close();
    }
    const original = await daemon.bootstrap();
    await submitCommand(tui, '/status');
    await waitForText(() => tui!.viewport(), `传输: ${daemon.endpoint.kind}`, 10_000);
    await waitForText(() => tui!.viewport(), original.instanceId, 5_000);
    expect(screenContains(tui.viewport(), 'Service PID')).toBe(false);
    expect(screenContains(tui.viewport(), original.instanceId)).toBe(true);

    second = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      args: ['--server', endpoint],
    });
    await submitCommand(second, '/resume');
    await waitForCondition(
      () => screenHasSessionRow(second!.viewport(), sessionTitle!, { active: false }),
      'second shared TUI to find the exact daemon Session',
      5_000,
    );
    if (!screenHasSessionRow(second.viewport(), sessionTitle!, { selected: true, active: false })) {
      const rows = stripAnsi(second.viewport()).split('\n');
      const target = rows.findIndex((row) =>
        screenHasSessionRow(`会话列表\n${row}`, sessionTitle!, { active: false }),
      );
      const selected = rows.findIndex((row) => /^\s*[>❯◌⏳]\s/u.test(row));
      expect(target).toBeGreaterThanOrEqual(0);
      expect(selected).toBeGreaterThanOrEqual(0);
      second.write(target < selected ? '\x1b[A' : '\x1b[B');
    }
    await waitForCondition(
      () =>
        screenHasSessionRow(second!.viewport(), sessionTitle!, {
          selected: true,
          active: false,
        }),
      'exact original daemon Session to be selected',
      5_000,
    );
    second.write('\r');
    await waitForText(() => second!.viewport(), 'DAEMON_TUI_DONE', 5_000);
    await submitCommand(second, '/status');
    await waitForText(() => second!.viewport(), original.instanceId, 5_000);
    expect(screenContains(second.viewport(), sessionId!)).toBe(true);
    expect(screenContains(second.viewport(), `传输: ${daemon.endpoint.kind}`)).toBe(true);
    expect(server.getWorkRequestCount()).toBe(1);
    second.write('\x1b');
    await waitForCondition(
      () => second!.focusedMainInputReady(),
      'status closes back to the original main input',
      5_000,
    );
    await submitCommand(second, '/exit');
    expect(await second.waitForExit()).toBe(0);
    expect(await daemon.status()).toMatchObject({
      state: 'accepting',
      instanceId: original.instanceId,
    });

    tui.write('\x1b');
    await waitForCondition(
      () => tui!.focusedMainInputReady(),
      'status closes back to the original main input',
      5_000,
    );
    await submitCommand(tui, '/exit');
    expect(await tui.waitForExit()).toBe(0);
    expect(await daemon.status()).toMatchObject({ state: 'accepting' });
  }, 30_000);

  test('restart refuses an active turn unless cancellation is explicit', async () => {
    server.setResponses([{ message: { content: 'SHOULD_NOT_COMPLETE' }, delay: 10_000 }]);
    const endpoint = daemon.endpoint.socket;
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      args: ['--server', endpoint],
    });
    await submitUserMessage(tui, server, 'Keep the daemon busy', { timeout: 15_000 });
    await waitForCondition(
      () => server.getWorkRequestCount() === 1,
      'the daemon-owned model request to start',
      10_000,
    );

    const before = await daemon.status();
    await expect(daemon.restart()).rejects.toThrow('busy');
    expect(await daemon.status()).toMatchObject({
      state: 'accepting',
      instanceId: before!.instanceId,
    });
    const restarted = await daemon.restart(true);
    expect(restarted!.state).toBe('accepting');
    expect(restarted!.instanceId).not.toBe(before!.instanceId);
    expect(screenContains(tui.viewport(), 'SHOULD_NOT_COMPLETE')).toBe(false);
  }, 30_000);
});
