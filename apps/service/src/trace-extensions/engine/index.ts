import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OwnedProcessIdentity,
  observeOwnedProcessIdentity,
} from '@kite-ai/agent/process-observation';
import {
  decimal64Schema,
  type TraceDeliveryResult,
  type TraceEventBatch,
  traceBatchSchema,
  validateDeliveryResult,
} from '@kite-ai/trajectory';
import { engineDigest, type TraceEngineAssets, verifyTraceEngineAssets } from './assets';
import {
  copyEngineJson,
  defaultEngineBudgets,
  type EngineJson,
  engineBudgetsSchema,
  runnerResponseSchema,
  type TraceEngineBudgets,
} from './protocol';

export { type TraceEngineAssets, verifyTraceEngineAssets } from './assets';
export { defaultEngineBudgets, type EngineJson, type TraceEngineBudgets } from './protocol';
export interface TraceEngineBundle {
  apiVersion: 1;
  source: string;
  sha256: string;
}
export interface TraceEngineExitEvidence {
  identity: OwnedProcessIdentity;
  exit: { code: number | null; signal: string | null; reaped: true } | null;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  stdinClosed: boolean;
  confirmed: boolean;
}
export interface TraceEngine {
  readonly generation: string;
  initialize(input: EngineJson, signal?: AbortSignal): Promise<void>;
  onEvents(batch: TraceEventBatch, signal?: AbortSignal): Promise<TraceDeliveryResult>;
  flush(signal?: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
  /** Retirement seals broker replies and new calls before stopping the exact original process. */
  retire(): Promise<TraceEngineExitEvidence>;
  readExitEvidence(): TraceEngineExitEvidence;
}
export class TraceEngineError extends Error {
  readonly code: string;
  readonly cleanup: TraceEngineExitEvidence | undefined;
  constructor(code: string, cleanup?: TraceEngineExitEvidence) {
    super(code);
    this.code = code;
    this.cleanup = cleanup;
  }
}
const occupied = new Map<string, object>();
/** No grant/queue authority lives here. The trusted caller supplies a narrow broker per installation. */
export async function createTraceEngine(options: {
  installationId: string;
  generation: string;
  assets: TraceEngineAssets;
  /** Trusted in-process composition. Guest bundles cannot select an executable. */
  executable?: string;
  bundle: TraceEngineBundle;
  budgets?: Partial<TraceEngineBudgets>;
  broker(
    method: string,
    input: EngineJson,
    context: { generation: string; signal: AbortSignal },
  ): Promise<EngineJson>;
}): Promise<TraceEngine> {
  const generation = decimal64Schema.parse(options.generation);
  if (
    !options.installationId ||
    options.installationId.length > 512 ||
    occupied.has(options.installationId)
  )
    throw new TraceEngineError('trace_engine_scope_busy');
  const budgets = engineBudgetsSchema.parse({ ...defaultEngineBudgets, ...options.budgets });
  const bundle = options.bundle;
  if (
    bundle.apiVersion !== 1 ||
    typeof bundle.source !== 'string' ||
    Buffer.byteLength(bundle.source) > 512 * 1024 ||
    engineDigest(bundle.source) !== bundle.sha256
  )
    throw new TraceEngineError('trace_engine_bundle_invalid');
  verifyTraceEngineAssets(options.assets);
  const assetRoot = realpathSync.native(options.assets.directory);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-trace-engine-')));
  const token = {};
  occupied.set(options.installationId, token);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      realpathSync.native(options.executable ?? process.execPath),
      ['--no-global-search-paths', join(assetRoot, 'runner.js')],
      {
        cwd: root,
        // Never inherit credentials, proxies, Node options, preload, or project configuration.
        env: {
          HOME: root,
          TMPDIR: root,
          TZ: 'UTC',
          ...(process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch {
    occupied.delete(options.installationId);
    rmSync(root, { recursive: true });
    throw new TraceEngineError('trace_engine_spawn_failed');
  }
  const identity = child.pid
    ? observeOwnedProcessIdentity(child.pid)
    : { pid: 0, parentPid: null, birth: null, unavailable: ['spawn_pending'] };
  let exit: TraceEngineExitEvidence['exit'] = null;
  let stdoutClosed = false,
    stderrClosed = false,
    stdinClosed = false;
  let retired = false,
    didReady = false;
  let buffer = Buffer.alloc(0),
    sequence = 0;
  let retirePromise: Promise<TraceEngineExitEvidence> | undefined;
  const brokerAbort = new AbortController();
  let resolveReady!: () => void, rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let pending:
    | {
        id: number;
        resolve(value: EngineJson): void;
        reject(reason: unknown): void;
        timer: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        abort(): void;
        calls: Set<number>;
        lastCall: number;
      }
    | undefined;
  const readExitEvidence = (): TraceEngineExitEvidence =>
    structuredClone({
      identity,
      exit,
      stdoutClosed,
      stderrClosed,
      stdinClosed,
      confirmed: !!exit && stdoutClosed && stderrClosed && stdinClosed,
    });
  const write = (value: unknown): Promise<void> => {
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame) > budgets.messageBytes)
      return Promise.reject(new TraceEngineError('trace_engine_message_limit'));
    if (retired) return Promise.reject(new TraceEngineError('trace_engine_retired'));
    return new Promise((resolve, reject) =>
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve())),
    );
  };
  const retire = () =>
    (retirePromise ??= (async () => {
      retired = true;
      brokerAbort.abort();
      rejectReady(new TraceEngineError('trace_engine_retired'));
      const original = pending;
      pending = undefined;
      if (original) {
        clearTimeout(original.timer);
        original.signal?.removeEventListener('abort', original.abort);
        original.reject(new TraceEngineError('trace_engine_retired'));
      }
      // The guest cannot create subprocesses. This handle owns only its original runner root.
      if (!exit) child.kill('SIGKILL');
      child.stdin.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      const evidence = readExitEvidence();
      if (evidence.confirmed) {
        if (occupied.get(options.installationId) === token) occupied.delete(options.installationId);
        rmSync(root, { recursive: true });
      }
      return evidence;
    })());
  const fail = (code: string) => {
    const error = new TraceEngineError(code);
    rejectReady(error);
    pending?.reject(error);
    void retire();
  };
  child.once('exit', (code, signal) => {
    exit = { code, signal, reaped: true };
  });
  child.once('close', () => {
    resolveClosed();
    if (!retired) fail('trace_engine_exited');
  });
  child.once('error', () => fail('trace_engine_process_error'));
  child.stdin.on('error', () => {
    if (!retired) fail('trace_engine_pipe_error');
  });
  child.stdin.once('close', () => {
    stdinClosed = true;
  });
  child.stdout.once('close', () => {
    stdoutClosed = true;
  });
  child.stderr.once('close', () => {
    stderrClosed = true;
  });
  child.stdout.on('error', () => fail('trace_engine_pipe_error'));
  child.stderr.on('error', () => fail('trace_engine_pipe_error'));
  // The runner emits finite failure codes, never arbitrary guest diagnostics or console output.
  let stderrBytes = 0;
  child.stderr.on('data', (bytes: Buffer) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 16384) fail('trace_engine_output_limit');
  });
  child.stdout.on('data', (bytes: Buffer) => {
    if (retired) return;
    try {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > budgets.messageBytes) throw Error('limit');
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const response = runnerResponseSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))),
        );
        buffer = buffer.subarray(end + 1);
        if (response.generation !== generation) throw Error('generation');
        if (response.type === 'ready') {
          if (didReady || pending) throw Error('ready');
          didReady = true;
          resolveReady();
          continue;
        }
        if (response.type === 'failed') {
          fail(`trace_engine_${response.code}`);
          return;
        }
        const call = pending;
        if (!didReady || !call || response.id !== call.id) throw Error('callback');
        if (response.type === 'result') {
          if (call.calls.size) throw Error('unawaited_broker');
          pending = undefined;
          clearTimeout(call.timer);
          call.signal?.removeEventListener('abort', call.abort);
          call.resolve(copyEngineJson(response.value, budgets.messageBytes));
        } else {
          if (
            response.callId !== call.lastCall + 1 ||
            call.calls.size >= budgets.brokerConcurrency ||
            response.callId > budgets.brokerCalls
          )
            throw Error('broker_limit');
          call.lastCall = response.callId;
          call.calls.add(response.callId);
          void Promise.resolve()
            .then(() => {
              if (retired || pending !== call || brokerAbort.signal.aborted) throw Error('retired');
              return options.broker(
                response.method,
                copyEngineJson(response.input, budgets.messageBytes),
                { generation, signal: brokerAbort.signal },
              );
            })
            .then(
              (value) => ({ value: copyEngineJson(value, budgets.messageBytes) }),
              () => ({ error: 'broker_rejected' as const }),
            )
            .then(async (result) => {
              if (retired || pending !== call || brokerAbort.signal.aborted) return;
              call.calls.delete(response.callId);
              await write({
                type: 'broker_result',
                id: call.id,
                callId: response.callId,
                ...result,
              });
            })
            .catch(() => {
              if (!retired) fail('trace_engine_broker_failed');
            });
        }
      }
    } catch {
      fail('trace_engine_protocol_error');
    }
  });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wasm = readFileSync(join(assetRoot, 'quickjs.wasm'));
    await write({
      type: 'initialize',
      generation,
      source: bundle.source,
      digest: bundle.sha256,
      wasmPath: join(assetRoot, 'quickjs.wasm'),
      wasmDigest: engineDigest(wasm),
      budgets,
    });
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new TraceEngineError('trace_engine_start_timeout')),
          budgets.callbackMs + 2000,
        );
      }),
    ]);
  } catch (cause) {
    const cleanup = await retire();
    throw new TraceEngineError(
      cause instanceof TraceEngineError ? cause.code : 'trace_engine_start_failed',
      cleanup,
    );
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }
  const call = (
    method: 'initialize' | 'onEvents' | 'flush' | 'shutdown',
    input: EngineJson,
    signal?: AbortSignal,
  ): Promise<EngineJson> => {
    if (retired) return Promise.reject(new TraceEngineError('trace_engine_retired'));
    if (pending) return Promise.reject(new TraceEngineError('trace_engine_busy'));
    if (signal?.aborted) return Promise.reject(new TraceEngineError('trace_engine_cancelled'));
    const safeInput = copyEngineJson(input, budgets.messageBytes);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const abort = () => fail('trace_engine_cancelled');
      pending = {
        id,
        resolve,
        reject,
        signal,
        abort,
        calls: new Set(),
        lastCall: 0,
        timer: setTimeout(() => fail('trace_engine_timeout'), budgets.callbackMs + 100),
      };
      signal?.addEventListener('abort', abort, { once: true });
      void write({ type: 'invoke', id, method, input: safeInput }).catch(() =>
        fail('trace_engine_write_failed'),
      );
    });
  };
  return {
    generation,
    readExitEvidence,
    retire,
    async initialize(input, signal) {
      await call('initialize', input, signal);
    },
    async onEvents(batch, signal) {
      const safe = traceBatchSchema.parse(batch);
      if (safe.processGeneration !== generation)
        throw new TraceEngineError('trace_engine_generation_mismatch');
      return validateDeliveryResult(
        await call('onEvents', copyEngineJson(safe, budgets.messageBytes), signal),
        safe,
      );
    },
    async flush(signal) {
      await call('flush', null, signal);
    },
    async shutdown(signal) {
      let failure: unknown;
      try {
        await call('shutdown', null, signal);
      } catch (error) {
        failure = error;
      }
      const cleanup = await retire();
      if (!cleanup.confirmed) throw new TraceEngineError('trace_engine_exit_unconfirmed', cleanup);
      if (failure) throw failure;
    },
  };
}
