import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
  type ModelAttemptOutcomeV1,
  type ModelSurfaceV1,
} from '@kite/runtime-spi';
import { isTransientModelConnectionError } from './deepseek';
import type { SupportedChatModel } from './factory';
import { invokeModelTransportSingleAttemptV1, type ModelTransportResponseV1 } from './transport';

export type SingleAttemptTransportV1 = typeof invokeModelTransportSingleAttemptV1;

export interface ModelResponseSourceAttemptInputV1 {
  surface: ModelSurfaceV1;
  attemptOrdinal: number;
  model: SupportedChatModel;
  signal?: AbortSignal;
  onActivity?: () => void;
  onTextCumulative?: (text: string) => void;
  onReasoningCumulative?: (text: string, segmentId: string) => void;
  onReasoningCompleted?: (text: string, segmentId: string) => void;
}

/** Exactly one outcome. Retry, backoff and the next attempt ack remain Gateway-owned. */
export interface ModelResponseSourceV1 {
  attempt(input: ModelResponseSourceAttemptInputV1): Promise<ModelAttemptOutcomeV1>;
  /** Live-only diagnostic cause; never persisted or copied into Runtime events. */
  failureError?(outcome: Exclude<ModelAttemptOutcomeV1, { kind: 'success' }>): Error | undefined;
}

export class ModelAttemptFailureErrorV1 extends Error {
  readonly outcome: Exclude<ModelAttemptOutcomeV1, { kind: 'success' }>;

  constructor(outcome: Exclude<ModelAttemptOutcomeV1, { kind: 'success' }>, cause?: Error) {
    super(
      `MODEL_ATTEMPT_${outcome.kind.toUpperCase()}:${outcome.classification}`,
      cause ? { cause } : undefined,
    );
    this.name = 'ModelAttemptFailureErrorV1';
    this.outcome = outcome;
  }
}

export function createLiveModelResponseSourceV1(
  transport: SingleAttemptTransportV1 = invokeModelTransportSingleAttemptV1,
): ModelResponseSourceV1 {
  const failureCauses = new WeakMap<object, Error>();
  return Object.freeze({
    attempt: async (input: ModelResponseSourceAttemptInputV1) => {
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
    failureError: (outcome: Exclude<ModelAttemptOutcomeV1, { kind: 'success' }>) =>
      failureCauses.get(outcome),
  });
}

function outcomeSuccess(response: ModelTransportResponseV1): ModelAttemptOutcomeV1 {
  return deepFreeze({
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
    kind: 'success',
    response,
    nativeReplayState: null,
  });
}

function outcomeFromTransportFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): ModelAttemptOutcomeV1 {
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
      schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
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
  classification: Extract<ModelAttemptOutcomeV1, { kind: 'retryable_failure' }>['classification'],
  providerStatusCode: number | null,
  timedOut: boolean,
): ModelAttemptOutcomeV1 {
  return deepFreeze({
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
    kind: 'retryable_failure',
    classification,
    retryObservation: { providerStatusCode, timedOut },
  });
}

function outcomeFatal(
  classification: Extract<ModelAttemptOutcomeV1, { kind: 'fatal_failure' }>['classification'],
  providerStatusCode: number | null,
): ModelAttemptOutcomeV1 {
  return deepFreeze({
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
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
