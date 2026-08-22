type ContextCompactionTerminalEventV1 =
  | {
      type: 'context.compaction_completed';
      compactionId: string;
      checkpoint: { inputTokensBefore: number; inputTokensAfter: number };
    }
  | {
      type: 'context.compaction_failed';
      compactionId: string;
      errorKind:
        | 'unsafe_boundary'
        | 'oversized_turn'
        | 'summary_model_failed'
        | 'provider_admission_denied'
        | 'summary_aborted'
        | 'empty_summary'
        | 'truncated_summary'
        | 'unexpected_tool_call'
        | 'stale_context'
        | 'invalid_candidate'
        | 'insufficient_reduction';
      message: string;
      retryable: boolean;
    };

export type ContextCompactionProgressPhase = 'preparing' | 'summarizing' | 'validating';

export interface ContextCompactionTerminalNotice {
  compactionId: string;
  kind: 'completed' | 'failed' | 'cancelled';
  message: string;
  isError: boolean;
}

/** One redacted user-facing terminal notice for a durable compaction result. */
export function contextCompactionTerminalNotice(
  event: ContextCompactionTerminalEventV1,
): ContextCompactionTerminalNotice {
  if (event.type === 'context.compaction_completed') {
    return {
      compactionId: event.compactionId,
      kind: 'completed',
      message: `Compacted ${event.checkpoint.inputTokensBefore} → ${event.checkpoint.inputTokensAfter} tokens.`,
      isError: false,
    };
  }
  const cancelled = event.errorKind === 'summary_aborted';
  const benign =
    (event.errorKind === 'unsafe_boundary' || event.errorKind === 'insufficient_reduction') &&
    !event.retryable;
  const message = (() => {
    if (benign) return event.message;
    if (cancelled) {
      return 'Context compaction was cancelled; the original conversation was preserved.';
    }
    switch (event.errorKind) {
      case 'stale_context':
        return 'Context changed while compaction was running; retry /compact. The original conversation was preserved.';
      case 'oversized_turn':
        return 'The conversation exceeds compaction.maxSummaryInputTokens; increase that limit or run /clear. The original conversation was preserved.';
      case 'empty_summary':
      case 'truncated_summary':
      case 'unexpected_tool_call':
        return 'The selected model returned an unusable compaction summary; try another model or adjust the compaction summary limits. The original conversation was preserved.';
      case 'summary_model_failed':
        return 'The compaction Provider request failed; check the selected model, credentials, connection, and context/output limits, then retry or run /clear. The original conversation was preserved.';
      case 'provider_admission_denied':
        return 'Provider data policy blocked context compaction; review the selected provider policy or choose an approved route. The original conversation was preserved.';
      case 'invalid_candidate':
        return 'The generated compaction checkpoint failed validation; retry /compact. The original conversation was preserved.';
      case 'insufficient_reduction':
        return 'Compaction did not reduce enough context; continue the conversation before retrying. The original conversation was preserved.';
      default:
        return 'Context compaction failed; the original conversation was preserved.';
    }
  })();
  return {
    compactionId: event.compactionId,
    kind: cancelled ? 'cancelled' : 'failed',
    message,
    isError: !cancelled && !benign,
  };
}
