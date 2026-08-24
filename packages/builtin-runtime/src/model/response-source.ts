import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_,
  type ModelAttemptOutcome,
  type ModelSurface,
} from '@kite/runtime-spi';
import { isTransientModelConnectionError } from './deepseek';
import type { SupportedChatModel } from './factory';
import { invokeModelTransportSingleAttempt, type ModelTransportResponse } from './transport';

export type SingleAttemptTransport = typeof invokeModelTransportSingleAttempt;

export interface ModelResponseSourceAttemptInput {
  surface: ModelSurface;
  attemptOrdinal: number;
  model: SupportedChatModel;
  signal?: AbortSignal;
  onActivity?: () => void;
  onTextCumulative?: (text: string) => void;
  onReasoningCumulative?: (text: string, segmentId: string) => void;
  onReasoningCompleted?: (text: string, segmentId: string) => void;
}

/** Exactly one outcome. Retry, backoff and the next attempt ack remain Gateway-owned. */
export interface ModelResponseSource {
  attempt(input: ModelResponseSourceAttemptInput): Promise<ModelAttemptOutcome>;
  /** Live-only diagnostic cause; never persisted or copied into Runtime events. */
  failureError?(outcome: Exclude<ModelAttemptOutcome, { kind: 'success' }>): Error | undefined;
}

export class ModelAttemptFailureError extends Error {
  readonly outcome: Exclude<ModelAttemptOutcome, { kind: 'success' }>;
  readonly invocationId?: string;

  constructor(
    outcome: Exclude<ModelAttemptOutcome, { kind: 'success' }>,
    cause?: Error,
    invocationId?: string,
  ) {
    super(
      `MODEL_ATTEMPT_${outcome.kind.toUpperCase()}:${outcome.classification}`,
      cause ? { cause } : undefined,
    );
    this.name = 'ModelAttemptFailureError';
    this.outcome = outcome;
    this.invocationId = invocationId;
  }
}

export function createLiveModelResponseSource(
  transport: SingleAttemptTransport = invokeModelTransportSingleAttempt,
): ModelResponseSource {
  const failureCauses = new WeakMap<object, Error>();
  return Object.freeze({
    attempt: async (input: ModelResponseSourceAttemptInput) => {
      try {
        const response = await transport({
          model: input.model,
          surface: input.surface,
          signal: input.signal,
          onActivity: input.onActivity,
          onTextCumulative: input.onTextCumulative,
          onReasoningCumulative: input.onReasoningCumulative,
          onReasoningCompleted: input.onReasoningCompleted,
        });
        return outcomeSuccess(response);
      } catch (error) {
        const outcome = outcomeFromTransportFailure(error, input.signal);
        if (error instanceof Error) failureCauses.set(outcome, error);
        return outcome;
      }
    },
    failureError: (outcome: Exclude<ModelAttemptOutcome, { kind: 'success' }>) =>
      failureCauses.get(outcome),
  });
}

function outcomeSuccess(response: ModelTransportResponse): ModelAttemptOutcome {
  return deepFreeze({
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
    kind: 'success',
    response,
    nativeReplayState: null,
  });
}

function outcomeFromTransportFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): ModelAttemptOutcome {
  const status = providerStatusCode(error);
  const timedOut = Boolean(
    signal?.aborted &&
      signal.reason instanceof Error &&
      signal.reason.message === 'Model attempt timed out.',
  );
  if (timedOut) {
    return outcomeRetryable('attempt_timeout', status, true);
  }
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return deepFreeze({
      schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
      kind: 'aborted',
      classification: signal?.aborted ? 'cancelled' : 'transport_aborted',
    });
  }
  if (isTransientModelConnectionError(error)) {
    const classification =
      status === 429
        ? 'provider_rate_limited'
        : status != null && status >= 500
          ? 'provider_unavailable'
          : 'connection_failure';
    return outcomeRetryable(classification, status, false);
  }
  return outcomeFatal(
    status != null && status >= 400 && status < 500 ? 'provider_rejected' : 'provider_failure',
    status,
  );
}

function outcomeRetryable(
  classification: Extract<ModelAttemptOutcome, { kind: 'retryable_failure' }>['classification'],
  providerStatusCode: number | null,
  timedOut: boolean,
): ModelAttemptOutcome {
  return deepFreeze({
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
    kind: 'retryable_failure',
    classification,
    retryObservation: { providerStatusCode, timedOut },
  });
}

function outcomeFatal(
  classification: Extract<ModelAttemptOutcome, { kind: 'fatal_failure' }>['classification'],
  providerStatusCode: number | null,
): ModelAttemptOutcome {
  return deepFreeze({
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
    kind: 'fatal_failure',
    classification,
    providerStatusCode,
  });
}

function providerStatusCode(error: unknown): number | null {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const value =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : null;
  return value != null && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
