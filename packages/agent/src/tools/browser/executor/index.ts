import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Json } from '../../../extensions';
import {
  launchIdentity,
  removeRuntimeTemp,
  verifyLaunchIdentities,
} from '../../../jobs/launch-identity';
import { startDarwinBrowserOwner } from '../darwin-owner';
import type { BrowserCodeExecutor, BrowserCodeResult } from '../execute';
import { BrowserExecutorFailure } from '../executor-failure';
import { createExecutorCpuBudget } from './cpu-budget';

export { browserExecutorWorkerAsset } from './assets';

/** Startup always reports whether its exact owned resources were confirmed closed. */
export class BrowserExecutorStartupError extends Error {
  readonly cleanupConfirmed: boolean;
  constructor(code: string, cleanupConfirmed: boolean) {
    super(code);
    this.name = 'BrowserExecutorStartupError';
    this.cleanupConfirmed = cleanupConfirmed;
  }
}

const MAX_CODE = 16384,
  MAX_FRAME = 65536,
  MAX_OUTPUT = 16384,
  MAX_CALLS = 32;
const quote = (path: string) => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
/** No Workspace, Profile, network, subprocess or arbitrary executable grant. */
export function browserExecutorProfile(
  bun: string,
  worker: string,
  cwd: string = dirname(worker),
): string {
  const systems = ['/System/Library', '/usr/lib', '/usr/share']
    .filter(existsSync)
    .map((path) => realpathSync.native(path));
  const ancestors = new Set<string>();
  for (const root of [bun, worker, join(cwd, 'placeholder'), ...systems]) {
    for (let current = dirname(root); ; current = dirname(current)) {
      ancestors.add(current);
      if (dirname(current) === current) break;
    }
  }
  return `(version 1)
(import "system.sb")
(deny default)
(deny network*)
(deny process-fork)
(allow process-exec (literal ${quote(bun)}))
(allow signal (target same-sandbox))
(allow file-read* ${systems.map((path) => `(subpath ${quote(path)})`).join(' ')} (literal ${quote(bun)}) (literal ${quote(worker)}))
(allow file-read* (literal ${quote(cwd)}) (literal ${quote(dirname(worker))}))
(allow file-read-metadata ${[...ancestors].map((path) => `(literal ${quote(path)})`).join(' ')})
(allow file-map-executable ${systems.map((path) => `(subpath ${quote(path)})`).join(' ')} (literal ${quote(bun)}))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow sysctl-read (sysctl-name "hw.*") (sysctl-name "kern.*") (sysctl-name "machdep.cpu.*") (sysctl-name "sysctl.proc_translated"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.logd"))
(allow ipc-posix-sem)`;
}
export interface BrowserExecutor extends BrowserCodeExecutor {
  readonly scope: string;
  readProcessEvidence(): ReturnType<
    ReturnType<typeof startDarwinBrowserOwner>['readProcessEvidence']
  >;
  execute(
    input: Parameters<BrowserCodeExecutor['execute']>[0] & { timeoutMs?: number },
  ): Promise<BrowserCodeResult>;
  close(): Promise<{ confirmed: boolean }>;
}
/** One hot environment for one immutable host scope. Never reconstructed from records. */
export async function createBrowserExecutor(options: {
  scope: string;
  workerPath: string;
  guardianPath: string;
  bunExecutable?: string;
}): Promise<BrowserExecutor> {
  if (process.platform !== 'darwin')
    throw new BrowserExecutorStartupError('browser_executor_unavailable', true);
  if (
    !options.scope ||
    options.scope.length > 1024 ||
    !options.workerPath.endsWith('.js') ||
    !options.guardianPath.endsWith('.js')
  )
    throw new BrowserExecutorStartupError('browser_executor_configuration', true);
  let facts: ReturnType<typeof launchIdentity>[];
  try {
    facts = [
      launchIdentity(options.bunExecutable ?? process.execPath, true),
      launchIdentity(options.workerPath, true),
      launchIdentity(options.guardianPath, true),
      launchIdentity('/usr/bin/sandbox-exec', true),
    ];
    verifyLaunchIdentities(facts);
  } catch {
    throw new BrowserExecutorStartupError('browser_executor_unavailable', true);
  }
  const [bun, worker, guardian, sandbox] = facts;
  const root = launchIdentity(
    realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-browser-executor-'))),
  );
  const owner = startDarwinBrowserOwner({
    guardianPath: guardian!.canonical,
    bunExecutable: bun!.canonical,
    executable: sandbox!.canonical,
    argv: [
      '-p',
      browserExecutorProfile(bun!.canonical, worker!.canonical, root.canonical),
      bun!.canonical,
      '--no-env-file',
      '--no-install',
      worker!.canonical,
    ],
    cwd: root.canonical,
    env: { HOME: root.canonical, TMPDIR: root.canonical, TZ: 'UTC' },
    nonce: randomUUID(),
    graceMs: 50,
    startupTimeoutMs: 5000,
  });
  let closed = false,
    closePromise: Promise<{ confirmed: boolean }> | undefined,
    buffer = Buffer.alloc(0),
    sequence = 0,
    apiSequence = 0,
    didReady = false;
  let cpu: ReturnType<typeof createExecutorCpuBudget> | undefined;
  let active:
    | {
        id: number;
        calls: number;
        output: string;
        failed?: Error;
        apiFailure?: { message: string };
        pending: number;
        sealed: boolean;
        input: Parameters<BrowserExecutor['execute']>[0];
        resolve(value: BrowserCodeResult): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setInterval>;
        waiting: number;
        wallLeft: number;
        lastTick: number;
        cpuStart: bigint;
        timeout: number;
        abort(): void;
        chain: Promise<void>;
      }
    | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const workerReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void workerReady.catch(() => {});
  const close = () =>
    (closePromise ??= (async () => {
      closed = true;
      const original = active;
      if (original) {
        active = undefined;
        clearInterval(original.timer);
        original.input.signal.removeEventListener('abort', original.abort);
      }
      let result: { confirmed: boolean };
      try {
        result = await owner.cancel();
        if (result.confirmed) removeRuntimeTemp(root);
      } catch {
        result = { confirmed: false };
      }
      try {
        cpu?.close();
      } catch {
        result = { confirmed: false };
      }
      const failure = Error(
        result.confirmed ? 'browser_executor_closed' : 'browser_executor_cleanup_unknown',
      );
      rejectReady(failure);
      if (original)
        original.reject(new BrowserExecutorFailure(original.failed ?? failure, original.output));
      return result;
    })());
  const fail = (error: Error) => {
    if (active) active.failed ??= error;
    rejectReady(error);
    void close();
  };
  owner.stdout.on('data', (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) throw Error('browser_executor_frame_limit');
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const frame = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)),
        );
        buffer = buffer.subarray(end + 1);
        if (frame.type === 'ready' && !didReady && !active && sequence === 0) {
          didReady = true;
          resolveReady();
          continue;
        }
        const batch = active;
        if (!batch || frame.batch !== batch.id || closed) throw Error('browser_executor_protocol');
        if (batch.sealed) throw Error('browser_executor_protocol');
        if (frame.type === 'call') {
          if (
            ++batch.calls > MAX_CALLS ||
            typeof frame.method !== 'string' ||
            frame.method.length > 64 ||
            !Number.isSafeInteger(frame.id) ||
            frame.id !== ++apiSequence
          )
            throw Error('browser_executor_call_limit');
          batch.pending++;
          // Serialize dynamic actions. Sticky failure blocks calls already queued by Promise.all
          // and calls attempted after generated code catches a rejection.
          batch.chain = batch.chain
            .then(async () => {
              if (closed || active !== batch || batch.input.signal.aborted)
                throw Error('browser_executor_cancelled');
              if (batch.apiFailure) {
                batch.pending--;
                await owner.write(
                  JSON.stringify({
                    type: 'result',
                    batch: batch.id,
                    id: frame.id,
                    error: 'browser_executor_batch_stopped',
                  }) + '\n',
                );
                return;
              }
              try {
                await cpu!.suspend();
                batch.waiting++;
                let value: Json = null;
                try {
                  value = await batch.input.call(frame.method, frame.args ?? null);
                } catch (error) {
                  const known = batch.input.recoverableFailure?.(error);
                  if (!known) throw error;
                  batch.apiFailure = known;
                } finally {
                  batch.waiting--;
                }
                batch.lastTick = performance.now();
                if (closed || active !== batch || batch.input.signal.aborted)
                  throw Error('browser_executor_cancelled');
                const content = JSON.stringify({
                  type: 'result',
                  batch: batch.id,
                  id: frame.id,
                  ...(batch.apiFailure
                    ? { error: batch.apiFailure.message.slice(0, 512) }
                    : { value }),
                });
                if (Buffer.byteLength(content) > 131000)
                  throw Error('browser_executor_result_limit');
                batch.pending--;
                cpu!.resume();
                await owner.write(content + '\n');
              } catch (error) {
                batch.failed ??=
                  error instanceof Error ? error : Error('browser_executor_api_failed');
                fail(batch.failed);
              }
            })
            .catch((error) => fail(error));
        } else if (frame.type === 'output' && typeof frame.content === 'string') {
          if (Buffer.byteLength(batch.output) + Buffer.byteLength(frame.content) > MAX_OUTPUT)
            throw Error('browser_executor_output_limit');
          batch.output += frame.content + '\n';
        } else if (frame.type === 'done') {
          // The worker can only veto reuse. Its idle claim cannot settle Host calls
          // or prove that the exact process has actually stopped.
          if (frame.pending !== 0 || batch.pending !== 0)
            throw Error('browser_executor_unawaited_calls');
          if (
            frame.error !== undefined &&
            (typeof frame.error !== 'string' || Buffer.byteLength(frame.error) > 512)
          )
            throw Error('browser_executor_protocol');
          batch.sealed = true;
          batch.chain = batch.chain
            .then(async () => {
              if (active !== batch || closed) return;
              // The worker's done frame is untrusted. Confirm the actual process
              // is suspended before returning or dropping its execution budget.
              await cpu!.suspend();
              if (active !== batch || closed) return;
              if (batch.pending !== 0 || batch.waiting !== 0 || batch.input.signal.aborted)
                throw Error('browser_executor_cancelled');
              active = undefined;
              clearInterval(batch.timer);
              batch.input.signal.removeEventListener('abort', batch.abort);
              const failure = batch.apiFailure
                ? { kind: 'api' as const, message: batch.apiFailure.message }
                : frame.error
                  ? { kind: 'evaluation' as const, message: frame.error }
                  : undefined;
              batch.resolve(
                failure
                  ? { value: null, output: batch.output, failure }
                  : { value: frame.value ?? null, output: batch.output },
              );
            })
            .catch((error) => fail(error));
        } else throw Error('browser_executor_protocol');
      }
    } catch (error) {
      fail(error instanceof Error ? error : Error('browser_executor_protocol'));
    }
  });
  owner.stderr.resume();
  owner.stdout.on('error', (error) => fail(error));
  owner.stderr.on('error', (error) => fail(error));
  void owner.completion.then(() => {
    if (!closed) fail(Error('browser_executor_ended'));
  });
  try {
    await Promise.all([
      owner.ready,
      Promise.race([
        workerReady,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(Error('browser_executor_unavailable')), 5000);
          void workerReady.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]),
    ]);
    const identity = owner.readProcessEvidence().root;
    if (!identity) throw Error('browser_executor_budget_unavailable');
    cpu = createExecutorCpuBudget(identity);
    cpu.read();
    await cpu.suspend();
  } catch {
    const stopped = await close();
    throw new BrowserExecutorStartupError(
      stopped.confirmed ? 'browser_executor_unavailable' : 'browser_executor_cleanup_unknown',
      stopped.confirmed,
    );
  }
  return {
    scope: options.scope,
    readProcessEvidence: () => owner.readProcessEvidence(),
    close,
    async execute(input) {
      if (closed) throw Error('browser_executor_closed');
      if (active) throw Error('browser_executor_busy');
      if (
        typeof input.code !== 'string' ||
        !input.code.trim() ||
        Buffer.byteLength(input.code) > MAX_CODE
      )
        throw Error('browser_executor_code_limit');
      const timeout = input.timeoutMs ?? 15000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
        throw Error('browser_executor_timeout_invalid');
      if (input.signal.aborted) throw Error('browser_executor_cancelled');
      return new Promise((resolve, reject) => {
        const abort = () => fail(Error('browser_executor_cancelled'));
        const cpuStart = cpu!.read();
        active = {
          id: ++sequence,
          calls: 0,
          pending: 0,
          sealed: false,
          output: '',
          input,
          resolve,
          reject,
          abort,
          chain: Promise.resolve(),
          waiting: 0,
          wallLeft: timeout,
          lastTick: performance.now(),
          cpuStart,
          timeout,
          timer: setInterval(
            () => {
              const batch = active;
              if (!batch || closed) return;
              try {
                const now = performance.now();
                if (!batch.waiting) batch.wallLeft -= now - batch.lastTick;
                batch.lastTick = now;
                if (
                  batch.wallLeft <= 0 ||
                  cpu!.read() - batch.cpuStart > BigInt(batch.timeout) * 1000000n
                )
                  fail(Error('browser_executor_timeout'));
              } catch (error) {
                fail(error instanceof Error ? error : Error('browser_executor_budget_unavailable'));
              }
            },
            Math.min(25, timeout),
          ),
        };
        input.signal.addEventListener('abort', abort, { once: true });
        void owner
          .write(JSON.stringify({ type: 'execute', batch: sequence, code: input.code }) + '\n')
          .then(() => cpu!.resume())
          .catch((error) => fail(error));
        if (input.signal.aborted) abort();
      });
    },
  };
}
