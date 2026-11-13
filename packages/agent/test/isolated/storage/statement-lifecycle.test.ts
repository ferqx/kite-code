import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { openSqliteStore } from '../../../src/sqlite';
import { fixtureWorkerEntry, NativeWorker, useFixtureWorker } from '../../fixtures/owned-worker';

test('real Worker finalizes native SQLite statements before success/error ACK and remains usable', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-statement-lifecycle-')));
  const dataRoot = join(directory, 'data');

  const audits: { observed: number; finalized: boolean; failed: boolean }[] = [];
  class AuditedWorker extends NativeWorker {
    constructor(...args: ConstructorParameters<typeof NativeWorker>) {
      super(...fixtureWorkerEntry(args, new URL('./statement-worker-fixture.ts', import.meta.url)));
      this.on('message', (data) => {
        const response = data as {
          error?: unknown;
          statementScope?: { observed: number; finalized: boolean };
        };
        if (response.statementScope)
          audits.push({ ...response.statementScope, failed: !!response.error });
      });
    }
  }
  useFixtureWorker(AuditedWorker);
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    store = await openSqliteStore({ dataRoot, profile: 'owned' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///owned', name: 'w' });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'native statement lifecycle',
      subjectId: 'owned',
    });
    const initial = await store.getView('s');
    for (let i = 0; i < 32; i++) {
      expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
      expect((await store.getView('s')).snapshotCursor).toBe(initial.snapshotCursor);
    }
    let rejected: unknown;
    try {
      await store.getView('absent');
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: 'session_not_found' });
    expect((await store.getView('s')).snapshotCursor).toBe(initial.snapshotCursor);
    await store.close();
    store = await openSqliteStore({ dataRoot, profile: 'owned', mode: 'readonly' });
    expect((await store.getView('s')).session.id).toBe('s');
    expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
    await store.close();
    store = undefined;
    expect(audits.length).toBeGreaterThan(64);
    expect(audits.every((audit) => audit.finalized)).toBe(true);
    expect(audits.filter((audit) => audit.observed > 0).length).toBeGreaterThan(64);
    expect(audits.some((audit) => audit.failed && audit.observed > 0)).toBe(true);
  } finally {
    useFixtureWorker();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
