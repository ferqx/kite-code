import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage';

async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-host-controls-');
  chmodSync(root, 0o700);
  const profile = { dataRoot: root, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const db = new Database(join(root, 'new/core.db'));
  const base = { expectedStoreId, subjectId: 'user' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///temporary',
    name: 'w',
  });
  await store.createSession({
    ...base,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create-s',
    title: 's',
  });
  await store.createSession({
    ...base,
    sessionId: 'other',
    workspaceId: 'w',
    commandId: 'create-other',
    title: 'other',
  });
  const mode = async (
    commandId: string,
    value: {
      mode: string;
      ifRevision?: string;
      makeDefault?: boolean;
      ifDefaultRevision?: string;
      sessionId?: string;
    },
  ) => {
    const sessionId = value.sessionId ?? 's';
    const safeRequest = {
      scope: 'session',
      sessionId,
      mode: value.mode,
      ifRevision: value.ifRevision ?? '0',
      makeDefault: value.makeDefault ?? false,
      ifDefaultRevision: value.ifDefaultRevision ?? '0',
    };
    return {
      ...base,
      commandId,
      kind: 'permission.mode' as const,
      scope: `session:${sessionId}`,
      safeRequest,
      requestDigest: await semanticDigest(safeRequest),
    };
  };
  const trust = async (commandId: string, trusted: boolean, ifRevision = '0') => {
    const safeRequest = {
      scope: 'workspace',
      workspaceId: 'w',
      trusted,
      ifRevision,
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
    };
    return {
      ...base,
      commandId,
      kind: 'workspace.trust' as const,
      scope: 'workspace:w',
      safeRequest,
      requestDigest: await semanticDigest(safeRequest),
    };
  };
  const finish = (input: Parameters<Store['beginHostMutation']>[0], target: Store = store) =>
    target.finishHostMutation({
      ...base,
      commandId: input.commandId,
      requestDigest: input.requestDigest,
      state: 'applied',
      receipt: { status: 'applied' },
    });
  const read = (
    kind: 'permission.mode' | 'workspace.trust',
    scope: string,
    target: Store = store,
  ) => target.readHostControl({ ...base, kind, scope });
  return {
    profile,
    root,
    store,
    db,
    base,
    mode,
    trust,
    finish,
    read,
    async close() {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('two Workers commit only one observed mode/default revision; pending has no live authority and exact receipts stay immutable', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    expect(await f.read('permission.mode', 'session:s')).toEqual({ revision: '0', record: null });
    const a = await f.mode('mode-a', { mode: 'ask', makeDefault: true });
    const b = await f.mode('mode-b', { mode: 'full', makeDefault: true });
    await Promise.all([f.store.beginHostMutation(a), peer.beginHostMutation(b)]);
    expect(await f.read('permission.mode', 'session:s')).toEqual({ revision: '0', record: null });
    expect(await f.read('permission.mode', 'user')).toEqual({ revision: '0', record: null });
    const first = await f.finish(b, peer);
    const current = await f.read('permission.mode', 'session:s');
    expect(current.record).toEqual(first);
    expect(first.receipt).toEqual({
      status: 'applied',
      mode: 'full',
      revision: current.revision,
      makeDefault: true,
      defaultRevision: current.revision,
    });
    expect((await f.read('permission.mode', 'user')).record).toEqual(first);
    await rejected(f.finish(a), 'host_control_conflict');
    expect((await f.store.getHostMutation({ ...f.base, commandId: a.commandId }))?.state).toBe(
      'pending',
    );
    expect((await f.store.beginHostMutation(b)).record).toEqual(first);
    const changed = await f.mode('mode-changed', {
      mode: 'accept_edits',
      ifRevision: current.revision,
    });
    await f.store.beginHostMutation(changed);
    await f.finish(changed);
    expect((await f.read('permission.mode', 'session:s')).record?.safeRequest).toMatchObject({
      mode: 'accept_edits',
    });
    expect(await f.finish(b, peer)).toEqual(first);
    const staleDefault = await f.mode('other-default', {
      mode: 'auto',
      sessionId: 'other',
      makeDefault: true,
    });
    await rejected(f.store.beginHostMutation(staleDefault), 'host_control_conflict');
    expect((await f.read('permission.mode', 'session:other')).record).toBeNull();
    expect((await f.read('permission.mode', 'user')).record).toEqual(first);
    const { events } = await f.store.getChanges({ after: '0', limit: 100 });
    expect(events.filter((event) => event.type === 'host_control.changed')).toHaveLength(2);
  } finally {
    await peer.close();
    await f.close();
  }
});

test('control scope, original Store and closed metadata reject forgeries; trust terminal fault never publishes authority', async () => {
  const f = await fixture();
  try {
    await rejected(
      f.store.readHostControl({
        ...f.base,
        kind: 'permission.mode',
        scope: 'session:s',
        subjectId: 'intruder',
      }),
      'host_control_scope_denied',
    );
    await rejected(
      f.store.readHostControl({
        ...f.base,
        kind: 'permission.mode',
        scope: 'session:s',
        expectedStoreId: 'foreign',
      }),
      'store_identity_mismatch',
    );
    const mode = await f.mode('bad-mode', { mode: 'full' });
    await rejected(
      f.store.beginHostMutation({ ...mode, subjectId: 'intruder' }),
      'host_control_scope_denied',
    );
    await rejected(
      f.store.beginHostMutation({
        ...mode,
        safeRequest: { ...mode.safeRequest, source: 'system' },
      }),
      'invalid_host_mutation',
    );
    await rejected(
      f.store.beginHostMutation({
        ...mode,
        safeRequest: { ...mode.safeRequest, ifRevision: '90071992547409920x' },
      }),
      'invalid_host_mutation',
    );
    const trust = await f.trust('trust', true);
    await f.store.beginHostMutation(trust);
    await rejected(
      f.store.finishHostMutation({
        ...f.base,
        commandId: trust.commandId,
        requestDigest: trust.requestDigest,
        state: 'applied',
        receipt: { status: 'applied', trusted: true },
      }),
      'invalid_host_mutation',
    );
    expect(await f.read('workspace.trust', 'workspace:w')).toEqual({ revision: '0', record: null });
    f.db.run(
      "CREATE TRIGGER control_fault BEFORE UPDATE ON host_mutation BEGIN SELECT RAISE(ABORT,'control fault'); END",
    );
    let failed = false;
    try {
      await f.finish(trust);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(await f.read('workspace.trust', 'workspace:w')).toEqual({ revision: '0', record: null });
    expect((await f.store.getHostMutation({ ...f.base, commandId: trust.commandId }))?.state).toBe(
      'pending',
    );
    expect(
      (await f.store.getChanges({ after: '0', limit: 100 })).events.filter(
        (event) => event.type === 'host_control.changed',
      ),
    ).toHaveLength(0);
    f.db.run('DROP TRIGGER control_fault');
    const applied = await f.finish(trust);
    expect(applied.receipt).toMatchObject({
      status: 'applied',
      trusted: true,
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
    });
    const revoke = await f.trust(
      'revoke',
      false,
      (await f.read('workspace.trust', 'workspace:w')).revision,
    );
    await f.store.beginHostMutation(revoke);
    await f.finish(revoke);
    expect((await f.read('workspace.trust', 'workspace:w')).record?.receipt).toMatchObject({
      trusted: false,
    });
    expect(
      (await f.store.getChanges({ after: '0', limit: 100 })).events.filter(
        (event) => event.type === 'host_control.changed',
      ),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('cold readonly control facts preserve exact revisions; restored Store never inherits old live mode/trust/default facts', async () => {
  const f = await fixture();
  let reader: Store | undefined;
  try {
    const mode = await f.mode('full-default', { mode: 'full', makeDefault: true });
    await f.store.beginHostMutation(mode);
    await f.finish(mode);
    const trust = await f.trust('trusted', true);
    await f.store.beginHostMutation(trust);
    await f.finish(trust);
    const original = await f.read('permission.mode', 'session:s');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.close();
    reader = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    expect(await f.read('permission.mode', 'session:s', reader)).toEqual(original);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
    await rejected(reader.beginHostMutation(mode), 'read_only');
    const restoredId = 'restored-current-store';
    f.db.run('UPDATE storage_meta SET store_id=?', [restoredId]);
    for (const [kind, scope] of [
      ['permission.mode', 'session:s'],
      ['permission.mode', 'user'],
      ['workspace.trust', 'workspace:w'],
    ] as const)
      expect(
        await reader.readHostControl({ ...f.base, expectedStoreId: restoredId, kind, scope }),
      ).toEqual({ revision: '0', record: null });
    await rejected(
      reader.getHostMutation({ ...f.base, expectedStoreId: restoredId, commandId: mode.commandId }),
      'host_mutation_scope_denied',
    );
    expect(f.db.query('SELECT count(*) AS count FROM execution').get()).toEqual({ count: 0 });
  } finally {
    await reader?.close();
    await f.close();
  }
});
