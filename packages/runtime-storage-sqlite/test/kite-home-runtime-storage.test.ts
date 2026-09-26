import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CHILD_SESSION_TASK_USER_GOAL,
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

  test('keeps receipt-free ordinary Runs and unowned internal followups closed', () => {
    using database = preparedDatabase();
    const owner = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    const admitted = workspace('followup', 'receipt');
    owner.admissions.admit(admitted);
    const run: RuntimeStoredRun = {
      sessionId: 'session-followup',
      runId: 'followup-run',
      startCommandId: 'followup:submission-1',
      phase: 'building',
      status: 'queued',
      createdRevision: 4,
      lastRevision: 4,
      createdAtMs: 1,
    };
    const checkpointRef = {
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'subagent_checkpoint' as const,
      integrityIdentifier: `sha256:${'a'.repeat(64)}` as const,
      byteLength: 1,
    };
    const grantRef = {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'agent_followup_grant' as const,
      integrityIdentifier: `sha256:${'b'.repeat(64)}` as const,
      byteLength: 1,
    };
    const mutation = {
      sourceSessionId: 'source',
      submissionId: 'submission-1',
      targetRunId: run.runId,
      taskId: 'task-1',
      phase: 'building' as const,
      checkpointRef,
      grantDigest: grantRef.integrityIdentifier,
      grant: { ref: grantRef, canonicalJson: '{}', createdAt: 1 },
    };
    const events = [
      {
        type: 'agent.followup_turn_prepared',
        sourceSessionId: mutation.sourceSessionId,
        submissionId: mutation.submissionId,
        targetRunId: mutation.targetRunId,
        taskId: mutation.taskId,
        checkpointRef,
        grantRef,
        grantDigest: mutation.grantDigest,
      },
      { type: 'resource_budget.configured', runId: run.runId },
      {
        type: 'task.started',
        taskId: mutation.taskId,
        turnId: run.runId,
        userGoal: CHILD_SESSION_TASK_USER_GOAL,
      },
      { type: 'turn.started', turnId: run.runId },
    ];
    const causeMessages = (operation: () => void): string[] => {
      try {
        operation();
      } catch (error) {
        const messages: string[] = [];
        let current: unknown = error;
        while (current && messages.length < 5) {
          messages.push(String(current));
          current = (current as { cause?: unknown }).cause;
        }
        return messages;
      }
      throw new Error('A receipt-free Run was unexpectedly committed.');
    };
    expect(
      causeMessages(() =>
        owner.storage.transactions.commitDecision({
          sessionId: run.sessionId,
          events,
          metadata: events.map((_, index) => ({
            eventId: `followup-event-${index}`,
            revision: index + 1,
          })),
          snapshot: state(admitted, 4),
          runMutation: { type: 'insert', run },
          followupRunStart: mutation,
        }),
      ),
    ).toContain(
      'SqliteRuntimeCommandReceiptValidationError: Runtime internal followup Run has no Store13 owner authority.',
    );
    expect(owner.storage.sessions.loadSnapshot(run.sessionId)).toBeNull();
    expect(
      causeMessages(() =>
        owner.storage.transactions.commitDecision({
          sessionId: run.sessionId,
          events,
          metadata: events.map((_, index) => ({
            eventId: `ordinary-event-${index}`,
            revision: index + 1,
          })),
          snapshot: state(admitted, 4),
          runMutation: { type: 'insert', run },
        }),
      ),
    ).toContain(
      'SqliteRuntimeCommandReceiptValidationError: Runtime Run insert requires its exact Store 8 start resource receipt.',
    );
    expect(owner.storage.runs.get(run.sessionId, run.runId)).toBeNull();
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

  test('opens the directory without decoding history and validates a Session when its snapshot is read', () => {
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
    let decoded = 0;
    const damaged = createKiteHomeRuntimeStorageForConnection<Event, State>({
      database,
      codec: {
        ...codec,
        decodeEvent: (json: string) => {
          decoded++;
          return codec.decodeEvent(json);
        },
      },
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    expect(damaged.directory.listSessions({ limit: 10 }).entries).toMatchObject([
      { sessionId: 'session-1', workspace: { workspaceId: admitted.workspaceId } },
    ]);
    expect(decoded).toBe(0);
    expect(() => damaged.storage.sessions.loadSnapshot('session-1')).toThrow('snapshot');
    damaged.close();
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
