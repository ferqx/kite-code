import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { z } from 'zod';
import {
  type DaemonEndpoint,
  type DaemonProfile,
  type DaemonReservation,
  daemonError,
  endpointCleanupUnknown,
  profileSchema,
  readDaemonReservation,
  sameRecord,
} from './reservation';
import { requestWindowsDaemonPipe } from './windows-pipe';

export const bootstrapMaxBytes = 16384;
const origin = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === 'http:' &&
        u.hostname === '127.0.0.1' &&
        u.pathname === '/' &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password &&
        Boolean(u.port)
      );
    } catch {
      return false;
    }
  });
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const bootstrapRequestSchema = z.strictObject({
  requestVersion: z.literal(1),
  requestId,
  operation: z.literal('bootstrap'),
});
export const bootstrapSchema = z.strictObject({
  requestVersion: z.literal(1),
  requestId,
  operation: z.literal('bootstrap'),
  profile: profileSchema,
  instanceId: z.string().min(1).max(512),
  buildId: z.string().min(1).max(512),
  httpEndpoint: origin,
  token: z.string().min(32).max(256),
  pid: z.number().int().positive().max(2147483647),
  processStartIdentity: z.string().min(1).max(512),
  workspace: z.string().min(1).max(4096),
  webOrigin: origin,
});
export type DaemonBootstrap = z.infer<typeof bootstrapSchema>;
function decodeFrame(bytes: Buffer) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
/** Exactly the same single bootstrap request and response on either local transport. */
export function bootstrapResponse(
  bytes: Uint8Array,
  value: Omit<DaemonBootstrap, 'requestId'>,
): Buffer | null {
  try {
    const frame = Buffer.from(bytes);
    if (frame.length > bootstrapMaxBytes || frame.indexOf(10) !== frame.length - 1) return null;
    const input = bootstrapRequestSchema.parse(decodeFrame(frame.subarray(0, -1)));
    const response = Buffer.from(
      `${JSON.stringify(bootstrapSchema.parse({ ...value, requestId: input.requestId }))}\n`,
    );
    return response.length <= bootstrapMaxBytes ? response : null;
  } catch {
    return null;
  }
}
export function handleBootstrapConnection(
  socket: Socket,
  value: Omit<DaemonBootstrap, 'requestId'>,
) {
  let bytes = Buffer.alloc(0),
    finished = false;
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    if (finished) {
      socket.destroy();
      return;
    }
    bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    if (bytes.length > bootstrapMaxBytes) {
      socket.destroy();
      return;
    }
    const end = bytes.indexOf(10);
    if (end < 0) return;
    finished = true;
    try {
      if (end !== bytes.length - 1) throw Error('invalid_frame');
      const input = bootstrapRequestSchema.parse(decodeFrame(bytes.subarray(0, end)));
      const response = `${JSON.stringify(bootstrapSchema.parse({ ...value, requestId: input.requestId }))}\n`;
      if (Buffer.byteLength(response) > bootstrapMaxBytes) throw Error('invalid_frame');
      socket.end(response);
    } catch {
      socket.destroy();
    }
  });
}
function sameProfile(a: DaemonProfile, b: DaemonProfile) {
  return a.dataRoot === b.dataRoot && a.name === b.name && a.accessKey === b.accessKey;
}
/** Private native launcher only. HTTP clients remain browser-safe and own subsequent admission. */
export async function requestDaemonBootstrap(
  endpoint: DaemonEndpoint,
  expectedProfile: DaemonProfile,
): Promise<DaemonBootstrap> {
  const parsed = profileSchema.safeParse(structuredClone(expectedProfile));
  if (!parsed.success) throw daemonError('daemon_invalid_selection');
  const expected = parsed.data,
    record = readDaemonReservation(endpoint);
  if (!record) throw daemonError('daemon_absent');
  if (!sameProfile(record.profile, expected)) throw daemonError('daemon_identity_mismatch');
  if (endpoint.transport === 'windows-pipe') {
    if (!record.pipe) throw daemonError('daemon_not_ready');
    if (record.pipe !== endpoint.socket) throw daemonError('daemon_endpoint_drift');
    const id = randomUUID();
    const bytes = await requestWindowsDaemonPipe(
      endpoint.socket,
      record,
      Buffer.from(
        `${JSON.stringify(bootstrapRequestSchema.parse({ requestVersion: 1, requestId: id, operation: 'bootstrap' }))}\n`,
      ),
    );
    try {
      const frame = Buffer.from(bytes);
      if (frame.length > bootstrapMaxBytes || frame.indexOf(10) !== frame.length - 1)
        throw Error('invalid_frame');
      const value = bootstrapSchema.parse(decodeFrame(frame.subarray(0, -1)));
      const after = readDaemonReservation(endpoint);
      if (
        value.requestId !== id ||
        !sameProfile(value.profile, expected) ||
        !after ||
        !sameOwner(value, record) ||
        !sameRecord(after, record)
      )
        throw Error('identity_mismatch');
      return value;
    } catch (error) {
      if (endpointCleanupUnknown(error)) throw error;
      throw daemonError('daemon_identity_mismatch');
    }
  }
  if (!record.socket) throw daemonError('daemon_not_ready');
  const stat = lstatSync(endpoint.socket, { bigint: true });
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o077n) !== 0n ||
    String(stat.dev) !== record.socket.dev ||
    String(stat.ino) !== record.socket.ino
  )
    throw daemonError('daemon_endpoint_drift');
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socket);
    let bytes = Buffer.alloc(0),
      done = false;
    const finish = (error?: Error, value?: DaemonBootstrap) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    socket.setTimeout(5000, () => finish(daemonError('daemon_bootstrap_timeout')));
    socket.once('error', () => finish(daemonError('daemon_unavailable')));
    socket.once('end', () => {
      if (!done) finish(daemonError('daemon_invalid_bootstrap'));
    });
    socket.once('connect', () =>
      socket.end(
        `${JSON.stringify(bootstrapRequestSchema.parse({ requestVersion: 1, requestId: id, operation: 'bootstrap' }))}\n`,
      ),
    );
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (bytes.length > bootstrapMaxBytes) {
        finish(daemonError('daemon_invalid_bootstrap'));
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== bytes.length - 1) throw daemonError('daemon_invalid_bootstrap');
        const value = bootstrapSchema.parse(decodeFrame(bytes.subarray(0, end)));
        const after = readDaemonReservation(endpoint);
        if (
          value.requestId !== id ||
          !sameProfile(value.profile, expected) ||
          !after ||
          !sameOwner(value, record) ||
          !sameOwner(after, record)
        )
          throw daemonError('daemon_identity_mismatch');
        finish(undefined, value);
      } catch {
        finish(daemonError('daemon_identity_mismatch'));
      }
    });
  });
}
function sameOwner(
  value: Pick<
    DaemonReservation,
    'profile' | 'pid' | 'processStartIdentity' | 'instanceId' | 'buildId' | 'workspace'
  >,
  record: DaemonReservation,
) {
  return (
    sameProfile(value.profile, record.profile) &&
    value.pid === record.pid &&
    value.processStartIdentity === record.processStartIdentity &&
    value.instanceId === record.instanceId &&
    value.buildId === record.buildId &&
    value.workspace === record.workspace
  );
}
