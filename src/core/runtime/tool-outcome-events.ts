import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import type { RuntimeState, ToolCallRecord } from './state';
import {
  classifyToolOutcomeV1,
  isToolOutcomeV1,
  type ToolExternalEffectsV1,
  type ToolOutcomeStatusV1,
  type ToolOutcomeV1,
} from './tool-outcome';
import { toolFailureInstanceIdV1 } from './tool-recovery-journal';

type ToolTerminalEvent = Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
>;

type ToolOutcomeEvent =
  | ToolTerminalEvent
  | Extract<RuntimeEvent, { type: 'tool.retry_recorded' | 'approval.rejected' }>
  | Extract<RuntimeEvent, { type: 'auto_review.completed' }>;

function historicalLegacyOutcomeV1(status: Exclude<ToolOutcomeStatusV1, 'unknown'>): ToolOutcomeV1 {
  return status === 'success'
    ? {
        schemaVersion: 1,
        status,
        dispatchState: 'unknown',
        externalEffects: 'unknown',
        recovery: {
          disposition: 'never',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
        timing: { source: 'legacy_unknown' },
      }
    : {
        schemaVersion: 1,
        status,
        failure: { kind: 'tool_runtime_error', detailCode: 'legacy_unclassified' },
        dispatchState: 'unknown',
        externalEffects: 'unknown',
        recovery: {
          disposition: 'never',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
        timing: { source: 'legacy_unknown' },
      };
}

function invalidHistoricalOutcomeV1(): ToolOutcomeV1 {
  return classifyToolOutcomeV1({
    status: 'failed',
    failure: classifyFailure('unknown', 'Persisted ToolOutcomeV1 was invalid.'),
    authority: { dispatchState: 'unknown', externalEffects: 'unknown' },
    classifierDiagnostic: 'classifier_invalid',
  });
}

function decodedHistoricalOutcomeV1(
  outcome: unknown,
  legacyStatus: Exclude<ToolOutcomeStatusV1, 'unknown'>,
): ToolOutcomeV1 {
  if (isToolOutcomeV1(outcome)) return outcome;
  return outcome == null ? historicalLegacyOutcomeV1(legacyStatus) : invalidHistoricalOutcomeV1();
}

/** Current consumers accept only the canonical outcome produced by the Kernel boundary. */
export function canonicalToolOutcomeV1(event: ToolOutcomeEvent): ToolOutcomeV1 {
  if (!isToolOutcomeV1(event.outcomeV1)) {
    throw new Error(`${event.type} requires a canonical ToolOutcomeV1.`);
  }
  return event.outcomeV1;
}

/**
 * Decode persisted pre-ToolOutcome terminal facts before they enter current reducers or UI replay.
 * This is the sole legacy ToolOutcome read path and never infers policy from text fields.
 */
export function decodeHistoricalToolOutcomeEventV1(event: RuntimeEvent): RuntimeEvent {
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
      return {
        ...event,
        outcomeV1: decodedHistoricalOutcomeV1(event.outcomeV1, statusFor(event)),
      } as RuntimeEvent;
    case 'tool.retry_recorded':
      return {
        ...event,
        outcomeV1: decodedHistoricalOutcomeV1(event.outcomeV1, 'failed'),
      };
    case 'approval.rejected':
      return {
        ...event,
        outcomeV1: decodedHistoricalOutcomeV1(event.outcomeV1, 'rejected'),
      };
    case 'auto_review.completed': {
      if (event.result.ok && !event.result.approved && !event.result.escalatedToUser) {
        return {
          ...event,
          outcomeV1: decodedHistoricalOutcomeV1(event.outcomeV1, 'rejected'),
        };
      }
      const { outcomeV1: _nonTerminalOutcome, ...nonTerminal } = event;
      return nonTerminal;
    }
    default:
      return event;
  }
}

/** Reject any current event that bypassed Kernel canonicalization. */
export function assertCanonicalToolOutcomeEventV1(event: RuntimeEvent): void {
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
    case 'tool.retry_recorded':
    case 'approval.rejected':
      canonicalToolOutcomeV1(event);
      return;
    case 'auto_review.completed':
      if (event.result.ok && !event.result.approved && !event.result.escalatedToUser) {
        canonicalToolOutcomeV1(event);
      } else if (event.outcomeV1 != null) {
        throw new Error('Non-terminal auto_review.completed cannot carry ToolOutcomeV1.');
      }
      return;
    default:
      return;
  }
}

function durationBetween(start: string | undefined, end: string): number | undefined {
  if (!start) return undefined;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function statusFor(event: ToolTerminalEvent): Exclude<ToolOutcomeStatusV1, 'unknown'> {
  if (event.type === 'tool.finished') {
    if (event.result.terminationReason === 'timed_out') return 'timed_out';
    if (event.result.terminationReason === 'cancelled') return 'cancelled';
    if (event.result.status === 'exhausted') return 'exhausted';
    return event.result.ok ? 'success' : 'failed';
  }
  if (event.type === 'tool.rejected') return 'rejected';
  if (event.type === 'tool.cancelled') return 'cancelled';
  if (event.failure?.kind === 'tool_timeout' || event.failure?.kind === 'user_input_timeout') {
    return 'timed_out';
  }
  if (event.failure?.kind === 'loop_exhausted' || event.failure?.kind === 'budget_exceeded') {
    return 'exhausted';
  }
  return 'failed';
}

function externalEffectsFor(
  event: ToolTerminalEvent,
  call: ToolCallRecord | undefined,
  dispatchState: ToolOutcomeV1['dispatchState'],
): ToolExternalEffectsV1 {
  if (dispatchState === 'not_started' || event.type === 'tool.rejected') return 'none';
  if (event.type === 'tool.cancelled' || event.type === 'tool.failed') {
    return call?.status === 'running' ? 'unknown' : 'none';
  }
  if (!call?.sideEffect) return 'none';
  if (event.result.resultMeta?.processCleanupConfirmed === false) return 'unknown';
  return event.result.ok ? 'known' : 'unknown';
}

function failureFor(event: ToolTerminalEvent) {
  if (event.type === 'tool.finished') {
    if (event.result.terminationReason === 'timed_out') {
      return classifyFailure('tool_timeout', 'Tool execution exceeded its Runtime deadline.');
    }
    if (event.result.terminationReason === 'cancelled') {
      return classifyFailure('user_input_cancelled', 'Tool execution was cancelled.');
    }
    if (event.result.terminationReason === 'sandbox_denied') {
      return classifyFailure('sandbox_error', 'Sandbox denied tool execution.');
    }
    return event.result.ok
      ? undefined
      : classifyFailure('tool_runtime_error', 'Tool returned a failed result.');
  }
  if (event.type === 'tool.failed') {
    return (
      event.failure ??
      classifyFailure('tool_runtime_error', event.error ?? 'Legacy tool failure replay.')
    );
  }
  if (event.type === 'tool.rejected') {
    return event.failure ?? classifyFailure('policy_denied', event.reason);
  }
  return classifyFailure('user_input_cancelled', event.reason);
}

/** Add the canonical ToolOutcomeV1 before persistence. Runtime state owns its authority facts. */
function normalizeToolTerminalEventV1(
  event: ToolTerminalEvent,
  state: Readonly<RuntimeState>,
  occurredAt: string,
): ToolTerminalEvent {
  const call = state.tools.calls[event.toolCallId];
  const createdAt = event.createdAt ?? occurredAt;
  const failure = failureFor(event);
  const status = statusFor(event);
  const dispatchState =
    event.type === 'tool.rejected' || call?.status === 'queued' || call?.status === 'approved'
      ? 'not_started'
      : call?.status === 'running'
        ? 'started'
        : 'unknown';
  const externalEffects = externalEffectsFor(event, call, dispatchState);
  const replaySafety =
    dispatchState === 'not_started' && externalEffects === 'none'
      ? ('pre_dispatch' as const)
      : dispatchState === 'started' &&
          call?.effectClass === 'read_only' &&
          externalEffects !== 'unknown'
        ? ('safe_read' as const)
        : ('none' as const);
  const recoveryBlocked = call?.recoveryAdmission && call.recoveryAdmission !== 'admitted';
  const toolAdvice = recoveryBlocked
    ? {
        detailCode: call.recoveryAdmission,
        disposition: 'never' as const,
        maximumAdditionalCalls: 0,
        safeAutomaticRetry: false,
      }
    : event.type === 'tool.finished' && !event.result.ok
      ? event.classifierAdviceV1
      : undefined;
  const classifierDiagnostic =
    event.type === 'tool.finished' &&
    status === 'failed' &&
    failure?.kind === 'tool_runtime_error' &&
    !recoveryBlocked
      ? (event.classifierDiagnostic ??
        (event.classifierAdviceV1 ? undefined : ('classifier_missing' as const)))
      : undefined;
  const base = classifyToolOutcomeV1({
    status,
    failure,
    authority: {
      dispatchState,
      externalEffects,
      replaySafety,
      policyDenied:
        failure?.kind === 'policy_denied' || failure?.kind === 'mandatory_policy_unavailable',
      approvalDenied:
        failure?.kind === 'approval_rejected' || failure?.kind === 'auto_review_rejected',
    },
    lineage: call?.recoveryOf ? { recoveryOf: call.recoveryOf } : undefined,
    timing: {
      queueMs: durationBetween(call?.queuedAt, call?.startedAt ?? createdAt),
      executionMs: durationBetween(call?.startedAt, createdAt),
      approvalWaitMs: call?.approvalWaitMs,
      totalActiveMs: durationBetween(call?.queuedAt, createdAt),
    },
    unknownFields: call?.unknownFields,
    ...(toolAdvice ? { toolAdvice } : {}),
    ...(classifierDiagnostic ? { classifierDiagnostic } : {}),
  });
  const fingerprint = call?.invocationFingerprint;
  const outcomeV1 =
    status !== 'success' && fingerprint
      ? {
          ...base,
          lineage: {
            ...base.lineage,
            failureInstanceId: toolFailureInstanceIdV1({
              toolCallId: event.toolCallId,
              invocationFingerprint: fingerprint,
              outcome: base,
            }),
          },
        }
      : base;
  return { ...event, createdAt, outcomeV1 } as ToolTerminalEvent;
}

function normalizeApprovalRejectedToolOutcomeV1(
  event: Extract<RuntimeEvent, { type: 'approval.rejected' }>,
  state: Readonly<RuntimeState>,
  occurredAt: string,
): Extract<RuntimeEvent, { type: 'approval.rejected' }> {
  const call = event.toolCallId ? state.tools.calls[event.toolCallId] : undefined;
  const createdAt = event.createdAt ?? occurredAt;
  return {
    ...event,
    createdAt,
    outcomeV1: classifyToolOutcomeV1({
      status: 'rejected',
      failure: event.failure ?? classifyFailure('approval_rejected', event.reason),
      authority: {
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
        approvalDenied: true,
      },
      timing: {
        queueMs: durationBetween(call?.queuedAt, createdAt),
        approvalWaitMs: durationBetween(call?.approvalRequestedAt, createdAt),
        totalActiveMs: durationBetween(call?.queuedAt, createdAt),
      },
      unknownFields: call?.unknownFields,
    }),
  };
}

function normalizeAutoReviewCompletedToolOutcomeV1(
  event: Extract<RuntimeEvent, { type: 'auto_review.completed' }>,
  state: Readonly<RuntimeState>,
  occurredAt: string,
): Extract<RuntimeEvent, { type: 'auto_review.completed' }> {
  if (!event.result.ok || event.result.approved || event.result.escalatedToUser) {
    const { outcomeV1: _nonTerminalOutcome, ...nonTerminal } = event;
    return nonTerminal;
  }
  const call = state.tools.calls[event.toolCallId];
  const createdAt = event.createdAt ?? occurredAt;
  const queueMs = durationBetween(call?.queuedAt, createdAt);
  const approvalWaitMs = event.result.durationMs;
  const totalActiveMs = Math.max(queueMs ?? 0, approvalWaitMs);
  return {
    ...event,
    createdAt,
    outcomeV1: classifyToolOutcomeV1({
      status: 'rejected',
      failure: classifyFailure('auto_review_rejected', 'Auto-review rejected the tool.'),
      authority: {
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
        approvalDenied: true,
      },
      timing: {
        queueMs,
        approvalWaitMs,
        totalActiveMs,
      },
      unknownFields: call?.unknownFields,
    }),
  };
}

/** Sole current-event ToolOutcome canonicalization boundary used before persistence. */
export function normalizeCurrentToolOutcomeEventV1(
  event: RuntimeEvent,
  state: Readonly<RuntimeState>,
  occurredAt: string,
): RuntimeEvent {
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
      return normalizeToolTerminalEventV1(event, state, occurredAt);
    case 'approval.rejected':
      return normalizeApprovalRejectedToolOutcomeV1(event, state, occurredAt);
    case 'auto_review.completed':
      return normalizeAutoReviewCompletedToolOutcomeV1(event, state, occurredAt);
    default:
      return event;
  }
}
