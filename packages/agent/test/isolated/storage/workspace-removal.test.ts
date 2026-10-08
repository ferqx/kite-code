import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-workspace-remove-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' },
    store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  for (const id of ['w', 'other'])
    await store.createWorkspace({
      expectedStoreId: storeId,
      id,
      rootUri: `file://${root}`,
      name: id,
    });
  for (const id of ['a', 'b', 'sibling'])
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'user',
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: id === 'sibling' ? 'other' : 'w',
      title: id,
    });
  return {
    root,
    profile,
    store,
    storeId,
    input: { expectedStoreId: storeId, subjectId: 'user', workspaceId: 'w', commandId: 'remove' },
  };
}
async function denied(work: Promise<unknown>, code: string) {
  expect(((await work.catch((e) => e)) as { code: string }).code).toBe(code);
}
test('one real transaction removes all roots, shares the original receipt across Workers and closes late admission without deleting project files', async () => {
  const f = await fixture(),
    peer = await openSqliteStore(f.profile);
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    writeFileSync(join(f.root, 'user-file'), 'keep me');
    await denied(
      f.store.removeWorkspace({ ...f.input, subjectId: 'foreign' }),
      'permission_denied',
    );
    await denied(
      f.store.removeWorkspace({ ...f.input, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await denied(
      f.store.removeWorkspace({ ...f.input, commandId: 'create-a' }),
      'command_conflict',
    );
    // The Workspace batch is independent of exhausted root CAS/old recovery labels.
    physical.run("UPDATE session SET control_revision=9223372036854775807 WHERE id='a'");
    const results = await Promise.all([
      f.store.removeWorkspace(f.input),
      peer.removeWorkspace(f.input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      commandId: 'remove',
      workspaceId: 'w',
      originStoreId: f.storeId,
      subjectId: 'user',
      deletedRoots: 2,
      deletedSessions: 2,
      outcome: 'workspace_removed',
      stopConfirmed: false,
    });
    const water = (await f.store.getMetadata()).lastChangeCursor;
    expect(await peer.getWorkspaceRemoval(f.input)).toEqual(results[0]);
    expect(await f.store.getWorkspace('w')).toBeNull();
    expect((await f.store.listWorkspaces()).map((w) => w.id)).toEqual(['other']);
    expect(
      (await f.store.listWorkspaceDirectory({ expectedStoreId: f.storeId })).items.map(
        (i) => i.workspace.id,
      ),
    ).toEqual(['other']);
    expect((await f.store.listSessions()).map((s) => s.id)).toEqual(['sibling']);
    expect(
      (
        await f.store.listSessionDirectory({ expectedStoreId: f.storeId, subjectId: 'user' })
      ).items.map((i) => i.session.id),
    ).toEqual(['sibling']);
    expect((await f.store.getSession('a'))!.deletedAt).toBeGreaterThan(0);
    expect((await f.store.getSession('sibling'))!.deletedAt).toBeNull();
    await denied(
      peer.createSession({
        expectedStoreId: f.storeId,
        subjectId: 'user',
        workspaceId: 'w',
        sessionId: 'late',
        commandId: 'late-create',
        title: 'late',
      }),
      'workspace_removed',
    );
    await denied(
      peer.acceptCommand({
        expectedStoreId: f.storeId,
        subjectId: 'user',
        sessionId: 'a',
        commandId: 'late-run',
        request: { kind: 'run.start', content: 'no' },
      }),
      'session_not_found',
    );
    await denied(peer.removeWorkspace({ ...f.input, commandId: 'changed' }), 'workspace_removed');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    expect(readFileSync(join(f.root, 'user-file'), 'utf8')).toBe('keep me');
    await f.store.createWorkspace({
      expectedStoreId: f.storeId,
      id: 'fresh',
      rootUri: `file://${f.root}`,
      name: 'same directory',
    });
    expect((await f.store.getWorkspace('fresh'))!.rootUri).toBe(`file://${f.root}`);
    expect(await peer.getWorkspaceRemoval(f.input)).toEqual(results[0]);
  } finally {
    physical.close();
    await peer.close();
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('a real SQL commit fault rolls back Workspace marker, root tombstones and cancellation as one unit', async () => {
  const f = await fixture(),
    db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    const water = (await f.store.getMetadata()).lastChangeCursor;
    db.run(
      "CREATE TRIGGER fail_remove BEFORE INSERT ON change_event WHEN NEW.type='workspace.removed' BEGIN SELECT RAISE(ABORT,'remove rollback'); END",
    );
    await denied(f.store.removeWorkspace(f.input), 'SQLITE_CONSTRAINT_TRIGGER');
    expect(await f.store.getWorkspaceRemoval(f.input)).toBeNull();
    expect((await f.store.getWorkspace('w'))!.id).toBe('w');
    expect((await f.store.listSessions()).length).toBe(3);
    expect((await f.store.getSession('a'))!.deletedAt).toBeNull();
    expect((await f.store.getSession('a'))!.controlRevision).toBe('0');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    db.run('DROP TRIGGER fail_remove');
    const receipt = await f.store.removeWorkspace(f.input);
    expect(receipt.deletedSessions).toBe(2);
  } finally {
    db.close();
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
