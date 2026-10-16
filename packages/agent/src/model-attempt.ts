import { ModelAttemptError } from '@kite-ai/ai';

export interface ModelRetrySource {
  readonly previousExecutionId: string;
  readonly attempt: number;
  readonly maxAttempts: number | null;
  readonly reason: ModelAttemptError['reason'];
}
/** The Runtime owns visible retries; SDK adapters always perform one Provider attempt. */
export async function waitForModelRetry(attempt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(attempt) || attempt < 2) throw new Error('invalid_model_retry_attempt');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      Math.min(100 * 2 ** Math.min(attempt - 2, 9), 30000),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function modelRetryReason(error: unknown): ModelAttemptError['reason'] | null {
  return ModelAttemptError.isInstance(error) ? error.reason : null;
}
