import { ModelAttemptError } from '@kite-ai/ai';

export const MODEL_MAX_ATTEMPTS = 5;
export interface ModelRetrySource {
  readonly previousExecutionId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: ModelAttemptError['reason'];
}
/** The Runtime owns visible retries; SDK adapters always perform one Provider attempt. */
export async function waitForModelRetry(attempt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isInteger(attempt) || attempt < 2 || attempt > MODEL_MAX_ATTEMPTS)
    throw new Error('invalid_model_retry_attempt');
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
      Math.min(100 * 2 ** (attempt - 2), 800),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function modelRetryReason(error: unknown): ModelAttemptError['reason'] | null {
  return ModelAttemptError.isInstance(error) ? error.reason : null;
}
