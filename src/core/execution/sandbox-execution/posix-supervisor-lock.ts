import { dlopen } from 'bun:ffi';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const LOCK_WAIT_MS = 2_000;

export interface PosixSupervisorLockIdentityV1 {
  readonly version: 1;
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
}

export interface PosixSupervisorLockHandleV1 {
  readonly fd: number;
  readonly path: string;
  close(): void;
}

export function posixSupervisorLockPathV1(runtimePath: string, dispatchId: string): string {
  const key = createHash('sha256').update(dispatchId).digest('hex').slice(0, 24);
  return join(runtimePath, `.dispatch-${key}.lock`);
}

/**
 * Acquire a pre-spawn lock whose open file description is inherited by the
 * supervisor. A restored Runtime can therefore prove the supervisor exited
 * even if its host died before the child published a PID/start identity.
 */
export function createPosixSupervisorLockV1(
  runtimePath: string,
  identity: Readonly<PosixSupervisorLockIdentityV1>,
): PosixSupervisorLockHandleV1 {
  const path = posixSupervisorLockPathV1(runtimePath, identity.dispatchId);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let closed = false;
  try {
    const bytes = Buffer.from(encodeIdentity(identity), 'utf8');
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    if (flock(fd, LOCK_EXCLUSIVE_NONBLOCKING) !== 0) {
      throw new Error('POSIX supervisor dispatch lock could not be acquired.');
    }
    return Object.freeze({
      fd,
      path,
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Verify fd 3 is the exact pre-spawn lock inherited by this supervisor. */
export function verifyInheritedPosixSupervisorLockV1(
  fd: number,
  runtimePath: string,
  expected: Readonly<PosixSupervisorLockIdentityV1>,
): boolean {
  try {
    const path = posixSupervisorLockPathV1(runtimePath, expected.dispatchId);
    const descriptor = fstatSync(fd);
    const target = lstatSync(path);
    return (
      target.isFile() &&
      !target.isSymbolicLink() &&
      target.nlink === 1 &&
      target.dev === descriptor.dev &&
      target.ino === descriptor.ino &&
      readExactIdentity(path, expected)
    );
  } catch {
    return false;
  }
}

/** True only once no process retains the inherited pre-spawn lock. */
export async function confirmPosixSupervisorLockReleasedV1(
  runtimePath: string,
  expected: Readonly<PosixSupervisorLockIdentityV1>,
): Promise<boolean> {
  const path = posixSupervisorLockPathV1(runtimePath, expected.dispatchId);
  if (!existsSync(path)) {
    // The lock is created before spawn. Absence proves dispatch did not reach spawn.
    return true;
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  do {
    let fd: number | undefined;
    try {
      const before = lstatSync(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (typeof before.uid === 'number' && before.uid !== process.getuid?.()) ||
        !readExactIdentity(path, expected)
      ) {
        return false;
      }
      fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino) return false;
      if (flock(fd, LOCK_EXCLUSIVE_NONBLOCKING) === 0) return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  return false;
}

function readExactIdentity(
  path: string,
  expected: Readonly<PosixSupervisorLockIdentityV1>,
): boolean {
  try {
    return readFileSync(path, 'utf8') === encodeIdentity(expected);
  } catch {
    return false;
  }
}

function encodeIdentity(identity: Readonly<PosixSupervisorLockIdentityV1>): string {
  if (
    identity.version !== 1 ||
    !identity.dispatchId ||
    !identity.supervisorNonce ||
    !identity.dispatchIntentDigest
  ) {
    throw new Error('POSIX supervisor dispatch lock identity is incomplete.');
  }
  return `${JSON.stringify({
    version: 1,
    dispatchId: identity.dispatchId,
    supervisorNonce: identity.supervisorNonce,
    dispatchIntentDigest: identity.dispatchIntentDigest,
  })}\n`;
}

let cachedFlock: ((fd: number, operation: number) => number) | undefined;

function flock(fd: number, operation: number): number {
  cachedFlock ??= dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      flock: {
        args: ['i32', 'i32'],
        returns: 'i32',
      },
    },
  ).symbols.flock;
  return cachedFlock(fd, operation);
}
