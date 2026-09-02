import {
  type ExactJsonCodec,
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  KiteAppContractValidationError,
  type KiteAppControlClient,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '@kite-ai/kite-app-contract';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import {
  RUNTIME_PROTOCOL_APP_CONTROL_METHOD_SCHEMA_,
  RUNTIME_PROTOCOL_ERROR_NUMBERS,
  RUNTIME_PROTOCOL_ERROR_SCHEMA_,
  RUNTIME_PROTOCOL_LIMITS,
  RUNTIME_PROTOCOL_REQUEST_SCHEMA_,
  RUNTIME_PROTOCOL_RESULT_SCHEMA_,
  type RuntimeProtocolAppControlMethod,
  type RuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import type {
  RuntimeServer,
  RuntimeServerConnection,
  RuntimeServerLogicalMessageConnection,
  RuntimeServerOpenOptions,
} from '@kite-ai/runtime-server';

const DEFAULT_DRAIN_DEADLINE_MS = 5_000;

export type RuntimeStdioInput = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Minimal writable seam: this App carrier owns the concrete Node/Bun stream. */
export interface RuntimeStdioOutput {
  write(chunk: Uint8Array): boolean | Promise<boolean>;
  waitForDrain?(): Promise<void>;
  flush?(): Promise<void>;
}

/** Diagnostics are deliberately a separate, text-only stream from protocol stdout. */
export interface RuntimeStdioDiagnostics {
  write(message: string): unknown;
}

export interface RuntimeStdioSignals {
  subscribe(signal: 'SIGINT' | 'SIGTERM', listener: () => void): () => void;
}

export interface RuntimeStdioCarrierOptions {
  readonly server: RuntimeServer;
  readonly stdin: RuntimeStdioInput;
  readonly stdout: RuntimeStdioOutput;
  readonly stderr?: RuntimeStdioDiagnostics;
  readonly signals?: RuntimeStdioSignals;
  /** Parent-owned isolated admission for this one logical stdio client. */
  readonly admission?: RuntimeServerOpenOptions['admission'];
  readonly onClose?: RuntimeServerOpenOptions['onClose'];
  /** Only an App composition owner may release the Host/composition. */
  readonly shutdownComposition?: () => void | Promise<void>;
  /** KASD App Server-only durable reads on this same JSON-RPC connection. */
  readonly history?: RuntimeHistoryClient;
  /** KASD App Server-only exact no-secret control surface on this connection. */
  readonly appControl?: KiteAppControlClient;
  readonly maxLineBytes?: number;
  readonly drainDeadlineMs?: number;
}

export interface RuntimeStdioCarrier {
  readonly connection: RuntimeServerConnection;
  /** Settles once this one logical connection has been released. */
  readonly done: Promise<void>;
  /** Owner-only shutdown: drain Server, flush stdout, then release composition. */
  shutdown(): Promise<void>;
}

interface NodeStyleWritable {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  once(event: 'drain', listener: () => void): unknown;
  off?(event: 'drain', listener: () => void): unknown;
}

interface ProcessStyleSignals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Adapts a Node/Bun writable without letting stream types leak into Server core. */
export function createNodeRuntimeStdioOutput(stream: NodeStyleWritable): RuntimeStdioOutput {
  let flushTail = Promise.resolve();
  return Object.freeze({
    write: (chunk: Uint8Array) => {
      let settle!: () => void;
      let reject!: (error: unknown) => void;
      const flushed = new Promise<void>((resolve, rejectPromise) => {
        settle = resolve;
        reject = rejectPromise;
      });
      let accepted: boolean;
      try {
        accepted = stream.write(chunk, (error) => {
          if (error) reject(error);
          else settle();
        });
      } catch (error) {
        reject(error);
        throw error;
      } finally {
        flushTail = flushTail.then(() => flushed);
      }
      return accepted;
    },
    waitForDrain: () =>
      new Promise<void>((resolve) => {
        const listener = () => {
          stream.off?.('drain', listener);
          resolve();
        };
        stream.once('drain', listener);
      }),
    flush: () => flushTail,
  });
}

/** Adapts App-owned process signal registration for injection into the carrier. */
export function createProcessRuntimeStdioSignals(
  processSignals: ProcessStyleSignals,
): RuntimeStdioSignals {
  return Object.freeze({
    subscribe: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      processSignals.on(signal, listener);
      return () => processSignals.off(signal, listener);
    },
  });
}

/**
 * Creates one App-owned JSONL stdio carrier. EOF is connection-local; only an
 * explicit owner shutdown or an owner process signal releases the composition.
 */
export function createRuntimeStdioCarrier(
  options: RuntimeStdioCarrierOptions,
): RuntimeStdioCarrier {
  const session = new RuntimeStdioSession(options);
  const connection = options.server.open(session, {
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
  });
  session.bindConnection(connection);
  return Object.freeze({
    connection,
    done: session.done,
    shutdown: () => session.shutdown(),
  });
}

class RuntimeStdioSession implements RuntimeServerLogicalMessageConnection {
  readonly incoming = this.#readIncoming();
  readonly done: Promise<void>;
  readonly #options: RuntimeStdioCarrierOptions;
  readonly #maxLineBytes: number;
  readonly #drainDeadlineMs: number;
  #source: AsyncIterator<Uint8Array> | undefined;
  #outputTail: Promise<void> = Promise.resolve();
  #shutdown: Promise<void> | undefined;
  #connection: RuntimeServerConnection | undefined;
  #closed = false;
  #readingComplete = false;
  #resolveDone!: () => void;
  #unsubscribeSignals: (() => void)[] = [];

  constructor(options: RuntimeStdioCarrierOptions) {
    this.#options = options;
    this.#maxLineBytes = options.maxLineBytes ?? RUNTIME_PROTOCOL_LIMITS.maxMessageBytes;
    this.#drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes <= 0) {
      throw new TypeError('maxLineBytes must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.#drainDeadlineMs) || this.#drainDeadlineMs <= 0) {
      throw new TypeError('drainDeadlineMs must be a positive safe integer.');
    }
    this.done = new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });
    if (options.signals) {
      const signals = options.signals;
      const names: readonly ('SIGINT' | 'SIGTERM')[] = ['SIGINT', 'SIGTERM'];
      this.#unsubscribeSignals = names.map((signal) =>
        signals.subscribe(signal, () => {
          void this.shutdown().catch(() => this.#diagnose('shutdown_failure'));
        }),
      );
    }
  }

  bindConnection(connection: RuntimeServerConnection): void {
    if (this.#connection) throw new Error('Runtime stdio connection is already bound.');
    this.#connection = connection;
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    try {
      await this.#writeProtocol(message);
    } catch {
      this.#diagnose('stdout_failure');
      throw new Error('runtime stdio protocol write failed');
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#readingComplete) {
      try {
        await this.#source?.return?.();
      } catch {
        this.#diagnose('input_close_failure');
      }
    }
    this.#resolveDone();
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= this.#shutdownOwnedComposition();
    return this.#shutdown;
  }

  async #shutdownOwnedComposition(): Promise<void> {
    this.#removeSignalHandlers();
    try {
      await this.#options.server.beginDraining();
      await this.#flushOutput();
    } finally {
      try {
        await this.#options.shutdownComposition?.();
      } finally {
        this.#removeSignalHandlers();
      }
    }
  }

  async *#readIncoming(): AsyncGenerator<unknown> {
    // CR in CRLF is framing, not a protocol byte. Keep one byte of bounded
    // lookahead so a max-sized JSON payload may still use CRLF.
    const line = new Uint8Array(this.#maxLineBytes + 1);
    let length = 0;
    try {
      this.#source = chunkIterator(this.#options.stdin);
      while (!this.#closed) {
        const next = await this.#source.next();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          await this.#failClosed('invalid_input_chunk');
          return;
        }
        for (const byte of next.value) {
          if (byte === 0x0a) {
            const payloadLength = length > 0 && line[length - 1] === 0x0d ? length - 1 : length;
            const parsed = await this.#parseLine(line.subarray(0, payloadLength));
            length = 0;
            if (parsed === undefined) continue;
            if (await this.#handleHistory(parsed)) continue;
            if (await this.#handleAppControl(parsed)) continue;
            yield parsed;
            continue;
          }
          if (length === this.#maxLineBytes && byte !== 0x0d) {
            await this.#failClosed('overlong_line');
            return;
          }
          if (length > this.#maxLineBytes) {
            await this.#failClosed('overlong_line');
            return;
          }
          line[length++] = byte;
        }
      }
      if (!this.#closed && length > 0) {
        const payloadLength = line[length - 1] === 0x0d ? length - 1 : length;
        const parsed = await this.#parseLine(line.subarray(0, payloadLength));
        if (
          parsed !== undefined &&
          !(await this.#handleHistory(parsed)) &&
          !(await this.#handleAppControl(parsed))
        )
          yield parsed;
      }
    } catch {
      if (!this.#closed) await this.#failClosed('input_failure');
    } finally {
      this.#readingComplete = true;
    }
  }

  async #parseLine(line: Uint8Array): Promise<unknown | undefined> {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line);
    } catch {
      await this.#failClosed('invalid_utf8');
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      try {
        await this.#writeProtocol(parseErrorResponse());
      } catch {
        await this.#failClosed('stdout_failure');
      }
      return undefined;
    }
  }

  async #handleHistory(value: unknown): Promise<boolean> {
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    if (typeof candidate.method !== 'string' || !candidate.method.startsWith('history/')) {
      return false;
    }
    const decoded = RUNTIME_PROTOCOL_REQUEST_SCHEMA_.safeParse(value);
    if (!decoded.success || !decoded.data.method.startsWith('history/')) {
      await this.#writeError(
        typeof candidate.id === 'string' ? candidate.id : null,
        'invalid_params',
      );
      return true;
    }
    const request = decoded.data;
    if (this.#connection?.state !== 'active') {
      await this.#writeError(request.id, 'not_initialized');
      return true;
    }
    const history = this.#options.history;
    if (!history) {
      await this.#writeError(request.id, 'method_not_found');
      return true;
    }
    try {
      const result =
        request.method === 'history/list_sessions'
          ? await history.listSessions(request.params.request)
          : request.method === 'history/list_events'
            ? await history.listEvents(request.params.request)
            : request.method === 'history/load_session'
              ? await history.loadSession(request.params.sessionId)
              : undefined;
      if (result === undefined) {
        await this.#writeError(request.id, 'method_not_found');
        return true;
      }
      await this.#writeProtocol({
        jsonrpc: '2.0',
        id: request.id,
        result: RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse(result),
      });
    } catch {
      await this.#writeError(request.id, 'internal_error');
    }
    return true;
  }

  async #handleAppControl(value: unknown): Promise<boolean> {
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    if (typeof candidate.method !== 'string' || !candidate.method.startsWith('app/')) {
      return false;
    }
    const decoded = RUNTIME_PROTOCOL_REQUEST_SCHEMA_.safeParse(value);
    if (
      !decoded.success ||
      !RUNTIME_PROTOCOL_APP_CONTROL_METHOD_SCHEMA_.safeParse(decoded.data.method).success
    ) {
      await this.#writeError(
        typeof candidate.id === 'string' ? candidate.id : null,
        'invalid_params',
      );
      return true;
    }
    const request = decoded.data as Extract<
      typeof decoded.data,
      { readonly method: RuntimeProtocolAppControlMethod }
    >;
    if (this.#connection?.state !== 'active') {
      await this.#writeError(request.id, 'not_initialized');
      return true;
    }
    const appControl = this.#options.appControl;
    if (!appControl) {
      await this.#writeError(request.id, 'method_not_found');
      return true;
    }
    try {
      const response = await dispatchAppControl(appControl, request.method, request.params.request);
      await this.#writeProtocol({
        jsonrpc: '2.0',
        id: request.id,
        result: RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse({ method: request.method, response }),
      });
    } catch (error) {
      await this.#writeError(
        request.id,
        error instanceof AppControlProtocolRequestError ? 'invalid_params' : 'internal_error',
      );
    }
    return true;
  }

  #writeError(id: string | null, code: keyof typeof RUNTIME_PROTOCOL_ERROR_NUMBERS): Promise<void> {
    const messages: Record<keyof typeof RUNTIME_PROTOCOL_ERROR_NUMBERS, string> = {
      parse_error: 'Parse error',
      invalid_request: 'Invalid request',
      method_not_found: 'Method not found',
      invalid_params: 'Invalid params',
      internal_error: 'Internal error',
      overloaded: 'Overloaded',
      not_initialized: 'Not initialized',
      already_initialized: 'Already initialized',
      protocol_version_mismatch: 'Protocol version mismatch',
      unauthorized: 'Unauthorized',
      subscription_unavailable: 'Subscription unavailable',
      resync_required: 'Resync required',
    };
    return this.#writeProtocol({
      jsonrpc: '2.0',
      id,
      error: RUNTIME_PROTOCOL_ERROR_SCHEMA_.parse({
        code: RUNTIME_PROTOCOL_ERROR_NUMBERS[code],
        message: messages[code],
        data: { code },
      }),
    });
  }

  async #failClosed(diagnostic: string): Promise<void> {
    this.#diagnose(diagnostic);
    await this.close();
  }

  #writeProtocol(message: RuntimeProtocolMessage): Promise<void> {
    const operation = this.#outputTail.then(async () => {
      const encoded = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
      const accepted = await this.#options.stdout.write(encoded);
      if (!accepted) await this.#waitForDrain();
    });
    this.#outputTail = operation.catch(() => undefined);
    return operation;
  }

  async #waitForDrain(): Promise<void> {
    if (!this.#options.stdout.waitForDrain) {
      throw new Error('stdout does not provide a drain waiter.');
    }
    await withDeadline(this.#options.stdout.waitForDrain(), this.#drainDeadlineMs);
  }

  async #flushOutput(): Promise<void> {
    await withDeadline(this.#outputTail, this.#drainDeadlineMs);
    if (this.#options.stdout.flush) {
      await withDeadline(this.#options.stdout.flush(), this.#drainDeadlineMs);
    }
  }

  #removeSignalHandlers(): void {
    for (const unsubscribe of this.#unsubscribeSignals.splice(0)) unsubscribe();
  }

  #diagnose(code: string): void {
    try {
      this.#options.stderr?.write(`kite runtime stdio carrier: ${code}\n`);
    } catch {
      // stderr is diagnostic-only; a failed diagnostic must never enter stdout.
    }
  }
}

async function dispatchAppControl(
  client: KiteAppControlClient,
  method: RuntimeProtocolAppControlMethod,
  input: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  switch (method) {
    case 'app/workspace_trust/query':
      return invokeAppControlCodec(
        input,
        workspaceTrustQueryRequestCodec,
        workspaceTrustQueryResponseCodec,
        (request) => client.queryWorkspaceTrust(request),
      );
    case 'app/workspace_trust/decide':
      return invokeAppControlCodec(
        input,
        workspaceTrustDecisionRequestCodec,
        workspaceTrustDecisionResponseCodec,
        (request) => client.decideWorkspaceTrust(request),
      );
    case 'app/provider_model/snapshot':
      return invokeAppControlCodec(
        input,
        providerModelSnapshotRequestCodec,
        providerModelSnapshotResponseCodec,
        (request) => client.getProviderModelSnapshot(request),
      );
    case 'app/provider_model/select':
      return invokeAppControlCodec(
        input,
        providerModelSelectRequestCodec,
        providerModelSelectResponseCodec,
        (request) => client.selectProviderModel(request),
      );
    case 'app/mcp/snapshot':
      return invokeAppControlCodec(
        input,
        mcpSnapshotRequestCodec,
        mcpSnapshotResponseCodec,
        (request) => client.getMcpSnapshot(request),
      );
    case 'app/mcp/action':
      return invokeAppControlCodec(
        input,
        mcpActionRequestCodec,
        mcpActionResponseCodec,
        (request) => client.applyMcpAction(request),
      );
    case 'app/skills/catalog':
      return invokeAppControlCodec(
        input,
        skillCatalogRequestCodec,
        skillCatalogResponseCodec,
        (request) => client.getSkillCatalog(request),
      );
    case 'app/execution/status':
      return invokeAppControlCodec(
        input,
        executionStatusRequestCodec,
        executionStatusResponseCodec,
        (request) => client.getExecutionStatus(request),
      );
    case 'app/release/status':
      return invokeAppControlCodec(
        input,
        releaseStatusRequestCodec,
        releaseStatusResponseCodec,
        (request) => client.getReleaseStatus(request),
      );
  }
}

async function invokeAppControlCodec<Request, ResponseValue>(
  input: unknown,
  requestCodec: ExactJsonCodec<Request>,
  responseCodec: ExactJsonCodec<ResponseValue>,
  operation: (request: Request) => Promise<ResponseValue>,
): Promise<Readonly<Record<string, unknown>>> {
  let request: Request;
  try {
    request = requestCodec.decode(input);
  } catch (error) {
    if (error instanceof KiteAppContractValidationError) {
      throw new AppControlProtocolRequestError();
    }
    throw error;
  }
  return responseCodec.encode(await operation(request));
}

class AppControlProtocolRequestError extends Error {
  constructor() {
    super('App Control request is invalid.');
    this.name = 'AppControlProtocolRequestError';
  }
}

function parseErrorResponse(): RuntimeProtocolMessage {
  return {
    jsonrpc: '2.0',
    id: null,
    error: RUNTIME_PROTOCOL_ERROR_SCHEMA_.parse({
      code: RUNTIME_PROTOCOL_ERROR_NUMBERS.parse_error,
      message: 'Parse error',
      data: { code: 'parse_error' },
    }),
  };
}

function chunkIterator(input: RuntimeStdioInput): AsyncIterator<Uint8Array> {
  const stream = input as ReadableStream<Uint8Array>;
  if (typeof stream.getReader !== 'function')
    return (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const reader = stream.getReader();
  return {
    next: async () => {
      const next = await reader.read();
      return next.done ? { done: true, value: undefined } : { done: false, value: next.value };
    },
    return: async () => {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
      return { done: true, value: undefined };
    },
  };
}

async function withDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('stdio drain deadline exceeded')), deadlineMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
