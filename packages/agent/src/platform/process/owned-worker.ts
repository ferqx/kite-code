import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { AgentError } from '../../storage/types';
import { nodeRuntimeFlags } from '../runtime-flags';
import { retainWorkerThread } from './worker-thread.darwin';

const NodeEvent = globalThis.Event;
const NodeMessageEvent = globalThis.MessageEvent;

/** Private adapter failure: business cancellation cannot turn uncertain cleanup into success. */
export class WorkerCleanupError extends AgentError {
  constructor(cause: unknown, originalThread: unknown) {
    super('worker_exit_unconfirmed');
    this.cause = cause;
    Object.assign(this, { originalThread });
  }
}
export function isWorkerCleanupFailure(error: unknown): boolean {
  return (
    error instanceof WorkerCleanupError ||
    (error instanceof AggregateError &&
      error.errors.some((cause) => cause instanceof WorkerCleanupError))
  );
}

/** The reviewed preload is separate from the original Worker entrypoint. Pure metadata. */
export function ownedWorkerPreloadAsset(): URL {
  return new URL(
    import.meta.url.endsWith('.ts')
      ? '../../../dist/storage/worker/observer-preload.js'
      : './storage/worker/observer-preload.js',
    import.meta.url,
  );
}

/** Exact host module and bundled observer entrypoint. No directory grant. */
export function ownedWorkerAssets() {
  return Object.freeze({
    preload: ownedWorkerPreloadAsset(),
    modules: Object.freeze([new URL(import.meta.url)]),
  });
}

class NodeWorkerEvents extends EventTarget {
  private readonly worker: NodeWorker;
  private message: ((event: MessageEvent) => void) | null = null;
  private error: ((event: ErrorEvent) => void) | null = null;

  constructor(script: string | URL, preload?: URL) {
    super();
    const url =
      script instanceof URL
        ? script
        : script.startsWith('file:')
          ? new URL(script)
          : pathToFileURL(resolve(script));
    if (url.protocol !== 'file:') throw Error('worker_entrypoint_invalid');
    this.worker = new NodeWorker(preload ?? url, {
      execArgv: [...nodeRuntimeFlags],
      env: {},
      workerData: preload ? url.href : undefined,
    });
    this.worker.on('message', (data: unknown) =>
      this.dispatchEvent(new NodeMessageEvent('message', { data })),
    );
    this.worker.on('error', (error: Error) => this.report(error));
    this.worker.on('exit', () => this.dispatchEvent(new NodeEvent('close')));
  }

  private report(error: Error): void {
    const event = Object.assign(new NodeEvent('error'), { error, message: error.message });
    this.dispatchEvent(event);
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    if (this.message) this.removeEventListener('message', this.message as EventListener);
    this.message = handler;
    if (handler) this.addEventListener('message', handler as EventListener);
  }

  set onerror(handler: ((event: ErrorEvent) => void) | null) {
    if (this.error) this.removeEventListener('error', this.error as EventListener);
    this.error = handler;
    if (handler) this.addEventListener('error', handler as EventListener);
  }

  postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    const transfers = Array.isArray(options) ? options : options?.transfer;
    this.worker.postMessage(value, transfers as Parameters<NodeWorker['postMessage']>[1]);
  }

  terminate(): void {
    void this.worker.terminate().catch((error: Error) => this.report(error));
  }

  async terminateAndWait(): Promise<void> {
    await this.worker.terminate();
  }
}

/** One original Worker and its own thread right; no global registry or execution authority. */
export function createOwnedWorker(script: string | URL) {
  const native = process.platform === 'darwin';
  const worker = new NodeWorkerEvents(script, native ? ownedWorkerPreloadAsset() : undefined);
  let termination: Promise<void> | undefined;
  let originalThread: unknown;
  let resolveOrigin!: (lease: ReturnType<typeof retainWorkerThread>) => void;
  let rejectOrigin!: (error: unknown) => void;
  const origin = new Promise<ReturnType<typeof retainWorkerThread>>((resolve, reject) => {
    resolveOrigin = resolve;
    rejectOrigin = reject;
  });
  // Startup failure may precede the caller's eventual termination request.
  void origin.catch(() => {});
  if (native) {
    const missingOrigin = () => rejectOrigin(new AgentError('worker_exit_unconfirmed'));
    const capture = (event: MessageEvent) => {
      // This listener runs before the business handler. The trusted preload's first
      // frame never enters the original parser/SQL message protocol.
      if (event.data?.protocol !== 'kite_worker_thread@1') {
        missingOrigin();
        return;
      }
      event.stopImmediatePropagation();
      worker.removeEventListener('message', capture as EventListener);
      worker.removeEventListener('error', missingOrigin);
      worker.removeEventListener('close', missingOrigin);
      originalThread = event.data.thread;
      try {
        if (event.data.failure)
          throw Object.assign(new AgentError('worker_exit_unconfirmed'), {
            cause: event.data.failure,
          });
        resolveOrigin(retainWorkerThread(event.data.thread));
      } catch (cause) {
        // Retain failure does not release the trusted capture's original send right.
        // Preserve that exact custody and all native cleanup diagnostics through close.
        rejectOrigin(
          Object.assign(new AgentError('worker_exit_unconfirmed'), {
            cause,
            originalThread: event.data.thread,
          }),
        );
      }
    };
    worker.addEventListener('message', capture as EventListener);
    worker.addEventListener('error', missingOrigin, { once: true });
    worker.addEventListener('close', missingOrigin, { once: true });
  }
  return {
    worker,
    terminate(): Promise<void> {
      if (termination) return termination;
      termination = (async () => {
        if (!native) {
          // Await the runtime's thread join. macOS still requires its retained Mach right below.
          await worker.terminateAndWait();
          return;
        }
        let lease: Awaited<typeof origin>;
        const deadline = Date.now() + 5000;
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Earliest cancellation still lets the trusted preload capture the original
          // right before requesting termination; no business input is re-sent.
          lease = await Promise.race([
            origin,
            new Promise<never>((_, reject) => {
              startupTimer = setTimeout(
                () => reject(new AgentError('worker_exit_unconfirmed')),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
        } catch (cause) {
          worker.terminate();
          throw Object.assign(new AgentError('worker_exit_unconfirmed'), { cause });
        } finally {
          if (startupTimer) clearTimeout(startupTimer);
        }
        worker.terminate();
        while (lease.inspect() !== 'terminated') {
          if (Date.now() >= deadline) throw new AgentError('worker_exit_unconfirmed');
          await sleep(1);
        }
        // Observation and accurate right release are separate necessary facts.
        lease.release();
      })().catch((cause: unknown) => {
        throw new WorkerCleanupError(cause, originalThread);
      });
      return termination;
    },
  };
}
