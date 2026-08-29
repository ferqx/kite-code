import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
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
import { createSqliteRuntimeCommandReceiptWriter } from '../src/command-receipts';
import { initializeSqliteRuntimeSchema } from '../src/schema';

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
      store.insert(run('run-1', 1, 'planning'));
      store.insert(run('run-2', 2, 'building'));
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
        run('run-1', 1, 'planning'),
      ]);
      expect(store.get('session-1', 'run-2')).toEqual(run('run-2', 2, 'building'));

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
      expect(() =>
        store.transition({
          sessionId: 'session-1',
          runId: 'run-6',
          expectedLastRevision: 6,
          next: { ...current, runId: 'changed', lastRevision: 7 },
        }),
      ).toThrow('identity');
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
      db.run(
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
          createHash('sha256').update(resultJson).digest('hex'),
        ],
      );
      expect(() => assertSqliteRuntimeRunStoreConnection(db, binding)).not.toThrow();
    } finally {
      db.close();
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
