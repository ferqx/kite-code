import { createHash } from 'node:crypto';
import type { RuntimeEvent } from './events';
import type { RuntimeState } from './state';

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actualUsageDigest(value: unknown): string {
  return createHash('sha256')
    .update('summary-resolution-actual-usage:v1\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

/** Closed Summary start/terminal batch validator executed before reduction. */
export function assertSummaryLifecycleBatchV1(
  events: readonly RuntimeEvent[],
  state: Readonly<RuntimeState>,
): void {
  const consumed = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'context.normal_reprepare_consumed_v1' }> =>
      event.type === 'context.normal_reprepare_consumed_v1',
  );
  const consumptionBoundResources = events.filter(
    (event) =>
      (event.type === 'resource_budget.reserved' ||
        event.type === 'resource_budget.dispatch_started') &&
      event.normalReprepareConsumptionKey != null,
  );
  if (consumed.length > 1) throw new Error('Continuation may be consumed only once per batch.');
  if (consumed[0] || consumptionBoundResources.length > 0) {
    const key = consumed[0]?.consumptionKey;
    const lifecycle = state.context.summaryLifecycle;
    const reserved = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'resource_budget.reserved' }> =>
        event.type === 'resource_budget.reserved' &&
        event.reservation.reservationId === key?.resourceReservationId,
    );
    const dispatched = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'resource_budget.dispatch_started' }> =>
        event.type === 'resource_budget.dispatch_started' &&
        event.reservationId === key?.resourceReservationId,
    );
    if (
      !key ||
      lifecycle.kind !== 'normal_reprepare_required' ||
      !equal(key.originReceipt, lifecycle.receipt) ||
      !equal(key.continuation, lifecycle.receipt.continuation) ||
      key.attemptId !== lifecycle.receipt.attemptId ||
      key.compactionId !== lifecycle.receipt.compactionId ||
      !key.primaryEffectLeaseId ||
      !key.primaryRequestId ||
      !reserved ||
      !dispatched ||
      reserved.reservation.invocationId !== key.primaryInvocationId ||
      !equal(reserved.normalReprepareConsumptionKey, key) ||
      !equal(dispatched.normalReprepareConsumptionKey, key)
    ) {
      throw new Error('Continuation consumption requires one exact primary start batch.');
    }
  }
  const priorConsumption =
    state.context.summaryLifecycle.kind === 'idle'
      ? state.context.summaryLifecycle.lastConsumption
      : undefined;
  const continuationResourceTerminal = priorConsumption
    ? events.find(
        (event) =>
          (event.type === 'resource_budget.released' || event.type === 'resource_budget.unknown') &&
          event.reservationId === priorConsumption.resourceReservationId,
      )
    : undefined;
  if (continuationResourceTerminal) {
    const consumption = priorConsumption!;
    const runError = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'run.error' }> => event.type === 'run.error',
    );
    const aborted = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'turn.aborted' }> =>
        event.type === 'turn.aborted',
    );
    const denial = continuationResourceTerminal.type === 'resource_budget.released';
    if (
      !runError ||
      !aborted ||
      runError.turnId !== consumption.continuation.turnId ||
      aborted.turnId !== consumption.continuation.turnId ||
      aborted.cause !== 'error' ||
      (denial
        ? continuationResourceTerminal.proof !== 'local_provider_admission_denied' ||
          (runError.failure?.kind !== 'policy_denied' &&
            runError.failure?.kind !== 'mandatory_policy_unavailable') ||
          runError.outcome?.knownExternalEffects !== 'none'
        : runError.failure?.kind !== 'unknown' ||
          runError.outcome?.knownExternalEffects !== 'unknown')
    ) {
      throw new Error('Continuation primary terminal requires one closed three-event batch.');
    }
  }
  const resolutionReconcile = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'resource_budget.reconciled' }> =>
      event.type === 'resource_budget.reconciled' && event.summaryResolutionBatchKey != null,
  );
  const resolutionReprepare = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'context.normal_reprepare_required_v1' }> =>
      event.type === 'context.normal_reprepare_required_v1' &&
      event.summaryResolutionBatchKey != null,
  );
  if (resolutionReconcile || resolutionReprepare) {
    if (
      !resolutionReconcile ||
      !resolutionReprepare ||
      state.context.summaryLifecycle.kind !== 'resource_resolution_required' ||
      !equal(
        resolutionReconcile.summaryResolutionBatchKey,
        resolutionReprepare.summaryResolutionBatchKey,
      )
    ) {
      throw new Error('Late Summary resolution requires one closed two-event batch.');
    }
    const key = resolutionReconcile.summaryResolutionBatchKey!;
    const pending = state.context.summaryLifecycle;
    if (
      key.version !== 1 ||
      key.generation !== resolutionReprepare.receipt.generation ||
      key.attemptId !== pending.attempt.attemptId ||
      key.compactionId !== pending.attempt.compactionId ||
      key.originalTerminalBatchId !== pending.terminalBatchKey.terminalBatchId ||
      key.resourceReservationId !== pending.resourceReservationId ||
      key.resourceUnknownEventId !== pending.resourceUnknownEventId ||
      resolutionReconcile.reservationId !== pending.resourceReservationId ||
      key.actualUsageDigest !== actualUsageDigest(resolutionReconcile.actual) ||
      !equal(key.continuation, pending.continuation) ||
      resolutionReprepare.receipt.origin.kind !== 'late_resolution' ||
      resolutionReprepare.receipt.origin.resolutionBatchId !== key.resolutionBatchId ||
      resolutionReprepare.receipt.origin.originalTerminalBatchId !== key.originalTerminalBatchId ||
      resolutionReprepare.receipt.origin.resourceUnknownEventId !== key.resourceUnknownEventId
    ) {
      throw new Error('Late Summary resolution key does not bind the pending unknown outcome.');
    }
  }
  const started = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'context.summary_dispatch_started_v1' }> =>
      event.type === 'context.summary_dispatch_started_v1',
  );
  if (started.length > 1) throw new Error('Summary batch may contain only one dispatch start.');
  const summaryStartResources = events.filter(
    (event) =>
      (event.type === 'resource_budget.reserved' ||
        event.type === 'resource_budget.dispatch_started') &&
      event.summaryStartBatchKey != null,
  );
  if (summaryStartResources.length > 0 && !started[0]) {
    throw new Error('Summary resource start evidence cannot persist as a partial batch.');
  }
  const autoRequest = events.find(
    (event) => event.type === 'context.summary_requested_v1' && event.attempt.reason === 'auto',
  );
  if (autoRequest && !started[0]) {
    throw new Error('Auto Summary request and dispatch start must be one atomic batch.');
  }
  if (started[0]) {
    const key = started[0].startBatchKey;
    const requestedLifecycle = state.context.summaryLifecycle;
    const requestedInBatch = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'context.summary_requested_v1' }> =>
        event.type === 'context.summary_requested_v1' && event.attempt.attemptId === key.attemptId,
    );
    const attempt =
      requestedLifecycle.kind === 'requested'
        ? requestedLifecycle.attempt
        : requestedInBatch?.attempt;
    if (
      !attempt ||
      attempt.attemptId !== key.attemptId ||
      attempt.compactionId !== key.compactionId ||
      !equal(attempt.summarySourceIdentity, key.summarySourceIdentity) ||
      !equal(attempt.sourceProducingEventCutV1, key.sourceProducingEventCutV1) ||
      attempt.requestedAtRevision !== key.requestedAtRevision ||
      attempt.requestedAtTurnId !== key.requestedAtTurnId ||
      !key.dispatchStart.summaryEffectLeaseId ||
      !key.dispatchStart.requestId ||
      key.dispatchStart.expectedMaxOutputTokens < 1
    ) {
      throw new Error('Summary start key does not bind the requested attempt.');
    }
    const reserved = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'resource_budget.reserved' }> =>
        event.type === 'resource_budget.reserved' &&
        event.reservation.reservationId === key.dispatchStart.resourceReservationId,
    );
    const dispatch = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'resource_budget.dispatch_started' }> =>
        event.type === 'resource_budget.dispatch_started' &&
        event.reservationId === key.dispatchStart.resourceReservationId,
    );
    if (
      !reserved ||
      !dispatch ||
      !equal(reserved.summaryStartBatchKey, key) ||
      !equal(dispatch.summaryStartBatchKey, key)
    )
      throw new Error('Summary dispatch start requires one closed resource start batch.');
    if (
      state.context.summaryLifecycle.kind === 'idle' &&
      requestedInBatch?.attempt.reason !== 'auto'
    ) {
      throw new Error('Auto summary start requires its request in the same batch.');
    }
  }

  const terminals = events.filter(
    (event) =>
      event.type === 'context.summary_completed_v1' ||
      event.type === 'context.summary_failed_v1' ||
      event.type === 'context.summary_unknown_external_outcome_v1',
  );
  if (terminals.length > 1) throw new Error('Summary batch may contain only one terminal.');
  const terminal = terminals[0] as
    | Extract<
        RuntimeEvent,
        {
          type:
            | 'context.summary_completed_v1'
            | 'context.summary_failed_v1'
            | 'context.summary_unknown_external_outcome_v1';
        }
      >
    | undefined;
  if (!terminal) {
    const lifecycle = state.context.summaryLifecycle;
    const startedReservationId =
      lifecycle.kind === 'started'
        ? lifecycle.startBatchKey.dispatchStart.resourceReservationId
        : undefined;
    const orphanResourceTerminal = events.find(
      (event) =>
        (event.type === 'resource_budget.reconciled' ||
          event.type === 'resource_budget.released' ||
          event.type === 'resource_budget.unknown') &&
        (event.summaryTerminalBatchKey != null ||
          (startedReservationId != null && event.reservationId === startedReservationId)),
    );
    if (orphanResourceTerminal) {
      throw new Error('Summary resource terminal cannot persist without its Summary terminal.');
    }
    return;
  }
  const key = terminal.terminalBatchKey;
  const startedLifecycle = state.context.summaryLifecycle;
  const manualPreReservationDenial =
    startedLifecycle.kind === 'requested' &&
    startedLifecycle.attempt.reason === 'manual' &&
    terminal.type === 'context.summary_failed_v1' &&
    terminal.providerDispatchState === 'not_entered' &&
    key.admission.stage === 'denied' &&
    key.dispatchStart === undefined;
  const bindingAttempt =
    startedLifecycle.kind === 'started' || startedLifecycle.kind === 'requested'
      ? startedLifecycle.attempt
      : undefined;
  if (
    (startedLifecycle.kind !== 'started' && !manualPreReservationDenial) ||
    !bindingAttempt ||
    bindingAttempt.attemptId !== key.attemptId ||
    bindingAttempt.compactionId !== key.compactionId ||
    !equal(bindingAttempt.summarySourceIdentity, key.summarySourceIdentity) ||
    !equal(bindingAttempt.sourceProducingEventCutV1, key.sourceProducingEventCutV1) ||
    (startedLifecycle.kind === 'started' &&
      !equal(startedLifecycle.startBatchKey.dispatchStart, key.dispatchStart)) ||
    (manualPreReservationDenial &&
      (!startedLifecycle.requestedEventId || key.causationId !== startedLifecycle.requestedEventId))
  ) {
    throw new Error('Summary terminal key does not bind the started attempt.');
  }
  const resourceTerminal = events.find(
    (event) =>
      event.type === 'resource_budget.reconciled' ||
      event.type === 'resource_budget.released' ||
      event.type === 'resource_budget.unknown',
  ) as
    | Extract<
        RuntimeEvent,
        {
          type:
            | 'resource_budget.reconciled'
            | 'resource_budget.released'
            | 'resource_budget.unknown';
        }
      >
    | undefined;
  if (!manualPreReservationDenial) {
    if (!resourceTerminal || !equal(resourceTerminal.summaryTerminalBatchKey, key)) {
      throw new Error('Summary terminal requires one matching resource terminal.');
    }
  } else if (resourceTerminal) {
    throw new Error('Pre-reservation denial cannot terminalize a resource reservation.');
  }
  if (resourceTerminal && key.dispatchStart) {
    if (resourceTerminal.reservationId !== key.dispatchStart.resourceReservationId) {
      throw new Error('Summary terminal resource reservation mismatch.');
    }
    if (
      (key.admission.stage === 'denied' &&
        (resourceTerminal.type !== 'resource_budget.released' ||
          resourceTerminal.proof !== 'local_provider_admission_denied')) ||
      (key.admission.stage === 'admitted' &&
        resourceTerminal.type !== 'resource_budget.reconciled' &&
        resourceTerminal.type !== 'resource_budget.unknown') ||
      (key.admission.stage === 'indeterminate_after_crash' &&
        resourceTerminal.type !== 'resource_budget.unknown') ||
      (key.admission.stage === 'not_completed' &&
        (resourceTerminal.type !== 'resource_budget.released' ||
          resourceTerminal.proof !== 'prepared_dispatch_not_entered_v1' ||
          !equal(resourceTerminal.summaryDispatchGuardProof, key.admission.proof) ||
          key.admission.proof.summaryStartBatchId !== key.dispatchStart.startBatchId))
    ) {
      throw new Error('Summary admission and resource terminal are incompatible.');
    }
  }
  if (
    terminal.type === 'context.summary_failed_v1' &&
    (key.admission.stage === 'not_completed' ||
      key.admission.stage === 'denied' ||
      manualPreReservationDenial) !==
      (terminal.providerDispatchState === 'not_entered')
  ) {
    throw new Error('Summary failure Provider-entry evidence is inconsistent.');
  }
  if (
    terminal.type === 'context.summary_completed_v1' &&
    terminal.providerDispatchState !== 'entered'
  ) {
    throw new Error('Summary completion requires Provider callback entry.');
  }
  const continuation = events.find(
    (event) =>
      event.type === 'context.normal_reprepare_required_v1' ||
      event.type === 'context.normal_resource_resolution_required_v1' ||
      event.type === 'context.normal_continuation_superseded_v1',
  );
  const auto = startedLifecycle.kind === 'started' && startedLifecycle.attempt.reason === 'auto';
  if (auto && !continuation) throw new Error('Auto summary terminal requires one continuation.');
  if (!auto && continuation) throw new Error('Manual summary terminal cannot create continuation.');
  if (auto && resourceTerminal?.type === 'resource_budget.unknown') {
    if (continuation?.type !== 'context.normal_resource_resolution_required_v1') {
      throw new Error('Unknown summary usage requires resource resolution, not reprepare.');
    }
  } else if (
    auto &&
    continuation?.type !== 'context.normal_reprepare_required_v1' &&
    continuation?.type !== 'context.normal_continuation_superseded_v1'
  ) {
    throw new Error('Settled summary usage requires normal reprepare.');
  }
  if (
    continuation?.type === 'context.normal_continuation_superseded_v1' &&
    (continuation.attemptId !== key.attemptId || continuation.reason !== 'new_source')
  )
    throw new Error('Stale Summary supersede must bind the current attempt and new source.');
}
