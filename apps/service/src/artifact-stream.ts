/** One HTTP response owns one Artifact iterator. Partial consumption is not verified EOF. */
export function createArtifactStream(input: {
  content: AsyncIterable<Uint8Array>;
  controller: AbortController;
  settled(error?: unknown, cleanupUnknown?: boolean): void;
}) {
  const iterator = input.content[Symbol.asyncIterator]();
  let settled = false;
  let closing: Promise<void> | undefined;
  let pendingRead: Promise<IteratorResult<Uint8Array>> | undefined;
  let readFailure: unknown;
  let onAbort: (() => void) | undefined;
  const settle = (error?: unknown, cleanupUnknown = false) => {
    if (settled) return;
    settled = true;
    if (onAbort) input.controller.signal.removeEventListener('abort', onAbort);
    input.settled(error, cleanupUnknown);
  };
  const close = (readError?: unknown) => {
    if (
      readError !== undefined &&
      (readFailure === undefined || readFailure === input.controller.signal.reason)
    )
      readFailure = readError;
    closing ??= (async () => {
      // return() queues behind next(). Observe its failure before deciding cleanup succeeded.
      if (pendingRead)
        try {
          await pendingRead;
        } catch (error) {
          readFailure = error;
        }
      try {
        await iterator.return?.();
        // A generator can throw from its finally during next(), then return() succeeds.
        // Preserve that original error; only known read failures prove cleanup was ordinary.
        const readError = readFailure;
        const code = (readError as { code?: string })?.code;
        const knownReadFailure =
          readError === undefined ||
          readError === input.controller.signal.reason ||
          [
            'artifact_reference_not_found',
            'artifact_content_mismatch',
            'artifact_content_unavailable',
            'artifact_scope_denied',
            'runtime_draining',
            'store_identity_mismatch',
            // Path lookup/access failure cannot originate from closing an already-open FD.
            'ENOENT',
            'EACCES',
            'EPERM',
            'ENOTDIR',
          ].includes(code ?? '');
        settle(readError, !knownReadFailure);
      } catch (error) {
        settle(
          readFailure === undefined
            ? error
            : new AggregateError([readFailure, error], 'artifact_stream_cleanup_unconfirmed'),
          true,
        );
        throw error;
      }
    })();
    return closing;
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        onAbort = () => {
          void close().catch(() => {}); // settled preserves cleanup failure for the transport owner.
          try {
            controller.error(input.controller.signal.reason);
          } catch {}
        };
        input.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (input.controller.signal.aborted) onAbort();
      },
      async pull(controller) {
        try {
          input.controller.signal.throwIfAborted();
          pendingRead = iterator.next();
          const item = await pendingRead;
          pendingRead = undefined;
          input.controller.signal.throwIfAborted();
          if (item.done) {
            controller.close();
            settle();
          } else controller.enqueue(Uint8Array.from(item.value));
        } catch (error) {
          try {
            controller.error(error);
          } finally {
            await close(error);
          }
        }
      },
      async cancel() {
        input.controller.abort();
        await close();
      },
    },
    { highWaterMark: 0 },
  );
}
