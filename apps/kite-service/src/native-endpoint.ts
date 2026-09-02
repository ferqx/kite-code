import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import {
  decodeKiteLocalNativeRequest,
  decodeKiteLocalNativeResponse,
  encodeKiteLocalNativeFrame,
  encodeKiteLocalRuntimeLifecycleReservation,
  KITE_LOCAL_NATIVE_MAX_FRAME_BYTES,
  KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
  type KiteLocalNativeRequest,
  type KiteLocalNativeResponse,
  type KiteLocalRuntimeEndpoint,
  type KiteLocalRuntimeLifecycleReservation,
} from '@kite-ai/kite-local-runtime/service';

const DEFAULT_REQUEST_DEADLINE_MS = 2_000;
const DEFAULT_MAX_CONNECTIONS = 64;

export interface KiteNativeEndpointServerOptions {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly dispatch: (
    request: KiteLocalNativeRequest,
  ) => KiteLocalNativeResponse | Promise<KiteLocalNativeResponse>;
  readonly requestDeadlineMs?: number;
  readonly maxConnections?: number;
  readonly lifecycleIdentity: KiteLocalRuntimeLifecycleReservation;
}

export interface KiteNativeEndpointServer extends AsyncDisposable {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly state: 'absent' | 'ready' | 'closed';
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface KiteOwnedLocalEndpointServerOptions {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly lifecycleIdentity: KiteLocalRuntimeLifecycleReservation;
  readonly handleConnection: (socket: Socket) => void | Promise<void>;
  readonly maxConnections?: number;
  readonly closeActiveConnections?: boolean;
}

export type KiteOwnedLocalEndpointServer = KiteNativeEndpointServer;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Single-Service native discovery/control listener. It accepts exactly one bounded JSONL request
 * per connection and never writes descriptors, credentials, launch intents, or business state.
 */
export function createKiteNativeEndpointServer(
  options: KiteNativeEndpointServerOptions,
): KiteNativeEndpointServer {
  const requestDeadlineMs = positiveBound(
    options.requestDeadlineMs,
    DEFAULT_REQUEST_DEADLINE_MS,
    30_000,
    'requestDeadlineMs',
  );
  return createKiteOwnedLocalEndpointServer({
    endpoint: options.endpoint,
    lifecycleIdentity: options.lifecycleIdentity,
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    handleConnection: (socket) => handleConnection(socket, options.dispatch, requestDeadlineMs),
  });
}

/** Owner-only Unix socket/named-pipe lifecycle shared by control and Runtime protocols. */
export function createKiteOwnedLocalEndpointServer(
  options: KiteOwnedLocalEndpointServerOptions,
): KiteOwnedLocalEndpointServer {
  const maxConnections = positiveBound(
    options.maxConnections,
    DEFAULT_MAX_CONNECTIONS,
    1_024,
    'maxConnections',
  );
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (state !== 'ready' || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    Promise.resolve()
      .then(() => options.handleConnection(socket))
      .finally(() => {
        sockets.delete(socket);
      });
  });
  let state: KiteNativeEndpointServer['state'] = 'absent';
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let lockDescriptor: number | undefined;
  let lockIdentity: FileIdentity | undefined;
  let socketIdentity: FileIdentity | undefined;

  const owner: KiteNativeEndpointServer = {
    endpoint: options.endpoint,
    get state() {
      return state;
    },
    start() {
      if (state === 'closed') return Promise.reject(new Error('Native endpoint is closed.'));
      startPromise ??= startServer();
      return startPromise;
    },
    close() {
      closePromise ??= closeServer();
      return closePromise;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };
  return Object.freeze(owner);

  async function startServer(): Promise<void> {
    if (state !== 'absent') throw new Error('Native endpoint start state is invalid.');
    try {
      if (options.endpoint.kind === 'unix') {
        prepareUnixRuntimeRoot(options.endpoint.root);
        lockDescriptor = openSync(options.endpoint.lifecycleReservation, 'wx', 0o600);
        writeSync(
          lockDescriptor,
          encodeKiteLocalRuntimeLifecycleReservation(options.lifecycleIdentity),
        );
        fsyncSync(lockDescriptor);
        lockIdentity = identityForDescriptor(lockDescriptor);
        assertPathAbsent(options.endpoint.socket, 'Native endpoint socket');
      }
      await listen(server, endpointAddress(options.endpoint));
      if (options.endpoint.kind === 'unix') {
        chmodSync(options.endpoint.socket, 0o600);
        const stat = lstatSync(options.endpoint.socket);
        if (!stat.isSocket() || stat.isSymbolicLink()) {
          throw new Error('Native endpoint did not create an exact Unix socket.');
        }
        socketIdentity = { dev: stat.dev, ino: stat.ino };
        if (lockDescriptor === undefined) {
          throw new Error('Native endpoint lifecycle reservation is unavailable.');
        }
        ftruncateSync(lockDescriptor, 0);
        writeSync(
          lockDescriptor,
          encodeKiteLocalRuntimeLifecycleReservation({
            ...options.lifecycleIdentity,
            socketDevice: stat.dev,
            socketInode: stat.ino,
          }),
          0,
          'utf8',
        );
        fsyncSync(lockDescriptor);
      }
      state = 'ready';
    } catch (error) {
      await closeNetServer(server).catch(() => undefined);
      await cleanupTransport().catch(() => undefined);
      throw error;
    }
  }

  async function closeServer(): Promise<void> {
    if (state === 'closed') return;
    state = 'closed';
    // Stop accepting first, then let bounded one-request connections flush their response. In
    // particular, an authenticated service_stop response must reach the manager before endpoint
    // cleanup removes the socket. Each connection already has requestDeadlineMs as its upper bound.
    const closing = closeNetServer(server);
    if (options.closeActiveConnections) {
      for (const socket of sockets) socket.destroy();
    }
    await closing;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await cleanupTransport();
  }

  async function cleanupTransport(): Promise<void> {
    if (options.endpoint.kind !== 'unix') return;
    if (socketIdentity) {
      unlinkExact(options.endpoint.socket, socketIdentity, 'socket');
      socketIdentity = undefined;
    }
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      lockDescriptor = undefined;
    }
    if (lockIdentity) {
      unlinkExact(options.endpoint.lifecycleReservation, lockIdentity, 'file');
      lockIdentity = undefined;
    }
    try {
      rmdirSync(options.endpoint.root);
    } catch (error) {
      if (!errorCodeIs(error, 'ENOENT') && !errorCodeIs(error, 'ENOTEMPTY')) throw error;
    }
  }
}

async function handleConnection(
  socket: Socket,
  dispatch: KiteNativeEndpointServerOptions['dispatch'],
  deadlineMs: number,
): Promise<void> {
  socket.setNoDelay(true);
  let bytes = 0;
  let settled = false;
  let buffer = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), deadlineMs);
  try {
    const frame = await new Promise<Buffer>((resolveFrame, reject) => {
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > KITE_LOCAL_NATIVE_MAX_FRAME_BYTES) {
          settled = true;
          reject(new Error('Native request frame exceeds its fixed bound.'));
          return;
        }
        buffer = Buffer.concat([buffer, chunk], bytes);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== buffer.byteLength - 1 || buffer.subarray(0, newline).includes(0x0a)) {
          settled = true;
          reject(new Error('Native request must contain exactly one frame.'));
          return;
        }
        settled = true;
        resolveFrame(buffer.subarray(0, newline));
      });
      socket.once('error', reject);
      socket.once('end', () => {
        if (!settled) reject(new Error('Native request ended before a complete frame.'));
      });
    });
    let request: KiteLocalNativeRequest;
    try {
      request = decodeKiteLocalNativeRequest(JSON.parse(frame.toString('utf8')) as unknown);
    } catch {
      socket.end(
        encodeKiteLocalNativeFrame({
          schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
          requestId: 'invalid-request',
          operation: 'rejected',
          outcome: 'rejected',
          diagnostic: 'invalid_request',
        }),
      );
      return;
    }
    let response: KiteLocalNativeResponse;
    try {
      response = decodeKiteLocalNativeResponse(await dispatch(request));
      if (response.requestId !== request.requestId) {
        throw new Error('Native response request identity mismatch.');
      }
    } catch {
      response = {
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: request.requestId,
        operation: 'rejected',
        outcome: 'rejected',
        diagnostic: 'unavailable',
      };
    }
    socket.end(encodeKiteLocalNativeFrame(response));
  } catch {
    socket.destroy();
  } finally {
    clearTimeout(timer);
  }
}

function prepareUnixRuntimeRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(root) !== resolve(root)) {
    throw new Error('Native endpoint runtime root is not a real directory.');
  }
  chmodSync(root, 0o700);
}

function assertPathAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error(`${label} already exists.`);
}

function identityForDescriptor(descriptor: number): FileIdentity {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Native endpoint lock is invalid.');
  return { dev: stat.dev, ino: stat.ino };
}

function unlinkExact(path: string, identity: FileIdentity, kind: 'file' | 'socket'): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) return;
    throw error;
  }
  const kindMatches = kind === 'file' ? stat.isFile() && stat.nlink === 1 : stat.isSocket();
  if (
    stat.isSymbolicLink() ||
    !kindMatches ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino
  ) {
    throw new Error(`Native endpoint ${kind} identity changed before cleanup.`);
  }
  unlinkSync(path);
}

function endpointAddress(endpoint: KiteLocalRuntimeEndpoint): string {
  return endpoint.kind === 'unix' ? endpoint.socket : endpoint.pipeName;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeNetServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${label} must be a positive bounded integer.`);
  }
  return selected;
}

function errorCodeIs(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
