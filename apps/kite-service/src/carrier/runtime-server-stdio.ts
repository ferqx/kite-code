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
  providerModelSetEnabledRequestCodec,
  providerModelSetEnabledResponseCodec,
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
import {
  decodeLocalRuntimeCredentialRequest,
  encodeLocalRuntimeCredentialResult,
  type NativeProviderCredentialClient,
  type NativeProviderCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { RuntimeHistorySessionTranscript } from '@kite-ai/runtime-contract';
import {
  RUNTIME_PROTOCOL_APP_METHOD_SCHEMA_,
  RUNTIME_PROTOCOL_ERROR_NUMBERS,
  RUNTIME_PROTOCOL_ERROR_SCHEMA_,
  RUNTIME_PROTOCOL_LIMITS,
  RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_,
  RUNTIME_PROTOCOL_REQUEST_SCHEMA_,
  RUNTIME_PROTOCOL_RESULT_SCHEMA_,
  RUNTIME_PROTOCOL_WORKSPACE_REMOVAL_RESULT_SCHEMA_,
  type RuntimeProtocolAppControlMethod,
  type RuntimeProtocolAppMethod,
  type RuntimeProtocolMessage,
  type RuntimeProtocolServerControlMethod,
  type RuntimeProtocolWorkspaceRemovalRequest,
} from '@kite-ai/runtime-protocol';
import type {
  RuntimeServer,
  RuntimeServerConnection,
  RuntimeServerLogicalMessageConnection,
  RuntimeServerOpenOptions,
} from '@kite-ai/runtime-server';
import type { KiteHistoryPageClient } from '../runtime-client/history-page-pool';

const DEFAULT_DRAIN_DEADLINE_MS = 5_000;
const MAX_PENDING_HISTORY_READS = 256;
const MAX_PENDING_APP_READS = 64;
const MAX_QUEUED_HISTORY_READ_BYTES = 3 * 1024 * 1024;
const MAX_QUEUED_APP_READ_BYTES = 1024 * 1024;
const MAX_ACTIVE_HISTORY_READS = 48;
const MAX_ACTIVE_APP_READS = 16;
const MAX_GLOBAL_HISTORY_READS = 8;
const MAX_GLOBAL_HISTORY_PENDING = 1024;
const MAX_GLOBAL_HISTORY_PENDING_BYTES = 12 * 1024 * 1024;
const MAX_GLOBAL_APP_READS = 16;
const MAX_GLOBAL_APP_PENDING = 256;
const MAX_GLOBAL_APP_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_READ_MS = 10_000;
const MAX_QUEUED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_OUTPUT_FRAMES = 2048;
const MAX_GLOBAL_QUEUED_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_GLOBAL_QUEUED_OUTPUT_FRAMES = 8192;

type CarrierReadKind = 'history' | 'app';

type QueuedCarrierRead = Readonly<{
  bytes: number;
  kind: CarrierReadKind;
  run: () => Promise<unknown>;
  cancel: () => void;
  expire: () => void;
}>;

// A daemon shares one History client among its socket carriers. Keep the
// aggregate queue bounded and choose one request per connection per turn.
const HISTORY_READ_SCHEDULERS = new WeakMap<RuntimeHistoryClient, FairReadScheduler>();
const APP_READ_SCHEDULERS = new WeakMap<RuntimeServer, FairReadScheduler>();
const OUTPUT_BUDGETS = new WeakMap<RuntimeServer, OutputBudget>();

class OutputBudget {
  #bytes = 0;
  #frames = 0;

  reserve(bytes: number): boolean {
    if (
      this.#bytes + bytes > MAX_GLOBAL_QUEUED_OUTPUT_BYTES ||
      this.#frames >= MAX_GLOBAL_QUEUED_OUTPUT_FRAMES
    )
      return false;
    this.#bytes += bytes;
    this.#frames++;
    return true;
  }

  release(bytes: number): void {
    this.#bytes -= bytes;
    this.#frames--;
  }
}

function outputBudget(server: RuntimeServer): OutputBudget {
  let budget = OUTPUT_BUDGETS.get(server);
  if (!budget) {
    budget = new OutputBudget();
    OUTPUT_BUDGETS.set(server, budget);
  }
  return budget;
}

function historyReadScheduler(history: RuntimeHistoryClient): FairReadScheduler {
  let scheduler = HISTORY_READ_SCHEDULERS.get(history);
  if (!scheduler) {
    scheduler = new FairReadScheduler(
      MAX_GLOBAL_HISTORY_READS,
      MAX_GLOBAL_HISTORY_PENDING,
      MAX_GLOBAL_HISTORY_PENDING_BYTES,
      true,
    );
    HISTORY_READ_SCHEDULERS.set(history, scheduler);
  }
  return scheduler;
}

function appReadScheduler(server: RuntimeServer): FairReadScheduler {
  let scheduler = APP_READ_SCHEDULERS.get(server);
  if (!scheduler) {
    scheduler = new FairReadScheduler(
      MAX_GLOBAL_APP_READS,
      MAX_GLOBAL_APP_PENDING,
      MAX_GLOBAL_APP_PENDING_BYTES,
      false,
    );
    APP_READ_SCHEDULERS.set(server, scheduler);
  }
  return scheduler;
}

class FairReadScheduler {
  readonly maxActive: number;
  readonly maxPending: number;
  readonly maxPendingBytes: number;
  readonly releaseRunningOnCancel: boolean;
  readonly #queues = new Map<object, QueuedCarrierRead[]>();
  readonly #owners: object[] = [];
  readonly #running = new Map<QueuedCarrierRead, { owner: object; finish: () => void }>();
  readonly #waitTimers = new Map<QueuedCarrierRead, ReturnType<typeof setTimeout>>();
  #pending = 0;
  #pendingBytes = 0;
  #active = 0;
  #scheduled = false;

  constructor(
    maxActive: number,
    maxPending: number,
    maxPendingBytes: number,
    releaseRunningOnCancel: boolean,
  ) {
    this.maxActive = maxActive;
    this.maxPending = maxPending;
    this.maxPendingBytes = maxPendingBytes;
    this.releaseRunningOnCancel = releaseRunningOnCancel;
  }

  canAdmit(bytes: number): boolean {
    return this.#pending < this.maxPending && this.#pendingBytes + bytes <= this.maxPendingBytes;
  }

  enqueue(owner: object, read: QueuedCarrierRead): boolean {
    if (!this.canAdmit(read.bytes)) return false;
    const queue = this.#queues.get(owner);
    if (queue) queue.push(read);
    else {
      this.#queues.set(owner, [read]);
      this.#owners.push(owner);
    }
    this.#pending++;
    this.#pendingBytes += read.bytes;
    this.#waitTimers.set(
      read,
      setTimeout(() => {
        if (!this.remove(owner, read)) return;
        read.expire();
        this.#schedule();
      }, MAX_HISTORY_READ_MS),
    );
    this.#schedule();
    return true;
  }

  cancel(owner: object): void {
    const queue = this.#queues.get(owner);
    if (queue) {
      this.#queues.delete(owner);
      const index = this.#owners.indexOf(owner);
      if (index >= 0) this.#owners.splice(index, 1);
      for (const read of queue) {
        this.#clearWaitTimer(read);
        this.#pending--;
        this.#pendingBytes -= read.bytes;
        read.cancel();
      }
    }
    for (const [read, running] of this.#running) {
      if (running.owner !== owner) continue;
      read.cancel();
      if (this.releaseRunningOnCancel) running.finish();
    }
  }

  remove(owner: object, read: QueuedCarrierRead): boolean {
    const queue = this.#queues.get(owner);
    const index = queue?.indexOf(read) ?? -1;
    if (!queue || index < 0) return false;
    queue.splice(index, 1);
    this.#clearWaitTimer(read);
    this.#pending--;
    this.#pendingBytes -= read.bytes;
    if (queue.length === 0) {
      this.#queues.delete(owner);
      const ownerIndex = this.#owners.indexOf(owner);
      if (ownerIndex >= 0) this.#owners.splice(ownerIndex, 1);
    }
    return true;
  }

  cancelRead(owner: object, read: QueuedCarrierRead): void {
    if (this.remove(owner, read)) {
      read.cancel();
      return;
    }
    const running = this.#running.get(read);
    if (running?.owner !== owner) return;
    read.cancel();
    if (this.releaseRunningOnCancel) running.finish();
  }

  #schedule(): void {
    if (this.#scheduled || this.#active >= this.maxActive || !this.#owners.length) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (this.#active >= this.maxActive || !this.#owners.length) return;
      const owner = this.#owners.shift()!;
      const queue = this.#queues.get(owner)!;
      const read = queue.shift()!;
      this.#clearWaitTimer(read);
      if (queue.length) this.#owners.push(owner);
      else this.#queues.delete(owner);
      this.#active++;
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        this.#running.delete(read);
        this.#active--;
        this.#pending--;
        this.#pendingBytes -= read.bytes;
        this.#schedule();
      };
      const timeout = setTimeout(() => {
        read.expire();
        if (this.releaseRunningOnCancel) finish();
      }, MAX_HISTORY_READ_MS);
      this.#running.set(read, { owner, finish });
      void read.run().finally(finish);
      this.#schedule();
    });
  }

  #clearWaitTimer(read: QueuedCarrierRead): void {
    const timer = this.#waitTimers.get(read);
    if (timer) clearTimeout(timer);
    this.#waitTimers.delete(read);
  }
}

/** Keep source records intact and leave room for the JSON-RPC envelope. */
function historyTranscriptPage(transcript: RuntimeHistorySessionTranscript, afterSequence = 0) {
  const { events: _events, records: source, ...metadata } = transcript;
  const records: RuntimeHistorySessionTranscript['records'][number][] = [];
  const page = { type: 'history_session_page' as const, ...metadata, records };
  const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  let bytes = byteLength(page);
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source[middle]!.sequence <= afterSequence) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < source.length; index++) {
    const record = source[index]!;
    const size = byteLength(record) + 1;
    if (bytes + size > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes - 65_536 || records.length === 512) {
      const last = records.at(-1);
      if (!last) throw new Error('History record exceeds the protocol frame limit.');
      return { ...page, nextCursor: last.sequence };
    }
    records.push(record);
    bytes += size;
  }
  return page;
}

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
  readonly history?: RuntimeHistoryClient & Partial<KiteHistoryPageClient>;
  /** KASD App Server-only exact no-secret control surface on this connection. */
  readonly appControl?: KiteAppControlClient;
  /** KASD App Server-only Workspace removal lifecycle. */
  readonly removeWorkspace?: (
    request: RuntimeProtocolWorkspaceRemovalRequest,
  ) => Promise<{ readonly deletedSessions: number; readonly token: string }>;
  /** Native-only first-run credential owner; secret material is never returned. */
  readonly credential?: NativeProviderCredentialClient;
  readonly serverControl?: Readonly<{
    dispatch(
      method: RuntimeProtocolServerControlMethod,
      request: Readonly<Record<string, unknown>>,
    ): Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  }>;
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
    historyCancellation: options.history !== undefined,
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
  readonly #historyScheduler: FairReadScheduler | undefined;
  readonly #appScheduler: FairReadScheduler;
  readonly #outputBudget: OutputBudget;
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
  #pendingReads = new Set<Promise<unknown>>();
  #historyReadsById = new Map<string, QueuedCarrierRead>();
  #queuedReads: Record<CarrierReadKind, QueuedCarrierRead[]> = { history: [], app: [] };
  #queuedReadBytes: Record<CarrierReadKind, number> = { history: 0, app: 0 };
  #pendingReadCount: Record<CarrierReadKind, number> = { history: 0, app: 0 };
  #activeReads: Record<CarrierReadKind, number> = { history: 0, app: 0 };
  #queuedOutputBytes = 0;
  #queuedOutputFrames = 0;

  constructor(options: RuntimeStdioCarrierOptions) {
    this.#options = options;
    this.#historyScheduler = options.history ? historyReadScheduler(options.history) : undefined;
    this.#appScheduler = appReadScheduler(options.server);
    this.#outputBudget = outputBudget(options.server);
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
    this.#historyScheduler?.cancel(this);
    this.#appScheduler.cancel(this);
    this.#drainQueuedReads();
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
      await withDeadline(Promise.allSettled(this.#pendingReads), this.#drainDeadlineMs).catch(() =>
        this.#diagnose('read_drain_timeout'),
      );
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
    let framesSinceYield = 0;
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
          if (this.#closed) return;
          if (byte === 0x0a) {
            // One OS read may contain thousands of JSONL requests. Yield to
            // Runtime responses, timers, and other connections periodically.
            if (++framesSinceYield === 64) {
              framesSinceYield = 0;
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (this.#closed) return;
            }
            const payloadLength = length > 0 && line[length - 1] === 0x0d ? length - 1 : length;
            const parsed = await this.#parseLine(line.subarray(0, payloadLength));
            length = 0;
            if (parsed === undefined) continue;
            if (this.#handleHistoryCancellation(parsed)) continue;
            if (await this.#dispatchRead(parsed, payloadLength)) continue;
            if (await this.#handleHistory(parsed)) continue;
            if (await this.#handleAppControl(parsed)) continue;
            if (await this.#handleServerControl(parsed)) continue;
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
          !this.#handleHistoryCancellation(parsed) &&
          !(await this.#dispatchRead(parsed, payloadLength)) &&
          !(await this.#handleHistory(parsed)) &&
          !(await this.#handleAppControl(parsed)) &&
          !(await this.#handleServerControl(parsed))
        )
          yield parsed;
      }
    } catch {
      if (!this.#closed) await this.#failClosed('input_failure');
    } finally {
      await withDeadline(Promise.allSettled(this.#pendingReads), this.#drainDeadlineMs).catch(() =>
        this.#diagnose('read_drain_timeout'),
      );
      this.#readingComplete = true;
    }
  }

  #handleHistoryCancellation(value: unknown): boolean {
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    if (candidate?.method !== 'history/cancel') return false;
    const decoded = RUNTIME_PROTOCOL_NOTIFICATION_SCHEMA_.safeParse(value);
    if (!decoded.success) {
      if (candidate && Object.hasOwn(candidate, 'id'))
        void this.#writeError(
          typeof candidate.id === 'string' ? candidate.id : null,
          'invalid_request',
        ).catch(() => this.#diagnose('stdout_failure'));
      return true;
    }
    if (this.#connection?.state !== 'active' || decoded.data.method !== 'history/cancel')
      return true;
    const read = this.#historyReadsById.get(decoded.data.params.requestId);
    if (!read) return true;
    this.#historyScheduler?.cancelRead(this, read);
    return true;
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

  #dispatchRead(value: unknown, frameBytes: number): boolean {
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    const method = candidate?.method;
    if (
      typeof method !== 'string' ||
      !(
        method.startsWith('history/') ||
        [
          'app/workspace_trust/query',
          'app/provider_model/snapshot',
          'app/mcp/snapshot',
          'app/skills/catalog',
          'app/execution/status',
          'app/release/status',
        ].includes(method)
      )
    )
      return false;
    // Keep separate execution and admission reservations so slow capability
    // reads cannot consume History capacity, and long History reads leave room
    // for capability status. Neither queue blocks protocol frame parsing.
    const kind: CarrierReadKind = method.startsWith('history/') ? 'history' : 'app';
    if (
      kind === 'history' &&
      typeof candidate.id === 'string' &&
      this.#historyReadsById.has(candidate.id)
    ) {
      void this.#writeError(candidate.id, 'invalid_request').catch(() =>
        this.#diagnose('stdout_failure'),
      );
      return true;
    }
    const maxPending = kind === 'history' ? MAX_PENDING_HISTORY_READS : MAX_PENDING_APP_READS;
    const maxQueuedBytes =
      kind === 'history' ? MAX_QUEUED_HISTORY_READ_BYTES : MAX_QUEUED_APP_READ_BYTES;
    const scheduler = kind === 'history' ? this.#historyScheduler : this.#appScheduler;
    if (
      this.#pendingReadCount[kind] >= maxPending ||
      this.#queuedReadBytes[kind] + frameBytes > maxQueuedBytes ||
      (scheduler !== undefined && !scheduler.canAdmit(frameBytes))
    ) {
      void this.#writeError(
        typeof candidate.id === 'string' ? candidate.id : null,
        'overloaded',
      ).catch(() => this.#diagnose('stdout_failure'));
      return true;
    }
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    const complete = () => {
      if (!this.#pendingReads.delete(pending)) return;
      this.#pendingReadCount[kind]--;
      resolvePending();
    };
    this.#pendingReads.add(pending);
    this.#pendingReadCount[kind]++;
    let started = false;
    let cancelled = false;
    let settled = false;
    let responseQueued = false;
    const abort = kind === 'history' ? new AbortController() : undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (started) this.#activeReads[kind]--;
      if (
        kind === 'history' &&
        typeof candidate.id === 'string' &&
        this.#historyReadsById.get(candidate.id) === queued
      )
        this.#historyReadsById.delete(candidate.id);
      complete();
      this.#drainQueuedReads();
    };
    const queued: QueuedCarrierRead = {
      bytes: frameBytes,
      kind,
      run: () => {
        started = true;
        this.#queuedReadBytes[kind] -= frameBytes;
        this.#activeReads[kind]++;
        return (
          kind === 'history'
            ? this.#handleHistory(
                value,
                () => cancelled,
                abort?.signal,
                () => {
                  responseQueued = true;
                },
              )
            : this.#handleAppControl(
                value,
                () => cancelled,
                () => {
                  responseQueued = true;
                },
              )
        )
          .catch(() => this.#diagnose('read_failure'))
          .finally(settle);
      },
      cancel: () => {
        cancelled = true;
        abort?.abort();
        if (!started) this.#queuedReadBytes[kind] -= frameBytes;
        settle();
      },
      expire: () => {
        cancelled = true;
        abort?.abort();
        if (!started) this.#queuedReadBytes[kind] -= frameBytes;
        settle();
        if (typeof candidate.id === 'string' && !responseQueued)
          void this.#writeError(candidate.id, 'internal_error', {
            detailCode: 'temporarily_unavailable',
            retryable: true,
          }).catch(() => this.#diagnose('stdout_failure'));
      },
    };
    this.#queuedReadBytes[kind] += frameBytes;
    if (kind === 'history' && typeof candidate.id === 'string')
      this.#historyReadsById.set(candidate.id, queued);
    if (scheduler) {
      if (!scheduler.enqueue(this, queued)) {
        queued.cancel();
        void this.#writeError(
          typeof candidate.id === 'string' ? candidate.id : null,
          'overloaded',
        ).catch(() => this.#diagnose('stdout_failure'));
      }
    } else {
      this.#queuedReads[kind].push(queued);
      this.#drainQueuedReads();
    }
    return true;
  }

  #drainQueuedReads(): void {
    if (this.#closed) {
      for (const kind of ['history', 'app'] as const) {
        for (const queued of this.#queuedReads[kind].splice(0)) queued.cancel();
      }
      return;
    }
    for (const kind of ['history', 'app'] as const) {
      const maxActive = kind === 'history' ? MAX_ACTIVE_HISTORY_READS : MAX_ACTIVE_APP_READS;
      while (this.#activeReads[kind] < maxActive && this.#queuedReads[kind].length > 0) {
        const queued = this.#queuedReads[kind].shift()!;
        void queued.run();
      }
    }
  }

  async #handleHistory(
    value: unknown,
    isCancelled: () => boolean = () => false,
    signal?: AbortSignal,
    onResponseQueued: () => void = () => undefined,
  ): Promise<boolean> {
    if (isCancelled()) return true;
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    if (typeof candidate.method !== 'string' || !candidate.method.startsWith('history/')) {
      return false;
    }
    const decoded = RUNTIME_PROTOCOL_REQUEST_SCHEMA_.safeParse(value);
    if (!decoded.success || !decoded.data.method.startsWith('history/')) {
      onResponseQueued();
      await this.#writeError(
        typeof candidate.id === 'string' ? candidate.id : null,
        'invalid_params',
      );
      return true;
    }
    const request = decoded.data;
    if (this.#connection?.state !== 'active') {
      onResponseQueued();
      await this.#writeError(request.id, 'not_initialized');
      return true;
    }
    const history = this.#options.history;
    if (!history) {
      onResponseQueued();
      await this.#writeError(request.id, 'method_not_found');
      return true;
    }
    if (request.method === 'history/load_child_session' && !history.loadChildSession) {
      onResponseQueued();
      await this.#writeError(request.id, 'method_not_found');
      return true;
    }
    try {
      const pageRead =
        (request.method === 'history/load_session' ||
          request.method === 'history/load_child_session') &&
        request.params.page !== undefined &&
        history.loadSessionPage !== undefined;
      const fullRead =
        (request.method === 'history/load_session' ||
          request.method === 'history/load_child_session') &&
        request.params.page === undefined &&
        history.loadSessionFull !== undefined;
      const result = pageRead
        ? await history.loadSessionPage!(
            {
              sessionId:
                request.method === 'history/load_session'
                  ? request.params.sessionId
                  : request.params.childSessionId,
              ...(request.method === 'history/load_child_session'
                ? { parentSessionId: request.params.parentSessionId }
                : {}),
              ...(request.params.page?.throughSequence === undefined
                ? {}
                : { throughSequence: request.params.page.throughSequence }),
              ...(request.params.page?.afterSequence === undefined
                ? {}
                : { afterSequence: request.params.page.afterSequence }),
              ...(request.params.page?.snapshotDigest === undefined
                ? {}
                : { snapshotDigest: request.params.page.snapshotDigest }),
            },
            { signal },
          )
        : fullRead
          ? await history.loadSessionFull!(
              {
                sessionId:
                  request.method === 'history/load_session'
                    ? request.params.sessionId
                    : request.params.childSessionId,
                ...(request.method === 'history/load_child_session'
                  ? { parentSessionId: request.params.parentSessionId }
                  : {}),
              },
              { signal },
            )
          : request.method === 'history/list_sessions'
            ? request.params.request.query?.trim() && history.searchSessions
              ? await history.searchSessions(request.params.request, { signal })
              : await history.listSessions(request.params.request)
            : request.method === 'history/list_events'
              ? await history.listEvents(request.params.request)
              : request.method === 'history/load_session'
                ? await history.loadSession(
                    request.params.sessionId,
                    request.params.page?.throughSequence,
                  )
                : request.method === 'history/load_child_session'
                  ? await history.loadChildSession!(
                      request.params.parentSessionId,
                      request.params.childSessionId,
                      request.params.page?.throughSequence,
                    )
                  : undefined;
      if (result === undefined) {
        if (isCancelled()) return true;
        onResponseQueued();
        await this.#writeError(request.id, 'method_not_found');
        return true;
      }
      if (isCancelled()) return true;
      if (
        (request.method === 'history/load_session' ||
          request.method === 'history/load_child_session') &&
        request.params.page?.afterSequence !== undefined &&
        request.params.page.snapshotDigest !== undefined
      ) {
        const digest = (result as RuntimeHistorySessionTranscript).snapshotDigest;
        if (digest && request.params.page.snapshotDigest !== digest) {
          throw Object.assign(new Error('History snapshot changed during pagination.'), {
            code: 'history_snapshot_changed',
          });
        }
      }
      const response =
        !pageRead &&
        (request.method === 'history/load_session' ||
          request.method === 'history/load_child_session') &&
        request.params.page
          ? historyTranscriptPage(
              result as RuntimeHistorySessionTranscript,
              request.params.page.afterSequence,
            )
          : result;
      onResponseQueued();
      await this.#writeProtocol({
        jsonrpc: '2.0',
        id: request.id,
        result: RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse(response),
      });
    } catch (error) {
      if (isCancelled()) return true;
      onResponseQueued();
      await this.#writeError(
        request.id,
        'internal_error',
        readFailure(error, 'session_unavailable'),
      );
    }
    return true;
  }

  async #handleAppControl(
    value: unknown,
    isCancelled: () => boolean = () => false,
    onResponseQueued: () => void = () => undefined,
  ): Promise<boolean> {
    if (isCancelled()) return true;
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    if (typeof candidate.method !== 'string' || !candidate.method.startsWith('app/')) {
      return false;
    }
    const decoded = RUNTIME_PROTOCOL_REQUEST_SCHEMA_.safeParse(value);
    if (
      !decoded.success ||
      !RUNTIME_PROTOCOL_APP_METHOD_SCHEMA_.safeParse(decoded.data.method).success
    ) {
      onResponseQueued();
      await this.#writeError(
        typeof candidate.id === 'string' ? candidate.id : null,
        'invalid_params',
      );
      return true;
    }
    const request = decoded.data as Extract<
      typeof decoded.data,
      { readonly method: RuntimeProtocolAppMethod }
    >;
    if (this.#connection?.state !== 'active') {
      onResponseQueued();
      await this.#writeError(request.id, 'not_initialized');
      return true;
    }
    if (
      (request.method === 'app/provider_credential/write' && !this.#options.credential) ||
      (request.method === 'app/workspace/remove' && !this.#options.removeWorkspace) ||
      (request.method !== 'app/provider_credential/write' &&
        request.method !== 'app/workspace/remove' &&
        !this.#options.appControl)
    ) {
      onResponseQueued();
      await this.#writeError(request.id, 'method_not_found');
      return true;
    }
    try {
      const response =
        request.method === 'app/provider_credential/write'
          ? await dispatchProviderCredential(this.#options.credential!, request.params.request)
          : request.method === 'app/workspace/remove'
            ? RUNTIME_PROTOCOL_WORKSPACE_REMOVAL_RESULT_SCHEMA_.parse(
                await this.#options.removeWorkspace!(request.params.request),
              )
            : await dispatchAppControl(
                this.#options.appControl!,
                request.method,
                request.params.request,
              );
      if (isCancelled()) return true;
      onResponseQueued();
      await this.#writeProtocol({
        jsonrpc: '2.0',
        id: request.id,
        result: RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse({ method: request.method, response }),
      });
    } catch (error) {
      if (isCancelled()) return true;
      onResponseQueued();
      await this.#writeError(
        request.id,
        error instanceof AppControlProtocolRequestError ? 'invalid_params' : 'internal_error',
        request.method === 'app/workspace_trust/query'
          ? readFailure(error, 'workspace_unavailable')
          : request.method === 'app/provider_model/snapshot'
            ? readFailure(error, 'configuration_unavailable')
            : undefined,
      );
    }
    return true;
  }

  async #handleServerControl(value: unknown): Promise<boolean> {
    const candidate = value as { readonly method?: unknown; readonly id?: unknown };
    if (candidate.method !== 'server/status' && candidate.method !== 'server/shutdown') {
      return false;
    }
    const decoded = RUNTIME_PROTOCOL_REQUEST_SCHEMA_.safeParse(value);
    if (!decoded.success) {
      await this.#writeError(
        typeof candidate.id === 'string' ? candidate.id : null,
        'invalid_params',
      );
      return true;
    }
    const request = decoded.data as Extract<
      typeof decoded.data,
      { readonly method: RuntimeProtocolServerControlMethod }
    >;
    if (this.#connection?.state !== 'active') {
      await this.#writeError(request.id, 'not_initialized');
      return true;
    }
    if (!this.#options.serverControl) {
      await this.#writeError(request.id, 'method_not_found');
      return true;
    }
    try {
      const response = await this.#options.serverControl.dispatch(
        request.method,
        request.params.request,
      );
      await this.#writeProtocol({
        jsonrpc: '2.0',
        id: request.id,
        result: RUNTIME_PROTOCOL_RESULT_SCHEMA_.parse({ method: request.method, response }),
      });
    } catch {
      await this.#writeError(request.id, 'invalid_params');
    }
    return true;
  }

  #writeError(
    id: string | null,
    code: keyof typeof RUNTIME_PROTOCOL_ERROR_NUMBERS,
    detail?: ReturnType<typeof readFailure>,
  ): Promise<void> {
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
        data: { code, ...detail },
      }),
    });
  }

  async #failClosed(diagnostic: string): Promise<void> {
    this.#diagnose(diagnostic);
    await this.close();
  }

  #writeProtocol(message: RuntimeProtocolMessage): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const encoded = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (
      this.#queuedOutputFrames >= MAX_QUEUED_OUTPUT_FRAMES ||
      this.#queuedOutputBytes + encoded.byteLength > MAX_QUEUED_OUTPUT_BYTES ||
      !this.#outputBudget.reserve(encoded.byteLength)
    ) {
      void this.#failClosed('stdout_overloaded');
      return Promise.reject(new Error('runtime stdio output queue is full'));
    }
    this.#queuedOutputFrames++;
    this.#queuedOutputBytes += encoded.byteLength;
    const operation = this.#outputTail
      .then(async () => {
        const accepted = await this.#options.stdout.write(encoded);
        if (!accepted) await this.#waitForDrain();
      })
      .finally(() => {
        this.#queuedOutputFrames--;
        this.#queuedOutputBytes -= encoded.byteLength;
        this.#outputBudget.release(encoded.byteLength);
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

async function dispatchProviderCredential(
  client: NativeProviderCredentialClient,
  input: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  let request: NativeProviderCredentialRequest;
  try {
    const decoded = decodeLocalRuntimeCredentialRequest(input);
    if (decoded.operation !== 'write_provider_api_key') {
      throw new TypeError('App Server accepts only provider credential writes.');
    }
    request = decoded;
  } catch {
    throw new AppControlProtocolRequestError();
  }
  return encodeLocalRuntimeCredentialResult(await client.writeProviderCredential(request));
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
    case 'app/provider_model/set_enabled':
      return invokeAppControlCodec(
        input,
        providerModelSetEnabledRequestCodec,
        providerModelSetEnabledResponseCodec,
        (request) => client.setProviderModelEnabled(request),
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
  if (typeof stream.getReader !== 'function') {
    const source = input as AsyncIterable<Uint8Array> & { destroy?: () => void };
    const iterator = source[Symbol.asyncIterator]();
    if (typeof source.destroy !== 'function') return iterator;
    return {
      next: () => iterator.next(),
      return: async () => {
        // Node's iterator.return() queues behind a pending next(). Destroy the
        // owned pipe/socket first so closing a failed peer never needs another
        // client request to wake its read loop and release connection accounting.
        source.destroy?.();
        return (await iterator.return?.()) ?? { done: true, value: undefined };
      },
    };
  }
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

function readFailure(
  error: unknown,
  fallback: 'session_unavailable' | 'workspace_unavailable' | 'configuration_unavailable',
) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const detailCode =
    code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'temporarily_unavailable'
      ? 'temporarily_unavailable'
      : code === 'session_not_found' ||
          code === 'session_unavailable' ||
          code === 'corrupt_event' ||
          code === 'invalid_request' ||
          code === 'history_snapshot_changed' ||
          code === 'history_too_large'
        ? code
        : fallback;
  return { detailCode, retryable: detailCode === 'temporarily_unavailable' };
}
