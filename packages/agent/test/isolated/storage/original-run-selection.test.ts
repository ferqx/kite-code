import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-original-selection-');
  chmodSync(root, 0o700);
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: `file://${root}`, name: 'w' });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
  async function run(sessionId: string, commandId: string) {
    await store.acceptCommand({
      ...base,
      sessionId,
      commandId,
      request: { kind: 'run.start', content: commandId },
    });
    const owner = (await store.acquireSessionOwner(sessionId, 'host'))!;
    const result = await store.startRun({ expectedStoreId, owner, commandId, configuration: {} });
    await store.finishRun({
      expectedStoreId,
      owner,
      runId: result.id,
      status: 'completed',
      requirements: [],
    });
    await store.releaseSessionOwner(owner);
    return result;
  }
  const first = await run('s', 'work');
  const db = new Database(join(root, 'test', 'core.db'));
  return {
    root,
    store,
    base,
    first,
    db,
    run,
    async close() {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function denied(p: Promise<unknown>, code = 'original_run_selection_unverifiable') {
  const error = await p.catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
}

test('original implicit Run selection survives all-retained select without writes', async () => {
  const f = await fixture();
  try {
    const before = await f.store.readOriginalRunSelection({ ...f.base, runId: f.first.id });
    const message = (await f.store.listMessages('s')).at(-1)!;
    await f.store.selectContext({
      ...f.base,
      commandId: 'select',
      expectedContextSelectionId: before.selection.id,
      boundary: { messageId: message.id, seq: message.seq },
    });
    const second = await f.run('s', 'next');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const original = await f.store.readOriginalRunSelection({ ...f.base, runId: f.first.id });
    expect(original.selection).toEqual(before.selection);
    expect(BigInt(original.highWaterSeq)).toBeGreaterThan(BigInt(before.highWaterSeq));
    expect(
      (await f.store.readOriginalRunSelection({ ...f.base, runId: second.id })).selection.id,
    ).not.toBe(before.selection.id);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await denied(
      f.store.readOriginalRunSelection({ ...f.base, subjectId: 'other', runId: f.first.id }),
      'context_scope_denied',
    );
    await denied(f.store.readOriginalRunSelection({ ...f.base, runId: 'missing' }));
    await denied(
      f.store.readOriginalRunSelection({ ...f.base, sessionId: 'other', runId: f.first.id }),
      'session_not_found',
    );
  } finally {
    await f.close();
  }
});

test('Fork initial selection is mandatory and keeps exact original producer', async () => {
  const f = await fixture();
  try {
    const initial = (await f.store.getSession('s'))!.contextSelectionId;
    const fork = await f.store.forkSession({
      ...f.base,
      commandId: 'fork',
      sourceSessionId: 's',
      newSessionId: 'forked',
      title: 'forked',
      expectedContextSelectionId: initial,
    });
    const run = await f.run('forked', 'fork-work');
    const input = { ...f.base, sessionId: 'forked', runId: run.id };
    expect((await f.store.readOriginalRunSelection(input)).selection).toEqual(fork.selection);
    f.db.run('DELETE FROM context_snapshot WHERE id=?', [fork.selection.id]);
    await denied(f.store.readOriginalRunSelection(input));
  } finally {
    await f.close();
  }
});

test('selection snapshot missing, malformed, future and mismatched producer reject', async () => {
  const f = await fixture();
  try {
    const id = (await f.store.getSession('s'))!.contextSelectionId;
    const message = (await f.store.listMessages('s')).at(-1)!;
    const selected = await f.store.selectContext({
      ...f.base,
      commandId: 'select',
      expectedContextSelectionId: id,
      boundary: { messageId: message.id, seq: message.seq },
    });
    const run = await f.run('s', 'later');
    const input = { ...f.base, runId: run.id };
    const row = f.db
      .query('SELECT request_json FROM context_snapshot WHERE id=?')
      .get(selected.selection.id) as { request_json: string };
    for (const change of [
      { tailFromSeq: '9223372036854775807' },
      { sessionId: 'foreign' },
      { unexpected: true },
    ]) {
      f.db.run('UPDATE context_snapshot SET request_json=? WHERE id=?', [
        JSON.stringify({ ...selected.selection, ...change }),
        selected.selection.id,
      ]);
      await denied(f.store.readOriginalRunSelection(input));
    }
    f.db.run('UPDATE context_snapshot SET request_json=? WHERE id=?', [
      row.request_json,
      selected.selection.id,
    ]);
    f.db.run("UPDATE context_snapshot SET session_id='foreign' WHERE id=?", [
      selected.selection.id,
    ]);
    await denied(f.store.readOriginalRunSelection(input));
    f.db.run("UPDATE context_snapshot SET session_id='s' WHERE id=?", [selected.selection.id]);
    const producer = f.db.query("SELECT seq FROM command WHERE id='select'").get() as {
      seq: number;
    };
    f.db.run("UPDATE command SET seq=999999 WHERE id='select'");
    await denied(f.store.readOriginalRunSelection(input));
    f.db.run("UPDATE command SET seq=? WHERE id='select'", [producer.seq]);
    f.db.run("UPDATE context_snapshot SET kind='result_ref' WHERE id=?", [selected.selection.id]);
    await denied(f.store.readOriginalRunSelection(input));
    f.db.run("UPDATE context_snapshot SET kind='selection' WHERE id=?", [selected.selection.id]);
    f.db.run("UPDATE command SET receipt_json='{}' WHERE id='select'");
    await denied(f.store.readOriginalRunSelection(input));
  } finally {
    await f.close();
  }
});

test('real offline A to B restore observes original selection in current Store readonly', async () => {
  const f = await fixture();
  const original = await f.store.readOriginalRunSelection({ ...f.base, runId: f.first.id });
  f.db.close();
  await f.store.close();
  const profile = { dataRoot: f.root, profile: 'test' };
  try {
    const backup = await createProfileBackup({ profile, destinationRoot: join(f.root, 'backup') });
    const restored = await restoreProfileBackup({
      profile,
      expectedStoreId: f.base.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.base.expectedStoreId);
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const cursor = (await cold.getMetadata()).lastChangeCursor;
      expect(
        await cold.readOriginalRunSelection({
          ...f.base,
          expectedStoreId: restored.storeId,
          runId: f.first.id,
        }),
      ).toEqual(original);
      expect((await cold.getRun(f.first.id))!.originStoreId).toBe(f.base.expectedStoreId);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      await denied(
        cold.readOriginalRunSelection({ ...f.base, runId: f.first.id }),
        'store_identity_mismatch',
      );
    } finally {
      await cold.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
