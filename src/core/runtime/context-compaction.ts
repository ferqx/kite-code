import type { StructuredContextSummaryV1 } from '@/core/model/compaction-schema';
import type { ContextPreflight, ContextTokenEstimate } from '@/core/model/context-budget';

export type ContextCompactionReason = 'manual' | 'auto_soft' | 'auto_hard' | 'overflow_recovery';

export interface ContextCompactionCheckpoint {
  compactionId: string;
  version: 1;
  sourceRevision: number;
  sourceDigest: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  summary: StructuredContextSummaryV1;
  inputTokensBefore: number;
  inputTokensAfter: number;
  targetTokens: number;
  reason: ContextCompactionReason;
  createdAt: string;
}

export interface PendingContextCompaction {
  compactionId: string;
  reason: ContextCompactionReason;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  force: boolean;
  estimate: ContextTokenEstimate;
  /** Optional user-supplied instructions for the summary model. */
  customInstructions?: string;
}

export type ContextCompactionErrorKind =
  | 'unsafe_boundary'
  | 'summary_model_failed'
  | 'invalid_schema'
  | 'missing_mandatory_facts'
  | 'insufficient_reduction'
  | 'stale_source';

export interface ContextCompactionFailure {
  compactionId: string;
  sourceRevision: number;
  errorKind: ContextCompactionErrorKind;
  message: string;
  retryable: boolean;
  reason?: ContextCompactionReason;
}

export type ContextCompactionHistoryEntry =
  | { kind: 'completed'; checkpoint: ContextCompactionCheckpoint }
  | { kind: 'failed'; failure: ContextCompactionFailure }
  | { kind: 'reset'; compactionId: string; reason: 'manual' };

export interface ContextRuntimeState {
  activeCheckpoint?: ContextCompactionCheckpoint;
  pendingCompaction?: PendingContextCompaction;
  lastFailure?: ContextCompactionFailure;
  history: ContextCompactionHistoryEntry[];
  /** Limits provider overflow recovery to once per Runtime turn. */
  overflowRecoveryTurnId?: string;
  lastCompactionTurnIndex?: number;
  lastPreflight?: ContextPreflight;
}
