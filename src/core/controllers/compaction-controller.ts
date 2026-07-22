import type { CompactionReporter } from '@/core/model/compaction-metrics';
import { ContextCompactionValidationError } from '@/core/model/compaction-summary';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import {
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from '@/core/model/context-projection';
import type {
  ContextCompactionCheckpoint,
  PendingContextCompaction,
} from '@/core/runtime/context-compaction';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';

export type ContextCompactor = (input: {
  state: Readonly<RuntimeState>;
  pending: Readonly<PendingContextCompaction>;
  sourceRevision: number;
  /** Serialized tool descriptors for candidate projection token estimation.
   *  Resolved fresh at effect time — never from the event or pending state. */
  projectionEnvironment?: ContextProjectionEnvironment;
}) => Promise<ContextCompactionCheckpoint>;

function failure(
  pending: PendingContextCompaction,
  sourceRevision: number,
  errorKind: Extract<RuntimeEvent, { type: 'context.compaction_failed' }>['errorKind'],
  message: string,
  retryable: boolean,
  reporter?: CompactionReporter,
  durationMs?: number,
): RuntimeEvent[] {
  reporter?.recordFailed({
    compactionId: pending.compactionId,
    reason: pending.reason,
    durationMs,
    errorKind,
  });
  return [
    {
      type: 'context.compaction_failed',
      compactionId: pending.compactionId,
      sourceRevision,
      errorKind,
      message,
      retryable,
      requestedAtTurnId: pending.requestedAtTurnId,
      ...(durationMs != null ? { durationMs } : {}),
    },
  ];
}

/** Execute the M2 checkpoint effect without mutating RuntimeState directly. */
export async function executeContextCompaction(input: {
  state: Readonly<RuntimeState>;
  compactionId: string;
  compact?: ContextCompactor;
  /** Serialized tool descriptors for candidate projection token estimation (PR 1). */
  projectionEnvironment?: ContextProjectionEnvironment;
  /** Resolve again after the model call so environment changes are stale, not failures. */
  resolveProjectionEnvironment?: () => ContextProjectionEnvironment;
  /** Ephemeral progress only. Never persist these phases as RuntimeEvents. */
  onProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  reporter?: CompactionReporter;
}): Promise<RuntimeEvent[]> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  const pending = input.state.context.pendingCompaction;
  if (!pending || pending.compactionId !== input.compactionId) return [];
  input.onProgress?.('preparing');
  const sourceRevision = input.state.revision;
  const leasedEnvironment = input.resolveProjectionEnvironment?.() ?? input.projectionEnvironment;
  const leasedEnvironmentDigest = leasedEnvironment
    ? digestProjectionEnvironment(leasedEnvironment)
    : undefined;
  if (!input.compact) {
    input.onProgress?.(undefined);
    return failure(
      pending,
      sourceRevision,
      'summary_model_failed',
      'No context compactor is configured.',
      false,
      input.reporter,
      elapsed(),
    );
  }

  try {
    input.onProgress?.('summarizing');
    const checkpoint = await input.compact({
      state: input.state,
      pending,
      sourceRevision,
      projectionEnvironment: leasedEnvironment,
    });
    input.onProgress?.('validating');
    const completedEnvironment = input.resolveProjectionEnvironment?.() ?? leasedEnvironment;
    const completedEnvironmentDigest = completedEnvironment
      ? digestProjectionEnvironment(completedEnvironment)
      : undefined;
    if (completedEnvironmentDigest !== leasedEnvironmentDigest) {
      // Environment freshness is part of the effect lease. A stale result must
      // not create a failure event, checkpoint, or correctness block.
      return [];
    }
    if (
      checkpoint.compactionId !== pending.compactionId ||
      checkpoint.sourceRevision !== sourceRevision
    ) {
      return [];
    }
    const coveredMessage = input.state.transcript.messages.find(
      (message) => message.messageId === checkpoint.coveredThroughMessageId,
    );
    if (!coveredMessage || coveredMessage.turnId !== checkpoint.coveredThroughTurnId) {
      return failure(
        pending,
        sourceRevision,
        'unsafe_boundary',
        'The checkpoint coverage boundary is not present in the source transcript.',
        false,
        input.reporter,
        elapsed(),
      );
    }
    if (
      checkpoint.version !== 1 ||
      typeof checkpoint.summary !== 'string' ||
      checkpoint.summary.trim().length === 0 ||
      !checkpoint.sourceDigest ||
      checkpoint.inputTokensAfter >= checkpoint.inputTokensBefore
    ) {
      return failure(
        pending,
        sourceRevision,
        'invalid_candidate',
        'The compaction checkpoint envelope is invalid.',
        false,
        input.reporter,
        elapsed(),
      );
    }
    const reductionFailed = checkpoint.inputTokensBefore - checkpoint.inputTokensAfter < 1_024;
    if (reductionFailed) {
      return failure(
        pending,
        sourceRevision,
        'insufficient_reduction',
        'Compaction did not save enough tokens (minimum 1024).',
        pending.reason === 'auto',
        input.reporter,
        elapsed(),
      );
    }
    input.reporter?.recordCompleted({
      compactionId: pending.compactionId,
      reason: pending.reason,
      durationMs: elapsed(),
      tokensBefore: checkpoint.inputTokensBefore,
      tokensAfter: checkpoint.inputTokensAfter,
      turnsSinceLastCheckpoint:
        input.state.context.lastCompactionTurnIndex != null
          ? input.state.turn.turnIndex - input.state.context.lastCompactionTurnIndex
          : undefined,
      completionTurnIndex: input.state.turn.turnIndex,
    });
    return [
      {
        type: 'context.compaction_completed',
        compactionId: pending.compactionId,
        sourceRevision,
        checkpoint,
        durationMs: elapsed(),
      },
    ];
  } catch (error) {
    if (error instanceof ContextCompactionValidationError) {
      return failure(
        pending,
        sourceRevision,
        error.kind,
        error.message,
        error.kind === 'insufficient_reduction',
        input.reporter,
        elapsed(),
      );
    }
    return failure(
      pending,
      sourceRevision,
      'summary_model_failed',
      error instanceof Error ? error.message : String(error),
      true,
      input.reporter,
      elapsed(),
    );
  } finally {
    input.onProgress?.(undefined);
  }
}
