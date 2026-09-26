import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKiteHomeDirectoryQuery } from '../src/kite-home-directory';
import { createKiteHomeRuntimeStorageForConnection } from '../src/kite-home-runtime-storage';
import {
  assertKiteSessionStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../src/kite-home-store';
import {
  createKiteHomeWorkspaceAdmissionPort,
  createKiteHomeWorkspaceSessionStore,
} from '../src/kite-home-workspaces';
import { createKiteHomeWriteTransactionPort } from '../src/kite-home-write';
import { validateKiteSessionStoreContinuity } from '../src/kite-session-continuity-validation';
import { createSqliteRuntimeLogQueryPortFromDatabase_ } from '../src/log-query';
import { checksum, SQLITE_RUNTIME_RUN_FORMAT_EPOCH } from '../src/preflight';

const workspace = (seed: string) => {
  const canonicalPath = `/workspace/${seed}`;
  const hex = createHash('sha256').update(canonicalPath).digest('hex');
  const projectId = `project_${hex}`;
  const workspaceDigest = `sha256:${hex}`;
  const workspaceIdentityDigest = `sha256:${createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
    )
    .digest('hex')}`;
  return {
    workspaceId: `workspace_${workspaceIdentityDigest.slice(7)}`,
    canonicalPath,
    workspaceIdentityDigest,
    projectId,
    workspaceDigest,
    displayName: seed,
  };
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as { type: string },
  encodeState: JSON.stringify,
  decodeState: (json: string) => JSON.parse(json),
  snapshotMetadata: (state: { revision: number }) => ({
    stateRevision: state.revision,
    schemaVersion: 27,
  }),
  sessionIdentity: (state: { session: { projectId: string; canonicalWorkspaceDigest: string } }) =>
    state.session,
  rebindForkState: <State>(state: State) => state,
};

test('candidate child admission binds exact parent and hides children before every top-level limit', () => {
  using database = new Database(':memory:', { strict: true });
  initializeKiteSessionStoreIfNeeded(database);
  const writer = createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema);
  const a = workspace('a');
  const b = workspace('b');
  const admissions = createKiteHomeWorkspaceAdmissionPort({
    database,
    writer,
    assertStoreSchema: assertKiteSessionStoreSchema,
  });
  admissions.admit(a);
  admissions.admit(b);
  const store = createKiteHomeWorkspaceSessionStore({
    database,
    writer,
    assertStoreSchema: assertKiteSessionStoreSchema,
    workspace: a,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    now: () => 10,
  });
  const state = (identity: typeof a) => ({
    revision: 0,
    session: { projectId: identity.projectId, canonicalWorkspaceDigest: identity.workspaceDigest },
  });
  store.ensure('root', state(a));
  store.ensure('older', state(a));
  writer.run(() => store.ensureChildInTransaction('child', 'root', state(a)));
  for (const sessionId of ['root', 'older', 'child']) {
    const json = JSON.stringify(state(a));
    database
      .query(`INSERT INTO runtime_snapshots
        (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at)
        VALUES (?, 27, ?, 0, ?, 0, ?, unixepoch())`)
      .run(sessionId, SQLITE_RUNTIME_RUN_FORMAT_EPOCH, json, checksum(json));
  }
  expect(
    database
      .query<{ parent_session_id: string | null }, [string]>(
        'SELECT parent_session_id FROM runtime_sessions WHERE session_id = ?',
      )
      .get('child')?.parent_session_id,
  ).toBe('root');
  expect(() =>
    writer.run(() => store.ensureChildInTransaction('orphan', 'missing', state(a))),
  ).toThrow();
  const other = createKiteHomeWorkspaceSessionStore({
    database,
    writer,
    assertStoreSchema: assertKiteSessionStoreSchema,
    workspace: b,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    now: () => 10,
  });
  expect(() =>
    writer.run(() => other.ensureChildInTransaction('cross', 'root', state(b))),
  ).toThrow();
  expect(() =>
    writer.run(() => store.ensureChildInTransaction('root', 'child', state(a))),
  ).toThrow();
  expect(() =>
    writer.run(() => store.ensureChildInTransaction('child', 'other', state(a))),
  ).toThrow();
  database.query('UPDATE runtime_sessions SET updated_at = 100 WHERE session_id = ?').run('child');
  database.query('UPDATE runtime_sessions SET updated_at = 5 WHERE session_id = ?').run('older');

  const directory = createKiteHomeDirectoryQuery(database, {
    assertStoreSchema: assertKiteSessionStoreSchema,
    maxSessionsPerWorkspace: 1,
  });
  expect(
    directory
      .list()
      .find((row) => row.workspaceId === a.workspaceId)
      ?.sessions.map((s) => s.sessionId),
  ).toEqual(['root']);
  expect(directory.listSessions({ limit: 1 }).entries.map((s) => s.sessionId)).toEqual(['root']);
  const firstPage = directory.listSessions({ limit: 1 });
  expect(
    directory
      .listSessions({ limit: 1, cursor: firstPage.nextCursor })
      .entries.map((s) => s.sessionId),
  ).toEqual(['older']);
  expect(directory.listSessions({ limit: 1, query: 'child' }).entries).toEqual([]);
  const logs = createSqliteRuntimeLogQueryPortFromDatabase_({
    database,
    codec,
    currentEventTypes: ['user.message_appended'],
  });
  expect(logs.listSessions({ limit: 1 }).entries.map((s) => s.sessionId)).toEqual(['root']);
  const logFirstPage = logs.listSessions({ limit: 1 });
  expect(
    logs
      .listSessions({ limit: 1, cursor: logFirstPage.nextCursor })
      .entries.map((s) => s.sessionId),
  ).toEqual(['older']);
  expect(logs.getSession?.('child')).toBeNull();
  expect(() => logs.listEvents({ sessionId: 'child', direction: 'forward', limit: 1 })).toThrow(
    'not found',
  );
  expect(store.list(1).map((s) => s.threadId)).toEqual(['root']);
  const owner = createKiteHomeRuntimeStorageForConnection({
    database,
    assertStoreSchema: assertKiteSessionStoreSchema,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  });
  expect(owner.readSessionLineage('root')).toEqual({ parentSessionId: null });
  expect(owner.readSessionLineage('child')).toEqual({ parentSessionId: 'root' });
  expect(owner.readSessionLineage('missing')).toBeNull();
  expect(() => store.delete('root', 0)).toThrow();
  expect(owner.readSessionLineage('root')).toEqual({ parentSessionId: null });
  expect(owner.readSessionLineage('child')).toEqual({ parentSessionId: 'root' });
  owner.close();
  expect(validateKiteSessionStoreContinuity({ database, codec })).toMatchObject({
    sessions: 3,
    listedSessions: 2,
  });
});
