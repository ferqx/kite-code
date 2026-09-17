import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import { createKiteHomeWorkspaceRuntimeJournal } from '../src/kite-home-runtime-journal';
import { createKiteHomeRuntimeStorageForConnection } from '../src/kite-home-runtime-storage';
import { assertKiteSessionStoreSchema } from '../src/kite-home-store';
import { createKiteHomeWorkspaceAdmissionPort } from '../src/kite-home-workspaces';
import { createKiteHomeWriteTransactionPort } from '../src/kite-home-write';
import { createKiteSessionExecutionAuthority } from '../src/kite-session-execution-authority';
import {
  assertKiteSessionStore11Schema,
  convertKiteSessionStore11To10,
  KITE_SESSION_STORE11_DDL,
  KiteStore11ConversionUnsupported,
} from '../src/kite-session-store11-conversion';

type State = {
  revision: number;
  settled: boolean;
  recoveryIdentity: string;
  session: { projectId: string; canonicalWorkspaceDigest: string };
};
const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as { type: string },
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  eventSummary: () => ({ isSessionNameCandidate: false, searchText: '' }),
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 27 }),
  sessionIdentity: (state: State) => state.session,
  recoveryIdentity: (state: State) => state.recoveryIdentity,
  rebindForkState: (state: State, _sessionId: string, recoveryIdentity: string) => ({
    ...state,
    recoveryIdentity,
  }),
};
function source(): Database {
  const db = new Database(':memory:', { strict: true });
  db.run('PRAGMA foreign_keys=ON');
  for (const ddl of KITE_SESSION_STORE11_DDL) db.run(ddl);
  db.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '11');
  db.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(
    'format_epoch',
    'kite-session-accepted-runs-2026-09-15',
  );
  db.run('PRAGMA user_version=11');
  assertKiteSessionStore11Schema(db);
  return db;
}
const convert = (database: Database) =>
  convertKiteSessionStore11To10({
    database,
    codec,
    isSettledState: (state: State) => state.settled,
    nowMs: 500,
  });
function addSession(
  db: Database,
  status: 'idle' | 'active' = 'idle',
  settled = true,
  withRun = false,
) {
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
    workspaceId: `workspace_${workspaceIdentityDigest.slice(7)}`,
    canonicalPath,
    workspaceIdentityDigest,
    projectId,
    workspaceDigest,
    displayName: 'Conversion',
  };
  const writer = createKiteHomeWriteTransactionPort(db, assertKiteSessionStore11Schema);
  createKiteHomeWorkspaceAdmissionPort({
    database: db,
    writer,
    assertStoreSchema: assertKiteSessionStore11Schema,
  }).admit(workspace);
  const journal = createKiteHomeWorkspaceRuntimeJournal({
    database: db,
    writer,
    assertStoreSchema: assertKiteSessionStore11Schema,
    workspace,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: 'kite-agent-server-api-v1-2026-08-29',
    now: () => 200,
  });
  const state: State = {
    revision: 1,
    settled,
    recoveryIdentity: 'f'.repeat(64),
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
    createdAtMs: 1000,
  };
  const receipt = createRuntimeStoredCommandReceipt(
    {
      scopeSessionId: 'session-1',
      commandId: 'start-1',
      requestDigest: 'a'.repeat(64),
      targetSessionId: 'session-1',
      committedAt: 1000,
      resourceResult: createRuntimeRunStartResourceResult(queued),
    },
    1,
  );
  journal.transactions.commitDecision({
    sessionId: 'session-1',
    events: [{ type: 'message' }],
    metadata: [{ eventId: 'event-1', revision: 1 }],
    snapshot: state,
    ...(withRun
      ? { commandReceipt: receipt, runMutation: { type: 'insert' as const, run: queued } }
      : {}),
  });
  journal.recoveryIdentities.getOrCreate('session-1', () => state.recoveryIdentity);
  db.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(
    'session_execution/session-1',
    JSON.stringify({
      schema: 'kite.session-execution-authority.v1',
      sessionId: 'session-1',
      status,
      controllerGeneration: 1,
      hostInstanceId: status === 'active' ? 'old-host' : null,
      clientId: null,
      connectionGeneration: 0,
      interactionGeneration: 0,
      leaseUntilMs: status === 'active' ? 1000 : null,
      cleanupConfirmed: status === 'idle',
      updatedAt: 200,
      revision: 1,
    }),
  );
  return { state, workspace };
}

describe('bounded Store 11 to 10 conversion', () => {
  test('exact empty source converts to exact current Store', () => {
    using db = source();
    expect(convert(db)).toEqual({ sessions: 0, recoveryRequired: 0 });
    assertKiteSessionStoreSchema(db);
  });

  test('existing Session is readable through current loader and clean authority remains byte-identical', () => {
    using db = source();
    const { state } = addSession(db);
    const raw = db
      .query<{ value: string }, []>(
        "SELECT value FROM kite_meta WHERE key='session_execution/session-1'",
      )
      .get()?.value;
    expect(convert(db)).toEqual({ sessions: 1, recoveryRequired: 0 });
    assertKiteSessionStoreSchema(db);
    expect(
      db
        .query<{ value: string }, []>(
          "SELECT value FROM kite_meta WHERE key='session_execution/session-1'",
        )
        .get()?.value,
    ).toBe(raw);
    const owner = createKiteHomeRuntimeStorageForConnection({
      database: db,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: 10,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: 'kite-agent-server-api-v1-2026-08-29',
      ownsDatabase: false,
    });
    expect(owner.storage.sessions.loadSnapshot<State>('session-1')).toEqual(state);
    expect(owner.storage.sessions.loadEventsStrict('session-1')).toHaveLength(1);
    owner.close();
  });

  test('old active authority is fenced, with Run and State facts retained', () => {
    using db = source();
    const { state } = addSession(db, 'active');
    expect(convert(db)).toEqual({ sessions: 1, recoveryRequired: 1 });
    const authority = createKiteSessionExecutionAuthority({
      database: db,
      writer: createKiteHomeWriteTransactionPort(db, assertKiteSessionStoreSchema),
    }).read('session-1');
    expect(authority).toMatchObject({
      status: 'recovery_required',
      cleanupConfirmed: false,
      controllerGeneration: 2,
      revision: 2,
      hostInstanceId: null,
    });
    const owner = createKiteHomeRuntimeStorageForConnection({
      database: db,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: 10,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: 'kite-agent-server-api-v1-2026-08-29',
      ownsDatabase: false,
    });
    expect(owner.storage.sessions.loadSnapshot<State>('session-1')).toEqual(state);
    owner.close();
  });

  test('idle authority with a queued Run is fenced without changing Run or receipt', () => {
    using db = source();
    addSession(db, 'idle', true, true);
    const runBefore = db
      .query<Record<string, unknown>, []>("SELECT * FROM runtime_runs WHERE run_id='run-1'")
      .get();
    const receiptBefore = db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM runtime_command_receipts WHERE command_id='start-1'",
      )
      .get();
    expect(convert(db)).toEqual({ sessions: 1, recoveryRequired: 1 });
    expect(
      db
        .query<Record<string, unknown>, []>("SELECT * FROM runtime_runs WHERE run_id='run-1'")
        .get(),
    ).toMatchObject({ status: 'queued', started_at_ms: null, finished_at_ms: null });
    expect(
      db
        .query<Record<string, unknown>, []>(
          "SELECT * FROM runtime_command_receipts WHERE command_id='start-1'",
        )
        .get(),
    ).toEqual(receiptBefore);
    expect(runBefore).toMatchObject({ status: 'queued' });
    const authority = createKiteSessionExecutionAuthority({
      database: db,
      writer: createKiteHomeWriteTransactionPort(db, assertKiteSessionStoreSchema),
    }).read('session-1');
    expect(authority.status).toBe('recovery_required');
  });

  test('non-NULL accepted input or nonzero failure count is rejected', () => {
    for (const mutation of [
      "UPDATE runtime_runs SET input_json='{}'",
      "UPDATE runtime_runs SET input_json='{}',preparation_failure_count=1",
    ]) {
      using db = source();
      addSession(db, 'idle', true, true);
      db.run(mutation);
      expect(() => convert(db)).toThrow(KiteStore11ConversionUnsupported);
      assertKiteSessionStore11Schema(db);
      expect(
        db
          .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key='schema_version'")
          .get()?.value,
      ).toBe('11');
    }
  });

  test('schema-11 pre-start terminal Run is not coerced into schema 10', () => {
    using db = source();
    addSession(db, 'idle', true, true);
    db.run(
      "UPDATE runtime_runs SET status='cancelled',finished_at_ms=1000,terminal_json='{}' WHERE run_id='run-1'",
    );
    expect(() => convert(db)).toThrow(KiteStore11ConversionUnsupported);
    assertKiteSessionStore11Schema(db);
    expect(
      db.query<{ status: string }, []>("SELECT status FROM runtime_runs WHERE run_id='run-1'").get()
        ?.status,
    ).toBe('cancelled');
  });

  test('current reader failure after DDL rebuild rolls back the whole transaction', () => {
    using db = source();
    addSession(db, 'idle', true, true);
    db.run(
      "UPDATE runtime_command_receipts SET original_receipt_json='{}' WHERE command_id='start-1'",
    );
    expect(() => convert(db)).toThrow();
    assertKiteSessionStore11Schema(db);
    expect(
      db
        .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key='schema_version'")
        .get()?.value,
    ).toBe('11');
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='runtime_runs_pending_input'",
        )
        .get()?.count,
    ).toBe(1);
  });

  test('unknown source table refuses before any mutation', () => {
    using db = source();
    db.run('CREATE TABLE unknown_data (id INTEGER) STRICT');
    expect(() => convert(db)).toThrow(KiteStore11ConversionUnsupported);
    expect(
      db
        .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key='schema_version'")
        .get()?.value,
    ).toBe('11');
  });

  test('old effect lease is refused without inventing a terminal outcome', () => {
    using db = source();
    addSession(db);
    db.query(`INSERT INTO runtime_effect_leases
      (session_id,effect_id,owner_id,lease_revision,certainty,expires_at_ms,
       controller_generation,host_instance_id,connection_generation,state,updated_at)
      VALUES ('session-1','effect-1','old-host',1,'certain',1000,1,'old-host',0,'prepared',200)`).run();
    expect(() => convert(db)).toThrow(KiteStore11ConversionUnsupported);
    assertKiteSessionStore11Schema(db);
    expect(
      db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_effect_leases').get()
        ?.count,
    ).toBe(1);
  });

  test('unknown source trigger is refused', () => {
    using db = source();
    db.run('CREATE TRIGGER unexpected AFTER INSERT ON kite_meta BEGIN SELECT 1; END');
    expect(() => convert(db)).toThrow(KiteStore11ConversionUnsupported);
    expect(
      db
        .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key='schema_version'")
        .get()?.value,
    ).toBe('11');
  });

  test('unexpected metadata refuses without changing source', () => {
    using db = source();
    db.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('unknown/evidence', 'opaque');
    expect(() => convert(db)).toThrow(KiteStore11ConversionUnsupported);
    assertKiteSessionStore11Schema(db);
  });
});
