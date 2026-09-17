import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireKiteSessionStoreMaintenance } from '../../../packages/runtime-storage-sqlite/src/kite-session-maintenance';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, spawnTui, waitForTuiReady } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedUserMessageSession } from '../harness/test-workspace';

const holderFixture = join(import.meta.dir, '../fixtures/session-store-maintenance-holder.ts');
const question = 'Question before maintenance wait';
const answer = 'History survived maintenance wait.';

async function existingHistory() {
  const workspace = createTestWorkspace();
  const server = createMockModelServer();
  const tuis: PtyProcess[] = [];
  server.setResponses([{ message: { content: answer } }]);
  try {
    const first = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
    tuis.push(first);
    await submitUserMessage(first, server, question);
    await waitForText(() => first.outputSinceLastAction(), answer, 15_000);
    let sessionId: string | undefined;
    await waitForCondition(
      () => {
        const observation = observePersistedUserMessageSession(workspace, question);
        if (observation.status !== 'ready' || !observation.value) return false;
        sessionId = observation.value.threadId;
        return true;
      },
      'original Session ID to persist',
      10_000,
    );
    if (!sessionId) throw new Error('The original Session ID was not persisted.');
    await submitCommand(first, '/exit');
    expect(await first.waitForExit()).toBe(0);

    const canonical = join(workspace.home, '.kite-code', 'kite-session.sqlite');
    const historical = join(
      workspace.home,
      '.kite-code',
      'source-profiles',
      '2'.repeat(32),
      'kite-session.sqlite',
    );
    mkdirSync(dirname(historical), { recursive: true, mode: 0o700 });
    chmodSync(join(workspace.home, '.kite-code', 'source-profiles'), 0o700);
    chmodSync(dirname(historical), 0o700);
    // The source is an exact SQLite snapshot of real TUI-authored rows. Keeping
    // canonical too exercises the supported equal-content schema-10 merge path.
    const source = new Database(canonical, { readonly: true });
    try {
      source.query('VACUUM main INTO ?').run(historical);
    } finally {
      source.close();
    }
    chmodSync(historical, 0o600);
    expect(existsSync(historical)).toBe(true);
    server.setResponses([]);
    return { workspace, server, tuis, canonical, sessionId };
  } catch (error) {
    await cleanupTuiSystemFixtures({ tuis, mockServers: [server], workspaces: [workspace] });
    throw error;
  }
}

function holdStore(canonical: string, readyPath: string) {
  return Bun.spawn([process.execPath, holderFixture, canonical, readyPath], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

async function waitForHolder(readyPath: string): Promise<void> {
  await waitForCondition(() => existsSync(readyPath), 'test-owned exclusive Store lock', 5_000);
}

async function releaseHolder(holder: ReturnType<typeof holdStore>): Promise<void> {
  holder.stdin.write('release\n');
  await holder.stdin.flush();
  expect(await holder.exited).toBe(0);
}

async function cleanupHolder(holder: ReturnType<typeof holdStore> | undefined): Promise<void> {
  if (!holder) return;
  if (holder.exitCode === null) holder.kill('SIGTERM');
  await holder.exited;
}

describe.skipIf(process.platform !== 'darwin')('TUI startup Store maintenance wait', () => {
  test('one TUI visibly waits for a different lock holder, then opens the original history without restarting', async () => {
    const fixture = await existingHistory();
    let holder: ReturnType<typeof holdStore> | undefined;
    try {
      const readyPath = join(fixture.workspace.home, 'holder-ready-1');
      holder = holdStore(fixture.canonical, readyPath);
      await waitForHolder(readyPath);
      const waiting = spawnTui({
        cols: 120,
        rows: 40,
        mockServer: fixture.server,
        workspace: fixture.workspace,
      });
      fixture.tuis.push(waiting);
      await waitForCondition(
        () =>
          screenContains(waiting.transcript(), '正在自动重试') &&
          screenContains(waiting.transcript(), '超时后请按提示重试'),
        'real TUI waiting_for_store progress',
        10_000,
      );
      expect(waiting.exited).toBe(false);
      await releaseHolder(holder);
      await waitForTuiReady(waiting, 'main', fixture.workspace);
      waiting.setRawMode(true);
      await submitCommand(waiting, '/resume');
      await waitForCondition(
        () => screenHasSessionRow(waiting.viewport(), question, { active: false }),
        'original Session listed after automatic maintenance retry',
        15_000,
      );
      waiting.write('\x1b[B');
      await waitForCondition(
        () => screenHasSessionRow(waiting.viewport(), question, { selected: true, active: false }),
        'original Session selected',
        5_000,
      );
      waiting.write('\r');
      await waitForCondition(
        () =>
          screenContains(waiting.viewport(), question) &&
          screenContains(waiting.viewport(), answer),
        'original conversation opened without a TUI restart',
        15_000,
      );
      const observed = observePersistedUserMessageSession(fixture.workspace, question);
      expect(observed.status).toBe('ready');
      if (observed.status === 'ready') expect(observed.value?.threadId).toBe(fixture.sessionId);
    } finally {
      await cleanupHolder(holder);
      await cleanupTuiSystemFixtures({
        tuis: fixture.tuis,
        mockServers: [fixture.server],
        workspaces: [fixture.workspace],
      });
    }
  }, 90_000);

  test('Ctrl+C during the wait exits only the TUI, leaving the independent lock holder and history intact', async () => {
    const fixture = await existingHistory();
    let holder: ReturnType<typeof holdStore> | undefined;
    try {
      const readyPath = join(fixture.workspace.home, 'holder-ready-2');
      holder = holdStore(fixture.canonical, readyPath);
      await waitForHolder(readyPath);
      const waiting = spawnTui({
        cols: 120,
        rows: 40,
        mockServer: fixture.server,
        workspace: fixture.workspace,
      });
      fixture.tuis.push(waiting);
      await waitForCondition(
        () => screenContains(waiting.transcript(), '正在自动重试'),
        'real TUI waiting_for_store progress before cancellation',
        10_000,
      );
      waiting.write('\x03');
      await waitForCondition(() => waiting.exited, 'waiting TUI to exit after Ctrl+C', 20_000);
      expect([0, 1]).toContain(await waiting.waitForExit());
      expect(holder.exitCode).toBeNull();
      expect(() => acquireKiteSessionStoreMaintenance(fixture.canonical, 'shared')).toThrow('busy');
      await releaseHolder(holder);
      const restarted = await spawnReadyTui({
        cols: 120,
        rows: 40,
        mockServer: fixture.server,
        workspace: fixture.workspace,
      });
      fixture.tuis.push(restarted);
      await submitCommand(restarted, '/resume');
      await waitForCondition(
        () => screenHasSessionRow(restarted.viewport(), question, { active: false }),
        'original Session still listed after a normal restart',
        15_000,
      );
      const observed = observePersistedUserMessageSession(fixture.workspace, question);
      expect(observed.status).toBe('ready');
      if (observed.status === 'ready') expect(observed.value?.threadId).toBe(fixture.sessionId);
    } finally {
      await cleanupHolder(holder);
      await cleanupTuiSystemFixtures({
        tuis: fixture.tuis,
        mockServers: [fixture.server],
        workspaces: [fixture.workspace],
      });
    }
  }, 90_000);
});
