import type { KiteHomeIdentity } from '../service';
import {
  type CoordinatorCarrierAdapter,
  CoordinatorCarrierError,
  type CoordinatorCarrierSocket,
  PosixCoordinatorCarrierAdapter,
  WindowsCoordinatorCarrierAdapter,
} from './carrier';
import type {
  CoordinatorEndpointDescriptor,
  CoordinatorHandshakeRequest,
  CoordinatorRequestFrame,
} from './codecs';
import type { CoordinatorRequestTransport } from './dispatcher';
import {
  CoordinatorLengthPrefixedFrameDecoder,
  type CoordinatorWireFrame,
  encodeCoordinatorWireFrame,
} from './framing';

const DEFAULT_DEADLINE_MS = 30_000;
const MAX_INBOUND_FRAMES = 32;

export interface CoordinatorSocketRequestTransportOptions {
  readonly home: KiteHomeIdentity;
  readonly endpoint: CoordinatorEndpointDescriptor;
  readonly adapter?: CoordinatorCarrierAdapter;
  readonly operationDeadlineMs?: number;
}

/** One authenticated, serial local-IPC client connection. No reconnect/replay is implicit. */
export function createCoordinatorSocketRequestTransport(
  options: CoordinatorSocketRequestTransportOptions,
): CoordinatorRequestTransport {
  const adapter = options.adapter ?? defaultAdapter(options.endpoint.transport);
  if (adapter.transport !== options.endpoint.transport || !adapter.connect) {
    throw new CoordinatorCarrierError('invalid_endpoint', 'Coordinator transport is incompatible.');
  }
  const deadline = boundedDeadline(options.operationDeadlineMs);
  const address = adapter.resolveAddress(options.home, options.endpoint);
  let socket: CoordinatorCarrierSocket | undefined;
  let inbox: CoordinatorInbox | undefined;
  let handshaken = false;
  let closed = false;
  let tail = Promise.resolve();

  const serial = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return Object.freeze({
    handshake(frame: CoordinatorHandshakeRequest): Promise<unknown> {
      return serial(async () => {
        if (handshaken) throw unavailable();
        const connection = await ensureConnection();
        await connection.write(encodeCoordinatorWireFrame(frame));
        const response = await inbox!.next(deadline);
        if (response.kind !== 'handshake_response') throw unavailable();
        handshaken = response.accepted;
        if (!response.accepted) await close();
        return response;
      });
    },
    request(frame: CoordinatorRequestFrame): Promise<unknown> {
      return serial(async () => {
        if (!handshaken) throw unavailable();
        await socket!.write(encodeCoordinatorWireFrame(frame));
        const response = await inbox!.next(deadline);
        if (response.kind !== 'response') throw unavailable();
        return response;
      });
    },
    close,
  });

  async function ensureConnection(): Promise<CoordinatorCarrierSocket> {
    if (closed) throw unavailable();
    if (socket) return socket;
    socket = await adapter.connect!(address);
    inbox = new CoordinatorInbox(socket, () => {
      handshaken = false;
      socket = undefined;
    });
    return socket;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    handshaken = false;
    inbox?.close();
    socket?.end();
    socket = undefined;
    inbox = undefined;
  }
}

class CoordinatorInbox {
  readonly #decoder = new CoordinatorLengthPrefixedFrameDecoder();
  readonly #frames: CoordinatorWireFrame[] = [];
  readonly #waiters: Array<{
    readonly resolve: (frame: CoordinatorWireFrame) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  readonly #onClose: () => void;
  readonly #socket: CoordinatorCarrierSocket;
  #closed = false;

  constructor(socket: CoordinatorCarrierSocket, onClose: () => void) {
    this.#socket = socket;
    this.#onClose = onClose;
    socket.onData((chunk) => this.push(chunk));
    socket.onEnd(() => this.finish());
    socket.onError(() => this.fail());
    socket.onClose(() => this.finish());
  }

  next(deadlineMs: number): Promise<CoordinatorWireFrame> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.#closed) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(
            new CoordinatorCarrierError('unavailable', 'Coordinator response deadline exceeded.'),
          );
          this.#socket.destroy();
          this.fail();
        }, deadlineMs),
      };
      this.#waiters.push(waiter);
    });
  }

  close(): void {
    this.fail();
  }

  private push(chunk: Uint8Array): void {
    if (this.#closed) return;
    let frames: readonly CoordinatorWireFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      this.fail();
      return;
    }
    for (const frame of frames) {
      const waiter = this.#waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        if (this.#frames.length >= MAX_INBOUND_FRAMES) {
          this.#socket.destroy();
          this.fail();
          return;
        }
        this.#frames.push(frame);
      }
    }
  }

  private finish(): void {
    if (this.#closed) return;
    try {
      this.#decoder.finish();
    } catch {
      this.fail();
      return;
    }
    this.fail();
  }

  private fail(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#frames.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(unavailable());
    }
    this.#onClose();
  }
}

function defaultAdapter(
  transport: CoordinatorEndpointDescriptor['transport'],
): CoordinatorCarrierAdapter {
  return transport === 'unix_socket'
    ? new PosixCoordinatorCarrierAdapter()
    : new WindowsCoordinatorCarrierAdapter();
}

function boundedDeadline(value: number | undefined): number {
  const deadline = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 120_000) {
    throw new RangeError('Coordinator client deadline is invalid.');
  }
  return deadline;
}

function unavailable(): CoordinatorCarrierError {
  return new CoordinatorCarrierError('unavailable', 'Coordinator connection is unavailable.');
}
