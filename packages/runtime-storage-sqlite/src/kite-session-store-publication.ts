import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertCanonicalKiteDatabasePath } from './kite-home-runtime-file';
import { assertKiteSessionStoreSchema } from './kite-home-store';
import {
  assertKiteSessionExclusiveMaintenance,
  type KiteSessionMaintenanceLock,
  type KiteSessionWindowsPathSecurity,
} from './kite-session-maintenance';
import {
  captureKiteSessionPreservationManifest,
  compareKiteSessionPreservationManifests,
  type KiteSessionPreservationManifest,
} from './kite-session-preservation';
import { inspectKiteSessionStoreSources } from './kite-session-store-sources';

const INTENT_NAME = 'kite-session-publication.json';
const STAGING_NAME = 'publication-stage.json';
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const ASSET_COMPONENT = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const PARTS = ['main', 'wal', 'shm'] as const;

export interface KitePublicationFileFingerprint {
  readonly sha256: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
}
export interface KitePublicationSourceFingerprint {
  readonly main: KitePublicationFileFingerprint | null;
  readonly wal: KitePublicationFileFingerprint | null;
  readonly shm: KitePublicationFileFingerprint | null;
}
export interface KitePublicationSource {
  readonly databasePath: string;
  readonly maintenance: KiteSessionMaintenanceLock;
  readonly files: KitePublicationSourceFingerprint;
}
export interface KitePublicationWindowsSecurity extends KiteSessionWindowsPathSecurity {
  secureDirectory(path: string): void;
}
export interface KiteSessionPublicationInput {
  readonly canonicalPath: string;
  readonly candidatePath: string;
  readonly migrationDirectory: string;
  /** Produced by full production-reader validation of this closed candidate. */
  readonly candidateManifest: KiteSessionPreservationManifest;
  /** Production reader validation before the intent is cleared. */
  readonly validatePublished: (database: Database) => void;
  readonly canonicalMaintenance: KiteSessionMaintenanceLock;
  /** Includes canonical (even if absent) and every known historical source. */
  readonly sources: readonly KitePublicationSource[];
  readonly windowsPathSecurity?: KitePublicationWindowsSecurity;
  /** Test-only fault after an observable persistence boundary. */
  readonly fault?: (stage: string) => void;
}
export interface KiteSessionPublicationResumeInput {
  readonly canonicalPath: string;
  readonly canonicalMaintenance: KiteSessionMaintenanceLock;
  readonly sourceMaintenance: readonly {
    readonly databasePath: string;
    readonly maintenance: KiteSessionMaintenanceLock;
  }[];
  readonly validatePublished: (database: Database) => void;
  readonly windowsPathSecurity?: KitePublicationWindowsSecurity;
  readonly fault?: (stage: string) => void;
}
export type KiteSessionPublicationInspection =
  | { readonly status: 'none' }
  | {
      readonly status: 'pending';
      readonly sourcePaths: readonly string[];
      readonly migrationDirectory: string;
    };

interface StoredSource {
  readonly path: string;
  readonly files: KitePublicationSourceFingerprint;
}
interface PublicationIntent {
  readonly version: 1;
  readonly migrationDirectory: string;
  readonly candidatePath: string;
  readonly candidateSha256: string;
  readonly candidateManifest: KiteSessionPreservationManifest;
  readonly sources: readonly StoredSource[];
}

export class KiteSessionPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiteSessionPublicationError';
  }
}
const fail = (message: string): never => {
  throw new KiteSessionPublicationError(message);
};

/** Fingerprint an exact known source path without opening SQLite or creating files. */
export function captureKiteSessionPublicationSource(
  canonicalPath: string,
  databasePath: string,
  security?: KitePublicationWindowsSecurity,
): KitePublicationSourceFingerprint {
  const canonical = canonicalStore(canonicalPath);
  const source = knownSourcePath(canonical, databasePath);
  const main = fingerprintIfExists(source, security);
  const wal = fingerprintIfExists(`${source}-wal`, security);
  const shm = fingerprintIfExists(`${source}-shm`, security);
  if (!main && (wal || shm)) fail('A Store sidecar exists without its main file.');
  return Object.freeze({ main, wal, shm });
}

/** Read-only startup discovery; incomplete staging never becomes admission state. */
export function inspectKiteSessionPublication(
  canonicalPath: string,
): KiteSessionPublicationInspection {
  const canonical = assertCanonicalKiteDatabasePath(canonicalPath, 'kite-session.sqlite');
  const root = dirname(canonical);
  if (process.platform !== 'win32') privateDirectory(root);
  const committed = join(root, INTENT_NAME);
  if (!pathExists(committed)) return { status: 'none' };
  // Windows supports ordinary current/fresh Store ownership under its separate
  // ACL-verified maintenance lock, but automatic publication is not qualified.
  if (process.platform === 'win32') fail('Pending Store publication is unsupported on Windows.');
  const intent = readIntent(committed, canonical);
  return Object.freeze({
    status: 'pending',
    sourcePaths: Object.freeze(intent.sources.map((entry) => join(root, entry.path))),
    migrationDirectory: join(root, intent.migrationDirectory),
  });
}

/** Caller owns all exclusive locks and old-writer shutdown throughout this operation. */
export function publishVerifiedKiteSessionCandidate(input: KiteSessionPublicationInput): void {
  const canonical = canonicalStore(input.canonicalPath);
  const root = dirname(canonical);
  const migrationDirectory = privateMigrationDirectory(
    root,
    input.migrationDirectory,
    input.windowsPathSecurity,
  );
  const candidate = privateCandidatePath(
    migrationDirectory,
    input.candidatePath,
    input.windowsPathSecurity,
  );
  assertKiteSessionExclusiveMaintenance(input.canonicalMaintenance, canonical);
  if (pathExists(join(root, INTENT_NAME)))
    fail('A publication intent already exists; resume it before starting another.');
  const historical = inspectKiteSessionStoreSources(canonical);
  const expectedPaths = [canonical, ...historical].sort();
  const actualPaths = input.sources
    .map((entry) => knownSourcePath(canonical, entry.databasePath))
    .sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    fail('Publication source inventory changed.');
  const sources: StoredSource[] = [];
  for (const entry of input.sources) {
    const path = knownSourcePath(canonical, entry.databasePath);
    assertKiteSessionExclusiveMaintenance(entry.maintenance, path);
    const actual = captureKiteSessionPublicationSource(canonical, path, input.windowsPathSecurity);
    if (!sameFingerprint(actual, entry.files)) fail('Publication source changed before intent.');
    sources.push({ path: relative(root, path), files: actual });
  }
  sources.sort((a, b) => a.path.localeCompare(b.path));
  const candidateSha256 = verifyCandidate(
    candidate,
    input.candidateManifest,
    input.windowsPathSecurity,
  );
  fsyncFile(candidate);
  fsyncDirectory(dirname(candidate));
  fsyncDirectory(migrationDirectory);
  const intent: PublicationIntent = {
    version: 1,
    migrationDirectory: relative(root, migrationDirectory),
    candidatePath: relative(root, candidate),
    candidateSha256,
    candidateManifest: input.candidateManifest,
    sources,
  };
  writeIntent(root, migrationDirectory, intent, input.fault);
  resumeWithIntent(
    canonical,
    intent,
    input.canonicalMaintenance,
    input.sources.map((entry) => ({
      databasePath: entry.databasePath,
      maintenance: entry.maintenance,
    })),
    input.validatePublished,
    input.windowsPathSecurity,
    input.fault,
  );
}

/** Resume only the one fixed canonical-parent intent; no caller-supplied manifest is trusted. */
export function resumeKiteSessionPublication(input: KiteSessionPublicationResumeInput): void {
  const canonical = canonicalStore(input.canonicalPath);
  const root = dirname(canonical);
  const finalPath = join(root, INTENT_NAME);
  if (!pathExists(finalPath)) fail('There is no pending publication.');
  const intent = readIntent(finalPath, canonical);
  assertKiteSessionExclusiveMaintenance(input.canonicalMaintenance, canonical);
  const locks = new Map(
    input.sourceMaintenance.map(
      (entry) => [knownSourcePath(canonical, entry.databasePath), entry.maintenance] as const,
    ),
  );
  if (
    locks.size !== intent.sources.length ||
    intent.sources.some((entry) => !locks.has(join(root, entry.path)))
  )
    fail('Publication resume did not receive every source lock.');
  for (const entry of intent.sources) {
    const sourcePath = join(root, entry.path);
    const lock = locks.get(sourcePath);
    if (!lock) throw new KiteSessionPublicationError('Publication source lock is missing.');
    assertKiteSessionExclusiveMaintenance(lock, sourcePath);
  }
  const migrationDirectory = privateMigrationDirectory(
    root,
    join(root, intent.migrationDirectory),
    input.windowsPathSecurity,
  );
  privateCandidatePath(
    migrationDirectory,
    join(root, intent.candidatePath),
    input.windowsPathSecurity,
    true,
  );
  resumeWithIntent(
    canonical,
    intent,
    input.canonicalMaintenance,
    input.sourceMaintenance,
    input.validatePublished,
    input.windowsPathSecurity,
    input.fault,
  );
}

function resumeWithIntent(
  canonical: string,
  intent: PublicationIntent,
  canonicalLock: KiteSessionMaintenanceLock,
  sourceLocks: readonly { databasePath: string; maintenance: KiteSessionMaintenanceLock }[],
  validatePublished: (database: Database) => void,
  security?: KitePublicationWindowsSecurity,
  fault?: (stage: string) => void,
): void {
  const root = dirname(canonical);
  assertKiteSessionExclusiveMaintenance(canonicalLock, canonical);
  const locks = new Map(
    sourceLocks.map(
      (entry) => [knownSourcePath(canonical, entry.databasePath), entry.maintenance] as const,
    ),
  );
  if (locks.size !== intent.sources.length) fail('Publication lock inventory changed.');
  for (const entry of intent.sources) {
    const source = join(root, entry.path);
    const lock = locks.get(source);
    if (!lock) throw new KiteSessionPublicationError('Publication source lock is missing.');
    assertKiteSessionExclusiveMaintenance(lock, source);
  }
  const migrationDirectory = privateMigrationDirectory(
    root,
    join(root, intent.migrationDirectory),
    security,
  );
  const candidate = join(root, intent.candidatePath);
  const candidatePresentAtStart = pathExists(candidate);
  if (candidatePresentAtStart) {
    if (fingerprintIfExists(candidate, security)?.sha256 !== intent.candidateSha256)
      fail('Candidate changed after intent.');
    verifyCandidate(candidate, intent.candidateManifest, security);
  }
  const retiredParent = join(migrationDirectory, 'retired');
  ensurePrivateDirectory(retiredParent, security);
  const knownRetired = new Set(intent.sources.map((_, index) => `source${index}`));
  if (readdirSync(retiredParent).some((name) => !knownRetired.has(name)))
    fail('Unknown retired source directory exists.');
  for (const index of intent.sources.keys())
    ensurePrivateDirectory(join(retiredParent, `source${index}`), security);
  // Persist every new directory entry before moving any original Store file.
  fsyncDirectory(migrationDirectory);
  fsyncDirectory(retiredParent);
  for (const [index, entry] of intent.sources.entries()) {
    const source = join(root, entry.path);
    const retired = join(migrationDirectory, 'retired', `source${index}`);
    ensurePrivateDirectory(retired, security);
    const expectedNames = new Set(
      PARTS.filter((part) => entry.files[part] !== null).map(
        (part) => `${basename(source)}${part === 'main' ? '' : `-${part}`}`,
      ),
    );
    if (readdirSync(retired).some((name) => !expectedNames.has(name)))
      fail('Unknown retired source file exists.');
    for (const part of PARTS) {
      const expected = entry.files[part];
      const suffix = part === 'main' ? '' : `-${part}`;
      const from = `${source}${suffix}`;
      const to = join(retired, `${basename(source)}${suffix}`);
      let sourceFact = fingerprintIfExists(from, security);
      const retiredFact = fingerprintIfExists(to, security);
      // After candidate rename, canonical holds the new Store while its original main is retired.
      if (
        source === canonical &&
        part === 'main' &&
        !candidatePresentAtStart &&
        sourceFact?.sha256 === intent.candidateSha256 &&
        (!expected || (retiredFact && !sameFileFingerprint(sourceFact, expected)))
      )
        sourceFact = null;
      if (!expected) {
        if (sourceFact || retiredFact) fail('Unexpected Store file appeared during publication.');
        continue;
      }
      if (sourceFact && retiredFact) fail('Source and retired copies coexist.');
      if (!sameFileFingerprint(sourceFact ?? retiredFact, expected))
        fail('Publication source file changed.');
      if (sourceFact) {
        renameSync(from, to);
        fault?.(`source_rename:${index}:${part}`);
        fsyncDirectory(dirname(from));
        fault?.(`source_parent_fsync:${index}:${part}`);
        fsyncDirectory(dirname(to));
        fault?.(`retired_parent_fsync:${index}:${part}`);
      }
    }
  }
  const candidateFact = fingerprintIfExists(candidate, security);
  const canonicalFact = fingerprintIfExists(canonical, security);
  if (candidateFact && canonicalFact) fail('Candidate and published Store coexist.');
  if (!candidateFact && !canonicalFact) fail('Both candidate and published Store are missing.');
  if (candidateFact) {
    if (candidateFact.sha256 !== intent.candidateSha256) fail('Candidate changed after intent.');
    verifyCandidate(candidate, intent.candidateManifest, security);
    renameSync(candidate, canonical);
    fault?.('candidate_rename');
    fsyncDirectory(dirname(candidate));
    fault?.('candidate_parent_fsync');
    fsyncDirectory(root);
    fault?.('canonical_parent_fsync');
  } else if (canonicalFact?.sha256 !== intent.candidateSha256) {
    fail('Published Store hash differs from the intent.');
  }
  verifyCandidate(canonical, intent.candidateManifest, security);
  const published = new Database(
    canonical,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    published.run('PRAGMA query_only=ON');
    validatePublished(published);
  } finally {
    published.close(false);
  }
  for (const [index, entry] of intent.sources.entries()) {
    for (const part of PARTS) {
      const expected = entry.files[part];
      const suffix = part === 'main' ? '' : `-${part}`;
      const retired = join(
        migrationDirectory,
        'retired',
        `source${index}`,
        `${basename(entry.path)}${suffix}`,
      );
      if (!sameFileFingerprint(fingerprintIfExists(retired, security), expected))
        fail('Retired source is incomplete.');
      if (
        !(join(root, entry.path) === canonical && part === 'main') &&
        pathExists(`${join(root, entry.path)}${suffix}`)
      )
        fail('Historical source still exists.');
    }
  }
  const intentPath = join(root, INTENT_NAME);
  if (!pathExists(intentPath)) fail('Publication intent disappeared.');
  unlinkSync(intentPath);
  fault?.('intent_unlink');
  fsyncDirectory(root);
  fault?.('intent_unlink_fsync');
}

function writeIntent(
  root: string,
  migrationDirectory: string,
  intent: PublicationIntent,
  fault?: (stage: string) => void,
): void {
  const temp = join(migrationDirectory, STAGING_NAME);
  const final = join(root, INTENT_NAME);
  const bytes = Buffer.from(`${JSON.stringify(intent)}\n`);
  if (bytes.length > MAX_INTENT_BYTES) fail('Publication intent exceeds its limit.');
  writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
  fault?.('intent_temp_write');
  fsyncFile(temp);
  fault?.('intent_temp_fsync');
  fsyncDirectory(migrationDirectory);
  renameSync(temp, final);
  fault?.('intent_rename');
  fsyncDirectory(migrationDirectory);
  fsyncDirectory(root);
  fault?.('intent_directory_fsync');
}

function readIntent(path: string, canonical: string): PublicationIntent {
  assertPrivateFile(path);
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > MAX_INTENT_BYTES)
    fail('Publication intent size is invalid.');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('Publication intent is invalid.');
  }
  if (
    !record(raw) ||
    !exactKeys(raw, [
      'version',
      'migrationDirectory',
      'candidatePath',
      'candidateSha256',
      'candidateManifest',
      'sources',
    ]) ||
    raw.version !== 1
  )
    throw new KiteSessionPublicationError('Publication intent shape is invalid.');
  const root = dirname(canonical);
  const migration = privateMigrationDirectory(root, join(root, String(raw.migrationDirectory)));
  const candidate = privateCandidatePath(
    migration,
    join(root, String(raw.candidatePath)),
    undefined,
    true,
  );
  if (
    relative(root, migration) !== raw.migrationDirectory ||
    relative(root, candidate) !== raw.candidatePath ||
    typeof raw.candidateSha256 !== 'string' ||
    !DIGEST.test(raw.candidateSha256)
  )
    fail('Publication paths or hash are invalid.');
  if (
    !validManifest(raw.candidateManifest) ||
    !Array.isArray(raw.sources) ||
    raw.sources.length < 1 ||
    raw.sources.length > 1024
  )
    throw new KiteSessionPublicationError('Publication manifest or sources are invalid.');
  const sources: StoredSource[] = [];
  for (const source of raw.sources) {
    if (
      !record(source) ||
      !exactKeys(source, ['path', 'files']) ||
      typeof source.path !== 'string' ||
      !record(source.files) ||
      !exactKeys(source.files, [...PARTS])
    )
      fail('Publication source is invalid.');
    const path = knownSourcePath(canonical, join(root, source.path));
    if (
      relative(root, path) !== source.path ||
      !PARTS.every((part) => validFingerprint(source.files[part]))
    )
      fail('Publication source fingerprint is invalid.');
    if (!source.files.main && (source.files.wal || source.files.shm))
      fail('Publication source sidecar lacks a main file.');
    sources.push({
      path: source.path,
      files: source.files as unknown as KitePublicationSourceFingerprint,
    });
  }
  if (
    new Set(sources.map((source) => source.path)).size !== sources.length ||
    !sources.some((source) => source.path === basename(canonical))
  )
    fail('Publication source inventory is invalid.');
  return {
    version: 1,
    migrationDirectory: raw.migrationDirectory as string,
    candidatePath: raw.candidatePath as string,
    candidateSha256: raw.candidateSha256 as string,
    candidateManifest: raw.candidateManifest as KiteSessionPreservationManifest,
    sources,
  };
}

function canonicalStore(path: string): string {
  const canonical = assertCanonicalKiteDatabasePath(path, 'kite-session.sqlite');
  privateDirectory(dirname(canonical));
  return canonical;
}
function knownSourcePath(canonical: string, path: string): string {
  if (!isAbsolute(path)) fail('Publication source path must be absolute.');
  const root = dirname(canonical);
  const resolved = resolve(path);
  const relativePath = relative(root, resolved).split(sep).join('/');
  if (
    resolved !== canonical &&
    relativePath !== 'kite.sqlite' &&
    !/^source-profiles\/[a-f0-9]{32}\/kite-session\.sqlite$/u.test(relativePath)
  )
    fail('Publication source path is not a known Store location.');
  if (relativePath.startsWith('source-profiles/')) privateDirectory(dirname(resolved));
  return resolved;
}
function privateMigrationDirectory(
  root: string,
  path: string,
  security?: KitePublicationWindowsSecurity,
): string {
  if (!isAbsolute(path)) fail('Migration directory must be absolute.');
  const resolved = resolve(path);
  const components = relative(root, resolved).split(sep);
  if (
    components.length < 1 ||
    components.length > 2 ||
    components.some((part) => !ASSET_COMPONENT.test(part))
  )
    fail('Migration directory must be a bounded child of the Store root.');
  let current = root;
  const rootDevice = lstatSync(root).dev;
  for (const component of components) {
    current = join(current, component);
    privateDirectory(current, security);
    if (lstatSync(current).dev !== rootDevice)
      fail('Migration assets must share the canonical filesystem.');
  }
  return resolved;
}
function privateCandidatePath(
  migration: string,
  path: string,
  security?: KitePublicationWindowsSecurity,
  allowMissing = false,
): string {
  if (!isAbsolute(path)) fail('Candidate path must be absolute.');
  const resolved = resolve(path);
  const parent = dirname(resolved);
  const components = relative(migration, parent).split(sep);
  if (
    basename(resolved) !== 'kite-session.sqlite' ||
    components.length !== 1 ||
    !ASSET_COMPONENT.test(components[0] ?? '')
  )
    fail('Candidate must be one migration-owned Store file.');
  privateDirectory(parent, security);
  if (!allowMissing || pathExists(resolved)) assertPrivateFile(resolved, security);
  return resolved;
}
function privateDirectory(path: string, security?: KitePublicationWindowsSecurity): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(path) !== path ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    fail('Publication directory is not private and canonical.');
  if (process.platform === 'win32') {
    if (!security)
      throw new KiteSessionPublicationError('Windows publication requires path security.');
    security.verifyDirectory(path);
  }
}
function ensurePrivateDirectory(path: string, security?: KitePublicationWindowsSecurity): void {
  if (!pathExists(path)) {
    mkdirSync(path, { mode: 0o700 });
    if (process.platform === 'win32') security?.secureDirectory(path);
    fsyncDirectory(dirname(path));
  }
  privateDirectory(path, security);
}
function assertPrivateFile(path: string, security?: KitePublicationWindowsSecurity): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync.native(path) !== path ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    fail('Publication file is not private and canonical.');
  if (process.platform === 'win32') {
    if (!security)
      throw new KiteSessionPublicationError('Windows publication requires path security.');
    security.verifyFile(path);
  }
}
function fingerprintIfExists(
  path: string,
  security?: KitePublicationWindowsSecurity,
): KitePublicationFileFingerprint | null {
  if (!pathExists(path)) return null;
  assertPrivateFile(path, security);
  const beforePath = lstatSync(path);
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.nlink !== 1)
      fail('Publication file changed before hashing.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.dev !== afterPath.dev ||
      before.ino !== afterPath.ino
    )
      fail('Publication file changed during hashing.');
    return Object.freeze({
      sha256: hash.digest('hex'),
      device: before.dev,
      inode: before.ino,
      size: before.size,
    });
  } finally {
    closeSync(fd);
  }
}
function sameFileFingerprint(
  actual: KitePublicationFileFingerprint | null,
  expected: KitePublicationFileFingerprint | null,
): boolean {
  return (
    actual === expected ||
    (!!actual &&
      !!expected &&
      actual.sha256 === expected.sha256 &&
      actual.device === expected.device &&
      actual.inode === expected.inode &&
      actual.size === expected.size)
  );
}
function sameFingerprint(
  a: KitePublicationSourceFingerprint,
  b: KitePublicationSourceFingerprint,
): boolean {
  return PARTS.every((part) => sameFileFingerprint(a[part], b[part]));
}
function validFingerprint(value: unknown): boolean {
  if (value === null) return true;
  return (
    record(value) &&
    exactKeys(value, ['sha256', 'device', 'inode', 'size']) &&
    typeof value.sha256 === 'string' &&
    DIGEST.test(value.sha256) &&
    ['device', 'inode', 'size'].every(
      (key) =>
        typeof value[key] === 'number' &&
        Number.isSafeInteger(value[key]) &&
        (value[key] as number) >= 0,
    )
  );
}
function verifyCandidate(
  path: string,
  expected: KiteSessionPreservationManifest,
  security?: KitePublicationWindowsSecurity,
): string {
  const fact = fingerprintIfExists(path, security);
  if (!fact) throw new KiteSessionPublicationError('Verified candidate is missing.');
  if (pathExists(`${path}-wal`) || pathExists(`${path}-shm`) || pathExists(`${path}-journal`))
    fail('Candidate has a journal sidecar.');
  const db = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    db.run('PRAGMA query_only=ON');
    if (
      db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
        .get()
        ?.journal_mode.toLowerCase() !== 'delete'
    )
      fail('Candidate is not in DELETE journal mode.');
    assertKiteSessionStoreSchema(db);
    const manifest = captureKiteSessionPreservationManifest(db);
    if (!compareKiteSessionPreservationManifests(manifest, expected).preserved)
      fail('Candidate differs from its validated manifest.');
  } finally {
    db.close(false);
  }
  return fact.sha256;
}
function validManifest(value: unknown): value is KiteSessionPreservationManifest {
  if (
    !record(value) ||
    !exactKeys(value, ['schema', 'tables']) ||
    value.schema !== 'kite.session-preservation.schema10.v1' ||
    !record(value.tables)
  )
    return false;
  return Object.values(value.tables).every(
    (entry) =>
      record(entry) &&
      exactKeys(entry, ['rows', 'sha256']) &&
      typeof entry.rows === 'number' &&
      Number.isSafeInteger(entry.rows) &&
      entry.rows >= 0 &&
      typeof entry.sha256 === 'string' &&
      DIGEST.test(entry.sha256),
  );
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
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
