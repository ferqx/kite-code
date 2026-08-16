import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { userKiteCodeDir } from '@/core/config/paths';
import { secureWindowsOwnerOnlyPath } from '@/core/session-logger/secure-storage';
import { modelArtifactRoot } from './model-artifact-paths';

const KEY_BYTES = 32;
const KEY_FILE_NAME = 'model-artifacts.key';

export class ModelArtifactIntegrityKeyError extends Error {
  readonly code: 'key_unavailable' | 'storage_boundary_violation';

  constructor(
    code: 'key_unavailable' | 'storage_boundary_violation',
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'ModelArtifactIntegrityKeyError';
    this.code = code;
  }
}

export interface ModelArtifactIntegrityKeyOptionsV1 {
  keyPath?: string;
  artifactRoot?: string;
  /** Other private evidence namespaces governed by the same installation key. */
  additionalArtifactRoots?: readonly string[];
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  randomKey?: () => Uint8Array;
}

/**
 * Load the installation-level Model Artifact key, creating it only when no
 * prior evidence namespace exists. Missing/corrupt historical key material is
 * never replaced with a new identity.
 */
export function loadOrCreateModelArtifactIntegrityKeyV1(
  options: ModelArtifactIntegrityKeyOptionsV1 = {},
): Uint8Array {
  const platform = options.platform ?? process.platform;
  const secureWindowsPath = options.secureWindowsPath ?? secureWindowsOwnerOnlyPath;
  const keyPath = resolve(options.keyPath ?? join(userKiteCodeDir(), KEY_FILE_NAME));
  const artifactPaths = [
    resolve(options.artifactRoot ?? modelArtifactRoot()),
    ...(options.additionalArtifactRoots ?? []).map((path) => resolve(path)),
  ];
  if (
    basename(keyPath) !== KEY_FILE_NAME ||
    artifactPaths.some((artifactPath) => dirname(keyPath) !== dirname(artifactPath))
  ) {
    throw keyError(
      'storage_boundary_violation',
      'Model Artifact key path is outside its namespace.',
    );
  }
  bindOwnerOnlyDirectory(dirname(keyPath), platform, secureWindowsPath);
  if (existsSync(keyPath)) return readExistingKey(keyPath, platform, secureWindowsPath);
  if (artifactPaths.some(artifactNamespaceExists)) {
    throw keyError(
      'key_unavailable',
      'Model Artifact evidence exists but its installation integrity key is unavailable.',
    );
  }

  const generated = Buffer.from(options.randomKey?.() ?? randomBytes(KEY_BYTES));
  if (generated.byteLength !== KEY_BYTES) {
    throw keyError('key_unavailable', 'Generated Model Artifact integrity key has invalid length.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      keyPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(platform),
      0o600,
    );
    const opened = fstatSync(descriptor);
    assertPrivateKeyFile(opened, platform);
    writeFileSync(descriptor, generated);
    fsyncSync(descriptor);
    if (platform === 'win32') secureWindowsPath(keyPath);
    else chmodSync(keyPath, 0o600);
    const written = fstatSync(descriptor);
    if (written.dev !== opened.dev || written.ino !== opened.ino || written.size !== KEY_BYTES) {
      throw keyError('storage_boundary_violation', 'Model Artifact key changed while publishing.');
    }
  } catch (error) {
    if (isFileSystemError(error, 'EEXIST')) {
      return readExistingKey(keyPath, platform, secureWindowsPath);
    }
    if (error instanceof ModelArtifactIntegrityKeyError) throw error;
    throw keyError('key_unavailable', 'Model Artifact integrity key could not be created.', error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(dirname(keyPath), platform);
  return readExistingKey(keyPath, platform, secureWindowsPath);
}

function readExistingKey(
  path: string,
  platform: NodeJS.Platform,
  secureWindowsPath: (path: string) => void,
): Uint8Array {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    assertPrivateKeyFile(before, platform);
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag(platform));
    const opened = fstatSync(descriptor);
    assertPrivateKeyFile(opened, platform);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw keyError('storage_boundary_violation', 'Model Artifact key changed while opening.');
    }
    const key = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || key.byteLength !== KEY_BYTES) {
      throw keyError('key_unavailable', 'Model Artifact integrity key is corrupt.');
    }
    if (platform === 'win32') secureWindowsPath(path);
    return key;
  } catch (error) {
    if (error instanceof ModelArtifactIntegrityKeyError) throw error;
    throw keyError('key_unavailable', 'Model Artifact integrity key could not be loaded.', error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function bindOwnerOnlyDirectory(
  path: string,
  platform: NodeJS.Platform,
  secureWindowsPath: (path: string) => void,
): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw keyError('storage_boundary_violation', 'Model Artifact key directory is unsafe.');
  }
  assertCurrentOwner(before.uid, platform);
  if (realpathSync(path) !== resolve(path)) {
    throw keyError('storage_boundary_violation', 'Model Artifact key directory is not canonical.');
  }
  if (platform === 'win32') secureWindowsPath(path);
  else if ((before.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (platform !== 'win32' && (after.mode & 0o777) !== 0o700) ||
    realpathSync(path) !== resolve(path)
  ) {
    throw keyError(
      'storage_boundary_violation',
      'Model Artifact key directory changed while securing it.',
    );
  }
  assertCurrentOwner(after.uid, platform);
}

function artifactNamespaceExists(path: string): boolean {
  if (!existsSync(path)) return false;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw keyError('storage_boundary_violation', 'Model Artifact namespace is unsafe.');
  }
  return readdirSync(path).length > 0;
}

function assertPrivateKeyFile(stats: Stats, platform: NodeJS.Platform): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.size > KEY_BYTES) {
    throw keyError('storage_boundary_violation', 'Model Artifact integrity key file is unsafe.');
  }
  assertCurrentOwner(stats.uid, platform);
  if (platform !== 'win32' && (stats.mode & 0o777) !== 0o600) {
    throw keyError('storage_boundary_violation', 'Model Artifact integrity key is not owner-only.');
  }
}

function assertCurrentOwner(uid: number, platform: NodeJS.Platform): void {
  if (platform !== 'win32' && typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw keyError('storage_boundary_violation', 'Model Artifact integrity key has another owner.');
  }
}

function fsyncDirectory(path: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag(platform));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function noFollowFlag(platform: NodeJS.Platform): number {
  return platform === 'win32' ? 0 : ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code,
  );
}

function keyError(
  code: ModelArtifactIntegrityKeyError['code'],
  message: string,
  cause?: unknown,
): ModelArtifactIntegrityKeyError {
  return new ModelArtifactIntegrityKeyError(code, message, cause === undefined ? {} : { cause });
}
