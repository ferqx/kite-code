import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { KiteHomeIdentity } from '../service';
import {
  COORDINATOR_LIMITS,
  type CoordinatorEndpointDescriptor,
  type CoordinatorOsIdentity,
  type CoordinatorPeerIdentity,
  type CoordinatorResponseFrame,
} from './codecs';
import type { CoordinatorDispatcher } from './dispatcher';
import {
  CoordinatorFramingError,
  CoordinatorLengthPrefixedFrameDecoder,
  type CoordinatorWireFrame,
  encodeCoordinatorWireFrame,
} from './framing';
import { ensureCoordinatorStateRoot, resolveCoordinatorStatePaths } from './identity';

export type CoordinatorCarrierErrorCode =
  | 'unsupported'
  | 'invalid_endpoint'
  | 'busy'
  | 'permission'
  | 'unavailable'
  | 'handshake_timeout'
  | 'malformed_frame'
  | 'oversized_frame'
  | 'partial_frame'
  | 'queue_overflow';

export class CoordinatorCarrierError extends Error {
  readonly code: CoordinatorCarrierErrorCode;

  constructor(code: CoordinatorCarrierErrorCode, message: string) {
    super(message);
    this.name = 'CoordinatorCarrierError';
    this.code = code;
  }
}

export type CoordinatorCarrierDiagnosticCode = CoordinatorCarrierErrorCode | 'closed';

export interface CoordinatorCarrierSocket {
  onData(listener: (chunk: Uint8Array) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: () => void): void;
  onClose(listener: () => void): void;
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  destroy(): void;
}

export interface CoordinatorCarrierListener {
  close(): Promise<void>;
}

export interface CoordinatorCarrierAdapter {
  readonly transport: CoordinatorEndpointDescriptor['transport'];
  readonly supported: boolean;
  resolveAddress(home: KiteHomeIdentity, endpoint: CoordinatorEndpointDescriptor): string;
  listen(
    address: string,
    onConnection: (socket: CoordinatorCarrierSocket) => void,
  ): Promise<CoordinatorCarrierListener>;
  connect?(address: string): Promise<CoordinatorCarrierSocket>;
}

export interface PosixCoordinatorCarrierAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly socketMode?: number;
  readonly staleProbeTimeoutMs?: number;
}

/** Native AF_UNIX adapter. It never turns a failed Unix bind into TCP. */
export class PosixCoordinatorCarrierAdapter implements CoordinatorCarrierAdapter {
  readonly transport = 'unix_socket' as const;
  readonly supported: boolean;
  readonly #platform: NodeJS.Platform;
  readonly #socketMode: number;
  readonly #staleProbeTimeoutMs: number;

  constructor(options: PosixCoordinatorCarrierAdapterOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.supported = this.#platform !== 'win32';
    this.#socketMode = options.socketMode ?? 0o600;
    this.#staleProbeTimeoutMs = options.staleProbeTimeoutMs ?? 250;
    if (
      !Number.isSafeInteger(this.#socketMode) ||
      this.#socketMode < 0o600 ||
      (this.#socketMode & 0o077) !== 0
    ) {
      throw new CoordinatorCarrierError(
        'permission',
        'Coordinator Unix socket mode is not owner-only.',
      );
    }
    if (
      !Number.isSafeInteger(this.#staleProbeTimeoutMs) ||
      this.#staleProbeTimeoutMs < 1 ||
      this.#staleProbeTimeoutMs > 5_000
    ) {
      throw new CoordinatorCarrierError(
        'unavailable',
        'Coordinator Unix socket probe timeout is invalid.',
      );
    }
  }

  resolveAddress(home: KiteHomeIdentity, endpoint: CoordinatorEndpointDescriptor): string {
    if (endpoint.transport !== this.transport) {
      throw new CoordinatorCarrierError(
        'invalid_endpoint',
        'Coordinator endpoint transport is incompatible.',
      );
    }
    if (endpoint.owner.kind !== 'posix_uid') {
      throw new CoordinatorCarrierError(
        'invalid_endpoint',
        'Coordinator Unix endpoint owner is invalid.',
      );
    }
    return join(resolveCoordinatorStatePaths(home).root, 'coordinator.sock');
  }

  async listen(
    address: string,
    onConnection: (socket: CoordinatorCarrierSocket) => void,
  ): Promise<CoordinatorCarrierListener> {
    if (!this.supported) {
      throw new CoordinatorCarrierError(
        'unsupported',
        'Unix sockets are unavailable on this platform.',
      );
    }
    const existing = await prepareUnixSocketAddress(address, this.#staleProbeTimeoutMs);
    const server = createServer((socket) => onConnection(new NodeCoordinatorCarrierSocket(socket)));
    try {
      await listenServer(server, address);
      chmodSync(address, this.#socketMode);
      verifyUnixSocketOwner(address, process.getuid?.(), existing);
    } catch (error) {
      await closeNodeServer(server);
      removeOwnedUnixSocket(address, existing);
      if (error instanceof CoordinatorCarrierError) throw error;
      throw new CoordinatorCarrierError(
        'unavailable',
        'Coordinator Unix socket could not be opened.',
      );
    }
    const owned = readUnixSocketIdentity(address);
    return {
      close: async () => {
        await closeNodeServer(server);
        removeOwnedUnixSocket(address, owned);
      },
    };
  }

  async connect(address: string): Promise<CoordinatorCarrierSocket> {
    if (!this.supported) {
      throw new CoordinatorCarrierError(
        'unsupported',
        'Unix sockets are unavailable on this platform.',
      );
    }
    return connectUnixSocket(address, this.#staleProbeTimeoutMs);
  }
}

export interface WindowsCoordinatorCarrierAdapterOptions {
  readonly platform?: NodeJS.Platform;
}

/** Native named-pipe adapter. The caller supplies the authenticated SID. */
export class WindowsCoordinatorCarrierAdapter implements CoordinatorCarrierAdapter {
  readonly transport = 'named_pipe' as const;
  readonly supported: boolean;
  readonly #platform: NodeJS.Platform;

  constructor(options: WindowsCoordinatorCarrierAdapterOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.supported = this.#platform === 'win32';
  }

  resolveAddress(home: KiteHomeIdentity, endpoint: CoordinatorEndpointDescriptor): string {
    if (endpoint.transport !== this.transport) {
      throw new CoordinatorCarrierError(
        'invalid_endpoint',
        'Coordinator endpoint transport is incompatible.',
      );
    }
    if (endpoint.owner.kind !== 'windows_sid') {
      throw new CoordinatorCarrierError(
        'invalid_endpoint',
        'Coordinator named-pipe owner is invalid.',
      );
    }
    const homeDigest = createHash('sha256').update(home.root).digest('hex').slice(0, 32);
    const endpointDigest = createHash('sha256')
      .update(endpoint.endpointId)
      .digest('hex')
      .slice(0, 16);
    return `\\\\.\\pipe\\kite-coordinator-${homeDigest}-${endpointDigest}`;
  }

  async listen(
    address: string,
    onConnection: (socket: CoordinatorCarrierSocket) => void,
  ): Promise<CoordinatorCarrierListener> {
    if (!this.supported) {
      throw new CoordinatorCarrierError(
        'unsupported',
        'Windows named pipes are unavailable on this platform.',
      );
    }
    const server = createServer((socket) => onConnection(new NodeCoordinatorCarrierSocket(socket)));
    try {
      await listenServer(server, address);
    } catch (error) {
      await closeNodeServer(server);
      if (error instanceof CoordinatorCarrierError) throw error;
      throw new CoordinatorCarrierError(
        'unavailable',
        'Coordinator named pipe could not be opened.',
      );
    }
    return { close: () => closeNodeServer(server) };
  }

  async connect(address: string): Promise<CoordinatorCarrierSocket> {
    if (!this.supported) {
      throw new CoordinatorCarrierError(
        'unsupported',
        'Windows named pipes are unavailable on this platform.',
      );
    }
    return connectNodeSocket(address, 1_000);
  }
}

export interface CoordinatorCarrierOptions {
  readonly home: KiteHomeIdentity;
  readonly endpoint: CoordinatorEndpointDescriptor;
  readonly dispatcher: CoordinatorDispatcher;
  /** The carrier obtains this from its OS peer adapter; it is never inferred from the frame. */
  readonly peerOsIdentity: CoordinatorOsIdentity;
  readonly adapter?: CoordinatorCarrierAdapter;
  readonly handshakeDeadlineMs?: number;
  readonly maxQueuedMessages?: number;
  readonly maxQueuedBytes?: number;
  readonly onDiagnostic?: (code: CoordinatorCarrierDiagnosticCode) => void;
  /** Server lifecycle hook invoked only after an exact response write callback completes. */
  readonly onResponseFlushed?: (response: CoordinatorResponseFrame) => void | Promise<void>;
}

export interface CoordinatorCarrier {
  readonly endpoint: CoordinatorEndpointDescriptor;
  readonly address: string;
  readonly supported: boolean;
  readonly activeConnections: number;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createCoordinatorCarrier(options: CoordinatorCarrierOptions): CoordinatorCarrier {
  const adapter = options.adapter ?? defaultAdapter(options.endpoint.transport);
  if (adapter.transport !== options.endpoint.transport) {
    throw new CoordinatorCarrierError(
      'invalid_endpoint',
      'Coordinator carrier transport is incompatible.',
    );
  }
  const handshakeDeadlineMs = boundedOption(
    options.handshakeDeadlineMs,
    5_000,
    COORDINATOR_LIMITS.maxDeadlineMs,
    'handshake deadline',
  );
  const maxQueuedMessages = boundedOption(options.maxQueuedMessages, 32, 256, 'connection queue');
  const maxQueuedBytes = boundedOption(
    options.maxQueuedBytes,
    Math.min(COORDINATOR_LIMITS.maxFrameBytes * 4, 256 * 1024),
    COORDINATOR_LIMITS.maxFrameBytes * 4,
    'connection queue bytes',
  );
  const address = adapter.resolveAddress(options.home, options.endpoint);
  const connections = new Set<CoordinatorCarrierConnection>();
  let listener: CoordinatorCarrierListener | undefined;
  let started = false;
  let closing: Promise<void> | undefined;

  return {
    endpoint: options.endpoint,
    address,
    get supported() {
      return adapter.supported;
    },
    get activeConnections() {
      return connections.size;
    },
    async start(): Promise<void> {
      if (started) return;
      if (!adapter.supported) {
        throw new CoordinatorCarrierError(
          'unsupported',
          'Coordinator carrier is unavailable on this platform.',
        );
      }
      ensureCoordinatorStateRoot(options.home);
      listener = await adapter.listen(address, (socket) => {
        const connection = new CoordinatorCarrierConnection({
          socket,
          dispatcher: options.dispatcher,
          peerOsIdentity: options.peerOsIdentity,
          handshakeDeadlineMs,
          maxQueuedMessages,
          maxQueuedBytes,
          onDiagnostic: options.onDiagnostic,
          onResponseFlushed: options.onResponseFlushed,
          onClose: () => connections.delete(connection),
        });
        connections.add(connection);
      });
      started = true;
    },
    async close(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        for (const connection of connections) connection.close();
        connections.clear();
        await listener?.close();
        listener = undefined;
        started = false;
      })();
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    },
  };
}

function defaultAdapter(
  transport: CoordinatorEndpointDescriptor['transport'],
): CoordinatorCarrierAdapter {
  return transport === 'unix_socket'
    ? new PosixCoordinatorCarrierAdapter()
    : new WindowsCoordinatorCarrierAdapter();
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new CoordinatorCarrierError('unavailable', `Coordinator ${label} limit is invalid.`);
  }
  return candidate;
}

class NodeCoordinatorCarrierSocket implements CoordinatorCarrierSocket {
  readonly #socket: Socket;

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#socket.on('data', (chunk: Buffer | string) =>
      listener(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)),
    );
  }

  onEnd(listener: () => void): void {
    this.#socket.on('end', listener);
  }

  onError(listener: () => void): void {
    this.#socket.on('error', listener);
  }

  onClose(listener: () => void): void {
    this.#socket.on('close', listener);
  }

  write(chunk: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.#socket.write(Buffer.from(chunk), (error?: Error | null) =>
          error ? reject(error) : resolve(),
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  end(): void {
    this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

class CoordinatorCarrierConnection {
  readonly #socket: CoordinatorCarrierSocket;
  readonly #dispatcher: CoordinatorDispatcher;
  readonly #peerOsIdentity: CoordinatorOsIdentity;
  readonly #decoder: CoordinatorLengthPrefixedFrameDecoder;
  readonly #handshakeDeadlineMs: number;
  readonly #maxQueuedMessages: number;
  readonly #maxQueuedBytes: number;
  readonly #onDiagnostic: ((code: CoordinatorCarrierDiagnosticCode) => void) | undefined;
  readonly #onResponseFlushed:
    | ((response: CoordinatorResponseFrame) => void | Promise<void>)
    | undefined;
  readonly #onClose: () => void;
  readonly #outbound: {
    readonly bytes: Uint8Array;
    readonly onFlushed?: () => void | Promise<void>;
  }[] = [];
  #outboundBytes = 0;
  #writing = false;
  #inboundCount = 0;
  #inboundTail: Promise<void> = Promise.resolve();
  #handshaken = false;
  #peer: CoordinatorPeerIdentity | undefined;
  #closeAfterDrain = false;
  #closed = false;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    readonly socket: CoordinatorCarrierSocket;
    readonly dispatcher: CoordinatorDispatcher;
    readonly peerOsIdentity: CoordinatorOsIdentity;
    readonly handshakeDeadlineMs: number;
    readonly maxQueuedMessages: number;
    readonly maxQueuedBytes: number;
    readonly onDiagnostic?: (code: CoordinatorCarrierDiagnosticCode) => void;
    readonly onResponseFlushed?: (response: CoordinatorResponseFrame) => void | Promise<void>;
    readonly onClose: () => void;
  }) {
    this.#socket = options.socket;
    this.#dispatcher = options.dispatcher;
    this.#peerOsIdentity = options.peerOsIdentity;
    this.#decoder = new CoordinatorLengthPrefixedFrameDecoder();
    this.#handshakeDeadlineMs = options.handshakeDeadlineMs;
    this.#maxQueuedMessages = options.maxQueuedMessages;
    this.#maxQueuedBytes = options.maxQueuedBytes;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onResponseFlushed = options.onResponseFlushed;
    this.#onClose = options.onClose;
    this.#socket.onData((chunk) => this.#receive(chunk));
    this.#socket.onEnd(() => this.#end());
    this.#socket.onError(() => this.#fail('unavailable'));
    this.#socket.onClose(() => this.#finishClose());
    this.#handshakeTimer = setTimeout(
      () => this.#fail('handshake_timeout'),
      this.#handshakeDeadlineMs,
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    this.#socket.destroy();
    this.#onClose();
  }

  #receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    let frames: readonly CoordinatorWireFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#fail(errorCodeForFraming(error));
      return;
    }
    for (const frame of frames) {
      if (this.#inboundCount >= this.#maxQueuedMessages) {
        this.#fail('queue_overflow');
        return;
      }
      this.#inboundCount += 1;
      this.#inboundTail = this.#inboundTail
        .then(() => this.#process(frame))
        .catch(() => this.#fail('unavailable'))
        .finally(() => {
          this.#inboundCount -= 1;
        });
    }
  }

  async #process(frame: CoordinatorWireFrame): Promise<void> {
    if (this.#closed) return;
    if (!this.#handshaken) {
      if (frame.kind !== 'handshake_request') {
        this.#fail('malformed_frame');
        return;
      }
      const response = this.#dispatcher.handleHandshake(frame);
      if (!samePeerIdentity(frame.peerOsIdentity, this.#peerOsIdentity)) {
        this.#fail('unavailable');
        return;
      }
      this.#enqueue(response);
      if (!response.accepted) {
        this.#closeAfterDrain = true;
        this.#drainOutbound();
        return;
      }
      this.#handshaken = true;
      this.#peer = frame.peer;
      if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
      return;
    }
    if (frame.kind !== 'request') {
      this.#fail('malformed_frame');
      return;
    }
    const peer = this.#peer;
    if (peer === undefined) {
      this.#fail('malformed_frame');
      return;
    }
    const response = await this.#dispatcher.dispatch(frame, peer);
    this.#enqueue(response, () => this.#onResponseFlushed?.(response));
  }

  #enqueue(frame: CoordinatorWireFrame, onFlushed?: () => void | Promise<void>): void {
    if (this.#closed) return;
    let encoded: Uint8Array;
    try {
      encoded = encodeCoordinatorWireFrame(frame);
    } catch {
      this.#fail('malformed_frame');
      return;
    }
    if (
      this.#outbound.length >= this.#maxQueuedMessages ||
      this.#outboundBytes + encoded.byteLength > this.#maxQueuedBytes
    ) {
      this.#fail('queue_overflow');
      return;
    }
    this.#outbound.push({ bytes: encoded, ...(onFlushed ? { onFlushed } : {}) });
    this.#outboundBytes += encoded.byteLength;
    this.#drainOutbound();
  }

  #drainOutbound(): void {
    if (this.#closed || this.#writing) return;
    const next = this.#outbound.shift();
    if (!next) {
      if (this.#closeAfterDrain) {
        this.#closed = true;
        if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
        this.#socket.end();
        this.#onClose();
        this.#diagnose('closed');
      }
      return;
    }
    this.#outboundBytes -= next.bytes.byteLength;
    this.#writing = true;
    void this.#socket
      .write(next.bytes)
      .then(() => next.onFlushed?.())
      .catch(() => this.#fail('unavailable'))
      .finally(() => {
        this.#writing = false;
        this.#drainOutbound();
      });
  }

  #end(): void {
    if (this.#closed) return;
    try {
      this.#decoder.finish();
    } catch (error) {
      this.#fail(errorCodeForFraming(error));
      return;
    }
    // A peer half-close must receive our FIN after already-queued responses drain. Merely
    // dropping the connection from the registry leaves the client socket referenced forever,
    // which prevents short-lived CLI commands from exiting.
    this.#closeAfterDrain = true;
    this.#drainOutbound();
  }

  #fail(code: CoordinatorCarrierErrorCode): void {
    if (this.#closed) return;
    this.#diagnose(code);
    this.#closed = true;
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    this.#socket.destroy();
    this.#onClose();
  }

  #finishClose(): void {
    if (this.#closed) return;
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    this.#closed = true;
    this.#onClose();
    this.#diagnose('closed');
  }

  #diagnose(code: CoordinatorCarrierDiagnosticCode): void {
    try {
      this.#onDiagnostic?.(code);
    } catch {
      // Diagnostics never change connection lifecycle.
    }
  }
}

function samePeerIdentity(left: CoordinatorOsIdentity, right: CoordinatorOsIdentity): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'posix_uid'
    ? right.kind === 'posix_uid' && left.uid === right.uid
    : right.kind === 'windows_sid' && left.sid === right.sid;
}

function errorCodeForFraming(error: unknown): CoordinatorCarrierErrorCode {
  if (error instanceof CoordinatorFramingError) {
    return error.code === 'unsupported_frame' ? 'malformed_frame' : error.code;
  }
  return 'malformed_frame';
}

async function prepareUnixSocketAddress(
  address: string,
  timeoutMs: number,
): Promise<UnixSocketIdentity | undefined> {
  if (!existsSync(address)) return undefined;
  const stat = lstatSync(address);
  if (!stat.isSocket()) {
    throw new CoordinatorCarrierError('permission', 'Coordinator Unix endpoint is not a socket.');
  }
  const identity = { dev: stat.dev, ino: stat.ino };
  const live = await probeUnixSocket(address, timeoutMs);
  if (live === 'alive') {
    throw new CoordinatorCarrierError('busy', 'Coordinator Unix endpoint is already serving.');
  }
  if (live === 'uncertain') {
    throw new CoordinatorCarrierError(
      'unavailable',
      'Coordinator Unix endpoint liveness is uncertain.',
    );
  }
  removeOwnedUnixSocket(address, identity);
  return undefined;
}

type UnixSocketIdentity = Readonly<{ dev: number; ino: number }>;

function readUnixSocketIdentity(address: string): UnixSocketIdentity {
  const stat = lstatSync(address);
  if (!stat.isSocket())
    throw new CoordinatorCarrierError('permission', 'Coordinator endpoint changed type.');
  return { dev: stat.dev, ino: stat.ino };
}

function verifyUnixSocketOwner(
  address: string,
  ownerUid: number | undefined,
  previous: UnixSocketIdentity | undefined,
): void {
  const stat = lstatSync(address);
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
    throw new CoordinatorCarrierError('permission', 'Coordinator Unix endpoint is not owner-only.');
  }
  if (ownerUid !== undefined && stat.uid !== ownerUid) {
    throw new CoordinatorCarrierError(
      'permission',
      'Coordinator Unix endpoint owner is unexpected.',
    );
  }
  if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) {
    throw new CoordinatorCarrierError(
      'unavailable',
      'Coordinator Unix endpoint changed while binding.',
    );
  }
}

function removeOwnedUnixSocket(address: string, expected: UnixSocketIdentity | undefined): void {
  if (!existsSync(address)) return;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(address);
  } catch {
    return;
  }
  if (!stat.isSocket()) return;
  if (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino)) return;
  try {
    unlinkSync(address);
  } catch {
    // A replacement owner or an already removed endpoint is not ours to unlink.
  }
}

async function probeUnixSocket(
  address: string,
  timeoutMs: number,
): Promise<'alive' | 'dead' | 'uncertain'> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(address);
    const finish = (result: 'alive' | 'dead' | 'uncertain') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('uncertain'), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      finish('alive');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish('dead');
      else finish('uncertain');
    });
  });
}

function listenServer(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = () => {
      server.off('listening', onListening);
      reject(new CoordinatorCarrierError('unavailable', 'Coordinator endpoint listener failed.'));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function closeNodeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function connectUnixSocket(address: string, timeoutMs: number): Promise<CoordinatorCarrierSocket> {
  return connectNodeSocket(address, timeoutMs);
}

function connectNodeSocket(address: string, timeoutMs: number): Promise<CoordinatorCarrierSocket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new CoordinatorCarrierError('unavailable', 'Coordinator endpoint connection timed out.'),
      );
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(new NodeCoordinatorCarrierSocket(socket));
    });
    socket.once('error', () => {
      clearTimeout(timer);
      reject(new CoordinatorCarrierError('unavailable', 'Coordinator endpoint connection failed.'));
    });
  });
}
