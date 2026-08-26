import type {
  KiteServiceReadiness,
  KiteServiceReadinessEvent,
  KiteServiceReadinessPort,
} from './ports';

export interface KiteServiceReadinessChannel extends KiteServiceReadinessPort {
  readonly state: KiteServiceReadiness;
  readonly events: readonly KiteServiceReadinessEvent[];
  waitUntilReady(signal?: AbortSignal): Promise<void>;
}

/**
 * In-memory readiness channel for the process entrypoint and owner tests.  A production carrier
 * can adapt the same port to a readiness pipe/handle without putting protocol data on stdout.
 */
export function createKiteServiceReadinessChannel(): KiteServiceReadinessChannel {
  let state: KiteServiceReadiness = 'unavailable';
  let lastDiagnostic: string | undefined;
  const events: KiteServiceReadinessEvent[] = [];
  let readyWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
  }> = [];

  const settleWaiters = (event: KiteServiceReadinessEvent): void => {
    if (event.state === 'starting') return;
    const pending = readyWaiters;
    readyWaiters = [];
    for (const waiter of pending) {
      if (waiter.signal && waiter.onAbort)
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (event.state === 'ready') waiter.resolve();
      else waiter.reject(new Error(event.diagnostic ?? 'Service is unavailable.'));
    }
  };

  const channel: KiteServiceReadinessChannel = {
    get state() {
      return state;
    },
    get events() {
      return [...events];
    },
    publish(event) {
      state = event.state;
      lastDiagnostic = event.diagnostic;
      events.push(Object.freeze({ ...event }));
      settleWaiters(event);
    },
    waitUntilReady(signal) {
      if (state === 'ready') return Promise.resolve();
      if (state === 'unavailable' && events.length > 0) {
        return Promise.reject(new Error(lastDiagnostic ?? 'Service is unavailable.'));
      }
      if (signal?.aborted) {
        return Promise.reject(
          signal.reason instanceof Error ? signal.reason : new Error('Aborted.'),
        );
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: {
          readonly resolve: () => void;
          readonly reject: (error: unknown) => void;
          readonly signal?: AbortSignal;
          readonly onAbort?: () => void;
        } = { resolve, reject, signal };
        if (signal) {
          const onAbort = () => {
            const index = readyWaiters.indexOf(waiter);
            if (index >= 0) readyWaiters.splice(index, 1);
            reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
          };
          (waiter as { onAbort?: () => void }).onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        readyWaiters.push(waiter);
      });
    },
  };

  return Object.freeze(channel);
}

export const KITE_SERVICE_NOOP_READINESS: KiteServiceReadinessPort = Object.freeze({
  publish: () => undefined,
});
