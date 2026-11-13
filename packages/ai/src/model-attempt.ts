/** Sanitized transport-only failure; never contains Provider bodies, URLs or credentials. */
const marker = Symbol.for('@kite-ai/ai.ModelAttemptError.v1');
const accessMarker = Symbol.for('@kite-ai/ai.ModelAccessError.v1');
type ModelAccessCode = 'model_authentication_required' | 'model_access_denied';

/** A Provider HTTP refusal that a reconnection cannot resolve. */
export class ModelAccessError extends Error {
  readonly code: ModelAccessCode;
  constructor(code: ModelAccessCode) {
    super(code);
    this.name = 'ModelAccessError';
    this.code = code;
    Object.defineProperty(this, accessMarker, { value: true });
  }
  static isInstance(error: unknown): error is ModelAccessError {
    if (!(error instanceof Error)) return false;
    const value = error as ModelAccessError & { [accessMarker]?: boolean };
    return (
      value[accessMarker] === true &&
      (value.code === 'model_authentication_required' || value.code === 'model_access_denied') &&
      value.message === value.code
    );
  }
}

const details = [
  'connection_refused',
  'connection_timeout',
  'name_resolution_failed',
  'connection_interrupted',
  'rate_limited',
  'request_timeout',
  'service_unavailable',
] as const;
export type ModelAttemptDetail = (typeof details)[number];
export class ModelAttemptError extends Error {
  readonly reason: 'provider_unavailable' | 'connection_failed' | 'stream_incomplete';
  readonly detail?: ModelAttemptDetail;
  constructor(reason: ModelAttemptError['reason'], detail?: ModelAttemptDetail) {
    super(`MODEL_ATTEMPT_RETRYABLE_FAILURE:${reason}`);
    if (detail !== undefined && !details.includes(detail))
      throw new Error('invalid_model_failure_detail');
    this.name = 'ModelAttemptError';
    this.reason = reason;
    this.detail = detail;
    Object.defineProperty(this, marker, { value: true });
  }
  /** The independently built AI root and SDK entries can own distinct constructors. */
  static isInstance(error: unknown): error is ModelAttemptError {
    if (!(error instanceof Error)) return false;
    const value = error as ModelAttemptError & { [marker]?: boolean };
    return (
      value[marker] === true &&
      (value.detail === undefined || details.includes(value.detail)) &&
      ['provider_unavailable', 'connection_failed', 'stream_incomplete'].includes(value.reason) &&
      value.message === `MODEL_ATTEMPT_RETRYABLE_FAILURE:${value.reason}`
    );
  }
}

/** Only known system codes; never inspect or retain remote messages, URLs or bodies. */
export function modelConnectionDetail(error: unknown): ModelAttemptDetail | undefined {
  const codes: Record<string, ModelAttemptDetail> = {
    ECONNREFUSED: 'connection_refused',
    ETIMEDOUT: 'connection_timeout',
    UND_ERR_CONNECT_TIMEOUT: 'connection_timeout',
    UND_ERR_HEADERS_TIMEOUT: 'request_timeout',
    UND_ERR_BODY_TIMEOUT: 'request_timeout',
    ENOTFOUND: 'name_resolution_failed',
    EAI_AGAIN: 'name_resolution_failed',
    ECONNRESET: 'connection_interrupted',
    EPIPE: 'connection_interrupted',
    UND_ERR_SOCKET: 'connection_interrupted',
    ENETDOWN: 'connection_interrupted',
    ENETUNREACH: 'connection_interrupted',
    EHOSTDOWN: 'connection_interrupted',
    EHOSTUNREACH: 'connection_interrupted',
    ConnectionClosed: 'connection_interrupted',
    ConnectionRefused: 'connection_refused',
  };
  for (let depth = 0; depth < 5 && error instanceof Error; depth++) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && Object.hasOwn(codes, code)) return codes[code];
    error = error.cause;
  }
  return undefined;
}
