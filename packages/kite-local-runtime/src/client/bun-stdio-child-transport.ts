import type { RuntimeClientConnection, RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_PROTOCOL_LIMITS,
  type RuntimeProtocolMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';

const DEFAULT_SEND_DEADLINE_MS = 5_000;
const DEFAULT_CLOSE_DEADLINE_MS = 5_000;
const DEFAULT_MAX_QUEUED_MESSAGES = RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages;

export type BunStdioChildTransportDiagnosticCode =
  | 'stdio_child_exited'
  | 'stdio_child_spawn_failure'
  | 'stdio_close_deadline'
  | 'stdio_send_failure'
  | 'stdio_stderr_failure'
  | 'stdio_stdin_close_failure'
  | 'stdio_stdout_failure'
  | 'stdio_stdout_invalid_protocol'
  | 'stdio_stdout_invalid_utf8'
  | 'stdio_stdout_malformed_json'
  | 'stdio_stdout_overlong_line'
  | 'stdio_stdout_truncated_line';

/** The deliberately small pipe surface required by this App-owned carrier. */
export interface BunStdioChild {
  readonly stdin: {
    write(chunk: Uint8Array): unknown;
    flush(): unknown;
    end(): unknown;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<unknown>;
  kill(signal?: string | number): unknown;
}

export interface BunStdioChildSpawnOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Injectable only for App-local reference consumers and isolated tests. */
export type BunStdioChildSpawnFactory = (options: BunStdioChildSpawnOptions) => BunStdioChild;

export interface BunStdioChildRuntimeClientTransportOptions extends BunStdioChildSpawnOptions {
  /** Defaults to Bun.spawn with pipe-only stdio. It never invokes a shell. */
  readonly spawn?: BunStdioChildSpawnFactory;
  readonly sendDeadlineMs?: number;
  readonly closeDeadlineMs?: number;
  readonly maxLineBytes?: number;
  readonly maxQueuedMessages?: number;
  /** Receives only a fixed diagnostic code; stderr bytes are never exposed. */
  readonly onDiagnostic?: (code: BunStdioChildTransportDiagnosticCode) => void;
}

/**
 * Parent-owned JSONL transport for a Desktop/test runtime child. Each connect
 * owns a fresh child and no process environment or shell command is inferred.
 */
export class BunStdioChildRuntimeClientTransport implements RuntimeClientTransport {
  readonly #spawn: BunStdioChildSpawnFactory;
  readonly #spawnOptions: BunStdioChildSpawnOptions;
  readonly #sendDeadlineMs: number;
  readonly #closeDeadlineMs: number;
  readonly #maxLineBytes: number;
  readonly #maxQueuedMessages: number;
  readonly #onDiagnostic: ((code: BunStdioChildTransportDiagnosticCode) => void) | undefined;

  constructor(options: BunStdioChildRuntimeClientTransportOptions) {
    assertSpawnOptions(options);
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#spawnOptions = Object.freeze({
      argv: Object.freeze([...options.argv]),
      cwd: options.cwd,
      env: Object.freeze({ ...options.env }),
    });
    this.#sendDeadlineMs = positiveSafeInteger(
      options.sendDeadlineMs,
      DEFAULT_SEND_DEADLINE_MS,
      'sendDeadlineMs',
    );
    this.#closeDeadlineMs = positiveSafeInteger(
      options.closeDeadlineMs,
      DEFAULT_CLOSE_DEADLINE_MS,
      'closeDeadlineMs',
    );
    this.#maxLineBytes = boundedPositiveSafeInteger(
      options.maxLineBytes,
      RUNTIME_PROTOCOL_LIMITS.maxMessageBytes,
      RUNTIME_PROTOCOL_LIMITS.maxMessageBytes,
      'maxLineBytes',
    );
    this.#maxQueuedMessages = positiveSafeInteger(
      options.maxQueuedMessages,
      DEFAULT_MAX_QUEUED_MESSAGES,
      'maxQueuedMessages',
    );
    this.#onDiagnostic = options.onDiagnostic;
  }

  async connect(): Promise<RuntimeClientConnection> {
    let child: BunStdioChild;
    try {
      child = this.#spawn(this.#spawnOptions);
    } catch {
      this.#diagnose('stdio_child_spawn_failure');
      throw connectionError();
    }
    if (!isBunStdioChild(child)) {
      this.#diagnose('stdio_child_spawn_failure');
      throw connectionError();
    }
    return new BunStdioChildRuntimeClientConnection({
      child,
      sendDeadlineMs: this.#sendDeadlineMs,
      closeDeadlineMs: this.#closeDeadlineMs,
      maxLineBytes: this.#maxLineBytes,
      maxQueuedMessages: this.#maxQueuedMessages,
      diagnose: (code) => this.#diagnose(code),
    });
  }

  #diagnose(code: BunStdioChildTransportDiagnosticCode): void {
    try {
      this.#onDiagnostic?.(code);
    } catch {
      // Diagnostics are never allowed to change carrier lifecycle.
    }
  }
}

export function createBunStdioChildRuntimeClientTransport(
  options: BunStdioChildRuntimeClientTransportOptions,
): RuntimeClientTransport {
  return new BunStdioChildRuntimeClientTransport(options);
}

class BunStdioChildRuntimeClientConnection implements RuntimeClientConnection {
  readonly #child: BunStdioChild;
  readonly #sendDeadlineMs: number;
  readonly #closeDeadlineMs: number;
  readonly #maxLineBytes: number;
  readonly #queue: BoundedMessageQueue;
  readonly #diagnose: (code: BunStdioChildTransportDiagnosticCode) => void;
  readonly #stdoutDone: Promise<void>;
  readonly #stderrDone: Promise<void>;
  #writeTail: Promise<void> = Promise.resolve();
  #failure: Error | undefined;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly child: BunStdioChild;
    readonly sendDeadlineMs: number;
    readonly closeDeadlineMs: number;
    readonly maxLineBytes: number;
    readonly maxQueuedMessages: number;
    readonly diagnose: (code: BunStdioChildTransportDiagnosticCode) => void;
  }) {
    this.#child = options.child;
    this.#sendDeadlineMs = options.sendDeadlineMs;
    this.#closeDeadlineMs = options.closeDeadlineMs;
    this.#maxLineBytes = options.maxLineBytes;
    this.#queue = new BoundedMessageQueue(options.maxQueuedMessages);
    this.#diagnose = options.diagnose;
    this.#stdoutDone = this.#consumeStdout();
    this.#stderrDone = this.#consumeStderr();
    void this.#observeExit();
  }

  send(message: RuntimeProtocolMessage): Promise<void> {
    if (this.#failure || this.#closing || this.#closed) {
      return Promise.reject(this.#connectionError());
    }
    const decoded = safeDecodeRuntimeProtocolMessage(message);
    if (!decoded.success)
      return Promise.reject(new TypeError('Runtime stdio refused an invalid protocol message.'));
    const bytes = new TextEncoder().encode(`${JSON.stringify(decoded.data)}\n`);
    if (bytes.byteLength - 1 > this.#maxLineBytes) {
      return Promise.reject(new TypeError('Runtime stdio refused an oversized protocol message.'));
    }
    const sending = this.#writeTail.then(async () => {
      if (this.#failure || this.#closing || this.#closed) throw this.#connectionError();
      try {
        await withDeadline(Promise.resolve(this.#child.stdin.write(bytes)), this.#sendDeadlineMs);
        await withDeadline(Promise.resolve(this.#child.stdin.flush()), this.#sendDeadlineMs);
      } catch {
        this.#failed('stdio_send_failure');
        throw this.#connectionError();
      }
    });
    this.#writeTail = sending.catch(() => undefined);
    return sending;
  }

  messages(): AsyncIterable<unknown> {
    return this.#queue.iterable();
  }

  close(_reason?: string): Promise<void> {
    void _reason;
    this.#closePromise ??= this.#closeOwnedChild();
    return this.#closePromise;
  }

  async #consumeStdout(): Promise<void> {
    const reader = this.#child.stdout.getReader();
    const line = new Uint8Array(this.#maxLineBytes + 1);
    let length = 0;
    try {
      while (!this.#closed) {
        const item = await reader.read();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) {
          this.#failed('stdio_stdout_failure');
          return;
        }
        for (const byte of item.value) {
          if (byte === 0x0a) {
            const payloadLength = length > 0 && line[length - 1] === 0x0d ? length - 1 : length;
            if (!this.#acceptStdoutLine(line.subarray(0, payloadLength))) return;
            length = 0;
            continue;
          }
          // One CR byte is reserved for a max-sized CRLF line.
          if (length === this.#maxLineBytes && byte !== 0x0d) {
            this.#failed('stdio_stdout_overlong_line');
            return;
          }
          if (length > this.#maxLineBytes) {
            this.#failed('stdio_stdout_overlong_line');
            return;
          }
          line[length++] = byte;
        }
      }
      if (!this.#closed) {
        this.#failed(length === 0 ? 'stdio_stdout_failure' : 'stdio_stdout_truncated_line');
      }
    } catch {
      if (!this.#closed) this.#failed('stdio_stdout_failure');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Stream cleanup is best-effort after the connection has already ended.
      }
    }
  }

  #acceptStdoutLine(bytes: Uint8Array): boolean {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      this.#failed('stdio_stdout_invalid_utf8');
      return false;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.#failed('stdio_stdout_malformed_json');
      return false;
    }
    const decoded = safeDecodeRuntimeProtocolMessage(value);
    if (!decoded.success) {
      this.#failed('stdio_stdout_invalid_protocol');
      return false;
    }
    if (!this.#queue.push(decoded.data)) {
      this.#failed('stdio_stdout_failure');
      return false;
    }
    return true;
  }

  async #consumeStderr(): Promise<void> {
    const reader = this.#child.stderr.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        // Deliberately discard every diagnostic byte so the child cannot block
        // on stderr and no secret/error body crosses the App boundary.
        if (!(item.value instanceof Uint8Array)) {
          if (!this.#closed) this.#diagnose('stdio_stderr_failure');
          return;
        }
      }
    } catch {
      if (!this.#closed) this.#diagnose('stdio_stderr_failure');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Stream cleanup is best-effort.
      }
    }
  }

  async #observeExit(): Promise<void> {
    try {
      await this.#child.exited;
    } catch {
      // The fixed exit diagnostic intentionally does not expose process data.
    }
    if (!this.#closed) this.#failed('stdio_child_exited');
  }

  #failed(code: Exclude<BunStdioChildTransportDiagnosticCode, 'stdio_child_spawn_failure'>): void {
    if (this.#failure || this.#closed) return;
    this.#failure = connectionError();
    this.#diagnose(code);
    this.#queue.fail(this.#failure);
    void this.close();
  }

  async #closeOwnedChild(): Promise<void> {
    this.#closing = true;
    try {
      await withDeadline(this.#writeTail, this.#closeDeadlineMs);
    } catch {
      this.#diagnose('stdio_close_deadline');
    }
    this.#closed = true;
    this.#queue.close();
    try {
      await withDeadline(Promise.resolve(this.#child.stdin.end()), this.#closeDeadlineMs);
    } catch {
      this.#diagnose('stdio_stdin_close_failure');
    }
    try {
      this.#child.kill(process.platform === 'win32' ? 9 : 'SIGTERM');
    } catch {
      // The child may already have exited. Its handles are still awaited below.
    }
    let handlesClosed = false;
    try {
      await withDeadline(
        Promise.all([this.#stdoutDone, this.#stderrDone, this.#child.exited]).then(() => undefined),
        this.#closeDeadlineMs,
      );
      handlesClosed = true;
    } catch {
      this.#diagnose('stdio_close_deadline');
    }
    if (!handlesClosed && process.platform !== 'win32') {
      try {
        this.#child.kill('SIGKILL');
      } catch {
        // The child may have exited after the first bounded wait.
      }
      try {
        await withDeadline(
          Promise.all([this.#stdoutDone, this.#stderrDone, this.#child.exited]).then(
            () => undefined,
          ),
          this.#closeDeadlineMs,
        );
      } catch {
        this.#diagnose('stdio_close_deadline');
      }
    }
  }

  #connectionError(): Error {
    return this.#failure ?? connectionError();
  }
}

class BoundedMessageQueue {
  readonly #items: unknown[] = [];
  readonly #waiters = new Set<{
    readonly resolve: (result: IteratorResult<unknown>) => void;
    readonly reject: (reason: Error) => void;
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
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            this.#waiters.add({ resolve, reject });
          });
        },
        return: async (): Promise<IteratorResult<unknown>> => {
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

function defaultSpawn(options: BunStdioChildSpawnOptions): BunStdioChild {
  return Bun.spawn({
    cmd: [...options.argv],
    cwd: options.cwd,
    env: { ...options.env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as BunStdioChild;
}

function assertSpawnOptions(options: BunStdioChildRuntimeClientTransportOptions): void {
  if (
    !Array.isArray(options.argv) ||
    options.argv.length === 0 ||
    options.argv.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new TypeError('argv must contain an executable and explicit arguments.');
  }
  if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
    throw new TypeError('cwd must be an explicit non-empty string.');
  }
  if (!options.env || Object.values(options.env).some((value) => typeof value !== 'string')) {
    throw new TypeError('env must be an explicit string-only record.');
  }
}

function isBunStdioChild(value: unknown): value is BunStdioChild {
  if (!value || typeof value !== 'object') return false;
  const child = value as Partial<BunStdioChild>;
  return (
    !!child.stdin &&
    typeof child.stdin.write === 'function' &&
    typeof child.stdin.flush === 'function' &&
    typeof child.stdin.end === 'function' &&
    !!child.stdout &&
    typeof child.stdout.getReader === 'function' &&
    !!child.stderr &&
    typeof child.stderr.getReader === 'function' &&
    !!child.exited &&
    typeof child.exited.then === 'function' &&
    typeof child.kill === 'function'
  );
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function boundedPositiveSafeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = positiveSafeInteger(value, fallback, name);
  if (resolved > maximum) throw new TypeError(`${name} must not exceed ${maximum}.`);
  return resolved;
}

function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(connectionError()), milliseconds);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function connectionError(): Error {
  return new Error('Runtime stdio connection failed.');
}
