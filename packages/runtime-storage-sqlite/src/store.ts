import { createHash } from 'node:crypto';
import type { RuntimeStorageBoundary } from '@kite-ai/runtime-host/storage';
import { createSqliteRuntimeStorageAdapter } from './adapter';
import {
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  type SqliteRuntimeStorageInput,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';

export const SQLITE_RUNTIME_DDL = Object.freeze([
  'CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE runtime_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL, event_json TEXT NOT NULL, causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))',
  "CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  "CREATE TABLE runtime_snapshots (session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))",
  'CREATE TABLE runtime_named_snapshots (session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))',
  'CREATE TABLE runtime_file_preimages (session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))',
  "CREATE TABLE runtime_effect_leases (session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain', expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))",
  'CREATE TABLE runtime_command_receipts (scope_session_id TEXT NOT NULL, command_id TEXT NOT NULL, request_digest TEXT NOT NULL, target_session_id TEXT NOT NULL, original_receipt_json TEXT NOT NULL, committed_revision INTEGER NOT NULL, committed_at INTEGER NOT NULL, PRIMARY KEY (scope_session_id, command_id))',
  'CREATE INDEX runtime_events_session_sequence ON runtime_events(session_id, sequence)',
  'CREATE INDEX runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
] as const);

/** Exact Store 7 DDL; unlike the legacy Store 6 list it carries owner binding and tombstones. */
export const SQLITE_WORKSPACE_RUNTIME_DDL = Object.freeze([
  'CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE runtime_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL, event_json TEXT NOT NULL, causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))',
  "CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, worker_scope_id TEXT NOT NULL, workspace_identity_digest TEXT NOT NULL, state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  "CREATE TABLE runtime_snapshots (session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))",
  'CREATE TABLE runtime_named_snapshots (session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))',
  'CREATE TABLE runtime_file_preimages (session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))',
  "CREATE TABLE runtime_effect_leases (session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain', expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))",
  'CREATE TABLE runtime_command_receipts (scope_session_id TEXT NOT NULL, command_id TEXT NOT NULL, worker_scope_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, request_digest TEXT NOT NULL, target_session_id TEXT NOT NULL, original_receipt_json TEXT NOT NULL, committed_revision INTEGER NOT NULL, committed_at INTEGER NOT NULL, PRIMARY KEY (scope_session_id, command_id))',
  'CREATE TABLE session_workspace_tombstone (session_id TEXT PRIMARY KEY, worker_scope_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, deleted_revision INTEGER NOT NULL, deleted_at INTEGER NOT NULL)',
  'CREATE TABLE session_directory_outbox (session_id TEXT NOT NULL, worker_scope_id TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)), UNIQUE (worker_scope_id, session_id, revision, updated_at, tombstone))',
  'CREATE INDEX runtime_events_session_sequence ON runtime_events(session_id, sequence)',
  'CREATE INDEX runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
] as const);

/** Exact unpublished Store 8 logical DDL inventory. */
export const SQLITE_RUNTIME_RUN_DDL = Object.freeze([
  ...SQLITE_WORKSPACE_RUNTIME_DDL.filter(
    (statement) =>
      !statement.startsWith('CREATE TABLE runtime_sessions ') &&
      !statement.startsWith('CREATE TABLE runtime_command_receipts '),
  ),
  "CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, worker_scope_id TEXT NOT NULL, workspace_identity_digest TEXT NOT NULL, state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()), run_index_from_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(run_index_from_revision) = 'integer' AND run_index_from_revision >= 0))",
  "CREATE TABLE runtime_command_receipts (scope_session_id TEXT NOT NULL, command_id TEXT NOT NULL, worker_scope_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, request_digest TEXT NOT NULL, target_session_id TEXT NOT NULL, original_receipt_json TEXT NOT NULL, committed_revision INTEGER NOT NULL, committed_at INTEGER NOT NULL, result_schema TEXT, result_json TEXT, result_digest TEXT, PRIMARY KEY (scope_session_id, command_id), CHECK ((result_schema IS NULL AND result_json IS NULL AND result_digest IS NULL) OR (result_schema IS NOT NULL AND result_json IS NOT NULL AND result_digest IS NOT NULL AND length(result_schema) BETWEEN 1 AND 128 AND length(result_digest) = 64 AND result_digest NOT GLOB '*[^a-f0-9]*' AND json_valid(result_json))))",
  "CREATE TABLE runtime_runs (session_id TEXT NOT NULL, run_id TEXT NOT NULL, origin_session_id TEXT, origin_run_id TEXT, start_command_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('planning', 'building')), status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown')), created_revision INTEGER NOT NULL CHECK (typeof(created_revision) = 'integer' AND created_revision >= 0), last_revision INTEGER NOT NULL CHECK (typeof(last_revision) = 'integer' AND last_revision >= created_revision), created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0), started_at_ms INTEGER CHECK (started_at_ms IS NULL OR (typeof(started_at_ms) = 'integer' AND started_at_ms >= created_at_ms)), finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR (typeof(finished_at_ms) = 'integer' AND finished_at_ms >= COALESCE(started_at_ms, created_at_ms))), terminal_json TEXT CHECK (terminal_json IS NULL OR json_valid(terminal_json)), PRIMARY KEY (session_id, run_id), UNIQUE (session_id, start_command_id), FOREIGN KEY (session_id) REFERENCES runtime_sessions(session_id) ON DELETE CASCADE, CHECK ((origin_session_id IS NULL) = (origin_run_id IS NULL)), CHECK ((status = 'queued') = (started_at_ms IS NULL)), CHECK ((status IN ('completed', 'failed', 'cancelled', 'unknown')) = (finished_at_ms IS NOT NULL)), CHECK (status NOT IN ('queued', 'running', 'waiting') OR terminal_json IS NULL), CHECK (status NOT IN ('failed', 'cancelled', 'unknown') OR terminal_json IS NOT NULL))",
  'CREATE INDEX runtime_runs_session_created_revision ON runtime_runs(session_id, created_revision, run_id)',
] as const);

export function createSqliteWorkspaceRuntimeProfile(
  workspaceBinding: SqliteRuntimeWorkspaceBinding,
) {
  return Object.freeze({
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding,
  });
}

export function createSqliteRuntimeRunProfile(workspaceBinding: SqliteRuntimeWorkspaceBinding) {
  return Object.freeze({
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    workspaceBinding,
  });
}

export function createSqliteRuntimeStorageBoundary(): RuntimeStorageBoundary {
  return Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
  });
}

export function createSqliteRuntimeStorage<Event = unknown, State = unknown>(
  input: SqliteRuntimeStorageInput<Event, State>,
): ReturnType<typeof createSqliteRuntimeStorageAdapter<Event, State>> {
  return createSqliteRuntimeStorageAdapter(input);
}

export function sqliteRuntimeStorePath(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return `${checkpointPath.replace(/\.sqlite$/u, '')}.runtime-state-store.db`;
}

/**
 * Derive one opaque Store generation from its semantic format epoch.
 *
 * An incompatible future writer therefore receives a different file instead
 * of trying to preflight/open the previous generation as current. The epoch
 * itself remains an internal contract and is not exposed in the file name.
 */
export function sqliteRuntimeStorePathForEpoch(
  checkpointPath: string,
  formatEpoch: string,
): string {
  if (checkpointPath === ':memory:') return ':memory:';
  if (!formatEpoch || formatEpoch.includes('\0')) {
    throw new Error('SQLite Runtime format epoch is invalid.');
  }
  const generation = createHash('sha256').update(formatEpoch).digest('hex').slice(0, 16);
  return `${checkpointPath.replace(/\.sqlite$/u, '')}.runtime-state-store-${generation}.db`;
}

/** Stable target path within the current semantic Runtime format generation. */
export function sqliteCurrentRuntimeStorePath(checkpointPath: string): string {
  return sqliteRuntimeStorePathForEpoch(checkpointPath, SQLITE_RUNTIME_FORMAT_EPOCH);
}
