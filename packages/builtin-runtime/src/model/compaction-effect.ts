import { findSafeCompactionBoundary } from './compaction';
import type { CompactionReporter } from './compaction-metrics';
import {
  type ContextCompactionErrorKind,
  ContextCompactionValidationError,
  expectedCompactionSourceDigest,
  normalizeCompactionSummary,
} from './compaction-summary';
import type { ContextCompactionProgressPhase } from './context-compaction-presentation';
import {
  buildContextProjection,
  type ContextProjectionEnvironment,
  digestProjectionEnvironment,
} from './context-projection';
import { ProviderDataAdmissionError } from './provider-data-admission';
import type { BuiltinContextCheckpointViewV1, BuiltinRuntimeStateViewV1 } from './runtime-view';

export type BuiltinContextCompactorV1 = (input: {
  state: Readonly<BuiltinRuntimeStateViewV1>;
  pending: Readonly<NonNullable<BuiltinRuntimeStateViewV1['context']['pendingCompaction']>>;
  sourceRevision: number;
  projectionEnvironment?: ContextProjectionEnvironment;
}) => Promise<BuiltinContextCheckpointViewV1>;

export type BuiltinContextCompactionTerminalV1 =
  | {
      readonly type: 'context.compaction_completed';
      readonly compactionId: string;
      readonly sourceRevision: number;
      readonly checkpoint: BuiltinContextCheckpointViewV1;
      readonly durationMs: number;
    }
  | {
      readonly type: 'context.compaction_failed';
      readonly compactionId: string;
      readonly sourceRevision: number;
      readonly errorKind: ContextCompactionErrorKind;
      readonly message: string;
      readonly retryable: boolean;
      readonly requestedAtTurnId: string;
      readonly durationMs: number;
    };

function failure(input: {
  pending: Readonly<NonNullable<BuiltinRuntimeStateViewV1['context']['pendingCompaction']>>;
  sourceRevision: number;
  errorKind: ContextCompactionErrorKind;
  message: string;
  retryable: boolean;
  reporter?: CompactionReporter;
  durationMs: number;
}): BuiltinContextCompactionTerminalV1 {
  input.reporter?.recordFailed({
    compactionId: input.pending.compactionId,
    reason: input.pending.reason,
    durationMs: input.durationMs,
    errorKind: input.errorKind,
  });
  return {
    type: 'context.compaction_failed',
    compactionId: input.pending.compactionId,
    sourceRevision: input.sourceRevision,
    errorKind: input.errorKind,
    message: input.message,
    retryable: input.retryable,
    requestedAtTurnId: input.pending.requestedAtTurnId,
    durationMs: input.durationMs,
  };
}

/** Execute the Builtin context compaction effect without Runtime authority. */
export async function executeBuiltinContextCompactionV1(input: {
  state: Readonly<BuiltinRuntimeStateViewV1>;
  compactionId: string;
  compact?: BuiltinContextCompactorV1;
  projectionEnvironment?: ContextProjectionEnvironment;
  resolveProjectionEnvironment?: () => ContextProjectionEnvironment | undefined;
  onProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  reporter?: CompactionReporter;
  now?: () => number;
}): Promise<ReadonlyArray<BuiltinContextCompactionTerminalV1>> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, now() - startedAt);
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
    return [
      failure({
        pending,
        sourceRevision,
        errorKind: 'summary_model_failed',
        message: 'No context compactor is configured.',
        retryable: false,
        reporter: input.reporter,
        durationMs: elapsed(),
      }),
    ];
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
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'stale_context',
          message: 'The context projection changed while compaction was running.',
          retryable: true,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    if (
      checkpoint.compactionId !== pending.compactionId ||
      checkpoint.sourceRevision !== sourceRevision ||
      checkpoint.reason !== pending.reason
    ) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'invalid_candidate',
          message: 'The compaction checkpoint does not match its durable request.',
          retryable: false,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    const coveredMessage = input.state.transcript.messages.find(
      (message) => message.messageId === checkpoint.coveredThroughMessageId,
    );
    if (!coveredMessage || coveredMessage.turnId !== checkpoint.coveredThroughTurnId) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'unsafe_boundary',
          message: 'The checkpoint coverage boundary is not present in the source transcript.',
          retryable: false,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    const currentTurnHasMessages = input.state.transcript.messages.some(
      (message) => message.turnId === input.state.turn.turnId,
    );
    const boundary = findSafeCompactionBoundary(input.state, {
      protectLatestTurn:
        pending.reason === 'auto' ||
        (input.state.turn.status === 'active' && currentTurnHasMessages),
    });
    const base = input.state.context.activeCheckpoint;
    const baseIndex = base
      ? input.state.transcript.messages.findIndex(
          (message) => message.messageId === base.coveredThroughMessageId,
        )
      : -1;
    const sourceMessages = base
      ? boundary.coveredMessages.filter(
          (message) =>
            input.state.transcript.messages.findIndex(
              (candidate) => candidate.messageId === message.messageId,
            ) > baseIndex,
        )
      : boundary.coveredMessages;
    if (
      !boundary.eligible ||
      checkpoint.coveredThroughMessageId !== boundary.lastMessageId ||
      checkpoint.coveredThroughTurnId !== boundary.coveredThroughTurnId ||
      (base ? checkpoint.baseCheckpointId !== base.compactionId : checkpoint.baseCheckpointId) ||
      sourceMessages.length === 0 ||
      checkpoint.sourceDigest !== expectedCompactionSourceDigest(base?.sourceDigest, sourceMessages)
    ) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'invalid_candidate',
          message: 'The compaction checkpoint does not match the safe source boundary.',
          retryable: false,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    if (
      checkpoint.version !== 1 ||
      typeof checkpoint.summary !== 'string' ||
      checkpoint.summary.trim().length === 0 ||
      checkpoint.summary !== normalizeCompactionSummary(checkpoint.summary) ||
      !checkpoint.sourceDigest ||
      !Number.isFinite(checkpoint.inputTokensBefore) ||
      !Number.isFinite(checkpoint.inputTokensAfter) ||
      checkpoint.inputTokensBefore <= 0 ||
      checkpoint.inputTokensAfter < 0 ||
      !Number.isFinite(Date.parse(checkpoint.createdAt))
    ) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'invalid_candidate',
          message: 'The compaction checkpoint envelope is invalid.',
          retryable: false,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    const projectionInput = {
      role: 'agent' as const,
      state: input.state,
      serializedTools: leasedEnvironment?.serializedTools,
      activeSkillInstructions: leasedEnvironment?.activeSkillInstructions,
      workflowSkills: leasedEnvironment?.workflowSkills,
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
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'invalid_candidate',
          message: 'The compaction checkpoint token estimates do not match the source projection.',
          retryable: false,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    const reductionFailed = expectedBefore - expectedAfter < 1_024;
    if (reductionFailed) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'insufficient_reduction',
          message: 'Compaction did not save enough tokens (minimum 1024).',
          retryable: pending.reason === 'auto',
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
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
    if (error instanceof ProviderDataAdmissionError) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: 'provider_admission_denied',
          message: 'Provider data admission denied the compaction request.',
          retryable: false,
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    if (error instanceof ContextCompactionValidationError) {
      return [
        failure({
          pending,
          sourceRevision,
          errorKind: error.kind,
          message: error.message,
          retryable:
            error.kind === 'stale_context' ||
            (error.kind === 'insufficient_reduction' && pending.reason === 'auto'),
          reporter: input.reporter,
          durationMs: elapsed(),
        }),
      ];
    }
    return [
      failure({
        pending,
        sourceRevision,
        errorKind: 'summary_model_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        reporter: input.reporter,
        durationMs: elapsed(),
      }),
    ];
  } finally {
    input.onProgress?.(undefined);
  }
}
