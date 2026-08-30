import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { chmodSync, closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { ArtifactPort } from '@kite-ai/runtime-host/storage';
import {
  createKiteHomeRuntimeStorageForConnection,
  type KiteHomeRuntimeStorageOwner,
} from './kite-home-runtime-storage';
import { initializeKiteHomeStoreSchema } from './kite-home-store';
import { assertNoFollowDatabasePath, type SqliteRuntimeSnapshotCodec } from './preflight';

/** Open the final `<Kite Home>/kite.sqlite` writer; no fallback basename or second DB is accepted. */
export function openKiteHomeRuntimeStorage<Event, State>(input: {
  readonly databasePath: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly artifacts?: ArtifactPort;
  readonly now?: () => number;
}): KiteHomeRuntimeStorageOwner<Event, State> {
  const path = assertCanonicalKiteDatabasePath(input.databasePath);
  assertNoFollowDatabasePath(path);
  ensurePrivateDatabaseFile(path);
  const database = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READWRITE |
      sqliteConstants.SQLITE_OPEN_CREATE |
      sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    database.run('PRAGMA busy_timeout = 5000');
    database.run('PRAGMA foreign_keys = ON');
    const tableCount =
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get()?.count ?? 0;
    if (tableCount === 0) initializeKiteHomeStoreSchema(database);
    database.run('PRAGMA journal_mode = WAL');
    database.run('PRAGMA synchronous = FULL');
    return createKiteHomeRuntimeStorageForConnection({
      database,
      codec: input.codec,
      stateSchemaVersion: input.stateSchemaVersion,
      formatEpoch: input.formatEpoch,
      ownsDatabase: true,
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    database.close(false);
    throw error;
  }
}

function assertCanonicalKiteDatabasePath(path: string): string {
  if (!isAbsolute(path) || basename(path) !== 'kite.sqlite' || /\p{Cc}/u.test(path)) {
    throw new TypeError('Kite Home Store path must be an absolute kite.sqlite path.');
  }
  const resolved = resolve(path);
  const parent = dirname(resolved);
  const parentStat = lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    realpathSync.native(parent) !== parent
  ) {
    throw new Error('Kite Home Store parent must be a canonical real directory.');
  }
  if (typeof process.getuid === 'function' && parentStat.uid !== process.getuid()) {
    throw new Error('Kite Home Store parent owner is invalid.');
  }
  return resolved;
}

function ensurePrivateDatabaseFile(path: string): void {
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    closeSync(descriptor);
  } catch (error) {
    if (!errorCodeIs(error, 'EEXIST')) throw error;
  }
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    realpathSync.native(path) !== path
  ) {
    throw new Error('Kite Home Store must be one exact regular file.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Kite Home Store owner is invalid.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Kite Home Store permissions are not owner-only.');
  }
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function errorCodeIs(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
