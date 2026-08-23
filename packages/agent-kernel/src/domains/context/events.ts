import type { ContextTokenEstimate } from './state';

export type ContextEventMap = {
  'context.compaction_requested': {
    type: 'context.compaction_requested';
    compactionId: string;
    reason: 'manual' | 'auto';
    requestedAtRevision: number;
    requestedAtTurnId: string;
    force: boolean;
    estimate: ContextTokenEstimate;
    customInstructions?: string;
  };
  'context.compaction_completed': {
    type: 'context.compaction_completed';
    compactionId: string;
    sourceRevision: number;
    checkpoint: {
      compactionId: string;
      modelInvocationId?: string;
      version: 1;
      sourceRevision: number;
      sourceDigest: string;
      coveredThroughMessageId: string;
      coveredThroughTurnId: string;
      summary: string;
      inputTokensBefore: number;
      inputTokensAfter: number;
      reason: 'manual' | 'auto';
      createdAt: string;
      baseCheckpointId?: string;
    };
    durationMs?: number;
  };
  'context.compaction_failed': {
    type: 'context.compaction_failed';
    compactionId: string;
    sourceRevision: number;
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
    requestedAtTurnId?: string;
    durationMs?: number;
  };
  'context.compaction_reset': {
    type: 'context.compaction_reset';
    checkpointId: string;
    reason: 'manual';
  };
  'context.hard_block_cleared': {
    type: 'context.hard_block_cleared';
    reason:
      | 'unsafe_context_projection'
      | 'corrupted_runtime_state'
      | 'corrupted_event_tail'
      | 'unrecoverable_checkpoint'
      | 'runtime_invariant_violation';
    sourceDigest: string;
  };
  'context.hard_blocked': {
    type: 'context.hard_blocked';
    reason:
      | 'unsafe_context_projection'
      | 'corrupted_runtime_state'
      | 'corrupted_event_tail'
      | 'unrecoverable_checkpoint'
      | 'runtime_invariant_violation';
    sourceDigest: string;
    message: string;
    createdAtTurnId: string;
  };
};
