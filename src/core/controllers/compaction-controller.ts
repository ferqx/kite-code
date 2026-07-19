import { compactionMetrics } from '@/core/model/compaction-metrics';
import { structuredContextSummaryV1Schema } from '@/core/model/compaction-schema';
import { ContextCompactionValidationError } from '@/core/model/compaction-summary';
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
}) => Promise<ContextCompactionCheckpoint>;

function failure(
  pending: PendingContextCompaction,
  sourceRevision: number,
  errorKind: Extract<RuntimeEvent, { type: 'context.compaction_failed' }>['errorKind'],
  message: string,
  retryable: boolean,
): RuntimeEvent[] {
  compactionMetrics.recordFailed();
  return [
    {
      type: 'context.compaction_failed',
      compactionId: pending.compactionId,
      sourceRevision,
      errorKind,
      message,
      retryable,
    },
  ];
}

/** Execute the M2 checkpoint effect without mutating RuntimeState directly. */
export async function executeContextCompaction(input: {
  state: Readonly<RuntimeState>;
  compactionId: string;
  compact?: ContextCompactor;
}): Promise<RuntimeEvent[]> {
  const pending = input.state.context.pendingCompaction;
  if (!pending || pending.compactionId !== input.compactionId) return [];
  const sourceRevision = input.state.revision;
  if (!input.compact) {
    return failure(
      pending,
      sourceRevision,
      'summary_model_failed',
      'No structured context compactor is configured.',
      false,
    );
  }

  try {
    const checkpoint = await input.compact({
      state: input.state,
      pending,
      sourceRevision,
    });
    if (
      checkpoint.compactionId !== pending.compactionId ||
      checkpoint.sourceRevision !== sourceRevision
    ) {
      return failure(
        pending,
        sourceRevision,
        'stale_source',
        'The compaction result does not match the leased Runtime revision.',
        true,
      );
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
      );
    }
    if (
      checkpoint.version !== 1 ||
      !structuredContextSummaryV1Schema.safeParse(checkpoint.summary).success ||
      !checkpoint.sourceDigest ||
      checkpoint.summary.provenance.sourceDigest !== checkpoint.sourceDigest ||
      checkpoint.summary.provenance.lastMessageId !== checkpoint.coveredThroughMessageId
    ) {
      return failure(
        pending,
        sourceRevision,
        'invalid_schema',
        'The compaction checkpoint envelope is invalid.',
        false,
      );
    }
    if (
      checkpoint.inputTokensAfter >= checkpoint.inputTokensBefore ||
      checkpoint.inputTokensAfter > checkpoint.targetTokens
    ) {
      return failure(
        pending,
        sourceRevision,
        'insufficient_reduction',
        'The checkpoint did not reduce context below its target.',
        true,
      );
    }
    compactionMetrics.recordCompleted({
      compactionId: pending.compactionId,
      reason: pending.reason,
      durationMs: 0, // caller should update with actual timing
      tokensBefore: checkpoint.inputTokensBefore,
      tokensAfter: checkpoint.inputTokensAfter,
      turnsSinceLastCheckpoint:
        input.state.context.lastCompactionTurnIndex != null
          ? input.state.turn.turnIndex - input.state.context.lastCompactionTurnIndex
          : undefined,
    });
    return [
      {
        type: 'context.compaction_completed',
        compactionId: pending.compactionId,
        sourceRevision,
        checkpoint,
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
      );
    }
    return failure(
      pending,
      sourceRevision,
      'summary_model_failed',
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}
