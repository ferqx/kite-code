import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  decodeLocalRuntimeServiceDescriptor,
  decodeLocalRuntimeToken,
  decodeLocalServiceLockIdentity,
  encodeLocalRuntimeToken,
  type LocalRuntimeServiceDescriptor,
  type LocalRuntimeToken,
  type LocalServiceLockIdentity,
} from './codecs';
import {
  createKiteHomeIdentity,
  type KiteHomeIdentity,
  type LocalRuntimeServiceStatePaths,
  resolveLocalRuntimeServiceStatePaths,
} from './paths';
import {
  secureWindowsStatePath,
  verifyWindowsStatePath,
  windowsStateSecurityDiagnostic,
} from './windows-state-security';

/** Native state files are deliberately small; a corrupt/oversized file fails closed. */
export const LOCAL_RUNTIME_SERVICE_STATE_LIMITS = Object.freeze({
  descriptorBytes: 64 * 1024,
  lockIdentityBytes: 16 * 1024,
  tokenBytes: 512,
  temporaryNameBytes: 128,
} as const);

export type LocalRuntimeServiceLockKind = 'instance' | 'lifecycle';

export type LocalRuntimeServiceStateErrorCode =
  | 'invalid_path'
  | 'missing'
  | 'busy'
  | 'corrupt'
  | 'permission'
  | 'unsupported'
  | 'io';

/** Errors intentionally contain a stable label, never a token, path, or file contents. */
export class LocalRuntimeServiceStateError extends Error {
  readonly code: LocalRuntimeServiceStateErrorCode;

  constructor(code: LocalRuntimeServiceStateErrorCode, message: string, _cause?: unknown) {
    // Do not attach the native error as `cause`: filesystem errors can carry absolute paths and
    // codec errors can carry rejected secret input. Callers receive only the stable safe label.
    super(message);
    this.name = 'LocalRuntimeServiceStateError';
    this.code = code;
  }
}

export interface LocalRuntimeServiceDirectoryLock {
  readonly kind: LocalRuntimeServiceLockKind;
  readonly path: string;
  readonly identity: LocalServiceLockIdentity;
  /** Idempotent only after this handle has successfully released its own directory. */
  release(): void;
}

export interface LocalRuntimeServiceQuarantinedLock {
  readonly kind: LocalRuntimeServiceLockKind;
  readonly path: string;
  readonly identity: LocalServiceLockIdentity;
  /** Remove only the exact quarantined directory returned by this handle. */
  remove(): void;
}

export interface LocalRuntimeServiceStateCleanup {
  readonly descriptor?: LocalRuntimeServiceDescriptor;
  readonly accessToken?: LocalRuntimeToken;
  readonly controlToken?: LocalRuntimeToken;
  readonly instanceLock?: LocalServiceLockIdentity;
  readonly lifecycleLock?: LocalServiceLockIdentity;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DirectoryBoundary extends FileIdentity {
  readonly path: string;
  readonly realPath: string;
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const POSIX_OWNER_MASK = 0o077;
const POSIX_FILE_MODE = 0o600;
const POSIX_DIRECTORY_MODE = 0o700;
const LOCK_IDENTITY_FILE = 'identity.json';
const TEMPORARY_FILE_PREFIX = '.kite-state-';

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function stateError(
  code: LocalRuntimeServiceStateErrorCode,
  message: string,
  cause?: unknown,
): LocalRuntimeServiceStateError {
  return new LocalRuntimeServiceStateError(code, message, cause);
}

function fail(code: LocalRuntimeServiceStateErrorCode, message: string, cause?: unknown): never {
  throw stateError(code, message, cause);
}

function windowsSecurityMessage(message: string, error: unknown): string {
  const diagnostic = windowsStateSecurityDiagnostic(error);
  return diagnostic === undefined ? message : `${message} (${diagnostic})`;
}

function assertAbsolutePath(path: string, label: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !isAbsolute(path) ||
    [...path].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  ) {
    fail('invalid_path', `${label} is not a safe absolute path.`);
  }
  return resolve(path);
}

function assertExpectedStatePaths(paths: LocalRuntimeServiceStatePaths): string {
  const root = assertAbsolutePath(paths.root, 'State root');
  const expected = resolveLocalRuntimeServiceStatePaths(
    // This is only a lexical reconstruction. Filesystem validation happens below.
    createKiteHomeIdentity(resolve(root, '..', '..')),
  );
  if (
    root !== resolve(expected.root) ||
    resolve(paths.descriptor) !== resolve(join(root, 'instance.json')) ||
    resolve(paths.accessToken) !== resolve(join(root, 'access.token')) ||
    resolve(paths.controlToken) !== resolve(join(root, 'control.token')) ||
    resolve(paths.instanceLock) !== resolve(join(root, 'instance.lock')) ||
    resolve(paths.lifecycleLock) !== resolve(join(root, 'lifecycle.lock'))
  ) {
    fail('invalid_path', 'State paths do not match the fixed V1 layout.');
  }
  return root;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwnerOnly(
  stat: { readonly mode: number; readonly uid?: number },
  label: string,
  path: string,
  kind: 'directory' | 'file',
): void {
  if (process.platform === 'win32') {
    try {
      verifyWindowsStatePath(path, kind);
      return;
    } catch (error) {
      fail(
        'permission',
        windowsSecurityMessage(`${label} does not have a verified Windows owner ACL.`, error),
        error,
      );
    }
  }
  if ((stat.mode & POSIX_OWNER_MASK) !== 0) {
    fail('permission', `${label} is not owner-only.`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== undefined && stat.uid !== uid) {
    fail('permission', `${label} has a different owner.`);
  }
}

type PortableFileStat = {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

function asPortableFileStat(stat: ReturnType<typeof lstatSync>): PortableFileStat {
  return stat as unknown as PortableFileStat;
}

function assertDirectoryStat(
  stat: PortableFileStat,
  label: string,
  ownerOnly: boolean,
  path: string,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('corrupt', `${label} is not a real directory and may not be a symbolic link.`);
  }
  if (ownerOnly) assertOwnerOnly(stat, label, path, 'directory');
}

function assertRegularFileStat(stat: PortableFileStat, label: string, path: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('corrupt', `${label} is not a private regular file.`);
  }
  assertOwnerOnly(stat, label, path, 'file');
}

function lstatIfPresent(path: string): PortableFileStat | undefined {
  try {
    return asPortableFileStat(lstatSync(path));
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return undefined;
    fail('io', 'State entry could not be inspected.', error);
  }
}

function secureExistingOwnerDirectory(path: string, stat: PortableFileStat, label: string): void {
  if (process.platform === 'win32') {
    try {
      secureWindowsStatePath(path, 'directory');
      return;
    } catch (error) {
      fail(
        'permission',
        windowsSecurityMessage(`${label} could not be secured for the Windows owner.`, error),
        error,
      );
    }
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== undefined && stat.uid !== uid) {
    fail('permission', `${label} has a different owner.`);
  }
  try {
    chmodSync(path, POSIX_DIRECTORY_MODE);
  } catch (error) {
    fail('permission', `${label} could not be secured for the current owner.`, error);
  }
}

function ensureDirectoryAtPath(
  path: string,
  label: string,
  ownerOnly: boolean,
  secureExisting = false,
): void {
  const existing = lstatIfPresent(path);
  if (existing) {
    assertDirectoryStat(existing, label, false, path);
    if (ownerOnly && secureExisting) {
      secureExistingOwnerDirectory(path, existing, label);
      const secured = lstatIfPresent(path);
      if (!secured || !sameIdentity(existing, secured)) {
        fail('corrupt', `${label} changed while its owner access was secured.`);
      }
      assertDirectoryStat(secured, label, true, path);
      return;
    }
    assertDirectoryStat(existing, label, ownerOnly, path);
    return;
  }
  try {
    mkdirSync(path, { mode: POSIX_DIRECTORY_MODE });
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) {
      fail('io', `${label} could not be created.`, error);
    }
  }
  const created = lstatIfPresent(path);
  if (!created) fail('io', `${label} disappeared during creation.`);
  if (process.platform === 'win32' && ownerOnly) {
    try {
      secureWindowsStatePath(path, 'directory', { allowOwnerInitialization: true });
    } catch (error) {
      fail(
        'permission',
        windowsSecurityMessage(`${label} could not be secured for the Windows owner.`, error),
        error,
      );
    }
    const secured = lstatIfPresent(path);
    if (!secured || !sameIdentity(created, secured)) {
      fail('corrupt', `${label} changed while its owner access was initialized.`);
    }
    assertDirectoryStat(secured, label, true, path);
    return;
  }
  assertDirectoryStat(created, label, ownerOnly, path);
}

function pathSegmentsUnderRoot(target: string): {
  readonly anchor: string;
  readonly segments: string[];
} {
  const absolute = assertAbsolutePath(target, 'State path');
  const anchor = parse(absolute).root;
  const tail = relative(anchor, absolute);
  return {
    anchor,
    segments: tail === '' ? [] : tail.split(sep).filter((segment) => segment.length > 0),
  };
}

/**
 * Validate/create a home and its fixed runtime-service/v1 state root without following links.
 * The filesystem is walked one component at a time so recursive mkdir cannot silently traverse
 * a pre-positioned link.
 */
export function ensureLocalRuntimeServiceStateRoot(
  identity: KiteHomeIdentity,
): LocalRuntimeServiceStatePaths {
  const validatedIdentity = ensureLocalRuntimeServiceHome(identity);
  const home = validatedIdentity.root;

  const stateDirectory = join(home, 'runtime-service');
  const stateVersion = join(stateDirectory, 'v1');
  ensureDirectoryAtPath(stateDirectory, 'Runtime service state directory', true);
  ensureDirectoryAtPath(stateVersion, 'Runtime service state version directory', true);
  return resolveLocalRuntimeServiceStatePaths(validatedIdentity);
}

/** Create or verify the explicit Service home without following aliases or widening its ACL. */
export function ensureLocalRuntimeServiceHome(identity: KiteHomeIdentity): KiteHomeIdentity {
  const home = assertAbsolutePath(identity.root, 'Kite home');
  const homePath = pathSegmentsUnderRoot(home);
  if (homePath.segments.length === 0)
    fail('invalid_path', 'Kite home must not be a filesystem root.');

  let current = homePath.anchor;
  for (let index = 0; index < homePath.segments.length; index += 1) {
    current = join(current, homePath.segments[index]!);
    const isHome = index === homePath.segments.length - 1;
    ensureDirectoryAtPath(current, 'Kite home', isHome, isHome);
  }
  let canonical: string;
  try {
    canonical = requireRealPath(home);
  } catch (error) {
    fail('io', 'Kite home could not be resolved after validation.', error);
  }
  return createKiteHomeIdentity(canonical, identity.source);
}

/**
 * Reuse the Native no-follow/owner-only directory walk for another fixed
 * repo-private local-runtime state owner. Callers provide only literal safe
 * path segments; request or Workspace input must never reach this primitive.
 */
export function ensurePrivateKiteHomeDirectory(
  identity: KiteHomeIdentity,
  segments: readonly string[],
): string {
  if (
    segments.length === 0 ||
    segments.length > 8 ||
    segments.some((segment) => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(segment))
  ) {
    fail('invalid_path', 'Private Kite home directory segments are invalid.');
  }
  const validatedIdentity = ensureLocalRuntimeServiceHome(identity);
  let current = validatedIdentity.root;
  for (const segment of segments) {
    current = join(current, segment);
    ensureDirectoryAtPath(current, 'Private Kite home state directory', true);
  }
  return current;
}

function validateExistingStateRoot(
  paths: LocalRuntimeServiceStatePaths,
): DirectoryBoundary | undefined {
  const root = assertExpectedStatePaths(paths);
  const parsed = pathSegmentsUnderRoot(root);
  let current = parsed.anchor;
  let stat: PortableFileStat | undefined;
  for (let index = 0; index < parsed.segments.length; index += 1) {
    current = join(current, parsed.segments[index]!);
    stat = lstatIfPresent(current);
    if (!stat) return undefined;
    assertDirectoryStat(
      stat,
      index === parsed.segments.length - 1
        ? 'Runtime service state root'
        : 'Runtime service state parent',
      index === parsed.segments.length - 1,
      current,
    );
  }
  if (!stat) return undefined;
  let realPath: string;
  try {
    realPath = requireRealPath(root);
  } catch (error) {
    fail('io', 'Runtime service state root could not be resolved.', error);
  }
  return { path: root, realPath, dev: stat.dev, ino: stat.ino };
}

function requireRealPath(path: string): string {
  // Keep this isolated so callers never accidentally use realpath as a write target.
  // eslint/biome accepts the native implementation through the local import below.
  // The dynamic property avoids adding a second `realpathSync` import to every call site.
  return realpathSync(path);
}

function assertStateRoot(paths: LocalRuntimeServiceStatePaths): DirectoryBoundary {
  return (
    validateExistingStateRoot(paths) ??
    fail('missing', 'Runtime service state root is missing; initialize it before state I/O.')
  );
}

function lockPath(paths: LocalRuntimeServiceStatePaths, kind: LocalRuntimeServiceLockKind): string {
  assertExpectedStatePaths(paths);
  return kind === 'instance' ? paths.instanceLock : paths.lifecycleLock;
}

function lockIdentityPath(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
): string {
  return join(lockPath(paths, kind), LOCK_IDENTITY_FILE);
}

function readSecureFile(
  path: string,
  label: string,
  maxBytes: number,
  missingAllowed: boolean,
): Buffer | undefined {
  const before = lstatIfPresent(path);
  if (!before) {
    if (missingAllowed) return undefined;
    fail('missing', `${label} is missing.`);
  }
  assertRegularFileStat(before, label, path);
  if (before.size > maxBytes) fail('corrupt', `${label} is oversized.`);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(descriptor);
    assertRegularFileStat(opened, label, path);
    if (!sameIdentity(before, opened)) fail('corrupt', `${label} changed during read.`);
    if (opened.size > maxBytes) fail('corrupt', `${label} is oversized.`);
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > maxBytes) fail('corrupt', `${label} is oversized.`);
    return bytes;
  } catch (error) {
    if (error instanceof LocalRuntimeServiceStateError) throw error;
    return fail('io', `${label} could not be read.`, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeJsonFile<T>(bytes: Buffer, label: string, decode: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    fail('corrupt', `${label} is not valid JSON.`, error);
  }
  try {
    return decode(value);
  } catch (error) {
    fail('corrupt', `${label} failed strict validation.`, error);
  }
}

function encodeJsonFile(value: unknown, label: string): Buffer {
  try {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  } catch (error) {
    fail('corrupt', `${label} could not be serialized.`, error);
  }
}

function encodeDescriptorForState(value: unknown): LocalRuntimeServiceDescriptor {
  try {
    return decodeLocalRuntimeServiceDescriptor(value);
  } catch (error) {
    fail('corrupt', 'Service descriptor failed strict validation.', error);
  }
}

function encodeTokenForState(value: unknown, kind: 'access' | 'control'): LocalRuntimeToken {
  if (typeof value !== 'string') fail('corrupt', `${kind} token failed strict validation.`);
  try {
    return encodeLocalRuntimeToken(value);
  } catch (error) {
    fail('corrupt', `${kind} token failed strict validation.`, error);
  }
}

function encodeLockIdentityForState(
  value: unknown,
  kind: LocalRuntimeServiceLockKind,
): LocalServiceLockIdentity {
  try {
    return decodeLocalServiceLockIdentity(value);
  } catch (error) {
    fail('corrupt', `${kind} lock identity failed strict validation.`, error);
  }
}

function targetBoundary(path: string, label: string): DirectoryBoundary {
  const directory = dirname(path);
  const stat = lstatIfPresent(directory);
  if (!stat) fail('missing', `${label} parent is missing.`);
  assertDirectoryStat(stat, `${label} parent`, true, directory);
  let realPath: string;
  try {
    realPath = requireRealPath(directory);
  } catch (error) {
    fail('io', `${label} parent could not be resolved.`, error);
  }
  return { path: directory, realPath, dev: stat.dev, ino: stat.ino };
}

function assertBoundaryStable(boundary: DirectoryBoundary, label: string): void {
  const current = lstatIfPresent(boundary.path);
  if (!current) fail('corrupt', `${label} parent disappeared.`);
  assertDirectoryStat(current, `${label} parent`, true, boundary.path);
  let realPath: string;
  try {
    realPath = requireRealPath(boundary.path);
  } catch (error) {
    fail('io', `${label} parent could not be resolved.`, error);
  }
  if (!sameIdentity(boundary, current) || realPath !== boundary.realPath) {
    fail('corrupt', `${label} parent changed during publication.`);
  }
}

function assertTargetUnchanged(
  path: string,
  before: PortableFileStat | undefined,
  label: string,
): void {
  const current = lstatIfPresent(path);
  if (!before && current) fail('corrupt', `${label} appeared during publication.`);
  if (before && !current) fail('corrupt', `${label} disappeared during publication.`);
  if (before && current) {
    assertRegularFileStat(current, label, path);
    if (!sameIdentity(before, current)) fail('corrupt', `${label} changed during publication.`);
  }
}

function syncDirectory(path: string, label: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) fail('corrupt', `${label} is not a directory.`);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof LocalRuntimeServiceStateError) throw error;
    fail('io', `${label} could not be flushed.`, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function temporaryPath(directory: string, targetName: string): string {
  const suffix = randomBytes(16).toString('hex');
  const value = `${TEMPORARY_FILE_PREFIX}${targetName}.${suffix}.tmp`;
  if (Buffer.byteLength(value, 'utf8') > LOCAL_RUNTIME_SERVICE_STATE_LIMITS.temporaryNameBytes) {
    fail('invalid_path', 'State temporary name is oversized.');
  }
  return join(directory, value);
}

function publishBytes(target: string, bytes: Buffer, label: string, maxBytes: number): void {
  if (bytes.byteLength > maxBytes) fail('corrupt', `${label} is oversized.`);
  const boundary = targetBoundary(target, label);
  const existing = lstatIfPresent(target);
  if (existing) assertRegularFileStat(existing, label, target);
  const temporary = temporaryPath(boundary.path, target.split(/[\\/]/u).at(-1) ?? 'state');
  let descriptor: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      POSIX_FILE_MODE,
    );
    const created = fstatSync(descriptor);
    temporaryIdentity = { dev: created.dev, ino: created.ino };
    writeFileSync(descriptor, bytes);
    if (process.platform !== 'win32') fchmodSync(descriptor, POSIX_FILE_MODE);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (process.platform === 'win32') {
      try {
        secureWindowsStatePath(temporary, 'file', { allowOwnerInitialization: true });
      } catch (error) {
        fail(
          'permission',
          'State temporary file could not be secured for the Windows owner.',
          error,
        );
      }
    }
    const secured = lstatIfPresent(temporary);
    if (!secured || !sameIdentity(temporaryIdentity, secured)) {
      fail('corrupt', 'State temporary file changed while its owner access was secured.');
    }
    assertRegularFileStat(secured, 'State temporary file', temporary);

    assertBoundaryStable(boundary, label);
    assertTargetUnchanged(target, existing, label);
    renameSync(temporary, target);
    published = true;
    syncDirectory(boundary.path, `${label} parent`);

    const after = lstatIfPresent(target);
    if (!after) fail('io', `${label} disappeared after publication.`);
    assertRegularFileStat(after, label, target);
  } catch (error) {
    if (error instanceof LocalRuntimeServiceStateError) throw error;
    fail('io', `${label} could not be published.`, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published && temporaryIdentity) {
      try {
        assertBoundaryStable(boundary, label);
        const current = lstatIfPresent(temporary);
        if (current && sameIdentity(temporaryIdentity, current)) {
          assertRegularFileStat(current, 'State temporary file', temporary);
          unlinkSync(temporary);
        }
      } catch {
        // Never clean a temp path after its parent or inode has changed.
      }
    }
  }
}

export function readLocalRuntimeServiceDescriptor(
  paths: LocalRuntimeServiceStatePaths,
): LocalRuntimeServiceDescriptor | undefined {
  if (!validateExistingStateRoot(paths)) return undefined;
  const bytes = readSecureFile(
    paths.descriptor,
    'Service descriptor',
    LOCAL_RUNTIME_SERVICE_STATE_LIMITS.descriptorBytes,
    true,
  );
  return bytes === undefined
    ? undefined
    : decodeJsonFile(bytes, 'Service descriptor', decodeLocalRuntimeServiceDescriptor);
}

export function publishLocalRuntimeServiceDescriptor(
  paths: LocalRuntimeServiceStatePaths,
  descriptor: unknown,
): LocalRuntimeServiceDescriptor {
  assertStateRoot(paths);
  const value = encodeDescriptorForState(descriptor);
  publishBytes(
    paths.descriptor,
    encodeJsonFile(value, 'Service descriptor'),
    'Service descriptor',
    LOCAL_RUNTIME_SERVICE_STATE_LIMITS.descriptorBytes,
  );
  return value;
}

export function readLocalRuntimeServiceToken(
  paths: LocalRuntimeServiceStatePaths,
  kind: 'access' | 'control',
): LocalRuntimeToken | undefined {
  if (!validateExistingStateRoot(paths)) return undefined;
  const path = kind === 'access' ? paths.accessToken : paths.controlToken;
  const bytes = readSecureFile(
    path,
    `${kind} token`,
    LOCAL_RUNTIME_SERVICE_STATE_LIMITS.tokenBytes,
    true,
  );
  if (bytes === undefined) return undefined;
  try {
    return decodeLocalRuntimeToken(bytes.toString('utf8'));
  } catch (error) {
    fail('corrupt', `${kind} token failed strict validation.`, error);
  }
}

export function publishLocalRuntimeServiceToken(
  paths: LocalRuntimeServiceStatePaths,
  kind: 'access' | 'control',
  token: unknown,
): LocalRuntimeToken {
  assertStateRoot(paths);
  const value = encodeTokenForState(token, kind);
  const path = kind === 'access' ? paths.accessToken : paths.controlToken;
  publishBytes(
    path,
    Buffer.from(value, 'utf8'),
    `${kind} token`,
    LOCAL_RUNTIME_SERVICE_STATE_LIMITS.tokenBytes,
  );
  return value;
}

/** Generate one restart-scoped token. Callers must invoke this twice for access/control. */
export function createLocalRuntimeServiceToken(): LocalRuntimeToken {
  return decodeLocalRuntimeToken(randomBytes(32).toString('base64url'));
}

function readLockIdentityAtPath(
  path: string,
  kind: LocalRuntimeServiceLockKind,
): LocalServiceLockIdentity | undefined {
  const lock = lstatIfPresent(path);
  if (!lock) return undefined;
  assertDirectoryStat(lock, `${kind} lock`, true, path);
  let entries: readonly { readonly name: string }[];
  try {
    entries = readdirSync(path, { withFileTypes: true }) as unknown as readonly {
      readonly name: string;
    }[];
  } catch (error) {
    fail('io', `${kind} lock identity directory could not be read.`, error);
  }
  if (entries.length !== 1 || entries[0]?.name !== LOCK_IDENTITY_FILE) {
    fail('corrupt', `${kind} lock identity directory has unexpected entries.`);
  }
  const bytes = readSecureFile(
    join(path, LOCK_IDENTITY_FILE),
    `${kind} lock identity`,
    LOCAL_RUNTIME_SERVICE_STATE_LIMITS.lockIdentityBytes,
    false,
  );
  if (!bytes) fail('missing', `${kind} lock identity is missing.`);
  return decodeJsonFile(bytes, `${kind} lock identity`, decodeLocalServiceLockIdentity);
}

function readLockIdentityFile(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
): LocalServiceLockIdentity | undefined {
  return readLockIdentityAtPath(lockPath(paths, kind), kind);
}

export function readLocalRuntimeServiceLockIdentity(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
): LocalServiceLockIdentity | undefined {
  if (!validateExistingStateRoot(paths)) return undefined;
  return readLockIdentityFile(paths, kind);
}

function publishLockIdentity(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
  identity: LocalServiceLockIdentity,
): FileIdentity {
  const path = lockIdentityPath(paths, kind);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      POSIX_FILE_MODE,
    );
    const stat = fstatSync(descriptor);
    writeFileSync(descriptor, encodeJsonFile(identity, `${kind} lock identity`));
    if (process.platform !== 'win32') fchmodSync(descriptor, POSIX_FILE_MODE);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (process.platform === 'win32') {
      try {
        secureWindowsStatePath(path, 'file', { allowOwnerInitialization: true });
      } catch (error) {
        fail(
          'permission',
          `${kind} lock identity could not be secured for the Windows owner.`,
          error,
        );
      }
    }
    const secured = lstatIfPresent(path);
    if (!secured || !sameIdentity(stat, secured)) {
      fail('corrupt', `${kind} lock identity changed while its owner access was secured.`);
    }
    assertRegularFileStat(secured, `${kind} lock identity`, path);
    syncDirectory(lockPath(paths, kind), `${kind} lock`);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof LocalRuntimeServiceStateError) throw error;
    return fail('io', `${kind} lock identity could not be published.`, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function lockBusyOrInvalid(path: string, kind: LocalRuntimeServiceLockKind): undefined {
  const existing = lstatIfPresent(path);
  if (!existing) return undefined;
  assertDirectoryStat(existing, `${kind} lock`, true, path);
  return undefined;
}

function sameLockIdentity(
  left: LocalServiceLockIdentity,
  right: LocalServiceLockIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeFileIfMatches<T>(input: {
  readonly paths: LocalRuntimeServiceStatePaths;
  readonly path: string;
  readonly label: string;
  readonly maxBytes: number;
  readonly expected: T;
  readonly decode: (value: Buffer) => T;
  readonly equal: (actual: T, expected: T) => boolean;
}): void {
  const root = assertStateRoot(input.paths);
  const before = lstatIfPresent(input.path);
  if (!before) return;
  assertRegularFileStat(before, input.label, input.path);
  const bytes = readSecureFile(input.path, input.label, input.maxBytes, false);
  if (!bytes) fail('missing', `${input.label} is missing.`);
  let actual: T;
  try {
    actual = input.decode(bytes);
  } catch (error) {
    fail('corrupt', `${input.label} failed strict validation.`, error);
  }
  if (!input.equal(actual, input.expected)) {
    fail('corrupt', `${input.label} does not match the cleanup identity.`);
  }
  const current = lstatIfPresent(input.path);
  if (!current) return;
  assertRegularFileStat(current, input.label, input.path);
  if (!sameIdentity(before, current)) fail('corrupt', `${input.label} changed during cleanup.`);
  assertBoundaryStable(root, 'Runtime service state');
  unlinkSync(input.path);
  syncDirectory(root.path, 'Runtime service state root');
}

export function removeLocalRuntimeServiceDescriptor(
  paths: LocalRuntimeServiceStatePaths,
  expected: LocalRuntimeServiceDescriptor,
): void {
  removeFileIfMatches({
    paths,
    path: paths.descriptor,
    label: 'Service descriptor',
    maxBytes: LOCAL_RUNTIME_SERVICE_STATE_LIMITS.descriptorBytes,
    expected: encodeDescriptorForState(expected),
    decode: (bytes) =>
      decodeJsonFile(bytes, 'Service descriptor', decodeLocalRuntimeServiceDescriptor),
    equal: (actual, value) => JSON.stringify(actual) === JSON.stringify(value),
  });
}

export function removeLocalRuntimeServiceToken(
  paths: LocalRuntimeServiceStatePaths,
  kind: 'access' | 'control',
  expected: LocalRuntimeToken,
): void {
  const path = kind === 'access' ? paths.accessToken : paths.controlToken;
  removeFileIfMatches({
    paths,
    path,
    label: `${kind} token`,
    maxBytes: LOCAL_RUNTIME_SERVICE_STATE_LIMITS.tokenBytes,
    expected: encodeTokenForState(expected, kind),
    decode: (bytes) => decodeLocalRuntimeToken(bytes.toString('utf8')),
    equal: (actual, value) => actual === value,
  });
}

function removeLockIfMatches(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
  expected: LocalServiceLockIdentity,
): void {
  const root = assertStateRoot(paths);
  const path = lockPath(paths, kind);
  const before = lstatIfPresent(path);
  if (!before) return;
  assertDirectoryStat(before, `${kind} lock`, true, path);
  const actual = readLockIdentityFile(paths, kind);
  if (!actual || !sameLockIdentity(actual, expected)) {
    fail('corrupt', `${kind} lock does not match the cleanup identity.`);
  }
  const current = lstatIfPresent(path);
  if (!current) return;
  assertDirectoryStat(current, `${kind} lock`, true, path);
  if (!sameIdentity(before, current)) fail('corrupt', `${kind} lock changed during cleanup.`);
  unlinkSync(lockIdentityPath(paths, kind));
  syncDirectory(path, `${kind} lock`);
  try {
    rmdirSync(path);
  } catch (error) {
    fail('io', `${kind} lock could not be removed.`, error);
  }
  syncDirectory(root.path, 'Runtime service state root');
}

export function removeLocalRuntimeServiceLock(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
  expected: LocalServiceLockIdentity,
): void {
  removeLockIfMatches(paths, kind, encodeLockIdentityForState(expected, kind));
}

function quarantineName(kind: LocalRuntimeServiceLockKind): string {
  return `.${kind}.quarantine-${randomBytes(16).toString('hex')}`;
}

function assertQuarantinePath(
  root: string,
  kind: LocalRuntimeServiceLockKind,
  path: string,
): string {
  const absolute = assertAbsolutePath(path, `${kind} quarantine`);
  const expectedPrefix = `.${kind}.quarantine-`;
  if (
    dirname(absolute) !== root ||
    !absolute.slice(root.length + 1).startsWith(expectedPrefix) ||
    !/^[a-f0-9]{32}$/u.test(absolute.slice(root.length + 1 + expectedPrefix.length))
  ) {
    fail('invalid_path', `${kind} quarantine path is invalid.`);
  }
  return absolute;
}

/** Atomically move a lock aside for a caller that has independently proved it stale. */
export function quarantineLocalRuntimeServiceLock(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
  expected?: LocalServiceLockIdentity,
): LocalRuntimeServiceQuarantinedLock | undefined {
  const root = assertStateRoot(paths);
  const source = lockPath(paths, kind);
  const sourceStat = lstatIfPresent(source);
  if (!sourceStat) return undefined;
  assertDirectoryStat(sourceStat, `${kind} lock`, true, source);
  const identity = readLockIdentityFile(paths, kind);
  if (!identity) fail('missing', `${kind} lock identity is missing.`);
  if (expected && !sameLockIdentity(identity, encodeLockIdentityForState(expected, kind))) {
    fail('corrupt', `${kind} lock does not match the quarantine identity.`);
  }
  const destination = join(root.path, quarantineName(kind));
  if (lstatIfPresent(destination))
    fail('io', `${kind} lock quarantine destination already exists.`);
  assertBoundaryStable(root, 'Runtime service state');
  renameSync(source, destination);
  syncDirectory(root.path, 'Runtime service state root');
  const quarantinedStat = lstatIfPresent(destination);
  if (!quarantinedStat || !sameIdentity(sourceStat, quarantinedStat)) {
    fail('io', `${kind} lock quarantine could not be verified.`);
  }

  let removed = false;
  return Object.freeze({
    kind,
    path: destination,
    identity,
    remove(): void {
      if (removed) return;
      const current = lstatIfPresent(destination);
      if (!current) {
        removed = true;
        return;
      }
      assertQuarantinePath(root.path, kind, destination);
      assertDirectoryStat(current, `${kind} quarantined lock`, true, destination);
      if (!sameIdentity(quarantinedStat, current)) {
        fail('corrupt', `${kind} quarantined lock is no longer owned by this handle.`);
      }
      const currentIdentity = readLockIdentityAtPath(destination, kind);
      if (!currentIdentity || !sameLockIdentity(currentIdentity, identity)) {
        fail('corrupt', `${kind} quarantined lock identity is no longer owned by this handle.`);
      }
      unlinkSync(join(destination, LOCK_IDENTITY_FILE));
      syncDirectory(destination, `${kind} quarantined lock`);
      try {
        rmdirSync(destination);
      } catch (error) {
        fail('io', `${kind} quarantined lock could not be removed.`, error);
      }
      syncDirectory(root.path, 'Runtime service state root');
      removed = true;
    },
  });
}

/** Remove only state entries whose exact current identity was supplied by the owner. */
export function clearLocalRuntimeServiceState(
  paths: LocalRuntimeServiceStatePaths,
  expected: LocalRuntimeServiceStateCleanup,
): void {
  if (expected.descriptor !== undefined)
    removeLocalRuntimeServiceDescriptor(paths, expected.descriptor);
  if (expected.accessToken !== undefined) {
    removeLocalRuntimeServiceToken(paths, 'access', expected.accessToken);
  }
  if (expected.controlToken !== undefined) {
    removeLocalRuntimeServiceToken(paths, 'control', expected.controlToken);
  }
  if (expected.instanceLock !== undefined) {
    removeLocalRuntimeServiceLock(paths, 'instance', expected.instanceLock);
  }
  if (expected.lifecycleLock !== undefined) {
    removeLocalRuntimeServiceLock(paths, 'lifecycle', expected.lifecycleLock);
  }
}

/** Return undefined when another owner already holds the exact lock directory. */
export function tryAcquireLocalRuntimeServiceLock(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
  identity: unknown,
): LocalRuntimeServiceDirectoryLock | undefined {
  const root = assertStateRoot(paths);
  const value = encodeLockIdentityForState(identity, kind);
  const path = lockPath(paths, kind);
  let created = false;
  try {
    mkdirSync(path, { mode: POSIX_DIRECTORY_MODE });
    created = true;
    if (process.platform === 'win32') {
      try {
        secureWindowsStatePath(path, 'directory', { allowOwnerInitialization: true });
      } catch (error) {
        fail('permission', `${kind} lock could not be secured for the Windows owner.`, error);
      }
    }
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) {
      fail('io', `${kind} lock could not be acquired.`, error);
    }
    lockBusyOrInvalid(path, kind);
    return undefined;
  }

  let lockDirectoryIdentity: FileIdentity | undefined;
  try {
    const lockStat = lstatIfPresent(path);
    if (!lockStat) fail('io', `${kind} lock disappeared during acquisition.`);
    assertDirectoryStat(lockStat, `${kind} lock`, true, path);
    lockDirectoryIdentity = { dev: lockStat.dev, ino: lockStat.ino };
    publishLockIdentity(paths, kind, value);
    syncDirectory(root.path, 'Runtime service state root');
  } catch (error) {
    if (created) {
      try {
        const entries = readdirSync(path);
        if (entries.length === 0) rmdirSync(path);
      } catch {
        // Preserve evidence if the lock directory no longer belongs to this attempt.
      }
    }
    throw error;
  }

  let released = false;
  return Object.freeze({
    kind,
    path,
    identity: value,
    release(): void {
      if (released) return;
      const current = lstatIfPresent(path);
      if (!current) {
        released = true;
        return;
      }
      assertDirectoryStat(current, `${kind} lock`, true, path);
      if (!lockDirectoryIdentity || !sameIdentity(lockDirectoryIdentity, current)) {
        fail('corrupt', `${kind} lock is no longer owned by this handle.`);
      }
      const currentIdentity = readLockIdentityFile(paths, kind);
      if (!currentIdentity || currentIdentity.nonce !== value.nonce) {
        fail('corrupt', `${kind} lock identity is no longer owned by this handle.`);
      }
      const identityFile = lockIdentityPath(paths, kind);
      const identityStat = lstatIfPresent(identityFile);
      if (!identityStat) {
        fail('corrupt', `${kind} lock identity disappeared before release.`);
      }
      assertRegularFileStat(identityStat, `${kind} lock identity`, identityFile);
      unlinkSync(identityFile);
      syncDirectory(path, `${kind} lock`);
      try {
        rmdirSync(path);
      } catch (error) {
        fail('io', `${kind} lock could not be released.`, error);
      }
      syncDirectory(root.path, 'Runtime service state root');
      released = true;
    },
  });
}

export function acquireLocalRuntimeServiceLock(
  paths: LocalRuntimeServiceStatePaths,
  kind: LocalRuntimeServiceLockKind,
  identity: unknown,
): LocalRuntimeServiceDirectoryLock {
  const lock = tryAcquireLocalRuntimeServiceLock(paths, kind, identity);
  if (!lock) fail('busy', `${kind} lock is already held.`);
  return lock;
}

/** A synchronous filesystem implementation of the read-only port used by native callers. */
export function createLocalRuntimeServiceStatePort(identity: KiteHomeIdentity): {
  readonly paths: LocalRuntimeServiceStatePaths;
  readDescriptor(): Promise<LocalRuntimeServiceDescriptor | undefined>;
  readToken(kind: 'access' | 'control'): Promise<LocalRuntimeToken | undefined>;
} {
  const paths = resolveLocalRuntimeServiceStatePaths(identity);
  return Object.freeze({
    paths,
    readDescriptor: async () => readLocalRuntimeServiceDescriptor(paths),
    readToken: async (kind: 'access' | 'control') => readLocalRuntimeServiceToken(paths, kind),
  });
}
