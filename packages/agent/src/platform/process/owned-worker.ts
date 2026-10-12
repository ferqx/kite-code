import { AgentError } from '../../storage/types';
import { retainWorkerThread } from './worker-thread.darwin';

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
      ? '../../storage/worker/observer-preload.ts'
      : './storage/worker/observer-preload.js',
    import.meta.url,
  );
}

/** Exact executed source leaves, or the built chunk and bundled preload. No directory grant. */
export function ownedWorkerAssets() {
  return Object.freeze({
    preload: ownedWorkerPreloadAsset(),
    modules: Object.freeze([
      new URL(import.meta.url),
      ...(import.meta.url.endsWith('.ts')
        ? [new URL('./worker-thread.darwin.ts', import.meta.url)]
        : []),
    ]),
  });
}

/** One original Worker and its own thread right; no global registry or execution authority. */
export function createOwnedWorker(script: string | URL) {
  const native = process.platform === 'darwin';
  const worker = native
    ? new Worker(script, { preload: [ownedWorkerPreloadAsset().href] })
    : new Worker(script);
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
      worker.removeEventListener('message', capture);
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
    worker.addEventListener('message', capture);
    worker.addEventListener('error', missingOrigin, { once: true });
    worker.addEventListener('close', missingOrigin, { once: true });
  }
  return {
    worker,
    terminate(): Promise<void> {
      if (termination) return termination;
      termination = (async () => {
        if (!native) {
          // Deferred platform paths retain their existing behavior and unclosed gate.
          // No Bun close/exit notification is promoted to native termination evidence.
          worker.terminate();
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
          await Bun.sleep(1);
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
