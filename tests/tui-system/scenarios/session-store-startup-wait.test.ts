import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import {
  awaitPreInkTuiReady,
  type PtyProcess,
  spawnPreInkTui,
  spawnReadyTui,
} from '../harness/pty-process';
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
    await waitForText(() => first.viewport(), answer, 15_000);
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

    const canonical = workspace.databasePath;
    // Actual selected Core/Profile data, authored by the first real TUI. D08
    // excludes foreign historical source conversion from this waiting journey.
    expect(existsSync(canonical)).toBe(true);
    server.setResponses([]);
    return { workspace, server, tuis, canonical, sessionId };
  } catch (error) {
    await cleanupTuiSystemFixtures({ tuis, mockServers: [server], workspaces: [workspace] });
    throw error;
  }
}

function holdStore(workspace: ReturnType<typeof createTestWorkspace>, readyPath: string) {
  return Bun.spawn(
    [process.execPath, holderFixture, workspace.dataRoot, workspace.profile, readyPath],
    {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
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

describe('TUI startup Store maintenance wait', () => {
  test('one TUI visibly waits for a different lock holder, then opens the original history without restarting', async () => {
    const fixture = await existingHistory();
    let holder: ReturnType<typeof holdStore> | undefined;
    try {
      const readyPath = join(fixture.workspace.home, 'holder-ready-1');
      holder = holdStore(fixture.workspace, readyPath);
      await waitForHolder(readyPath);
      const waiting = await spawnPreInkTui(
        {
          cols: 120,
          rows: 40,
          mockServer: fixture.server,
          workspace: fixture.workspace,
        },
        'waiting_for_store',
        10_000,
      );
      fixture.tuis.push(waiting);
      expect(waiting.exited).toBe(false);
      await releaseHolder(holder);
      await awaitPreInkTuiReady(waiting, fixture.workspace);
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
      holder = holdStore(fixture.workspace, readyPath);
      await waitForHolder(readyPath);
      const waiting = await spawnPreInkTui(
        {
          cols: 120,
          rows: 40,
          mockServer: fixture.server,
          workspace: fixture.workspace,
        },
        'waiting_for_store_start',
        10_000,
      );
      fixture.tuis.push(waiting);
      waiting.write('\x03');
      await waitForCondition(() => waiting.exited, 'waiting TUI to exit after Ctrl+C', 20_000);
      expect([0, 1]).toContain(await waiting.waitForExit());
      expect(holder.exitCode).toBeNull();
      expect(() =>
        acquireProfileAccess({
          dataRoot: fixture.workspace.dataRoot,
          profile: fixture.workspace.profile,
        }),
      ).toThrow('busy');
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
