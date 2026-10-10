import { dlopen, ptr } from 'bun:ffi';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { bootstrapSchema, type DaemonBootstrap, handleBootstrapConnection } from './bootstrap';
import { readProcessStartIdentity } from './process-identity';
import {
  assertPrivateDirectory,
  type DaemonEndpoint,
  DaemonEndpointCleanupError,
  type DaemonProfile,
  daemonError,
  endpointCleanupUnknown,
  fileIdentity,
  readReservationDetails,
  removeExactEndpoint,
  reservationSchema,
} from './reservation';
import { reserveWindowsEndpoint, selectWindowsEndpoint } from './windows-endpoint';

export { requestDaemonBootstrap } from './bootstrap';
export type { DaemonEndpoint, DaemonProfile, DaemonReservation } from './reservation';
export { clearDeadDaemonEndpoint, readDaemonReservation } from './reservation';

/** Pure bounded address selection; status never creates the selected namespace. */
export function selectDaemonEndpoint(input: {
  profileAccessKey: string;
  explicitSocket?: string;
  platform?: NodeJS.Platform;
  uid?: number;
}): DaemonEndpoint {
  const platform = input.platform ?? process.platform,
    uid = input.uid ?? process.getuid?.();
  if (platform === 'win32') return selectWindowsEndpoint(input);
  if (platform !== 'darwin' && platform !== 'linux')
    throw daemonError('daemon_platform_unsupported');
  if (
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !/^[a-f0-9]{64}$/.test(input.profileAccessKey)
  )
    throw daemonError('daemon_invalid_selection');
  if (input.explicitSocket !== undefined) {
    const path = input.explicitSocket;
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /\p{Cc}/u.test(path) ||
      Buffer.byteLength(path) > 103
    )
      throw daemonError('daemon_invalid_endpoint');
    return Object.freeze({
      root: dirname(path),
      socket: path,
      record: `${path}.lock`,
      profileAccessKey: input.profileAccessKey,
    });
  }
  const parent = platform === 'darwin' ? '/private/tmp' : '/tmp',
    base = join(parent, `kite-daemon-${uid}`),
    version = join(base, 'v1'),
    root = join(version, input.profileAccessKey.slice(0, 32));
  const socket = join(root, 's.sock');
  if (Buffer.byteLength(socket) > 103) throw daemonError('daemon_invalid_endpoint');
  return Object.freeze({
    root,
    socket,
    record: join(root, 'owner.json'),
    profileAccessKey: input.profileAccessKey,
    defaultParent: parent,
    privateParents: Object.freeze([base, version, root]),
  });
}
function prepare(endpoint: DaemonEndpoint) {
  if (endpoint.defaultParent) {
    const parent = lstatSync(endpoint.defaultParent);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      realpathSync.native(endpoint.defaultParent) !== endpoint.defaultParent ||
      ((parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0) ||
      ![0, process.getuid!()].includes(parent.uid)
    )
      throw daemonError('daemon_endpoint_unsafe');
    for (const path of endpoint.privateParents!) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      assertPrivateDirectory(path);
    }
  } else assertPrivateDirectory(endpoint.root);
}
let posix: ReturnType<typeof openPosix> | undefined;
function openPosix() {
  return dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
    bind: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    listen: { args: ['i32', 'i32'], returns: 'i32' },
    close: { args: ['i32'], returns: 'i32' },
  });
}
function bindFd(path: string) {
  posix ??= openPosix();
  const fd = posix.symbols.socket(1, 1, 0);
  if (fd < 0) throw daemonError('daemon_bind_failed');
  try {
    const name = new TextEncoder().encode(path),
      bytes = new Uint8Array(process.platform === 'darwin' ? 106 : 110);
    if (process.platform === 'darwin') {
      bytes[0] = 2 + name.length + 1;
      bytes[1] = 1;
    } else new DataView(bytes.buffer).setUint16(0, 1, true);
    bytes.set(name, 2);
    if (posix.symbols.bind(fd, ptr(bytes), 2 + name.length + 1) !== 0)
      throw daemonError('daemon_bind_failed');
    return fd;
  } catch (error) {
    posix.symbols.close(fd);
    throw error;
  }
}
/** Reservation is acquired before any Store open. Only this process's kernel identity is recorded. */
export async function reserveDaemonEndpoint(
  endpoint: DaemonEndpoint,
  identity: { profile: DaemonProfile; instanceId: string; buildId: string; workspace: string },
) {
  try {
    if (process.platform === 'win32') return await reserveWindowsEndpoint(endpoint, identity);
    return await reserveEndpoint(endpoint, identity);
  } catch (error) {
    if (endpointCleanupUnknown(error)) throw new DaemonEndpointCleanupError(error);
    if (
      typeof (error as { code?: unknown }).code === 'string' &&
      String((error as { code: string }).code).startsWith('daemon_')
    )
      throw error;
    throw daemonError('daemon_endpoint_unsafe');
  }
}
async function reserveEndpoint(
  endpoint: DaemonEndpoint,
  identity: { profile: DaemonProfile; instanceId: string; buildId: string; workspace: string },
) {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw daemonError('daemon_platform_unsupported');
  const selected = selectProfile({
    dataRoot: identity.profile.dataRoot,
    profile: identity.profile.name,
  });
  if (
    selected.dataRoot !== identity.profile.dataRoot ||
    selected.profileAccessKey !== identity.profile.accessKey ||
    selected.profileAccessKey !== endpoint.profileAccessKey
  )
    throw daemonError('daemon_identity_mismatch');
  const workspace = realpathSync.native(identity.workspace);
  if (workspace !== identity.workspace || !lstatSync(workspace).isDirectory())
    throw daemonError('daemon_invalid_workspace');
  const start = readProcessStartIdentity(process.pid);
  if (!start) throw daemonError('daemon_identity_unavailable');
  let record = reservationSchema.parse({
    reservationVersion: 1,
    profile: structuredClone(identity.profile),
    instanceId: identity.instanceId,
    buildId: identity.buildId,
    workspace,
    pid: process.pid,
    processStartIdentity: start,
  });
  prepare(endpoint);
  if (readReservationDetails(endpoint)) throw daemonError('daemon_endpoint_busy');
  if (lstatAbsent(endpoint.socket) !== true) throw daemonError('daemon_identity_unknown');
  let recordFd: number;
  try {
    recordFd = openSync(
      endpoint.record,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw daemonError('daemon_endpoint_busy');
    throw error;
  }
  const rs = fstatSync(recordFd, { bigint: true }),
    recordIdentity = { dev: String(rs.dev), ino: String(rs.ino) };
  let rawFd: number | undefined,
    server: ReturnType<typeof createServer> | undefined,
    closeTask: Promise<void> | undefined,
    opening: Promise<void> | undefined,
    closed = false,
    listening = false;
  const sockets = new Set<import('node:net').Socket>();
  function publish() {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > 16384) throw daemonError('daemon_reservation_oversized');
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(recordFd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw daemonError('daemon_reservation_write_failed');
      offset += n;
    }
    ftruncateSync(recordFd, bytes.length);
    fsyncSync(recordFd);
  }
  try {
    publish();
  } catch (error) {
    closeSync(recordFd);
    throw error;
  }
  const close = () =>
    (closeTask ??= (async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      try {
        await opening?.catch(() => {});
        if (server?.listening)
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
        if (rawFd !== undefined) {
          posix!.symbols.close(rawFd);
          rawFd = undefined;
        }
        removeExactEndpoint(endpoint, record, recordIdentity);
      } finally {
        closeSync(recordFd);
      }
    })());
  return Object.freeze({
    get reservation() {
      return structuredClone(record);
    },
    close,
    async listen(input: Pick<DaemonBootstrap, 'httpEndpoint' | 'token' | 'webOrigin'>) {
      if (closed || listening) throw daemonError('daemon_endpoint_state');
      listening = true;
      // Build only the finite native frame, never an arbitrary request handler.
      const frame = {
        requestVersion: 1 as const,
        operation: 'bootstrap' as const,
        profile: record.profile,
        instanceId: record.instanceId,
        buildId: record.buildId,
        httpEndpoint: input.httpEndpoint,
        token: input.token,
        pid: record.pid,
        processStartIdentity: record.processStartIdentity,
        workspace: record.workspace,
        webOrigin: input.webOrigin,
      };
      try {
        bootstrapSchema.omit({ requestId: true }).parse(frame);
      } catch {
        throw daemonError('daemon_invalid_bootstrap');
      }
      try {
        const observed = readReservationDetails(endpoint);
        if (
          !observed ||
          observed.identity.dev !== recordIdentity.dev ||
          observed.identity.ino !== recordIdentity.ino ||
          JSON.stringify(observed.record) !== JSON.stringify(record)
        )
          throw daemonError('daemon_endpoint_drift');
        if (lstatAbsent(endpoint.socket) !== true) throw daemonError('daemon_endpoint_busy');
        rawFd = bindFd(endpoint.socket);
        record = { ...record, socket: fileIdentity(endpoint.socket) };
        // Native bind observes umask; secure the original socket before publication.
        chmodSync(endpoint.socket, 0o600);
        // A published socket identity promises native connectability. Start the
        // kernel listener before readers can observe it; net then adopts this fd.
        if (posix!.symbols.listen(rawFd, 64) !== 0) throw daemonError('daemon_bind_failed');
        publish();
        server = createServer((socket) => {
          if (closed || sockets.size >= 64) {
            socket.destroy();
            return;
          }
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          handleBootstrapConnection(socket, frame);
        });
        opening = new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen({ fd: rawFd }, () => {
            resolve();
          });
          rawFd = undefined;
        });
        await opening;
        if (closed) throw daemonError('daemon_endpoint_state');
        return { close };
      } catch (error) {
        await close().catch(() => {});
        if (
          typeof (error as { code?: unknown }).code === 'string' &&
          String((error as { code: string }).code).startsWith('daemon_')
        )
          throw error;
        throw daemonError('daemon_bind_failed');
      }
    },
  });
}
function lstatAbsent(path: string) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
