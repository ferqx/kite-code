import { compactionMetrics } from '@/core/model/compaction-metrics';
import {
  structuredContextSummaryV1Schema,
  structuredContextSummaryV2Schema,
} from '@/core/model/compaction-schema';
import { ContextCompactionValidationError } from '@/core/model/compaction-summary';
import type { ContextProjectionEnvironment } from '@/core/model/context-projection';
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
  durationMs?: number,
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
}): Promise<RuntimeEvent[]> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
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
      elapsed(),
    );
  }

  try {
    const checkpoint = await input.compact({
      state: input.state,
      pending,
      sourceRevision,
      projectionEnvironment: input.projectionEnvironment,
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
        elapsed(),
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
        elapsed(),
      );
    }
    const summaryParseResult =
      checkpoint.summary.version === 2
        ? structuredContextSummaryV2Schema.safeParse(checkpoint.summary)
        : structuredContextSummaryV1Schema.safeParse(checkpoint.summary);
    if (
      checkpoint.version !== 1 ||
      !summaryParseResult.success ||
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
        elapsed(),
      );
    }
    const isManual = pending.reason === 'manual';
    const reductionFailed = isManual
      ? checkpoint.inputTokensAfter >= checkpoint.inputTokensBefore ||
        checkpoint.inputTokensBefore - checkpoint.inputTokensAfter < 1_024
      : checkpoint.inputTokensAfter >= checkpoint.inputTokensBefore ||
        checkpoint.inputTokensAfter > checkpoint.targetTokens;
    if (reductionFailed) {
      return failure(
        pending,
        sourceRevision,
        'insufficient_reduction',
        isManual
          ? 'Manual compaction did not save enough tokens (minimum 1024).'
          : 'The checkpoint did not reduce context below its target.',
        !isManual, // manual failures aren't retryable
        elapsed(),
      );
    }
    compactionMetrics.recordCompleted({
      compactionId: pending.compactionId,
      reason: pending.reason,
      durationMs: elapsed(),
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
        elapsed(),
      );
    }
    return failure(
      pending,
      sourceRevision,
      'summary_model_failed',
      error instanceof Error ? error.message : String(error),
      true,
      elapsed(),
    );
  }
}
