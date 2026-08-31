import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import {
  createKiteHomeRuntimeStorageForConnection,
  initializeKiteHomeStoreSchema,
  KITE_HOME_STORE_SCHEMA_VERSION,
  type KiteHomeWorkspaceAdmission,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '../src';

type Event = { readonly type: string };
type State = {
  readonly revision: number;
  readonly recoveryIdentity: string;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <Loaded>(json: string) => JSON.parse(json) as Loaded,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 27 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  recoveryIdentity: (state: State) => state.recoveryIdentity,
  rebindForkState: (state: State, _sessionId: string, recoveryIdentity: string) => ({
    ...state,
    recoveryIdentity,
  }),
  isCurrentPendingInteractionRequest: () => false,
};

describe('global Kite Home RuntimeStorage owner', () => {
  test('routes two Workspaces through one connection and one durable Session authority', () => {
    using database = preparedDatabase();
    const owner = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      now: () => 1_000,
    });
    const first = workspace('a', 'b');
    const second = workspace('c', 'd');
    owner.admissions.admit(first);
    owner.admissions.admit(second);

    owner.storage.transactions.commitDecision({
      sessionId: 'session-a',
      events: [{ type: 'created-a' }],
      metadata: [{ eventId: 'event-a', revision: 1 }],
      snapshot: state(first, 1),
    });
    owner.storage.transactions.commitDecision({
      sessionId: 'session-b',
      events: [{ type: 'created-b' }],
      metadata: [{ eventId: 'event-b', revision: 1 }],
      snapshot: state(second, 1),
    });

    expect(owner.storage).toMatchObject({
      adapterId: 'kite-home-sqlite',
      stateSchemaVersion: 27,
      storeSchemaVersion: KITE_HOME_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    expect(owner.storage.sessions.loadSnapshot<State>('session-a')).toEqual(state(first, 1));
    expect(owner.storage.sessions.loadSnapshot<State>('session-b')).toEqual(state(second, 1));
    expect(owner.storage.sessions.listSessions()).toMatchObject([
      { threadId: 'session-a' },
      { threadId: 'session-b' },
    ]);
    expect(owner.directory.list()).toMatchObject([
      { workspaceId: first.workspaceId, sessions: [{ sessionId: 'session-a' }] },
      { workspaceId: second.workspaceId, sessions: [{ sessionId: 'session-b' }] },
    ]);
    expect(() =>
      owner.storage.transactions.commitDecision({
        sessionId: 'session-a',
        events: [{ type: 'forged' }],
        metadata: [{ eventId: 'event-forged', revision: 2 }],
        snapshot: state(second, 2),
      }),
    ).toThrow();
    expect(owner.storage.sessions.getLastEventPosition('session-a')).toBe(1);
  });

  test('exposes complete standard ports and keeps typed Artifact mutations on the writer', () => {
    using database = preparedDatabase();
    const owner = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    const admitted = workspace('a', 'b');
    owner.admissions.admit(admitted);
    owner.storage.transactions.commitDecision({
      sessionId: 'source',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: state(admitted, 1),
    });
    owner.storage.checkpoints.saveNamedSnapshot('source', 'checkpoint', state(admitted, 1), 1);
    expect(
      owner.storage.checkpoints.forkSession('source', 'checkpoint', 'target', 'f'.repeat(64)),
    ).toBe(true);
    expect(owner.storage.recoveryIdentities.read('target')).toBe('f'.repeat(64));
    expect(owner.storage.runs).toBeDefined();
    expect(owner.storage.artifacts.listNamespaces()).toEqual([]);

    const canonicalJson = '{"artifactFormatVersion":1,"response":"ok"}';
    const ref = {
      artifactId: `pa_${'1'.repeat(64)}`,
      kind: 'model_response' as const,
      integrityIdentifier: `sha256:${'2'.repeat(64)}`,
      byteLength: Buffer.byteLength(canonicalJson),
    };
    owner.artifactStore.writeModel({
      ref,
      artifactFormatVersion: 1,
      canonicalJson,
      createdAt: 1,
    });
    expect(owner.artifactStore.readModel(ref)).toEqual({
      artifactFormatVersion: 1,
      canonicalJson,
    });
    owner.close();
    expect(() => owner.storage.sessions.loadSnapshot('source')).toThrow('closed');
    expect(() => owner.admissions.get(admitted.workspaceId)).toThrow('closed');
    expect(() => owner.artifactStore.readModel(ref)).toThrow('closed');
  });

  test('commits same-phase queued Run activation through the one Store writer', () => {
    using database = preparedDatabase();
    const owner = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    const admitted = workspace('run', 'ignored');
    owner.admissions.admit(admitted);
    const queued: RuntimeStoredRun = Object.freeze({
      sessionId: 'session-run',
      runId: 'run-1',
      startCommandId: 'start-1',
      phase: 'building',
      status: 'queued',
      createdRevision: 1,
      lastRevision: 1,
      createdAtMs: 1_000,
    });
    owner.storage.transactions.commitDecision({
      sessionId: 'session-run',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: state(admitted, 1),
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'session-run',
          commandId: 'start-1',
          requestDigest: 'a'.repeat(64),
          targetSessionId: 'session-run',
          committedAt: 1_000,
          resourceResult: createRuntimeRunStartResourceResult(queued),
        },
        1,
      ),
      runMutation: { type: 'insert', run: queued },
    });

    expect(
      owner.storage.runs.transition({
        sessionId: 'session-run',
        runId: 'run-1',
        expectedLastRevision: 1,
        next: Object.freeze({ ...queued, status: 'running', startedAtMs: 1_001 }),
      }),
    ).toBe('applied');
    expect(owner.storage.runs.get('session-run', 'run-1')).toMatchObject({
      status: 'running',
      startedAtMs: 1_001,
    });
  });

  test('commits initial Session, recovery identity and Controller together and rolls back together', () => {
    using database = preparedDatabase();
    const owner = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      now: () => 1_000,
    });
    const admitted = workspace('atomic', 'ignored');
    owner.admissions.admit(admitted);
    const creation = owner.sessionCreationForWorkspace(admitted.workspaceId);
    const input = atomicCreationInput(admitted, 'atomic-session', 'a', secret(7));
    expect(creation.create(input)).toMatchObject({
      status: 'applied',
      runtimeReceipt: { committedRevision: 0 },
      controller: {
        status: 'applied',
        lease: { sessionId: 'atomic-session', controllerGeneration: 1 },
      },
    });
    expect(owner.storage.recoveryIdentities.read('atomic-session')).toBe('e'.repeat(64));

    const invalid = atomicCreationInput(admitted, 'rollback-session', 'b', 'invalid');
    expect(() => creation.create(invalid)).toThrow();
    expect(owner.storage.sessions.loadSnapshot('rollback-session')).toBeNull();
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM kite_meta WHERE key LIKE '%' || ? || '%'",
        )
        .get('rollback-session')?.count,
    ).toBe(0);

    owner.storage.sessions.deleteSession('atomic-session');
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM kite_meta WHERE key LIKE '%' || ? || '%'",
        )
        .get('atomic-session')?.count,
    ).toBe(0);
  });

  test('deep-validates existing Workspace, snapshot, event, receipt, Run and Artifact facts', () => {
    using database = preparedDatabase();
    const admitted = workspace('a', 'b');
    const first = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    first.admissions.admit(admitted);
    first.storage.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: state(admitted, 1),
    });
    first.close();
    const reopened = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    expect(reopened.storage.sessions.loadSnapshot<State>('session-1')).toEqual(state(admitted, 1));
    reopened.close();

    database
      .query(
        "UPDATE runtime_snapshots SET state_checksum = 'corrupt' WHERE session_id = 'session-1'",
      )
      .run();
    expect(() =>
      createKiteHomeRuntimeStorageForConnection<Event, State>({
        database,
        codec,
        stateSchemaVersion: 27,
        formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      }),
    ).toThrow('snapshot');
  });
});

function preparedDatabase(): Database {
  const database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  return database;
}

function workspace(identitySeed: string, _projectSeed: string): KiteHomeWorkspaceAdmission {
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

function state(workspaceIdentity: KiteHomeWorkspaceAdmission, revision: number): State {
  return Object.freeze({
    revision,
    recoveryIdentity: 'e'.repeat(64),
    session: Object.freeze({
      projectId: workspaceIdentity.projectId,
      canonicalWorkspaceDigest: workspaceIdentity.workspaceDigest,
    }),
  });
}

function atomicCreationInput(
  admitted: KiteHomeWorkspaceAdmission,
  sessionId: string,
  digestSeed: string,
  resumeSecret: string,
) {
  return {
    runtime: {
      sessionId,
      events: [],
      snapshot: state(admitted, 0),
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: sessionId,
          commandId: `command-${digestSeed}`,
          requestDigest: digestSeed.repeat(64),
          targetSessionId: sessionId,
          committedAt: 1_000,
        },
        0,
      ),
    },
    controller: {
      sessionId,
      requestId: `controller-${digestSeed}`,
      requestDigest: digestSeed.repeat(64),
      clientId: 'atomic-client',
      connectionGeneration: 1,
      workerInstanceId: 'atomic-service',
      resumeSecret,
      resumeExpiresAtMs: 2_000,
    },
    recoveryIdentity: 'e'.repeat(64),
  } as const;
}

function secret(seed: number): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 37) % 256),
  ).toString('base64url');
}
