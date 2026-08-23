import type { RuntimeStorageBoundaryV1 } from '@kite/runtime-host/storage';
import {
  createSqliteRuntimeStorageForFormatV1,
  type SqliteRuntimeStorageInputV1,
} from './sqlite-store';

export const SQLITE_RUNTIME_STATE26_SCHEMA_VERSION = 26 as const;
export const SQLITE_RUNTIME_STORE5_SCHEMA_VERSION = 5 as const;
export const SQLITE_RUNTIME_FORMAT_EPOCH_V2 = 'kite-runtime-modularization-v1-2026-08-19' as const;
export const STORE5_DDL_V1 = Object.freeze([
  'CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE runtime_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL, event_json TEXT NOT NULL, causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))',
  "CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  "CREATE TABLE runtime_snapshots (session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))",
  'CREATE TABLE runtime_named_snapshots (session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))',
  'CREATE TABLE runtime_file_preimages (session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))',
  "CREATE TABLE runtime_effect_leases (session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain', expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))",
  'CREATE INDEX runtime_events_session_sequence ON runtime_events(session_id, sequence)',
  'CREATE INDEX runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
] as const);

export function createSqliteRuntimeStorageBoundaryV5V1(): RuntimeStorageBoundaryV1 {
  return Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE26_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE5_SCHEMA_VERSION,
    compatibilityEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
  });
}

export function createSqliteRuntimeStorageV5<Event = unknown, State = unknown>(
  input: SqliteRuntimeStorageInputV1<Event, State>,
): ReturnType<typeof createSqliteRuntimeStorageForFormatV1<Event, State>> {
  return createSqliteRuntimeStorageForFormatV1(input, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE26_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE5_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
  });
}

export function sqliteRuntimeStorePathForV2(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return `${checkpointPath.replace(/\.sqlite$/u, '')}.runtime-state26-store5.db`;
}
