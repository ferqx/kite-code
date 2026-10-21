import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '../../../src/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

/** Store.close releases the actual owner flock without settling the durable Run. */
test('readonly directory observes original owner lock loss without settling or acquiring work, and preserves another live root', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-directory-owner-')));
  const options = { dataRoot: join(root, 'data'), profile: 'test' };
  const stores: Store[] = [];
  const open = async (mode: 'readwrite' | 'readonly' = 'readwrite') => {
    const store = await openSqliteStore({ ...options, mode });
    stores.push(store);
    return store;
  };
  try {
    const first = await open();
    const expectedStoreId = (await first.getMetadata()).storeId;
    await first.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'owner observation fixture',
    });
    const second = await open();
    const start = async (store: Store, sessionId: string) => {
      await store.createSession({
        expectedStoreId,
        sessionId,
        commandId: `create-${sessionId}`,
        workspaceId: 'w',
        subjectId: 'user',
        title: sessionId,
      });
      const commandId = `run-${sessionId}`;
      await store.acceptCommand({
        expectedStoreId,
        sessionId,
        commandId,
        subjectId: 'user',
        request: { kind: 'run.start', content: 'Keep this original work active.' },
      });
      const owner = (await store.acquireSessionOwner(sessionId, `host-${sessionId}`))!;
      const run = await store.startRun({ expectedStoreId, owner, commandId, configuration: {} });
      await store.planExecution({
        expectedStoreId,
        owner,
        executionId: `tool-${sessionId}`,
        sessionId,
        runId: run.id,
        originCommandId: commandId,
        stepId: 'step',
        callId: 'call',
        kind: 'tool',
        definitionId: 'task.events',
        definitionVersion: '1',
        input: {},
        decisionSource: { fixture: 'original waiting tool' },
      });
      return run;
    };
    const firstRun = await start(first, 'lost');
    const secondRun = await start(second, 'live');
    const observer = await open('readonly');
    const query = { expectedStoreId, subjectId: 'user' };
    const snapshot = async (reader: Store) => ({
      metadata: await reader.getMetadata(),
      lostSession: await reader.getSession('lost'),
      liveSession: await reader.getSession('live'),
      lostRun: await reader.getRun(firstRun.id),
      liveRun: await reader.getRun(secondRun.id),
      lostTool: await reader.getExecution('tool-lost'),
      liveTool: await reader.getExecution('tool-live'),
      lostCommand: await reader.getCommand('run-lost'),
      liveCommand: await reader.getCommand('run-live'),
    });
    const before = await snapshot(observer);
    expect(before.lostRun?.isActive).toBe(true);
    expect(before.liveRun?.isActive).toBe(true);
    const held = await observer.listSessionDirectory(query);
    expect(held.items.find((item) => item.session.id === 'lost')?.activity?.executionOwner).toBe(
      'held',
    );
    expect(held.items.find((item) => item.session.id === 'live')?.activity?.executionOwner).toBe(
      'held',
    );
    expect(await snapshot(observer)).toEqual(before);

    // Drop only the first Store's real OS ownership; do not cancel or rewrite its history.
    await first.close();
    await observer.close();
    const cold = await open('readonly');
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await cold.listSessionDirectory(query);
      const lost = page.items.find((item) => item.session.id === 'lost')!;
      const live = page.items.find((item) => item.session.id === 'live')!;
      expect(lost.activity?.executionOwner).toBe('unheld');
      expect(live.activity?.executionOwner).toBe('held');
      expect(lost.activity?.run?.isActive).toBe(true);
      expect(live.activity?.run?.isActive).toBe(true);
      expect(page.snapshotCursor).toBe(before.metadata.lastChangeCursor);
      // Exact owner generation, original commands and nonterminal facts remain unchanged.
      expect(await snapshot(cold)).toEqual(before);
    }
    const missing = join(selectProfile(options).coordinationPath, 'session-lost.lock');
    rmSync(missing);
    const unverifiable = await cold.listSessionDirectory(query);
    expect(
      unverifiable.items.find((item) => item.session.id === 'lost')?.activity.executionOwner,
    ).toBe('unknown');
    expect(
      unverifiable.items.find((item) => item.session.id === 'live')?.activity.executionOwner,
    ).toBe('held');
    expect(existsSync(missing)).toBe(false);
    expect(await snapshot(cold)).toEqual(before);
  } finally {
    for (const store of stores.reverse()) await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
