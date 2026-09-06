import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import {
  assertCanonicalKiteDatabasePath,
  ensurePrivateDatabaseFile,
} from './kite-home-runtime-file';
import {
  assertKiteSessionStoreSchema,
  initializeKiteSessionStoreIfNeeded,
  KiteHomeStoreSchemaError,
} from './kite-home-store';
import { assertNoFollowDatabasePath } from './preflight';

export type KiteSessionStoreOpenErrorCode = 'store_upgrade_required' | 'store_busy';

export class KiteSessionStoreOpenError extends Error {
  readonly code: KiteSessionStoreOpenErrorCode;

  constructor(code: KiteSessionStoreOpenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KiteSessionStoreOpenError';
    this.code = code;
  }
}

/** Opens only the accepted App Server Store file; it never probes or imports `kite.sqlite`. */
export function openKiteSessionStoreDatabase(databasePath: string): Database {
  const path = assertCanonicalKiteDatabasePath(databasePath, 'kite-session.sqlite');
  assertNoFollowDatabasePath(path);
  validateKiteSessionStoreDatabase(path);
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
          'store_upgrade_required',
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

/** Read-only compatibility preflight used before stopping an old owner or opening mutable storage. */
export function validateKiteSessionStoreDatabase(databasePath: string): void {
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
    assertKiteSessionStoreSchema(database);
  } catch (error) {
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
      'store_upgrade_required',
      'Kite Session Store format is incompatible or unavailable; no data migration was performed.',
      { cause: error },
    );
  } finally {
    database?.close(false);
  }
}
