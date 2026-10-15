/** Sanitized transport-only failure; never contains Provider bodies, URLs or credentials. */
const marker = Symbol.for('@kite-ai/ai.ModelAttemptError.v1');
export class ModelAttemptError extends Error {
  readonly reason: 'provider_unavailable' | 'connection_failed' | 'stream_incomplete';
  constructor(reason: ModelAttemptError['reason']) {
    super(`MODEL_ATTEMPT_RETRYABLE_FAILURE:${reason}`);
    this.name = 'ModelAttemptError';
    this.reason = reason;
    Object.defineProperty(this, marker, { value: true });
  }
  /** The independently built AI root and SDK entries can own distinct constructors. */
  static isInstance(error: unknown): error is ModelAttemptError {
    if (!(error instanceof Error)) return false;
    const value = error as ModelAttemptError & { [marker]?: boolean };
    return (
      value[marker] === true &&
      ['provider_unavailable', 'connection_failed', 'stream_incomplete'].includes(value.reason) &&
      value.message === `MODEL_ATTEMPT_RETRYABLE_FAILURE:${value.reason}`
    );
  }
}
