/** One owned main-frame document lifecycle; no navigation, polling or independent deadline. */
export function createBrowserDocumentReady() {
  let epoch = 0;
  let phase: 'ready' | 'started' | 'committed' | 'failed' = 'ready';
  let disposed = false;
  let stopped = false;
  const waiting = new Set<{ current(): boolean; finish(ready: boolean): void }>();
  const cancel = () => {
    for (const waiter of [...waiting]) waiter.finish(false);
  };
  return {
    start() {
      cancel();
      phase = 'started';
      stopped = false;
      return ++epoch;
    },
    commit(expected: number) {
      if (!disposed && expected === epoch && phase === 'started') phase = 'committed';
    },
    ready(expected: number) {
      if (disposed || expected !== epoch || phase !== 'committed') return;
      phase = 'ready';
      stopped = false;
      for (const waiter of [...waiting]) waiter.finish(waiter.current());
    },
    fail() {
      phase = 'failed';
      cancel();
    },
    stopped() {
      if (phase !== 'started' && phase !== 'committed') return;
      // Stopping a load retires reads, but does not prove that its committed
      // document failed. A later engine readiness event still owns this epoch.
      stopped = true;
      cancel();
    },
    check() {
      for (const waiter of [...waiting]) if (!waiter.current()) waiter.finish(false);
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
    wait(signal?: AbortSignal, current: () => boolean = () => true): Promise<boolean> {
      signal?.throwIfAborted();
      if (disposed || stopped || phase === 'failed' || !current()) return Promise.resolve(false);
      if (phase === 'ready') return Promise.resolve(true);
      return new Promise<boolean>((resolve, reject) => {
        const abort = () => {
          waiting.delete(waiter);
          signal?.removeEventListener('abort', abort);
          reject(signal?.reason);
        };
        const waiter = {
          current,
          finish(ready: boolean) {
            if (!waiting.delete(waiter)) return;
            signal?.removeEventListener('abort', abort);
            resolve(ready);
          },
        };
        waiting.add(waiter);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
}
