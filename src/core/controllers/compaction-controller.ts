import { ProviderDataAdmissionError } from '@/core/config/provider-data-admission';
import type { CompactionReporter } from '@/core/model/compaction-metrics';
import {
  ContextCompactionValidationError,
  normalizeCompactionSummary,
  takeContextSummaryProviderUsageV1,
} from '@/core/model/compaction-summary';
import { findSafeCompactionBoundary } from '@/core/model/compaction-v2';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from '@/core/model/context-projection';
import { selectCheckpointWorkingSetV1 } from '@/core/model/context-working-set';
import type { ProviderDispatchEntryGuardV1 } from '@/core/model/progressive-context-orchestrator';
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
  dispatchEntryGuard?: ProviderDispatchEntryGuardV1;
}) => Promise<
  | ContextCompactionCheckpoint
  | {
      checkpoint: ContextCompactionCheckpoint;
      providerUsage: { inputTokens: number; outputTokens: number };
    }
>;

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
  dispatchEntryGuard?: ProviderDispatchEntryGuardV1;
}): Promise<RuntimeEvent[]> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  const pending = input.state.context.pendingCompaction;
  if (!pending || pending.compactionId !== input.compactionId) return [];
  if (
    pending.reason === 'auto' &&
    !(
      input.state.context.summaryLifecycle.kind === 'started' &&
      input.state.context.summaryLifecycle.attempt.reason === 'auto' &&
      input.state.context.summaryLifecycle.attempt.compactionId === pending.compactionId
    )
  )
    return [];
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
    const compacted = await input.compact({
      state: input.state,
      pending,
      sourceRevision,
      projectionEnvironment: leasedEnvironment,
      dispatchEntryGuard: input.dispatchEntryGuard,
    });
    const checkpoint = 'checkpoint' in compacted ? compacted.checkpoint : compacted;
    const providerUsage =
      'checkpoint' in compacted
        ? compacted.providerUsage
        : checkpoint.version === 3
          ? takeContextSummaryProviderUsageV1(checkpoint)
          : undefined;
    input.onProgress?.('validating');
    const completedEnvironment = input.resolveProjectionEnvironment?.() ?? leasedEnvironment;
    const completedEnvironmentDigest = completedEnvironment
      ? digestProjectionEnvironment(completedEnvironment)
      : undefined;
    if (completedEnvironmentDigest !== leasedEnvironmentDigest) {
      // Environment freshness is part of the effect lease. The generated
      // checkpoint must not be accepted, but the durable request still needs a
      // terminal fact so an idle manual command cannot remain pending forever.
      return failure(
        pending,
        sourceRevision,
        'stale_context',
        'The context projection changed while compaction was running.',
        true,
        input.reporter,
        elapsed(),
      );
    }
    if (
      checkpoint.version !== 3 ||
      checkpoint.compactionId !== pending.compactionId ||
      (checkpoint.version === 3 &&
        (checkpoint.source.sourceRevision !==
          (pending.sourceProducingEventCutV1?.revision ?? sourceRevision) ||
          (pending.sourceProducingEventCutV1 != null &&
            (checkpoint.source.sourceProducingEventCutV1.revision !==
              pending.sourceProducingEventCutV1.revision ||
              checkpoint.source.sourceProducingEventCutV1.eventId !==
                pending.sourceProducingEventCutV1.eventId)))) ||
      checkpoint.reason !== pending.reason
    ) {
      return failure(
        pending,
        sourceRevision,
        'invalid_candidate',
        'The compaction checkpoint does not match its durable request.',
        false,
        input.reporter,
        elapsed(),
      );
    }
    const coveredMessage = input.state.transcript.messages.find(
      (message) =>
        message.messageId ===
        (checkpoint.version === 3 ? checkpoint.source.coveredThroughMessageId : undefined),
    );
    if (
      checkpoint.version !== 3 ||
      !coveredMessage ||
      coveredMessage.turnId !== checkpoint.source.coveredThroughTurnId
    ) {
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
    const currentTurnHasMessages = input.state.transcript.messages.some(
      (message) => message.turnId === input.state.turn.turnId,
    );
    const boundary = findSafeCompactionBoundary(input.state, {
      protectLatestTurn: input.state.turn.status === 'active' && currentTurnHasMessages,
    });
    const base =
      input.state.context.activeCheckpoint?.version === 3
        ? input.state.context.activeCheckpoint
        : undefined;
    const workingSet = selectCheckpointWorkingSetV1({
      state: input.state,
      checkpoint,
      ...(leasedEnvironmentDigest ? { expectedRouteIdentityDigest: leasedEnvironmentDigest } : {}),
    });
    if (
      !boundary.eligible ||
      checkpoint.version !== 3 ||
      checkpoint.source.coveredThroughMessageId !== boundary.lastMessageId ||
      checkpoint.source.coveredThroughTurnId !== boundary.coveredThroughTurnId ||
      (base
        ? checkpoint.baseCheckpoint?.checkpointId !== base.checkpointId ||
          checkpoint.baseCheckpoint.summaryContentDigest !== base.summaryContentDigest
        : checkpoint.baseCheckpoint !== undefined) ||
      boundary.coveredMessages.length === 0 ||
      workingSet.status !== 'available'
    ) {
      return failure(
        pending,
        sourceRevision,
        'invalid_candidate',
        'The compaction checkpoint does not match the safe source boundary.',
        false,
        input.reporter,
        elapsed(),
      );
    }
    if (
      checkpoint.version !== 3 ||
      typeof checkpoint.summary !== 'string' ||
      checkpoint.summary.trim().length === 0 ||
      checkpoint.summary !== normalizeCompactionSummary(checkpoint.summary) ||
      !checkpoint.source.sourceRangeDigest ||
      !Number.isFinite(checkpoint.inputTokensBefore) ||
      !Number.isFinite(checkpoint.inputTokensAfter) ||
      checkpoint.inputTokensBefore <= 0 ||
      checkpoint.inputTokensAfter < 0 ||
      !Number.isFinite(Date.parse(checkpoint.createdAt))
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
    const projectionInput = {
      role: 'agent' as const,
      state: input.state,
      serializedTools: leasedEnvironment?.serializedTools,
      activeSkillInstructions: leasedEnvironment?.activeSkillInstructions,
      workflowSkills: leasedEnvironment?.workflowSkills,
      projectionEnvironment: leasedEnvironment,
    };
    const expectedBefore = buildContextProjection(projectionInput).estimate.totalInputTokens;
    const expectedAfter = buildContextProjection({
      ...projectionInput,
      candidateCheckpoint: checkpoint,
    }).estimate.totalInputTokens;
    if (
      checkpoint.inputTokensBefore !== expectedBefore ||
      checkpoint.inputTokensAfter !== expectedAfter
    ) {
      return failure(
        pending,
        sourceRevision,
        'invalid_candidate',
        'The compaction checkpoint token estimates do not match the source projection.',
        false,
        input.reporter,
        elapsed(),
      );
    }
    const reductionFailed = expectedBefore - expectedAfter < 1_024;
    if (reductionFailed) {
      return failure(
        pending,
        sourceRevision,
        'insufficient_reduction',
        'Compaction did not save enough tokens (minimum 1024).',
        false,
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
        ...(providerUsage ? { providerUsage } : {}),
      },
    ];
  } catch (error) {
    if (error instanceof ProviderDataAdmissionError) {
      return failure(
        pending,
        sourceRevision,
        'provider_admission_denied',
        'Provider data admission denied the compaction request.',
        false,
        input.reporter,
        elapsed(),
      );
    }
    if (error instanceof ContextCompactionValidationError) {
      return failure(
        pending,
        sourceRevision,
        error.kind,
        error.message,
        error.kind === 'stale_context',
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
