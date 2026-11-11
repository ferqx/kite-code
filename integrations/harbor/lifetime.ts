/** One invocation deadline/cancellation, separate from bounded owned-process cleanup. */
export class InvocationStopped extends Error {
  readonly outcome: 'cancelled' | 'timed_out';
  constructor(outcome: 'cancelled' | 'timed_out') {
    super(outcome);
    this.outcome = outcome;
  }
}
export function createInvocationLifetime(milliseconds: number) {
  const controller = new AbortController();
  const stop = (outcome: InvocationStopped['outcome']) => {
    if (!controller.signal.aborted) controller.abort(new InvocationStopped(outcome));
  };
  const cancel = () => stop('cancelled');
  const timer = setTimeout(() => stop('timed_out'), milliseconds);
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  return {
    signal: controller.signal,
    cancel,
    check() {
      controller.signal.throwIfAborted();
    },
    async guard<T>(promise: Promise<T>): Promise<T> {
      // Observe the original promise even when already cancelled.
      void promise.catch(() => {});
      controller.signal.throwIfAborted();
      let rejectStop: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          rejectStop = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', rejectStop, { once: true });
        });
        const result = await Promise.race([promise, interrupted]);
        controller.signal.throwIfAborted();
        return result;
      } finally {
        if (rejectStop) controller.signal.removeEventListener('abort', rejectStop);
      }
    },
    dispose() {
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    },
  };
}
