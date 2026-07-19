import type { StructuredContextSummary } from '@/core/model/compaction-schema';
import type { ContextPreflight, ContextTokenEstimate } from '@/core/model/context-budget';

export type ContextCompactionReason = 'manual' | 'auto_soft' | 'auto_hard' | 'overflow_recovery';

export interface ContextCompactionCheckpoint {
  compactionId: string;
  version: 1;
  sourceRevision: number;
  sourceDigest: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  /** V1 for backward compat, V2 for current — use `summary.version` to discriminate. */
  summary: StructuredContextSummary;
  inputTokensBefore: number;
  inputTokensAfter: number;
  targetTokens: number;
  reason: ContextCompactionReason;
  createdAt: string;
  /** When this checkpoint was built on top of a previous one (incremental compaction). */
  baseCheckpointId?: string;
  /** Summary schema version used (maps to summary.version). */
  summaryVersion?: number;
  /** Compaction policy version at creation time. */
  policyVersion?: string;
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
  /** Tool definitions for candidate projection validation (PR 5). */
  tools?: Record<string, unknown>;
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

/**
 * Durable hard-limit block.
 * Once set, the block persists across unrelated revisions — only explicit
 * recovery actions (compaction success, /clear, rewind, or significant config
 * change) can clear it.
 */
export interface ContextHardBlock {
  reason: 'hard_limit' | 'overflow_recovery_failed';
  compactionId?: string;
  sourceDigest: string;
  failure: ContextCompactionFailure;
  createdAtTurnId: string;
}

/**
 * Session-level circuit breaker that stops proactive auto-compaction
 * when the context refills too quickly or produces persistently low gain.
 */
export interface AutoCompactionGuard {
  recentAutomaticCompactions: Array<{
    turnIndex: number;
    reductionRatio: number;
    tokensAfter: number;
  }>;
  consecutiveLowGain: number;
  disabledUntilManualAction: boolean;
}

export interface ContextRuntimeState {
  activeCheckpoint?: ContextCompactionCheckpoint;
  pendingCompaction?: PendingContextCompaction;
  lastFailure?: ContextCompactionFailure;
  history: ContextCompactionHistoryEntry[];
  /** Limits provider overflow recovery to once per Runtime turn. */
  overflowRecoveryTurnId?: string;
  lastCompactionTurnIndex?: number;
  lastPreflight?: ContextPreflight;
  /** Durable block set when hard-limit compaction fails. */
  hardBlock?: ContextHardBlock;
  /** Thrash breaker state for auto-compaction. */
  autoGuard: AutoCompactionGuard;
}
