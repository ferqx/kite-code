import { createConnection, type Socket } from 'node:net';
import type { RuntimeClientConnection, RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_PROTOCOL_LIMITS,
  type RuntimeProtocolMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import type { KiteLocalRuntimeEndpoint } from '../service';

const DEFAULT_CONNECT_DEADLINE_MS = 5_000;
const DEFAULT_SEND_DEADLINE_MS = 5_000;
const DEFAULT_MAX_QUEUED_MESSAGES = RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages;

export type NodeSocketTransportDiagnosticCode =
  | 'socket_connect_failure'
  | 'socket_connection_closed'
  | 'socket_invalid_protocol'
  | 'socket_invalid_utf8'
  | 'socket_malformed_json'
  | 'socket_overlong_line'
  | 'socket_queue_overflow'
  | 'socket_send_failure'
  | 'socket_truncated_line';

export interface NodeSocketRuntimeClientTransportOptions {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly connectDeadlineMs?: number;
  readonly sendDeadlineMs?: number;
  readonly maxLineBytes?: number;
  readonly maxQueuedMessages?: number;
  readonly onDiagnostic?: (code: NodeSocketTransportDiagnosticCode) => void;
}

/** Explicit owner-only Unix socket/named-pipe transport; it never discovers or spawns a daemon. */
export function createNodeSocketRuntimeClientTransport(
  options: NodeSocketRuntimeClientTransportOptions,
): RuntimeClientTransport {
  const connectDeadlineMs = positive(options.connectDeadlineMs, DEFAULT_CONNECT_DEADLINE_MS);
  const sendDeadlineMs = positive(options.sendDeadlineMs, DEFAULT_SEND_DEADLINE_MS);
  const maxLineBytes = positive(options.maxLineBytes, RUNTIME_PROTOCOL_LIMITS.maxMessageBytes);
  if (maxLineBytes > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
    throw new RangeError('Socket Runtime line bound exceeds the Protocol limit.');
  }
  const maxQueuedMessages = positive(options.maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES);
  const diagnose = (code: NodeSocketTransportDiagnosticCode) => {
    try {
      options.onDiagnostic?.(code);
    } catch {
      // Diagnostics never affect connection state.
    }
  };
  return Object.freeze({
    async connect(): Promise<RuntimeClientConnection> {
      const socket = await connectSocket(options.endpoint, connectDeadlineMs, diagnose);
      return new NodeSocketRuntimeClientConnection({
        socket,
        sendDeadlineMs,
        maxLineBytes,
        maxQueuedMessages,
        diagnose,
      });
    },
  });
}

class NodeSocketRuntimeClientConnection implements RuntimeClientConnection {
  readonly #socket: Socket;
  readonly #sendDeadlineMs: number;
  readonly #maxLineBytes: number;
  readonly #queue: SocketMessageQueue;
  readonly #diagnose: (code: NodeSocketTransportDiagnosticCode) => void;
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;
  #failure: Error | undefined;

  constructor(input: {
    readonly socket: Socket;
    readonly sendDeadlineMs: number;
    readonly maxLineBytes: number;
    readonly maxQueuedMessages: number;
    readonly diagnose: (code: NodeSocketTransportDiagnosticCode) => void;
  }) {
    this.#socket = input.socket;
    this.#sendDeadlineMs = input.sendDeadlineMs;
    this.#maxLineBytes = input.maxLineBytes;
    this.#queue = new SocketMessageQueue(input.maxQueuedMessages);
    this.#diagnose = input.diagnose;
    this.#consume();
  }

  send(message: RuntimeProtocolMessage): Promise<void> {
    if (this.#closed || this.#failure) return Promise.reject(this.#error());
    const decoded = safeDecodeRuntimeProtocolMessage(message);
    if (!decoded.success) {
      return Promise.reject(new TypeError('Socket Runtime refused an invalid message.'));
    }
    const bytes = Buffer.from(`${JSON.stringify(decoded.data)}\n`, 'utf8');
    if (bytes.byteLength - 1 > this.#maxLineBytes) {
      return Promise.reject(new RangeError('Socket Runtime refused an oversized message.'));
    }
    const sent = this.#writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.#closed || this.#failure) {
            reject(this.#error());
            return;
          }
          const timer = setTimeout(() => {
            this.#fail('socket_send_failure');
            reject(this.#error());
          }, this.#sendDeadlineMs);
          this.#socket.write(bytes, (error) => {
            clearTimeout(timer);
            if (error) {
              this.#fail('socket_send_failure');
              reject(this.#error());
            } else {
              resolve();
            }
          });
        }),
    );
    this.#writeTail = sent.catch(() => undefined);
    return sent;
  }

  messages(): AsyncIterable<unknown> {
    return this.#queue.iterable();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.close();
    await this.#writeTail.catch(() => undefined);
    this.#socket.end();
    this.#socket.destroy();
  }

  #consume(): void {
    let buffered = Buffer.alloc(0);
    this.#socket.on('data', (chunk: Buffer) => {
      if (this.#closed || this.#failure) return;
      const firstNewline = chunk.indexOf(0x0a);
      if (firstNewline < 0 && buffered.byteLength + chunk.byteLength > this.#maxLineBytes) {
        this.#fail('socket_overlong_line');
        return;
      }
      if (firstNewline > this.#maxLineBytes - buffered.byteLength) {
        this.#fail('socket_overlong_line');
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        if (newline > this.#maxLineBytes) {
          this.#fail('socket_overlong_line');
          return;
        }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        const payload =
          line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
          this.#fail('socket_invalid_utf8');
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          this.#fail('socket_malformed_json');
          return;
        }
        const decoded = safeDecodeRuntimeProtocolMessage(value);
        if (!decoded.success) {
          this.#fail('socket_invalid_protocol');
          return;
        }
        if (!this.#queue.push(decoded.data)) {
          this.#fail('socket_queue_overflow');
          return;
        }
      }
      if (buffered.byteLength > this.#maxLineBytes + 1) this.#fail('socket_overlong_line');
    });
    this.#socket.once('end', () => {
      if (this.#closed) return;
      if (buffered.byteLength > 0) this.#fail('socket_truncated_line');
      else this.#fail('socket_connection_closed');
    });
    this.#socket.once('error', () => this.#fail('socket_connection_closed'));
  }

  #fail(code: NodeSocketTransportDiagnosticCode): void {
    if (this.#closed || this.#failure) return;
    this.#failure = new Error('App Server daemon connection failed.');
    this.#diagnose(code);
    this.#queue.fail(this.#failure);
    this.#socket.destroy();
  }

  #error(): Error {
    return this.#failure ?? new Error('App Server daemon connection is closed.');
  }
}

async function connectSocket(
  endpoint: KiteLocalRuntimeEndpoint,
  deadlineMs: number,
  diagnose: (code: NodeSocketTransportDiagnosticCode) => void,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(endpoint.kind === 'unix' ? endpoint.socket : endpoint.pipeName);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      diagnose('socket_connect_failure');
      socket.destroy();
      reject(new Error('App Server daemon connection timed out.'));
    }, deadlineMs);
    socket.setNoDelay(true);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      diagnose('socket_connect_failure');
      reject(new Error('App Server daemon is unavailable.'));
    });
  });
}

class SocketMessageQueue {
  readonly #items: unknown[] = [];
  readonly #waiters = new Set<{
    readonly resolve: (value: IteratorResult<unknown>) => void;
    readonly reject: (error: Error) => void;
  }>();
  readonly #maximum: number;
  #closed = false;
  #failure: Error | undefined;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  push(value: unknown): boolean {
    if (this.#closed || this.#failure) return false;
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter.resolve({ done: false, value });
      return true;
    }
    if (this.#items.length >= this.#maximum) return false;
    this.#items.push(value);
    return true;
  }

  close(): void {
    if (this.#closed || this.#failure) return;
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter.resolve({ done: true, value: undefined });
    this.#waiters.clear();
  }

  fail(error: Error): void {
    if (this.#closed || this.#failure) return;
    this.#failure = error;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  iterable(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          const item = this.#items.shift();
          if (item !== undefined) return Promise.resolve({ done: false, value: item });
          if (this.#failure) return Promise.reject(this.#failure);
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => this.#waiters.add({ resolve, reject }));
        },
        return: async () => {
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError('Invalid socket bound.');
  return result;
}
