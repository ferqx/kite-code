import type { StructuredContextSummary } from '@/core/model/compaction-schema';
import type { ContextPreflight, ContextTokenEstimate } from '@/core/model/context-budget';

export type ContextCompactionReason = 'manual' | 'auto';

export type ContextCompactionAutoMode = 'off' | 'shadow' | 'live';

export type ContextHardBlockReason =
  | 'unsafe_context_projection'
  | 'corrupted_runtime_state'
  | 'corrupted_event_tail'
  | 'unrecoverable_checkpoint'
  | 'runtime_invariant_violation';

const CONTEXT_HARD_BLOCK_REASONS = new Set<ContextHardBlockReason>([
  'unsafe_context_projection',
  'corrupted_runtime_state',
  'corrupted_event_tail',
  'unrecoverable_checkpoint',
  'runtime_invariant_violation',
]);

/** Rejects persisted reason values that are outside the current schema. */
export function normalizeContextCompactionReason(value: unknown): ContextCompactionReason | null {
  return value === 'manual' || value === 'auto' ? value : null;
}

export function isContextHardBlockReason(value: unknown): value is ContextHardBlockReason {
  return CONTEXT_HARD_BLOCK_REASONS.has(value as ContextHardBlockReason);
}

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
  /** Reserved compatibility field; all current requests use false. */
  force: boolean;
  estimate: ContextTokenEstimate;
  /** Optional user-supplied instructions for the summary model. */
  customInstructions?: string;
}

export type ContextCompactionErrorKind =
  | 'unsafe_boundary'
  | 'summary_model_failed'
  | 'invalid_schema'
  | 'invalid_provenance'
  | 'invalid_evidence'
  | 'missing_user_coverage'
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
 * Durable Runtime correctness block. Capacity estimates, Provider failures,
 * and compaction failures must never create or clear this state.
 */
export interface ContextHardBlock {
  reason: ContextHardBlockReason;
  sourceDigest: string;
  message: string;
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
  lastCompactionTurnIndex?: number;
  lastPreflight?: ContextPreflight;
  /** Durable block reserved for proven Runtime correctness failures. */
  hardBlock?: ContextHardBlock;
  /** Thrash breaker state for auto-compaction. */
  autoGuard: AutoCompactionGuard;
}

/**
 * Converges restored development snapshots without retaining values outside
 * the current type schema. Capacity-era hard blocks are discarded.
 */
export function normalizeContextRuntimeState(
  context: ContextRuntimeState | undefined,
): ContextRuntimeState {
  const fallbackGuard: AutoCompactionGuard = {
    recentAutomaticCompactions: [],
    consecutiveLowGain: 0,
    disabledUntilManualAction: false,
  };
  if (!context) return { history: [], autoGuard: fallbackGuard };

  const normalizeCheckpoint = (
    checkpoint: ContextCompactionCheckpoint | undefined,
  ): ContextCompactionCheckpoint | undefined => {
    if (!checkpoint) return undefined;
    const reason = normalizeContextCompactionReason(checkpoint.reason);
    return reason ? { ...checkpoint, reason } : undefined;
  };
  const normalizeFailure = (
    failure: ContextCompactionFailure | undefined,
  ): ContextCompactionFailure | undefined => {
    if (!failure) return undefined;
    const reason = normalizeContextCompactionReason(failure.reason);
    return { ...failure, ...(reason ? { reason } : { reason: undefined }) };
  };
  const hardBlock = context.hardBlock as ContextHardBlock | undefined;

  return {
    ...context,
    activeCheckpoint: normalizeCheckpoint(context.activeCheckpoint),
    pendingCompaction: context.pendingCompaction
      ? (() => {
          const reason = normalizeContextCompactionReason(context.pendingCompaction.reason);
          return reason ? { ...context.pendingCompaction, reason, force: false } : undefined;
        })()
      : undefined,
    lastFailure: normalizeFailure(context.lastFailure),
    history: (context.history ?? []).flatMap((entry): ContextCompactionHistoryEntry[] => {
      if (entry.kind === 'completed') {
        const checkpoint = normalizeCheckpoint(entry.checkpoint);
        return checkpoint ? [{ kind: 'completed', checkpoint }] : [];
      }
      if (entry.kind === 'failed') {
        const failure = normalizeFailure(entry.failure);
        return failure ? [{ kind: 'failed', failure }] : [];
      }
      return [{ kind: 'reset', compactionId: entry.compactionId, reason: 'manual' }];
    }),
    hardBlock:
      hardBlock && isContextHardBlockReason(hardBlock.reason)
        ? {
            reason: hardBlock.reason,
            sourceDigest: hardBlock.sourceDigest,
            message:
              typeof hardBlock.message === 'string'
                ? hardBlock.message
                : 'Runtime correctness failure.',
            createdAtTurnId: hardBlock.createdAtTurnId,
          }
        : undefined,
    autoGuard: context.autoGuard ?? fallbackGuard,
  };
}
