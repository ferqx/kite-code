import type {
  AgentContextState,
  ContextCompactionCheckpoint,
  ContextCompactionFailure,
  ContextCompactionReason,
  ContextHardBlock,
  ContextHardBlockReason,
  ContextHistoryEntry,
} from './state';

type MutableStateConstruction<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { -readonly [Key in keyof T]: MutableStateConstruction<T[Key]> }
      : T;

/** Mutable construction view used only by State restore/fault fixtures. */
export type ContextRuntimeState = MutableStateConstruction<AgentContextState>;
export type MutableContextCompactionCheckpoint =
  MutableStateConstruction<ContextCompactionCheckpoint>;
export type ContextCompactionHistoryEntry = ContextHistoryEntry;
export type AutoCompactionGuard = MutableStateConstruction<AgentContextState['autoGuard']>;

export interface ContextCorrectnessFailure {
  readonly reason: ContextHardBlockReason;
  readonly sourceDigest: string;
  readonly message: string;
  readonly createdAtTurnId: string;
}

const CONTEXT_HARD_BLOCK_REASONS = new Set<ContextHardBlockReason>([
  'unsafe_context_projection',
  'corrupted_runtime_state',
  'corrupted_event_tail',
  'unrecoverable_checkpoint',
  'runtime_invariant_violation',
]);

/** Reject persisted reason values outside the frozen State 25 schema. */
export function normalizeContextCompactionReason(value: unknown): ContextCompactionReason | null {
  return value === 'manual' || value === 'auto' ? value : null;
}

export function isContextHardBlockReason(value: unknown): value is ContextHardBlockReason {
  return CONTEXT_HARD_BLOCK_REASONS.has(value as ContextHardBlockReason);
}

/** The only Kernel constructor for a durable State 25 context correctness block. */
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

/** Normalize restored development State 25 context facts without changing their schema. */
export function normalizeContextRuntimeState(
  context: ContextRuntimeState | undefined,
): ContextRuntimeState {
  const fallbackGuard: AutoCompactionGuard = {
    recentAutomaticCompactions: [],
    consecutiveLowGain: 0,
    disabledUntilManualAction: false,
    recoveryAttempted: false,
  };
  if (!context) return { history: [], autoGuard: fallbackGuard };

  const normalizeCheckpoint = (
    checkpoint: ContextCompactionCheckpoint | undefined,
  ): ContextCompactionCheckpoint | undefined => {
    if (!checkpoint) return undefined;
    const reason = normalizeContextCompactionReason(checkpoint.reason);
    const validEnvelope =
      checkpoint.version === 1 &&
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
    return reason &&
      validEnvelope &&
      typeof checkpoint.summary === 'string' &&
      checkpoint.summary.trim()
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
  const hardBlock = context.hardBlock;
  const normalizedActiveCheckpoint = normalizeCheckpoint(context.activeCheckpoint);
  const corruptedActiveCheckpoint = Boolean(
    context.activeCheckpoint && !normalizedActiveCheckpoint,
  );

  return {
    ...context,
    activeCheckpoint: normalizedActiveCheckpoint,
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
    hardBlock: corruptedActiveCheckpoint
      ? {
          reason: 'unrecoverable_checkpoint' as const,
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
    autoGuard: {
      ...fallbackGuard,
      ...(context.autoGuard ?? {}),
    },
  };
}
