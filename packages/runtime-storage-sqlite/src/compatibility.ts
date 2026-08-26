import { constants, Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  assertCurrentSqliteRuntimeStoreConnection,
  assertNoFollowDatabasePath,
  assertSqliteRuntimeStorageCanOpen,
  checksum,
  defaultSqliteRuntimeJournalMode,
  openSqliteReadonlySnapshotView,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SqliteRuntimeStorageOpenError,
} from './preflight';
import { initializeSqliteRuntimeSchema, type SqliteRuntimeFormatProfile } from './schema';

/**
 * Profiles which are safe to inspect as a legacy Runtime Store.  The list is
 * deliberately finite: a database with an unrecognised marker is treated as
 * absent by the compatibility layer and is never opened for writing.
 */
export interface SqliteRuntimeCompatibilitySourceProfile extends SqliteRuntimeFormatProfile {
  /** Empty checksums are accepted only for a profile whose old Store rules explicitly allow it. */
  readonly allowMissingSnapshotChecksum?: boolean;
}

export const SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES: readonly SqliteRuntimeCompatibilitySourceProfile[] =
  Object.freeze([
    Object.freeze({
      storeSchemaVersion: 5,
      stateSchemaVersion: 26,
      formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
      allowMissingSnapshotChecksum: false,
    }),
    Object.freeze({
      storeSchemaVersion: 5,
      stateSchemaVersion: 27,
      formatEpoch: 'kite-runtime-saq-v1-2026-08-25',
      allowMissingSnapshotChecksum: false,
    }),
  ]);

const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
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
    'state_schema',
    'format_epoch',
    'revision',
    'name',
    'model_provider',
    'model_name',
    'updated_at',
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
});

export interface SqliteRuntimeCompatibilitySessionSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly name: string;
  readonly updatedAt: number;
  readonly modelProvider: string | null;
  readonly modelName: string | null;
}

export interface SqliteRuntimeCompatibilitySnapshot {
  readonly schemaVersion: number;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly stateJson: string;
  readonly eventPosition: number;
  readonly stateChecksum: string;
  readonly createdAt: number;
}

export interface SqliteRuntimeCompatibilityEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly schemaVersion: number;
  readonly eventJson: string;
  readonly causationId: string | null;
  readonly occurredAt: string | null;
  readonly createdAt: number;
}

export interface SqliteRuntimeCompatibilitySession {
  readonly session: SqliteRuntimeCompatibilitySessionSummary;
  readonly snapshot: SqliteRuntimeCompatibilitySnapshot;
  /** The complete known-format journal. An unknown/malformed row invalidates this session projection. */
  readonly events: readonly SqliteRuntimeCompatibilityEvent[];
  readonly namedSnapshots: readonly SqliteRuntimeCompatibilityNamedSnapshot[];
  readonly filePreimages: readonly SqliteRuntimeCompatibilityFilePreimage[];
}

export interface SqliteRuntimeCompatibilityNamedSnapshot {
  readonly name: string;
  readonly schemaVersion: number;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly stateJson: string;
  readonly eventPosition: number;
  readonly stateChecksum: string;
  readonly createdAt: number;
}

export interface SqliteRuntimeCompatibilityFilePreimage {
  readonly path: string;
  readonly eventPosition: number;
  readonly content: string | null;
  readonly existed: boolean;
  readonly postHash: string | null;
  readonly postExisted: boolean | null;
  readonly createdAt: number;
}

export interface SqliteRuntimeCompatibilitySource {
  readonly databasePath: string;
  readonly sourceIdentity: string;
  readonly profile: SqliteRuntimeCompatibilitySourceProfile;
  listSessions(): readonly SqliteRuntimeCompatibilitySessionSummary[];
  readSession(sessionId: string): SqliteRuntimeCompatibilitySession | null;
  close(): void;
}

export type SqliteRuntimeCompatibilitySourceReference = SqliteRuntimeCompatibilitySource | string;

export interface SqliteRuntimeCompatibilityTargetEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly schemaVersion?: number;
  readonly eventJson: string;
  readonly causationId?: string | null;
  readonly occurredAt?: string | null;
  readonly createdAt?: number;
}

export interface SqliteRuntimeCompatibilityTargetSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly name?: string;
  readonly modelProvider?: string | null;
  readonly modelName?: string | null;
  readonly updatedAt?: number;
  readonly revision: number;
  readonly eventPosition: number;
  readonly stateJson: string;
  readonly stateChecksum?: string;
  readonly events: readonly SqliteRuntimeCompatibilityTargetEvent[];
  readonly namedSnapshots?: readonly SqliteRuntimeCompatibilityNamedSnapshot[];
  readonly filePreimages?: readonly SqliteRuntimeCompatibilityFilePreimage[];
}

export type SqliteRuntimeCompatibilityMigrator = (
  input: SqliteRuntimeCompatibilitySession,
  sourceProfile: SqliteRuntimeCompatibilitySourceProfile,
) => SqliteRuntimeCompatibilityTargetSession | null;

export type SqliteRuntimeCompatibilityImportResult =
  | { readonly status: 'imported'; readonly sessionId: string }
  | { readonly status: 'already_imported'; readonly sessionId: string }
  | { readonly status: 'ignored'; readonly sessionId: string }
  | { readonly status: 'conflict'; readonly sessionId: string }
  | { readonly status: 'failed'; readonly sessionId: string; readonly error: unknown };

interface ReadonlyDatabaseView {
  readonly database: Database;
  close(): void;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Open a read-only SQLite view. A caller must wrap each logical read in
 * `BEGIN`/`COMMIT` so SQLite pins one snapshot for that read.
 *
 * A SQLITE_OPEN_READONLY connection may still update an existing SHM shared
 * index. Therefore any source with WAL/SHM sidecars is read only through the
 * isolated snapshot view; otherwise our own SQLite open could mutate the
 * source fingerprint and make a healthy legacy Store disappear.
 */
function openReadonlyView(databasePath: string): ReadonlyDatabaseView {
  assertNoFollowDatabasePath(databasePath);
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  const wal = lstatIfPresent(walPath);
  const shm = lstatIfPresent(shmPath);
  for (const stat of [wal, shm]) {
    if (stat?.isSymbolicLink()) {
      throw new SqliteRuntimeStorageOpenError(
        'SQLite compatibility WAL/SHM source must not be a symlink.',
      );
    }
  }
  if (wal || shm) {
    // SHM is a rebuildable WAL index, but it is not immutable merely because
    // the database handle is read-only. Rebuild/use all sidecar state only
    // beside an isolated no-follow snapshot; never touch the source sidecars.
    return openSqliteReadonlySnapshotView(databasePath);
  }
  const database = new Database(
    databasePath,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    database.run('PRAGMA busy_timeout = 250');
    database.run('PRAGMA query_only = ON');
  } catch (error) {
    database.close();
    throw error;
  }
  return { database, close: () => database.close() };
}

function hasTable(database: Database, name: string): boolean {
  return Boolean(
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name)?.count,
  );
}

function hasRequiredShape(database: Database): boolean {
  for (const [table, required] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    if (!hasTable(database, table)) return false;
    const columns = new Set(
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((entry) => entry.name),
    );
    if (required.some((column) => !columns.has(column))) return false;
  }
  return true;
}

function sourceFileFingerprint(path: string): string {
  const stat = lstatIfPresent(path);
  if (!stat) return 'missing';
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function sourceFingerprint(databasePath: string): string {
  const stat = statSync(databasePath);
  return [
    `${realpathSync(databasePath)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
    `wal=${sourceFileFingerprint(`${databasePath}-wal`)}`,
    `shm=${sourceFileFingerprint(`${databasePath}-shm`)}`,
  ].join('|');
}

function stableSourcePath(databasePath: string): string {
  try {
    return realpathSync(databasePath);
  } catch {
    return resolve(databasePath);
  }
}

function sourcePath(source: SqliteRuntimeCompatibilitySourceReference): string {
  return typeof source === 'string' ? source : source.databasePath;
}

function sessionTombstoneKeys(
  source: SqliteRuntimeCompatibilitySourceReference,
  sessionId: string,
): readonly string[] {
  const pathKey = `compat_tombstone_path_v1:${encodeURIComponent(stableSourcePath(sourcePath(source)))}:${encodeURIComponent(sessionId)}`;
  if (typeof source === 'string') return [pathKey];
  return [
    `compat_tombstone_v1:${encodeURIComponent(source.sourceIdentity)}:${encodeURIComponent(sessionId)}`,
    pathKey,
  ];
}

function withReadTransaction<T>(database: Database, work: () => T): T {
  database.run('BEGIN');
  try {
    const result = work();
    database.run('COMMIT');
    return result;
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      /* The read transaction may already have been aborted by SQLite. */
    }
    throw error;
  }
}

function profileForMarker(
  database: Database,
  profiles: readonly SqliteRuntimeCompatibilitySourceProfile[],
): SqliteRuntimeCompatibilitySourceProfile | null {
  if (!hasTable(database, 'runtime_store_meta')) return null;
  const marker = database
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM runtime_store_meta WHERE key IN ('format_version', 'runtime_format_epoch')",
    )
    .all();
  const values = new Map(marker.map((entry) => [entry.key, entry.value]));
  const storeSchemaVersion = Number(values.get('format_version'));
  const formatEpoch = values.get('runtime_format_epoch');
  return (
    profiles.find(
      (profile) =>
        profile.storeSchemaVersion === storeSchemaVersion && profile.formatEpoch === formatEpoch,
    ) ?? null
  );
}

function validJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function readSessionFromDatabase(
  database: Database,
  profile: SqliteRuntimeCompatibilitySourceProfile,
  sessionId: string,
): SqliteRuntimeCompatibilitySession | null {
  try {
    const session = database
      .query<
        {
          session_id: string;
          project_id: string;
          workspace_digest: string;
          state_schema: number;
          format_epoch: string;
          revision: number;
          name: string;
          updated_at: number;
          model_provider: string | null;
          model_name: string | null;
        },
        [string]
      >(
        'SELECT session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at, model_provider, model_name FROM runtime_sessions WHERE session_id = ? LIMIT 1',
      )
      .get(sessionId);
    if (
      !session ||
      session.state_schema !== profile.stateSchemaVersion ||
      session.format_epoch !== profile.formatEpoch ||
      !Number.isSafeInteger(session.revision) ||
      session.revision < 0
    ) {
      return null;
    }
    const snapshot = database
      .query<
        {
          schema_version: number;
          format_epoch: string;
          revision: number;
          state_json: string;
          event_position: number;
          state_checksum: string;
          created_at: number;
        },
        [string]
      >(
        'SELECT schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
      )
      .get(sessionId);
    if (
      !snapshot ||
      snapshot.schema_version !== profile.stateSchemaVersion ||
      snapshot.format_epoch !== profile.formatEpoch ||
      snapshot.revision !== session.revision ||
      !Number.isSafeInteger(snapshot.event_position) ||
      snapshot.event_position < 0 ||
      !validJson(snapshot.state_json) ||
      (!snapshot.state_checksum && !profile.allowMissingSnapshotChecksum) ||
      (snapshot.state_checksum.length > 0 &&
        checksum(snapshot.state_json) !== snapshot.state_checksum)
    ) {
      return null;
    }
    const rows = database
      .query<
        {
          event_id: string;
          sequence: number;
          schema_version: number;
          event_json: string;
          causation_id: string | null;
          occurred_at: string | null;
          created_at: number;
        },
        [string]
      >(
        'SELECT event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? ORDER BY sequence ASC',
      )
      .all(sessionId);
    if (
      rows.some(
        (row) =>
          row.schema_version !== profile.stateSchemaVersion ||
          !validJson(row.event_json) ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence <= 0,
      )
    ) {
      return null;
    }
    let expectedSequence = 1;
    if (rows.some((row) => row.sequence !== expectedSequence++)) return null;
    const events = rows.map((row) => ({
      eventId: row.event_id,
      sequence: row.sequence,
      schemaVersion: row.schema_version,
      eventJson: row.event_json,
      causationId: row.causation_id,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    }));
    const namedRows = database
      .query<
        {
          name: string;
          schema_version: number;
          format_epoch: string;
          revision: number;
          state_json: string;
          event_position: number;
          state_checksum: string;
          created_at: number;
        },
        [string]
      >(
        'SELECT name, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at FROM runtime_named_snapshots WHERE session_id = ? ORDER BY event_position ASC, name ASC',
      )
      .all(sessionId);
    if (
      namedRows.some(
        (row) =>
          row.schema_version !== profile.stateSchemaVersion ||
          row.format_epoch !== profile.formatEpoch ||
          !validJson(row.state_json) ||
          !Number.isSafeInteger(row.event_position) ||
          row.event_position < 0 ||
          (!row.state_checksum && !profile.allowMissingSnapshotChecksum) ||
          (row.state_checksum.length > 0 && checksum(row.state_json) !== row.state_checksum),
      )
    ) {
      return null;
    }
    const namedSnapshots = namedRows.map((row) => ({
      name: row.name,
      schemaVersion: row.schema_version,
      formatEpoch: row.format_epoch,
      revision: row.revision,
      stateJson: row.state_json,
      eventPosition: row.event_position,
      stateChecksum: row.state_checksum,
      createdAt: row.created_at,
    }));
    const fileRows = database
      .query<
        {
          path: string;
          event_position: number;
          content: string | null;
          existed: number;
          post_hash: string | null;
          post_existed: number | null;
          created_at: number;
        },
        [string]
      >(
        'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE session_id = ? ORDER BY event_position ASC, path ASC',
      )
      .all(sessionId);
    if (fileRows.some((row) => !Number.isSafeInteger(row.event_position) || row.event_position < 0))
      return null;
    const filePreimages = fileRows.map((row) => ({
      path: row.path,
      eventPosition: row.event_position,
      content: row.content,
      existed: row.existed !== 0,
      postHash: row.post_hash,
      postExisted: row.post_existed == null ? null : row.post_existed !== 0,
      createdAt: row.created_at,
    }));
    return {
      session: {
        sessionId: session.session_id,
        projectId: session.project_id,
        workspaceDigest: session.workspace_digest,
        stateSchemaVersion: session.state_schema,
        formatEpoch: session.format_epoch,
        revision: session.revision,
        name: session.name,
        updatedAt: session.updated_at,
        modelProvider: session.model_provider,
        modelName: session.model_name,
      },
      snapshot: {
        schemaVersion: snapshot.schema_version,
        formatEpoch: snapshot.format_epoch,
        revision: snapshot.revision,
        stateJson: snapshot.state_json,
        eventPosition: snapshot.event_position,
        stateChecksum: snapshot.state_checksum,
        createdAt: snapshot.created_at,
      },
      events,
      namedSnapshots,
      filePreimages,
    };
  } catch {
    // Compatibility discovery is intentionally best effort. A malformed
    // session is isolated to that session and is equivalent to no source row.
    return null;
  }
}

/**
 * Open a legacy source for read-only discovery. Unknown/malformed sources
 * return null and never become a process-wide startup failure.
 */
export function discoverSqliteRuntimeCompatibilitySource(
  databasePath: string,
  profiles: readonly SqliteRuntimeCompatibilitySourceProfile[] = SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES,
): SqliteRuntimeCompatibilitySource | null {
  if (!databasePath || databasePath === ':memory:' || !existsSync(databasePath)) return null;
  let view: ReadonlyDatabaseView | undefined;
  try {
    assertNoFollowDatabasePath(databasePath);
    const sourceIdentityBeforeOpen = sourceFingerprint(databasePath);
    view = openReadonlyView(databasePath);
    if (sourceFingerprint(databasePath) !== sourceIdentityBeforeOpen) {
      view.close();
      return null;
    }
    const { database } = view;
    const profile = withReadTransaction(database, () => profileForMarker(database, profiles));
    const shapeIsKnown = withReadTransaction(database, () => hasRequiredShape(database));
    if (!profile || !shapeIsKnown) {
      view.close();
      return null;
    }
    const sourceIdentity = sourceFingerprint(databasePath);
    if (sourceIdentity !== sourceIdentityBeforeOpen) {
      view.close();
      return null;
    }
    const sourceIsCurrent = (): boolean => {
      try {
        return sourceFingerprint(databasePath) === sourceIdentity;
      } catch {
        return false;
      }
    };
    let closed = false;
    return {
      databasePath,
      sourceIdentity,
      profile,
      listSessions: () => {
        if (closed || !sourceIsCurrent()) return [];
        try {
          return withReadTransaction(database, () => {
            const ids = database
              .query<
                {
                  session_id: string;
                  project_id: string;
                  workspace_digest: string;
                  state_schema: number;
                  format_epoch: string;
                  revision: number;
                  name: string;
                  updated_at: number;
                  model_provider: string | null;
                  model_name: string | null;
                },
                []
              >(
                'SELECT session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at, model_provider, model_name FROM runtime_sessions ORDER BY updated_at DESC, session_id DESC',
              )
              .all();
            return ids
              .filter(
                (row) =>
                  row.state_schema === profile.stateSchemaVersion &&
                  row.format_epoch === profile.formatEpoch,
              )
              .map((row) => ({
                sessionId: row.session_id,
                projectId: row.project_id,
                workspaceDigest: row.workspace_digest,
                stateSchemaVersion: row.state_schema,
                formatEpoch: row.format_epoch,
                revision: row.revision,
                name: row.name,
                updatedAt: row.updated_at,
                modelProvider: row.model_provider,
                modelName: row.model_name,
              }));
          });
        } catch {
          return [];
        }
      },
      readSession: (sessionId: string) => {
        if (closed || !sessionId) return null;
        if (!sourceIsCurrent()) return null;
        try {
          return withReadTransaction(database, () =>
            readSessionFromDatabase(database, profile, sessionId),
          );
        } catch {
          return null;
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        view?.close();
      },
    };
  } catch {
    view?.close();
    return null;
  }
}

function targetDatabaseLooksCurrent(
  database: Database,
  profile: SqliteRuntimeFormatProfile,
): boolean {
  if (
    profile.storeSchemaVersion === SQLITE_RUNTIME_STORE_SCHEMA_VERSION &&
    profile.stateSchemaVersion === SQLITE_RUNTIME_STATE_SCHEMA_VERSION &&
    profile.formatEpoch === SQLITE_RUNTIME_FORMAT_EPOCH
  ) {
    try {
      assertCurrentSqliteRuntimeStoreConnection(database);
      return true;
    } catch {
      return false;
    }
  }
  if (!hasTable(database, 'runtime_store_meta')) return false;
  const row = database
    .query<{ format_version: string | null; runtime_format_epoch: string | null }, []>(
      "SELECT (SELECT value FROM runtime_store_meta WHERE key = 'format_version') AS format_version, (SELECT value FROM runtime_store_meta WHERE key = 'runtime_format_epoch') AS runtime_format_epoch",
    )
    .get();
  return (
    Number(row?.format_version) === profile.storeSchemaVersion &&
    row?.runtime_format_epoch === profile.formatEpoch &&
    hasRequiredShape(database)
  );
}

function classifyTargetPath(databasePath: string, profile: SqliteRuntimeFormatProfile): boolean {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return true;
  if (
    profile.storeSchemaVersion === SQLITE_RUNTIME_STORE_SCHEMA_VERSION &&
    profile.stateSchemaVersion === SQLITE_RUNTIME_STATE_SCHEMA_VERSION &&
    profile.formatEpoch === SQLITE_RUNTIME_FORMAT_EPOCH
  ) {
    try {
      // Reuse the current Store preflight for the writable target. In
      // particular, its WAL view remains valid when a prior connection left a
      // WAL file but no SHM file. Treating that normal SQLite state as an
      // unknown target would make the first lazy history import fail even
      // though the target format is current.
      assertSqliteRuntimeStorageCanOpen(databasePath);
      return true;
    } catch {
      return false;
    }
  }
  let view: ReadonlyDatabaseView | undefined;
  try {
    view = openReadonlyView(databasePath);
    return withReadTransaction(view.database, () => {
      const tables = view!.database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      return tables.length === 0 || targetDatabaseLooksCurrent(view!.database, profile);
    });
  } catch {
    return false;
  } finally {
    view?.close();
  }
}

function encodedLedgerKey(
  source: SqliteRuntimeCompatibilitySource,
  input: SqliteRuntimeCompatibilitySession,
): string {
  return `compat_migration_v1:${encodeURIComponent(source.sourceIdentity)}:${encodeURIComponent(input.session.sessionId)}:${input.snapshot.revision}:${encodeURIComponent(input.snapshot.stateChecksum || checksum(input.snapshot.stateJson))}`;
}

function invalidMigration(message: string): Error {
  return new Error(`Compatibility migration produced invalid data: ${message}`);
}

function validateTargetSession(
  migrated: SqliteRuntimeCompatibilityTargetSession,
  profile: SqliteRuntimeFormatProfile,
): Error | undefined {
  if (!validJson(migrated.stateJson)) return invalidMigration('state JSON.');
  const expectedStateChecksum = checksum(migrated.stateJson);
  if (migrated.stateChecksum && migrated.stateChecksum !== expectedStateChecksum) {
    return invalidMigration('state checksum.');
  }
  if (!Number.isSafeInteger(migrated.revision) || migrated.revision < 0) {
    return invalidMigration('state revision.');
  }
  if (!Number.isSafeInteger(migrated.eventPosition) || migrated.eventPosition < 0) {
    return invalidMigration('event position.');
  }
  let expectedSequence = 1;
  for (const event of migrated.events) {
    if (
      event.schemaVersion !== profile.stateSchemaVersion ||
      event.sequence !== expectedSequence ||
      !event.eventId ||
      !validJson(event.eventJson)
    ) {
      return invalidMigration('event schema, sequence, or JSON.');
    }
    expectedSequence += 1;
  }
  const lastSequence = expectedSequence - 1;
  if (lastSequence !== migrated.revision || migrated.eventPosition !== migrated.revision) {
    return invalidMigration('event sequence/revision boundary.');
  }
  for (const named of migrated.namedSnapshots ?? []) {
    if (
      named.schemaVersion !== profile.stateSchemaVersion ||
      named.formatEpoch !== profile.formatEpoch ||
      !named.name ||
      !Number.isSafeInteger(named.revision) ||
      named.revision < 0 ||
      !Number.isSafeInteger(named.eventPosition) ||
      named.eventPosition < 0 ||
      named.revision !== named.eventPosition ||
      named.eventPosition > migrated.eventPosition ||
      !validJson(named.stateJson) ||
      (named.stateChecksum !== '' && named.stateChecksum !== checksum(named.stateJson))
    ) {
      return invalidMigration('named snapshot.');
    }
  }
  for (const preimage of migrated.filePreimages ?? []) {
    if (
      !preimage.path ||
      preimage.path.includes('\0') ||
      !Number.isSafeInteger(preimage.eventPosition) ||
      preimage.eventPosition < 0 ||
      preimage.eventPosition > migrated.eventPosition
    ) {
      return invalidMigration('file preimage.');
    }
  }
  return undefined;
}

export interface SqliteRuntimeCompatibilityWriter {
  readonly databasePath: string;
  readonly profile: SqliteRuntimeFormatProfile;
  readonly available: boolean;
  suppressSession(source: SqliteRuntimeCompatibilitySourceReference, sessionId: string): boolean;
  clearSessionSuppression(
    source: SqliteRuntimeCompatibilitySourceReference,
    sessionId: string,
  ): boolean;
  isSessionSuppressed(
    source: SqliteRuntimeCompatibilitySourceReference,
    sessionId: string,
  ): boolean;
  importSession(
    source: SqliteRuntimeCompatibilitySource,
    sessionId: string,
    migrate: SqliteRuntimeCompatibilityMigrator,
  ): SqliteRuntimeCompatibilityImportResult;
  close(): void;
}

/**
 * Create the stable current writer. The writer owns the target connection;
 * every session import is an independent immediate transaction. An unknown
 * pre-existing target is left untouched and exposed as unavailable.
 */
export function createSqliteRuntimeCompatibilityWriter(input: {
  readonly databasePath: string;
  readonly profile?: SqliteRuntimeFormatProfile;
  readonly journalMode?: 'wal' | 'delete';
}): SqliteRuntimeCompatibilityWriter {
  const profile = input.profile ?? {
    storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
  };
  assertNoFollowDatabasePath(input.databasePath);
  if (input.databasePath !== ':memory:') {
    mkdirSync(dirname(input.databasePath), { recursive: true });
  }
  if (!classifyTargetPath(input.databasePath, profile)) {
    return Object.freeze({
      databasePath: input.databasePath,
      profile,
      available: false,
      suppressSession: () => false,
      clearSessionSuppression: () => false,
      isSessionSuppressed: () => false,
      importSession: (_source: SqliteRuntimeCompatibilitySource, sessionId: string) => ({
        status: 'ignored' as const,
        sessionId,
      }),
      close: () => undefined,
    });
  }
  let database: Database | undefined;
  let available = false;
  let closed = false;
  try {
    database = new Database(
      input.databasePath,
      constants.SQLITE_OPEN_READWRITE |
        constants.SQLITE_OPEN_CREATE |
        constants.SQLITE_OPEN_NOFOLLOW,
    );
    database.run('PRAGMA busy_timeout = 5000');
    const existingTables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (existingTables.length === 0) {
      database.run(
        `PRAGMA journal_mode = ${input.journalMode ?? defaultSqliteRuntimeJournalMode()}`,
      );
      initializeSqliteRuntimeSchema(database, profile);
      available = true;
    } else if (targetDatabaseLooksCurrent(database, profile)) {
      database.run(
        `PRAGMA journal_mode = ${input.journalMode ?? defaultSqliteRuntimeJournalMode()}`,
      );
      available = true;
    }
  } catch (error) {
    database?.close();
    database = undefined;
    if (
      !(error instanceof SqliteRuntimeStorageOpenError) &&
      !(error instanceof Error && error.name === 'SqliteRuntimeFormatMismatchError')
    ) {
      throw error;
    }
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    database?.close();
  };

  const suppressSession = (
    source: SqliteRuntimeCompatibilitySourceReference,
    sessionId: string,
  ): boolean => {
    if (closed || !available || !database || !sessionId) return false;
    try {
      database.run('BEGIN IMMEDIATE');
      const value = JSON.stringify({
        sourceIdentity: typeof source === 'string' ? null : source.sourceIdentity,
        sourcePath: stableSourcePath(sourcePath(source)),
        sessionId,
        suppressedAt: Date.now(),
      });
      for (const key of sessionTombstoneKeys(source, sessionId)) {
        database
          .query('INSERT OR REPLACE INTO runtime_store_meta (key, value) VALUES (?, ?)')
          .run(key, value);
      }
      database.run('COMMIT');
      return true;
    } catch {
      try {
        database.run('ROLLBACK');
      } catch {
        /* The transaction may already have rolled back. */
      }
      return false;
    }
  };

  const clearSessionSuppression = (
    source: SqliteRuntimeCompatibilitySourceReference,
    sessionId: string,
  ): boolean => {
    if (closed || !available || !database || !sessionId) return false;
    try {
      database.run('BEGIN IMMEDIATE');
      for (const key of sessionTombstoneKeys(source, sessionId)) {
        database.query('DELETE FROM runtime_store_meta WHERE key = ?').run(key);
      }
      database.run('COMMIT');
      return true;
    } catch {
      try {
        database.run('ROLLBACK');
      } catch {
        /* The transaction may already have rolled back. */
      }
      return false;
    }
  };

  const isSessionSuppressed = (
    source: SqliteRuntimeCompatibilitySourceReference,
    sessionId: string,
  ): boolean => {
    if (closed || !available || !database || !sessionId) return false;
    try {
      return withReadTransaction(database, () =>
        sessionTombstoneKeys(source, sessionId).some((key) =>
          Boolean(
            database
              .query<{ value: string }, [string]>(
                'SELECT value FROM runtime_store_meta WHERE key = ? LIMIT 1',
              )
              .get(key),
          ),
        ),
      );
    } catch {
      return false;
    }
  };

  const importSession = (
    source: SqliteRuntimeCompatibilitySource,
    sessionId: string,
    migrate: SqliteRuntimeCompatibilityMigrator,
  ): SqliteRuntimeCompatibilityImportResult => {
    const ignored = (): SqliteRuntimeCompatibilityImportResult => ({
      status: 'ignored',
      sessionId,
    });
    if (closed || !available || !database || !source) return ignored();
    if (isSessionSuppressed(source, sessionId)) return ignored();
    const knownSession = source.listSessions().some((entry) => entry.sessionId === sessionId);
    if (!knownSession) return ignored();
    const inputSession = source.readSession(sessionId);
    if (!inputSession) {
      return {
        status: 'failed',
        sessionId,
        error: new Error('Compatibility source session is malformed.'),
      };
    }
    let migrated: SqliteRuntimeCompatibilityTargetSession | null;
    try {
      migrated = migrate(inputSession, source.profile);
    } catch (error) {
      return { status: 'failed', sessionId, error };
    }
    if (!migrated) return ignored();
    if (migrated.sessionId !== sessionId) {
      return { status: 'failed', sessionId, error: invalidMigration('session identity.') };
    }
    const validationError = validateTargetSession(migrated, profile);
    if (validationError) return { status: 'failed', sessionId, error: validationError };
    const ledgerKey = encodedLedgerKey(source, inputSession);
    try {
      database.run('BEGIN IMMEDIATE');
      const ledger = database
        .query<{ value: string }, [string]>('SELECT value FROM runtime_store_meta WHERE key = ?')
        .get(ledgerKey);
      if (ledger) {
        if (
          database
            .query<{ session_id: string }, [string]>(
              'SELECT session_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
            )
            .get(sessionId)
        ) {
          database.run('ROLLBACK');
          return { status: 'already_imported', sessionId };
        }
        const orphanedRows = [
          'runtime_events',
          'runtime_snapshots',
          'runtime_named_snapshots',
          'runtime_file_preimages',
          'runtime_effect_leases',
        ].some((table) =>
          database
            .query<{ session_id: string }, [string]>(
              `SELECT session_id FROM ${table} WHERE session_id = ? LIMIT 1`,
            )
            .get(sessionId),
        );
        if (orphanedRows) {
          database.run('ROLLBACK');
          return {
            status: 'conflict',
            sessionId,
          };
        }
      }
      const existing = database
        .query<{ revision: number }, [string]>(
          'SELECT revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
        )
        .get(sessionId);
      if (existing) {
        database.run('ROLLBACK');
        return { status: 'conflict', sessionId };
      }
      const stateChecksum = migrated.stateChecksum || checksum(migrated.stateJson);
      database
        .query(
          'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, model_provider, model_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          migrated.sessionId,
          migrated.projectId,
          migrated.workspaceDigest,
          profile.stateSchemaVersion,
          profile.formatEpoch,
          migrated.revision,
          migrated.name ?? '',
          migrated.modelProvider ?? null,
          migrated.modelName ?? null,
          migrated.updatedAt ?? Math.floor(Date.now() / 1000),
        );
      for (const event of migrated.events) {
        database
          .query(
            'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            migrated.sessionId,
            event.eventId,
            event.sequence,
            event.schemaVersion ?? profile.stateSchemaVersion,
            event.eventJson,
            event.causationId ?? null,
            event.occurredAt ?? null,
            event.createdAt ?? Math.floor(Date.now() / 1000),
          );
      }
      database
        .query(
          'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
        )
        .run(
          migrated.sessionId,
          profile.stateSchemaVersion,
          profile.formatEpoch,
          migrated.revision,
          migrated.stateJson,
          migrated.eventPosition,
          stateChecksum,
        );
      for (const named of migrated.namedSnapshots ?? []) {
        if (
          named.schemaVersion !== profile.stateSchemaVersion ||
          named.formatEpoch !== profile.formatEpoch ||
          !named.name ||
          !Number.isSafeInteger(named.eventPosition) ||
          named.eventPosition < 0 ||
          !Number.isSafeInteger(named.revision) ||
          named.revision < 0 ||
          !validJson(named.stateJson)
        ) {
          throw new Error('Compatibility migration produced an invalid named snapshot.');
        }
        database
          .query(
            'INSERT INTO runtime_named_snapshots (session_id, name, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            migrated.sessionId,
            named.name,
            profile.stateSchemaVersion,
            profile.formatEpoch,
            named.revision,
            named.stateJson,
            named.eventPosition,
            named.stateChecksum || checksum(named.stateJson),
            named.createdAt,
          );
      }
      for (const preimage of migrated.filePreimages ?? []) {
        if (
          !preimage.path ||
          preimage.path.includes('\0') ||
          !Number.isSafeInteger(preimage.eventPosition) ||
          preimage.eventPosition < 0 ||
          preimage.eventPosition > migrated.eventPosition
        ) {
          throw new Error('Compatibility migration produced an invalid file preimage.');
        }
        database
          .query(
            'INSERT INTO runtime_file_preimages (session_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            migrated.sessionId,
            preimage.path,
            preimage.eventPosition,
            preimage.content,
            preimage.existed ? 1 : 0,
            preimage.postHash,
            preimage.postExisted == null ? null : preimage.postExisted ? 1 : 0,
            preimage.createdAt,
          );
      }
      if (!ledger) {
        database.query('INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)').run(
          ledgerKey,
          JSON.stringify({
            sourceIdentity: source.sourceIdentity,
            sourceSessionId: inputSession.session.sessionId,
            sourceRevision: inputSession.snapshot.revision,
            sourceSnapshotChecksum:
              inputSession.snapshot.stateChecksum || checksum(inputSession.snapshot.stateJson),
            importedAt: Date.now(),
          }),
        );
      }
      database.run('COMMIT');
      return { status: 'imported', sessionId };
    } catch (error) {
      try {
        database.run('ROLLBACK');
      } catch {
        /* SQLite may already have rolled back after a constraint error. */
      }
      return { status: 'failed', sessionId, error };
    }
  };

  return Object.freeze({
    databasePath: input.databasePath,
    profile,
    get available() {
      return available && !closed;
    },
    suppressSession,
    clearSessionSuppression,
    isSessionSuppressed,
    importSession,
    close,
  });
}
