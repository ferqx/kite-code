import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createKiteHomeWorkspaceAdmissionPort,
  createKiteHomeWorkspaceSessionStore,
  createKiteHomeWriteTransactionPort,
  initializeKiteHomeStoreSchema,
  type KiteHomeWorkspaceAdmission,
  KiteHomeWriteError,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '../src';

type State = {
  readonly revision: number;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as { readonly type: string },
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (state: State) => ({
    stateRevision: state.revision,
    schemaVersion: 27,
  }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  rebindForkState: (state: State) => state,
  isCurrentPendingInteractionRequest: () => false,
};

describe('Kite Home Workspace admission and Session binding', () => {
  test('admits one exact Workspace and keeps exact replay read-only', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    let currentTime = 100;
    const admissions = createKiteHomeWorkspaceAdmissionPort({
      database,
      writer,
      now: () => currentTime,
    });
    const workspace = identity('a', 'b');

    expect(admissions.admit(workspace)).toEqual({
      status: 'admitted',
      workspace,
    });
    expect(admissions.admit(workspace)).toEqual({
      status: 'existing',
      workspace,
    });
    expect(workspaceUpdatedAt(database, workspace.workspaceId)).toBe(100);

    currentTime = 101;
    expect(admissions.admit({ ...workspace, displayName: 'Renamed' })).toMatchObject({
      status: 'existing',
      workspace: { displayName: 'Renamed' },
    });
    expect(workspaceUpdatedAt(database, workspace.workspaceId)).toBe(101);
  });

  test('rejects identity drift and the legacy bare Workspace digest shape', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const admissions = createKiteHomeWorkspaceAdmissionPort({
      database,
      writer,
    });
    const workspace = identity('a', 'b');
    admissions.admit(workspace);

    expect(
      capture(() => admissions.admit({ ...workspace, canonicalPath: '/workspace/other' })),
    ).toMatchObject({ code: 'invalid_workspace' });
    expect(() =>
      database
        .query(
          `INSERT INTO workspaces(
            workspace_id, canonical_path, workspace_identity_digest, project_id,
            workspace_digest, display_name, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, '', 1, 1)`,
        )
        .run(
          `workspace_${'c'.repeat(64)}`,
          '/workspace/c',
          'c'.repeat(64),
          `project_${'c'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
        ),
    ).toThrow();
  });

  test('binds Session metadata to its admitted Workspace and scopes reads', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const admissions = createKiteHomeWorkspaceAdmissionPort({
      database,
      writer,
      now: () => 100,
    });
    const first = identity('a', 'b');
    const second = identity('c', 'd');
    admissions.admit(first);
    admissions.admit(second);
    const firstSessions = sessions(database, writer, first, () => 200);
    const secondSessions = sessions(database, writer, second, () => 300);
    const state = stateFor(first, 1);

    expect(() => firstSessions.ensureInTransaction('session-1', state)).toThrow(KiteHomeWriteError);
    firstSessions.ensure('session-1', state);
    secondSessions.ensure('session-2', stateFor(second, 2));
    expect(firstSessions.list()).toEqual([{ threadId: 'session-1', name: '', updatedAt: 200 }]);
    expect(secondSessions.list()).toEqual([{ threadId: 'session-2', name: '', updatedAt: 300 }]);
    expect(firstSessions.binding('session-1')).toEqual({
      sessionId: 'session-1',
      workspaceId: first.workspaceId,
      projectId: first.projectId,
      workspaceDigest: first.workspaceDigest,
      revision: 1,
    });
    expect(capture(() => secondSessions.binding('session-1'))).toMatchObject({
      code: 'session_conflict',
    });
  });

  test('rejects forged State identity and retains a tombstone after cascading Session facts', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const admissions = createKiteHomeWorkspaceAdmissionPort({
      database,
      writer,
      now: () => 100,
    });
    const workspace = identity('a', 'b');
    admissions.admit(workspace);
    const store = sessions(database, writer, workspace, () => 200);

    expect(capture(() => store.ensure('forged', stateFor(identity('c', 'd'), 1)))).toMatchObject({
      code: 'write_failed',
    });
    expect(store.has('forged')).toBe(false);

    store.ensure('session-1', stateFor(workspace, 1));
    database
      .query(
        `INSERT INTO runtime_events(
          session_id, event_id, sequence, schema_version, event_json, created_at
        ) VALUES ('session-1', 'event-1', 1, 27, '{}', 1)`,
      )
      .run();
    store.setName('session-1', 'Named');
    store.setModelRoute('session-1', { provider: 'provider', name: 'model' });
    expect(store.getModelRoute('session-1')).toEqual({
      provider: 'provider',
      name: 'model',
    });
    expect(store.delete('session-1', 1)).toBe(true);
    expect(store.has('session-1')).toBe(false);
    expect(database.query('SELECT * FROM runtime_events').all()).toHaveLength(0);
    expect(
      database
        .query<{ workspace_id: string; deleted_revision: number }, []>(
          "SELECT workspace_id, deleted_revision FROM runtime_session_tombstones WHERE session_id = 'session-1'",
        )
        .get(),
    ).toEqual({ workspace_id: workspace.workspaceId, deleted_revision: 1 });
    expect(capture(() => store.ensure('session-1', stateFor(workspace, 2)))).toMatchObject({
      code: 'write_failed',
    });
  });
});

function preparedDatabase(): Database {
  const database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  return database;
}

function identity(identitySeed: string, _workspaceSeed: string): KiteHomeWorkspaceAdmission {
  const canonicalPath = `/workspace/${identitySeed}`;
  const pathHex = createHash('sha256').update(canonicalPath).digest('hex');
  const projectId = `project_${pathHex}`;
  const workspaceDigest = `sha256:${pathHex}`;
  const identityDigest = `sha256:${createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
    )
    .digest('hex')}`;
  return Object.freeze({
    workspaceId: `workspace_${identityDigest.slice('sha256:'.length)}`,
    canonicalPath,
    workspaceIdentityDigest: identityDigest,
    projectId,
    workspaceDigest,
    displayName: identitySeed.toUpperCase(),
  });
}

function stateFor(workspace: KiteHomeWorkspaceAdmission, revision: number): State {
  return Object.freeze({
    revision,
    session: Object.freeze({
      projectId: workspace.projectId,
      canonicalWorkspaceDigest: workspace.workspaceDigest,
    }),
  });
}

function sessions(
  database: Database,
  writer: ReturnType<typeof createKiteHomeWriteTransactionPort>,
  workspace: KiteHomeWorkspaceAdmission,
  now: () => number,
) {
  return createKiteHomeWorkspaceSessionStore({
    database,
    writer,
    workspace,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    now,
  });
}

function workspaceUpdatedAt(database: Database, workspaceId: string): number | undefined {
  return database
    .query<{ updated_at: number }, [string]>(
      'SELECT updated_at FROM workspaces WHERE workspace_id = ?',
    )
    .get(workspaceId)?.updated_at;
}

function capture(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
