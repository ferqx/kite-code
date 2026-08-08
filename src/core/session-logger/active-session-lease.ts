import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  assertSecureOwnedRegularFile,
  assertSecureSessionLogDirectoryChainIdentity,
  captureSecureSessionLogDirectoryChain,
  type SecureSessionLogDirectoryBinding,
  type SecureSessionStorageOptions,
  writeSessionLogJsonAtomically,
} from './secure-storage';

export const SESSION_LOG_LEASE_FILE = '.active-session-lease.json';
export const SESSION_LOG_TERMINAL_FILE = 'terminal.json';
const OPERATION_LOCK_FILE = '.session-operation.lock';
export const SESSION_LOG_ADMISSION_LOCK_FILE = '.session-admission.lock';
export const SESSION_LOG_LEASE_RESERVE_BYTES = 512;
export const SESSION_LOG_OPERATION_RESERVE_BYTES = 256;

export interface SessionLogLeaseRecordV1 {
  version: 1;
  pid: number;
  processStartIdentity: string;
  ownerIdentity: string;
  sessionDirectoryIdentity: string;
  nonce: string;
  createdAt: string;
  heartbeatAt: string;
}

interface SessionLogOperationLockV1 {
  version: 1;
  pid: number;
  processStartIdentity: string;
  nonce: string;
  createdAt: string;
}

export type SessionLogLeaseInspection =
  | { status: 'absent' }
  | { status: 'active'; record: SessionLogLeaseRecordV1 }
  | { status: 'stale'; record: SessionLogLeaseRecordV1 }
  | { status: 'unknown'; reason: string };

export interface ActiveSessionLeaseOptions extends SecureSessionStorageOptions {
  now?: () => Date;
  processIdentity?: (pid: number) => string | undefined;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  onFailure?: () => void;
  directoryChain?: readonly string[];
}

export class ActiveSessionLease {
  private readonly leasePath: string;
  private readonly terminalPath: string;
  private readonly record: SessionLogLeaseRecordV1;
  private readonly options: ActiveSessionLeaseOptions;
  private readonly sessionDir: string;
  private readonly directoryBindings: readonly SecureSessionLogDirectoryBinding[];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private released = false;
  private failureReported = false;
  private releasePromise?: Promise<void>;

  private constructor(
    sessionDir: string,
    record: SessionLogLeaseRecordV1,
    directoryBindings: readonly SecureSessionLogDirectoryBinding[],
    options: ActiveSessionLeaseOptions,
  ) {
    this.sessionDir = sessionDir;
    this.record = record;
    this.directoryBindings = directoryBindings;
    this.options = options;
    this.leasePath = join(sessionDir, SESSION_LOG_LEASE_FILE);
    this.terminalPath = join(sessionDir, SESSION_LOG_TERMINAL_FILE);
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    if (heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.refresh(), heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  static acquire(sessionDir: string, options: ActiveSessionLeaseOptions = {}): ActiveSessionLease {
    const directoryChain = [...(options.directoryChain ?? []), sessionDir].filter(
      (path, index, paths) => paths.indexOf(path) === index,
    );
    const directoryBindings = captureSecureSessionLogDirectoryChain(directoryChain, options);
    assertSecureSessionLogDirectoryChainIdentity(directoryBindings, options);
    const releaseOperation = tryAcquireSessionOperation(sessionDir, options);
    if (!releaseOperation) throw new Error('Session-log lease operation is already in progress.');
    try {
      const inspection = inspectSessionLogLease(sessionDir, options);
      if (inspection.status === 'active' || inspection.status === 'unknown') {
        throw new Error('Session-log directory has an active or unverifiable writer lease.');
      }
      const leasePath = join(sessionDir, SESSION_LOG_LEASE_FILE);
      if (inspection.status === 'stale' && existsSync(leasePath)) unlinkSync(leasePath);
      const terminalPath = join(sessionDir, SESSION_LOG_TERMINAL_FILE);
      if (existsSync(terminalPath)) {
        assertSecureOwnedRegularFile(terminalPath, options);
        unlinkSync(terminalPath);
      }

      const now = (options.now ?? (() => new Date()))();
      const identity = (options.processIdentity ?? readProcessStartIdentity)(process.pid);
      if (!identity) throw new Error('Cannot establish the current process identity for logging.');
      const directoryIdentity = readDirectoryIdentity(sessionDir);
      if (!directoryIdentity)
        throw new Error('Cannot establish the session-log directory identity.');
      const record: SessionLogLeaseRecordV1 = {
        version: 1,
        pid: process.pid,
        processStartIdentity: identity,
        ownerIdentity: readOwnerIdentity(sessionDir),
        sessionDirectoryIdentity: directoryIdentity,
        nonce: randomUUID(),
        createdAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      };
      writeSessionLogJsonAtomically(leasePath, record, options);
      assertSecureSessionLogDirectoryChainIdentity(directoryBindings, options);
      return new ActiveSessionLease(sessionDir, record, directoryBindings, options);
    } finally {
      releaseOperation();
    }
  }

  async release(
    outcome: 'closed' | 'failed' | 'limited',
    runOutcome: 'completed' | 'aborted' | 'fatal' = 'completed',
  ): Promise<void> {
    if (this.released) return;
    if (this.releasePromise) return this.releasePromise;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.releasePromise = this.releaseWithBoundedRetry(outcome, runOutcome);
    return this.releasePromise;
  }

  storageBytes(): number {
    try {
      if (!this.sessionDirectoryStillBound()) {
        throw new Error('Session-log directory identity changed.');
      }
      const record = readLeaseRecord(this.leasePath);
      if (!record || record.nonce !== this.record.nonce) {
        throw new Error('Session-log lease identity changed.');
      }
      return lstatSync(this.leasePath).size;
    } catch {
      this.reportFailure();
      throw new Error('Cannot establish the active session-log lease size.');
    }
  }

  private refresh(): void {
    if (this.released) return;
    if (!this.sessionDirectoryStillBound()) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.reportFailure();
      return;
    }
    const releaseOperation = tryAcquireSessionOperation(this.sessionDir, this.options);
    if (!releaseOperation) return;
    try {
      if (!this.sessionDirectoryStillBound()) {
        throw new Error('Session-log directory identity changed.');
      }
      const current = readLeaseRecord(this.leasePath);
      if (!current || current.nonce !== this.record.nonce) {
        this.released = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        return;
      }
      const nextHeartbeat = (this.options.now ?? (() => new Date()))();
      const currentHeartbeatMs = Date.parse(current.heartbeatAt);
      if (
        !Number.isFinite(nextHeartbeat.getTime()) ||
        !Number.isFinite(currentHeartbeatMs) ||
        nextHeartbeat.getTime() < currentHeartbeatMs
      ) {
        throw new Error('Session-log lease heartbeat clock moved backwards.');
      }
      this.record.heartbeatAt = nextHeartbeat.toISOString();
      writeSessionLogJsonAtomically(this.leasePath, this.record, this.options);
    } catch {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.reportFailure();
    } finally {
      releaseOperation();
    }
  }

  private reportFailure(): void {
    if (this.failureReported) return;
    this.failureReported = true;
    try {
      this.options.onFailure?.();
    } catch {
      // Lease diagnostics are advisory and cannot escape into Runtime.
    }
  }

  private async releaseWithBoundedRetry(
    outcome: 'closed' | 'failed' | 'limited',
    runOutcome: 'completed' | 'aborted' | 'fatal',
  ): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!this.sessionDirectoryStillBound()) {
        this.reportFailure();
        this.released = true;
        return;
      }
      const releaseOperation = tryAcquireSessionOperation(this.sessionDir, this.options);
      if (!releaseOperation) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        if (!this.sessionDirectoryStillBound()) {
          throw new Error('Session-log directory identity changed.');
        }
        const current = readLeaseRecord(this.leasePath);
        if (!current || current.nonce !== this.record.nonce) {
          this.reportFailure();
          this.released = true;
          return;
        }
        const closedAt = (this.options.now ?? (() => new Date()))();
        const heartbeatMs = Date.parse(current.heartbeatAt);
        if (
          !Number.isFinite(closedAt.getTime()) ||
          !Number.isFinite(heartbeatMs) ||
          closedAt.getTime() < heartbeatMs
        ) {
          throw new Error('Session-log terminal clock moved backwards.');
        }
        writeSessionLogJsonAtomically(
          this.terminalPath,
          {
            version: 1,
            outcome,
            runOutcome,
            closedAt: closedAt.toISOString(),
          },
          this.options,
        );
        unlinkSync(this.leasePath);
        this.released = true;
        return;
      } catch {
        this.reportFailure();
      } finally {
        releaseOperation();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    this.reportFailure();
    this.released = true;
  }

  private sessionDirectoryStillBound(): boolean {
    try {
      assertSecureSessionLogDirectoryChainIdentity(this.directoryBindings, this.options);
      return (
        readDirectoryIdentity(this.sessionDir) === this.record.sessionDirectoryIdentity &&
        readOwnerIdentity(this.sessionDir) === this.record.ownerIdentity
      );
    } catch {
      return false;
    }
  }
}

export function inspectSessionLogLease(
  sessionDir: string,
  options: ActiveSessionLeaseOptions = {},
): SessionLogLeaseInspection {
  const leasePath = join(sessionDir, SESSION_LOG_LEASE_FILE);
  if (!existsSync(leasePath)) return { status: 'absent' };
  const record = readLeaseRecord(leasePath);
  if (!record) return { status: 'unknown', reason: 'malformed_lease' };
  if (record.ownerIdentity !== readOwnerIdentity(sessionDir)) {
    return { status: 'unknown', reason: 'lease_directory_identity_changed' };
  }
  // A persistent dev/inode pair can drift after a macOS volume remount or a
  // restore, even when the owner and the directory object are otherwise still
  // valid. Do not let that alone make an abandoned lease permanent; the
  // process-liveness checks below still protect live or unverifiable writers.
  const currentDirectoryIdentity = readDirectoryIdentity(sessionDir);
  if (!currentDirectoryIdentity) {
    return { status: 'unknown', reason: 'lease_directory_identity_changed' };
  }
  const directoryIdentityChanged = record.sessionDirectoryIdentity !== currentDirectoryIdentity;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const createdMs = Date.parse(record.createdAt);
  const heartbeatMs = Date.parse(record.heartbeatAt);
  if (
    !Number.isFinite(createdMs) ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs < createdMs ||
    nowMs < heartbeatMs
  ) {
    return { status: 'unknown', reason: 'lease_clock_unverifiable' };
  }
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const stale = nowMs - heartbeatMs > staleAfterMs;
  const identity = (options.processIdentity ?? readProcessStartIdentity)(record.pid);
  const processAlive = isProcessAlive(record.pid);
  if (directoryIdentityChanged && processAlive) {
    return { status: 'unknown', reason: 'lease_directory_identity_changed' };
  }
  if (identity === record.processStartIdentity) return { status: 'active', record };
  if (!stale) return { status: 'active', record };
  if (
    processAlive &&
    (identity === undefined ||
      !areProcessStartIdentitiesComparable(identity, record.processStartIdentity))
  ) {
    return { status: 'unknown', reason: 'process_identity_unavailable' };
  }
  return { status: 'stale', record };
}

function areProcessStartIdentitiesComparable(left: string, right: string): boolean {
  // A Darwin fallback identity is intentionally local-only. It keeps lease
  // acquisition available inside a hardened sandbox, but its time origin is
  // not guaranteed to match the seconds-resolution value reported by `ps`.
  // Exact equality is handled before this function; any other comparison that
  // involves a fallback must fail closed while the recorded PID is alive.
  return !left.startsWith('darwin:fallback:') && !right.startsWith('darwin:fallback:');
}

export function tryAcquireSessionOperation(
  sessionDir: string,
  options: ActiveSessionLeaseOptions = {},
): (() => void) | undefined {
  return tryAcquireStorageOperation(sessionDir, OPERATION_LOCK_FILE, options);
}

export function tryAcquireSessionLogAdmission(
  root: string,
  options: ActiveSessionLeaseOptions = {},
): (() => void) | undefined {
  return tryAcquireStorageOperation(root, SESSION_LOG_ADMISSION_LOCK_FILE, options);
}

export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat.slice(closeParen + 2).split(' ');
      const startTicks = fields[19];
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    // Establishing the current writer must not depend on spawning `ps`: a
    // hardened sandbox may deny process listing even though secure local file
    // writes are allowed. This fallback is deliberately tagged as
    // incomparable with a later `ps` observation; inspection fails closed for
    // a live PID instead of treating clock rounding as evidence of PID reuse.
    if (pid === process.pid && Number.isFinite(performance.timeOrigin)) {
      return `darwin:fallback:${pid}:${Math.floor(performance.timeOrigin)}`;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const started = result.status === 0 ? result.stdout.trim() : '';
    const startedAt = Date.parse(started);
    return Number.isFinite(startedAt) ? `darwin:ps:${Math.floor(startedAt / 1000)}` : undefined;
  }
  if (process.platform === 'win32') {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true },
    );
    const started = result.status === 0 ? result.stdout.trim() : '';
    return started ? `win32:${started}` : undefined;
  }
  return undefined;
}

function readLeaseRecord(path: string): SessionLogLeaseRecordV1 | undefined {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionLogLeaseRecordV1>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      typeof value.processStartIdentity !== 'string' ||
      typeof value.ownerIdentity !== 'string' ||
      typeof value.sessionDirectoryIdentity !== 'string' ||
      typeof value.nonce !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.heartbeatAt !== 'string'
    ) {
      return undefined;
    }
    return value as SessionLogLeaseRecordV1;
  } catch {
    return undefined;
  }
}

function tryAcquireStorageOperation(
  directory: string,
  filename: string,
  options: ActiveSessionLeaseOptions,
): (() => void) | undefined {
  const lockPath = join(directory, filename);
  const now = (options.now ?? (() => new Date()))();
  const processStartIdentity = (options.processIdentity ?? readProcessStartIdentity)(process.pid);
  if (!Number.isFinite(now.getTime()) || !processStartIdentity) return undefined;
  const record: SessionLogOperationLockV1 = {
    version: 1,
    pid: process.pid,
    processStartIdentity,
    nonce: randomUUID(),
    createdAt: now.toISOString(),
  };
  let fd: number | undefined;
  let createdIdentity: { dev: number; ino: number } | undefined;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    const opened = fstatSync(fd);
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertSecureOwnedRegularFile(lockPath, options);
    return () => {
      try {
        const current = readOperationLock(lockPath);
        const currentIdentity = lstatSync(lockPath);
        if (
          current?.nonce === record.nonce &&
          currentIdentity.dev === createdIdentity?.dev &&
          currentIdentity.ino === createdIdentity?.ino
        ) {
          unlinkSync(lockPath);
        }
      } catch {
        // A moved/deleted operation lock is already released.
      }
    };
  } catch {
    if (fd != null) closeSync(fd);
    if (createdIdentity) {
      try {
        const currentIdentity = lstatSync(lockPath);
        if (
          currentIdentity.dev === createdIdentity.dev &&
          currentIdentity.ino === createdIdentity.ino
        ) {
          unlinkSync(lockPath);
        }
      } catch {
        // A replaced/missing lock must not be removed by this contender.
      }
    }
    return undefined;
  }
}

function readOperationLock(path: string): SessionLogOperationLockV1 | undefined {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionLogOperationLockV1>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      typeof value.processStartIdentity !== 'string' ||
      typeof value.nonce !== 'string' ||
      typeof value.createdAt !== 'string'
    ) {
      return undefined;
    }
    return value as SessionLogOperationLockV1;
  } catch {
    return undefined;
  }
}

function readDirectoryIdentity(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    return `${info.dev}:${info.ino}`;
  } catch {
    return undefined;
  }
}

function readOwnerIdentity(path: string): string {
  if (process.platform === 'win32') {
    const account =
      process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
    return `win32:${account ?? 'unknown'}`;
  }
  return `uid:${lstatSync(path).uid}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
