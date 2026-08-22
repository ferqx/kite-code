import { constants, Database } from 'bun:sqlite';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
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
import {
  type ArtifactPort,
  type CheckpointPort,
  createArtifactPortV1,
  type EffectLeasePort,
  type RuntimeEventMetadataV1,
  type RuntimeFileRestoreMaterialV1,
  type RuntimeRecoveryIdentityPortV1,
  type RuntimeSessionInfoV1,
  type RuntimeSessionModelRouteV1,
  type RuntimeSnapshotCodecV1,
  type RuntimeSnapshotMetadataV1,
  type RuntimeStorage,
  type RuntimeStorageBoundaryV1,
  type RuntimeTransactionInputV1,
  RuntimeUniqueReceiptConflictErrorV1,
  type RuntimeUniqueReceiptV1,
  type SessionStore,
  type StoredRuntimeEventV1,
} from '@kite/runtime-host/storage';

export const SQLITE_RUNTIME_STATE_SCHEMA_VERSION = 25;
export const SQLITE_RUNTIME_STORE_SCHEMA_VERSION = 4;
export const SQLITE_RUNTIME_FORMAT_EPOCH = 'kite-runtime-2026-08-18' as const;
export type SqliteRuntimeJournalModeV1 = 'wal' | 'delete';

/** Platform-safe production journal mode; Store 4 bytes and schema are unchanged. */
export function defaultSqliteRuntimeJournalModeV1(): SqliteRuntimeJournalModeV1 {
  return process.platform === 'win32' ? 'delete' : 'wal';
}

/** Derive the Store 4 sidecar path without turning SQLite's memory sentinel into a file. */
export function sqliteRuntimeStorePathForV1(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return `${checkpointPath.replace(/\.sqlite$/, '')}.runtime.db`;
}

export class SqliteRuntimeStorageOpenError extends Error {
  readonly code = 'invalid_configuration' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SqliteRuntimeStorageOpenError';
  }
}

export class SqliteRuntimeFormatIncompatibleError extends Error {
  readonly actualSchemaVersion: number | null;
  readonly actualFormatEpoch: string | null;

  constructor(actualSchemaVersion: number | null, actualFormatEpoch: string | null) {
    super(
      `Runtime format is incompatible (schema=${actualSchemaVersion ?? 'missing'}, epoch=${actualFormatEpoch ?? 'missing'}).`,
    );
    this.name = 'SqliteRuntimeFormatIncompatibleError';
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

export class SqliteRuntimeUniqueReceiptConflictError extends RuntimeUniqueReceiptConflictErrorV1 {
  constructor(cause?: unknown) {
    super(cause);
    this.name = 'SqliteRuntimeUniqueReceiptConflictError';
  }
}

export type SqliteRuntimeSnapshotCodecV1<Event = unknown, State = unknown> = RuntimeSnapshotCodecV1<
  Event,
  State
>;

export type SqliteRuntimeUniqueReceiptV1 = RuntimeUniqueReceiptV1;

export interface SqliteRuntimeStorageOptionsV1 {
  readonly journalMode?: SqliteRuntimeJournalModeV1;
  /** Test-only deterministic SQLITE_FULL injection. */
  readonly faultInjectionMaxPageCount?: number;
}

export interface SqliteRuntimeStorageInputV1<Event = unknown, State = unknown> {
  readonly databasePath: string;
  readonly codec: SqliteRuntimeSnapshotCodecV1<Event, State>;
  readonly artifacts?: ArtifactPort;
  readonly options?: SqliteRuntimeStorageOptionsV1;
  /** Optional session boundary to check before the write connection is opened. */
  readonly sessionId?: string;
  /** Host-owned extraction of a one-shot receipt permit from an opaque event. */
  readonly uniqueReceiptForEvent?: (event: Event) => SqliteRuntimeUniqueReceiptV1 | null;
}

interface EventRow {
  id: number;
  thread_id: string;
  event_json: string;
  created_at: number;
  event_id: string | null;
  revision: number;
  causation_id: string | null;
  occurred_at: string | null;
}

interface SnapshotRow {
  thread_id: string;
  state_json: string;
  created_at: number;
  event_position: number;
  state_revision: number;
  state_checksum: string;
  schema_version: number;
}

interface NamedSnapshotRow extends SnapshotRow {
  name: string;
}

function checksum(value: string): string {
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

const STORE_TABLE_COLUMNS = {
  runtime_events: [
    'id',
    'thread_id',
    'event_json',
    'event_id',
    'revision',
    'causation_id',
    'occurred_at',
    'created_at',
  ],
  runtime_sessions: ['thread_id', 'name', 'model_provider', 'model_name', 'updated_at'],
  runtime_named_snapshots: [
    'thread_id',
    'name',
    'event_position',
    'state_json',
    'state_revision',
    'state_checksum',
    'schema_version',
    'created_at',
  ],
  runtime_snapshots: [
    'thread_id',
    'state_json',
    'event_position',
    'state_revision',
    'state_checksum',
    'schema_version',
    'created_at',
  ],
  runtime_file_preimages: [
    'thread_id',
    'path',
    'event_position',
    'content',
    'existed',
    'post_hash',
    'post_existed',
    'created_at',
  ],
  runtime_mcp_egress_nonces: [
    'thread_id',
    'nonce_digest',
    'invocation_id',
    'receipt_digest',
    'expires_at',
    'created_at',
  ],
  runtime_effect_leases: ['thread_id', 'effect_id', 'owner_id', 'expires_at_ms'],
} as const;

const RECOVERY_IDENTITY_META_PREFIX = 'recovery_identity_v1:';

function assertNonEmptySessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SqliteRuntimeStorageOpenError('Runtime recovery identity requires a sessionId.');
  }
}

function isCanonicalRecoveryIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function recoveryIdentityMetaKey(sessionId: string): string {
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

function assertNoFollowDatabasePath(dbPath: string): void {
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

function assertStoreShape(database: Database): void {
  for (const [table, required] of Object.entries(STORE_TABLE_COLUMNS)) {
    if (!tableExists(database, table)) throw new SqliteRuntimeFormatIncompatibleError(null, null);
    const columns = new Set(
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((entry) => entry.name),
    );
    if (required.some((column) => !columns.has(column))) {
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
  }
}

function openPreflightView(dbPath: string): { database: Database; close: () => void } {
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

/** Read-only Store 4 preflight. Existing files are never migrated or rewritten. */
export function assertSqliteRuntimeStorageCanOpen<Event = unknown, State = unknown>(
  dbPath: string,
  codec?: SqliteRuntimeSnapshotCodecV1<Event, State>,
  sessionId?: string,
): void {
  if (dbPath === ':memory:') return;
  assertNoFollowDatabasePath(dbPath);
  if (!existsSync(dbPath)) return;
  const view = openPreflightView(dbPath);
  try {
    const database = view.database;
    const hasMeta = tableExists(database, 'runtime_store_meta');
    const hasData =
      tableExists(database, 'runtime_events') ||
      tableExists(database, 'runtime_snapshots') ||
      tableExists(database, 'runtime_named_snapshots');
    if (!hasMeta) {
      if (hasData) throw new SqliteRuntimeFormatIncompatibleError(null, null);
      return;
    }
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
      throw new SqliteRuntimeFormatIncompatibleError(
        Number(values.get('format_version')) || null,
        values.get('runtime_format_epoch') ?? null,
      );
    }
    assertStoreShape(database);
    if (!codec || !sessionId) return;
    const row = database
      .query<
        {
          state_json: string;
          schema_version: number;
          event_position: number;
          state_revision: number;
        },
        [string]
      >(
        'SELECT state_json, schema_version, event_position, state_revision FROM runtime_snapshots WHERE thread_id = ? LIMIT 1',
      )
      .get(sessionId);
    if (!row) return;
    try {
      const state = codec.decodeState<State>(row.state_json);
      const metadata = codec.snapshotMetadata(state);
      const eventRevision =
        database
          .query<{ revision: number }, [string, number]>(
            'SELECT revision FROM runtime_events WHERE thread_id = ? AND id <= ? ORDER BY id DESC LIMIT 1',
          )
          .get(sessionId, row.event_position)?.revision ?? 0;
      if (
        row.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
        metadata.schemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
        metadata.stateRevision !== row.state_revision ||
        row.state_revision !== eventRevision
      ) {
        throw new SqliteRuntimeFormatIncompatibleError(
          metadata.schemaVersion,
          SQLITE_RUNTIME_FORMAT_EPOCH,
        );
      }
      codec.validateSnapshot?.({
        state,
        sessionId,
        eventPosition: row.event_position,
        stateRevision: row.state_revision,
        schemaVersion: row.schema_version,
        eventRevision,
      });
    } catch (error) {
      if (error instanceof SqliteRuntimeFormatIncompatibleError) throw error;
      throw new SqliteRuntimeFormatIncompatibleError(null, null);
    }
  } finally {
    view.close();
  }
}

function eventMetadataAt(
  metadata: readonly RuntimeEventMetadataV1[] | undefined,
  index: number,
): RuntimeEventMetadataV1 | undefined {
  return metadata?.[index];
}

export class SqliteRuntimeStorageAdapter<Event = unknown, State = unknown>
  implements RuntimeStorage<Event, State>
{
  readonly adapterId = 'sqlite';
  readonly stateSchemaVersion = SQLITE_RUNTIME_STATE_SCHEMA_VERSION as 25;
  readonly storeSchemaVersion = SQLITE_RUNTIME_STORE_SCHEMA_VERSION as 4;
  readonly compatibilityEpoch = SQLITE_RUNTIME_FORMAT_EPOCH;
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeStorage<Event, State>['transactions'];
  readonly effects: EffectLeasePort;
  readonly checkpoints: CheckpointPort<State>;
  readonly artifacts: ArtifactPort;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPortV1;
  readonly #db: Database;
  readonly #codec: SqliteRuntimeSnapshotCodecV1<Event, State>;
  readonly #uniqueReceiptForEvent?: (event: Event) => SqliteRuntimeUniqueReceiptV1 | null;
  #closed = false;

  constructor(input: SqliteRuntimeStorageInputV1<Event, State>) {
    if (!input.databasePath || !input.codec) {
      throw new SqliteRuntimeStorageOpenError(
        'SQLite Runtime storage requires a databasePath and codec.',
      );
    }
    this.#codec = input.codec;
    this.#uniqueReceiptForEvent = input.uniqueReceiptForEvent;
    this.artifacts = input.artifacts ?? createArtifactPortV1();
    assertNoFollowDatabasePath(input.databasePath);
    assertSqliteRuntimeStorageCanOpen(input.databasePath, input.codec, input.sessionId);
    if (input.databasePath !== ':memory:')
      mkdirSync(dirname(input.databasePath), { recursive: true });
    const db = new Database(
      input.databasePath,
      constants.SQLITE_OPEN_READWRITE |
        constants.SQLITE_OPEN_CREATE |
        constants.SQLITE_OPEN_NOFOLLOW,
    );
    const journalMode = input.options?.journalMode ?? defaultSqliteRuntimeJournalModeV1();
    try {
      db.run('PRAGMA busy_timeout = 5000');
      db.run(`PRAGMA journal_mode = ${journalMode}`);
      db.run('BEGIN IMMEDIATE');
      try {
        db.run(
          `CREATE TABLE IF NOT EXISTS runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        );
        db.run(`CREATE TABLE IF NOT EXISTS runtime_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, event_json TEXT NOT NULL,
          event_id TEXT, revision INTEGER NOT NULL DEFAULT 0, causation_id TEXT, occurred_at TEXT,
          created_at INTEGER DEFAULT (unixepoch()))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_sessions (
          thread_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', model_provider TEXT,
          model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_named_snapshots (
          thread_id TEXT NOT NULL, name TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
          state_json TEXT NOT NULL, state_revision INTEGER NOT NULL, state_checksum TEXT NOT NULL,
          schema_version INTEGER NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (thread_id, name))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_snapshots (
          thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
          state_revision INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL DEFAULT '',
          schema_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_file_preimages (
          thread_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
          content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER,
          created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (thread_id, path, event_position))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_mcp_egress_nonces (
          thread_id TEXT NOT NULL, nonce_digest TEXT NOT NULL, invocation_id TEXT NOT NULL,
          receipt_digest TEXT NOT NULL, expires_at TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (nonce_digest))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_effect_leases (
          thread_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL, PRIMARY KEY (thread_id, effect_id))`);
        db.run(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_event_id ON runtime_events(thread_id, event_id) WHERE event_id IS NOT NULL',
        );
        db.run('CREATE INDEX IF NOT EXISTS idx_runtime_events_thread ON runtime_events(thread_id)');
        db.run(
          'CREATE INDEX IF NOT EXISTS idx_runtime_file_preimages_position ON runtime_file_preimages(thread_id, event_position)',
        );
        db.run(
          "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('format_version', ?)",
          [String(SQLITE_RUNTIME_STORE_SCHEMA_VERSION)],
        );
        db.run(
          "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('runtime_format_epoch', ?)",
          [SQLITE_RUNTIME_FORMAT_EPOCH],
        );
        const marker = db
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'format_version'",
          )
          .get();
        const epoch = db
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'runtime_format_epoch'",
          )
          .get();
        if (
          !marker ||
          Number(marker.value) !== SQLITE_RUNTIME_STORE_SCHEMA_VERSION ||
          !epoch ||
          epoch.value !== SQLITE_RUNTIME_FORMAT_EPOCH
        ) {
          throw new SqliteRuntimeFormatIncompatibleError(
            Number(marker?.value) || null,
            epoch?.value ?? null,
          );
        }
        db.run('COMMIT');
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* begin may have failed */
        }
        throw error;
      }
      if (input.options?.faultInjectionMaxPageCount != null) {
        const value = input.options.faultInjectionMaxPageCount;
        if (!Number.isInteger(value) || value <= 0)
          throw new SqliteRuntimeStorageOpenError(
            'faultInjectionMaxPageCount must be a positive integer',
          );
        db.run(`PRAGMA max_page_count = ${value}`);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    const assertStorageOpen = (): void => {
      if (this.#closed)
        throw new SqliteRuntimeStorageOpenError('SQLite Runtime storage is closed.');
    };
    const withImmediateTransaction = <T>(work: () => T): T => {
      assertStorageOpen();
      db.run('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.run('COMMIT');
        return result;
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* The transaction may already have been rolled back by SQLite. */
        }
        throw error;
      }
    };
    this.recoveryIdentities = Object.freeze({
      read: (sessionId: string): string | null => {
        assertStorageOpen();
        const key = recoveryIdentityMetaKey(sessionId);
        const row = selectRecoveryIdentity.get(key);
        if (!row) return null;
        if (!isCanonicalRecoveryIdentity(row.value)) {
          throw new SqliteRuntimeStorageOpenError(
            'Persisted runtime recovery identity is malformed.',
          );
        }
        return row.value;
      },
      getOrCreate: (sessionId: string, allocate: () => string): string => {
        assertNonEmptySessionId(sessionId);
        if (typeof allocate !== 'function') {
          throw new SqliteRuntimeStorageOpenError(
            'Runtime recovery identity requires a Host allocator.',
          );
        }
        const key = recoveryIdentityMetaKey(sessionId);
        return withImmediateTransaction(() => {
          const existing = selectRecoveryIdentity.get(key)?.value;
          if (existing !== undefined) {
            if (!isCanonicalRecoveryIdentity(existing)) {
              throw new SqliteRuntimeStorageOpenError(
                'Persisted runtime recovery identity is malformed.',
              );
            }
            return existing;
          }
          const allocated = allocate();
          if (!isCanonicalRecoveryIdentity(allocated)) {
            throw new SqliteRuntimeStorageOpenError(
              'Host recovery identity allocator returned an invalid key.',
            );
          }
          insertRecoveryIdentity.run(key, allocated);
          return allocated;
        });
      },
      remove: (sessionId: string): void => {
        const key = recoveryIdentityMetaKey(sessionId);
        withImmediateTransaction(() => {
          deleteRecoveryIdentity.run(key);
        });
      },
    });
    const insertEvent = db.query(
      'INSERT INTO runtime_events (thread_id, event_json) VALUES (?, ?)',
    );
    const insertEventWithMetadata = db.query(
      'INSERT OR IGNORE INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertUniqueReceipt = db.query(
      'INSERT INTO runtime_mcp_egress_nonces (thread_id, nonce_digest, invocation_id, receipt_digest, expires_at) VALUES (?, ?, ?, ?, ?)',
    );
    const deleteExpiredUniqueReceipts = db.query(
      'DELETE FROM runtime_mcp_egress_nonces WHERE expires_at <= ?',
    );
    const insertForkEvent = db.query(
      'INSERT INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const selectEvents = db.query<EventRow, [string, number]>(
      'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at FROM runtime_events WHERE thread_id = ? AND id > ? ORDER BY id ASC',
    );
    const selectAllEvents = db.query<EventRow, [string]>(
      'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at FROM runtime_events WHERE thread_id = ? ORDER BY id ASC',
    );
    const upsertSnapshot = db.query(
      'INSERT OR REPLACE INTO runtime_snapshots (thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const selectSnapshot = db.query<SnapshotRow, [string]>(
      'SELECT thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    const selectSnapshotRevision = db.query<{ state_revision: number }, [string]>(
      'SELECT state_revision FROM runtime_snapshots WHERE thread_id = ?',
    );
    const selectLastEventPosition = db.query<{ id: number | null }, [string]>(
      'SELECT MAX(id) AS id FROM runtime_events WHERE thread_id = ?',
    );
    const selectEventRevisionAtOrBefore = db.query<{ revision: number }, [string, number]>(
      'SELECT revision FROM runtime_events WHERE thread_id = ? AND id <= ? ORDER BY id DESC LIMIT 1',
    );
    const upsertSession = db.query(
      "INSERT INTO runtime_sessions (thread_id, name, updated_at) VALUES (?, '', unixepoch()) ON CONFLICT(thread_id) DO UPDATE SET updated_at = unixepoch()",
    );
    const updateSessionName = db.query(
      'UPDATE runtime_sessions SET name = ?, updated_at = unixepoch() WHERE thread_id = ?',
    );
    const selectSessionModelRoute = db.query<
      { model_provider: string | null; model_name: string | null },
      [string]
    >('SELECT model_provider, model_name FROM runtime_sessions WHERE thread_id = ?');
    const updateSessionModelRoute = db.query(
      'UPDATE runtime_sessions SET model_provider = ?, model_name = ?, updated_at = unixepoch() WHERE thread_id = ?',
    );
    const listSessionsQuery = db.query<
      { thread_id: string; name: string; updated_at: number },
      [number]
    >('SELECT thread_id, name, updated_at FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?');
    const deleteEvents = db.query('DELETE FROM runtime_events WHERE thread_id = ?');
    const deleteEventsAfter = db.query('DELETE FROM runtime_events WHERE thread_id = ? AND id > ?');
    const deleteSnapshot = db.query('DELETE FROM runtime_snapshots WHERE thread_id = ?');
    const deleteNamedSnapshots = db.query(
      'DELETE FROM runtime_named_snapshots WHERE thread_id = ?',
    );
    const deleteNamedSnapshotsAfter = db.query(
      'DELETE FROM runtime_named_snapshots WHERE thread_id = ? AND event_position > ?',
    );
    const upsertNamedSnapshot = db.query(
      'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const insertForkNamedSnapshot = db.query(
      'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const selectNamedSnapshot = db.query<NamedSnapshotRow, [string, string]>(
      'SELECT thread_id, name, state_json, event_position, state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
    );
    const selectNamedSnapshotsForFork = db.query<NamedSnapshotRow, [string, number]>(
      'SELECT thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND event_position <= ? ORDER BY event_position ASC, name ASC',
    );
    const listNamedSnapshotsQuery = db.query<
      { name: string; event_position: number; created_at: number; affected_file_count: number },
      [string]
    >(
      `SELECT s.name, s.event_position, s.created_at, (SELECT COUNT(DISTINCT p.path) FROM runtime_file_preimages p WHERE p.thread_id = s.thread_id AND p.event_position > s.event_position) AS affected_file_count FROM runtime_named_snapshots s WHERE s.thread_id = ? ORDER BY s.created_at DESC, s.name DESC`,
    );
    const selectNamedSnapshotEntry = db.query<NamedSnapshotRow, [string, string]>(
      'SELECT thread_id, name, event_position, state_json, state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
    );
    const deleteFilePreimages = db.query('DELETE FROM runtime_file_preimages WHERE thread_id = ?');
    const deleteFilePreimagesAfter = db.query(
      'DELETE FROM runtime_file_preimages WHERE thread_id = ? AND event_position > ?',
    );
    const insertFilePreimage = db.query(
      'INSERT OR REPLACE INTO runtime_file_preimages (thread_id, path, event_position, content, existed) VALUES (?, ?, ?, ?, ?)',
    );
    const selectFilePreimageInWindow = db.query<{ path: string }, [string, string, number]>(
      'SELECT path FROM runtime_file_preimages WHERE thread_id = ? AND path = ? AND event_position > ? LIMIT 1',
    );
    const updateFilePostimageInWindow = db.query(
      `UPDATE runtime_file_preimages SET post_hash = ?, post_existed = ? WHERE rowid = (SELECT rowid FROM runtime_file_preimages WHERE thread_id = ? AND path = ? AND event_position > ? ORDER BY event_position DESC LIMIT 1)`,
    );
    const selectLatestSnapshotPosition = db.query<{ event_position: number | null }, [string]>(
      'SELECT MAX(event_position) AS event_position FROM runtime_named_snapshots WHERE thread_id = ?',
    );
    const selectFileRestorePlan = db.query<
      {
        path: string;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
      },
      [string, number]
    >(
      `WITH bounds AS (SELECT thread_id, path, MIN(event_position) AS min_position, MAX(event_position) AS max_position FROM runtime_file_preimages WHERE thread_id = ? AND event_position > ? GROUP BY thread_id, path) SELECT first.path AS path, first.content AS content, first.existed AS existed, last.post_hash AS post_hash, last.post_existed AS post_existed FROM bounds JOIN runtime_file_preimages first ON first.thread_id = bounds.thread_id AND first.path = bounds.path AND first.event_position = bounds.min_position JOIN runtime_file_preimages last ON last.thread_id = bounds.thread_id AND last.path = bounds.path AND last.event_position = bounds.max_position`,
    );
    const selectFilePreimagesForFork = db.query<
      {
        path: string;
        event_position: number;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
        created_at: number;
      },
      [string, number]
    >(
      'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE thread_id = ? AND event_position <= ? ORDER BY event_position ASC, path ASC',
    );
    const insertForkFilePreimage = db.query(
      'INSERT OR REPLACE INTO runtime_file_preimages (thread_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const deleteEffectLeases = db.query('DELETE FROM runtime_effect_leases WHERE thread_id = ?');
    const deleteSession = db.query('DELETE FROM runtime_sessions WHERE thread_id = ?');
    const deleteExpiredLease = db.query(
      'DELETE FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND expires_at_ms <= ?',
    );
    const insertLease = db.query(
      'INSERT OR IGNORE INTO runtime_effect_leases (thread_id, effect_id, owner_id, expires_at_ms) VALUES (?, ?, ?, ?)',
    );
    const selectLease = db.query<{ owner_id: string }, [string, string, string, number]>(
      'SELECT owner_id FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
    );
    const renewLease = db.query(
      'UPDATE runtime_effect_leases SET expires_at_ms = ? WHERE thread_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
    );
    const releaseLease = db.query(
      'DELETE FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND owner_id = ?',
    );
    const selectRecoveryIdentity = db.query<{ value: string }, [string]>(
      'SELECT value FROM runtime_store_meta WHERE key = ?',
    );
    const insertRecoveryIdentity = db.query(
      'INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)',
    );
    const deleteRecoveryIdentity = db.query('DELETE FROM runtime_store_meta WHERE key = ?');

    const insertEvents = (
      sessionId: string,
      events: readonly Event[],
      metadata?: readonly RuntimeEventMetadataV1[],
      forkCreatedAt?: readonly number[],
    ): void => {
      for (const [index, event] of events.entries()) {
        const receipt = this.#uniqueReceiptForEvent?.(event);
        if (receipt) {
          deleteExpiredUniqueReceipts.run(receipt.pruneBefore ?? receipt.expiresAt);
          try {
            insertUniqueReceipt.run(
              sessionId,
              receipt.nonceDigest,
              receipt.invocationId,
              receipt.receiptDigest,
              receipt.expiresAt,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('runtime_mcp_egress_nonces') || message.includes('nonce_digest'))
              throw new SqliteRuntimeUniqueReceiptConflictError(error);
            throw error;
          }
        }
        const entry = eventMetadataAt(metadata, index);
        const json = this.#codec.encodeEvent(event);
        if (entry) {
          const statement = forkCreatedAt ? insertForkEvent : insertEventWithMetadata;
          if (forkCreatedAt)
            statement.run(
              sessionId,
              json,
              entry.eventId,
              entry.revision,
              entry.causationId ?? null,
              entry.occurredAt ?? null,
              forkCreatedAt[index] ?? 0,
            );
          else
            statement.run(
              sessionId,
              json,
              entry.eventId,
              entry.revision,
              entry.causationId ?? null,
              entry.occurredAt ?? new Date().toISOString(),
            );
        } else {
          if (forkCreatedAt)
            insertForkEvent.run(sessionId, json, null, 0, null, null, forkCreatedAt[index] ?? 0);
          else insertEvent.run(sessionId, json);
        }
      }
    };

    const snapshotMeta = (
      state: State,
      explicit?: RuntimeSnapshotMetadataV1,
    ): RuntimeSnapshotMetadataV1 => {
      if (explicit) return explicit;
      const metadata = this.#codec.snapshotMetadata(state);
      return {
        eventPosition: 0,
        stateRevision: metadata.stateRevision,
        stateChecksum: '',
        schemaVersion: metadata.schemaVersion,
      };
    };
    const encodeSnapshot = (
      state: State,
      explicit?: RuntimeSnapshotMetadataV1,
    ): { json: string; metadata: RuntimeSnapshotMetadataV1 } => {
      const json = this.#codec.encodeState(state);
      const derived = snapshotMeta(state, explicit);
      return {
        json,
        metadata: { ...derived, stateChecksum: derived.stateChecksum || checksum(json) },
      };
    };
    const restoreValidation = (
      state: State,
      sessionId: string,
      row: SnapshotRow | NamedSnapshotRow,
      eventRevision: number,
    ): void => {
      this.#codec.validateSnapshot?.({
        state,
        sessionId,
        eventPosition: row.event_position,
        stateRevision: row.state_revision,
        schemaVersion: row.schema_version,
        eventRevision,
      });
    };
    const loadEvents = (sessionId: string, since?: number): StoredRuntimeEventV1<Event>[] => {
      if (this.#closed) return [];
      const rows =
        since == null ? selectAllEvents.all(sessionId) : selectEvents.all(sessionId, since);
      return rows.map((row) => ({
        id: row.id,
        thread_id: row.thread_id,
        event: this.#codec.decodeEvent(row.event_json),
        created_at: row.created_at,
        ...(row.event_id ? { event_id: row.event_id } : {}),
        revision: row.revision,
        ...(row.causation_id ? { causation_id: row.causation_id } : {}),
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
      }));
    };
    const loadSnapshotRecord = <T = State>(
      sessionId: string,
    ): { state: T; metadata: RuntimeSnapshotMetadataV1 } | null => {
      if (this.#closed) return null;
      const row = selectSnapshot.get(sessionId);
      if (!row || (row.state_checksum && checksum(row.state_json) !== row.state_checksum))
        return null;
      try {
        return {
          state: this.#codec.decodeState<T>(row.state_json),
          metadata: {
            eventPosition: row.event_position,
            stateRevision: row.state_revision,
            stateChecksum: row.state_checksum,
            schemaVersion: row.schema_version,
          },
        };
      } catch {
        return null;
      }
    };
    const lastEvent = (sessionId: string): number =>
      selectLastEventPosition.get(sessionId)?.id ?? 0;
    const saveSnapshot = (sessionId: string, state: State): void => {
      if (this.#closed) return;
      const encoded = encodeSnapshot(state);
      const position = lastEvent(sessionId);
      upsertSnapshot.run(
        sessionId,
        encoded.json,
        position,
        encoded.metadata.stateRevision,
        encoded.metadata.stateChecksum,
        encoded.metadata.schemaVersion,
      );
    };

    const sessions: SessionStore<Event, State> = {
      appendEvents: (
        sessionId: string,
        events: readonly Event[],
        metadata?: readonly RuntimeEventMetadataV1[],
      ) => {
        if (this.#closed || events.length === 0) return;
        db.transaction(() => {
          upsertSession.run(sessionId);
          insertEvents(sessionId, events, metadata);
        })();
      },
      loadEventsStrict: loadEvents,
      saveSnapshot,
      loadSnapshot: <T = State>(sessionId: string) =>
        loadSnapshotRecord<T>(sessionId)?.state ?? null,
      loadSnapshotRecord,
      getLastEventPosition: (sessionId: string) => (this.#closed ? 0 : lastEvent(sessionId)),
      listSessions: (query = '', limit = 50): RuntimeSessionInfoV1[] => {
        if (this.#closed) return [];
        const needle = query.trim().toLowerCase();
        return listSessionsQuery
          .all(needle ? Math.max(limit, 200) : limit)
          .map((row) => {
            const first = loadEvents(row.thread_id)
              .map((entry) => ({ entry, summary: this.#codec.eventSummary?.(entry.event) ?? null }))
              .find((candidate) => candidate.summary?.isSessionNameCandidate);
            const firstText = first?.summary?.searchText ?? '';
            return { row, firstText };
          })
          .filter(
            ({ row, firstText }) =>
              !needle ||
              row.name.toLowerCase().includes(needle) ||
              firstText.toLowerCase().includes(needle),
          )
          .slice(0, limit)
          .map(({ row, firstText }) => ({
            threadId: row.thread_id,
            name: row.name || firstText || row.thread_id,
            updatedAt: row.updated_at,
            needsSmartName: !row.name,
          }));
      },
      setSessionName: (sessionId: string, name: string) => {
        if (!this.#closed) {
          upsertSession.run(sessionId);
          updateSessionName.run(name, sessionId);
        }
      },
      getSessionModelRoute: (sessionId): RuntimeSessionModelRouteV1 | null => {
        if (this.#closed) return null;
        const row = selectSessionModelRoute.get(sessionId);
        return row?.model_provider && row.model_name
          ? { provider: row.model_provider, name: row.model_name }
          : null;
      },
      setSessionModelRoute: (sessionId: string, route: RuntimeSessionModelRouteV1) => {
        if (!this.#closed && sessionId && route.provider.trim() && route.name.trim()) {
          upsertSession.run(sessionId);
          updateSessionModelRoute.run(route.provider.trim(), route.name.trim(), sessionId);
        }
      },
      deleteSession: (sessionId: string) => {
        if (!this.#closed)
          db.transaction(() => {
            deleteEvents.run(sessionId);
            deleteSnapshot.run(sessionId);
            deleteNamedSnapshots.run(sessionId);
            deleteFilePreimages.run(sessionId);
            deleteEffectLeases.run(sessionId);
            deleteRecoveryIdentity.run(recoveryIdentityMetaKey(sessionId));
            deleteSession.run(sessionId);
          })();
      },
    };
    this.sessions = Object.freeze(sessions);

    const commit = (input: RuntimeTransactionInputV1<Event, State>): void => {
      if (this.#closed) return;
      try {
        db.transaction(() => {
          if (
            input.requiredEffectLease &&
            !selectLease.get(
              input.sessionId,
              input.requiredEffectLease.effectId,
              input.requiredEffectLease.ownerId,
              input.requiredEffectLease.observedAtMs,
            )
          )
            throw new SqliteRuntimeEffectLeaseConflictError(
              input.sessionId,
              input.requiredEffectLease.effectId,
            );
          if (input.expectedRestoreBoundary) {
            const actual = selectSnapshot.get(input.sessionId);
            const expected = input.expectedRestoreBoundary.snapshot;
            const matches = expected
              ? actual != null &&
                actual.event_position === expected.eventPosition &&
                actual.state_revision === expected.stateRevision &&
                actual.state_checksum === expected.stateChecksum &&
                actual.schema_version === expected.schemaVersion
              : actual == null;
            const actualPosition = lastEvent(input.sessionId);
            if (!matches || actualPosition !== input.expectedRestoreBoundary.lastEventPosition)
              throw new SqliteRuntimeRevisionConflictError(
                input.sessionId,
                expected?.stateRevision ?? 0,
                actual?.state_revision ?? null,
                `Runtime restore boundary conflict for ${input.sessionId}: expected snapshot revision ${expected?.stateRevision ?? 'missing'} at event ${input.expectedRestoreBoundary.lastEventPosition}, found snapshot revision ${actual?.state_revision ?? 'missing'} at event ${actualPosition}.`,
              );
          }
          const firstRevision = input.metadata?.[0]?.revision;
          if (firstRevision != null) {
            const expectedRevision = firstRevision - 1;
            const actualRevision =
              selectSnapshotRevision.get(input.sessionId)?.state_revision ?? null;
            if (
              (actualRevision == null && expectedRevision !== 0) ||
              (actualRevision != null && actualRevision !== expectedRevision)
            )
              throw new SqliteRuntimeRevisionConflictError(
                input.sessionId,
                expectedRevision,
                actualRevision,
              );
          }
          upsertSession.run(input.sessionId);
          insertEvents(input.sessionId, input.events, input.metadata);
          const encoded = encodeSnapshot(input.snapshot, input.snapshotMetadata);
          const position = input.snapshotMetadata?.eventPosition ?? lastEvent(input.sessionId);
          upsertSnapshot.run(
            input.sessionId,
            encoded.json,
            position,
            encoded.metadata.stateRevision,
            encoded.metadata.stateChecksum,
            encoded.metadata.schemaVersion,
          );
        })();
      } catch (error) {
        if (
          error instanceof SqliteRuntimeUniqueReceiptConflictError ||
          error instanceof SqliteRuntimeRevisionConflictError ||
          error instanceof SqliteRuntimeEffectLeaseConflictError
        )
          throw error;
        throw new Error(
          `Failed to persist runtime transaction for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    };
    this.transactions = Object.freeze({
      commitDecision: commit,
      commitAttemptStart: commit,
      commitReceiptEvidence: commit,
      commitTerminalRecovery: commit,
    });
    this.effects = Object.freeze({
      tryAcquireEffectLease: (
        sessionId: string,
        effectId: string,
        ownerId: string,
        expiresAtMs: number,
      ): boolean => {
        if (this.#closed || expiresAtMs <= Date.now()) return false;
        const now = Date.now();
        return db.transaction(() => {
          deleteExpiredLease.run(sessionId, effectId, now);
          insertLease.run(sessionId, effectId, ownerId, expiresAtMs);
          return Boolean(selectLease.get(sessionId, effectId, ownerId, now));
        })();
      },
      renewEffectLease: (
        sessionId: string,
        effectId: string,
        ownerId: string,
        expiresAtMs: number,
      ): boolean => {
        if (this.#closed || expiresAtMs <= Date.now()) return false;
        const now = Date.now();
        renewLease.run(expiresAtMs, sessionId, effectId, ownerId, now);
        return Boolean(selectLease.get(sessionId, effectId, ownerId, now));
      },
      releaseEffectLease: (sessionId: string, effectId: string, ownerId: string): void => {
        if (!this.#closed) releaseLease.run(sessionId, effectId, ownerId);
      },
    });

    const loadNamed = <T = State>(sessionId: string, name: string): T | null => {
      if (this.#closed) return null;
      const row = selectNamedSnapshot.get(sessionId, name);
      if (!row || checksum(row.state_json) !== row.state_checksum) return null;
      try {
        return this.#codec.decodeState<T>(row.state_json);
      } catch {
        return null;
      }
    };
    this.checkpoints = Object.freeze({
      saveNamedSnapshot: (
        sessionId: string,
        name: string,
        state: State,
        eventPosition?: number,
      ) => {
        if (this.#closed) return;
        const encoded = encodeSnapshot(state);
        upsertNamedSnapshot.run(
          sessionId,
          name,
          eventPosition ?? lastEvent(sessionId),
          encoded.json,
          encoded.metadata.stateRevision,
          encoded.metadata.stateChecksum,
          encoded.metadata.schemaVersion,
        );
      },
      loadNamedSnapshot: loadNamed,
      listNamedSnapshots: (sessionId: string) => {
        if (this.#closed) return [];
        const events = loadEvents(sessionId);
        return listNamedSnapshotsQuery.all(sessionId).map((row) => {
          const target = events.find(
            (entry) =>
              entry.id > row.event_position &&
              this.#codec.eventSummary?.(entry.event)?.isSessionNameCandidate,
          );
          const summary = target ? this.#codec.eventSummary?.(target.event) : null;
          return {
            snapshotId: row.name,
            eventPosition: row.event_position,
            createdAt: row.created_at,
            ...(summary?.searchText != null ? { targetMessage: summary.searchText } : {}),
            ...(target ? { targetMessageCreatedAt: target.created_at } : {}),
            affectedFileCount: row.affected_file_count,
          };
        });
      },
      getNamedSnapshotEntry: (sessionId: string, snapshotId: string) => {
        if (this.#closed) return null;
        const row = selectNamedSnapshotEntry.get(sessionId, snapshotId);
        return row
          ? { snapshotId: row.name, eventPosition: row.event_position, createdAt: row.created_at }
          : null;
      },
      restoreNamedSnapshot: (sessionId: string, snapshotId: string): boolean => {
        if (this.#closed) return false;
        const row = selectNamedSnapshot.get(sessionId, snapshotId);
        if (!row || checksum(row.state_json) !== row.state_checksum) return false;
        let state: State;
        try {
          state = this.#codec.decodeState<State>(row.state_json);
          const eventRevision =
            selectEventRevisionAtOrBefore.get(sessionId, row.event_position)?.revision ?? 0;
          restoreValidation(state, sessionId, row, eventRevision);
          if (
            row.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
            row.event_position > lastEvent(sessionId) ||
            row.state_revision !== eventRevision
          )
            return false;
        } catch {
          return false;
        }
        db.transaction(() => {
          deleteEventsAfter.run(sessionId, row.event_position);
          deleteNamedSnapshotsAfter.run(sessionId, row.event_position);
          deleteFilePreimagesAfter.run(sessionId, row.event_position);
          const encoded = encodeSnapshot(state);
          upsertSnapshot.run(
            sessionId,
            encoded.json,
            row.event_position,
            row.state_revision,
            encoded.metadata.stateChecksum,
            encoded.metadata.schemaVersion,
          );
          upsertSession.run(sessionId);
        })();
        return true;
      },
      forkSession: (
        sourceSessionId: string,
        snapshotId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ): boolean => {
        if (
          this.#closed ||
          !sourceSessionId ||
          !targetSessionId ||
          sourceSessionId === targetSessionId
        )
          return false;
        if (!isCanonicalRecoveryIdentity(targetRecoveryIdentityKey)) return false;
        const current = snapshotId === '__runtime_current__';
        const rolling = current ? selectSnapshot.get(sourceSessionId) : null;
        const named = current ? null : selectNamedSnapshot.get(sourceSessionId, snapshotId);
        const sourceRow = rolling ?? named;
        if (!sourceRow || checksum(sourceRow.state_json) !== sourceRow.state_checksum) return false;
        let state: State;
        try {
          state = this.#codec.decodeState<State>(sourceRow.state_json);
          const eventRevision =
            selectEventRevisionAtOrBefore.get(sourceSessionId, sourceRow.event_position)
              ?.revision ?? 0;
          restoreValidation(state, sourceSessionId, sourceRow, eventRevision);
          if (this.#codec.canFork && !this.#codec.canFork(state)) return false;
          if (
            sourceRow.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
            sourceRow.state_revision !== eventRevision
          )
            return false;
        } catch {
          return false;
        }
        let sourceEvents: StoredRuntimeEventV1<Event>[];
        try {
          sourceEvents = loadEvents(sourceSessionId).filter(
            (entry) =>
              entry.id <= sourceRow.event_position &&
              (!current || !this.#codec.isCurrentPendingInteractionRequest?.(state, entry.event)),
          );
        } catch {
          return false;
        }
        const sourceNamed = selectNamedSnapshotsForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceFiles = selectFilePreimagesForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceRoute = this.sessions.getSessionModelRoute(sourceSessionId);
        const snapshotRecoveryIdentity = this.#codec.recoveryIdentity?.(state);
        if (
          snapshotRecoveryIdentity !== undefined &&
          !isCanonicalRecoveryIdentity(snapshotRecoveryIdentity)
        )
          return false;
        const persistedRecoveryIdentity = selectRecoveryIdentity.get(
          recoveryIdentityMetaKey(sourceSessionId),
        )?.value;
        if (
          persistedRecoveryIdentity !== undefined &&
          !isCanonicalRecoveryIdentity(persistedRecoveryIdentity)
        )
          return false;
        if (
          snapshotRecoveryIdentity !== undefined &&
          persistedRecoveryIdentity !== undefined &&
          snapshotRecoveryIdentity !== persistedRecoveryIdentity
        )
          return false;
        const sourceRecoveryIdentity = persistedRecoveryIdentity ?? snapshotRecoveryIdentity;
        if (
          (this.#codec.recoveryIdentity && sourceRecoveryIdentity === undefined) ||
          sourceRecoveryIdentity === targetRecoveryIdentityKey
        )
          return false;
        const forkState = this.#codec.rebindForkState(
          state,
          targetSessionId,
          targetRecoveryIdentityKey,
        );
        try {
          const forkMetadata = this.#codec.snapshotMetadata(forkState);
          this.#codec.validateSnapshot?.({
            state: forkState,
            sessionId: targetSessionId,
            eventPosition: 0,
            stateRevision: forkMetadata.stateRevision,
            schemaVersion: forkMetadata.schemaVersion,
            eventRevision: forkMetadata.stateRevision,
          });
        } catch {
          return false;
        }
        db.transaction(() => {
          deleteEvents.run(targetSessionId);
          deleteSnapshot.run(targetSessionId);
          deleteNamedSnapshots.run(targetSessionId);
          deleteFilePreimages.run(targetSessionId);
          deleteRecoveryIdentity.run(recoveryIdentityMetaKey(targetSessionId));
          deleteSession.run(targetSessionId);
          upsertSession.run(targetSessionId);
          if (sourceRecoveryIdentity !== undefined) {
            if (persistedRecoveryIdentity === undefined) {
              insertRecoveryIdentity.run(
                recoveryIdentityMetaKey(sourceSessionId),
                sourceRecoveryIdentity,
              );
            }
            insertRecoveryIdentity.run(
              recoveryIdentityMetaKey(targetSessionId),
              targetRecoveryIdentityKey,
            );
          }
          if (sourceRoute)
            updateSessionModelRoute.run(sourceRoute.provider, sourceRoute.name, targetSessionId);
          const positions = new Map<number, number>();
          for (const entry of sourceEvents) {
            const inserted = insertForkEvent.run(
              targetSessionId,
              this.#codec.encodeEvent(entry.event),
              entry.event_id ?? null,
              entry.revision ?? 0,
              entry.causation_id ?? null,
              entry.occurred_at ?? null,
              entry.created_at,
            );
            positions.set(entry.id, Number(inserted.lastInsertRowid));
          }
          const remap = (position: number): number => {
            let target = 0;
            for (const entry of sourceEvents) {
              if (entry.id > position) break;
              target = positions.get(entry.id) ?? target;
            }
            return target;
          };
          for (const file of sourceFiles)
            insertForkFilePreimage.run(
              targetSessionId,
              file.path,
              remap(file.event_position),
              file.content,
              file.existed,
              file.post_hash,
              file.post_existed,
              file.created_at,
            );
          const encodedFork = encodeSnapshot(forkState);
          upsertSnapshot.run(
            targetSessionId,
            encodedFork.json,
            remap(sourceRow.event_position),
            encodedFork.metadata.stateRevision,
            encodedFork.metadata.stateChecksum,
            encodedFork.metadata.schemaVersion,
          );
          for (const snapshot of sourceNamed) {
            try {
              if (checksum(snapshot.state_json) !== snapshot.state_checksum) continue;
              const namedState = this.#codec.decodeState<State>(snapshot.state_json);
              if (this.#codec.canFork && !this.#codec.canFork(namedState)) continue;
              const rebound = this.#codec.rebindForkState(
                namedState,
                targetSessionId,
                targetRecoveryIdentityKey,
              );
              this.#codec.validateSnapshot?.({
                state: rebound,
                sessionId: targetSessionId,
                eventPosition: remap(snapshot.event_position),
                stateRevision: snapshot.state_revision,
                schemaVersion: snapshot.schema_version,
                eventRevision: snapshot.state_revision,
              });
              const encodedNamed = encodeSnapshot(rebound, {
                eventPosition: remap(snapshot.event_position),
                stateRevision: snapshot.state_revision,
                stateChecksum: '',
                schemaVersion: snapshot.schema_version,
              });
              insertForkNamedSnapshot.run(
                targetSessionId,
                snapshot.name,
                remap(snapshot.event_position),
                encodedNamed.json,
                snapshot.state_revision,
                encodedNamed.metadata.stateChecksum,
                snapshot.schema_version,
                snapshot.created_at,
              );
            } catch {
              /* corrupt or rejected recovery points are omitted */
            }
          }
        })();
        return true;
      },
      forkCurrentSession: (
        sourceSessionId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ) =>
        this.checkpoints.forkSession(
          sourceSessionId,
          '__runtime_current__',
          targetSessionId,
          targetRecoveryIdentityKey,
        ),
      recordFilePreimage: (
        sessionId: string,
        path: string,
        content: string | null,
        existed: boolean,
      ) => {
        if (this.#closed || !sessionId || !path) return;
        try {
          const boundary = selectLatestSnapshotPosition.get(sessionId)?.event_position ?? -1;
          if (selectFilePreimageInWindow.get(sessionId, path, boundary)) return;
          insertFilePreimage.run(sessionId, path, lastEvent(sessionId), content, existed ? 1 : 0);
        } catch {
          /* best effort by contract */
        }
      },
      recordFilePostimage: (
        sessionId: string,
        path: string,
        contentHash: string | null,
        existed: boolean,
      ) => {
        if (this.#closed || !sessionId || !path) return;
        try {
          const boundary = selectLatestSnapshotPosition.get(sessionId)?.event_position ?? -1;
          updateFilePostimageInWindow.run(contentHash, existed ? 1 : 0, sessionId, path, boundary);
        } catch {
          /* best effort by contract */
        }
      },
      fileRestorePlan: (
        sessionId: string,
        eventPosition: number,
      ): RuntimeFileRestoreMaterialV1[] =>
        this.#closed
          ? []
          : selectFileRestorePlan.all(sessionId, eventPosition).map((row) => ({
              path: row.path,
              content: row.content,
              existed: row.existed === 1,
              postHash: row.post_hash,
              postExisted: row.post_existed == null ? null : row.post_existed === 1,
            })),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#db) {
      try {
        this.#db.fileControl('main', constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      } catch {
        /* best effort */
      }
      try {
        this.#db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort */
      }
      this.#db.close();
    }
  }
}

export function createSqliteRuntimeStorage<Event = unknown, State = unknown>(
  input: SqliteRuntimeStorageInputV1<Event, State>,
): RuntimeStorage<Event, State> {
  return new SqliteRuntimeStorageAdapter(input);
}

export function createSqliteRuntimeStorageBoundaryV1(): RuntimeStorageBoundaryV1 {
  return Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
    compatibilityEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
  });
}
