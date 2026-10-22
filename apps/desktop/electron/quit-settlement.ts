/** The closed client leaves owned Service cleanup running silently in the background. */
export async function settleDesktopQuit(input: {
  closeService: () => Promise<void>;
}): Promise<'clean' | 'force'> {
  return Promise.resolve()
    .then(input.closeService)
    .then(
      () => 'clean' as const,
      () => 'force' as const,
    );
}

/** A stalled read is unknown work; only this inspection's GETs are aborted. */
export async function inspectNativeQuitWork(
  read: (signal: AbortSignal) => Promise<boolean>,
  waitMs: number,
): Promise<boolean> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => read(abort.signal))
        .catch(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(true);
        }, waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}
