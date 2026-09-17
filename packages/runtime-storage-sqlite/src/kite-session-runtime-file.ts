import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import {
  assertCanonicalKiteDatabasePath,
  ensurePrivateDatabaseFile,
} from './kite-home-runtime-file';
import {
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  initializeKiteSessionStoreIfNeeded,
  KITE_SESSION_STORE_FORMAT_EPOCH,
  KITE_SESSION_STORE_SCHEMA_VERSION,
  KiteHomeStoreSchemaError,
} from './kite-home-store';
import { assertNoFollowDatabasePath, SqliteRuntimeStorageOpenError } from './preflight';

export type KiteSessionStoreOpenErrorCode =
  | 'store_incompatible'
  | 'store_migration_required'
  | 'store_insufficient_space'
  | 'store_access_denied'
  | 'store_corrupt'
  | 'store_busy'
  | 'store_preparation_cancelled'
  | 'store_history_reconciliation_required';

export type KiteSessionStorePreparationStage =
  | 'inspecting'
  | 'acquiring_maintenance'
  | 'preparing'
  | 'publishing'
  | 'waiting_for_store'
  | 'ready';

export interface KiteSessionStoreMetadata {
  schemaVersion: number | null;
  formatEpoch: string | null;
}

export type KiteSessionStoreCompatibility =
  | { status: 'compatible'; access: 'read_write' }
  | {
      status: 'incompatible' | 'migration_required';
      reason: 'unknown_format' | 'store_too_new' | 'unsupported_schema';
      actualSchema: number | null;
      expectedSchema: number;
      actualEpoch: string | null;
      expectedEpoch: string;
    };

/** Metadata only: callers must also validate the supported schema's structure. */
export function readKiteSessionStoreMetadata(database: Database): KiteSessionStoreMetadata {
  const rows = database
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM kite_meta WHERE key IN ('schema_version', 'format_epoch')",
    )
    .all();
  const metadata = new Map(rows.map((row) => [row.key, row.value]));
  const rawSchema = metadata.get('schema_version');
  const parsed = rawSchema && /^(0|[1-9][0-9]*)$/.test(rawSchema) ? Number(rawSchema) : null;
  return {
    schemaVersion: parsed !== null && Number.isSafeInteger(parsed) ? parsed : null,
    formatEpoch: metadata.get('format_epoch') ?? null,
  };
}

/** No version ranges are admitted without a proven reader AND writer implementation. */
export function checkKiteSessionStoreCompatibility(
  metadata: KiteSessionStoreMetadata,
): KiteSessionStoreCompatibility {
  const detail = {
    actualSchema: metadata.schemaVersion,
    expectedSchema: KITE_SESSION_STORE_SCHEMA_VERSION,
    actualEpoch: metadata.formatEpoch,
    expectedEpoch: KITE_SESSION_STORE_FORMAT_EPOCH,
  };
  if (metadata.formatEpoch !== KITE_SESSION_STORE_FORMAT_EPOCH) {
    return { status: 'incompatible', reason: 'unknown_format', ...detail };
  }
  if (metadata.schemaVersion === KITE_SESSION_STORE_SCHEMA_VERSION) {
    return { status: 'compatible', access: 'read_write' };
  }
  if (
    metadata.schemaVersion !== null &&
    metadata.schemaVersion < KITE_SESSION_STORE_SCHEMA_VERSION
  ) {
    return { status: 'incompatible', reason: 'unsupported_schema', ...detail };
  }
  return {
    status: 'incompatible',
    reason: metadata.schemaVersion === null ? 'unsupported_schema' : 'store_too_new',
    ...detail,
  };
}

export class KiteSessionStoreOpenError extends Error {
  readonly code: KiteSessionStoreOpenErrorCode;
  readonly compatibility?: Exclude<KiteSessionStoreCompatibility, { status: 'compatible' }>;
  readonly stage?: KiteSessionStorePreparationStage;

  constructor(
    code: KiteSessionStoreOpenErrorCode,
    message: string,
    options?: ErrorOptions & {
      compatibility?: Exclude<KiteSessionStoreCompatibility, { status: 'compatible' }>;
      stage?: KiteSessionStorePreparationStage;
    },
  ) {
    super(message, options);
    this.name = 'KiteSessionStoreOpenError';
    this.code = code;
    this.compatibility = options?.compatibility;
    this.stage = options?.stage;
  }
}

/** Opens only the accepted App Server Store file; it never probes or imports `kite.sqlite`. */
export function openKiteSessionStoreDatabase(databasePath: string): Database {
  const path = canonicalStorePath(databasePath);
  let database: Database | undefined;
  try {
    assertNoFollowDatabasePath(path);
    inspectKiteSessionStoreDatabase(path, false);
    try {
      ensurePrivateDatabaseFile(path);
    } catch (error) {
      if (['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(errorCode(error)))
        throw classifyStoreOpenFailure(error);
      throw new KiteSessionStoreOpenError(
        'store_access_denied',
        'Kite Session Store file is not privately accessible.',
        { cause: error },
      );
    }
    database = new Database(
      path,
      sqliteConstants.SQLITE_OPEN_READWRITE |
        sqliteConstants.SQLITE_OPEN_CREATE |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    database.run('PRAGMA busy_timeout = 5000');
    database.run('PRAGMA foreign_keys = ON');
    initializeKiteSessionStoreIfNeeded(database);
    configureJournalMode(database);
    database.run('PRAGMA synchronous = FULL');
    return database;
  } catch (error) {
    database?.close(false);
    throw classifyStoreOpenFailure(error, error instanceof KiteHomeStoreSchemaError);
  }
}

function configureJournalMode(database: Database): void {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      database.run('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isStoreBusy(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(10);
    }
  }
}

function isStoreBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = String(error.code);
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

/** Full read-only integrity preflight used before a release stops an old owner. */
export function validateKiteSessionStoreDatabase(databasePath: string): void {
  inspectKiteSessionStoreDatabase(databasePath, true);
}

export function inspectKiteSessionStoreDatabase(
  databasePath: string,
  fullIntegrity: boolean,
): void {
  const path = canonicalStorePath(databasePath);
  let database: Database | undefined;
  try {
    assertNoFollowDatabasePath(path);
    if (!existsSync(path)) return;
    assertPrivateReadableExistingStoreFile(path);
    database = new Database(
      path,
      sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    database.run('PRAGMA busy_timeout = 5000');
    database.run('PRAGMA query_only = ON');
    const tables = database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'",
      )
      .get();
    if (tables?.count === 0) return;
    const compatibility = checkKiteSessionStoreCompatibility(
      readKiteSessionStoreMetadata(database),
    );
    if (compatibility.status !== 'compatible') {
      throw new KiteSessionStoreOpenError(
        compatibility.status === 'migration_required'
          ? 'store_migration_required'
          : 'store_incompatible',
        'Kite Session Store cannot be safely opened by this Runtime; no data migration was performed.',
        { compatibility },
      );
    }
    try {
      assertKiteSessionStoreSchema(database);
      if (fullIntegrity) assertKiteStoreIntegrity(database);
    } catch (error) {
      throw classifyStoreOpenFailure(error, true);
    }
  } catch (error) {
    throw classifyStoreOpenFailure(error);
  } finally {
    database?.close(false);
  }
}

function classifyStoreOpenFailure(error: unknown, knownCurrent = false): KiteSessionStoreOpenError {
  if (error instanceof KiteSessionStoreOpenError) return error;
  const code = errorCode(error);
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL')
    return new KiteSessionStoreOpenError(
      'store_insufficient_space',
      'Session Store has insufficient writable space.',
      { cause: error },
    );
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return new KiteSessionStoreOpenError(
      'store_busy',
      'Kite Session Store is busy; retry after the current operation completes.',
      { cause: error },
    );
  if (
    error instanceof SqliteRuntimeStorageOpenError ||
    [
      'EACCES',
      'EPERM',
      'EROFS',
      'SQLITE_CANTOPEN',
      'SQLITE_PERM',
      'SQLITE_READONLY',
      'SQLITE_IOERR',
    ].some((prefix) => code === prefix || code.startsWith(`${prefix}_`))
  )
    return new KiteSessionStoreOpenError(
      'store_access_denied',
      'Kite Session Store cannot be accessed with the required permissions.',
      { cause: error },
    );
  if (
    knownCurrent ||
    error instanceof KiteHomeStoreSchemaError ||
    code === 'SQLITE_NOTADB' ||
    code.startsWith('SQLITE_CORRUPT')
  )
    return new KiteSessionStoreOpenError(
      'store_corrupt',
      'Kite Session Store contents failed integrity or current-schema validation.',
      { cause: error },
    );
  return new KiteSessionStoreOpenError(
    'store_incompatible',
    'Kite Session Store format is incompatible, unsupported, or cannot be identified.',
    { cause: error },
  );
}

function assertPrivateReadableExistingStoreFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new KiteSessionStoreOpenError(
      'store_access_denied',
      'Kite Session Store file is not a private regular file.',
    );
  }
}

function canonicalStorePath(databasePath: string): string {
  try {
    return assertCanonicalKiteDatabasePath(databasePath, 'kite-session.sqlite');
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return failedStorePath(error);
  }
}

function failedStorePath(error: unknown): never {
  throw new KiteSessionStoreOpenError(
    'store_access_denied',
    'Kite Session Store parent is unavailable or unsafe.',
    { cause: error },
  );
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}
