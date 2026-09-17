import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCanonicalKiteDatabasePath } from './kite-home-runtime-file';
import {
  assertKiteHomeStoreSchema,
  assertKiteSessionStoreSchema,
  assertKiteStoreIntegrity,
  KITE_HOME_STORE_TABLE_COLUMNS,
  KITE_SESSION_STORE_TABLE_COLUMNS,
} from './kite-home-store';
import {
  acquireKiteSessionStoreMaintenance,
  assertKiteSessionExclusiveMaintenance,
  type KiteSessionMaintenanceLock,
  type KiteSessionWindowsPathSecurity,
} from './kite-session-maintenance';
import { readKiteSessionStoreMetadata } from './kite-session-runtime-file';
import {
  assertKiteSessionStore11Schema,
  KITE_SESSION_STORE11_TABLE_COLUMNS,
} from './kite-session-store11-conversion';
import { assertNoFollowDatabasePath } from './preflight';
import {
  captureSqliteTableContentDigests,
  type SqliteTableContentDigests,
} from './sqlite-table-content';

interface WindowsRecoveryPathSecurity extends KiteSessionWindowsPathSecurity {
  secureDirectory(path: string): void;
}

export interface KiteSessionRecoveryBackupOptions {
  /** The caller retains ownership until its complete maintenance operation ends. */
  readonly maintenance?: KiteSessionMaintenanceLock;
  readonly windowsPathSecurity?: WindowsRecoveryPathSecurity;
}

export interface KiteSessionCapture {
  readonly schemaVersion: number;
  readonly formatEpoch: string;
  readonly userVersion: number;
  readonly schemaDigest: string;
  readonly tables: SqliteTableContentDigests;
}

export interface KiteSessionRecoveryManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly source: {
    readonly pathDigest: string;
    readonly device: number;
    readonly inode: number;
    readonly mainSha256: string;
    readonly walSha256: string | null;
  };
  readonly capture: KiteSessionCapture;
  readonly backupSha256: string;
}

export interface KiteSessionRecoveryBackup {
  readonly directory: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly manifest: KiteSessionRecoveryManifest;
}

/**
 * Copies an exact supported Store (9, 10 or 11) into a private, independently verified
 * recovery asset. The exclusive sidecar lock fences participating Runtime versions;
 * it does not prove that a retired writer using another Store has stopped.
 */
export function createKiteSessionRecoveryBackup(
  databasePath: string,
  recoveryParentPath: string,
  options: KiteSessionRecoveryBackupOptions = {},
): KiteSessionRecoveryBackup {
  const sourcePath = assertCanonicalKiteDatabasePath(
    databasePath,
    basename(databasePath) === 'kite.sqlite' ? 'kite.sqlite' : 'kite-session.sqlite',
  );
  assertNoFollowDatabasePath(sourcePath);
  assertPrivateExistingFile(sourcePath);
  const recoveryParent = assertPrivateRecoveryParent(
    recoveryParentPath,
    options.windowsPathSecurity,
  );
  if (process.platform === 'win32') {
    options.windowsPathSecurity!.verifyFile(sourcePath);
    if (existsSync(`${sourcePath}-wal`))
      options.windowsPathSecurity!.verifyFile(`${sourcePath}-wal`);
  }
  const maintenance =
    options.maintenance ?? acquireKiteSessionStoreMaintenance(sourcePath, 'exclusive', options);
  assertKiteSessionExclusiveMaintenance(maintenance, sourcePath);
  let directory: string | undefined;
  try {
    const sourceBefore = fingerprintSource(sourcePath);
    const source = openReadonlySource(sourcePath);
    let capture: KiteSessionCapture;
    try {
      // Source is opened READONLY; query_only would also forbid VACUUM INTO
      // from creating the separate destination file.
      capture = captureKnownStore(source);
      const candidateDirectory = join(recoveryParent, `backup-${randomBytes(12).toString('hex')}`);
      mkdirSync(candidateDirectory, { mode: 0o700 });
      // Only a directory created by this invocation may be removed on failure.
      directory = candidateDirectory;
      secureRecoveryDirectory(directory, options.windowsPathSecurity);
      const copyPath = join(directory, 'kite-session.sqlite');
      if (existsSync(copyPath)) throw new Error('Recovery copy path already exists.');
      // SQLite VACUUM INTO creates the output itself. The private directory
      // prevents access before the resulting file is secured and verified.
      source.query('VACUUM INTO ?').run(copyPath);
      if (process.platform !== 'win32') chmodSync(copyPath, 0o600);
      if (process.platform === 'win32') {
        options.windowsPathSecurity!.secureFile(copyPath);
        options.windowsPathSecurity!.verifyFile(copyPath);
      }
      assertPrivateExistingFile(copyPath);
      if (JSON.stringify(captureKnownStore(source)) !== JSON.stringify(capture)) {
        throw new Error('Kite Session source changed during recovery capture.');
      }
    } finally {
      source.close(false);
    }
    const sourceAfter = fingerprintSource(sourcePath);
    if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) {
      throw new Error('Kite Session source changed during recovery backup.');
    }
    const copyPath = join(directory, 'kite-session.sqlite');
    normalizeBackupJournal(copyPath);
    if (process.platform === 'win32') {
      options.windowsPathSecurity!.secureFile(copyPath);
      options.windowsPathSecurity!.verifyFile(copyPath);
    }
    const verified = new Database(
      copyPath,
      sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      verified.run('PRAGMA query_only = ON');
      if (JSON.stringify(captureKnownStore(verified)) !== JSON.stringify(capture)) {
        throw new Error('Kite Session recovery copy differs from the source capture.');
      }
    } finally {
      verified.close(false);
    }
    fsyncFile(copyPath);
    fsyncDirectory(directory);
    const manifest: KiteSessionRecoveryManifest = Object.freeze({
      version: 1,
      createdAt: new Date().toISOString(),
      source: Object.freeze({
        pathDigest: createHash('sha256').update(sourcePath).digest('hex'),
        device: sourceBefore.device,
        inode: sourceBefore.inode,
        mainSha256: sourceBefore.mainSha256,
        walSha256: sourceBefore.walSha256,
      }),
      capture,
      backupSha256: hashFile(copyPath),
    });
    const temporaryManifest = join(directory, 'ready.json.tmp');
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      options.windowsPathSecurity!.secureFile(temporaryManifest);
      options.windowsPathSecurity!.verifyFile(temporaryManifest);
    }
    fsyncFile(temporaryManifest);
    const manifestPath = join(directory, 'ready.json');
    renameSync(temporaryManifest, manifestPath);
    fsyncDirectory(directory);
    fsyncDirectory(recoveryParent);
    if (
      readFileSync(manifestPath, 'utf8') !== `${JSON.stringify(manifest)}\n` ||
      hashFile(copyPath) !== manifest.backupSha256
    ) {
      throw new Error('Kite Session recovery ready manifest does not match the backup bytes.');
    }
    return Object.freeze({ directory, databasePath: copyPath, manifestPath, manifest });
  } catch (error) {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Recovery backup failed and cleanup was incomplete.',
        );
      }
    }
    throw error;
  } finally {
    if (!options.maintenance) maintenance.release();
  }
}

function openReadonlySource(path: string): Database {
  // A clean WAL database may have no -wal/-shm files. SQLite's ordinary
  // readonly open then fails because it cannot initialize shared memory.
  // Only that exact sidecar-free case admits an immutable readonly snapshot;
  // source hashes and full logical captures are compared after VACUUM.
  if (!existsSync(`${path}-wal`) && !existsSync(`${path}-shm`) && hasWalHeader(path)) {
    return new Database(
      `${pathToFileURL(path).href}?immutable=1`,
      sqliteConstants.SQLITE_OPEN_READONLY |
        sqliteConstants.SQLITE_OPEN_URI |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
  }
  return new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
}

function hasWalHeader(path: string): boolean {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const versions = Buffer.alloc(2);
    return (
      readSync(fd, versions, 0, versions.length, 18) === 2 && versions[0] === 2 && versions[1] === 2
    );
  } finally {
    closeSync(fd);
  }
}

function assertPrivateRecoveryParent(path: string, security?: WindowsRecoveryPathSecurity): string {
  const canonical = realpathSync.native(path);
  if (canonical !== path) throw new Error('Recovery parent must be a canonical real directory.');
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Recovery parent must be a real directory.');
  }
  if (process.platform === 'win32') {
    if (!security) throw new Error('Windows recovery backup requires path security.');
    security.verifyDirectory(canonical);
  } else if (
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error('Recovery parent must be owner-only.');
  }
  return canonical;
}

function secureRecoveryDirectory(path: string, security?: WindowsRecoveryPathSecurity): void {
  if (process.platform === 'win32') {
    if (!security) throw new Error('Windows recovery backup requires path security.');
    security.secureDirectory(path);
    security.verifyDirectory(path);
  } else {
    chmodSync(path, 0o700);
  }
}

function assertPrivateExistingFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync.native(path) !== path ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Kite Session recovery source must be one private regular file.');
  }
}

function captureKnownStore(database: Database): KiteSessionCapture {
  return database.transaction(() => {
    const metadata = readKiteSessionStoreMetadata(database);
    let columns: Readonly<Record<string, readonly string[]>>;
    if (metadata.schemaVersion === 9) {
      assertKiteHomeStoreSchema(database);
      columns = KITE_HOME_STORE_TABLE_COLUMNS;
    } else if (metadata.schemaVersion === 10) {
      assertKiteSessionStoreSchema(database);
      columns = KITE_SESSION_STORE_TABLE_COLUMNS;
    } else if (metadata.schemaVersion === 11) {
      assertKiteSessionStore11Schema(database);
      columns = KITE_SESSION_STORE11_TABLE_COLUMNS;
    } else {
      throw new Error('Kite Session recovery backup supports only verified Store formats.');
    }
    assertKiteStoreIntegrity(database);
    const userVersion = database
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version;
    if (userVersion !== metadata.schemaVersion || metadata.formatEpoch === null) {
      throw new Error('Kite Session recovery source user_version is inconsistent.');
    }
    const schemaRows = database
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name',
      )
      .all();
    return Object.freeze({
      schemaVersion: metadata.schemaVersion,
      formatEpoch: metadata.formatEpoch,
      userVersion,
      schemaDigest: createHash('sha256').update(JSON.stringify(schemaRows)).digest('hex'),
      tables: captureSqliteTableContentDigests(database, columns),
    });
  })();
}

function fingerprintSource(path: string): {
  readonly device: number;
  readonly inode: number;
  readonly mainSha256: string;
  readonly walSha256: string | null;
} {
  const stat = lstatSync(path);
  const wal = `${path}-wal`;
  if (existsSync(wal)) assertPrivateExistingFile(wal);
  return {
    device: stat.dev,
    inode: stat.ino,
    mainSha256: hashFile(path),
    walSha256: existsSync(wal) ? hashFile(wal) : null,
  };
}

function hashFile(path: string): string {
  const pathnameBefore = lstatSync(path);
  if (!pathnameBefore.isFile() || pathnameBefore.isSymbolicLink() || pathnameBefore.nlink !== 1) {
    throw new Error('Recovery hash source is not one regular file.');
  }
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== pathnameBefore.dev ||
      before.ino !== pathnameBefore.ino
    ) {
      throw new Error('Recovery hash source changed before it was opened.');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    const pathnameAfter = lstatSync(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== pathnameAfter.dev ||
      after.ino !== pathnameAfter.ino
    ) {
      throw new Error('Recovery hash source changed while being read.');
    }
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function normalizeBackupJournal(path: string): void {
  const database = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    const result = database
      .query<{ journal_mode: string }, []>('PRAGMA journal_mode = DELETE')
      .get();
    if (result?.journal_mode.toLowerCase() !== 'delete') {
      throw new Error('Kite Session recovery copy could not enter standalone journal mode.');
    }
  } finally {
    database.close(false);
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) {
      const stat = lstatSync(sidecar);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
        throw new Error('Kite Session recovery copy retained a nonempty journal sidecar.');
      }
      unlinkSync(sidecar);
    }
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
