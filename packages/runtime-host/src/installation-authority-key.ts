import { createHash, randomBytes } from 'node:crypto';
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
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { AuthorityKeyV1 } from './authority-boundary';

const RUNTIME_AUTHORITY_KEY_FILE_V1 = 'runtime-authority.key';
const RUNTIME_AUTHORITY_KEY_BYTES_V1 = 32;

export class RuntimeInstallationAuthorityKeyErrorV1 extends Error {
  readonly code: 'key_unavailable' | 'storage_boundary_violation';

  constructor(
    code: RuntimeInstallationAuthorityKeyErrorV1['code'],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeInstallationAuthorityKeyErrorV1';
    this.code = code;
  }
}

/** Host-owned installation custody for identity, persisted authority and child-frame derivation. */
export function loadOrCreateRuntimeInstallationAuthorityKeyV1(input: {
  readonly keyPath: string;
  readonly authorityEvidencePaths: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly secureWindowsPath?: (path: string) => void;
  readonly randomKey?: () => Uint8Array;
}): AuthorityKeyV1 & { readonly keyId: `sha256:${string}` } {
  const platform = input.platform ?? process.platform;
  const keyPath = resolve(input.keyPath);
  if (basename(keyPath) !== RUNTIME_AUTHORITY_KEY_FILE_V1) {
    throw new RuntimeInstallationAuthorityKeyErrorV1(
      'storage_boundary_violation',
      'Runtime installation authority key path is invalid.',
    );
  }
  if (platform === 'win32' && !input.secureWindowsPath) {
    throw new RuntimeInstallationAuthorityKeyErrorV1(
      'storage_boundary_violation',
      'Runtime installation authority requires a Windows owner-only ACL mechanism.',
    );
  }
  bindOwnerDirectoryV1(dirname(keyPath), platform, input.secureWindowsPath);
  let key: Uint8Array;
  if (existsSync(keyPath)) {
    key = readAuthorityKeyV1(keyPath, platform, input.secureWindowsPath);
  } else {
    if (input.authorityEvidencePaths.some((path) => existsSync(resolve(path)))) {
      throw new RuntimeInstallationAuthorityKeyErrorV1(
        'key_unavailable',
        'Runtime authority evidence exists but its installation key is unavailable.',
      );
    }
    const generated = Buffer.from(
      input.randomKey?.() ?? randomBytes(RUNTIME_AUTHORITY_KEY_BYTES_V1),
    );
    if (
      generated.byteLength !== RUNTIME_AUTHORITY_KEY_BYTES_V1 ||
      generated.every((byte) => byte === 0)
    ) {
      generated.fill(0);
      throw new RuntimeInstallationAuthorityKeyErrorV1(
        'key_unavailable',
        'Generated Runtime installation authority key is invalid.',
      );
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        keyPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)),
        0o600,
      );
      writeFileSync(descriptor, generated);
      fsyncSync(descriptor);
      if (platform === 'win32') input.secureWindowsPath!(keyPath);
      else chmodSync(keyPath, 0o600);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== generated.byteLength) {
        throw new RuntimeInstallationAuthorityKeyErrorV1(
          'storage_boundary_violation',
          'Runtime installation authority key publication is unsafe.',
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      generated.fill(0);
    }
    fsyncDirectoryV1(dirname(keyPath), platform);
    key = readAuthorityKeyV1(keyPath, platform, input.secureWindowsPath);
  }
  const keyId = `sha256:${createHash('sha256').update(key).digest('hex')}` as const;
  return Object.freeze({ keyId, key });
}

function readAuthorityKeyV1(
  path: string,
  platform: NodeJS.Platform,
  secureWindowsPath: ((path: string) => void) | undefined,
): Uint8Array {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      (platform !== 'win32' && process.getuid?.() !== undefined && before.uid !== process.getuid())
    ) {
      throw new RuntimeInstallationAuthorityKeyErrorV1(
        'storage_boundary_violation',
        'Runtime installation authority key file is unsafe.',
      );
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)),
    );
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new RuntimeInstallationAuthorityKeyErrorV1(
        'storage_boundary_violation',
        'Runtime installation authority key changed while opening.',
      );
    }
    const key = readFileSync(descriptor);
    if (key.byteLength !== RUNTIME_AUTHORITY_KEY_BYTES_V1 || key.every((byte) => byte === 0)) {
      key.fill(0);
      throw new RuntimeInstallationAuthorityKeyErrorV1(
        'key_unavailable',
        'Runtime installation authority key is corrupt.',
      );
    }
    if (platform === 'win32') secureWindowsPath!(path);
    else if ((before.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    return key;
  } catch (error) {
    if (error instanceof RuntimeInstallationAuthorityKeyErrorV1) throw error;
    throw new RuntimeInstallationAuthorityKeyErrorV1(
      'key_unavailable',
      'Runtime installation authority key could not be loaded.',
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function bindOwnerDirectoryV1(
  path: string,
  platform: NodeJS.Platform,
  secureWindowsPath: ((path: string) => void) | undefined,
): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync(path) !== resolve(path) ||
    (platform !== 'win32' && process.getuid?.() !== undefined && stat.uid !== process.getuid())
  ) {
    throw new RuntimeInstallationAuthorityKeyErrorV1(
      'storage_boundary_violation',
      'Runtime installation authority directory is unsafe.',
    );
  }
  if (platform === 'win32') secureWindowsPath!(path);
  else if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

function fsyncDirectoryV1(path: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
