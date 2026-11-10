import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { openSqliteStore } from '../../../src/sqlite';

test('first Run read preserves original allocation order and restored origin in a readonly snapshot', async () => {
  const root = temporaryDirectory('kite-first-run-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///fixture',
      name: 'fixture',
    });
    await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'manual' });
    const emptyCursor = (await store.getMetadata()).lastChangeCursor;
    expect(await store.readFirstSessionRun(base)).toMatchObject({
      storeId: expectedStoreId,
      snapshotCursor: emptyCursor,
      run: null,
      session: { id: 's' },
    });
    expect((await store.getMetadata()).lastChangeCursor).toBe(emptyCursor);
    const owner = (await store.acquireSessionOwner('s', 'seed'))!;
    const original = [];
    for (const commandId of ['z-first', 'a-later']) {
      await store.acceptCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
      const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId,
        configuration: { modelId: commandId },
      });
      original.push(run);
      await store.finishRun({
        expectedStoreId,
        owner,
        runId: run.id,
        status: 'completed',
        requirements: [],
      });
    }
    await store.releaseSessionOwner(owner);
    const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    try {
      physical.run('UPDATE run SET started_at=?,origin_store_id=? WHERE id=?', [
        '999999',
        'restored-origin',
        original[0]!.id,
      ]);
      physical.run('UPDATE command SET origin_store_id=? WHERE id=?', [
        'restored-origin',
        'z-first',
      ]);
      physical.run('UPDATE run SET started_at=? WHERE id=?', ['1', original[1]!.id]);
    } finally {
      physical.close();
    }
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const saved = await store.readFirstSessionRun(base);
    expect(Object.keys(saved).sort()).toEqual(['run', 'session', 'snapshotCursor', 'storeId']);
    expect(saved).toMatchObject({
      storeId: expectedStoreId,
      snapshotCursor: cursor,
      run: {
        id: original[0]!.id,
        originCommandId: 'z-first',
        originStoreId: 'restored-origin',
        configuration: { modelId: 'z-first' },
      },
    });
    const wrongStore = await store
      .readFirstSessionRun({ ...base, expectedStoreId: 'foreign' })
      .catch((error) => error);
    expect(wrongStore.code).toBe('store_identity_mismatch');
    const missing = await store
      .readFirstSessionRun({ ...base, sessionId: 'absent' })
      .catch((error) => error);
    expect(missing.code).toBe('session_not_found');
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    await store.close();
    cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    expect(await cold.readFirstSessionRun(base)).toEqual(saved);
    expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await cold?.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
