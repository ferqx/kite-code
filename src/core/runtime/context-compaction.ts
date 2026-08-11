import type { ContextTokenEstimate } from '@/core/model/context-budget';

export type ContextCompactionReason = 'manual' | 'auto';

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

export interface ContextCompactionCheckpointV1 {
  compactionId: string;
  version: 1;
  sourceRevision: number;
  sourceDigest: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  /** The only model-generated content: normalized Markdown narrative. */
  summary: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  reason: ContextCompactionReason;
  createdAt: string;
  /** When this checkpoint was built on top of a previous one (incremental compaction). */
  baseCheckpointId?: string;
}

export type ContextCompactionCheckpoint = ContextCompactionCheckpointV1;

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
  | 'oversized_turn'
  | 'summary_model_failed'
  | 'provider_admission_denied'
  | 'summary_aborted'
  | 'empty_summary'
  | 'truncated_summary'
  | 'unexpected_tool_call'
  | 'summary_input_too_large'
  | 'unknown_external_outcome'
  | 'stale_context'
  | 'invalid_candidate'
  | 'insufficient_reduction';

export interface ContextCompactionFailure {
  compactionId: string;
  sourceRevision: number;
  errorKind: ContextCompactionErrorKind;
  message: string;
  retryable: boolean;
  reason?: ContextCompactionReason;
  /** Present for current events; optional only for restored legacy failures. */
  requestedAtTurnId?: string;
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

export interface ContextCorrectnessFailure {
  reason: ContextHardBlockReason;
  sourceDigest: string;
  message: string;
  createdAtTurnId: string;
}

/** The only constructor for a durable context correctness block. */
export function createContextCorrectnessBlock(
  failure: ContextCorrectnessFailure,
): ContextHardBlock {
  if (!isContextHardBlockReason(failure.reason)) {
    throw new Error(`Unsupported context correctness failure: ${String(failure.reason)}`);
  }
  if (!failure.sourceDigest || !failure.createdAtTurnId || !failure.message.trim()) {
    throw new Error('Context correctness failures require digest, turn, and message evidence.');
  }
  return { ...failure, message: failure.message.trim() };
}

export interface ContextRuntimeState {
  activeCheckpoint?: ContextCompactionCheckpoint;
  pendingCompaction?: PendingContextCompaction;
  lastFailure?: ContextCompactionFailure;
  history: ContextCompactionHistoryEntry[];
  lastCompactionTurnIndex?: number;
  /** Durable block reserved for proven Runtime correctness failures. */
  hardBlock?: ContextHardBlock;
  /** Metadata-only L2 watermark; immutable transcript bytes remain authoritative. */
  reclaimCommit?: import('@/core/model/context-reclaim-commit').ContextReclaimCommitV1;
  /** Last verified receipt authenticating the current reclaimCommit. */
  lastReclaimReceipt?: import('@/core/model/context-reclaim-commit').ContextReclaimAppliedReceiptV1;
  /** Transient only while replaying/applying one closed primary terminal batch. */
  pendingPrimaryReclaim?: import('@/core/model/context-reclaim-commit').ContextPrimaryRequestEvidenceV2;
}

/**
 * Converges restored development snapshots without retaining values outside
 * the current type schema. Capacity-era hard blocks are discarded.
 */
export function normalizeContextRuntimeState(
  context: ContextRuntimeState | undefined,
): ContextRuntimeState {
  if (!context) return { history: [] };

  const normalizeCheckpoint = (
    checkpoint: ContextCompactionCheckpoint | undefined,
  ): ContextCompactionCheckpoint | undefined => {
    if (!checkpoint) return undefined;
    const reason = normalizeContextCompactionReason(checkpoint.reason);
    const validCommonEnvelope =
      Boolean(checkpoint.compactionId) &&
      Number.isInteger(checkpoint.sourceRevision) &&
      checkpoint.sourceRevision >= 0 &&
      Boolean(checkpoint.sourceDigest) &&
      Boolean(checkpoint.coveredThroughMessageId) &&
      Boolean(checkpoint.coveredThroughTurnId) &&
      Number.isFinite(checkpoint.inputTokensBefore) &&
      Number.isFinite(checkpoint.inputTokensAfter) &&
      checkpoint.inputTokensBefore > checkpoint.inputTokensAfter &&
      checkpoint.inputTokensAfter >= 0 &&
      Boolean(checkpoint.createdAt);
    if (
      !reason ||
      !validCommonEnvelope ||
      typeof checkpoint.summary !== 'string' ||
      !checkpoint.summary.trim()
    ) {
      return undefined;
    }
    return checkpoint.version === 1
      ? { ...checkpoint, summary: checkpoint.summary.trim(), reason }
      : undefined;
  };
  const normalizeFailure = (
    failure: ContextCompactionFailure | undefined,
  ): ContextCompactionFailure | undefined => {
    if (!failure) return undefined;
    const reason = normalizeContextCompactionReason(failure.reason);
    return { ...failure, ...(reason ? { reason } : { reason: undefined }) };
  };
  const hardBlock = context.hardBlock as ContextHardBlock | undefined;
  const normalizedActiveCheckpoint = normalizeCheckpoint(context.activeCheckpoint);
  const corruptedActiveCheckpoint = Boolean(
    context.activeCheckpoint && !normalizedActiveCheckpoint,
  );

  const {
    autoGuard: _legacyAutoGuard,
    autoGuardV2: _legacyAutoGuardV2,
    ...currentContext
  } = context as ContextRuntimeState & { autoGuard?: unknown; autoGuardV2?: unknown };
  return {
    ...currentContext,
    activeCheckpoint: normalizedActiveCheckpoint,
    pendingCompaction: context.pendingCompaction
      ? (() => {
          const reason = normalizeContextCompactionReason(context.pendingCompaction.reason);
          return reason === 'manual'
            ? { ...context.pendingCompaction, reason, force: false }
            : undefined;
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
    hardBlock: corruptedActiveCheckpoint
      ? {
          reason: 'unrecoverable_checkpoint',
          sourceDigest:
            typeof context.activeCheckpoint?.sourceDigest === 'string' &&
            context.activeCheckpoint.sourceDigest
              ? context.activeCheckpoint.sourceDigest
              : `checkpoint:${context.activeCheckpoint?.compactionId ?? 'unknown'}`,
          message: 'The persisted context checkpoint failed validation.',
          createdAtTurnId: context.activeCheckpoint?.coveredThroughTurnId || 'unknown',
        }
      : hardBlock && isContextHardBlockReason(hardBlock.reason)
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
  };
}
