import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createKiteHomeDirectoryQuery } from '../../src/kite-home-directory';
import {
  assertKiteSessionStoreSchema,
  KITE_SESSION_STORE11_DDL as CURRENT_STORE11_DDL,
  initializeKiteHomeStoreSchema,
  KITE_SESSION_STORE10_DDL,
} from '../../src/kite-home-store';
import { validateKiteSessionStoreContinuity } from '../../src/kite-session-continuity-validation';
import { acquireKiteSessionStoreMaintenance } from '../../src/kite-session-maintenance';
import { captureKiteSessionPreservationManifest } from '../../src/kite-session-preservation';
import { prepareKiteSessionStore } from '../../src/kite-session-store-preparation';
import {
  captureKiteSessionPublicationSource,
  publishVerifiedKiteSessionCandidate,
} from '../../src/kite-session-store-publication';
import { inspectKiteSessionStoreSources } from '../../src/kite-session-store-sources';
import { convertKiteSessionStore10CandidateTo11 } from '../../src/kite-session-store10-to11';
import { KITE_SESSION_STORE11_DDL } from '../../src/kite-session-store11-conversion';
import { convertKiteSessionStore11CandidateTo12 } from '../../src/kite-session-store11-to12';
import { convertKiteSessionStore12CandidateTo13 } from '../../src/kite-session-store12-to13';
import { createSqliteRuntimeLogQueryPortFromDatabase_ } from '../../src/log-query';
import { checksum, SQLITE_RUNTIME_RUN_FORMAT_EPOCH } from '../../src/preflight';

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as { type: string },
  encodeState: JSON.stringify,
  decodeState: JSON.parse,
  eventSummary: () => ({ isSessionNameCandidate: false, searchText: '' }),
  snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 27 }),
  sessionIdentity: (state: { session: { projectId: string; canonicalWorkspaceDigest: string } }) =>
    state.session,
  rebindForkState: <T>(state: T) => state,
};
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-preparation-')));
  const databasePath = join(root, 'kite-session.sqlite');
  const paths = [
    databasePath,
    join(root, 'kite.sqlite'),
    join(root, 'source-profiles', '1'.repeat(32), 'kite-session.sqlite'),
  ];
  for (const [index, path] of paths.entries()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new Database(path);
    chmodSync(path, 0o600);
    if (index === 0) {
      for (const sql of KITE_SESSION_STORE10_DDL) database.run(sql);
      database.run(
        "INSERT INTO kite_meta VALUES ('schema_version', '10'), ('format_epoch', 'kite-session-app-server-2026-09-02')",
      );
      database.run('PRAGMA user_version=10');
    } else if (index === 1) initializeKiteHomeStoreSchema(database);
    else {
      for (const sql of KITE_SESSION_STORE11_DDL) database.run(sql);
      database.run(
        "INSERT INTO kite_meta VALUES ('schema_version', '11'), ('format_epoch', 'kite-session-accepted-runs-2026-09-15')",
      );
      database.run('PRAGMA user_version=11');
    }
    database.close(false);
  }
  return {
    root,
    databasePath,
    paths,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('known-format startup preparation', () => {
  test('keeps a Store 10 conversation visible by its original ID after multi-source preparation', async () => {
    using data = fixture();
    const old = new Database(data.databasePath);
    const canonicalPath = '/workspace/legacy';
    const hex = createHash('sha256').update(canonicalPath).digest('hex');
    const projectId = `project_${hex}`;
    const workspaceDigest = `sha256:${hex}`;
    const workspaceIdentityDigest = `sha256:${createHash('sha256')
      .update(
        `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
      )
      .digest('hex')}`;
    const workspaceId = `workspace_${workspaceIdentityDigest.slice(7)}`;
    const stateJson = JSON.stringify({
      revision: 1,
      session: { projectId, canonicalWorkspaceDigest: workspaceDigest },
    });
    const event = { type: 'user.message_appended', text: 'Legacy message' };
    const eventJson = JSON.stringify(event);
    try {
      old
        .query(`INSERT INTO workspaces
        (workspace_id, canonical_path, workspace_identity_digest, project_id, workspace_digest, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Workspace', 1, 1)`)
        .run(workspaceId, canonicalPath, workspaceIdentityDigest, projectId, workspaceDigest);
      old
        .query(`INSERT INTO runtime_sessions
        (session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at, run_index_from_revision)
        VALUES ('legacy-conversation', ?, ?, ?, 27, ?, 1, 'Old conversation', 1, 0)`)
        .run(workspaceId, projectId, workspaceDigest, SQLITE_RUNTIME_RUN_FORMAT_EPOCH);
      old
        .query(`INSERT INTO runtime_events
        (session_id, event_id, sequence, schema_version, event_json, created_at)
        VALUES ('legacy-conversation', 'legacy-event-1', 1, 27, ?, 1)`)
        .run(eventJson);
      old
        .query(`INSERT INTO runtime_snapshots
        (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at)
        VALUES ('legacy-conversation', 27, ?, 1, ?, 1, ?, 1)`)
        .run(SQLITE_RUNTIME_RUN_FORMAT_EPOCH, stateJson, checksum(stateJson));
      old.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run(
        'session_execution/legacy-conversation',
        JSON.stringify({
          schema: 'kite.session-execution-authority.v1',
          sessionId: 'legacy-conversation',
          status: 'idle',
          controllerGeneration: 0,
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          interactionGeneration: 0,
          leaseUntilMs: null,
          cleanupConfirmed: true,
          updatedAt: 0,
          revision: 0,
        }),
      );
    } finally {
      old.close(false);
    }
    rmSync(data.paths[2]!);
    const old11 = new Database(data.paths[2]!);
    chmodSync(data.paths[2]!, 0o600);
    for (const statement of CURRENT_STORE11_DDL) old11.run(statement);
    old11.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '11');
    old11
      .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
      .run('format_epoch', 'kite-session-lineage-2026-09-24');
    old11.run('PRAGMA user_version=11');
    const store11StateJson = JSON.stringify({
      revision: 1,
      session: { projectId, canonicalWorkspaceDigest: workspaceDigest },
    });
    const store11Event = { type: 'user.message_appended', text: 'Store11 message' };
    try {
      old11
        .query(`INSERT INTO workspaces
        (workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,
        display_name,created_at,updated_at) VALUES (?,?,?,?,?,'Workspace',1,1)`)
        .run(workspaceId, canonicalPath, workspaceIdentityDigest, projectId, workspaceDigest);
      old11
        .query(`INSERT INTO runtime_sessions
        (session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,
        revision,name,updated_at,run_index_from_revision,parent_session_id)
        VALUES ('legacy-store11',?,?,?,?,?,1,'Store11 conversation',2,0,NULL)`)
        .run(workspaceId, projectId, workspaceDigest, 27, SQLITE_RUNTIME_RUN_FORMAT_EPOCH);
      old11
        .query(`INSERT INTO runtime_events
        (session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('legacy-store11','legacy11-event',1,27,?,2)`)
        .run(JSON.stringify(store11Event));
      old11
        .query(`INSERT INTO runtime_snapshots
        (session_id,schema_version,format_epoch,revision,state_json,event_position,state_checksum,created_at)
        VALUES ('legacy-store11',27,?,1,?,1,?,2)`)
        .run(SQLITE_RUNTIME_RUN_FORMAT_EPOCH, store11StateJson, checksum(store11StateJson));
      old11.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(
        'session_execution/legacy-store11',
        JSON.stringify({
          schema: 'kite.session-execution-authority.v1',
          sessionId: 'legacy-store11',
          status: 'idle',
          controllerGeneration: 0,
          hostInstanceId: null,
          clientId: null,
          connectionGeneration: 0,
          interactionGeneration: 0,
          leaseUntilMs: null,
          cleanupConfirmed: true,
          updatedAt: 0,
          revision: 0,
        }),
      );
    } finally {
      old11.close(false);
    }
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
      }),
    ).toEqual({ status: 'prepared' });
    using upgraded = new Database(data.databasePath);
    upgraded.run('PRAGMA foreign_keys = ON');
    const childStateJson = JSON.stringify({
      revision: 0,
      session: { projectId, canonicalWorkspaceDigest: workspaceDigest },
    });
    upgraded
      .query(`INSERT INTO runtime_sessions
      (session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at, run_index_from_revision, parent_session_id)
      VALUES ('child-conversation', ?, ?, ?, 27, ?, 0, 'Internal child', 100, 0, 'legacy-conversation')`)
      .run(workspaceId, projectId, workspaceDigest, SQLITE_RUNTIME_RUN_FORMAT_EPOCH);
    upgraded
      .query(`INSERT INTO runtime_snapshots
      (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at)
      VALUES ('child-conversation', 27, ?, 0, ?, 0, ?, 1)`)
      .run(SQLITE_RUNTIME_RUN_FORMAT_EPOCH, childStateJson, checksum(childStateJson));
    const directory = createKiteHomeDirectoryQuery(upgraded, {
      assertStoreSchema: assertKiteSessionStoreSchema,
    });
    expect(
      directory
        .listSessions({ limit: 10 })
        .entries.map((entry) => entry.sessionId)
        .sort(),
    ).toEqual(['legacy-conversation', 'legacy-store11']);
    expect(
      upgraded
        .query('SELECT state_json FROM runtime_snapshots WHERE session_id = ?')
        .get('legacy-conversation'),
    ).toEqual({ state_json: stateJson });
    expect(
      upgraded
        .query('SELECT event_json FROM runtime_events WHERE session_id = ?')
        .get('legacy-conversation'),
    ).toEqual({ event_json: eventJson });
    expect(
      upgraded
        .query('SELECT parent_session_id FROM runtime_sessions WHERE session_id = ?')
        .get('legacy-conversation'),
    ).toEqual({ parent_session_id: null });
    const history = createSqliteRuntimeLogQueryPortFromDatabase_({
      database: upgraded,
      codec,
      currentEventTypes: ['user.message_appended'],
    });
    expect(
      history
        .listSessions({ limit: 10 })
        .entries.map((entry) => entry.sessionId)
        .sort(),
    ).toEqual(['legacy-conversation', 'legacy-store11']);
    expect(
      history.listEvents({ sessionId: 'legacy-conversation', direction: 'forward', limit: 10 }),
    ).toMatchObject({
      observedLastSequence: 1,
      entries: [{ sessionId: 'legacy-conversation', eventId: 'legacy-event-1', event }],
    });
    expect(history.getSession?.('child-conversation')).toBeNull();
    expect(
      history.listEvents({ sessionId: 'legacy-store11', direction: 'forward', limit: 10 }),
    ).toMatchObject({
      observedLastSequence: 1,
      entries: [{ sessionId: 'legacy-store11', eventId: 'legacy11-event', event: store11Event }],
    });
    expect(
      upgraded
        .query('SELECT state_json FROM runtime_snapshots WHERE session_id=?')
        .get('legacy-store11'),
    ).toEqual({ state_json: store11StateJson });
    expect(validateKiteSessionStoreContinuity({ database: upgraded, codec })).toMatchObject({
      sessions: 3,
      listedSessions: 2,
      events: 2,
    });
  });

  test('publishes one canonical Store and retires historical entries before normal startup', async () => {
    using data = fixture();
    let admissions = 0;
    const input = {
      ...data,
      codec,
      isSettledState: () => true,
      nowMs: 500,
      assertRetiredWritersStopped: () => {
        admissions++;
      },
    };
    expect(await prepareKiteSessionStore(input)).toEqual({ status: 'prepared' });
    expect(admissions).toBe(2);
    expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
    expect(await prepareKiteSessionStore(input)).toEqual({ status: 'current' });
    expect(admissions).toBe(2);
    using database = new Database(data.databasePath, { readonly: true });
    expect(database.query("SELECT value FROM kite_meta WHERE key='schema_version'").get()).toEqual({
      value: '13',
    });
  });
  test('writer admission lease spans candidate validation and publication and is released on success', async () => {
    using data = fixture();
    const phases: string[] = [];
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => {
          phases.push('acquired');
          return {
            revalidate() {
              expect(existsSync(data.paths[1]!)).toBe(true);
              expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(true);
              phases.push('validated');
            },
            release() {
              expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
              phases.push('released');
            },
          };
        },
      }),
    ).toEqual({ status: 'prepared' });
    expect(phases).toEqual(['acquired', 'validated', 'released']);
  });

  test('reports bounded preparation stages without letting observer failure change publication', async () => {
    using data = fixture();
    const stages: string[] = [];
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
        onProgress(stage) {
          stages.push(stage);
          if (stage === 'preparing') throw new Error('observer failed');
        },
      }),
    ).toEqual({ status: 'prepared' });
    expect(stages).toEqual([
      'inspecting',
      'acquiring_maintenance',
      'preparing',
      'publishing',
      'ready',
    ]);
    expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
  });

  test('failed lease revalidation releases admission without publishing or losing original data', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    let released = false;
    await expect(
      prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => ({
          revalidate() {
            throw new Error('distribution changed');
          },
          release() {
            released = true;
          },
        }),
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'store_history_reconciliation_required',
        stage: 'preparing',
      }),
    );
    expect(released).toBe(true);
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
  });

  test('never archives an empty main file with a nonempty WAL without a verified backup', async () => {
    using data = fixture();
    const historical = data.paths[2]!;
    writeFileSync(historical, '');
    writeFileSync(`${historical}-wal`, 'unresolved committed WAL', { mode: 0o600 });
    const before = data.paths.map((path) => readFileSync(path));
    await expect(
      prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'store_history_reconciliation_required' }));
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(readFileSync(`${historical}-wal`, 'utf8')).toBe('unresolved committed WAL');
    expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(false);
  });

  test('insufficient disk space is rejected before any recovery asset or source change', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    const actual = fs.statfsSync(data.root, { bigint: true });
    const space = spyOn(fs, 'statfsSync').mockReturnValue({ ...actual, bavail: 0n } as never);
    try {
      await expect(
        prepareKiteSessionStore({
          ...data,
          codec,
          isSettledState: () => true,
          assertRetiredWritersStopped() {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'store_insufficient_space' }));
    } finally {
      space.mockRestore();
    }
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(false);
  });

  test('failed writer admission leaves original paths and content intact without creating recovery assets', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    await expect(
      prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {
          throw new Error('old writer still running');
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'store_history_reconciliation_required' }));
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(false);
  });

  test('cancellation gate retains maintenance and admission, then leaves sources unchanged', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    let enterGate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterGate = resolve;
    });
    let decide!: (decision: 'commit' | 'cancel') => void;
    const decision = new Promise<'commit' | 'cancel'>((resolve) => {
      decide = resolve;
    });
    let released = false;
    const preparing = prepareKiteSessionStore({
      ...data,
      codec,
      isSettledState: () => true,
      assertRetiredWritersStopped: () => ({
        revalidate() {},
        release() {
          released = true;
        },
      }),
      beforePublication: () => {
        enterGate();
        return decision;
      },
    });
    await entered;
    expect(released).toBe(false);
    expect(() => acquireKiteSessionStoreMaintenance(data.databasePath, 'exclusive')).toThrow(
      expect.objectContaining({ code: 'store_busy' }),
    );
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
    decide('cancel');
    await expect(preparing).rejects.toThrow(
      expect.objectContaining({
        code: 'store_preparation_cancelled',
        stage: 'preparing',
      }),
    );
    expect(released).toBe(true);
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
    acquireKiteSessionStoreMaintenance(data.databasePath, 'exclusive').release();
  });

  test('commit gate revalidates admission after the wait and publishes', async () => {
    using data = fixture();
    const order: string[] = [];
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => ({
          revalidate() {
            order.push('revalidate');
          },
          release() {
            order.push('release');
          },
        }),
        async beforePublication() {
          order.push('gate');
          return 'commit';
        },
      }),
    ).toEqual({ status: 'prepared' });
    expect(order).toEqual(['gate', 'revalidate', 'release']);
    expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
  });

  test('pending committed publication settles without consulting cancellation gate', async () => {
    using data = fixture();
    const migrationDirectory = join(data.root, 'session-store-recovery', 'migration-test');
    mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
    const candidateDirectory = join(migrationDirectory, 'converted-0');
    mkdirSync(candidateDirectory, { mode: 0o700 });
    const candidatePath = join(candidateDirectory, 'kite-session.sqlite');
    copyFileSync(data.databasePath, candidatePath);
    chmodSync(candidatePath, 0o600);
    const candidateWriter = new Database(candidatePath);
    try {
      convertKiteSessionStore10CandidateTo11({ database: candidateWriter });
      convertKiteSessionStore11CandidateTo12({ database: candidateWriter });
      convertKiteSessionStore12CandidateTo13({ database: candidateWriter });
    } finally {
      candidateWriter.close(false);
    }
    using candidate = new Database(candidatePath, { readonly: true });
    const candidateManifest = captureKiteSessionPreservationManifest(candidate);
    const sources = data.paths.map((databasePath) => ({
      databasePath,
      files: captureKiteSessionPublicationSource(data.databasePath, databasePath),
      maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
    }));
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          canonicalPath: data.databasePath,
          canonicalMaintenance: sources[0]!.maintenance,
          candidatePath,
          candidateManifest,
          migrationDirectory,
          sources,
          validatePublished: () => {},
          fault(point) {
            if (point === 'intent_directory_fsync') throw new Error('simulated crash');
          },
        }),
      ).toThrow('simulated crash');
    } finally {
      for (const source of sources.reverse()) source.maintenance.release();
    }
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(true);
    let gateCalls = 0;
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
        async beforePublication() {
          gateCalls++;
          return 'cancel';
        },
      }),
    ).toEqual({ status: 'resumed' });
    expect(gateCalls).toBe(0);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
  });
});
