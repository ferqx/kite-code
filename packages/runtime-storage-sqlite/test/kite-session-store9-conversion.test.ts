import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import {
  assertKiteHomeStoreSchema,
  assertKiteSessionStoreSchema,
  createKiteHomeRuntimeStorageForConnection,
  createKiteHomeWorkspaceAdmissionPort,
  createKiteHomeWorkspaceAuthority,
  createKiteHomeWorkspaceRuntimeJournal,
  createKiteHomeWriteTransactionPort,
  createKiteSessionExecutionAuthority,
  initializeKiteHomeStoreSchema,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '../src';
import {
  convertKiteStore9ToSessionStore10,
  KiteStore9ConversionUnsupported,
} from '../src/kite-session-store9-conversion';

type State = {
  readonly revision: number;
  readonly settled: boolean;
  readonly recoveryIdentity: string;
  readonly session: { readonly projectId: string; readonly canonicalWorkspaceDigest: string };
};
type Event = { readonly type: string; readonly text: string };
const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  eventSummary: (event: Event) => ({ isSessionNameCandidate: true, searchText: event.text }),
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

function fixture(status: 'idle' | 'active' | 'detached', settled: boolean, withQueuedRun = true) {
  const database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  const writer = createKiteHomeWriteTransactionPort(database);
  const canonicalPath = '/workspace/conversion';
  const digest = createHash('sha256').update(canonicalPath).digest('hex');
  const projectId = `project_${digest}`;
  const workspaceDigest = `sha256:${digest}`;
  const workspaceIdentityDigest = `sha256:${createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
    )
    .digest('hex')}`;
  const workspace = {
    workspaceId: `workspace_${workspaceIdentityDigest.slice('sha256:'.length)}`,
    canonicalPath,
    workspaceIdentityDigest,
    projectId,
    workspaceDigest,
    displayName: 'Conversion',
  };
  createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
  const journal = createKiteHomeWorkspaceRuntimeJournal<Event, State>({
    database,
    writer,
    workspace,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    now: () => 200,
  });
  const state: State = {
    revision: 1,
    settled,
    recoveryIdentity: 'e'.repeat(64),
    session: { projectId, canonicalWorkspaceDigest: workspaceDigest },
  };
  const queued: RuntimeStoredRun = {
    sessionId: 'session-1',
    runId: 'run-1',
    startCommandId: 'start-1',
    phase: 'building',
    status: 'queued',
    createdRevision: 1,
    lastRevision: 1,
    createdAtMs: 1_000,
  };
  const receipt = createRuntimeStoredCommandReceipt(
    {
      scopeSessionId: 'session-1',
      commandId: 'start-1',
      requestDigest: 'a'.repeat(64),
      targetSessionId: 'session-1',
      committedAt: 1_000,
      resourceResult: createRuntimeRunStartResourceResult(queued),
    },
    1,
  );
  journal.transactions.commitDecision({
    sessionId: 'session-1',
    events: [{ type: 'message', text: 'Historical message' }],
    metadata: [{ eventId: 'event-1', revision: 1 }],
    snapshot: state,
    ...(withQueuedRun
      ? { commandReceipt: receipt, runMutation: { type: 'insert' as const, run: queued } }
      : {}),
  });
  journal.recoveryIdentities.getOrCreate('session-1', () => 'e'.repeat(64));
  const authority = createKiteHomeWorkspaceAuthority({
    database,
    writer,
    workspace,
    nowMs: () => 10,
  });
  const request = (requestId: string) =>
    authority.controller.requestControl({
      sessionId: 'session-1',
      requestId,
      requestDigest: '1'.repeat(64),
      clientId: 'client-1',
      connectionGeneration: 1,
      workerInstanceId: 'service-1',
      resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        'base64url',
      ),
      resumeExpiresAtMs: 100,
    });
  const acquired = request('acquire-1');
  if (acquired.status !== 'applied' || !acquired.lease)
    throw new Error('Fixture failed to acquire');
  const lease = acquired.lease;
  if (status === 'detached') {
    authority.controller.detachController({
      ...lease,
      requestId: 'detach-1',
      requestDigest: '2'.repeat(64),
      interactionGeneration: 1,
    });
  } else {
    authority.controller.releaseControl({
      ...lease,
      requestId: 'release-1',
      requestDigest: '2'.repeat(64),
    });
    if (status === 'active') request('acquire-2');
  }
  return { database, workspace, state, queued, [Symbol.dispose]: () => database.close() };
}

const convert = (database: Database) =>
  convertKiteStore9ToSessionStore10({
    database,
    codec,
    isSettledState: (state: State) => state.settled,
    nowMs: 300,
  });

describe('Store 9 to Session Store 10 strict conversion', () => {
  for (const [oldStatus, settled, nextStatus] of [
    ['idle', true, 'idle'],
    ['idle', true, 'recovery_required'],
    ['idle', false, 'recovery_required'],
    ['active', true, 'recovery_required'],
    ['detached', true, 'recovery_required'],
  ] as const) {
    test(`${oldStatus} with settled=${settled} and queued Run=${nextStatus !== 'idle'} maps to ${nextStatus}`, () => {
      const withQueuedRun = nextStatus !== 'idle';
      using data = fixture(oldStatus, settled, withQueuedRun);
      const { database, workspace, state, queued } = data;
      expect(convert(database)).toEqual({
        sessions: 1,
        recoveryRequired: nextStatus === 'idle' ? 0 : 1,
      });
      assertKiteSessionStoreSchema(database);
      const authority = createKiteSessionExecutionAuthority({
        database,
        writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
      });
      expect(authority.read('session-1')).toMatchObject({
        status: nextStatus,
        cleanupConfirmed: nextStatus === 'idle',
      });
      const owner = createKiteHomeRuntimeStorageForConnection({
        database,
        assertStoreSchema: assertKiteSessionStoreSchema,
        storeSchemaVersion: 10,
        codec,
        stateSchemaVersion: 27,
        formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      });
      expect(owner.storage.sessions.loadSnapshot<State>('session-1')).toEqual(state);
      expect(owner.storage.runs.get('session-1', 'run-1')).toEqual(withQueuedRun ? queued : null);
      expect(owner.storage.sessions.loadEventsStrict('session-1')).toMatchObject([
        { event_id: 'event-1', event: { text: 'Historical message' } },
      ]);
      expect(workspace.workspaceId).toBeTruthy();
      owner.close();
    });
  }

  test('an unsupported metadata key fails without changing Store 9', () => {
    using data = fixture('idle', true);
    const { database } = data;
    database.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run('unknown/key', 'opaque');
    expect(() => convert(database)).toThrow(KiteStore9ConversionUnsupported);
    assertKiteHomeStoreSchema(database);
    expect(
      database
        .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key='unknown/key'")
        .get()?.value,
    ).toBe('opaque');
  });

  test('a source trigger is rejected before mutation', () => {
    using data = fixture('idle', true);
    const { database } = data;
    database.run('CREATE TRIGGER unknown_trigger AFTER INSERT ON kite_meta BEGIN SELECT 1; END');
    expect(() => convert(database)).toThrow(KiteStore9ConversionUnsupported);
    assertKiteHomeStoreSchema(database);
  });

  test('a corrupt rolling snapshot cannot grant idle or partially migrate', () => {
    using data = fixture('idle', true);
    const { database } = data;
    database
      .query('UPDATE runtime_snapshots SET state_json = ? WHERE session_id = ?')
      .run(JSON.stringify({ ...data.state, revision: 2 }), 'session-1');
    expect(() => convert(database)).toThrow(KiteStore9ConversionUnsupported);
    assertKiteHomeStoreSchema(database);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM kite_meta WHERE key LIKE 'session_execution/%'",
        )
        .get()?.count,
    ).toBe(0);
  });

  test('a failure after target DDL rolls the entire conversion back to Store 9', () => {
    using data = fixture('idle', true, false);
    const { database } = data;
    const before = database
      .query<{ key: string; value: string }, []>('SELECT key, value FROM kite_meta ORDER BY key')
      .all();
    const originalQuery = database.query.bind(database);
    Object.defineProperty(database, 'query', {
      value: (sql: string) => {
        if (
          sql === 'INSERT INTO kite_meta(key, value) VALUES (?, ?)' &&
          originalQuery<{ value: string }, []>(
            "SELECT value FROM kite_meta WHERE key = 'schema_version'",
          ).get()?.value === '10'
        )
          throw new Error('injected seed failure');
        return originalQuery(sql);
      },
    });
    expect(() => convert(database)).toThrow('injected seed failure');
    assertKiteHomeStoreSchema(database);
    expect(
      database
        .query<{ key: string; value: string }, []>('SELECT key, value FROM kite_meta ORDER BY key')
        .all(),
    ).toEqual(before);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM kite_meta WHERE key LIKE 'session_execution/%'",
        )
        .get()?.count,
    ).toBe(0);
  });
});
