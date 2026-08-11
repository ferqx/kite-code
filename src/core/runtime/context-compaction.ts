import { createHash } from 'node:crypto';
import type { ContextTokenEstimate } from '@/core/model/context-budget';

function summaryContentDigestV3(summary: string): string {
  return createHash('sha256')
    .update('checkpoint-summary:v3\0')
    .update(JSON.stringify(summary))
    .digest('hex');
}

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

export interface SummarySourceIdentityV1 {
  version: 1;
  firstMessageId: string;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  canonicalSourceDigest: string;
  sourceProjectionPolicyId: string;
}

export interface NormalCompactionContinuationV1 {
  turnId: string;
  requestedAtRevision: number;
  summarySourceIdentity: SummarySourceIdentityV1;
}

export interface AutoSummaryCooldownV1 {
  version: 1;
  lastAttemptSourceIdentity: SummarySourceIdentityV1;
  successfulPrimaryOrdinalAtAttempt: number;
  nextEligibleSuccessfulPrimaryOrdinal: number;
}

export interface SummaryAttemptV1 {
  attemptId: string;
  compactionId: string;
  reason: ContextCompactionReason;
  trigger: 'manual_plain' | 'manual_custom' | 'auto_pressure';
  summarySourceIdentity: SummarySourceIdentityV1;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  sourceProducingEventCutV1: { revision: number; eventId: string };
  estimate: ContextTokenEstimate;
  customInstructions?: string;
}

export interface SummaryStartBatchKeyV1 {
  startBatchId: string;
  attemptId: string;
  compactionId: string;
  summarySourceIdentity: SummarySourceIdentityV1;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  sourceProducingEventCutV1: { revision: number; eventId: string };
  dispatchStart: {
    startBatchId: string;
    summaryEffectLeaseId: string;
    resourceReservationId: string;
    preparedSummaryRequestIdentity: string;
    requestId: string;
    expectedPayloadDigest: string;
    expectedMaxOutputTokens: number;
    expectedToolSetSchemaDigest: string;
  };
}

export interface SummaryStartedReceiptV1 {
  version: 1;
  requestedEventId: string;
  resourceReservedEventId: string;
  resourceDispatchStartedEventId: string;
  summaryDispatchStartedEventId: string;
}

export interface SummaryTerminalBatchKeyV1 {
  terminalBatchId: string;
  causationId: string;
  resourceDispatchCausationId?: string;
  attemptId: string;
  compactionId: string;
  summarySourceIdentity: SummarySourceIdentityV1;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  sourceProducingEventCutV1: { revision: number; eventId: string };
  dispatchStart?: SummaryStartBatchKeyV1['dispatchStart'];
  admission:
    | {
        stage: 'not_completed';
        proof: {
          kind: 'prepared_dispatch_not_entered_v1';
          guardNonce: string;
          producerGeneration: number;
          summaryStartBatchId: string;
        };
      }
    | { stage: 'denied'; proof: 'local_provider_admission_denied' }
    | {
        stage: 'admitted';
        evidence: {
          admittedRequestDigest: string;
          finalPayloadDigest: string;
          providerDataAdmissionReceiptDigest: string;
          finalMaxOutputTokens: number;
          finalToolSetSchemaDigest: string;
        };
      }
    | { stage: 'indeterminate_after_crash' };
}

export interface SummaryResolutionBatchKeyV1 {
  version: 1;
  resolutionBatchId: string;
  causationId: string;
  generation: number;
  attemptId: string;
  compactionId: string;
  originalTerminalBatchId: string;
  resourceReservationId: string;
  resourceUnknownEventId: string;
  continuation: NormalCompactionContinuationV1;
  actualUsageDigest: string;
}

export interface NormalReprepareReceiptV1 {
  version: 1;
  generation: number;
  attemptId: string;
  compactionId: string;
  continuation: NormalCompactionContinuationV1;
  origin:
    | {
        kind: 'summary_terminal';
        terminalBatchId: string;
        terminalEventId: string;
        resourceTerminalEventId: string;
      }
    | {
        kind: 'late_resolution';
        originalTerminalBatchId: string;
        resolutionBatchId: string;
        resourceUnknownEventId: string;
        resourceReconciledEventId: string;
      };
}

export interface NormalReprepareConsumptionKeyV1 {
  version: 1;
  generation: number;
  consumptionBatchId: string;
  attemptId: string;
  compactionId: string;
  continuation: NormalCompactionContinuationV1;
  originReceipt: NormalReprepareReceiptV1;
  primaryEffectLeaseId: string;
  primaryInvocationId: string;
  primaryRequestId: string;
  resourceReservationId: string;
}

export interface NormalReprepareConsumptionDetachReceiptV1 {
  version: 1;
  receiptId: string;
  sourceThreadId: string;
  targetThreadId: string;
  sourceGeneration: number;
  targetGeneration: number;
  selectedCutDigest: string;
  consumption: NormalReprepareConsumptionKeyV1;
  primaryState: 'in_flight' | 'settled_success' | 'settled_error_terminal';
  runErrorEventId?: string;
  resourceTerminalEventId?: string;
  turnAbortedEventId?: string;
  checksum: string;
}

export type SummaryLifecycleStateV1 =
  | { kind: 'idle'; lastConsumption?: NormalReprepareConsumptionKeyV1 }
  | {
      kind: 'requested';
      attempt: SummaryAttemptV1;
      continuation?: NormalCompactionContinuationV1;
      requestedEventId?: string;
    }
  | {
      kind: 'started';
      attempt: SummaryAttemptV1;
      startBatchKey: SummaryStartBatchKeyV1;
      startedReceipt?: SummaryStartedReceiptV1;
      continuation?: NormalCompactionContinuationV1;
    }
  | {
      kind: 'resource_resolution_required';
      attempt: SummaryAttemptV1;
      terminalBatchKey: SummaryTerminalBatchKeyV1;
      continuation: NormalCompactionContinuationV1;
      resourceReservationId: string;
      resourceUnknownEventId: string;
    }
  | { kind: 'normal_reprepare_required'; receipt: NormalReprepareReceiptV1 };

export interface VerifiedContextCheckpointV3 {
  version: 3;
  checkpointId: string;
  compactionId: string;
  reason: ContextCompactionReason;
  source: {
    firstMessageId: string;
    coveredThroughMessageId: string;
    coveredThroughTurnId: string;
    sourceRevision: number;
    sourceProducingEventCutV1: { revision: number; eventId: string };
    sourceRangeDigest: string;
    sourceProjectionPolicyId: string;
  };
  summary: string;
  summaryContentDigest: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  promptContractId: string;
  routeIdentityDigest: string;
  baseCheckpoint?: { checkpointId: string; summaryContentDigest: string };
  createdAt: string;
}

export type ContextCompactionCheckpoint =
  | ContextCompactionCheckpointV1
  | VerifiedContextCheckpointV3;

export interface PendingContextCompaction {
  compactionId: string;
  reason: ContextCompactionReason;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  /** Reserved compatibility field; all current requests use false. */
  force: boolean;
  sourceProducingEventCutV1?: { revision: number; eventId: string };
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
  summaryLifecycle: SummaryLifecycleStateV1;
  successfulPrimaryOrdinal: number;
  autoSummaryCooldown?: AutoSummaryCooldownV1;
  projectionBaseIdentity?: string;
  /** Last durable event that appended canonical transcript messages. */
  lastTranscriptProducingEventCutV1?: { revision: number; eventId: string };
  /** Historical audit only; never grants current continuation ownership. */
  lastDetach?: NormalReprepareConsumptionDetachReceiptV1;
}

/**
 * Converges restored development snapshots without retaining values outside
 * the current type schema. Capacity-era hard blocks are discarded.
 */
export function normalizeContextRuntimeState(
  context: ContextRuntimeState | undefined,
): ContextRuntimeState {
  if (!context)
    return { history: [], summaryLifecycle: { kind: 'idle' }, successfulPrimaryOrdinal: 0 };

  const normalizeCheckpoint = (
    checkpoint: ContextCompactionCheckpoint | undefined,
  ): ContextCompactionCheckpoint | undefined => {
    if (!checkpoint) return undefined;
    const reason = normalizeContextCompactionReason(checkpoint.reason);
    const validCommonEnvelope =
      Boolean(checkpoint.compactionId) &&
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
    if (checkpoint.version === 1) {
      return Number.isInteger(checkpoint.sourceRevision) &&
        checkpoint.sourceRevision >= 0 &&
        checkpoint.sourceDigest &&
        checkpoint.coveredThroughMessageId &&
        checkpoint.coveredThroughTurnId
        ? { ...checkpoint, summary: checkpoint.summary.trim(), reason }
        : undefined;
    }
    if (checkpoint.version !== 3) return undefined;
    const cut = checkpoint.source?.sourceProducingEventCutV1;
    return checkpoint.checkpointId &&
      checkpoint.source?.firstMessageId &&
      checkpoint.source?.coveredThroughMessageId &&
      checkpoint.source?.coveredThroughTurnId &&
      Number.isSafeInteger(checkpoint.source?.sourceRevision) &&
      checkpoint.source.sourceRevision >= 1 &&
      cut?.revision === checkpoint.source.sourceRevision &&
      /^[a-f0-9]{64}$/.test(cut.eventId) &&
      /^[a-f0-9]{64}$/.test(checkpoint.source.sourceRangeDigest) &&
      checkpoint.summaryContentDigest === summaryContentDigestV3(checkpoint.summary.trim()) &&
      /^[a-f0-9]{64}$/.test(checkpoint.routeIdentityDigest) &&
      checkpoint.promptContractId === 'summary-compact-markdown:v1'
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
    context.activeCheckpoint &&
      context.activeCheckpoint.version !== 3 &&
      !normalizedActiveCheckpoint,
  );
  const summaryLifecycle = context.summaryLifecycle ?? { kind: 'idle' as const };
  if (
    ![
      'idle',
      'requested',
      'started',
      'resource_resolution_required',
      'normal_reprepare_required',
    ].includes((summaryLifecycle as { kind?: string }).kind ?? '')
  ) {
    throw new Error('Persisted Summary lifecycle phase is not recognized by schema v24.');
  }

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
            context.activeCheckpoint &&
            context.activeCheckpoint.version !== 3 &&
            context.activeCheckpoint.sourceDigest
              ? context.activeCheckpoint.sourceDigest
              : context.activeCheckpoint?.version === 3 &&
                  context.activeCheckpoint.source.sourceRangeDigest
                ? context.activeCheckpoint.source.sourceRangeDigest
                : `checkpoint:${context.activeCheckpoint?.compactionId ?? 'unknown'}`,
          message: 'The persisted context checkpoint failed validation.',
          createdAtTurnId:
            (context.activeCheckpoint
              ? context.activeCheckpoint.version !== 3
                ? context.activeCheckpoint.coveredThroughTurnId
                : context.activeCheckpoint.source?.coveredThroughTurnId
              : undefined) || 'unknown',
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
    summaryLifecycle,
    successfulPrimaryOrdinal: Math.max(0, context.successfulPrimaryOrdinal ?? 0),
    projectionBaseIdentity:
      normalizedActiveCheckpoint?.version === 3 &&
      context.projectionBaseIdentity ===
        `checkpoint:${normalizedActiveCheckpoint.checkpointId}:${normalizedActiveCheckpoint.source.sourceRangeDigest}`
        ? context.projectionBaseIdentity
        : undefined,
    lastTranscriptProducingEventCutV1:
      Number.isSafeInteger(context.lastTranscriptProducingEventCutV1?.revision) &&
      (context.lastTranscriptProducingEventCutV1?.revision ?? 0) >= 1 &&
      /^[a-f0-9]{64}$/.test(context.lastTranscriptProducingEventCutV1?.eventId ?? '')
        ? context.lastTranscriptProducingEventCutV1
        : undefined,
  };
}
