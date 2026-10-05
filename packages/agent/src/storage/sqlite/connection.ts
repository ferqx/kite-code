import { constants, Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSymlinkPath, type ProfileAccess } from '../../platform/profile';
import { defaultWindowsPathSecurity, privateDirectory } from '../../platform/windows-path-security';
import { initializeDefaultSqliteEngine, type SqliteEngineSelection } from '../../sqlite-engine';
export const FORMAT_MAJOR = 1;
export class StoreOpenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function validateFiles(access: ProfileAccess): void {
  // The caller already holds shared profile use before any data-unit inspection.
  assertNoSymlinkPath(access.profilePath);
  for (const suffix of ['', '-wal', '-shm']) {
    assertNoSymlinkPath(access.databasePath + suffix);
    if (existsSync(access.databasePath + suffix)) privateRegular(access.databasePath + suffix);
  }
  if (existsSync(access.profilePath)) {
    defaultWindowsPathSecurity()?.verifyDirectory(access.profilePath);
    const stat = lstatSync(access.profilePath);
    if (
      !stat.isDirectory() ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    )
      throw new StoreOpenError('store_access_denied', 'Profile must be a private owned directory.');
  }
}
export function openDatabase(
  access: ProfileAccess,
  readOnly: boolean,
  engine?: SqliteEngineSelection | null,
): Database {
  if (engine === undefined) initializeDefaultSqliteEngine();
  validateFiles(access);
  if (readOnly && !existsSync(access.databasePath))
    throw new StoreOpenError('store_not_found', 'Profile has no Store.');
  if (existsSync(access.databasePath)) preflight(access.databasePath);
  if (!readOnly) {
    privateDirectory(access.profilePath);
    if (!existsSync(access.databasePath)) {
      try {
        if (process.platform === 'win32')
          defaultWindowsPathSecurity()!.createFile(access.databasePath);
        else writeFileSync(access.databasePath, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    }
  }
  const database = new Database(
    access.databasePath,
    (readOnly ? constants.SQLITE_OPEN_READONLY : constants.SQLITE_OPEN_READWRITE) |
      constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    database.run('PRAGMA busy_timeout=100');
    database.run('PRAGMA foreign_keys=ON');
    if (readOnly) database.run('PRAGMA query_only=ON');
    else {
      database.run('PRAGMA synchronous=FULL');
      initialize(database);
      database.run('PRAGMA journal_mode=WAL');
      database.run('PRAGMA synchronous=FULL');
      chmodSync(access.databasePath, 0o600);
      const profileFile = join(access.profilePath, 'profile.json');
      if (!existsSync(profileFile)) {
        try {
          writeFileSync(profileFile, JSON.stringify({ formatMajor: FORMAT_MAJOR }), {
            flag: 'wx',
            mode: 0o600,
          });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
    }
    validateFiles(access);
    if (existsSync(join(access.profilePath, 'profile.json')))
      privateRegular(join(access.profilePath, 'profile.json'));
    return database;
  } catch (error) {
    database.close(true);
    throw error;
  }
}
function privateRegular(path: string): void {
  defaultWindowsPathSecurity()?.verifyFile(path);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw new StoreOpenError('store_access_denied', 'Store must be a private owned regular file.');
}
export type StorePreflight =
  | { status: 'absent' }
  | { status: 'uninitialized' }
  | { status: 'compatible'; storeId: string; formatMajor: 1 };

export function preflightDatabase(access: ProfileAccess, baseline: URL): StorePreflight {
  initializeDefaultSqliteEngine();
  validateFiles(access);
  const journal = `${access.databasePath}-journal`;
  assertNoSymlinkPath(journal);
  if (existsSync(journal)) {
    privateRegular(journal);
    throw new StoreOpenError('store_journal_present', 'Store rollback journal requires recovery.');
  }
  if (!existsSync(access.databasePath)) return { status: 'absent' };
  return preflight(access.databasePath, baseline);
}

function preflight(
  path: string,
  baseline = new URL('../migrations/0001-baseline.sql', import.meta.url),
): StorePreflight {
  privateRegular(path);
  const database = new Database(
    path,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    database.run('PRAGMA query_only=ON');
    database.run('PRAGMA busy_timeout=100');
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'")
      .all();
    if (tables.length === 0) {
      const objects = database
        .query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
        .all();
      if (objects.length !== 0)
        throw new StoreOpenError('store_incompatible', 'Unknown Store format.');
      return { status: 'uninitialized' };
    }
    if (!tables.some((table) => table.name === 'storage_meta'))
      throw new StoreOpenError('store_incompatible', 'Unknown Store format.');
    const meta = database
      .query<{ format_major: number }, []>(
        'SELECT format_major FROM storage_meta WHERE singleton=1',
      )
      .get();
    if (Number(meta?.format_major) !== FORMAT_MAJOR)
      throw new StoreOpenError('store_incompatible', 'Unsupported Store format.');
    validateBaseline(database, baseline);
    const identity = database
      .query<{ store_id: string }, []>('SELECT store_id FROM storage_meta WHERE singleton=1')
      .get();
    if (typeof identity?.store_id !== 'string' || identity.store_id.length === 0)
      throw new StoreOpenError('store_incompatible', 'Store identity is invalid.');
    return { status: 'compatible', storeId: identity.store_id, formatMajor: FORMAT_MAJOR };
  } finally {
    closeReadonly(database);
  }
}
function closeReadonly(database: Database): void {
  try {
    database.close(true);
  } catch {
    throw new StoreOpenError(
      'store_preflight_cleanup_failed',
      'Readonly Store close was not confirmed.',
    );
  }
}

function initialize(database: Database): void {
  database.run('BEGIN IMMEDIATE');
  try {
    const exists = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='storage_meta'",
      )
      .get();
    if (!exists) {
      const sql = readFileSync(new URL('../migrations/0001-baseline.sql', import.meta.url), 'utf8');
      database.exec(sql);
      database.run('INSERT INTO storage_meta(singleton,store_id,format_major) VALUES(1,?,?)', [
        randomUUID(),
        FORMAT_MAJOR,
      ]);
      database.run('INSERT INTO schema_migration VALUES(?,?,?)', [
        '0001-baseline',
        createHash('sha256').update(sql).digest('hex'),
        new Date().toISOString(),
      ]);
    } else {
      const meta = database
        .query<{ format_major: number }, []>(
          'SELECT format_major FROM storage_meta WHERE singleton=1',
        )
        .get();
      if (Number(meta?.format_major) !== FORMAT_MAJOR)
        throw new StoreOpenError('store_incompatible', 'Unsupported Store format.');
    }
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {}
    throw error;
  }
}

function validateBaseline(database: Database, baseline: URL): void {
  const sql = readFileSync(baseline, 'utf8');
  const expected = new Database(':memory:');
  try {
    expected.exec(sql);
    const query =
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    const reference = JSON.stringify(expected.query(query).all());
    const actual = JSON.stringify(database.query(query).all());
    if (actual !== reference)
      throw new StoreOpenError(
        'store_incompatible',
        'Store schema does not match its supported baseline.',
      );
    const migration = database
      .query<{ checksum: string }, []>(
        "SELECT checksum FROM schema_migration WHERE id='0001-baseline'",
      )
      .get();
    if (migration?.checksum !== createHash('sha256').update(sql).digest('hex'))
      throw new StoreOpenError('store_incompatible', 'Store migration identity is invalid.');
  } finally {
    expected.close(true);
  }
}
