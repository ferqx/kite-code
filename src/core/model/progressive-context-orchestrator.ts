import { createHash } from 'node:crypto';
import type {
  NormalCompactionContinuationV1,
  SummaryAttemptV1,
  SummarySourceIdentityV1,
  SummaryStartBatchKeyV1,
} from '@/core/runtime/context-compaction';
import type { ContextSummaryRequestedEventV1, RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import { findSafeCompactionBoundary } from './compaction-v2';
import type { ContextPressure, ContextTokenEstimate } from './context-budget';
import { buildCanonicalTranscriptBlocksV1, summarySourceIdentityV1 } from './context-checkpoint-v3';
import { selectCheckpointWorkingSetV1 } from './context-working-set';

export const SUMMARY_AUTO_TRIGGER_RATIO_V1 = 0.9;
export const SUMMARY_AUTO_COOLDOWN_SUCCESSFUL_PRIMARY_TURNS_V1 = 3;

export type ProgressiveContextDecisionV1 =
  | { kind: 'dispatch_raw'; reason: string }
  | { kind: 'dispatch_micro'; reason: string }
  | { kind: 'dispatch_working_set'; reason: string }
  | { kind: 'request_summary'; event: ContextSummaryRequestedEventV1 }
  | { kind: 'blocked'; reason: 'resource_resolution_required' | 'summary_in_flight' };

function sameSource(left: SummarySourceIdentityV1, right: SummarySourceIdentityV1): boolean {
  return (
    left.firstMessageId === right.firstMessageId &&
    left.coveredThroughMessageId === right.coveredThroughMessageId &&
    left.coveredThroughTurnId === right.coveredThroughTurnId &&
    left.canonicalSourceDigest === right.canonicalSourceDigest &&
    left.sourceProjectionPolicyId === right.sourceProjectionPolicyId
  );
}

export function buildSummarySourceIdentityForCurrentPrefixV1(
  state: Readonly<RuntimeState>,
): SummarySourceIdentityV1 | undefined {
  const boundary = findSafeCompactionBoundary(state, {
    protectLatestTurn:
      state.turn.status === 'active' &&
      state.transcript.messages.some((message) => message.turnId === state.turn.turnId),
  });
  if (!boundary.eligible || !boundary.lastMessageId) return undefined;
  const built = buildCanonicalTranscriptBlocksV1(state);
  if (built.status === 'unavailable') return undefined;
  const index = built.blocks.findIndex((block) => block.lastMessageId === boundary.lastMessageId);
  return index < 0 ? undefined : summarySourceIdentityV1(built.blocks.slice(0, index + 1));
}

export function createSummaryRequestedEventV1(input: {
  state: Readonly<RuntimeState>;
  reason: 'manual' | 'auto';
  customInstructions?: string;
  sourceIdentity: SummarySourceIdentityV1;
  attemptId?: string;
  compactionId?: string;
  estimate?: ContextTokenEstimate;
}): ContextSummaryRequestedEventV1 {
  const attemptId = input.attemptId ?? crypto.randomUUID();
  const compactionId = input.compactionId ?? crypto.randomUUID();
  const sourceProducingEventCutV1 =
    input.state.context.lastTranscriptProducingEventCutV1 ??
    (input.state.lastAppliedEventId
      ? { revision: input.state.revision, eventId: input.state.lastAppliedEventId }
      : undefined);
  if (!sourceProducingEventCutV1) {
    throw new Error('Summary source has no durable transcript-producing event cut.');
  }
  const attempt: SummaryAttemptV1 = {
    attemptId,
    compactionId,
    reason: input.reason,
    trigger:
      input.reason === 'auto'
        ? 'auto_pressure'
        : input.customInstructions
          ? 'manual_custom'
          : 'manual_plain',
    summarySourceIdentity: input.sourceIdentity,
    requestedAtRevision: input.state.revision,
    requestedAtTurnId: input.state.turn.turnId,
    sourceProducingEventCutV1,
    estimate: input.estimate ?? {
      systemTokens: 0,
      toolSchemaTokens: 0,
      transcriptTokens: 0,
      summaryTokens: 0,
      dynamicRuntimeTokens: 0,
      framingTokens: 0,
      totalInputTokens: 0,
    },
    ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
  };
  const continuation: NormalCompactionContinuationV1 | undefined =
    input.reason === 'auto'
      ? {
          turnId: input.state.turn.turnId,
          requestedAtRevision: input.state.revision,
          summarySourceIdentity: input.sourceIdentity,
        }
      : undefined;
  return {
    type: 'context.summary_requested_v1',
    attempt,
    ...(continuation ? { continuation } : {}),
  };
}

/** Close a persisted manual request that was denied before any reservation. */
export function createManualSummaryPreReservationDeniedEventV1(input: {
  state: Readonly<RuntimeState>;
  message: string;
}): Extract<RuntimeEvent, { type: 'context.summary_failed_v1' }> {
  const lifecycle = input.state.context.summaryLifecycle;
  if (
    lifecycle.kind !== 'requested' ||
    lifecycle.attempt.reason !== 'manual' ||
    !lifecycle.requestedEventId
  ) {
    throw new Error('Manual pre-reservation denial requires one durable requested receipt.');
  }
  const attempt = lifecycle.attempt;
  return {
    type: 'context.summary_failed_v1',
    attemptId: attempt.attemptId,
    terminalBatchKey: {
      terminalBatchId: crypto.randomUUID(),
      causationId: lifecycle.requestedEventId,
      attemptId: attempt.attemptId,
      compactionId: attempt.compactionId,
      summarySourceIdentity: attempt.summarySourceIdentity,
      requestedAtRevision: attempt.requestedAtRevision,
      requestedAtTurnId: attempt.requestedAtTurnId,
      sourceProducingEventCutV1: attempt.sourceProducingEventCutV1,
      admission: { stage: 'denied', proof: 'local_provider_admission_denied' },
    },
    errorKind: 'summary_aborted',
    message: input.message,
    providerDispatchState: 'not_entered',
  };
}

/**
 * Sole pure tier selector. Admission/resource/Provider dispatch stay outside;
 * this function never writes, reserves, retries, or calls a Provider.
 */
export function prepareProgressiveContextDecisionV1(input: {
  state: Readonly<RuntimeState>;
  pressure: ContextPressure;
  utilization?: number;
  contextWindowTokens?: number;
  expectedRouteIdentityDigest?: string;
  /** L2.5 must be evaluated with the same effective projection policy as L2. */
  oversizedBlockOffloadV1?: boolean;
  /** Provider tools available for an L2.5 repeat-read stub. */
  availableToolNames?: readonly string[];
  autoSummaryEnabled: boolean;
  /** Configured successful normal-primary turns required after an auto summary. */
  autoCooldownSuccessfulPrimaryTurns?: number;
  microAvailable: boolean;
  microPressure?: ContextPressure;
  workingSetPressure?: ContextPressure;
  estimate?: ContextTokenEstimate;
  manual?: { customInstructions?: string; attemptId?: string; compactionId?: string };
}): ProgressiveContextDecisionV1 {
  const lifecycle = input.state.context.summaryLifecycle;
  if (lifecycle.kind === 'resource_resolution_required') {
    return { kind: 'blocked', reason: 'resource_resolution_required' };
  }
  if (lifecycle.kind === 'requested' || lifecycle.kind === 'started') {
    return { kind: 'blocked', reason: 'summary_in_flight' };
  }
  if (
    !input.manual &&
    input.microAvailable &&
    (input.microPressure === 'normal' || input.microPressure === 'unknown')
  ) {
    return { kind: 'dispatch_micro', reason: 'eligible_micro_candidate' };
  }
  const workingSet = selectCheckpointWorkingSetV1({
    state: input.state,
    checkpoint: input.state.context.activeCheckpoint,
    contextWindowTokens: input.contextWindowTokens,
    expectedRouteIdentityDigest: input.expectedRouteIdentityDigest,
    ...(input.oversizedBlockOffloadV1 === true
      ? {
          oversizedBlockOffloadV1: true,
          availableToolNames: input.availableToolNames,
        }
      : {}),
  });
  if (
    !input.manual &&
    workingSet.status === 'available' &&
    (input.workingSetPressure === 'normal' || input.workingSetPressure === 'unknown')
  ) {
    return { kind: 'dispatch_working_set', reason: 'verified_checkpoint_working_set' };
  }
  const bestLocalProjection = (): ProgressiveContextDecisionV1 =>
    workingSet.status === 'available'
      ? { kind: 'dispatch_working_set', reason: 'verified_checkpoint_working_set' }
      : input.microAvailable
        ? { kind: 'dispatch_micro', reason: 'eligible_micro_candidate' }
        : { kind: 'dispatch_raw', reason: 'auto_summary_policy_not_met' };
  const sourceIdentity = buildSummarySourceIdentityForCurrentPrefixV1(input.state);
  if (!sourceIdentity) {
    const best = bestLocalProjection();
    return best.kind === 'dispatch_raw'
      ? { kind: 'dispatch_raw', reason: 'summary_source_unavailable' }
      : best;
  }
  const active = input.state.context.activeCheckpoint;
  if (
    active?.version === 3 &&
    active.source.firstMessageId === sourceIdentity.firstMessageId &&
    active.source.coveredThroughMessageId === sourceIdentity.coveredThroughMessageId &&
    active.source.sourceRangeDigest === sourceIdentity.canonicalSourceDigest
  ) {
    const best = bestLocalProjection();
    return best.kind === 'dispatch_raw'
      ? { kind: 'dispatch_raw', reason: 'no_new_summary_source' }
      : best;
  }
  if (input.manual) {
    return {
      kind: 'request_summary',
      event: createSummaryRequestedEventV1({
        state: input.state,
        reason: 'manual',
        sourceIdentity,
        ...input.manual,
      }),
    };
  }
  if (
    !input.autoSummaryEnabled ||
    input.contextWindowTokens == null ||
    input.utilization == null ||
    input.utilization < SUMMARY_AUTO_TRIGGER_RATIO_V1 ||
    (input.pressure !== 'warning' &&
      input.pressure !== 'compact_due' &&
      input.pressure !== 'hard_limit')
  )
    return bestLocalProjection();
  const cooldown = input.state.context.autoSummaryCooldown;
  const cooldownTurns =
    input.autoCooldownSuccessfulPrimaryTurns ?? SUMMARY_AUTO_COOLDOWN_SUCCESSFUL_PRIMARY_TURNS_V1;
  if (!Number.isSafeInteger(cooldownTurns) || cooldownTurns < 0) {
    throw new Error('autoCooldownSuccessfulPrimaryTurns must be a non-negative safe integer.');
  }
  if (
    cooldown &&
    (sameSource(cooldown.lastAttemptSourceIdentity, sourceIdentity) ||
      input.state.context.successfulPrimaryOrdinal <
        cooldown.successfulPrimaryOrdinalAtAttempt + cooldownTurns)
  ) {
    const best = bestLocalProjection();
    return best.kind === 'dispatch_raw'
      ? { kind: 'dispatch_raw', reason: 'auto_summary_dedup_or_cooldown' }
      : best;
  }
  return {
    kind: 'request_summary',
    event: createSummaryRequestedEventV1({
      state: input.state,
      reason: 'auto',
      sourceIdentity,
      estimate: input.estimate,
    }),
  };
}

export type ProviderDispatchEntryGuardStateV1 = 'open' | 'entered' | 'closed_without_entry';

/** Synchronous single-use guard; callers must not await between resolution and use. */
export class ProviderDispatchEntryGuardV1 {
  readonly nonce = crypto.randomUUID();
  private state: ProviderDispatchEntryGuardStateV1 = 'open';

  tryEnter(): boolean {
    if (this.state !== 'open') return false;
    this.state = 'entered';
    return true;
  }

  closeWithoutEntry(): { proof: 'prepared_dispatch_not_entered_v1'; guardNonce: string } | null {
    if (this.state !== 'open') return null;
    this.state = 'closed_without_entry';
    return { proof: 'prepared_dispatch_not_entered_v1', guardNonce: this.nonce };
  }

  currentState(): ProviderDispatchEntryGuardStateV1 {
    return this.state;
  }
}

function summaryBindingDigest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0`).update(JSON.stringify(value)).digest('hex');
}

/** Builds the immutable pre-Provider binding after resource reservation but before callback entry. */
export function createSummaryStartBatchKeyV1(input: {
  state: Readonly<RuntimeState>;
  effectLeaseId: string;
  resourceReservationId: string;
  expectedMaxOutputTokens: number;
  attemptOverride?: SummaryAttemptV1;
}): SummaryStartBatchKeyV1 {
  const lifecycle = input.state.context.summaryLifecycle;
  if (lifecycle.kind !== 'requested' && !input.attemptOverride) {
    throw new Error('Summary start requires one requested lifecycle.');
  }
  const attempt = lifecycle.kind === 'requested' ? lifecycle.attempt : input.attemptOverride!;
  const requestId = crypto.randomUUID();
  const startBatchId = crypto.randomUUID();
  const requestShape = {
    requestId,
    attemptId: attempt.attemptId,
    compactionId: attempt.compactionId,
    source: attempt.summarySourceIdentity,
    customInstructions: attempt.customInstructions ?? null,
    maxOutputTokens: input.expectedMaxOutputTokens,
    tools: [],
  };
  return {
    startBatchId,
    attemptId: attempt.attemptId,
    compactionId: attempt.compactionId,
    summarySourceIdentity: attempt.summarySourceIdentity,
    requestedAtRevision: attempt.requestedAtRevision,
    requestedAtTurnId: attempt.requestedAtTurnId,
    sourceProducingEventCutV1: attempt.sourceProducingEventCutV1,
    dispatchStart: {
      startBatchId,
      summaryEffectLeaseId: input.effectLeaseId,
      resourceReservationId: input.resourceReservationId,
      preparedSummaryRequestIdentity: summaryBindingDigest(
        'prepared-summary-request:v1',
        requestShape,
      ),
      requestId,
      expectedPayloadDigest: summaryBindingDigest('summary-provider-payload:v1', requestShape),
      expectedMaxOutputTokens: input.expectedMaxOutputTokens,
      expectedToolSetSchemaDigest: summaryBindingDigest('summary-tool-set:v1', []),
    },
  };
}
