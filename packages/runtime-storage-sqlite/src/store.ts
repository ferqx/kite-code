import { createHash } from 'node:crypto';
import type { RuntimeStorageBoundary } from '@kite-ai/runtime-host/storage';
import { createSqliteRuntimeStorageAdapter } from './adapter';
import {
  SQLITE_RUNTIME_FORMAT_EPOCH,
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
