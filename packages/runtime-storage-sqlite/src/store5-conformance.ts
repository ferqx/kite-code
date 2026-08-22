import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSqliteRuntimeStorage, type SqliteRuntimeStorageInputV1 } from './sqlite-store';

export const SQLITE_RUNTIME_STATE26_SCHEMA_VERSION = 26 as const;
export const SQLITE_RUNTIME_STORE5_SCHEMA_VERSION = 5 as const;
export const SQLITE_RUNTIME_FORMAT_EPOCH_V2 = 'kite-runtime-modularization-v1-2026-08-19' as const;
export const STORE5_DDL_V1 = Object.freeze([
  'CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE runtime_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))',
  'CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL, state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL)',
  'CREATE TABLE runtime_snapshots (session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)',
  'CREATE TABLE runtime_effect_leases (session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_revision INTEGER NOT NULL, certainty TEXT NOT NULL, PRIMARY KEY (session_id, effect_id))',
  'CREATE TABLE runtime_mcp_egress_nonces (invocation_id TEXT NOT NULL, nonce_namespace TEXT NOT NULL, nonce_digest TEXT NOT NULL, consumed_at TEXT NOT NULL, PRIMARY KEY (invocation_id, nonce_namespace, nonce_digest))',
  'CREATE TABLE runtime_data_origins (origin_id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, project_id TEXT, classification TEXT NOT NULL, parent_origins_json TEXT NOT NULL)',
  'CREATE INDEX runtime_events_session_sequence ON runtime_events(session_id, sequence)',
  'CREATE INDEX runtime_data_origins_observation ON runtime_data_origins(observation_id)',
] as const);
export interface State26ConformanceV1 {
  readonly schemaVersion: 26;
  readonly formatEpoch: typeof SQLITE_RUNTIME_FORMAT_EPOCH_V2;
  readonly rav1: {
    readonly sourceSchemaVersion: 25;
    readonly sourceFormatEpoch: string;
    readonly projectIdentity: string;
  };
  readonly state: Readonly<Record<string, unknown>>;
}
export function mapState25ToState26ConformanceV1(input: {
  readonly state: Readonly<Record<string, unknown>>;
  readonly projectIdentity: string;
}): State26ConformanceV1 {
  if (input.state.schemaVersion !== 25 || typeof input.state.formatEpoch !== 'string')
    throw new Error('State 25 conformance input mismatch.');
  return Object.freeze({
    schemaVersion: 26,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
    rav1: {
      sourceSchemaVersion: 25 as const,
      sourceFormatEpoch: input.state.formatEpoch,
      projectIdentity: input.projectIdentity,
    },
    state: structuredClone(input.state),
  });
}
export function createIsolatedStore5ConformanceV1(input: {
  readonly databasePath: string;
  readonly conformanceOnly: true;
}): {
  readonly databasePath: string;
  readonly stateSchemaVersion: 26;
  readonly storeSchemaVersion: 5;
  readonly formatEpoch: typeof SQLITE_RUNTIME_FORMAT_EPOCH_V2;
  readonly ddl: readonly string[];
} {
  if (input.conformanceOnly !== true)
    throw new Error('Store 5 constructor is conformance-only before RAV1-06.');
  if (input.databasePath !== ':memory:')
    mkdirSync(dirname(input.databasePath), { recursive: true });
  return Object.freeze({
    databasePath: input.databasePath,
    stateSchemaVersion: 26,
    storeSchemaVersion: 5,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
    ddl: STORE5_DDL_V1,
  });
}

export function createSqliteRuntimeStorageV5Conformance<Event = unknown, State = unknown>(
  input: Omit<SqliteRuntimeStorageInputV1<Event, State>, 'formatProfile'>,
): ReturnType<typeof createSqliteRuntimeStorage<Event, State>> {
  return createSqliteRuntimeStorage({
    ...input,
    formatProfile: {
      stateSchemaVersion: 26,
      storeSchemaVersion: 5,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
    },
  });
}

export function sqliteRuntimeStorePathForV2(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return `${checkpointPath.replace(/\.sqlite$/u, '')}.runtime-v5.db`;
}
