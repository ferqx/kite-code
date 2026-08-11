import { randomBytes } from 'node:crypto';
import { canonicalContextDigestV3 } from '@/core/model/context-checkpoint-v3';
import { deriveCheckpointV3ReboundV1 } from '@/core/model/context-working-set';
import {
  type BranchCopiedTerminalClosureV1,
  type BranchMutationCompletionV1,
  type BranchMutationReceiptV1,
  finalizeBranchCopiedTerminalClosureV1,
  finalizeBranchMutationCompletionV1,
  finalizeBranchMutationReceiptV1,
  manifestDigestV1,
  sameConsumptionKeyV1,
} from './branch-receipt-v1';
import type {
  NormalReprepareConsumptionDetachReceiptV1,
  NormalReprepareConsumptionKeyV1,
} from './context-compaction';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import { assertRuntimeStateInvariants } from './invariants';
import { reduceRuntimeState } from './reducer';
import {
  buildRuntimeEventEnvelopeV24,
  canonicalRuntimeEventEnvelopeBytesV24,
  type RuntimeEventEnvelopeV24,
} from './runtime-event-v24';
import { advanceRuntimeStorageFormatV24 } from './runtime-storage-v24';
import type { RuntimeState } from './state';
import type { BranchMutationCommitResultV1, RuntimeEventMetadata, RuntimeStore } from './store';
import { failedTerminalOutcomeV1 } from './terminal-outcome';

export interface DerivedBranchLifecycleMutationV1 {
  state: RuntimeState;
  events: RuntimeEvent[];
  metadata: RuntimeEventMetadata[];
  requestDigest: string;
  candidateDigest: string;
  receipt?: BranchMutationReceiptV1;
  terminalClosure?: BranchCopiedTerminalClosureV1;
  completion: BranchMutationCompletionV1;
}

export interface BranchMutationOpaqueCandidateV1 {
  version: 1;
  nonceHex: string;
  occurredAt: string;
  /** Kernel-owned pure producer; Store invokes it only before entering its write lock. */
  derive: (input: BranchMutationDerivationInputV1) => DerivedBranchLifecycleMutationV1;
}

/** Kernel-owned entropy/timestamp reused unchanged for the one legal contention retry. */
export function createBranchMutationOpaqueCandidateV1(): BranchMutationOpaqueCandidateV1 {
  return {
    version: 1,
    nonceHex: randomBytes(16).toString('hex'),
    occurredAt: new Date().toISOString(),
    derive: deriveBranchLifecycleMutationV1,
  };
}

export function assertBranchMutationOpaqueCandidateV1(
  candidate: BranchMutationOpaqueCandidateV1,
): void {
  if (
    candidate.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(candidate.nonceHex) ||
    !Number.isFinite(Date.parse(candidate.occurredAt)) ||
    typeof candidate.derive !== 'function'
  ) {
    throw new Error('Branch mutation opaque candidate is invalid.');
  }
}

function resolveBranchMutationResultV1(
  store: Pick<RuntimeStore, 'resolveBranchMutationCompletionV1'>,
  result: BranchMutationCommitResultV1,
): BranchMutationCommitResultV1 {
  if (result.status !== 'commit_ack_unknown') return result;
  const resolution = store.resolveBranchMutationCompletionV1(result);
  if (resolution.status === 'already_committed') {
    return {
      status: 'committed',
      receiptId: result.receiptId,
      targetGeneration: result.targetGeneration,
    };
  }
  if (resolution.status === 'definitely_not_committed') return { status: 'identity_stale' };
  if (resolution.status === 'resolution_unavailable') {
    return result;
  }
  return { status: 'digest_invalid' };
}

/** Sole Core orchestration for fork retry and post-COMMIT ACK resolution. */
export function executeForkBranchMutationV1(
  store: Pick<RuntimeStore, 'forkSessionV1' | 'resolveBranchMutationCompletionV1'>,
  sourceThreadId: string,
  snapshotId: string,
  targetThreadId: string,
): BranchMutationCommitResultV1 {
  const candidate = createBranchMutationOpaqueCandidateV1();
  let result = store.forkSessionV1(sourceThreadId, snapshotId, targetThreadId, candidate);
  if (result.status === 'contention_timeout') {
    result = store.forkSessionV1(sourceThreadId, snapshotId, targetThreadId, candidate);
  }
  return resolveBranchMutationResultV1(store, result);
}

/** Sole Core orchestration for rewind retry and post-COMMIT ACK resolution. */
export function executeRewindBranchMutationV1(
  store: Pick<RuntimeStore, 'restoreNamedSnapshotV1' | 'resolveBranchMutationCompletionV1'>,
  threadId: string,
  snapshotId: string,
): BranchMutationCommitResultV1 {
  const candidate = createBranchMutationOpaqueCandidateV1();
  let result = store.restoreNamedSnapshotV1(threadId, snapshotId, candidate);
  if (result.status === 'contention_timeout') {
    result = store.restoreNamedSnapshotV1(threadId, snapshotId, candidate);
  }
  return resolveBranchMutationResultV1(store, result);
}

function detachChecksum(
  receipt: Omit<NormalReprepareConsumptionDetachReceiptV1, 'checksum'>,
): string {
  return canonicalContextDigestV3('normal-reprepare-consumption-detach:v1', receipt);
}

/**
 * Pure Kernel-side producer for branch lifecycle closure. Store callers may
 * persist only the returned opaque state/events/metadata under their own CAS.
 */
export interface BranchMutationDerivationInputV1 {
  state: Readonly<RuntimeState>;
  reason: 'fork' | 'rewind';
  receiptId: string;
  sourceThreadId: string;
  targetThreadId: string;
  sourceGeneration: number;
  targetGeneration: number;
  selectedCutDigest: string;
  requestDigest: string;
  selectedSourceEnvelopes?: readonly RuntimeEventEnvelopeV24[];
  occurredAt: string;
}

export function deriveBranchLifecycleMutationV1(
  input: BranchMutationDerivationInputV1,
): DerivedBranchLifecycleMutationV1 {
  let state = structuredClone(input.state) as RuntimeState;
  if (state.context.lastDetach) {
    state = {
      ...state,
      context: { ...state.context, lastDetach: undefined },
    };
  }
  const events: RuntimeEvent[] = [];
  const metadata: RuntimeEventMetadata[] = [];
  const targetLedgerBaseId = state.storageFormat.ledgerBase.baseId;
  let terminalClosure: BranchCopiedTerminalClosureV1 | undefined;
  const append = (event: RuntimeEvent): string => {
    const envelope = buildRuntimeEventEnvelopeV24({
      threadId: input.targetThreadId,
      generation: input.targetGeneration,
      revision: state.revision + 1,
      occurredAt: input.occurredAt,
      payload: event,
    });
    const reduced = reduceRuntimeState(state, event);
    state = {
      ...reduced,
      revision: envelope.revision,
      lastAppliedEventId: envelope.eventId,
      appliedEventIds: [...reduced.appliedEventIds, envelope.eventId].slice(-4096),
      storageFormat: advanceRuntimeStorageFormatV24({
        current: reduced.storageFormat,
        eventId: envelope.eventId,
        canonicalBytes: Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8'),
      }),
    };
    events.push(event);
    metadata.push({
      eventId: envelope.eventId,
      revision: envelope.revision,
      causationId: envelope.causationId,
      occurredAt: envelope.occurredAt,
      schemaVersion: 24,
      generation: input.targetGeneration,
      canonicalBytes: Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8'),
    });
    return envelope.eventId;
  };

  const checkpointRebound = deriveCheckpointV3ReboundV1({
    state,
    generation: input.targetGeneration,
  });
  if (checkpointRebound) append(checkpointRebound);

  const lifecycle = state.context.summaryLifecycle;
  if (lifecycle.kind === 'requested') {
    append({
      type: 'context.summary_branch_abandoned_v1',
      attemptId: lifecycle.attempt.attemptId,
      reason: input.reason,
      phase: 'requested',
    });
  } else if (lifecycle.kind === 'started') {
    const reservationId = lifecycle.startBatchKey.dispatchStart.resourceReservationId;
    const reservation =
      state.resourceBudget.status === 'active'
        ? state.resourceBudget.reservations[reservationId]
        : undefined;
    if (reservation?.state === 'dispatch_started') {
      append({ type: 'resource_budget.unknown', reservationId });
    }
    append({
      type: 'context.summary_branch_abandoned_v1',
      attemptId: lifecycle.attempt.attemptId,
      reason: input.reason,
      phase: 'started',
    });
  } else if (lifecycle.kind === 'resource_resolution_required') {
    append({
      type: 'context.summary_branch_abandoned_v1',
      attemptId: lifecycle.attempt.attemptId,
      reason: input.reason,
      phase: 'resource_resolution',
    });
  } else if (lifecycle.kind === 'normal_reprepare_required') {
    append({
      type: 'context.normal_continuation_superseded_v1',
      attemptId: lifecycle.receipt.attemptId,
      reason: input.reason,
    });
  } else if (lifecycle.lastConsumption) {
    const consumption: NormalReprepareConsumptionKeyV1 = lifecycle.lastConsumption;
    const reservation =
      state.resourceBudget.status === 'active'
        ? state.resourceBudget.reservations[consumption.resourceReservationId]
        : undefined;
    const sourceEnvelopes = [...(input.selectedSourceEnvelopes ?? [])].sort(
      (left, right) => left.revision - right.revision,
    );
    const consumed = sourceEnvelopes.find(
      (entry) =>
        entry.payload.type === 'context.normal_reprepare_consumed_v1' &&
        sameConsumptionKeyV1(entry.payload.consumptionKey, consumption),
    );
    const reserved = sourceEnvelopes.find(
      (entry) =>
        entry.payload.type === 'resource_budget.reserved' &&
        entry.payload.reservation.reservationId === consumption.resourceReservationId &&
        sameConsumptionKeyV1(entry.payload.normalReprepareConsumptionKey, consumption),
    );
    const dispatched = sourceEnvelopes.find(
      (entry) =>
        entry.payload.type === 'resource_budget.dispatch_started' &&
        entry.payload.reservationId === consumption.resourceReservationId &&
        sameConsumptionKeyV1(entry.payload.normalReprepareConsumptionKey, consumption),
    );
    if (!consumed || !reserved || !dispatched) {
      throw new Error('Branch continuation ownership lacks its canonical consumed/start evidence.');
    }
    const primarySuccess = sourceEnvelopes.find(
      (entry) =>
        entry.revision > dispatched.revision &&
        entry.payload.type === 'model.responded' &&
        entry.payload.contextEvidence?.reservationId === consumption.resourceReservationId &&
        entry.payload.contextEvidence.requestId === consumption.primaryRequestId,
    );
    const primarySuccessBatchId =
      primarySuccess?.payload.type === 'model.responded'
        ? primarySuccess.payload.contextEvidence?.terminalBatchId
        : undefined;
    const resourceSuccess =
      primarySuccess && primarySuccessBatchId
        ? sourceEnvelopes.find(
            (entry) =>
              entry.revision > primarySuccess.revision &&
              entry.payload.type === 'resource_budget.reconciled' &&
              entry.payload.reservationId === consumption.resourceReservationId &&
              entry.payload.terminalBatchId === primarySuccessBatchId,
          )
        : undefined;
    const runError = sourceEnvelopes.find(
      (entry) =>
        entry.revision > dispatched.revision &&
        entry.payload.type === 'run.error' &&
        entry.payload.turnId === consumption.continuation.turnId,
    );
    const resourceError = runError
      ? sourceEnvelopes.find(
          (entry) =>
            entry.revision > runError.revision &&
            (entry.payload.type === 'resource_budget.released' ||
              entry.payload.type === 'resource_budget.unknown') &&
            entry.payload.reservationId === consumption.resourceReservationId,
        )
      : undefined;
    const turnAborted = resourceError
      ? sourceEnvelopes.find(
          (entry) =>
            entry.revision > resourceError.revision &&
            entry.payload.type === 'turn.aborted' &&
            entry.payload.turnId === consumption.continuation.turnId &&
            entry.payload.cause === 'error',
        )
      : undefined;
    const settledSuccess = Boolean(primarySuccess && resourceSuccess);
    const settledError = Boolean(runError && resourceError && turnAborted);
    if (settledSuccess && settledError) {
      throw new Error('Branch continuation has conflicting success and error terminal evidence.');
    }
    const primaryState: NormalReprepareConsumptionDetachReceiptV1['primaryState'] = settledSuccess
      ? 'settled_success'
      : settledError
        ? 'settled_error_terminal'
        : 'in_flight';
    if (settledSuccess) {
      terminalClosure = finalizeBranchCopiedTerminalClosureV1({
        version: 1,
        targetThreadId: input.targetThreadId,
        targetGeneration: input.targetGeneration,
        branchMutationReceiptId: input.receiptId,
        sourceThreadId: input.sourceThreadId,
        sourceGeneration: input.sourceGeneration,
        sourceSelectedCutProofDigest: input.selectedCutDigest,
        terminal: {
          kind: 'success',
          envelopes: [
            { role: 'continuation_consumed', envelope: consumed },
            { role: 'primary_resource_reserved', envelope: reserved },
            { role: 'primary_resource_dispatch_started', envelope: dispatched },
            { role: 'primary_terminal', envelope: primarySuccess! },
            { role: 'resource_terminal', envelope: resourceSuccess! },
          ],
        },
      });
    } else if (settledError) {
      terminalClosure = finalizeBranchCopiedTerminalClosureV1({
        version: 1,
        targetThreadId: input.targetThreadId,
        targetGeneration: input.targetGeneration,
        branchMutationReceiptId: input.receiptId,
        sourceThreadId: input.sourceThreadId,
        sourceGeneration: input.sourceGeneration,
        sourceSelectedCutProofDigest: input.selectedCutDigest,
        terminal: {
          kind: 'error_terminal',
          outcome:
            resourceError!.payload.type === 'resource_budget.released'
              ? 'provider_admission_denied'
              : 'unknown_external_outcome',
          envelopes: [
            { role: 'continuation_consumed', envelope: consumed },
            { role: 'primary_resource_reserved', envelope: reserved },
            { role: 'primary_resource_dispatch_started', envelope: dispatched },
            { role: 'primary_terminal', envelope: runError! },
            { role: 'resource_terminal', envelope: resourceError! },
            { role: 'turn_terminal', envelope: turnAborted! },
          ],
        },
      });
    }
    let runErrorEventId: string | undefined;
    let resourceTerminalEventId: string | undefined;
    let turnAbortedEventId: string | undefined;
    if (primaryState === 'in_flight') {
      const failure = classifyFailure(
        'unknown',
        'Continuation primary ownership was detached by a branch mutation.',
      );
      runErrorEventId = append({
        type: 'run.error',
        message: failure.message,
        recoverable: false,
        failure,
        turnId: consumption.continuation.turnId,
        outcome: failedTerminalOutcomeV1(failure, { knownExternalEffects: 'unknown' }),
      });
      if (reservation?.state === 'dispatch_started') {
        resourceTerminalEventId = append({
          type: 'resource_budget.unknown',
          reservationId: consumption.resourceReservationId,
          normalReprepareConsumptionKey: consumption,
        });
      } else
        throw new Error(
          reservation?.state === 'unknown'
            ? 'In-flight continuation has an unknown reservation without its matching terminal quartet.'
            : 'In-flight continuation lacks a dispatched reservation.',
        );
      turnAbortedEventId = append({
        type: 'turn.aborted',
        turnId: consumption.continuation.turnId,
        reason: failure.message,
        cause: 'error',
      });
    }
    const receiptBody = {
      version: 1 as const,
      receiptId: input.receiptId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      sourceGeneration: input.sourceGeneration,
      targetGeneration: input.targetGeneration,
      selectedCutDigest: input.selectedCutDigest,
      consumption,
      primaryState,
      ...(runErrorEventId ? { runErrorEventId } : {}),
      ...(resourceTerminalEventId ? { resourceTerminalEventId } : {}),
      ...(turnAbortedEventId ? { turnAbortedEventId } : {}),
    };
    const receipt: NormalReprepareConsumptionDetachReceiptV1 = {
      ...receiptBody,
      checksum: detachChecksum(receiptBody),
    };
    append({
      type: 'context.normal_reprepare_consumption_detached_v1',
      attemptId: consumption.attemptId,
      receiptId: input.receiptId,
      receipt,
    });
  }

  assertRuntimeStateInvariants(state);
  const detachIndex = events.findIndex(
    (event) => event.type === 'context.normal_reprepare_consumption_detached_v1',
  );
  let receipt: BranchMutationReceiptV1 | undefined;
  if (detachIndex >= 0) {
    const inFlight = events[detachIndex - 3]?.type === 'run.error';
    const manifest = inFlight
      ? ({
          kind: 'in_flight_quartet',
          eventIds: metadata
            .slice(detachIndex - 3, detachIndex + 1)
            .map((entry) => entry.eventId) as [string, string, string, string],
          eventTypes: [
            'run.error',
            'resource_budget.unknown',
            'turn.aborted',
            'context.normal_reprepare_consumption_detached_v1',
          ],
        } as const)
      : ({
          kind: 'settled_detach',
          eventIds: [metadata[detachIndex]!.eventId],
          eventTypes: ['context.normal_reprepare_consumption_detached_v1'],
        } as const);
    const baseRevision = metadata[inFlight ? detachIndex - 3 : detachIndex]!.revision - 1;
    receipt = finalizeBranchMutationReceiptV1({
      version: 1,
      receiptId: input.receiptId,
      reason: input.reason,
      sourceThreadId: input.sourceThreadId,
      sourceGeneration: input.sourceGeneration,
      targetThreadId: input.targetThreadId,
      targetGeneration: input.targetGeneration,
      selectedCutDigest: input.selectedCutDigest,
      targetLedgerBaseId,
      manifest,
      baseRevision,
      finalRevision: metadata[detachIndex]!.revision,
      postSnapshotDigest: canonicalContextDigestV3('runtime-branch-post-snapshot:v1', state),
      terminalClosure: terminalClosure
        ? { kind: 'copied', closureChecksum: terminalClosure.closureChecksum }
        : { kind: 'none' },
    });
  }
  const postSnapshotDigest = canonicalContextDigestV3('runtime-branch-post-snapshot:v1', state);
  const genericManifest = receipt?.manifest ?? {
    kind: 'none' as const,
    eventIds: metadata.map((entry) => entry.eventId),
    eventTypes: events.map((event) => event.type),
  };
  const manifestDigest = manifestDigestV1({
    manifest: genericManifest,
    baseRevision: metadata[0]?.revision ? metadata[0].revision - 1 : state.revision,
    finalRevision: metadata.at(-1)?.revision ?? state.revision,
    payloadDigests: events.map((event) =>
      canonicalContextDigestV3('branch-mutation-event-payload:v1', event),
    ),
  });
  const candidateDigest = canonicalContextDigestV3('branch-mutation-candidate:v1', {
    requestDigest: input.requestDigest,
    receipt: receipt ?? null,
    eventIds: metadata.map((entry) => entry.eventId),
    closureChecksum: terminalClosure?.closureChecksum ?? null,
    postSnapshotDigest,
  });
  const completion = finalizeBranchMutationCompletionV1({
    version: 1,
    receiptId: input.receiptId,
    targetThreadId: input.targetThreadId,
    targetGeneration: input.targetGeneration,
    requestDigest: input.requestDigest,
    candidateDigest,
    manifestDigest,
    postSnapshotDigest,
  });
  return {
    state,
    events,
    metadata,
    requestDigest: input.requestDigest,
    candidateDigest,
    ...(receipt ? { receipt } : {}),
    ...(terminalClosure ? { terminalClosure } : {}),
    completion,
  };
}
