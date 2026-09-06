import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeSnapshotMetadata,
  type RuntimeStoredRun,
  type RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import {
  assertSqliteRuntimeRunStoreConnection,
  assertWorkspaceSqliteRuntimeStoreConnection,
  createSqliteRuntimeRunProfile,
  createSqliteRuntimeRunStore,
  createSqliteWorkspaceRuntimeProfile,
  SQLITE_RUNTIME_RUN_DDL,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_MIGRATION_SOURCE_PROFILE,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SqliteRuntimeCommandReceiptValidationError,
  SqliteRuntimeFormatMismatchError,
} from '../src';
import {
  createSqliteRuntimeCommandReceiptPort,
  createSqliteRuntimeCommandReceiptWriter,
} from '../src/command-receipts';
import { initializeSqliteRuntimeSchema } from '../src/schema';
import { createSqliteRuntimeTransactionPort } from '../src/transaction';

const binding = {
  layoutGeneration: 'generation-run-store-1',
  workerScopeId: 'worker-scope-run-store',
  workspaceIdentityDigest:
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} as const;

describe('Store 8 canonical Runtime Run schema and port', () => {
  test('publishes the exact marker, tables, indexes, columns and foreign key', () => {
    const db = runDatabase();
    try {
      expect(SQLITE_RUNTIME_RUN_DDL).toHaveLength(14);
      expect(SQLITE_RUNTIME_RUN_MIGRATION_SOURCE_PROFILE).toEqual({
        stateSchemaVersion: 27,
        storeSchemaVersion: 7,
        formatEpoch: 'kite-coordinator-workspace-worker-web-v1-2026-08-28',
      });
      expect(meta(db, 'format_version')).toBe(String(SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION));
      expect(meta(db, 'runtime_format_epoch')).toBe(SQLITE_RUNTIME_RUN_FORMAT_EPOCH);
      expect(userObjects(db, 'table')).toEqual([
        'runtime_command_receipts',
        'runtime_effect_leases',
        'runtime_events',
        'runtime_file_preimages',
        'runtime_named_snapshots',
        'runtime_runs',
        'runtime_sessions',
        'runtime_snapshots',
        'runtime_store_meta',
        'session_directory_outbox',
        'session_workspace_tombstone',
      ]);
      expect(userObjects(db, 'index')).toEqual([
        'runtime_events_session_sequence',
        'runtime_file_preimages_position',
        'runtime_runs_session_created_revision',
      ]);
      expect(columns(db, 'runtime_sessions')).toContain('run_index_from_revision');
      expect(columns(db, 'runtime_command_receipts').slice(-3)).toEqual([
        'result_schema',
        'result_json',
        'result_digest',
      ]);
      expect(columns(db, 'runtime_runs')).toEqual([
        'session_id',
        'run_id',
        'origin_session_id',
        'origin_run_id',
        'start_command_id',
        'phase',
        'status',
        'created_revision',
        'last_revision',
        'created_at_ms',
        'started_at_ms',
        'finished_at_ms',
        'terminal_json',
      ]);
      expect(db.query('PRAGMA foreign_key_list(runtime_runs)').all()).toContainEqual(
        expect.objectContaining({
          table: 'runtime_sessions',
          from: 'session_id',
          to: 'session_id',
          on_delete: 'CASCADE',
        }),
      );
      expect(() => assertSqliteRuntimeRunStoreConnection(db, binding)).not.toThrow();
      expect(() => assertWorkspaceSqliteRuntimeStoreConnection(db, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
    } finally {
      db.close();
    }
  });

  test('gets, filters and keyset-pages Runs through the dedicated index', () => {
    const db = runDatabase();
    try {
      insertSession(db, 'session-1', 10, 0);
      const store = createSqliteRuntimeRunStore({ db, workspaceBinding: binding });
      store.insert(completedRun(run('run-1', 1, 'planning')));
      store.insert(completedRun(run('run-2', 2, 'building')));
      store.insert(run('run-3', 3, 'building'));
      insertSession(db, 'session-2', 10, 0);
      store.insert({ ...run('run-1', 1, 'planning'), sessionId: 'session-2' });
      expect(store.get('session-2', 'run-1')).toMatchObject({
        sessionId: 'session-2',
        runId: 'run-1',
      });

      const first = store.list({ sessionId: 'session-1', limit: 2 });
      expect(first.entries.map((entry) => entry.runId)).toEqual(['run-1', 'run-2']);
      expect(first.nextCursor).toEqual({ createdRevision: 2, runId: 'run-2' });
      expect(
        store.list({ sessionId: 'session-1', limit: 2, cursor: first.nextCursor }).entries,
      ).toEqual([run('run-3', 3, 'building')]);
      expect(store.list({ sessionId: 'session-1', phase: 'planning', limit: 10 }).entries).toEqual([
        completedRun(run('run-1', 1, 'planning')),
      ]);
      expect(store.get('session-1', 'run-2')).toEqual(completedRun(run('run-2', 2, 'building')));

      const running = {
        ...run('run-3', 3, 'building'),
        status: 'running' as const,
        lastRevision: 4,
        startedAtMs: 130,
      };
      expect(
        store.transition({
          sessionId: 'session-1',
          runId: 'run-3',
          expectedLastRevision: 3,
          next: running,
        }),
      ).toBe('applied');
      expect(
        store.transition({
          sessionId: 'session-1',
          runId: 'run-3',
          expectedLastRevision: 3,
          next: running,
        }),
      ).toBe('conflict');
      expect(store.get('session-1', 'run-3')).toEqual(running);

      const plan = db
        .query<{ detail: string }, [string, number, number, string, number]>(
          `EXPLAIN QUERY PLAN SELECT run_id FROM runtime_runs
           WHERE session_id = ? AND (created_revision > ? OR
             (created_revision = ? AND run_id > ?))
           ORDER BY created_revision ASC, run_id ASC LIMIT ?`,
        )
        .all('session-1', 0, 0, '', 10)
        .map((row) => row.detail)
        .join(' ');
      expect(plan).toContain('runtime_runs_session_created_revision');
      expect(plan.toLowerCase()).not.toContain('runtime_events');
    } finally {
      db.close();
    }
  });

  test('enforces coverage, lifecycle constraints and exact transition identity', () => {
    const db = runDatabase();
    try {
      insertSession(db, 'session-1', 10, 5);
      const store = createSqliteRuntimeRunStore({ db, workspaceBinding: binding });
      expect(() => store.insert(run('covered-history', 5, 'building'))).toThrow('coverage');
      expect(() =>
        store.insert({ ...run('bad-running', 6, 'building'), status: 'running' }),
      ).toThrow('started time');
      const current = run('run-6', 6, 'building');
      store.insert(current);
      expect(() => store.insert(run('run-7', 7, 'building'))).toThrow('already has active Run');
      expect(() =>
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 6,
          next: { ...current, runId: 'changed', lastRevision: 7 },
        }),
      ).toThrow('identity');
      expect(() =>
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 6,
          next: completedRun(current),
        }),
      ).toThrow('reuse a revision');
      const running = {
        ...current,
        status: 'running' as const,
        startedAtMs: current.createdAtMs + 1,
      };
      expect(
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 6,
          next: running,
        }),
      ).toBe('applied');
      expect(
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 6,
          next: { ...running, lastRevision: 7 },
        }),
      ).toBe('applied');
      expect(() =>
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 7,
          next: {
            ...running,
            status: 'waiting',
            lastRevision: 8,
            startedAtMs: running.startedAtMs + 1,
          },
        }),
      ).toThrow('durable timestamp');
      expect(
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 7,
          next: completedRun({ ...running, lastRevision: 8 }),
        }),
      ).toBe('applied');
      expect(() =>
        store.insert({ ...run('run-7', 7, 'building'), startCommandId: 'command-run-6' }),
      ).toThrow();
      db.run("UPDATE runtime_sessions SET worker_scope_id = 'wrong-scope' WHERE session_id = ?", [
        'session-1',
      ]);
      expect(() => store.get('session-1', 'run-6')).toThrow('coverage');
    } finally {
      db.close();
    }
  });

  test('rejects Store 7 as a writer target and refuses resource results on its receipt writer', () => {
    const db = new Database(':memory:');
    try {
      initializeSqliteRuntimeSchema(db, createSqliteWorkspaceRuntimeProfile(binding));
      expect(() => assertSqliteRuntimeRunStoreConnection(db, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
      insertSession(db, 'session-1', 1);
      const json = '{"run_id":"run-1","schema":"kite.runtime.run-result.v1"}';
      const receipt = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'session-1',
          commandId: 'command-1',
          requestDigest: 'a'.repeat(64),
          targetSessionId: 'session-1',
          committedAt: 100,
          resourceResult: {
            schema: 'kite.runtime.run-result.v1',
            json,
            digest: createHash('sha256').update(json).digest('hex'),
          },
        },
        1,
      );
      expect(() =>
        createSqliteRuntimeCommandReceiptWriter({ db, workspaceBinding: binding }).insert(
          receipt,
          'session-1',
          1,
        ),
      ).toThrow(SqliteRuntimeCommandReceiptValidationError);
    } finally {
      db.close();
    }
  });

  test('accepts one complete digest-bound Store 8 receipt resource result', () => {
    const db = runDatabase();
    try {
      insertSession(db, 'session-1', 1);
      const resultJson = '{"run_id":"run-1","schema":"kite.runtime.run-result.v1"}';
      const receipt = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'session-1',
          commandId: 'command-result',
          requestDigest: 'a'.repeat(64),
          targetSessionId: 'session-1',
          committedAt: 100,
          resourceResult: {
            schema: 'kite.runtime.run-result.v1',
            json: resultJson,
            digest: createHash('sha256').update(resultJson).digest('hex'),
          },
        },
        1,
      );
      createSqliteRuntimeCommandReceiptWriter({
        db,
        workspaceBinding: binding,
        resourceResults: true,
      }).insert(receipt, 'session-1', 1);
      expect(
        createSqliteRuntimeCommandReceiptPort({
          db,
          isClosed: () => false,
          workspaceBinding: binding,
          resourceResults: true,
        }).lookup({
          scopeSessionId: 'session-1',
          commandId: 'command-result',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
      expect(() => assertSqliteRuntimeRunStoreConnection(db, binding)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('atomically commits and rolls back State, event, snapshot, Run and resource receipt', () => {
    const success = runDatabase();
    try {
      insertSession(success, 'session-1', 0);
      const harness = transactionHarness(success);
      harness.transactions.commitDecision(startTransaction(1));

      expect(rowCount(success, 'runtime_events')).toBe(1);
      expect(rowCount(success, 'runtime_snapshots')).toBe(1);
      expect(rowCount(success, 'runtime_runs')).toBe(1);
      expect(rowCount(success, 'runtime_command_receipts')).toBe(1);
      expect(
        createSqliteRuntimeCommandReceiptPort({
          db: success,
          isClosed: () => false,
          workspaceBinding: binding,
          resourceResults: true,
        }).lookup({
          scopeSessionId: 'session-1',
          commandId: 'command-start',
          requestDigest: 'a'.repeat(64),
        }),
      ).toMatchObject({
        status: 'replay',
        receipt: {
          resourceResult: { schema: 'kite.runtime.run-resource-result.v1' },
        },
      });
      expect(() => assertSqliteRuntimeRunStoreConnection(success, binding)).not.toThrow();
      const mismatchedJson = resultJson('run-other', 1);
      success.run(
        `UPDATE runtime_command_receipts
         SET result_json = ?, result_digest = ?
         WHERE scope_session_id = ? AND command_id = ?`,
        [
          mismatchedJson,
          createHash('sha256').update(mismatchedJson).digest('hex'),
          'session-1',
          'command-start',
        ],
      );
      expect(() => assertSqliteRuntimeRunStoreConnection(success, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
    } finally {
      success.close();
    }

    const rollback = runDatabase();
    try {
      insertSession(rollback, 'session-1', 0);
      const harness = transactionHarness(rollback, true);
      expect(() => harness.transactions.commitDecision(startTransaction(1))).toThrow(
        'injected Run write failure',
      );
      expect(rowCount(rollback, 'runtime_events')).toBe(0);
      expect(rowCount(rollback, 'runtime_snapshots')).toBe(0);
      expect(rowCount(rollback, 'runtime_runs')).toBe(0);
      expect(rowCount(rollback, 'runtime_command_receipts')).toBe(0);
      expect(
        rollback
          .query<{ revision: number }, [string]>(
            'SELECT revision FROM runtime_sessions WHERE session_id = ?',
          )
          .get('session-1')?.revision,
      ).toBe(0);
    } finally {
      rollback.close();
    }
  });

  test('preflight rejects unknown or missing DDL', () => {
    const extra = runDatabase();
    try {
      extra.run('CREATE TABLE unexpected_authority (value TEXT)');
      expect(() => assertSqliteRuntimeRunStoreConnection(extra, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
    } finally {
      extra.close();
    }

    const missing = runDatabase();
    try {
      missing.run('DROP INDEX runtime_runs_session_created_revision');
      expect(() => assertSqliteRuntimeRunStoreConnection(missing, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
    } finally {
      missing.close();
    }
  });

  test('reopen preflight refuses more than one active Run in a Session', () => {
    const db = runDatabase();
    try {
      insertSession(db, 'session-1', 10);
      insertRawRun(db, {
        ...run('active-1', 1, 'building'),
        originSessionId: 'source',
        originRunId: 'active-1',
      });
      insertRawRun(db, {
        ...run('active-2', 2, 'building'),
        originSessionId: 'source',
        originRunId: 'active-2',
      });
      expect(() => assertSqliteRuntimeRunStoreConnection(db, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
    } finally {
      db.close();
    }
  });

  test('maintains only complete Run boundaries for rewind and fork', () => {
    const db = runDatabase();
    try {
      insertSession(db, 'source', 10, 5);
      insertSession(db, 'target', 7, 0);
      const store = createSqliteRuntimeRunStore({ db, workspaceBinding: binding });
      const sourceRun = completedRun({
        ...run('run-6', 6, 'building'),
        sessionId: 'source',
        lastRevision: 7,
      });
      store.insert(sourceRun);

      expect(
        store.forkSession({
          sourceSessionId: 'source',
          targetSessionId: 'target',
          throughRevision: 7,
        }),
      ).toEqual({ status: 'applied', copiedCount: 1 });
      expect(store.get('target', 'run-6')).toMatchObject({
        sessionId: 'target',
        originSessionId: 'source',
        originRunId: 'run-6',
      });
      expect(
        db
          .query<{ boundary: number }, [string]>(
            'SELECT run_index_from_revision AS boundary FROM runtime_sessions WHERE session_id = ?',
          )
          .get('target')?.boundary,
      ).toBe(5);

      const unknown: RuntimeStoredRun = {
        ...run('run-8', 8, 'building'),
        sessionId: 'source',
        status: 'unknown',
        startedAtMs: 181,
        finishedAtMs: 182,
        terminal: {
          reasonCode: 'outcome_unknown',
          safeRetry: false,
          recoveryEntry: 'reconcile',
        },
      };
      store.insert(unknown);
      insertSession(db, 'unknown-target', 8, 0);
      expect(
        store.forkSession({
          sourceSessionId: 'source',
          targetSessionId: 'unknown-target',
          throughRevision: 8,
        }),
      ).toEqual({ status: 'invalid_boundary' });
      expect(store.rewindSession('source', 8)).toEqual({ status: 'invalid_boundary' });
      expect(store.rewindSession('source', 7)).toEqual({ status: 'applied', deletedCount: 1 });
      expect(store.get('source', 'run-8')).toBeNull();

      insertSession(db, 'partial', 10, 5);
      store.insert(
        completedRun({
          ...run('partial-run', 6, 'planning'),
          sessionId: 'partial',
          lastRevision: 8,
        }),
      );
      expect(store.rewindSession('partial', 7)).toEqual({ status: 'invalid_boundary' });
      expect(store.rewindSession('partial', 4)).toEqual({ status: 'invalid_boundary' });
    } finally {
      db.close();
    }
  });

  test('leaves no target facts when Store 8 fork maintenance faults', () => {
    const db = runDatabase();
    try {
      insertSession(db, 'source', 7, 5);
      insertSession(db, 'target', 7, 0);
      const writer = createSqliteRuntimeRunStore({ db, workspaceBinding: binding });
      writer.insert(
        completedRun({
          ...run('run-6', 6, 'building'),
          sessionId: 'source',
          originSessionId: 'history',
          originRunId: 'run-6',
          lastRevision: 7,
        }),
      );
      const faulting = createSqliteRuntimeRunStore({
        db,
        workspaceBinding: binding,
        beforeWrite: () => {
          throw new Error('injected maintenance failure');
        },
      });

      db.run('BEGIN IMMEDIATE');
      try {
        db.run("UPDATE runtime_sessions SET name = 'partial' WHERE session_id = 'target'");
        faulting.forkSession({
          sourceSessionId: 'source',
          targetSessionId: 'target',
          throughRevision: 7,
        });
        throw new Error('expected maintenance fault');
      } catch (error) {
        db.run('ROLLBACK');
        expect(String(error)).toContain('injected maintenance failure');
      }
      expect(storeSession(db, 'target')).toEqual({ name: '', boundary: 0 });
      expect(writer.list({ sessionId: 'target', limit: 10 }).entries).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('preflight rejects malformed terminal detail and resource result drift independently', () => {
    const malformed = runDatabase();
    try {
      insertSession(malformed, 'session-1', 10, 0);
      malformed.run(
        `INSERT INTO runtime_runs (
          session_id, run_id, start_command_id, phase, status, created_revision,
          last_revision, created_at_ms, started_at_ms, finished_at_ms, terminal_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'session-1',
          'run-1',
          'command-1',
          'building',
          'failed',
          1,
          2,
          100,
          110,
          120,
          '{"reason_code":"failed","safe_retry":false,"recovery_entry":"retry","extra":true}',
        ],
      );
      expect(() => assertSqliteRuntimeRunStoreConnection(malformed, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
    } finally {
      malformed.close();
    }

    const resultDrift = runDatabase();
    try {
      insertSession(resultDrift, 'session-1', 10, 0);
      const resultJson = '{"run_id":"run-1","schema":"kite.runtime.run-result.v1"}';
      resultDrift.run(
        `INSERT INTO runtime_command_receipts (
          scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
          request_digest, target_session_id, original_receipt_json, committed_revision,
          committed_at, result_schema, result_json, result_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'session-1',
          'command-result',
          binding.workerScopeId,
          'project-1',
          'workspace-digest-1',
          'a'.repeat(64),
          'session-1',
          '{"status":"applied","commandId":"command-result","sessionId":"session-1","revision":1}',
          1,
          100,
          'kite.runtime.run-result.v1',
          resultJson,
          '0'.repeat(64),
        ],
      );
      expect(() => assertSqliteRuntimeRunStoreConnection(resultDrift, binding)).toThrow(
        SqliteRuntimeFormatMismatchError,
      );
      expect(() =>
        resultDrift.run(
          `INSERT INTO runtime_command_receipts (
            scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
            request_digest, target_session_id, original_receipt_json, committed_revision,
            committed_at, result_schema
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'session-1',
            'partial-result',
            binding.workerScopeId,
            'project-1',
            'workspace-digest-1',
            'b'.repeat(64),
            'session-1',
            '{"status":"applied","commandId":"partial-result","sessionId":"session-1","revision":1}',
            1,
            100,
            'kite.runtime.run-result.v1',
          ],
        ),
      ).toThrow();
    } finally {
      resultDrift.close();
    }
  });
});

function runDatabase(): Database {
  const db = new Database(':memory:');
  initializeSqliteRuntimeSchema(db, createSqliteRuntimeRunProfile(binding));
  return db;
}

function insertSession(db: Database, sessionId: string, revision: number, boundary = 0): void {
  const hasBoundary = columns(db, 'runtime_sessions').includes('run_index_from_revision');
  db.run(
    hasBoundary
      ? `INSERT INTO runtime_sessions (
          session_id, project_id, workspace_digest, worker_scope_id,
          workspace_identity_digest, state_schema, format_epoch, revision,
          run_index_from_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO runtime_sessions (
          session_id, project_id, workspace_digest, worker_scope_id,
          workspace_identity_digest, state_schema, format_epoch, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      'project-1',
      'workspace-digest-1',
      binding.workerScopeId,
      binding.workspaceIdentityDigest,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      hasBoundary
        ? SQLITE_RUNTIME_RUN_FORMAT_EPOCH
        : 'kite-coordinator-workspace-worker-web-v1-2026-08-28',
      revision,
      ...(hasBoundary ? [boundary] : []),
    ],
  );
}

function run(
  runId: string,
  createdRevision: number,
  phase: RuntimeStoredRun['phase'],
): RuntimeStoredRun {
  return {
    sessionId: 'session-1',
    runId,
    startCommandId: `command-${runId}`,
    phase,
    status: 'queued',
    createdRevision,
    lastRevision: createdRevision,
    createdAtMs: 100 + createdRevision * 10,
  };
}

function completedRun(value: RuntimeStoredRun): RuntimeStoredRun {
  return {
    ...value,
    status: 'completed',
    startedAtMs: value.createdAtMs + 1,
    finishedAtMs: value.createdAtMs + 2,
    terminal: { reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' },
  };
}

function insertRawRun(db: Database, value: RuntimeStoredRun): void {
  db.run(
    `INSERT INTO runtime_runs (
      session_id, run_id, origin_session_id, origin_run_id, start_command_id,
      phase, status, created_revision, last_revision, created_at_ms,
      started_at_ms, finished_at_ms, terminal_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.sessionId,
      value.runId,
      value.originSessionId ?? null,
      value.originRunId ?? null,
      value.startCommandId,
      value.phase,
      value.status,
      value.createdRevision,
      value.lastRevision,
      value.createdAtMs,
      value.startedAtMs ?? null,
      value.finishedAtMs ?? null,
      null,
    ],
  );
}

function startTransaction(
  revision: number,
): RuntimeTransactionInput<{ type: string }, { revision: number }> {
  const resourceJson = resultJson('run-start', revision);
  const receipt = createRuntimeStoredCommandReceipt(
    {
      scopeSessionId: 'session-1',
      commandId: 'command-start',
      requestDigest: 'a'.repeat(64),
      targetSessionId: 'session-1',
      committedAt: 100,
      resourceResult: {
        schema: 'kite.runtime.run-resource-result.v1',
        json: resourceJson,
        digest: createHash('sha256').update(resourceJson).digest('hex'),
      },
    },
    revision,
  );
  return {
    sessionId: 'session-1',
    events: [{ type: 'turn.started' }],
    snapshot: { revision },
    metadata: [
      {
        eventId: `event-${revision}`,
        revision,
        occurredAt: '2026-08-30T00:00:00.000Z',
      },
    ],
    commandReceipt: receipt,
    runMutation: {
      type: 'insert',
      run: {
        sessionId: 'session-1',
        runId: 'run-start',
        startCommandId: 'command-start',
        phase: 'building',
        status: 'queued',
        createdRevision: revision,
        lastRevision: revision,
        createdAtMs: 100,
      },
    },
  };
}

function resultJson(runId: string, revision: number): string {
  return JSON.stringify({
    schema: 'kite.runtime.run-resource-result.v1',
    run: {
      schema: 'kite.runtime-run.v1',
      sessionId: 'session-1',
      runId,
      phase: 'building',
      status: 'queued',
      createdRevision: revision,
      lastRevision: revision,
      createdAtMs: 100,
    },
  });
}

function transactionHarness(db: Database, failRunWrite = false) {
  const runStore = createSqliteRuntimeRunStore({
    db,
    workspaceBinding: binding,
    beforeWrite: () => {
      if (failRunWrite) throw new Error('injected Run write failure');
    },
  });
  const receiptWriter = createSqliteRuntimeCommandReceiptWriter({
    db,
    workspaceBinding: binding,
    resourceResults: true,
  });
  const lastEventPosition = (sessionId: string): number =>
    db
      .query<{ position: number | null }, [string]>(
        'SELECT MAX(sequence) AS position FROM runtime_events WHERE session_id = ?',
      )
      .get(sessionId)?.position ?? 0;
  const transactions = createSqliteRuntimeTransactionPort<{ type: string }, { revision: number }>({
    db,
    isClosed: () => false,
    hasEffectLease: () => true,
    readSnapshotBoundary: (sessionId) =>
      db
        .query<
          {
            event_position: number;
            state_revision: number;
            state_checksum: string;
            schema_version: number;
          },
          [string]
        >(
          'SELECT event_position, revision AS state_revision, state_checksum, schema_version FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
        )
        .get(sessionId) ?? null,
    readSnapshotRevision: (sessionId) =>
      db
        .query<{ revision: number }, [string]>(
          'SELECT revision FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
        )
        .get(sessionId)?.revision ?? null,
    lastEventPosition,
    ensureSession: () => undefined,
    insertEvents: (sessionId, events, metadata = []) => {
      const insert = db.query(
        `INSERT INTO runtime_events (
          session_id, event_id, sequence, schema_version, event_json,
          causation_id, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      events.forEach((event, index) => {
        const entry = metadata[index]!;
        insert.run(
          sessionId,
          entry.eventId,
          lastEventPosition(sessionId) + 1,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          JSON.stringify(event),
          entry.causationId ?? null,
          entry.occurredAt ?? null,
          100,
        );
      });
    },
    encodeSnapshot: (state, explicit) => ({
      json: JSON.stringify(state),
      metadata:
        explicit ??
        ({
          eventPosition: 0,
          stateRevision: state.revision,
          stateChecksum: `checksum-${state.revision}`,
          schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        } satisfies RuntimeSnapshotMetadata),
    }),
    persistSnapshot: (
      sessionId,
      json,
      eventPosition,
      stateRevision,
      stateChecksum,
      schemaVersion,
    ) => {
      db.run(
        `INSERT OR REPLACE INTO runtime_snapshots (
          session_id, schema_version, format_epoch, revision, state_json,
          event_position, state_checksum, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          schemaVersion,
          SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
          stateRevision,
          json,
          eventPosition,
          stateChecksum,
          100,
        ],
      );
      db.run('UPDATE runtime_sessions SET revision = ? WHERE session_id = ?', [
        stateRevision,
        sessionId,
      ]);
    },
    readSessionBinding: (sessionId) =>
      db
        .query<{ workerScopeId: string; projectId: string; workspaceDigest: string }, [string]>(
          'SELECT worker_scope_id AS workerScopeId, project_id AS projectId, workspace_digest AS workspaceDigest FROM runtime_sessions WHERE session_id = ? LIMIT 1',
        )
        .get(sessionId) ?? null,
    receiptWriter,
    runStore,
  });
  return { transactions, runStore };
}

function rowCount(db: Database, table: string): number {
  return (
    db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0
  );
}

function storeSession(
  db: Database,
  sessionId: string,
): { readonly name: string; readonly boundary: number } | null {
  return db
    .query<{ name: string; boundary: number }, [string]>(
      'SELECT name, run_index_from_revision AS boundary FROM runtime_sessions WHERE session_id = ?',
    )
    .get(sessionId);
}

function meta(db: Database, key: string): string | undefined {
  return db
    .query<{ value: string }, [string]>('SELECT value FROM runtime_store_meta WHERE key = ?')
    .get(key)?.value;
}

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function userObjects(db: Database, type: 'table' | 'index'): string[] {
  return db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => row.name);
}
