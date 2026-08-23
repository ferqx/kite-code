export type ContextCompactionReason = 'manual' | 'auto';
export type ContextHardBlockReason =
  | 'unsafe_context_projection'
  | 'corrupted_runtime_state'
  | 'corrupted_event_tail'
  | 'unrecoverable_checkpoint'
  | 'runtime_invariant_violation';
export interface ContextCompactionCheckpoint {
  readonly compactionId: string;
  readonly modelInvocationId?: string;
  readonly version: 1;
  readonly sourceRevision: number;
  readonly sourceDigest: string;
  readonly coveredThroughMessageId: string;
  readonly coveredThroughTurnId: string;
  readonly summary: string;
  readonly inputTokensBefore: number;
  readonly inputTokensAfter: number;
  readonly reason: ContextCompactionReason;
  readonly createdAt: string;
  readonly baseCheckpointId?: string;
}
export interface ContextTokenEstimate {
  readonly systemTokens: number;
  readonly toolSchemaTokens: number;
  readonly transcriptTokens: number;
  readonly summaryTokens: number;
  readonly dynamicRuntimeTokens: number;
  readonly framingTokens: number;
  readonly totalInputTokens: number;
}
export interface PendingContextCompaction {
  readonly compactionId: string;
  readonly reason: ContextCompactionReason;
  readonly requestedAtRevision: number;
  readonly requestedAtTurnId: string;
  readonly force: boolean;
  readonly estimate: ContextTokenEstimate;
  readonly customInstructions?: string;
}
export type ContextCompactionErrorKind =
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
export interface ContextCompactionFailure {
  readonly compactionId: string;
  readonly sourceRevision: number;
  readonly errorKind: ContextCompactionErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly reason?: ContextCompactionReason;
  readonly requestedAtTurnId?: string;
}
export type ContextHistoryEntry =
  | { readonly kind: 'completed'; readonly checkpoint: ContextCompactionCheckpoint }
  | { readonly kind: 'failed'; readonly failure: ContextCompactionFailure }
  | { readonly kind: 'reset'; readonly compactionId: string; readonly reason: 'manual' };
export interface ContextHardBlock {
  readonly reason: ContextHardBlockReason;
  readonly sourceDigest: string;
  readonly message: string;
  readonly createdAtTurnId: string;
}
export interface ContextAutoGuardEntry {
  readonly turnIndex: number;
  readonly reductionRatio: number;
  readonly tokensAfter: number;
}

export interface AgentContextState {
  readonly activeCheckpoint?: ContextCompactionCheckpoint;
  readonly pendingCompaction?: PendingContextCompaction;
  readonly lastFailure?: ContextCompactionFailure;
  readonly history: readonly ContextHistoryEntry[];
  readonly lastCompactionTurnIndex?: number;
  readonly hardBlock?: ContextHardBlock;
  readonly autoGuard: {
    readonly recentAutomaticCompactions: readonly ContextAutoGuardEntry[];
    readonly consecutiveLowGain: number;
    readonly disabledUntilManualAction: boolean;
    readonly recoveryAttempted: boolean;
  };
}
