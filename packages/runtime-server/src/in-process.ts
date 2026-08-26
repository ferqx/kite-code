import { RUNTIME_PROTOCOL_LIMITS, type RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  RuntimeServer,
  type RuntimeServerBackend,
  type RuntimeServerConnection,
  type RuntimeServerOptions,
} from './server';

/** A test/TUI-facing endpoint over already-framed logical messages, never a Host bypass. */
export interface RuntimeServerInProcessEndpoint {
  send(message: unknown): Promise<void>;
  messages(): AsyncIterable<RuntimeProtocolMessage>;
  close(reason?: string): Promise<void>;
}

export interface RuntimeServerInProcessPair {
  readonly client: RuntimeServerInProcessEndpoint;
  readonly connection: RuntimeServerConnection;
}

/** App composition creates one of these per Runtime instance, then opens any number of logical clients. */
export interface RuntimeServerInProcessHub {
  readonly server: RuntimeServer;
  open(): RuntimeServerInProcessPair;
}

export interface RuntimeServerInProcessLimits {
  readonly maxMessageBytes: number;
  readonly maxQueuedMessages: number;
  readonly maxQueuedBytes: number;
}

const DEFAULT_IN_PROCESS_LIMITS: RuntimeServerInProcessLimits = Object.freeze({
  maxMessageBytes: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes,
  maxQueuedMessages: RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages,
  maxQueuedBytes: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2,
});

export function createRuntimeServerInProcessHub(
  backend: RuntimeServerBackend,
  options: RuntimeServerOptions,
): RuntimeServerInProcessHub {
  const server = new RuntimeServer(backend, options);
  const inProcessLimits = normalizeInProcessLimits({
    ...(options.limits?.maxOutboundMessages === undefined
      ? {}
      : { maxQueuedMessages: options.limits.maxOutboundMessages }),
    ...(options.limits?.maxOutboundBytes === undefined
      ? {}
      : {
          maxMessageBytes: Math.min(
            RUNTIME_PROTOCOL_LIMITS.maxMessageBytes,
            options.limits.maxOutboundBytes,
          ),
          maxQueuedBytes: options.limits.maxOutboundBytes,
        }),
  });
  return Object.freeze({
    server,
    open: () => openRuntimeServerInProcessPair(server, inProcessLimits),
  });
}

/** Opens one endpoint on an existing App-composed Server, preserving its instance and global budgets. */
export function openRuntimeServerInProcessPair(
  server: RuntimeServer,
  limits?: Partial<RuntimeServerInProcessLimits>,
): RuntimeServerInProcessPair {
  const normalizedLimits = normalizeInProcessLimits(limits);
  const toServer = new LogicalMessageQueue<unknown>(normalizedLimits);
  const toClient = new LogicalMessageQueue<RuntimeProtocolMessage>(normalizedLimits);
  const connection = server.open({
    incoming: toServer,
    send: async (message) => toClient.push(message),
    close: () => {
      toServer.close();
      toClient.close();
    },
  });
  return {
    connection,
    client: {
      send: async (message) => {
        try {
          toServer.push(message);
        } catch (error) {
          await connection.close('in_process_overloaded');
          throw error;
        }
      },
      messages: () => toClient,
      close: async (reason) => connection.close(reason),
    },
  };
}

class LogicalMessageQueue<T> implements AsyncIterable<T> {
  readonly #items: Array<{ value: T; bytes: number }> = [];
  readonly #waiters = new Set<(result: IteratorResult<T>) => void>();
  readonly #limits: RuntimeServerInProcessLimits;
  #bytes = 0;
  #closed = false;

  constructor(limits: RuntimeServerInProcessLimits) {
    this.#limits = limits;
  }

  push(value: T): void {
    if (this.#closed) throw new Error('Logical message connection is closed.');
    const bytes = logicalMessageBytes(value);
    if (
      bytes > this.#limits.maxMessageBytes ||
      this.#items.length >= this.#limits.maxQueuedMessages ||
      this.#bytes + bytes > this.#limits.maxQueuedBytes
    ) {
      throw new Error('Logical message connection capacity exceeded.');
    }
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return;
    }
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    this.#bytes = 0;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) {
          this.#bytes -= item.bytes;
          return Promise.resolve({ done: false, value: item.value });
        }
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        if (this.#waiters.size > 0) {
          return Promise.reject(new Error('Logical message queue supports one pending consumer.'));
        }
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.add(resolve));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function normalizeInProcessLimits(
  overrides?: Partial<RuntimeServerInProcessLimits>,
): RuntimeServerInProcessLimits {
  const limits = { ...DEFAULT_IN_PROCESS_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Runtime Server InProcess limits must be positive safe integers.');
    }
  }
  if (limits.maxMessageBytes > limits.maxQueuedBytes) {
    throw new TypeError('Runtime Server InProcess maxMessageBytes must fit maxQueuedBytes.');
  }
  return Object.freeze(limits);
}

function logicalMessageBytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError('Logical messages must be JSON serializable.');
  }
  if (encoded === undefined) throw new TypeError('Logical messages must be JSON serializable.');
  return new TextEncoder().encode(encoded).byteLength;
}
