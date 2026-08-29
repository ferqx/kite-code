import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  type CoordinatorProcessStatus,
  readCoordinatorProcessStartIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  ensurePrivateKiteHomeDirectory,
  type KiteHomeIdentity,
  secureWindowsStatePath,
  verifyWindowsStatePath,
} from '@kite-ai/kite-local-runtime/service';
import { z } from 'zod';
import type { WorkspaceWorkerConfirmedExitProof } from './process-manager';

export const WORKSPACE_OWNER_RESERVATION_SCHEMA_ = 'kite.workspace-owner-reservation.v1' as const;
export const WORKSPACE_OWNER_RESERVATION_NONCE_ENV = 'KITE_WORKER_OWNER_RESERVATION_NONCE' as const;
export const WORKSPACE_OWNER_COORDINATION_HOME_ENV = 'KITE_WORKER_COORDINATION_HOME' as const;
export const WORKSPACE_OWNER_RESERVATION_STATE_SEGMENTS = Object.freeze([
  'workspace-reservations',
  'v1',
] as const);

const MAX_RECORD_BYTES = 16 * 1024;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ownerDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const safeText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)));
const processStart = safeText.max(256);
const reservationNonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const reservationState = z.enum(['reserved', 'launching', 'claimed', 'worker_owned']);
const reservationRecordSchema = z
  .object({
    schema: z.literal(WORKSPACE_OWNER_RESERVATION_SCHEMA_),
    workerScopeId: safeText,
    workspaceDigest: ownerDigest,
    managerPid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    managerProcessStartIdentity: processStart,
    nonce: reservationNonce,
    state: reservationState,
    workerInstanceId: safeText.optional(),
    workerPid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    workerProcessStartIdentity: processStart.optional(),
  })
  .strict();

type ReservationRecord = z.infer<typeof reservationRecordSchema>;

export type WorkspaceReservationAcquireResult =
  | WorkspaceReservation
  | { readonly outcome: 'unknown' };

export interface WorkspaceReservation {
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  readonly coordinationHomeRoot: string;
  /** Raw nonce is intentionally available only to the explicit child environment builder. */
  readonly nonce: string;
  prepare(input: { readonly workerInstanceId: string }): Promise<void>;
  handoff(input?: {
    readonly workerInstanceId?: string;
    readonly workerPid?: number;
    readonly workerProcessStartIdentity?: string;
  }): Promise<void>;
  release(proof?: WorkspaceWorkerConfirmedExitProof): Promise<void>;
}

export interface WorkspaceReservationPort {
  acquire(input: {
    readonly workerScopeId: string;
    readonly workspace: KiteWorkspaceIdentity;
  }): Promise<WorkspaceReservationAcquireResult | undefined>;
  recover?(input: {
    readonly workerScopeId: string;
    readonly workspaceDigest: string;
    readonly workerInstanceId: string;
    readonly workerPid: number;
    readonly workerProcessStartIdentity: string;
  }): Promise<WorkspaceReservation | undefined>;
}

export interface WorkspaceReservationChildLease {
  release(): Promise<void>;
}

export interface WorkspaceReservationChildClaim {
  readonly coordinationHome: KiteHomeIdentity;
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  readonly workerInstanceId: string;
  readonly nonce: string;
  readonly workerPid: number;
  readonly workerProcessStartIdentity: string;
}

export interface WorkspaceReservationPortOptions {
  /** Explicit OS-user coordination root; never inferred from a Workspace Kite home. */
  readonly coordinationHome: KiteHomeIdentity;
  readonly processState?: (
    pid: number,
    processStartIdentity: string,
  ) => CoordinatorProcessStatus | Promise<CoordinatorProcessStatus>;
  readonly currentProcessIdentity?: () => string | undefined | Promise<string | undefined>;
  readonly currentProcessPid?: number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/**
 * Cross-Kite-home Workspace reservation owned by the Coordinator process. The reservation record
 * is the durable fence between spawn and child readiness; a `launching` record is deliberately
 * never replayed by a new Coordinator because the child outcome is unknown.
 */
export function createWorkspaceReservationPort(
  options: WorkspaceReservationPortOptions,
): WorkspaceReservationPort {
  const root = ensurePrivateKiteHomeDirectory(
    options.coordinationHome,
    WORKSPACE_OWNER_RESERVATION_STATE_SEGMENTS,
  );
  const processPid = options.currentProcessPid ?? process.pid;
  const processState =
    options.processState ??
    (async (pid: number, expected: string): Promise<CoordinatorProcessStatus> => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        return errorCode(error, 'ESRCH') ? 'dead' : 'uncertain';
      }
      const actual = await readCoordinatorProcessStartIdentity(pid, process.platform);
      return actual === expected ? 'alive' : 'uncertain';
    });
  const currentIdentity =
    options.currentProcessIdentity ??
    (() => readCoordinatorProcessStartIdentity(processPid, process.platform));
  const random = options.randomBytes ?? randomBytes;

  return Object.freeze({
    async acquire(input: {
      readonly workerScopeId: string;
      readonly workspace: KiteWorkspaceIdentity;
    }): Promise<WorkspaceReservationAcquireResult | undefined> {
      assertRequest(input.workerScopeId, input.workspace.workspaceDigest);
      const managerProcessStartIdentity = await currentIdentity();
      if (!managerProcessStartIdentity) {
        throw new Error('Workspace reservation manager process identity is unavailable.');
      }
      const nonceBytes = random(32);
      if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 32) {
        throw new TypeError('Workspace reservation nonce source is invalid.');
      }
      const nonce = Buffer.from(nonceBytes).toString('base64url');
      nonceBytes.fill(0);
      const path = reservationPath(root, input.workspace.workspaceDigest);
      const record: ReservationRecord = {
        schema: WORKSPACE_OWNER_RESERVATION_SCHEMA_,
        workerScopeId: input.workerScopeId,
        workspaceDigest: input.workspace.workspaceDigest,
        managerPid: processPid,
        managerProcessStartIdentity,
        nonce,
        state: 'reserved',
      };
      const created = createExclusive(path, record);
      if (created) {
        return reservationHandle(path, record, options.coordinationHome.root, processState);
      }

      const existing = readReservation(path);
      if (!existing) throw new Error('Workspace reservation is busy or unverifiable.');
      if (existing.workspaceDigest !== input.workspace.workspaceDigest) {
        throw new Error('Workspace reservation identity mismatches its filename.');
      }
      if (existing.state === 'launching') return { outcome: 'unknown' };
      if (existing.state === 'claimed' || existing.state === 'worker_owned') {
        if (
          existing.workerPid === undefined ||
          existing.workerProcessStartIdentity === undefined ||
          (await processState(existing.workerPid, existing.workerProcessStartIdentity)) !== 'dead'
        ) {
          return { outcome: 'unknown' };
        }
        const managerStatus = await processState(
          existing.managerPid,
          existing.managerProcessStartIdentity,
        );
        if (managerStatus !== 'dead') return undefined;
      } else {
        const managerStatus = await processState(
          existing.managerPid,
          existing.managerProcessStartIdentity,
        );
        if (managerStatus !== 'dead') return undefined;
      }
      removeExact(path, existing);
      if (!createExclusive(path, record)) {
        throw new Error('Workspace reservation changed during stale recovery.');
      }
      return reservationHandle(path, record, options.coordinationHome.root, processState);
    },

    async recover(input: {
      readonly workerScopeId: string;
      readonly workspaceDigest: string;
      readonly workerInstanceId: string;
      readonly workerPid: number;
      readonly workerProcessStartIdentity: string;
    }): Promise<WorkspaceReservation | undefined> {
      assertRequest(input.workerScopeId, input.workspaceDigest);
      assertSafeWorker(input.workerInstanceId);
      assertProcessIdentity(input.workerProcessStartIdentity);
      const path = reservationPath(root, input.workspaceDigest);
      const record = readReservation(path);
      if (
        !record ||
        record.workerScopeId !== input.workerScopeId ||
        record.state !== 'worker_owned' ||
        record.workerInstanceId !== input.workerInstanceId ||
        record.workerPid !== input.workerPid ||
        record.workerProcessStartIdentity !== input.workerProcessStartIdentity
      ) {
        return undefined;
      }
      return reservationHandle(path, record, options.coordinationHome.root, processState);
    },
  });
}

/** Called by the child before it opens Store 8. The nonce is never persisted outside this file. */
export function claimWorkspaceReservation(
  input: WorkspaceReservationChildClaim,
): WorkspaceReservationChildLease {
  assertRequest(input.workerScopeId, input.workspaceDigest);
  assertSafeWorker(input.workerInstanceId);
  assertProcessIdentity(input.workerProcessStartIdentity);
  reservationNonce.parse(input.nonce);
  const root = ensurePrivateKiteHomeDirectory(
    input.coordinationHome,
    WORKSPACE_OWNER_RESERVATION_STATE_SEGMENTS,
  );
  const path = reservationPath(root, input.workspaceDigest);
  const current = readReservation(path);
  if (!current) throw new Error('Workspace reservation child claim is not exact.');
  if (
    current.state !== 'launching' ||
    current.workerScopeId !== input.workerScopeId ||
    current.workerInstanceId !== input.workerInstanceId ||
    current.nonce !== input.nonce
  ) {
    throw new Error('Workspace reservation child claim is not exact.');
  }
  transition(path, current, {
    ...current,
    state: 'claimed',
    workerPid: input.workerPid,
    workerProcessStartIdentity: input.workerProcessStartIdentity,
  });
  let released = false;
  return Object.freeze({
    async release() {
      if (released) return;
      const currentRecord = readReservation(path);
      if (
        !currentRecord ||
        currentRecord.nonce !== input.nonce ||
        currentRecord.workerScopeId !== input.workerScopeId ||
        currentRecord.workerInstanceId !== input.workerInstanceId ||
        currentRecord.workerPid !== input.workerPid ||
        currentRecord.workerProcessStartIdentity !== input.workerProcessStartIdentity
      ) {
        throw new Error('Workspace reservation child ownership changed.');
      }
      removeExact(path, currentRecord);
      released = true;
    },
  });
}

function reservationHandle(
  path: string,
  original: ReservationRecord,
  coordinationHomeRoot: string,
  processState: (
    pid: number,
    processStartIdentity: string,
  ) => CoordinatorProcessStatus | Promise<CoordinatorProcessStatus>,
): WorkspaceReservation {
  let managerRecord = original;
  let released = false;
  return Object.freeze({
    workerScopeId: original.workerScopeId,
    workspaceDigest: original.workspaceDigest,
    // The child receives the shared coordination home, not this reservation subdirectory.
    // Both reservation claim and owner-lock code append their own fixed state segments.
    coordinationHomeRoot,
    nonce: original.nonce,
    async prepare(input: { readonly workerInstanceId: string }) {
      if (released) throw new Error('Workspace reservation is released.');
      assertSafeWorker(input.workerInstanceId);
      const current = assertOwned(path, managerRecord);
      if (current.state !== 'reserved') {
        throw new Error('Workspace reservation is not available for child launch.');
      }
      managerRecord = {
        ...current,
        state: 'launching',
        workerInstanceId: input.workerInstanceId,
      };
      transition(path, current, managerRecord);
    },
    async handoff(
      input: {
        readonly workerInstanceId?: string;
        readonly workerPid?: number;
        readonly workerProcessStartIdentity?: string;
      } = {},
    ) {
      if (released) throw new Error('Workspace reservation is released.');
      const current = assertOwned(path, managerRecord);
      if (current.state !== 'claimed' || current.workerInstanceId === undefined) {
        throw new Error('Workspace reservation child claim is unavailable.');
      }
      if (
        input.workerInstanceId !== undefined &&
        input.workerInstanceId !== current.workerInstanceId
      ) {
        throw new Error('Workspace reservation Worker identity mismatches readiness.');
      }
      if (
        input.workerPid !== undefined &&
        (current.workerPid !== input.workerPid ||
          current.workerProcessStartIdentity !== input.workerProcessStartIdentity)
      ) {
        throw new Error('Workspace reservation Worker process identity mismatches readiness.');
      }
      managerRecord = { ...current, state: 'worker_owned' };
      transition(path, current, managerRecord);
    },
    async release(proof?: WorkspaceWorkerConfirmedExitProof) {
      if (released) return;
      const exactExit = matchesConfirmedExit(managerRecord, proof);
      const current = readReservation(path);
      if (!current) {
        if (
          (managerRecord.state === 'claimed' || managerRecord.state === 'worker_owned') &&
          managerRecord.workerPid !== undefined &&
          managerRecord.workerProcessStartIdentity !== undefined &&
          (exactExit ||
            (await processState(
              managerRecord.workerPid,
              managerRecord.workerProcessStartIdentity,
            )) === 'dead')
        ) {
          released = true;
          return;
        }
        throw new Error('Workspace reservation ownership changed.');
      }
      if (
        current.nonce !== managerRecord.nonce ||
        current.workerScopeId !== managerRecord.workerScopeId ||
        current.workspaceDigest !== managerRecord.workspaceDigest
      ) {
        throw new Error('Workspace reservation ownership changed.');
      }
      if (current.state === 'claimed' || current.state === 'worker_owned') {
        if (
          current.workerPid === undefined ||
          current.workerProcessStartIdentity === undefined ||
          (!matchesConfirmedExit(current, proof) &&
            (await processState(current.workerPid, current.workerProcessStartIdentity)) !== 'dead')
        ) {
          throw new Error('Workspace reservation Worker identity is not confirmed dead.');
        }
      }
      removeExact(path, current);
      released = true;
    },
  });
}

function matchesConfirmedExit(
  record: ReservationRecord,
  proof: WorkspaceWorkerConfirmedExitProof | undefined,
): boolean {
  return (
    proof !== undefined &&
    (record.state === 'claimed' || record.state === 'worker_owned') &&
    record.workerInstanceId === proof.workerInstanceId &&
    record.workerPid === proof.workerPid &&
    record.workerProcessStartIdentity === proof.workerProcessStartIdentity
  );
}

function assertOwned(path: string, expected: ReservationRecord): ReservationRecord {
  const current = readReservation(path);
  if (
    !current ||
    current.nonce !== expected.nonce ||
    current.workerScopeId !== expected.workerScopeId ||
    current.workspaceDigest !== expected.workspaceDigest
  ) {
    throw new Error('Workspace reservation ownership changed.');
  }
  return current;
}

function reservationPath(root: string, digest: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(digest);
  if (!match?.[1]) throw new TypeError('Workspace reservation digest is invalid.');
  return join(root, `${match[1]}.json`);
}

function createExclusive(path: string, record: ReservationRecord): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error('Workspace reservation is oversized.');
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    assertFileStat(stat, path);
    secureCreatedWindowsEntry(path);
    syncParent(path);
    return true;
  } catch (error) {
    if (errorCode(error, 'EEXIST')) return false;
    try {
      if (fd !== undefined) {
        const stat = fstatSync(fd);
        const current = lstatSync(path);
        if (stat.dev === current.dev && stat.ino === current.ino) unlinkSync(path);
      }
    } catch {
      // Do not remove a replacement whose identity cannot be proven.
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readReservation(path: string): ReservationRecord | undefined {
  try {
    const stat = lstatSync(path);
    assertFileStat(stat, path);
    if (stat.size > MAX_RECORD_BYTES) return undefined;
    const parsed = reservationRecordSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function transition(path: string, before: ReservationRecord, after: ReservationRecord): void {
  const current = assertOwned(path, before);
  const beforeIdentity = currentFileIdentity(path);
  if (current.nonce !== after.nonce)
    throw new Error('Workspace reservation transition identity changed.');
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    const bytes = Buffer.from(`${JSON.stringify(after)}\n`, 'utf8');
    if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error('Workspace reservation is oversized.');
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedWindowsEntry(temporary);
    const currentIdentity = currentFileIdentity(path);
    if (beforeIdentity.dev !== currentIdentity.dev || beforeIdentity.ino !== currentIdentity.ino) {
      throw new Error('Workspace reservation changed before transition.');
    }
    renameSync(temporary, path);
    published = true;
    syncParent(path);
    assertFileStat(lstatSync(path), path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // Only the unique transition temporary is eligible for cleanup.
      }
    }
  }
}

function removeExact(path: string, expected: ReservationRecord): void {
  const before = currentFileIdentity(path);
  const current = readReservation(path);
  if (!current || current.nonce !== expected.nonce) {
    throw new Error('Workspace reservation changed during cleanup.');
  }
  const after = currentFileIdentity(path);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Workspace reservation was replaced during cleanup.');
  }
  unlinkSync(path);
  syncParent(path);
}

function currentFileIdentity(path: string): { readonly dev: number; readonly ino: number } {
  const stat = lstatSync(path);
  assertFileStat(stat, path);
  return { dev: stat.dev, ino: stat.ino };
}

function assertFileStat(stat: NonNullable<ReturnType<typeof lstatSync>>, path: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Workspace reservation file is not a private regular file: ${path}`);
  }
  if (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0) {
    throw new Error('Workspace reservation file is not owner-only.');
  }
  if (process.platform === 'win32') {
    verifyWindowsStatePath(path, 'file');
  }
}

function secureCreatedWindowsEntry(path: string): void {
  if (process.platform !== 'win32') return;
  secureWindowsStatePath(path, 'file', { allowOwnerInitialization: true });
}

function syncParent(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), constants.O_RDONLY | NO_FOLLOW);
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRequest(workerScopeId: string, workspaceDigest: string): void {
  assertSafeWorker(workerScopeId);
  ownerDigest.parse(workspaceDigest);
}

function assertSafeWorker(value: string): void {
  safeText.parse(value);
}

function assertProcessIdentity(value: string): void {
  processStart.parse(value);
}

function errorCode(error: unknown, expected: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}
