/** An explicit HTTP rejection, not an unknown outcome or permission to retry unchanged. */
const marker = Symbol.for('@kite-ai/ai.ModelRequestLimitError.v1');
export class ModelRequestLimitError extends Error {
  readonly kind = 'request_body_too_large' as const;
  readonly status = 413 as const;
  constructor() {
    super('model_request_body_too_large');
    this.name = 'ModelRequestLimitError';
    Object.defineProperty(this, marker, { value: true });
  }
  static isInstance(error: unknown): error is ModelRequestLimitError {
    if (!(error instanceof Error)) return false;
    const value = error as ModelRequestLimitError & { [marker]?: boolean };
    return (
      value[marker] === true &&
      value.kind === 'request_body_too_large' &&
      value.status === 413 &&
      value.message === 'model_request_body_too_large'
    );
  }
}

const overflowMarker = Symbol.for('@kite-ai/ai.ModelContextOverflowError');
/** The provider rejected an unsampled request for exceeding its token window. */
export class ModelContextOverflowError extends Error {
  constructor() {
    super('model_context_overflow');
    this.name = 'ModelContextOverflowError';
    Object.defineProperty(this, overflowMarker, { value: true });
  }
  static isInstance(error: unknown): error is ModelContextOverflowError {
    return (
      error instanceof Error &&
      (error as Error & { [overflowMarker]?: boolean })[overflowMarker] === true &&
      error.message === 'model_context_overflow'
    );
  }
}
