import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UnifiedExecution } from '../../../src/execution';
import { ExecutionResources } from '../../../src/execution/resources';
import { openSqliteStore } from '../../../src/sqlite';

for (const failure of ['execution.planned', 'execution.dispatching'])
  test(`${failure} commit failure rolls back intent/dispatch and causes zero adapter I/O`, async () => {
    const dataRoot = mkdtempSync('/private/tmp/kite-store-fault-');
    chmodSync(dataRoot, 0o700);
    const store = await openSqliteStore({ dataRoot, profile: 'test' });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: 'file:///disposable',
        name: 'w',
      });
      await store.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 's',
        subjectId: 'user',
      });
      await store.acceptCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'user',
        request: { kind: 'run.start', content: 'count' },
      });
      const owner = (await store.acquireSessionOwner('s', 'owner'))!;
      const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId: 'work',
        configuration: {},
      });
      const db = new Database(join(dataRoot, 'test', 'core.db'));
      db.exec(
        `CREATE TRIGGER fail_commit BEFORE INSERT ON change_event WHEN NEW.type='${failure}' BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END`,
      );
      let calls = 0;
      const execution = new UnifiedExecution({
        store,
        permissions: {
          async authorize() {
            return { allowed: true, revision: '0' };
          },
        },
        resources: new ExecutionResources(),
      });
      try {
        const result = await execution.tool(
          { run, owner, workspaceId: 'w', signal: new AbortController().signal },
          {
            id: 'count',
            version: '1',
            description: 'count',
            inputSchema: { type: 'object' },
            async execute() {
              calls++;
              return { outcome: 'succeeded', content: 'counted' };
            },
          },
          { id: 'call', name: 'count', arguments: '{}' },
          'step',
          'model',
        );
        expect(result.outcome).toBe('failed');
      } catch (error) {
        if (failure !== 'execution.planned') throw error;
      }
      expect(calls).toBe(0);
      expect(db.query('SELECT cursor FROM change_event WHERE type=?').all(failure)).toHaveLength(0);
      const rows = await store.listExecutions('s');
      expect(rows).toHaveLength(failure === 'execution.planned' ? 0 : 1);
      if (rows.length) expect(rows[0]!.status).toBe('failed');
      db.exec('DROP TRIGGER fail_commit');
      db.close();
    } finally {
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

test('accepted work prevents release; acceptance after release can be owned by another Service', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-store-handoff-');
  chmodSync(dataRoot, 0o700);
  const first = await openSqliteStore({ dataRoot, profile: 'test' });
  const second = await openSqliteStore({ dataRoot, profile: 'test' });
  try {
    const expectedStoreId = (await first.getMetadata()).storeId;
    await first.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///disposable',
      name: 'w',
    });
    await first.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 's',
      subjectId: 'user',
    });
    const owner = (await first.acquireSessionOwner('s', 'first'))!;
    // These awaits are commit barriers, proving both transaction orders without random sleeps.
    await second.acceptCommand({
      expectedStoreId,
      commandId: 'before',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'before release' },
    });
    expect(await first.releaseSessionOwner(owner)).toBe(false);
    expect(await second.acquireSessionOwner('s', 'second')).toBeNull();
    await first.rejectCommand({ expectedStoreId, owner, commandId: 'before', reason: 'fixture' });
    expect(await first.releaseSessionOwner(owner)).toBe(true);
    await second.acceptCommand({
      expectedStoreId,
      commandId: 'after',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'after release' },
    });
    const next = (await second.acquireSessionOwner('s', 'second'))!;
    expect(next.generation).toBe('2');
    expect((await second.listAcceptedCommands('s')).map((item) => item.id)).toEqual(['after']);
  } finally {
    await first.close();
    await second.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
