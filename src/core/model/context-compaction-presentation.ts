import type { RuntimeEvent } from '@/core/runtime/events';

export type ContextCompactionProgressPhase = 'preparing' | 'summarizing' | 'validating';

export interface ContextCompactionTerminalNotice {
  compactionId: string;
  kind: 'completed' | 'failed' | 'cancelled';
  message: string;
  isError: boolean;
}

/** One redacted user-facing terminal notice for a durable compaction result. */
export function contextCompactionTerminalNotice(
  event: Extract<
    RuntimeEvent,
    { type: 'context.compaction_completed' | 'context.compaction_failed' }
  >,
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
  return {
    compactionId: event.compactionId,
    kind: cancelled ? 'cancelled' : 'failed',
    message:
      event.errorKind === 'unsafe_boundary' && !event.retryable
        ? event.message
        : cancelled
          ? 'Context compaction was cancelled; the original conversation was preserved.'
          : event.errorKind === 'summary_model_failed'
            ? 'Context compaction was rejected by the provider; check the selected model contextWindowTokens configuration or run /clear. The original conversation was preserved.'
            : 'Context compaction failed; the original conversation was preserved.',
    isError: !cancelled && !(event.errorKind === 'unsafe_boundary' && !event.retryable),
  };
}
