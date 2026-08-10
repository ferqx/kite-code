import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import type { RuntimeState, ToolCallRecord } from './state';
import {
  classifyToolOutcomeV1,
  isToolOutcomeV1,
  legacyToolOutcomeV1,
  type ToolExternalEffectsV1,
  type ToolOutcomeStatusV1,
} from './tool-outcome';
import { toolFailureInstanceIdV1 } from './tool-recovery-journal';

type ToolTerminalEvent = Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
>;

function durationBetween(start: string | undefined, end: string): number | undefined {
  if (!start) return undefined;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function statusFor(event: ToolTerminalEvent): ToolOutcomeStatusV1 {
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
): ToolExternalEffectsV1 {
  if (event.type === 'tool.rejected') return 'none';
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

/**
 * Adds ToolOutcomeV1 to the same legacy terminal event before persistence. The Runtime state,
 * never tool output, owns dispatch/effect/timing/lineage facts.
 */
export function normalizeToolTerminalEventV1(
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
  const externalEffects = externalEffectsFor(event, call);
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
      policyDenied: event.type === 'tool.rejected' && failure?.kind === 'policy_denied',
      approvalDenied: event.type === 'tool.rejected' && failure?.kind === 'approval_rejected',
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

/** Historical terminal replay never infers classification from legacy text. */
export function outcomeForHistoricalToolTerminalV1(event: ToolTerminalEvent) {
  if (isToolOutcomeV1(event.outcomeV1)) return event.outcomeV1;
  if (event.outcomeV1 != null) {
    return classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('unknown', 'Persisted ToolOutcomeV1 was invalid.'),
      authority: { dispatchState: 'unknown', externalEffects: 'unknown' },
      classifierDiagnostic: 'classifier_invalid',
    });
  }
  const status = statusFor(event);
  return legacyToolOutcomeV1(status === 'unknown' ? 'failed' : status);
}

export function normalizeApprovalRejectedToolOutcomeV1(
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

export function normalizeAutoReviewCompletedToolOutcomeV1(
  event: Extract<RuntimeEvent, { type: 'auto_review.completed' }>,
  state: Readonly<RuntimeState>,
  occurredAt: string,
): Extract<RuntimeEvent, { type: 'auto_review.completed' }> {
  if (!event.result.ok || event.result.approved) return event;
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
