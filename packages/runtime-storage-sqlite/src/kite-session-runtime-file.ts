import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { existsSync } from 'node:fs';
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
import { assertNoFollowDatabasePath } from './preflight';

export type KiteSessionStoreOpenErrorCode =
  | 'store_incompatible'
  | 'store_migration_required'
  | 'store_busy';

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
    return { status: 'migration_required', reason: 'unsupported_schema', ...detail };
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

  constructor(
    code: KiteSessionStoreOpenErrorCode,
    message: string,
    options?: ErrorOptions & {
      compatibility?: Exclude<KiteSessionStoreCompatibility, { status: 'compatible' }>;
    },
  ) {
    super(message, options);
    this.name = 'KiteSessionStoreOpenError';
    this.code = code;
    this.compatibility = options?.compatibility;
  }
}

/** Opens only the accepted App Server Store file; it never probes or imports `kite.sqlite`. */
export function openKiteSessionStoreDatabase(databasePath: string): Database {
  const path = assertCanonicalKiteDatabasePath(databasePath, 'kite-session.sqlite');
  assertNoFollowDatabasePath(path);
  inspectKiteSessionStoreDatabase(path, false);
  ensurePrivateDatabaseFile(path);
  const database = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READWRITE |
      sqliteConstants.SQLITE_OPEN_CREATE |
      sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    try {
      database.run('PRAGMA busy_timeout = 5000');
      database.run('PRAGMA foreign_keys = ON');
      initializeKiteSessionStoreIfNeeded(database);
      configureJournalMode(database);
      database.run('PRAGMA synchronous = FULL');
    } catch (error) {
      if (error instanceof KiteHomeStoreSchemaError || isStoreFormatFailure(error)) {
        throw new KiteSessionStoreOpenError(
          'store_incompatible',
          'Kite Session Store format is incompatible or corrupt.',
          { cause: error },
        );
      }
      throw error;
    }
    return database;
  } catch (error) {
    database.close(false);
    throw error;
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

function isStoreFormatFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED';
}

/** Full read-only integrity preflight used before a release stops an old owner. */
export function validateKiteSessionStoreDatabase(databasePath: string): void {
  inspectKiteSessionStoreDatabase(databasePath, true);
}

function inspectKiteSessionStoreDatabase(databasePath: string, fullIntegrity: boolean): void {
  const path = assertCanonicalKiteDatabasePath(databasePath, 'kite-session.sqlite');
  assertNoFollowDatabasePath(path);
  if (!existsSync(path)) return;
  let database: Database | undefined;
  try {
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
    assertKiteSessionStoreSchema(database);
    if (fullIntegrity) assertKiteStoreIntegrity(database);
  } catch (error) {
    if (error instanceof KiteSessionStoreOpenError) throw error;
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      throw new KiteSessionStoreOpenError(
        'store_busy',
        'Kite Session Store is busy; retry after the current operation completes.',
        { cause: error },
      );
    }
    throw new KiteSessionStoreOpenError(
      'store_incompatible',
      'Kite Session Store format is incompatible or unavailable; no data migration was performed.',
      { cause: error },
    );
  } finally {
    database?.close(false);
  }
}
