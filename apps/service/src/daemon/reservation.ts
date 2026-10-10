import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { inspectProcess } from './process-identity';
import { windowsPipeExists } from './windows-pipe';
import { readWindowsDaemonRecord, removeWindowsDaemonRecord } from './windows-record';

export type DaemonErrorCode =
  | 'daemon_absent'
  | 'daemon_bind_failed'
  | 'daemon_bootstrap_timeout'
  | 'daemon_endpoint_busy'
  | 'daemon_endpoint_drift'
  | 'daemon_endpoint_state'
  | 'daemon_endpoint_close_unknown'
  | 'daemon_endpoint_unsafe'
  | 'daemon_identity_mismatch'
  | 'daemon_identity_unavailable'
  | 'daemon_identity_unknown'
  | 'daemon_invalid_bootstrap'
  | 'daemon_invalid_endpoint'
  | 'daemon_invalid_selection'
  | 'daemon_invalid_workspace'
  | 'daemon_not_ready'
  | 'daemon_platform_unsupported'
  | 'daemon_reservation_invalid'
  | 'daemon_reservation_oversized'
  | 'daemon_reservation_unsafe'
  | 'daemon_reservation_write_failed'
  | 'daemon_unavailable';
export function daemonError(code: DaemonErrorCode) {
  return Object.assign(new Error(code), { code });
}
/** Trusted native cleanup marker; the cause retains owners and is never serialized. */
export class DaemonEndpointCleanupError extends Error {
  readonly code = 'daemon_endpoint_close_unknown';
  readonly phase = 'daemon_endpoint';
  constructor(error: unknown, resources?: unknown) {
    super('daemon_endpoint_close_unknown', { cause: { error, resources } });
  }
}
export function endpointCleanupUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error instanceof DaemonEndpointCleanupError ||
    [
      'daemon_endpoint_close_unknown',
      'daemon_record_close_unknown',
      'daemon_record_unlock_unknown',
      'daemon_security_close_unknown',
      'windows_process_close_unknown',
    ].includes(error.message)
  )
    return true;
  return error instanceof AggregateError && error.errors.some(endpointCleanupUnknown);
}
export const windowsPipePattern = /^\\\\\.\\pipe\\kite-daemon-[a-z0-9-]+$/;
export const profileSchema = z.strictObject({
  dataRoot: z.string().min(1).max(4096).refine(isAbsolute),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  accessKey: z.string().regex(/^[a-f0-9]{64}$/),
});
const label = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !/\p{Cc}/u.test(v));
export const reservationSchema = z.strictObject({
  reservationVersion: z.literal(1),
  profile: profileSchema,
  pid: z.number().int().positive().max(2147483647),
  processStartIdentity: label,
  instanceId: label,
  buildId: label,
  workspace: z.string().min(1).max(4096).refine(isAbsolute),
  socket: z
    .strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
    .optional(),
  pipe: z.string().max(256).regex(windowsPipePattern).optional(),
});
export type DaemonProfile = z.infer<typeof profileSchema>;
export type DaemonReservation = z.infer<typeof reservationSchema>;
export interface DaemonEndpoint {
  readonly root: string;
  readonly socket: string;
  readonly record: string;
  readonly profileAccessKey: string;
  readonly transport?: 'windows-pipe';
  readonly defaultParent?: string;
  readonly privateParents?: readonly string[];
}
export function assertPrivateDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw daemonError('daemon_endpoint_unsafe');
}
export function sameRecord(a: DaemonReservation, b: DaemonReservation) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function fileIdentity(path: string) {
  const s = lstatSync(path, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino) };
}
export function sameIdentity(a: { dev: string; ino: string }, b: { dev: string; ino: string }) {
  return a.dev === b.dev && a.ino === b.ino;
}
export function readReservationDetails(endpoint: DaemonEndpoint) {
  if (endpoint.transport === 'windows-pipe') {
    try {
      const native = readWindowsDaemonRecord(endpoint.record);
      if (!native) {
        if (windowsPipeExists(endpoint.socket)) throw daemonError('daemon_identity_unknown');
        return;
      }
      const record = reservationSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(native.bytes)),
      );
      if (
        record.profile.accessKey !== endpoint.profileAccessKey ||
        record.socket ||
        (record.pipe !== undefined && record.pipe !== endpoint.socket)
      )
        throw daemonError('daemon_identity_mismatch');
      return { record, identity: native.identity };
    } catch (error) {
      if (endpointCleanupUnknown(error)) throw new DaemonEndpointCleanupError(error);
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
        throw daemonError('daemon_reservation_invalid');
      if (
        typeof (error as { code?: unknown }).code === 'string' &&
        String((error as { code: string }).code).startsWith('daemon_')
      )
        throw error;
      throw daemonError('daemon_reservation_unsafe');
    }
  }
  try {
    assertPrivateDirectory(endpoint.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if ((error as { code?: unknown }).code === 'daemon_endpoint_unsafe') throw error;
    throw daemonError('daemon_endpoint_unsafe');
  }
  let fd: number | undefined;
  try {
    fd = openSync(endpoint.record, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size < 1n ||
      stat.size > 16384n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o077n) !== 0n
    )
      throw daemonError('daemon_reservation_unsafe');
    const record = reservationSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    if (record.pipe !== undefined) throw daemonError('daemon_reservation_invalid');
    if (record.profile.accessKey !== endpoint.profileAccessKey)
      throw daemonError('daemon_identity_mismatch');
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    if (!sameIdentity(identity, fileIdentity(endpoint.record)))
      throw daemonError('daemon_endpoint_drift');
    return { record, identity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        lstatSync(endpoint.socket);
      } catch (socketError) {
        if ((socketError as NodeJS.ErrnoException).code === 'ENOENT') return;
      }
      throw daemonError('daemon_identity_unknown');
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw daemonError('daemon_reservation_invalid');
    if (
      typeof (error as { code?: unknown }).code === 'string' &&
      String((error as { code: string }).code).startsWith('daemon_')
    )
      throw error;
    throw daemonError('daemon_reservation_unsafe');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function readDaemonReservation(endpoint: DaemonEndpoint) {
  return readReservationDetails(endpoint)?.record;
}
export function removeExactEndpoint(
  endpoint: DaemonEndpoint,
  expected: DaemonReservation,
  recordIdentity: { dev: string; ino: string },
) {
  let current: ReturnType<typeof readReservationDetails>;
  try {
    current = readReservationDetails(endpoint);
  } catch (error) {
    if (endpointCleanupUnknown(error)) throw error;
    throw daemonError('daemon_endpoint_drift');
  }
  if (
    !current ||
    !sameRecord(current.record, expected) ||
    !sameIdentity(current.identity, recordIdentity)
  )
    throw daemonError('daemon_endpoint_drift');
  if (endpoint.transport === 'windows-pipe') {
    // A dead record never grants authority over an existing pipe, including a foreign replacement.
    if (windowsPipeExists(endpoint.socket)) throw daemonError('daemon_endpoint_drift');
    try {
      removeWindowsDaemonRecord(
        endpoint.record,
        Buffer.from(`${JSON.stringify(expected)}\n`),
        recordIdentity,
      );
    } catch (error) {
      if (endpointCleanupUnknown(error)) throw new DaemonEndpointCleanupError(error);
      throw error;
    }
    return;
  }
  if (expected.socket) {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(endpoint.socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (stat) {
      if (
        !stat.isSocket() ||
        stat.isSymbolicLink() ||
        !sameIdentity(fileIdentity(endpoint.socket), expected.socket)
      )
        throw daemonError('daemon_endpoint_drift');
      unlinkSync(endpoint.socket);
    }
  } else {
    try {
      lstatSync(endpoint.socket);
      throw daemonError('daemon_endpoint_drift');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const again = readReservationDetails(endpoint);
  if (
    !again ||
    !sameRecord(again.record, expected) ||
    !sameIdentity(again.identity, recordIdentity)
  )
    throw daemonError('daemon_endpoint_drift');
  unlinkSync(endpoint.record);
}
/** Explicit dead cleanup only; never used by ordinary start. */
export function clearDeadDaemonEndpoint(endpoint: DaemonEndpoint, expected: DaemonReservation) {
  const parsed = reservationSchema.safeParse(structuredClone(expected));
  if (!parsed.success) throw daemonError('daemon_reservation_invalid');
  const fixed = parsed.data;
  const current = readReservationDetails(endpoint);
  if (!current) return { outcome: 'absent' as const };
  if (!sameRecord(current.record, fixed))
    return { outcome: 'blocked' as const, reason: 'drift' as const };
  const state = inspectProcess(fixed.pid, fixed.processStartIdentity);
  if (state !== 'dead') return { outcome: 'blocked' as const, reason: state };
  try {
    removeExactEndpoint(endpoint, fixed, current.identity);
    return { outcome: 'cleared' as const };
  } catch (error) {
    if ((error as Error).message === 'daemon_endpoint_drift')
      return { outcome: 'blocked' as const, reason: 'drift' as const };
    throw error;
  }
}
