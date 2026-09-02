import { Database, constants as sqliteConstants } from 'bun:sqlite';
import {
  assertCanonicalKiteDatabasePath,
  ensurePrivateDatabaseFile,
} from './kite-home-runtime-file';
import { initializeKiteSessionStoreIfNeeded, KiteHomeStoreSchemaError } from './kite-home-store';
import { assertNoFollowDatabasePath } from './preflight';

export type KiteSessionStoreOpenErrorCode = 'store_upgrade_required';

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
      database.run('PRAGMA journal_mode = WAL');
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

function isStoreFormatFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED';
}
