import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '../../../src/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

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

test('a first-input session enters both directories only after its bound input is applied', () => {
  const db = new Database(':memory:');
  for (const migration of ['0001-baseline.sql', '0002-trajectory-facts.sql'])
    db.exec(
      readFileSync(
        new URL(`../../../src/storage/migrations/${migration}`, import.meta.url),
        'utf8',
      ),
    );
  db.run("INSERT INTO storage_meta(singleton,store_id,format_major) VALUES(1,'store',1)");
  db.run("INSERT INTO workspace(id,root_uri,name) VALUES('w','file:///owned','owned')");
  const operations = new SqliteOperations(db, false);
  const caller = { expectedStoreId: 'store', subjectId: 'user' };

  try {
    for (const id of ['ordinary', 'failed-first', 'successful-first']) {
      operations.call('createSession', [
        {
          ...caller,
          sessionId: id,
          commandId: `create-${id}`,
          workspaceId: 'w',
          title: '',
          ...(id === 'ordinary' ? {} : { firstInputCommandId: `input-${id}` }),
        },
      ]);
    }
    const expectDirectory = (expected: string[]) => {
      const sessions = operations.call('listSessions', []) as Awaited<
        ReturnType<Store['listSessions']>
      >;
      const directory = operations.call('listSessionDirectory', [caller]) as Awaited<
        ReturnType<Store['listSessionDirectory']>
      >;
      expect(sessions.map((session) => session.id).sort()).toEqual(expected);
      expect(directory.items.map((item) => item.session.id).sort()).toEqual(expected);
    };
    expectDirectory(['ordinary']);
    const session = operations.call('getSession', ['failed-first']) as Awaited<
      ReturnType<Store['getSession']>
    >;
    expect(session?.id).toBe('failed-first');
    const input = { kind: 'run.start', content: 'original request' } as const;
    expect(() =>
      operations.call('acceptCommand', [
        {
          ...caller,
          sessionId: 'failed-first',
          commandId: 'different-command',
          request: input,
        },
      ]),
    ).toThrow('session_not_found');
    for (const sessionId of ['failed-first', 'successful-first']) {
      operations.call('acceptCommand', [
        {
          ...caller,
          sessionId,
          commandId: `input-${sessionId}`,
          request: input,
        },
      ]);
    }
    expectDirectory(['ordinary']);
    db.run("UPDATE command SET status='rejected' WHERE id='input-failed-first'");
    expectDirectory(['ordinary']);
    db.run("UPDATE command SET status='applied' WHERE id='input-successful-first'");
    expectDirectory(['ordinary', 'successful-first']);
  } finally {
    operations.releaseStatements();
    db.close();
  }
});
