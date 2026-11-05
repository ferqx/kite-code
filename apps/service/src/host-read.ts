import { setImmediate } from 'node:timers';

const pending: { run(): void }[] = [];
let scheduled = false;
function schedule() {
  if (scheduled || !pending.length) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    pending.shift()?.run();
    schedule();
  });
}

/** One fresh, synchronous native read/check per event-loop turn. Never memoize authority. */
export function readHostState<T>(read: () => T, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = pending.indexOf(task);
      if (index < 0) return;
      pending.splice(index, 1);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    const task = {
      run() {
        signal?.removeEventListener('abort', abort);
        try {
          signal?.throwIfAborted();
          const value = read();
          signal?.throwIfAborted();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      },
    };
    pending.push(task);
    signal?.addEventListener('abort', abort, { once: true });
    schedule();
  });
}
