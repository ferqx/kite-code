/** Cleanup has four seconds; the caller retains one second for forced process exit. */
export function settleDesktopQuit(input: {
  closeService: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<'clean' | 'force'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: 'clean' | 'force') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const abort = () => finish('force');
    const timer = setTimeout(() => finish('force'), 4000);
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(input.closeService)
      .then(
        () => finish('clean'),
        () => finish('force'),
      );
  });
}
