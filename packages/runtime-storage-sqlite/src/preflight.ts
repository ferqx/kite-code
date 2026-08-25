import { constants, Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ArtifactPort,
  RuntimeEventMetadata,
  RuntimeSnapshotCodec,
} from '@kite/runtime-host/storage';

export const SQLITE_RUNTIME_STATE_SCHEMA_VERSION = 27;
export const SQLITE_RUNTIME_STORE_SCHEMA_VERSION = 5;
export const SQLITE_RUNTIME_FORMAT_EPOCH = 'kite-runtime-saq-v1-2026-08-25' as const;
export type SqliteRuntimeJournalMode = 'wal' | 'delete';

/** Platform-safe journal mode for the current Store implementation. */
export function defaultSqliteRuntimeJournalMode(): SqliteRuntimeJournalMode {
  return process.platform === 'win32' ? 'delete' : 'wal';
}

export class SqliteRuntimeStorageOpenError extends Error {
  readonly code = 'invalid_configuration' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SqliteRuntimeStorageOpenError';
  }
}

export class SqliteRuntimeFormatMismatchError extends Error {
  readonly actualSchemaVersion: number | null;
  readonly actualFormatEpoch: string | null;

  constructor(
    actualSchemaVersion: number | null,
    actualFormatEpoch: string | null,
    cause?: unknown,
  ) {
    super(
      `Runtime format is incompatible (schema=${actualSchemaVersion ?? 'missing'}, epoch=${actualFormatEpoch ?? 'missing'}).`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SqliteRuntimeFormatMismatchError';
    this.actualSchemaVersion = actualSchemaVersion;
    this.actualFormatEpoch = actualFormatEpoch;
  }
}

export class SqliteRuntimeRevisionConflictError extends Error {
  constructor(sessionId: string, expected: number, actual: number | null, detail?: string) {
    super(
      detail ??
        `Runtime revision conflict for ${sessionId}: expected ${expected}, found ${actual ?? 'deleted'}.`,
    );
    this.name = 'SqliteRuntimeRevisionConflictError';
  }
}

export class SqliteRuntimeEffectLeaseConflictError extends Error {
  constructor(sessionId: string, effectId: string) {
    super(`Runtime effect lease is stale for ${sessionId}/${effectId}; commit refused.`);
    this.name = 'SqliteRuntimeEffectLeaseConflictError';
  }
}

export type SqliteRuntimeSnapshotCodec<Event = unknown, State = unknown> = RuntimeSnapshotCodec<
  Event,
  State
>;

export interface SqliteRuntimeStorageOptions {
  readonly journalMode?: SqliteRuntimeJournalMode;
  /** Test-only deterministic SQLITE_FULL injection. */
  readonly faultInjectionMaxPageCount?: number;
}

export interface SqliteRuntimeStorageInput<Event = unknown, State = unknown> {
  readonly databasePath: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly artifacts?: ArtifactPort;
  readonly options?: SqliteRuntimeStorageOptions;
  /** Optional session boundary to check before the write connection is opened. */
  readonly sessionId?: string;
}

export interface EventRow {
  id: number;
  thread_id: string;
  event_json: string;
  created_at: number;
  event_id: string | null;
  revision: number;
  causation_id: string | null;
  occurred_at: string | null;
}

export interface SnapshotRow {
  thread_id: string;
  state_json: string;
  created_at: number;
  event_position: number;
  state_revision: number;
  state_checksum: string;
  schema_version: number;
}

export interface NamedSnapshotRow extends SnapshotRow {
  name: string;
}

export function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function tableExists(database: Database, table: string): boolean {
  return Boolean(
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table)?.count,
  );
}

const CURRENT_STORE_TABLE_COLUMNS = {
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
} as const;

const RECOVERY_IDENTITY_META_PREFIX = 'recovery_identity_v1:';

export function assertNonEmptySessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SqliteRuntimeStorageOpenError('Runtime recovery identity requires a sessionId.');
  }
}

export function isCanonicalRecoveryIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function recoveryIdentityMetaKey(sessionId: string): string {
  assertNonEmptySessionId(sessionId);
  const bytes = new TextEncoder().encode(sessionId);
  let encoded = '';
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0');
  return `${RECOVERY_IDENTITY_META_PREFIX}${encoded}`;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function rejectSymlink(path: string, label: string, allowMissing = true): void {
  const stat = lstatIfPresent(path);
  if (!stat && allowMissing) return;
  if (stat?.isSymbolicLink()) {
    throw new SqliteRuntimeStorageOpenError(`${label} must not be a symlink.`);
  }
}

export function assertNoFollowDatabasePath(dbPath: string): void {
  if (dbPath === ':memory:') return;
  rejectSymlink(dbPath, 'SQLite database path');
  rejectSymlink(dirname(dbPath), 'SQLite database parent');
}

function copyNoFollowFile(sourcePath: string, targetPath: string, label: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) {
      throw new SqliteRuntimeStorageOpenError(`${label} must be a regular file.`);
    }
    writeFileSync(targetPath, readFileSync(descriptor), { flag: 'wx' });
  } catch (error) {
    if (error instanceof SqliteRuntimeStorageOpenError) throw error;
    throw new SqliteRuntimeStorageOpenError(
      `SQLite preflight could not safely copy ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertCurrentStoreShape(database: Database): void {
  const expectedTables = Object.keys(CURRENT_STORE_TABLE_COLUMNS).sort();
  const actualTables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((entry) => entry.name);
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw new SqliteRuntimeFormatMismatchError(null, null);
  }
  for (const [table, required] of Object.entries(CURRENT_STORE_TABLE_COLUMNS)) {
    if (!tableExists(database, table)) throw new SqliteRuntimeFormatMismatchError(null, null);
    const columns = new Set(
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((entry) => entry.name),
    );
    if (columns.size !== required.length || required.some((column) => !columns.has(column))) {
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
  }
  const expectedIndexes = ['runtime_events_session_sequence', 'runtime_file_preimages_position'];
  const actualIndexes = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    )
    .all()
    .map((entry) => entry.name);
  if (
    actualIndexes.length !== expectedIndexes.length ||
    actualIndexes.some((index, position) => index !== expectedIndexes[position])
  ) {
    throw new SqliteRuntimeFormatMismatchError(null, null);
  }
}

/** Validate the marker and schema on the exact already-open connection used by a reader. */
export function assertCurrentSqliteRuntimeStoreConnection(
  database: Database,
): ReadonlyMap<string, string> {
  const marker = database
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM runtime_store_meta WHERE key IN ('format_version', 'runtime_format_epoch')",
    )
    .all();
  const values = new Map(marker.map((entry) => [entry.key, entry.value]));
  if (
    Number(values.get('format_version')) !== SQLITE_RUNTIME_STORE_SCHEMA_VERSION ||
    values.get('runtime_format_epoch') !== SQLITE_RUNTIME_FORMAT_EPOCH
  ) {
    throw new SqliteRuntimeFormatMismatchError(
      Number(values.get('format_version')) || null,
      values.get('runtime_format_epoch') ?? null,
    );
  }
  assertCurrentStoreShape(database);
  return values;
}

/**
 * Open a no-follow read snapshot without mutating the source Store. When a
 * WAL exists, the database and sidecars are copied into an isolated directory
 * so SQLite may rebuild an absent SHM index there.
 */
export function openSqliteReadonlySnapshotView(dbPath: string): {
  database: Database;
  close: () => void;
} {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assertNoFollowDatabasePath(dbPath);
  const walStat = lstatIfPresent(walPath);
  const shmStat = lstatIfPresent(shmPath);
  if (walStat?.isSymbolicLink()) {
    throw new SqliteRuntimeStorageOpenError('SQLite WAL source must not be a symlink.');
  }
  if (shmStat?.isSymbolicLink()) {
    throw new SqliteRuntimeStorageOpenError('SQLite SHM source must not be a symlink.');
  }
  if (!walStat) {
    const immutableUrl = pathToFileURL(dbPath);
    immutableUrl.searchParams.set('immutable', '1');
    const database = new Database(
      immutableUrl.href,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW,
    );
    return { database, close: () => database.close() };
  }
  const copyRoot = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-preflight-'));
  const copyPath = join(copyRoot, basename(dbPath));
  try {
    copyNoFollowFile(dbPath, copyPath, 'SQLite database');
    copyNoFollowFile(walPath, `${copyPath}-wal`, 'SQLite WAL source');
    if (shmStat) copyNoFollowFile(shmPath, `${copyPath}-shm`, 'SQLite SHM source');
    const database = new Database(
      copyPath,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
    );
    return {
      database,
      close: () => {
        database.close();
        rmSync(copyRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(copyRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Read-only Store 5 preflight. Existing files are never migrated or rewritten. */
export function assertSqliteRuntimeStorageCanOpen<Event = unknown, State = unknown>(
  dbPath: string,
  codec?: SqliteRuntimeSnapshotCodec<Event, State>,
  sessionId?: string,
): void {
  if (dbPath === ':memory:') return;
  assertNoFollowDatabasePath(dbPath);
  if (!existsSync(dbPath)) return;
  const view = openSqliteReadonlySnapshotView(dbPath);
  try {
    const database = view.database;
    const hasMeta = tableExists(database, 'runtime_store_meta');
    const hasData =
      tableExists(database, 'runtime_events') ||
      tableExists(database, 'runtime_snapshots') ||
      tableExists(database, 'runtime_sessions');
    if (!hasMeta) {
      if (hasData) throw new SqliteRuntimeFormatMismatchError(null, null);
      return;
    }
    const values = assertCurrentSqliteRuntimeStoreConnection(database);
    // A database-wide owner is used for session discovery and must not let one
    // damaged historical session block every healthy session. Deep event and
    // snapshot validation belongs to a session-scoped open.
    if (!codec || !sessionId) return;
    try {
      const events = database
        .query<{ schema_version: number; event_json: string }, [string]>(
          'SELECT schema_version, event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId);
      for (const event of events) {
        if (event.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION) {
          throw new SqliteRuntimeFormatMismatchError(
            event.schema_version,
            values.get('runtime_format_epoch')!,
          );
        }
        codec.decodeEvent(event.event_json);
      }
    } catch (error) {
      if (error instanceof SqliteRuntimeFormatMismatchError) throw error;
      throw new SqliteRuntimeFormatMismatchError(null, null, error);
    }
    try {
      for (const currentSessionId of [sessionId]) {
        const row = database
          .query<
            {
              state_json: string;
              schema_version: number;
              format_epoch: string;
              event_position: number;
              revision: number;
              state_checksum: string;
            },
            [string]
          >(
            'SELECT state_json, schema_version, format_epoch, event_position, revision, state_checksum FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
          )
          .get(currentSessionId);
        if (!row) {
          throw new SqliteRuntimeFormatMismatchError(
            SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
            values.get('runtime_format_epoch')!,
          );
        }
        if (!row.state_checksum || checksum(row.state_json) !== row.state_checksum) {
          throw new SqliteRuntimeStorageOpenError('Store snapshot checksum is invalid.');
        }
        const state = codec.decodeState<State>(row.state_json);
        const metadata = codec.snapshotMetadata(state);
        const identity = codec.sessionIdentity?.(state);
        const session = database
          .query<
            {
              project_id: string;
              workspace_digest: string;
              state_schema: number;
              format_epoch: string;
              revision: number;
            },
            [string]
          >(
            'SELECT project_id, workspace_digest, state_schema, format_epoch, revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
          )
          .get(currentSessionId);
        const eventRevision =
          database
            .query<{ sequence: number }, [string, number]>(
              'SELECT sequence FROM runtime_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1',
            )
            .get(currentSessionId, row.event_position)?.sequence ?? 0;
        if (
          row.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
          row.format_epoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
          metadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
          metadata.stateRevision !== row.revision ||
          row.revision !== eventRevision ||
          !identity ||
          !session ||
          session.project_id !== identity.projectId ||
          session.workspace_digest !== identity.canonicalWorkspaceDigest ||
          session.state_schema !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
          session.format_epoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
          session.revision !== row.revision
        ) {
          throw new SqliteRuntimeFormatMismatchError(
            metadata.schemaVersion,
            values.get('runtime_format_epoch')!,
          );
        }
        codec.validateSnapshot?.({
          state,
          sessionId: currentSessionId,
          eventPosition: row.event_position,
          stateRevision: row.revision,
          schemaVersion: row.schema_version,
          eventRevision,
        });
      }
    } catch (error) {
      if (error instanceof SqliteRuntimeFormatMismatchError) throw error;
      throw new SqliteRuntimeFormatMismatchError(null, null);
    }
  } finally {
    view.close();
  }
}

export function eventMetadataAt(
  metadata: readonly RuntimeEventMetadata[] | undefined,
  index: number,
): RuntimeEventMetadata | undefined {
  return metadata?.[index];
}
