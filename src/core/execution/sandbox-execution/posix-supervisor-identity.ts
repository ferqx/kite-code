import { dlopen, type Pointer } from 'bun:ffi';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface PosixSupervisorIdentityV1 {
  readonly version: 1;
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly processStartIdentity: string;
}

export function posixSupervisorIdentityPathV1(runtimePath: string, dispatchId: string): string {
  assertDispatchId(dispatchId);
  return join(runtimePath, `.supervisor-${dispatchId}.json`);
}

/** Comparable across processes; Darwin deliberately never uses the local timeOrigin fallback. */
export function readComparablePosixProcessStartIdentityV1(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat.slice(closeParen + 2).split(' ');
      const startTicks = fields[19];
      const processGroupId = fields[2];
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const executablePath = readlinkSync(`/proc/${pid}/exe`);
      const executableDigest = createHash('sha256')
        .update(executablePath)
        .digest('hex')
        .slice(0, 32);
      return startTicks && processGroupId && bootId
        ? `linux:${bootId}:${startTicks}:${processGroupId}:${executableDigest}`
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const api = darwinProcessApi();
      const info = Buffer.alloc(136);
      const read = api.proc_pidinfo(pid, 3, 0, info, info.byteLength);
      if (read !== info.byteLength || info.readUInt32LE(12) !== pid) return undefined;
      const processGroupId = info.readUInt32LE(100);
      const startSeconds = info.readBigUInt64LE(120);
      const startMicroseconds = info.readBigUInt64LE(128);
      const path = Buffer.alloc(4096);
      const pathLength = api.proc_pidpath(pid, path, path.byteLength);
      if (
        processGroupId < 1 ||
        startSeconds < 1n ||
        startMicroseconds >= 1_000_000n ||
        pathLength < 1
      ) {
        return undefined;
      }
      const executablePath = path.subarray(0, pathLength).toString('utf8').replace(/\0+$/, '');
      if (!executablePath) return undefined;
      const executableDigest = createHash('sha256')
        .update(executablePath)
        .digest('hex')
        .slice(0, 32);
      return `darwin:proc_bsdinfo:${startSeconds}:${startMicroseconds}:${processGroupId}:${executableDigest}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function posixProcessIdentityBindsGroupV1(
  identity: string,
  processGroupId: number,
): boolean {
  if (identity.startsWith('linux:')) {
    const parts = identity.split(':');
    return parts.length === 5 && parts[3] === String(processGroupId);
  }
  if (identity.startsWith('darwin:proc_bsdinfo:')) {
    const parts = identity.split(':');
    return parts.length === 6 && parts[4] === String(processGroupId);
  }
  return false;
}

type DarwinProcessApi = {
  proc_pidinfo(
    pid: number,
    flavor: number,
    arg: number,
    buffer: Pointer | Uint8Array,
    bufferSize: number,
  ): number;
  proc_pidpath(pid: number, buffer: Pointer | Uint8Array, bufferSize: number): number;
};

let cachedDarwinProcessApi: DarwinProcessApi | undefined;

function darwinProcessApi(): DarwinProcessApi {
  if (!cachedDarwinProcessApi) {
    cachedDarwinProcessApi = dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: {
        args: ['i32', 'i32', 'u64', 'ptr', 'i32'],
        returns: 'i32',
      },
      proc_pidpath: {
        args: ['i32', 'ptr', 'u32'],
        returns: 'i32',
      },
    }).symbols as unknown as DarwinProcessApi;
  }
  return cachedDarwinProcessApi;
}

export function writePosixSupervisorIdentityV1(
  path: string,
  identity: PosixSupervisorIdentityV1,
): void {
  validate(identity);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(identity)}\n`, 'utf8');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const descriptor = fstatSync(fd);
    const target = lstatSync(path);
    if (
      !target.isFile() ||
      target.isSymbolicLink() ||
      target.nlink !== 1 ||
      target.dev !== descriptor.dev ||
      target.ino !== descriptor.ino
    ) {
      throw new Error('POSIX supervisor identity publication raced its path identity.');
    }
  } finally {
    closeSync(fd);
  }
}

export function readPosixSupervisorIdentityV1(path: string): PosixSupervisorIdentityV1 | undefined {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return undefined;
    if (typeof metadata.uid === 'number' && metadata.uid !== process.getuid?.()) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !==
      'dispatchId,dispatchIntentDigest,pid,processGroupId,processStartIdentity,supervisorNonce,version'
    ) {
      return undefined;
    }
    validate(value);
    return Object.freeze(value as unknown as PosixSupervisorIdentityV1);
  } catch {
    return undefined;
  }
}

function validate(value: Record<string, unknown> | PosixSupervisorIdentityV1): void {
  if (
    value.version !== 1 ||
    typeof value.dispatchId !== 'string' ||
    typeof value.supervisorNonce !== 'string' ||
    typeof value.dispatchIntentDigest !== 'string' ||
    typeof value.processStartIdentity !== 'string' ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    value.processGroupId !== value.pid
  ) {
    throw new Error('POSIX supervisor identity is malformed.');
  }
  if (!posixProcessIdentityBindsGroupV1(value.processStartIdentity, Number(value.processGroupId))) {
    throw new Error('POSIX supervisor identity does not bind its process group.');
  }
  assertDispatchId(value.dispatchId);
  if (!value.supervisorNonce || !value.dispatchIntentDigest || !value.processStartIdentity) {
    throw new Error('POSIX supervisor identity is incomplete.');
  }
}

function assertDispatchId(dispatchId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(dispatchId)) {
    throw new Error('POSIX supervisor dispatch identity is invalid.');
  }
}
