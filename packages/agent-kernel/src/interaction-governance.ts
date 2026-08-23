import type { AgentState } from './state';

export const PLAN_REVIEW_SIBLING_CANCELLATION_REASON_V1 =
  'Cancelled because an earlier tool call opened an interaction.' as const;

export interface PlanReviewSiblingCancellationDecisionV1 {
  readonly toolCallId: string;
  readonly reason: typeof PLAN_REVIEW_SIBLING_CANCELLATION_REASON_V1;
}

/**
 * Pure State decision for queued calls hidden behind a Plan review barrier.
 * It reads only committed Tool facts and performs no persistence or event IO.
 */
export function decidePlanReviewSiblingCancellationsV1(
  state: Readonly<AgentState>,
  openingToolCallId: string,
): readonly Readonly<PlanReviewSiblingCancellationDecisionV1>[] {
  const opening = state.tools.calls[openingToolCallId];
  if (!opening) return Object.freeze([]);
  const openingOrdinal = opening.ordinal ?? 0;
  return Object.freeze(
    Object.values(state.tools.calls)
      .filter(
        (candidate) =>
          candidate.toolCallId !== openingToolCallId &&
          candidate.status === 'queued' &&
          candidate.modelMessageId === opening.modelMessageId &&
          (candidate.ordinal ?? 0) > openingOrdinal,
      )
      .map((candidate) =>
        Object.freeze({
          toolCallId: candidate.toolCallId,
          reason: PLAN_REVIEW_SIBLING_CANCELLATION_REASON_V1,
        }),
      ),
  );
}
