import type { Database } from 'bun:sqlite';

export const KITE_HOME_STORE_SCHEMA_VERSION = 9;
export const KITE_HOME_STORE_FORMAT_EPOCH = 'kite-home-single-service-v1-2026-08-30';
export const KITE_SESSION_STORE_SCHEMA_VERSION = 10;
export const KITE_SESSION_STORE_FORMAT_EPOCH = 'kite-session-app-server-2026-09-02';

export const KITE_HOME_STORE_TABLE_COLUMNS = Object.freeze({
  kite_meta: ['key', 'value'],
  workspaces: [
    'workspace_id',
    'canonical_path',
    'workspace_identity_digest',
    'project_id',
    'workspace_digest',
    'display_name',
    'created_at',
    'updated_at',
  ],
  runtime_sessions: [
    'session_id',
    'workspace_id',
    'project_id',
    'workspace_digest',
    'state_schema',
    'format_epoch',
    'revision',
    'name',
    'model_provider',
    'model_name',
    'updated_at',
    'run_index_from_revision',
  ],
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
    'workspace_id',
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
  runtime_session_tombstones: [
    'session_id',
    'workspace_id',
    'project_id',
    'workspace_digest',
    'deleted_revision',
    'deleted_at',
  ],
  model_artifacts: [
    'artifact_id',
    'kind',
    'integrity_identifier',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'created_at',
  ],
  plan_artifacts: [
    'artifact_id',
    'task_id',
    'plan_id',
    'version',
    'artifact_format_version',
    'structural_digest',
    'plan_json',
    'markdown',
    'byte_length',
    'created_at',
  ],
  capability_artifacts: [
    'artifact_id',
    'integrity_identifier',
    'invocation_id',
    'evidence_digest',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'created_at',
  ],
  filesystem_preimage_artifacts: [
    'artifact_id',
    'integrity_identifier',
    'invocation_id',
    'operation_digest',
    'target_identity_digest',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'created_at',
  ],
  sandbox_preparation_artifacts: [
    'artifact_id',
    'integrity_identifier',
    'preparation_digest',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'expires_at_ms',
    'created_at',
  ],
  subagent_task_artifacts: [
    'artifact_id',
    'kind',
    'integrity_identifier',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'created_at',
  ],
  subagent_lifecycle_artifacts: [
    'artifact_id',
    'integrity_identifier',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'created_at',
  ],
  subagent_continuation_artifacts: [
    'artifact_id',
    'integrity_identifier',
    'artifact_format_version',
    'canonical_json',
    'byte_length',
    'created_at',
  ],
} as const);

export const KITE_HOME_STORE_INDEXES = Object.freeze([
  'runtime_events_session_sequence',
  'runtime_file_preimages_position',
  'runtime_runs_session_created_revision',
  'runtime_sessions_workspace_updated',
  'runtime_session_tombstones_workspace_deleted',
] as const);

const DIGEST_CHECK = "length(%s) = 64 AND %s NOT GLOB '*[^a-f0-9]*'";
const digestCheck = (column: string): string => DIGEST_CHECK.replaceAll('%s', column);
const artifactIdCheck = (column: string): string =>
  `length(${column}) = 67 AND substr(${column}, 1, 3) = 'pa_' AND substr(${column}, 4) NOT GLOB '*[^a-f0-9]*'`;
const integrityCheck = (column: string): string =>
  `length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' AND substr(${column}, 8) NOT GLOB '*[^a-f0-9]*'`;

export const KITE_HOME_STORE_DDL = Object.freeze([
  `CREATE TABLE kite_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY NOT NULL,
    canonical_path TEXT NOT NULL UNIQUE,
    workspace_identity_digest TEXT NOT NULL UNIQUE CHECK (${integrityCheck('workspace_identity_digest')}),
    project_id TEXT NOT NULL,
    workspace_digest TEXT NOT NULL CHECK (length(workspace_digest) BETWEEN 1 AND 128),
    display_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT`,
  `CREATE TABLE runtime_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    project_id TEXT NOT NULL,
    workspace_digest TEXT NOT NULL,
    state_schema INTEGER NOT NULL,
    format_epoch TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    name TEXT NOT NULL DEFAULT '',
    model_provider TEXT,
    model_name TEXT,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    run_index_from_revision INTEGER NOT NULL DEFAULT 0 CHECK (run_index_from_revision >= 0)
  ) STRICT`,
  `CREATE TABLE runtime_events (
    session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    schema_version INTEGER NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    causation_id TEXT,
    occurred_at TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (session_id, event_id),
    UNIQUE (session_id, sequence)
  ) STRICT`,
  `CREATE TABLE runtime_snapshots (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL,
    format_epoch TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    event_position INTEGER NOT NULL DEFAULT 0 CHECK (event_position >= 0),
    state_checksum TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  `CREATE TABLE runtime_named_snapshots (
    session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    format_epoch TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    event_position INTEGER NOT NULL DEFAULT 0 CHECK (event_position >= 0),
    state_checksum TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (session_id, name)
  ) STRICT`,
  `CREATE TABLE runtime_file_preimages (
    session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    event_position INTEGER NOT NULL DEFAULT 0 CHECK (event_position >= 0),
    content TEXT,
    existed INTEGER NOT NULL CHECK (existed IN (0, 1)),
    post_hash TEXT,
    post_existed INTEGER CHECK (post_existed IS NULL OR post_existed IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (session_id, path, event_position)
  ) STRICT`,
  `CREATE TABLE runtime_effect_leases (
    session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
    effect_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    lease_revision INTEGER NOT NULL DEFAULT 0 CHECK (lease_revision >= 0),
    certainty TEXT NOT NULL CHECK (certainty IN ('certain', 'uncertain')),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    PRIMARY KEY (session_id, effect_id)
  ) STRICT`,
  `CREATE TABLE runtime_command_receipts (
    scope_session_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    project_id TEXT NOT NULL,
    workspace_digest TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (${digestCheck('request_digest')}),
    target_session_id TEXT NOT NULL,
    original_receipt_json TEXT NOT NULL CHECK (json_valid(original_receipt_json)),
    committed_revision INTEGER NOT NULL CHECK (committed_revision >= 0),
    committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
    result_schema TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    result_digest TEXT CHECK (result_digest IS NULL OR (${digestCheck('result_digest')})),
    PRIMARY KEY (scope_session_id, command_id),
    CHECK ((result_schema IS NULL AND result_json IS NULL AND result_digest IS NULL) OR
      (result_schema IS NOT NULL AND result_json IS NOT NULL AND result_digest IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE runtime_runs (
    session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    origin_session_id TEXT,
    origin_run_id TEXT,
    start_command_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('planning', 'building')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown')),
    created_revision INTEGER NOT NULL CHECK (created_revision >= 0),
    last_revision INTEGER NOT NULL CHECK (last_revision >= created_revision),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= created_at_ms),
    finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= COALESCE(started_at_ms, created_at_ms)),
    terminal_json TEXT CHECK (terminal_json IS NULL OR json_valid(terminal_json)),
    PRIMARY KEY (session_id, run_id),
    UNIQUE (session_id, start_command_id),
    CHECK ((origin_session_id IS NULL) = (origin_run_id IS NULL)),
    CHECK ((status = 'queued') = (started_at_ms IS NULL)),
    CHECK ((status IN ('completed', 'failed', 'cancelled', 'unknown')) = (finished_at_ms IS NOT NULL)),
    CHECK (status NOT IN ('queued', 'running', 'waiting') OR terminal_json IS NULL),
    CHECK (status NOT IN ('failed', 'cancelled', 'unknown') OR terminal_json IS NOT NULL)
  ) STRICT`,
  `CREATE TABLE runtime_session_tombstones (
    session_id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    project_id TEXT NOT NULL,
    workspace_digest TEXT NOT NULL,
    deleted_revision INTEGER NOT NULL CHECK (deleted_revision >= 0),
    deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0)
  ) STRICT`,
  `CREATE TABLE model_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    kind TEXT NOT NULL CHECK (kind IN ('model_surface', 'model_response', 'provider_options')),
    integrity_identifier TEXT NOT NULL CHECK (${integrityCheck('integrity_identifier')}),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (kind, integrity_identifier)
  ) STRICT`,
  `CREATE TABLE plan_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    structural_digest TEXT NOT NULL CHECK (length(structural_digest) BETWEEN 1 AND 128),
    plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
    markdown TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (task_id, plan_id, version),
    CHECK (artifact_id = plan_id || ':v' || version)
  ) STRICT`,
  `CREATE TABLE capability_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    integrity_identifier TEXT NOT NULL UNIQUE CHECK (${integrityCheck('integrity_identifier')}),
    invocation_id TEXT NOT NULL UNIQUE,
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) BETWEEN 1 AND 128),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  `CREATE TABLE filesystem_preimage_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    integrity_identifier TEXT NOT NULL UNIQUE CHECK (${integrityCheck('integrity_identifier')}),
    invocation_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL CHECK (${integrityCheck('operation_digest')}),
    target_identity_digest TEXT NOT NULL CHECK (${integrityCheck('target_identity_digest')}),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (invocation_id, operation_digest, target_identity_digest)
  ) STRICT`,
  `CREATE TABLE sandbox_preparation_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    integrity_identifier TEXT NOT NULL UNIQUE CHECK (${integrityCheck('integrity_identifier')}),
    preparation_digest TEXT NOT NULL UNIQUE CHECK (length(preparation_digest) BETWEEN 1 AND 128),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 2097152),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  `CREATE TABLE subagent_task_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    kind TEXT NOT NULL CHECK (kind IN ('subagent_task_request', 'subagent_task')),
    integrity_identifier TEXT NOT NULL CHECK (${integrityCheck('integrity_identifier')}),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (kind, integrity_identifier)
  ) STRICT`,
  `CREATE TABLE subagent_lifecycle_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    integrity_identifier TEXT NOT NULL UNIQUE CHECK (${integrityCheck('integrity_identifier')}),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 65536),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  `CREATE TABLE subagent_continuation_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (${artifactIdCheck('artifact_id')}),
    integrity_identifier TEXT NOT NULL UNIQUE CHECK (${integrityCheck('integrity_identifier')}),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version >= 1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 4194304),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  'CREATE INDEX runtime_events_session_sequence ON runtime_events(session_id, sequence)',
  'CREATE INDEX runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
  'CREATE INDEX runtime_runs_session_created_revision ON runtime_runs(session_id, created_revision, run_id)',
  'CREATE INDEX runtime_sessions_workspace_updated ON runtime_sessions(workspace_id, updated_at DESC, session_id)',
  'CREATE INDEX runtime_session_tombstones_workspace_deleted ON runtime_session_tombstones(workspace_id, deleted_at DESC, session_id)',
] as const);

export class KiteHomeStoreSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiteHomeStoreSchemaError';
  }
}

export function initializeKiteHomeStoreSchema(database: Database): void {
  initializeExactKiteStoreSchema(database, {
    schemaVersion: KITE_HOME_STORE_SCHEMA_VERSION,
    formatEpoch: KITE_HOME_STORE_FORMAT_EPOCH,
  });
}

export function initializeKiteSessionStoreIfNeeded(database: Database): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('BEGIN IMMEDIATE');
  try {
    const tableCount = currentTableCount(database);
    if (tableCount === 0) {
      initializeExactKiteStoreSchemaInTransaction(database, {
        schemaVersion: KITE_SESSION_STORE_SCHEMA_VERSION,
        formatEpoch: KITE_SESSION_STORE_FORMAT_EPOCH,
      });
    }
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // BEGIN may have failed.
    }
    throw error;
  }
  assertKiteSessionStoreSchema(database);
}

function initializeExactKiteStoreSchema(
  database: Database,
  profile: { readonly schemaVersion: number; readonly formatEpoch: string },
): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('BEGIN IMMEDIATE');
  try {
    initializeExactKiteStoreSchemaInTransaction(database, profile);
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // BEGIN may have failed.
    }
    throw error;
  }
  assertExactKiteStoreSchema(database, profile);
}

function initializeExactKiteStoreSchemaInTransaction(
  database: Database,
  profile: { readonly schemaVersion: number; readonly formatEpoch: string },
): void {
  for (const statement of KITE_HOME_STORE_DDL) database.run(statement);
  database
    .query('INSERT INTO kite_meta(key, value) VALUES (?, ?)')
    .run('schema_version', String(profile.schemaVersion));
  database
    .query('INSERT INTO kite_meta(key, value) VALUES (?, ?)')
    .run('format_epoch', profile.formatEpoch);
  database.run(`PRAGMA user_version = ${profile.schemaVersion}`);
}

export function assertKiteHomeStoreSchema(database: Database): void {
  assertExactKiteStoreSchema(database, {
    schemaVersion: KITE_HOME_STORE_SCHEMA_VERSION,
    formatEpoch: KITE_HOME_STORE_FORMAT_EPOCH,
  });
}

export function assertKiteSessionStoreSchema(database: Database): void {
  assertExactKiteStoreSchema(database, {
    schemaVersion: KITE_SESSION_STORE_SCHEMA_VERSION,
    formatEpoch: KITE_SESSION_STORE_FORMAT_EPOCH,
  });
}

function assertExactKiteStoreSchema(
  database: Database,
  profile: { readonly schemaVersion: number; readonly formatEpoch: string },
): void {
  database.run('PRAGMA foreign_keys = ON');
  const quickCheck = database.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
  if (quickCheck?.quick_check !== 'ok') fail('SQLite quick_check failed.');
  const foreignKeyErrors = database
    .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
    .all();
  if (foreignKeyErrors.length !== 0) fail('SQLite foreign_key_check failed.');

  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const expectedTables = Object.keys(KITE_HOME_STORE_TABLE_COLUMNS).sort();
  if (JSON.stringify(tables) !== JSON.stringify(expectedTables)) {
    fail('Kite Home Store table inventory is incompatible.');
  }

  for (const [table, expectedColumns] of Object.entries(KITE_HOME_STORE_TABLE_COLUMNS)) {
    const actual = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
      fail(`Kite Home Store table '${table}' columns are incompatible.`);
    }
  }

  const indexes = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const expectedIndexes = [...KITE_HOME_STORE_INDEXES].sort();
  if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) {
    fail('Kite Home Store index inventory is incompatible.');
  }

  const metadata = new Map(
    database
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM kite_meta WHERE key IN ('schema_version', 'format_epoch') ORDER BY key",
      )
      .all()
      .map((row) => [row.key, row.value] as const),
  );
  if (
    metadata.size !== 2 ||
    metadata.get('schema_version') !== String(profile.schemaVersion) ||
    metadata.get('format_epoch') !== profile.formatEpoch
  ) {
    fail('Kite Home Store metadata is incompatible.');
  }
  const userVersion = database.query<{ user_version: number }, []>('PRAGMA user_version').get();
  if (userVersion?.user_version !== profile.schemaVersion) {
    fail('Kite Home Store user_version is incompatible.');
  }
}

function currentTableCount(database: Database): number {
  return (
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get()?.count ?? 0
  );
}

function fail(message: string): never {
  throw new KiteHomeStoreSchemaError(message);
}
