import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  assertRuntimeRunStartResourceResult,
  assertRuntimeStoredCommandResourceResult,
  assertRuntimeStoredRun,
  decodeRuntimeRunTerminal,
  encodeRuntimeRunTerminal,
  type RuntimeRunPageRequest,
  type RuntimeRunStorePort,
  type RuntimeRunTransition,
  type RuntimeStoredCommandResourceResult,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import {
  assertSqliteRuntimeWorkspaceBinding,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SqliteRuntimeFormatMismatchError,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  runtime_store_meta: ['key', 'value'],
  runtime_events: [
    'session_id',
    'event_id',
    'sequence',
    'schema_version',
    'event_json',
    'causation_id',
    'occurred_at',
    'created_at',
  ],
  runtime_sessions: [
    'session_id',
    'project_id',
    'workspace_digest',
    'worker_scope_id',
    'workspace_identity_digest',
    'state_schema',
    'format_epoch',
    'revision',
    'name',
    'model_provider',
    'model_name',
    'updated_at',
    'run_index_from_revision',
  ],
  runtime_snapshots: [
    'session_id',
    'schema_version',
    'format_epoch',
    'revision',
    'state_json',
    'event_position',
    'state_checksum',
    'created_at',
  ],
  runtime_named_snapshots: [
    'session_id',
    'name',
    'schema_version',
    'format_epoch',
    'revision',
    'state_json',
    'event_position',
    'state_checksum',
    'created_at',
  ],
  runtime_file_preimages: [
    'session_id',
    'path',
    'event_position',
    'content',
    'existed',
    'post_hash',
    'post_existed',
    'created_at',
  ],
  runtime_effect_leases: [
    'session_id',
    'effect_id',
    'owner_id',
    'lease_revision',
    'certainty',
    'expires_at_ms',
  ],
  runtime_command_receipts: [
    'scope_session_id',
    'command_id',
    'worker_scope_id',
    'project_id',
    'workspace_digest',
    'request_digest',
    'target_session_id',
    'original_receipt_json',
    'committed_revision',
    'committed_at',
    'result_schema',
    'result_json',
    'result_digest',
  ],
  session_workspace_tombstone: [
    'session_id',
    'worker_scope_id',
    'project_id',
    'workspace_digest',
    'deleted_revision',
    'deleted_at',
  ],
  session_directory_outbox: [
    'session_id',
    'worker_scope_id',
    'revision',
    'updated_at',
    'tombstone',
  ],
  runtime_runs: [
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
  ],
});

const INDEXES = [
  'runtime_events_session_sequence',
  'runtime_file_preimages_position',
  'runtime_runs_session_created_revision',
] as const;

interface RunRow {
  readonly session_id: string;
  readonly run_id: string;
  readonly origin_session_id: string | null;
  readonly origin_run_id: string | null;
  readonly start_command_id: string;
  readonly phase: RuntimeStoredRun['phase'];
  readonly status: RuntimeStoredRun['status'];
  readonly created_revision: number;
  readonly last_revision: number;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly finished_at_ms: number | null;
  readonly terminal_json: string | null;
}

interface RunSessionRow {
  readonly revision: number;
  readonly run_index_from_revision: number;
  readonly worker_scope_id: string;
  readonly workspace_identity_digest: string;
  readonly state_schema: number;
  readonly format_epoch: string;
}

export interface SqliteRuntimeRunStoreInput {
  readonly db: Database;
  readonly workspaceBinding: SqliteRuntimeWorkspaceBinding;
  readonly isClosed?: () => boolean;
  readonly beforeWrite?: () => void;
}

export function createSqliteRuntimeRunStore(
  input: SqliteRuntimeRunStoreInput,
): RuntimeRunStorePort {
  assertSqliteRuntimeRunStoreConnection(input.db, input.workspaceBinding);
  const selectSession = input.db.query<RunSessionRow, [string]>(
    'SELECT revision, run_index_from_revision, worker_scope_id, workspace_identity_digest, state_schema, format_epoch FROM runtime_sessions WHERE session_id = ? LIMIT 1',
  );
  const getRun = input.db.query<RunRow, [string, string]>(
    'SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id, phase, status, created_revision, last_revision, created_at_ms, started_at_ms, finished_at_ms, terminal_json FROM runtime_runs WHERE session_id = ? AND run_id = ? LIMIT 1',
  );
  const getActiveRun = input.db.query<{ run_id: string }, [string]>(
    "SELECT run_id FROM runtime_runs WHERE session_id = ? AND status IN ('queued', 'running', 'waiting') LIMIT 1",
  );
  const insertRun = input.db.query(
    `INSERT INTO runtime_runs (
      session_id, run_id, origin_session_id, origin_run_id, start_command_id,
      phase, status, created_revision, last_revision, created_at_ms,
      started_at_ms, finished_at_ms, terminal_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRun = input.db.query(
    `UPDATE runtime_runs SET status = ?, last_revision = ?, started_at_ms = ?,
      finished_at_ms = ?, terminal_json = ?
      WHERE session_id = ? AND run_id = ? AND last_revision = ?`,
  );
  const port: RuntimeRunStorePort = {
    get(sessionId, runId) {
      assertOpen(input);
      assertIdentity(sessionId, 'Session');
      assertIdentity(runId, 'Run');
      const row = getRun.get(sessionId, runId);
      if (!row) return null;
      const run = runFromRow(row);
      assertRunWithinSession(selectSession.get(sessionId), run, input.workspaceBinding);
      return run;
    },
    list(request) {
      assertOpen(input);
      assertPageRequest(request);
      const filters = ['session_id = ?'];
      const values: (string | number)[] = [request.sessionId];
      if (request.status !== undefined) {
        filters.push('status = ?');
        values.push(request.status);
      }
      if (request.phase !== undefined) {
        filters.push('phase = ?');
        values.push(request.phase);
      }
      if (request.cursor !== undefined) {
        filters.push('(created_revision > ? OR (created_revision = ? AND run_id > ?))');
        values.push(
          request.cursor.createdRevision,
          request.cursor.createdRevision,
          request.cursor.runId,
        );
      }
      values.push(request.limit + 1);
      const rows = input.db
        .query<RunRow, (string | number)[]>(
          `SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id,
            phase, status, created_revision, last_revision, created_at_ms,
            started_at_ms, finished_at_ms, terminal_json
           FROM runtime_runs WHERE ${filters.join(' AND ')}
           ORDER BY created_revision ASC, run_id ASC LIMIT ?`,
        )
        .all(...values);
      const hasMore = rows.length > request.limit;
      const entries = rows.slice(0, request.limit).map(runFromRow);
      const session = entries.length > 0 ? selectSession.get(request.sessionId) : null;
      for (const run of entries) {
        assertRunWithinSession(session, run, input.workspaceBinding);
      }
      const last = entries.at(-1);
      return {
        entries,
        hasMore,
        ...(hasMore && last
          ? { nextCursor: { createdRevision: last.createdRevision, runId: last.runId } }
          : {}),
      };
    },
    insert(run) {
      assertOpen(input);
      assertRuntimeStoredRun(run);
      assertRunWithinSession(selectSession.get(run.sessionId), run, input.workspaceBinding);
      const active = getActiveRun.get(run.sessionId);
      if (active && active.run_id !== run.runId) {
        throw new Error(
          `Runtime Session ${run.sessionId} already has active Run ${active.run_id}.`,
        );
      }
      input.beforeWrite?.();
      insertRun.run(
        run.sessionId,
        run.runId,
        run.originSessionId ?? null,
        run.originRunId ?? null,
        run.startCommandId,
        run.phase,
        run.status,
        run.createdRevision,
        run.lastRevision,
        run.createdAtMs,
        run.startedAtMs ?? null,
        run.finishedAtMs ?? null,
        run.terminal ? encodeRuntimeRunTerminal(run.terminal) : null,
      );
    },
    transition(transition) {
      assertOpen(input);
      assertTransition(transition);
      const current = getRun.get(transition.sessionId, transition.runId);
      if (!current) return 'missing';
      if (current.last_revision !== transition.expectedLastRevision) return 'conflict';
      const existing = runFromRow(current);
      assertImmutableRunIdentity(existing, transition.next);
      assertRunWithinSession(
        selectSession.get(transition.sessionId),
        transition.next,
        input.workspaceBinding,
      );
      input.beforeWrite?.();
      const result = updateRun.run(
        transition.next.status,
        transition.next.lastRevision,
        transition.next.startedAtMs ?? null,
        transition.next.finishedAtMs ?? null,
        transition.next.terminal ? encodeRuntimeRunTerminal(transition.next.terminal) : null,
        transition.sessionId,
        transition.runId,
        transition.expectedLastRevision,
      );
      return result.changes === 1 ? 'applied' : 'conflict';
    },
  };
  return Object.freeze(port);
}

/** Exact Store 8 marker, DDL, binding and closed row validation. */
export function assertSqliteRuntimeRunStoreConnection(
  db: Database,
  binding: SqliteRuntimeWorkspaceBinding,
): ReadonlyMap<string, string> {
  assertSqliteRuntimeWorkspaceBinding(binding);
  const markerRows = db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM runtime_store_meta WHERE key IN ('format_version', 'runtime_format_epoch', 'layout_generation', 'worker_scope_id', 'workspace_identity_digest')",
    )
    .all();
  const marker = new Map(markerRows.map((entry) => [entry.key, entry.value]));
  if (
    Number(marker.get('format_version')) !== SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION ||
    marker.get('runtime_format_epoch') !== SQLITE_RUNTIME_RUN_FORMAT_EPOCH ||
    marker.get('layout_generation') !== binding.layoutGeneration ||
    marker.get('worker_scope_id') !== binding.workerScopeId ||
    marker.get('workspace_identity_digest') !== binding.workspaceIdentityDigest
  ) {
    throw formatMismatch(marker);
  }
  assertExactSchema(db);
  assertBoundRows(db, binding);
  return marker;
}

function assertExactSchema(db: Database): void {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const expectedTables = Object.keys(TABLE_COLUMNS).sort();
  if (
    tables.length !== expectedTables.length ||
    tables.some((table, index) => table !== expectedTables[index])
  ) {
    throw new SqliteRuntimeFormatMismatchError(null, null);
  }
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => column !== expected[index])
    ) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
  }
  const indexes = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  if (indexes.length !== INDEXES.length || indexes.some((name, index) => name !== INDEXES[index])) {
    throw new SqliteRuntimeFormatMismatchError(null, null);
  }
  const foreignKeys = db
    .query<{ table: string; from: string; to: string; on_delete: string }, []>(
      'PRAGMA foreign_key_list(runtime_runs)',
    )
    .all();
  if (
    foreignKeys.length !== 1 ||
    foreignKeys[0]?.table !== 'runtime_sessions' ||
    foreignKeys[0].from !== 'session_id' ||
    foreignKeys[0].to !== 'session_id' ||
    foreignKeys[0].on_delete.toUpperCase() !== 'CASCADE'
  ) {
    throw new SqliteRuntimeFormatMismatchError(null, null);
  }
}

function assertBoundRows(db: Database, binding: SqliteRuntimeWorkspaceBinding): void {
  const sessions = db
    .query<
      {
        session_id: string;
        project_id: string;
        workspace_digest: string;
        worker_scope_id: string;
        workspace_identity_digest: string;
        state_schema: number;
        format_epoch: string;
        revision: number;
        run_index_from_revision: number;
      },
      []
    >(
      'SELECT session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision, run_index_from_revision FROM runtime_sessions',
    )
    .all();
  const sessionRows = new Map(sessions.map((session) => [session.session_id, session]));
  for (const session of sessions) {
    if (
      !session.session_id ||
      !session.project_id ||
      !session.workspace_digest ||
      session.worker_scope_id !== binding.workerScopeId ||
      session.workspace_identity_digest !== binding.workspaceIdentityDigest ||
      session.state_schema !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
      session.format_epoch !== SQLITE_RUNTIME_RUN_FORMAT_EPOCH ||
      !Number.isSafeInteger(session.revision) ||
      !Number.isSafeInteger(session.run_index_from_revision) ||
      session.run_index_from_revision < 0 ||
      session.run_index_from_revision > session.revision
    ) {
      throw new SqliteRuntimeFormatMismatchError(session.state_schema, session.format_epoch);
    }
  }
  const tombstones = db
    .query<
      {
        session_id: string;
        worker_scope_id: string;
        project_id: string;
        workspace_digest: string;
        deleted_revision: number;
        deleted_at: number;
      },
      []
    >(
      'SELECT session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at FROM session_workspace_tombstone',
    )
    .all();
  const tombstoneRows = new Map(tombstones.map((tombstone) => [tombstone.session_id, tombstone]));
  for (const tombstone of tombstones) {
    if (
      !tombstone.session_id ||
      tombstone.worker_scope_id !== binding.workerScopeId ||
      !tombstone.project_id ||
      !tombstone.workspace_digest ||
      !Number.isSafeInteger(tombstone.deleted_revision) ||
      tombstone.deleted_revision < 0 ||
      !Number.isSafeInteger(tombstone.deleted_at) ||
      tombstone.deleted_at < 0 ||
      sessionRows.has(tombstone.session_id)
    ) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
  }
  const outbox = db
    .query<
      {
        session_id: string;
        worker_scope_id: string;
        revision: number;
        updated_at: number;
        tombstone: number;
      },
      []
    >(
      'SELECT session_id, worker_scope_id, revision, updated_at, tombstone FROM session_directory_outbox',
    )
    .all();
  for (const entry of outbox) {
    if (
      !entry.session_id ||
      entry.worker_scope_id !== binding.workerScopeId ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      !Number.isSafeInteger(entry.updated_at) ||
      ![0, 1].includes(entry.tombstone) ||
      (!sessionRows.has(entry.session_id) && !tombstoneRows.has(entry.session_id))
    ) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
  }
  const runs = db
    .query<RunRow, []>(
      'SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id, phase, status, created_revision, last_revision, created_at_ms, started_at_ms, finished_at_ms, terminal_json FROM runtime_runs',
    )
    .all();
  const currentStartRuns = new Map<string, RuntimeStoredRun>();
  const activeRunSessions = new Set<string>();
  for (const row of runs) {
    let run: RuntimeStoredRun;
    try {
      run = runFromRow(row);
    } catch {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
    const session = sessionRows.get(run.sessionId);
    if (
      !session ||
      run.createdRevision <= session.run_index_from_revision ||
      run.lastRevision > session.revision
    ) {
      throw new SqliteRuntimeFormatMismatchError(
        SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
        SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      );
    }
    if (run.originSessionId === undefined) {
      currentStartRuns.set(`${run.sessionId}\0${run.startCommandId}`, run);
    }
    if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') {
      if (activeRunSessions.has(run.sessionId)) {
        throw new SqliteRuntimeFormatMismatchError(
          SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
          SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
        );
      }
      activeRunSessions.add(run.sessionId);
    }
  }
  const receipts = db
    .query<
      {
        scope_session_id: string;
        command_id: string;
        worker_scope_id: string;
        project_id: string;
        workspace_digest: string;
        request_digest: string;
        target_session_id: string;
        original_receipt_json: string;
        committed_revision: number;
        committed_at: number;
        result_schema: string | null;
        result_json: string | null;
        result_digest: string | null;
      },
      []
    >(
      'SELECT scope_session_id, command_id, worker_scope_id, project_id, workspace_digest, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at, result_schema, result_json, result_digest FROM runtime_command_receipts',
    )
    .all();
  for (const row of receipts) {
    const owner =
      sessionRows.get(row.target_session_id) ?? tombstoneRows.get(row.target_session_id);
    const canonicalReceipt = JSON.stringify({
      status: 'applied',
      commandId: row.command_id,
      sessionId: row.target_session_id,
      revision: row.committed_revision,
    });
    if (
      !row.scope_session_id ||
      !row.command_id ||
      row.worker_scope_id !== binding.workerScopeId ||
      !owner ||
      row.project_id !== owner.project_id ||
      row.workspace_digest !== owner.workspace_digest ||
      !/^[a-f0-9]{64}$/u.test(row.request_digest) ||
      !Number.isSafeInteger(row.committed_revision) ||
      row.committed_revision < 0 ||
      !Number.isSafeInteger(row.committed_at) ||
      row.committed_at < 0 ||
      row.original_receipt_json !== canonicalReceipt ||
      ('revision' in owner && row.committed_revision > owner.revision) ||
      ('deleted_revision' in owner && row.committed_revision > owner.deleted_revision)
    ) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
    if (row.result_schema === null && row.result_json === null && row.result_digest === null)
      continue;
    if (row.result_schema === null || row.result_json === null || row.result_digest === null) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
    const result: RuntimeStoredCommandResourceResult = {
      schema: row.result_schema,
      json: row.result_json,
      digest: row.result_digest,
    };
    let decoded: unknown;
    try {
      assertRuntimeStoredCommandResourceResult(result);
      decoded = JSON.parse(result.json) as unknown;
      const currentRun = currentStartRuns.get(`${row.target_session_id}\0${row.command_id}`);
      if (currentRun) {
        if (row.scope_session_id !== row.target_session_id) {
          throw new Error('Runtime Run start receipt scope is invalid.');
        }
        assertRuntimeRunStartResourceResult(result, currentRun);
        currentStartRuns.delete(`${row.target_session_id}\0${row.command_id}`);
      }
    } catch {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      (decoded as Record<string, unknown>).schema !== result.schema ||
      createHash('sha256').update(result.json, 'utf8').digest('hex') !== result.digest
    ) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
  }
  if (currentStartRuns.size > 0) {
    throw new SqliteRuntimeFormatMismatchError(
      SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
      SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    );
  }
}

function runFromRow(row: RunRow): RuntimeStoredRun {
  const run: RuntimeStoredRun = {
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.origin_session_id === null ? {} : { originSessionId: row.origin_session_id }),
    ...(row.origin_run_id === null ? {} : { originRunId: row.origin_run_id }),
    startCommandId: row.start_command_id,
    phase: row.phase,
    status: row.status,
    createdRevision: row.created_revision,
    lastRevision: row.last_revision,
    createdAtMs: row.created_at_ms,
    ...(row.started_at_ms === null ? {} : { startedAtMs: row.started_at_ms }),
    ...(row.finished_at_ms === null ? {} : { finishedAtMs: row.finished_at_ms }),
    ...(row.terminal_json === null
      ? {}
      : { terminal: decodeRuntimeRunTerminal(row.terminal_json) }),
  };
  assertRuntimeStoredRun(run);
  return Object.freeze(run);
}

function assertPageRequest(request: RuntimeRunPageRequest): void {
  assertIdentity(request.sessionId, 'Session');
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200) {
    throw new RangeError('Runtime Run page limit is invalid.');
  }
  if (request.cursor !== undefined) {
    if (
      !Number.isSafeInteger(request.cursor.createdRevision) ||
      request.cursor.createdRevision < 0
    ) {
      throw new RangeError('Runtime Run page cursor revision is invalid.');
    }
    assertIdentity(request.cursor.runId, 'Run cursor');
  }
}

function assertTransition(transition: RuntimeRunTransition): void {
  assertIdentity(transition.sessionId, 'Session');
  assertIdentity(transition.runId, 'Run');
  if (
    !Number.isSafeInteger(transition.expectedLastRevision) ||
    transition.expectedLastRevision < 0
  ) {
    throw new Error('Runtime Run expected revision is invalid.');
  }
  assertRuntimeStoredRun(transition.next);
  if (
    transition.next.sessionId !== transition.sessionId ||
    transition.next.runId !== transition.runId ||
    transition.next.lastRevision < transition.expectedLastRevision
  ) {
    throw new Error('Runtime Run transition identity or revision is invalid.');
  }
}

function assertImmutableRunIdentity(current: RuntimeStoredRun, next: RuntimeStoredRun): void {
  if (
    current.sessionId !== next.sessionId ||
    current.runId !== next.runId ||
    current.originSessionId !== next.originSessionId ||
    current.originRunId !== next.originRunId ||
    current.startCommandId !== next.startCommandId ||
    current.phase !== next.phase ||
    current.createdRevision !== next.createdRevision ||
    current.createdAtMs !== next.createdAtMs
  ) {
    throw new Error('Runtime Run transition changed immutable identity.');
  }
}

function assertRunWithinSession(
  session: RunSessionRow | null,
  run: RuntimeStoredRun,
  binding: SqliteRuntimeWorkspaceBinding,
): void {
  if (
    !session ||
    session.worker_scope_id !== binding.workerScopeId ||
    session.workspace_identity_digest !== binding.workspaceIdentityDigest ||
    session.state_schema !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    session.format_epoch !== SQLITE_RUNTIME_RUN_FORMAT_EPOCH ||
    run.createdRevision <= session.run_index_from_revision ||
    run.lastRevision > session.revision
  ) {
    throw new Error('Runtime Run is outside its Session coverage/revision boundary.');
  }
}

function assertIdentity(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 512 ||
    value.includes('\0')
  ) {
    throw new Error(`Runtime Run ${label} identity is invalid.`);
  }
}

function assertOpen(input: SqliteRuntimeRunStoreInput): void {
  if (input.isClosed?.()) throw new Error('SQLite Runtime Run Store is closed.');
}

function formatMismatch(marker: ReadonlyMap<string, string>): SqliteRuntimeFormatMismatchError {
  return new SqliteRuntimeFormatMismatchError(
    Number(marker.get('format_version')) || null,
    marker.get('runtime_format_epoch') ?? null,
  );
}
