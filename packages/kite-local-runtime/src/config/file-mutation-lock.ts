import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readLocalProcessStartIdentity } from './process-identity';

const CONFIG_MUTATION_LOCK_SCHEMA = 'kite.config-mutation-lock.v1' as const;
const MAX_LOCK_BYTES = 4 * 1024;
const DEFAULT_RETRY_COUNT = 20;
const DEFAULT_RETRY_MS = 25;

interface ConfigMutationLockRecord {
  readonly schema: typeof CONFIG_MUTATION_LOCK_SCHEMA;
  readonly targetDigest: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly nonce: string;
}

export type ConfigMutationProcessState = 'alive' | 'dead' | 'uncertain';

export interface ConfigFileMutationLock extends Disposable {
  release(): void;
}

/** Acquire several config owners in canonical path order to avoid cross-file deadlock. */
export function acquireConfigFileMutationLocks(
  targetPaths: readonly string[],
  options: ConfigFileMutationLockOptions = {},
): ConfigFileMutationLock {
  const targets = [...new Set(targetPaths.map((path) => resolve(path)))].sort();
  if (targets.length === 0) {
    throw new ConfigFileMutationLockError('identity_unavailable', 'Config lock targets are empty.');
  }
  const acquired: ConfigFileMutationLock[] = [];
  try {
    for (const target of targets) acquired.push(acquireConfigFileMutationLock(target, options));
  } catch (error) {
    releaseAll(acquired);
    throw error;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseAll(acquired);
  };
  return Object.freeze({ release, [Symbol.dispose]: release });
}

export interface ConfigFileMutationLockOptions {
  readonly processState?: (pid: number, startIdentity: string) => ConfigMutationProcessState;
  readonly currentProcessIdentity?: () => string | undefined;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly retryCount?: number;
  readonly retryMs?: number;
}

export class ConfigFileMutationLockError extends Error {
  readonly code: 'busy' | 'identity_unavailable' | 'corrupt' | 'io';

  constructor(code: ConfigFileMutationLockError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigFileMutationLockError';
    this.code = code;
  }
}

/** Exclusive per-file writer lock. Only a positively dead exact owner may be reclaimed. */
export function acquireConfigFileMutationLock(
  targetPath: string,
  options: ConfigFileMutationLockOptions = {},
): ConfigFileMutationLock {
  const target = resolve(targetPath);
  const path = `${target}.kite-lock`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const currentProcessIdentity =
    options.currentProcessIdentity?.() ?? readLocalProcessStartIdentity(process.pid);
  if (!currentProcessIdentity) {
    throw new ConfigFileMutationLockError(
      'identity_unavailable',
      'Config mutation process identity is unavailable.',
    );
  }
  const nonceBytes = (options.randomBytes ?? randomBytes)(24);
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 24) {
    throw new ConfigFileMutationLockError('identity_unavailable', 'Config lock nonce is invalid.');
  }
  const nonce = Buffer.from(nonceBytes).toString('base64url');
  nonceBytes.fill(0);
  const record: ConfigMutationLockRecord = {
    schema: CONFIG_MUTATION_LOCK_SCHEMA,
    targetDigest: targetDigest(target),
    pid: process.pid,
    processStartIdentity: currentProcessIdentity,
    nonce,
  };
  const processState = options.processState ?? inspectProcess;
  const retryCount = boundedOption(options.retryCount, DEFAULT_RETRY_COUNT, 1, 100);
  const retryMs = boundedOption(options.retryMs, DEFAULT_RETRY_MS, 0, 1_000);
  let reclaimed = false;
  for (let attempt = 0; attempt < retryCount; attempt++) {
    const acquired = acquireExact(path, record);
    if (acquired) return lockHandle(path, record, acquired);

    const existing = readRecord(path, record.targetDigest);
    if (!existing) {
      throw new ConfigFileMutationLockError(
        'corrupt',
        'Config mutation lock is malformed or insecure.',
      );
    }
    if (!reclaimed && processState(existing.pid, existing.processStartIdentity) === 'dead') {
      removeExact(path, existing);
      reclaimed = true;
      continue;
    }
    if (attempt + 1 < retryCount && retryMs > 0) Bun.sleepSync(retryMs);
  }
  throw new ConfigFileMutationLockError('busy', 'Config mutation is already in progress.');
}

function lockHandle(
  path: string,
  record: ConfigMutationLockRecord,
  identity: Readonly<{ dev: number; ino: number }>,
): ConfigFileMutationLock {
  let released = false;
  const release = (): void => {
    if (released) return;
    const current = lstatSync(path);
    const currentRecord = readRecord(path, record.targetDigest);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      currentRecord?.nonce !== record.nonce
    ) {
      throw new ConfigFileMutationLockError(
        'corrupt',
        'Config mutation lock is no longer owned by this process.',
      );
    }
    unlinkSync(path);
    released = true;
    syncParent(path);
  };
  return Object.freeze({
    release,
    [Symbol.dispose]: release,
  });
}

function releaseAll(locks: readonly ConfigFileMutationLock[]): void {
  let firstError: unknown;
  for (const lock of [...locks].reverse()) {
    try {
      lock.release();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function acquireExact(
  path: string,
  record: ConfigMutationLockRecord,
): Readonly<{ dev: number; ino: number }> | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const bytes = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(bytes) > MAX_LOCK_BYTES) {
      throw new ConfigFileMutationLockError('io', 'Config mutation lock exceeds its size bound.');
    }
    writeFileSync(descriptor, bytes, 'utf8');
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new ConfigFileMutationLockError('io', 'Config mutation lock is not owner-only.');
    }
    syncParent(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (isCode(error, 'EEXIST')) return undefined;
    if (descriptor !== undefined) {
      try {
        const opened = fstatSync(descriptor);
        const current = lstatSync(path);
        if (opened.dev === current.dev && opened.ino === current.ino) unlinkSync(path);
      } catch {
        // Preserve state whose ownership cannot be proven.
      }
    }
    if (error instanceof ConfigFileMutationLockError) throw error;
    throw new ConfigFileMutationLockError('io', 'Config mutation lock could not be created.', {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRecord(
  path: string,
  expectedTargetDigest: string,
): ConfigMutationLockRecord | undefined {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_LOCK_BYTES ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      return undefined;
    }
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConfigMutationLockRecord>;
    if (
      value.schema !== CONFIG_MUTATION_LOCK_SCHEMA ||
      value.targetDigest !== expectedTargetDigest ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      !safeIdentity(value.processStartIdentity) ||
      !/^[A-Za-z0-9_-]{32}$/u.test(value.nonce ?? '')
    ) {
      return undefined;
    }
    return value as ConfigMutationLockRecord;
  } catch {
    return undefined;
  }
}

function removeExact(path: string, expected: ConfigMutationLockRecord): void {
  const before = lstatSync(path);
  const current = readRecord(path, expected.targetDigest);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    current?.nonce !== expected.nonce ||
    current.processStartIdentity !== expected.processStartIdentity
  ) {
    throw new ConfigFileMutationLockError('corrupt', 'Stale config lock identity changed.');
  }
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new ConfigFileMutationLockError('corrupt', 'Stale config lock file changed.');
  }
  unlinkSync(path);
  syncParent(path);
}

function inspectProcess(pid: number, expectedStart: string): ConfigMutationProcessState {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isCode(error, 'ESRCH') ? 'dead' : 'uncertain';
  }
  const actual = readLocalProcessStartIdentity(pid);
  return actual === expectedStart ? 'alive' : 'uncertain';
}

function targetDigest(path: string): string {
  return createHash('sha256').update('kite-config-mutation-target-v1\0').update(path).digest('hex');
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigFileMutationLockError('identity_unavailable', 'Config lock option is invalid.');
  }
  return value;
}

function safeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function syncParent(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32') {
      throw new ConfigFileMutationLockError('io', 'Config lock directory could not be synced.', {
        cause: error,
      });
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
