import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateActiveTask as getActiveTask,
  runtimeHostStateHasPendingSandboxCleanupAuthority as hasPendingSandboxCleanupAuthority,
  runtimeHostStateHasPendingSubagentCleanupAuthority as hasPendingSubagentCleanupAuthority,
  runtimeHostStateInteractionBelongsToCurrentWork as interactionBelongsToCurrentWork,
  runtimeHostStateInteractionToolCall as interactionToolCall,
  type RuntimeHostStateRestartRecoveryFacts,
  runtimeHostStateToolCallBelongsToCurrentWork as toolCallBelongsToCurrentWork,
  runtimeHostStateVerifiedDispatchedChildDelegationIds as verifiedDispatchedChildDelegationIds,
  runtimeHostStateVerifiedLiveAfterTurnReservationIds as verifiedLiveAfterTurnReservationIds,
  runtimeHostStateVerifiedPendingAfterTurnReservationIds as verifiedPendingAfterTurnReservationIds,
  runtimeHostStateVerifiedPendingFollowupReservationIds as verifiedPendingFollowupReservationIds,
  runtimeHostStateVerifiedPreparedCurrentTurnModelReservationIds as verifiedPreparedCurrentTurnModelReservationIds,
  runtimeHostStateVerifiedPreparedFollowupModelReservationIds as verifiedPreparedFollowupModelReservationIds,
  runtimeHostStateVerifiedSealedAfterTurnReportReservationIds as verifiedSealedAfterTurnReportReservationIds,
} from '@kite-ai/runtime-host/kernel-adapter';
import { type ClassifiedFailure, classifyFailure } from './failures';
import { rootToolInteractionOwner, runtimeInteractionOwnerForPending } from './interaction-owner';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

type ToolCallStatus = RuntimeState['tools']['calls'][string]['status'];

const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

/**
 * Classify the sole provider.admission_required producer in the supported
 * State26/State27 epochs. In each epoch this event was written only by the
 * required-provider check between accepted user input and model dispatch;
 * actual provider authentication used provider.action_required. Require the
 * complete current-Turn journal so an unrelated or ambiguous wait stays put.
 */
export function obsoleteGlobalAdmissionSettlementEvents(
  state: Readonly<RuntimeState>,
  journal: readonly { readonly event: RuntimeEvent; readonly revision?: number }[],
): Extract<RuntimeEvent, { type: 'provider.admission_cancelled' }>[] {
  const original = classifyObsoleteGlobalAdmission(state, journal, 'waiting');
  return (
    original?.map((admission) => ({
      type: 'provider.admission_cancelled' as const,
      interactionId: admission.interactionId,
      providerId: admission.providerId,
    })) ?? []
  );
}

/**
 * The settlement receipt may outlive the process before its prepared Turn is
 * dispatched. Model invocation_prepared and attempt_started are durably
 * acknowledged before outbound transport; Tool dispatch follows those facts.
 * A fully settled journal with no such fact can continue the original Run.
 */
export function canContinueSettledGlobalAdmission(
  state: Readonly<RuntimeState>,
  journal: readonly { readonly event: RuntimeEvent; readonly revision?: number }[],
): boolean {
  return classifyObsoleteGlobalAdmission(state, journal, 'settled') !== undefined;
}

/** Resume the original required child wait, never a parent model attempt already dispatched. */
export function canContinueAcceptedIndependentChild(
  state: Readonly<RuntimeState>,
  journal: readonly { readonly event: RuntimeEvent; readonly revision?: number }[],
): boolean {
  if (
    state.recoveryState.kind !== 'normal' ||
    state.turn.status !== 'active' ||
    state.interactions.kind !== 'idle' ||
    !state.activeTaskId ||
    state.tasks[state.activeTaskId]?.status !== 'active' ||
    state.terminalOutcome ||
    journal.at(-1)?.revision !== state.revision ||
    Object.values(state.modelInvocations).some((invocation) =>
      ['prepared', 'dispatching', 'unknown'].includes(invocation.status),
    ) ||
    Object.values(state.tools.calls).some((call) =>
      [
        'running',
        'queued',
        'awaiting_approval',
        'awaiting_review',
        'awaiting_auto_review',
      ].includes(call.status),
    )
  )
    return false;
  let turnStart = -1;
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const event = journal[index]?.event;
    if (event?.type === 'turn.started' && event.turnId === state.turn.turnId) {
      turnStart = index;
      break;
    }
  }
  if (turnStart < 0) return false;
  const currentTurn = journal.slice(turnStart + 1).map(({ event }) => event);
  let lastChildIntent = -1;
  for (let index = currentTurn.length - 1; index >= 0; index -= 1) {
    const event = currentTurn[index];
    if (
      event?.type === 'subagent.child_session_intended' &&
      event.disposition === 'required' &&
      event.parentSessionId === state.session.threadId &&
      event.originRunId === state.turn.turnId &&
      event.originTurnId === state.turn.turnId &&
      state.tools.calls[event.originToolCallId]?.status === 'succeeded' &&
      state.capabilities.invocations[event.parentInvocationId]?.subagentProviderLifecycle
        ?.childSession?.childThreadId === event.childThreadId
    ) {
      lastChildIntent = index;
      break;
    }
  }
  if (lastChildIntent < 0) return false;
  return !currentTurn
    .slice(lastChildIntent + 1)
    .some(
      (event) =>
        event.type === 'model.invocation_prepared' ||
        event.type === 'turn.aborted' ||
        event.type === 'run.error' ||
        event.type === 'run.completed',
    );
}

/** Resume a committed provisional final only after its exact required-child wait. */
export function canContinueBlockedIndependentChild(
  state: Readonly<RuntimeState>,
  journal: readonly { readonly event: RuntimeEvent; readonly revision?: number }[],
): boolean {
  const waiting = state.completionGuard.waitingReason;
  if (
    state.recoveryState.kind !== 'normal' ||
    state.turn.status !== 'active' ||
    state.interactions.kind !== 'idle' ||
    !state.activeTaskId ||
    state.tasks[state.activeTaskId]?.status !== 'active' ||
    state.terminalOutcome ||
    waiting?.kind !== 'required_background' ||
    waiting.taskIds.length === 0 ||
    journal.at(-1)?.revision !== state.revision ||
    Object.values(state.modelInvocations).some((invocation) =>
      ['prepared', 'dispatching'].includes(invocation.status),
    ) ||
    Object.values(state.tools.calls).some((call) =>
      [
        'running',
        'queued',
        'awaiting_approval',
        'awaiting_review',
        'awaiting_auto_review',
      ].includes(call.status),
    )
  )
    return false;
  let start = -1;
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const event = journal[index]?.event;
    if (event?.type === 'turn.started' && event.turnId === state.turn.turnId) {
      start = index;
      break;
    }
  }
  if (start < 0) return false;
  const turn = journal.slice(start + 1).map(({ event }) => event);
  let blockedIndex = -1;
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const event = turn[index];
    if (
      event?.type === 'completion.blocked' &&
      event.turnId === state.turn.turnId &&
      event.nextAction === 'wait_for_background'
    ) {
      blockedIndex = index;
      break;
    }
  }
  if (blockedIndex < 0) return false;
  const blocked = turn[blockedIndex]!;
  if (blocked.type !== 'completion.blocked' || !blocked.modelInvocationId) return false;
  const expectedIds = [...new Set(waiting.taskIds)].sort();
  if (
    expectedIds.length !== waiting.taskIds.length ||
    JSON.stringify(expectedIds) !== JSON.stringify([...(blocked.backgroundTaskIds ?? [])].sort())
  )
    return false;
  const model = state.modelInvocations[blocked.modelInvocationId];
  if (
    model?.status !== 'completed' ||
    model.purpose !== 'primary_agent' ||
    model.responseArtifact?.kind !== 'model_response' ||
    !/^sha256:[a-f0-9]{64}$/u.test(model.responseArtifact.integrityIdentifier)
  )
    return false;
  const before = turn.slice(0, blockedIndex);
  let response = -1;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const event = before[index];
    if (event?.type === 'model.responded' && event.invocationId === blocked.modelInvocationId) {
      response = index;
      break;
    }
  }
  if (response < 0) return false;
  let completed = -1;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const event = before[index];
    if (
      event?.type === 'model.invocation_completed' &&
      event.invocationId === blocked.modelInvocationId &&
      event.responseArtifact.integrityIdentifier === model.responseArtifact.integrityIdentifier
    ) {
      completed = index;
      break;
    }
  }
  if (completed < 0 || completed > response) return false;
  for (const taskId of expectedIds) {
    let intent: Extract<RuntimeEvent, { type: 'subagent.child_session_intended' }> | undefined;
    for (let index = before.length - 1; index >= 0; index -= 1) {
      const event = before[index];
      if (
        event?.type === 'subagent.child_session_intended' &&
        event.disposition === 'required' &&
        event.childInvocationId === taskId &&
        event.parentSessionId === state.session.threadId &&
        event.originRunId === state.turn.turnId &&
        event.originTurnId === state.turn.turnId
      ) {
        intent = event;
        break;
      }
    }
    if (
      !intent ||
      state.tools.calls[intent.originToolCallId]?.status !== 'succeeded' ||
      state.capabilities.invocations[intent.parentInvocationId]?.subagentProviderLifecycle
        ?.childSession?.childThreadId !== intent.childThreadId
    )
      return false;
  }
  return !turn
    .slice(blockedIndex + 1)
    .some((event) =>
      [
        'model.invocation_prepared',
        'model.invocation_attempt_started',
        'model.requested',
        'model.response_superseded',
        'tool.queued',
        'tool.started',
        'capability.execution_started',
        'run.error',
        'run.completed',
        'turn.aborted',
      ].includes(event.type),
    );
}

function classifyObsoleteGlobalAdmission(
  state: Readonly<RuntimeState>,
  journal: readonly { readonly event: RuntimeEvent; readonly revision?: number }[],
  phase: 'waiting' | 'settled',
): Extract<RuntimeEvent, { type: 'provider.admission_required' }>[] | undefined {
  if (
    state.recoveryState.kind !== 'normal' ||
    state.turn.status !== 'active' ||
    (phase === 'waiting'
      ? state.interactions.kind !== 'awaiting_provider_admission'
      : state.interactions.kind !== 'idle') ||
    !state.activeTaskId ||
    state.tasks[state.activeTaskId]?.status !== 'active' ||
    state.pendingApprovals.size !== 0 ||
    state.toolRecovery.qualityGuard.blocked ||
    Object.values(state.toolRecovery.failures).some((failure) => failure.status === 'unresolved') ||
    hasPendingSandboxCleanupAuthority(state) ||
    hasPendingSubagentCleanupAuthority(state) ||
    Object.values(state.capabilities.invocations).some((invocation) =>
      ['unknown', 'running', 'recorded'].includes(invocation.status),
    ) ||
    Object.values(state.resourceBudget.reservations).some((reservation) =>
      ['queued', 'reserved', 'dispatch_started', 'unknown'].includes(reservation.state),
    ) ||
    (state.resourceBudget.status === 'active' &&
      Object.values(state.resourceBudget.waiters).some(
        (waiter) => waiter.state === 'waiting' || waiter.state === 'promoted',
      )) ||
    journal.at(-1)?.revision !== state.revision
  )
    return undefined;

  let turnIndex = -1;
  for (let index = 0; index < journal.length; index += 1) {
    const event = journal[index]?.event;
    if (event?.type === 'turn.started' && event.turnId === state.turn.turnId) turnIndex = index;
  }
  if (turnIndex < 1 || journal[turnIndex - 1]?.event.type !== 'user.message_appended')
    return undefined;
  const firstAdmissionIndex = journal.findIndex(
    ({ event }, index) => index > turnIndex && event.type === 'provider.admission_required',
  );
  if (firstAdmissionIndex < 0) return undefined;
  if (
    journal
      .slice(turnIndex + 1, firstAdmissionIndex)
      .some(
        ({ event }) =>
          event.type !== 'skill.catalog_refreshed' && event.type !== 'skill.activation_started',
      )
  )
    return undefined;
  const suffix = journal.slice(firstAdmissionIndex);
  const required = suffix.flatMap(({ event }) =>
    event.type === 'provider.admission_required' ? [event] : [],
  );
  const cancelled = suffix.flatMap(({ event }) =>
    event.type === 'provider.admission_cancelled' ? [event] : [],
  );
  const pending = state.providerAdmission.pending;
  if (
    required.length === 0 ||
    (phase === 'waiting'
      ? pending.length !== required.length ||
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== pending[0]?.interactionId ||
        cancelled.length !== 0
      : pending.length !== 0 || cancelled.length !== required.length) ||
    suffix.some(
      ({ event }) =>
        event.type !== 'provider.admission_required' &&
        event.type !== 'provider.admission_retry_requested' &&
        event.type !== 'provider.admission_retry_failed' &&
        event.type !== 'provider.admission_cancelled',
    ) ||
    (phase === 'settled' &&
      suffix
        .slice(-cancelled.length)
        .some(({ event }) => event.type !== 'provider.admission_cancelled')) ||
    Object.values(state.modelInvocations).some(
      (invocation) => invocation.preparedStateRevision >= journal[turnIndex]!.revision!,
    ) ||
    Object.values(state.tools.calls).some((call) => call.createdAtTurnId === state.turn.turnId)
  )
    return undefined;
  for (const [index, original] of required.entries()) {
    const admission = pending[index];
    if (
      (phase === 'waiting' &&
        (original.interactionId !== admission?.interactionId ||
          original.providerId !== admission.providerId ||
          original.source !== admission.source)) ||
      (phase === 'settled' &&
        (original.interactionId !== cancelled[index]?.interactionId ||
          original.providerId !== cancelled[index]?.providerId))
    )
      return undefined;
  }
  return required;
}

/**
 * Build the durable facts for stopping the current turn.
 *
 * The active task remains resumable. Every unfinished tool call receives a
 * result-pairing cancellation event before the turn is marked aborted.
 */
export function eventsForRunCancellation(
  state: Readonly<RuntimeState>,
  reason = 'Cancelled by user.',
  cause: 'user' | 'error' = 'user',
  toolFailure?: ClassifiedFailure,
): RuntimeEvent[] {
  // Keyboard cancellation on a visible Tool approval must retain the exact
  // approval identity even when the Runtime action waiter has not attached
  // yet. This also cancels every unfinished concurrent sibling atomically.
  if (cause === 'user' && state.interactions.kind === 'awaiting_tool_approval') {
    return approvalCancellationEvents(state, state.interactions, reason);
  }
  // auto_review is never a human approval surface. If a user aborts while it
  // is running, preserve that precise durable reason instead of pretending an
  // approval was rejected or silently escalating it.
  const toolReason =
    cause === 'user' && state.interactions.kind === 'awaiting_auto_review'
      ? 'user_cancelled'
      : reason;
  const toolCancellations = unfinishedToolCancellationEvents(
    state,
    toolReason,
    undefined,
    toolFailure,
  );
  const userWaivers: RuntimeEvent[] =
    cause === 'user'
      ? Object.values(state.capabilities.invocations)
          .filter(
            (invocation) =>
              invocation.receiptRequirement &&
              (invocation.status === 'recorded' || invocation.status === 'running') &&
              toolCancellations.some((event) => event.toolCallId === invocation.toolCallId),
          )
          .map((invocation) => ({
            type: 'capability.reconciliation_resolved' as const,
            invocationId: invocation.invocationId,
            decision: 'waived' as const,
            reconciledAt: new Date().toISOString(),
            reason: 'User cancelled the run and waived reconciliation of the abandoned attempt.',
          }))
      : [];
  return [
    ...toolCancellations,
    ...userWaivers,
    ...interruptedCurrentRunModels(state),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason,
      cause,
    },
  ];
}

function interruptedCurrentRunModels(state: Readonly<RuntimeState>): RuntimeEvent[] {
  return Object.values(state.modelInvocations).flatMap((invocation) => {
    if (invocation.status !== 'dispatching' || invocation.attempts < 1) return [];
    if (invocation.budget.kind === 'reservation') {
      if (state.resourceBudget.status !== 'active') return [];
      const reservation = state.resourceBudget.reservations[invocation.budget.reservationId];
      if (
        reservation?.runId !== state.turn.turnId ||
        reservation.invocationId !== `model-invocation:${invocation.invocationId}` ||
        reservation.state !== 'dispatch_started'
      )
        return [];
    } else if (
      // Without a reservation there is no Run-linked budget row. Only the
      // foreground primary attempt belongs to this cancelled Turn here.
      invocation.purpose !== 'primary_agent' ||
      invocation.parentInvocationId !== null ||
      invocation.parentToolCallId !== null
    )
      return [];
    // The attempt was durably dispatched. Cancellation closes the local model
    // invocation; the separate budget event still records unknown Provider usage.
    return [
      {
        type: 'model.invocation_interrupted' as const,
        invocationId: invocation.invocationId,
        dispatchCertainty: 'attempted' as const,
        reasonCode: 'cancelled' as const,
      },
    ];
  });
}

function resourceReservationCancellationEvents(
  state: Readonly<RuntimeState>,
  preserveExact = new Set<string>(),
): RuntimeEvent[] {
  if (state.resourceBudget.status !== 'active') return [];
  const events: RuntimeEvent[] = [];
  for (const reservation of Object.values(state.resourceBudget.reservations)) {
    if (
      (reservation.state === 'queued' || reservation.state === 'reserved') &&
      !preserveExact.has(reservation.reservationId)
    ) {
      events.push({
        type: 'resource_budget.released',
        reservationId: reservation.reservationId,
      });
    } else if (
      reservation.state === 'dispatch_started' &&
      !preserveExact.has(reservation.reservationId)
    ) {
      events.push({
        type: 'resource_budget.unknown',
        reservationId: reservation.reservationId,
      });
    }
  }
  return events;
}

function resourceWaiterCancellationEvents(state: Readonly<RuntimeState>): RuntimeEvent[] {
  return state.resourceBudget.status === 'active'
    ? Object.values(state.resourceBudget.waiters)
        .filter((waiter) => waiter.state === 'waiting')
        .map((waiter) => ({
          type: 'resource_budget.waiter_cancelled' as const,
          invocationId: waiter.invocationId,
        }))
    : [];
}

function unfinishedToolCancellationEvents(
  state: Readonly<RuntimeState>,
  reason: string,
  excludedToolCallId?: string,
  failure?: ClassifiedFailure,
): Array<Extract<RuntimeEvent, { type: 'tool.cancelled' }>> {
  return Object.values(state.tools.calls)
    .filter((call) => !TERMINAL_TOOL_STATUSES.has(call.status))
    .filter((call) => call.toolCallId !== excludedToolCallId)
    .map((call) => ({
      type: 'tool.cancelled',
      toolCallId: call.toolCallId,
      reason,
      ...(failure ? { failure } : {}),
    }));
}

function capabilityWaiverEventsForToolTerminals(
  state: Readonly<RuntimeState>,
  toolCallIds: ReadonlySet<string>,
  reason: string,
): Array<Extract<RuntimeEvent, { type: 'capability.reconciliation_resolved' }>> {
  const reconciledAt = new Date().toISOString();
  return Object.values(state.capabilities.invocations)
    .filter(
      (invocation) =>
        invocation.receiptRequirement &&
        (invocation.status === 'recorded' || invocation.status === 'running') &&
        toolCallIds.has(invocation.toolCallId),
    )
    .map((invocation) => ({
      type: 'capability.reconciliation_resolved',
      invocationId: invocation.invocationId,
      decision: 'waived',
      reconciledAt,
      reason,
    }));
}

/**
 * Settle tool ownership left behind by an older run before accepting a fresh
 * user turn. A new turn cannot inherit an in-memory executor from the process
 * that owned these calls, so keeping them runnable would create a permanent
 * completion barrier.
 */
export function eventsForSupersededTurnRecovery(
  state: Readonly<RuntimeState>,
  reason = 'Superseded by a new user turn.',
): RuntimeEvent[] {
  const unfinished = Object.values(state.tools.calls)
    .filter((call) => toolCallBelongsToCurrentWork(state, call))
    .filter((call) => !TERMINAL_TOOL_STATUSES.has(call.status));
  const interactionCall = interactionToolCall(state);
  if (
    interactionCall &&
    !TERMINAL_TOOL_STATUSES.has(interactionCall.status) &&
    !unfinished.some((call) => call.toolCallId === interactionCall.toolCallId)
  ) {
    unfinished.push(interactionCall);
  }
  if (unfinished.length === 0) return [];

  return [
    ...unfinished.map((call) => ({
      type: 'tool.cancelled' as const,
      toolCallId: call.toolCallId,
      reason,
    })),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    ...(state.turn.status === 'active'
      ? [
          {
            type: 'turn.aborted' as const,
            turnId: state.turn.turnId,
            reason,
            cause: 'error' as const,
          },
        ]
      : []),
  ];
}

/**
 * Settle work after the Store fenced its old execution generation and the
 * Service confirmed process-owned provider and sandbox cleanup. The caller
 * supplies the complete event journal so a settled Tool can close its visible
 * Subagent card when the original projection missed a terminal event.
 *
 * A running Tool crossed the dispatch boundary, so its result is unknown and
 * must never be replayed. Work that had not started is cancelled by recovery.
 * The turn remains active only while a current durable interaction or
 * Subagent continuation still owns it.
 */
export function eventsForRestartedSessionRecovery(
  state: Readonly<RuntimeState>,
  historyEvents: readonly RuntimeEvent[],
  evidence: Readonly<{ kind: 'fenced_previous_execution'; controllerGeneration: number }>,
  reason = 'Runtime process ended before the operation completed.',
  preserveReservedChildDelegations: readonly string[] = [],
  preservePendingFollowupFunding: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preservePendingFollowupFunding']
  > = [],
  preservePreparedFollowupModels: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preservePreparedFollowupModels']
  > = [],
  preservePreparedCurrentTurnModels: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preservePreparedCurrentTurnModels']
  > = [],
  preserveDispatchedChildDelegations: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preserveDispatchedChildDelegations']
  > = [],
  preservePendingAfterTurnDelegations: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preservePendingAfterTurnDelegations']
  > = [],
  preserveLiveAfterTurnDelegations: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preserveLiveAfterTurnDelegations']
  > = [],
  preserveSealedAfterTurnReports: NonNullable<
    RuntimeHostStateRestartRecoveryFacts['preserveSealedAfterTurnReports']
  > = [],
): RuntimeEvent[] {
  if (evidence.kind !== 'fenced_previous_execution' || evidence.controllerGeneration < 1) {
    throw new Error('Restart recovery requires a fenced execution generation.');
  }
  const resumableToolCallIds = new Set<string>();
  if (interactionBelongsToCurrentWork(state)) {
    const interactionCall = interactionToolCall(state);
    if (interactionCall) resumableToolCallIds.add(interactionCall.toolCallId);
  }
  for (const pending of state.pendingApprovals.values()) {
    const call = state.tools.calls[pending.toolCallId];
    if (
      call &&
      toolCallBelongsToCurrentWork(state, call) &&
      !TERMINAL_TOOL_STATUSES.has(call.status) &&
      pending.status !== 'succeeded' &&
      pending.status !== 'failed' &&
      pending.status !== 'cancelled' &&
      pending.status !== 'rejected' &&
      pending.status !== 'expired'
    ) {
      resumableToolCallIds.add(call.toolCallId);
    }
  }
  for (const toolCallId of Object.keys(state.suspendedSubagents)) {
    const call = state.tools.calls[toolCallId];
    if (
      call &&
      toolCallBelongsToCurrentWork(state, call) &&
      !TERMINAL_TOOL_STATUSES.has(call.status)
    ) {
      resumableToolCallIds.add(toolCallId);
    }
  }
  // A fenced owner cannot resume a child Provider continuation after its
  // process-owned handle was cleaned up. Approval and suspension records may
  // still exist, but neither proves a live child executor.
  const cleanedChildParentToolIds = new Set(
    Object.values(state.capabilities.invocations)
      .filter(
        (invocation) =>
          invocation.subagentProviderLifecycle?.status === 'cleanup_completed' &&
          invocation.subagentProviderLifecycle.cleanupConfirmed === true,
      )
      .map((invocation) => invocation.toolCallId),
  );
  for (const toolCallId of cleanedChildParentToolIds) resumableToolCallIds.delete(toolCallId);
  for (const pending of state.pendingApprovals.values()) {
    if (pending.parentToolCallId && cleanedChildParentToolIds.has(pending.parentToolCallId)) {
      resumableToolCallIds.delete(pending.toolCallId);
    }
  }

  // An approval that never crossed dispatch cannot be resumed by the fenced
  // owner. Close this one precise stale wait after authority/cleanup proof;
  // preserve every wait with a dispatch acknowledgement or other live work.
  const pendingApproval =
    state.interactions.kind === 'awaiting_tool_approval'
      ? state.pendingApprovals.get(state.interactions.interactionId)
      : undefined;
  const approvalCall = pendingApproval ? state.tools.calls[pendingApproval.toolCallId] : undefined;
  const settleUndispatchedApproval =
    state.interactions.kind === 'awaiting_tool_approval' &&
    pendingApproval?.status === 'awaiting_user' &&
    (pendingApproval.dispatchState === undefined ||
      pendingApproval.dispatchState === 'before_dispatch') &&
    approvalCall?.status === 'awaiting_approval' &&
    state.pendingApprovals.size === 1 &&
    Object.keys(state.suspendedSubagents).length === 0 &&
    Object.values(state.tools.calls)
      .filter((call) => toolCallBelongsToCurrentWork(state, call))
      .every(
        (call) =>
          TERMINAL_TOOL_STATUSES.has(call.status) ||
          (call.toolCallId === approvalCall.toolCallId && call.status === 'awaiting_approval'),
      ) &&
    Object.values(state.capabilities.invocations)
      .filter((invocation) => invocation.toolCallId === approvalCall.toolCallId)
      .every(
        (invocation) =>
          invocation.status === 'recorded' &&
          (invocation.attemptsStarted ?? 0) === 0 &&
          invocation.subagentProviderLifecycle === undefined,
      ) &&
    Object.values(state.resourceBudget.reservations).every(
      (reservation) => reservation.state !== 'dispatch_started' && reservation.state !== 'unknown',
    );
  if (settleUndispatchedApproval) resumableToolCallIds.delete(approvalCall.toolCallId);

  const unfinished = Object.values(state.tools.calls)
    .filter((call) => toolCallBelongsToCurrentWork(state, call))
    .filter((call) => !TERMINAL_TOOL_STATUSES.has(call.status))
    .filter((call) => !resumableToolCallIds.has(call.toolCallId));
  const toolEvents: RuntimeEvent[] = unfinished.map((call) =>
    call.status === 'running'
      ? {
          type: 'tool.failed' as const,
          toolCallId: call.toolCallId,
          failure: classifyFailure('unknown', reason),
        }
      : {
          type: 'tool.cancelled' as const,
          toolCallId: call.toolCallId,
          reason,
        },
  );
  const settledSubagentEvents = settledSubagentHistoryEventsForToolIds(
    state,
    historyEvents,
    new Set([...failedTerminalToolIds(state), ...unfinished.map((call) => call.toolCallId)]),
    reason,
  );
  const hasResumableProviderInteraction =
    state.interactions.kind === 'awaiting_provider_action' ||
    state.interactions.kind === 'awaiting_provider_admission';
  const turnCanResume =
    resumableToolCallIds.size > 0 ||
    (hasResumableProviderInteraction &&
      !cleanedChildParentToolIds.has(interactionToolCall(state)?.toolCallId ?? ''));
  const hasInterruptedWork =
    settleUndispatchedApproval ||
    unfinished.length > 0 ||
    Object.values(state.modelInvocations).some(
      (invocation) =>
        invocation.status === 'interrupted' && invocation.interruptionReason === 'runtime_restored',
    ) ||
    (preservePreparedFollowupModels.length === 0 &&
      preservePreparedCurrentTurnModels.length === 0 &&
      isUndispatchedStartedTurn(state, historyEvents));
  const exactPendingChildReservations = new Set(
    historyEvents.flatMap((event) => {
      if (event.type !== 'subagent.child_session_intended') return [];
      const reservation =
        state.resourceBudget.status === 'active'
          ? state.resourceBudget.reservations[event.delegatedReservationId]
          : undefined;
      const invocation = state.capabilities.invocations[event.parentInvocationId];
      return state.turn.status === 'active' &&
        event.disposition === 'required' &&
        event.parentSessionId === state.session.threadId &&
        event.originRunId === state.turn.turnId &&
        event.fundingRunId === state.turn.turnId &&
        event.delegatedReservationId === `child-allotment:${event.childThreadId}` &&
        preserveReservedChildDelegations.includes(event.delegatedReservationId) &&
        state.tools.calls[event.originToolCallId]?.status === 'succeeded' &&
        invocation?.toolCallId === event.originToolCallId &&
        invocation.status === 'succeeded' &&
        reservation?.state === 'reserved' &&
        reservation.resourceKind === 'subagent' &&
        reservation.invocationId === event.delegatedReservationId
        ? [event.delegatedReservationId]
        : [];
    }),
  );
  const exactPendingFollowupReservations = verifiedPendingFollowupReservationIds(
    state,
    preservePendingFollowupFunding,
  );
  const exactPendingAfterTurnReservations = verifiedPendingAfterTurnReservationIds(
    state,
    preservePendingAfterTurnDelegations,
  );
  const exactLiveAfterTurnReservations = verifiedLiveAfterTurnReservationIds(
    state,
    preserveLiveAfterTurnDelegations,
  );
  const exactSealedAfterTurnReports = verifiedSealedAfterTurnReportReservationIds(
    state,
    preserveSealedAfterTurnReports,
  );
  const exactPreparedModels = verifiedPreparedFollowupModelReservationIds(
    state,
    preservePreparedFollowupModels,
  );
  const exactCurrentTurnModels = verifiedPreparedCurrentTurnModelReservationIds(
    state,
    preservePreparedCurrentTurnModels,
  );
  const exactDispatchedChildDelegations = verifiedDispatchedChildDelegationIds(
    state,
    preserveDispatchedChildDelegations,
  );

  return [
    ...settledSubagentEvents,
    ...toolEvents,
    ...resourceReservationCancellationEvents(
      state,
      new Set([
        ...exactPendingChildReservations,
        ...exactPendingAfterTurnReservations,
        ...exactLiveAfterTurnReservations,
        ...exactSealedAfterTurnReports,
        ...exactPendingFollowupReservations,
        ...exactPreparedModels.values(),
        ...exactCurrentTurnModels.values(),
        ...exactDispatchedChildDelegations,
      ]),
    ),
    ...resourceWaiterCancellationEvents(state),
    ...(state.turn.status === 'active' &&
    !state.activeFollowupTurn &&
    hasInterruptedWork &&
    !turnCanResume
      ? [
          {
            type: 'turn.aborted' as const,
            turnId: state.turn.turnId,
            reason,
            cause: 'error' as const,
          },
        ]
      : []),
  ];
}

/** A committed start can be activated before the process schedules its runner. */
function isUndispatchedStartedTurn(
  state: Readonly<RuntimeState>,
  historyEvents: readonly RuntimeEvent[],
): boolean {
  if (state.turn.status !== 'active' || state.interactions.kind !== 'idle') return false;
  if (
    Object.values(state.tools.calls).some((call) => toolCallBelongsToCurrentWork(state, call)) ||
    state.pendingApprovals.size > 0 ||
    Object.keys(state.suspendedSubagents).length > 0
  )
    return false;
  let started = -1;
  for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
    const event = historyEvents[index];
    if (event?.type === 'turn.started' && event.turnId === state.turn.turnId) {
      started = index;
      break;
    }
  }
  if (started < 0) return false;
  return historyEvents
    .slice(started + 1)
    .every(
      (event) =>
        event.type === 'skill.catalog_refreshed' || event.type === 'skill.activation_started',
    );
}

function failedTerminalToolIds(state: Readonly<RuntimeState>): string[] {
  return Object.values(state.tools.calls)
    .filter((call) => ['failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status))
    .map((call) => call.toolCallId);
}

function provenSuccessfulSubagentParent(
  state: Readonly<RuntimeState>,
  invocation: RuntimeState['capabilities']['invocations'][string],
): boolean {
  const lifecycle = invocation.subagentProviderLifecycle;
  return (
    invocation.status === 'succeeded' &&
    state.tools.calls[invocation.toolCallId]?.status === 'succeeded' &&
    lifecycle?.status === 'cleanup_completed' &&
    lifecycle.observationStatus === 'completed' &&
    lifecycle.cleanupConfirmed === true
  );
}

/** Cheap State-only hint; the full journal still proves a missing child terminal. */
export function hasSettledSubagentHistoryCandidate(state: Readonly<RuntimeState>): boolean {
  const terminalTools = new Set(failedTerminalToolIds(state));
  const childCounts = new Map<string, number>();
  const candidates = new Set<string>();
  for (const invocation of Object.values(state.capabilities.invocations)) {
    const lifecycle = invocation.subagentProviderLifecycle;
    if (!lifecycle) continue;
    childCounts.set(
      lifecycle.childInvocationId,
      (childCounts.get(lifecycle.childInvocationId) ?? 0) + 1,
    );
    const recoveredUnknown =
      invocation.status === 'unknown' && lifecycle.observationStatus !== 'completed';
    if (
      (!terminalTools.has(invocation.toolCallId) &&
        !provenSuccessfulSubagentParent(state, invocation) &&
        !recoveredUnknown) ||
      lifecycle.status !== 'cleanup_completed' ||
      lifecycle.cleanupConfirmed !== true
    )
      continue;
    candidates.add(lifecycle.childInvocationId);
  }
  return [...candidates].some((id) => childCounts.get(id) === 1);
}

/** Close stale history cards only when the parent Tool and Provider cleanup are terminal. */
export function eventsForSettledSubagentHistory(
  state: Readonly<RuntimeState>,
  historyEvents: readonly RuntimeEvent[],
  reason = 'The previous Subagent execution ended without a terminal presentation event.',
): RuntimeEvent[] {
  const settledToolIds = new Set(failedTerminalToolIds(state));
  for (const invocation of Object.values(state.capabilities.invocations)) {
    if (
      invocation.status === 'unknown' &&
      invocation.subagentProviderLifecycle?.status === 'cleanup_completed' &&
      invocation.subagentProviderLifecycle.cleanupConfirmed === true &&
      invocation.subagentProviderLifecycle.observationStatus !== 'completed'
    ) {
      settledToolIds.add(invocation.toolCallId);
    }
  }
  return settledSubagentHistoryEventsForToolIds(state, historyEvents, settledToolIds, reason);
}

function settledSubagentHistoryEventsForToolIds(
  state: Readonly<RuntimeState>,
  historyEvents: readonly RuntimeEvent[],
  settledToolIds: ReadonlySet<string>,
  reason: string,
): RuntimeEvent[] {
  const unsettledSubagents = new Map<string, string | undefined>();
  for (const event of historyEvents) {
    if (event.type === 'subagent.started') {
      unsettledSubagents.set(event.subagent.id, event.subagent.parentToolCallId);
    }
    if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      unsettledSubagents.delete(event.subagent.id);
    }
  }
  const settledSubagentEvents: RuntimeEvent[] = [];
  for (const [id, parentToolCallId] of unsettledSubagents) {
    // Historical starts did not always carry parentToolCallId. The Provider
    // lifecycle records the exact child invocation id and parent Tool id.
    const matches = Object.values(state.capabilities.invocations).filter(
      (candidate) =>
        candidate.subagentProviderLifecycle?.childInvocationId === id &&
        (parentToolCallId === undefined || candidate.toolCallId === parentToolCallId),
    );
    if (matches.length !== 1) continue;
    const invocation = matches[0]!;
    if (
      invocation.subagentProviderLifecycle?.status !== 'cleanup_completed' ||
      invocation.subagentProviderLifecycle.cleanupConfirmed !== true
    )
      continue;
    if (provenSuccessfulSubagentParent(state, invocation)) {
      const matchingObservation = historyEvents.some(
        (event) =>
          event.type === 'capability.subagent_observation_recorded' &&
          event.invocationId === invocation.invocationId &&
          event.attempt === invocation.subagentProviderLifecycle?.attempt &&
          event.dispatchIntentDigest ===
            invocation.subagentProviderLifecycle.dispatchIntentDigest &&
          event.status === 'completed',
      );
      const matchingSuccess = historyEvents.some(
        (event) =>
          event.type === 'capability.execution_succeeded' &&
          event.invocationId === invocation.invocationId,
      );
      const matchingCleanup = historyEvents.some(
        (event) =>
          event.type === 'capability.subagent_cleanup_completed' &&
          event.invocationId === invocation.invocationId &&
          event.attempt === invocation.subagentProviderLifecycle?.attempt &&
          event.dispatchIntentDigest ===
            invocation.subagentProviderLifecycle.dispatchIntentDigest &&
          event.cleanupConfirmed === true,
      );
      const matchingTool = historyEvents.find(
        (event) =>
          event.type === 'tool.finished' &&
          event.toolCallId === invocation.toolCallId &&
          event.outcome?.status === 'success' &&
          event.result.ok === true,
      );
      if (
        !matchingObservation ||
        !matchingCleanup ||
        !matchingSuccess ||
        !matchingTool ||
        matchingTool.type !== 'tool.finished'
      )
        continue;
      settledSubagentEvents.push({
        type: 'subagent.completed',
        subagent: {
          id,
          summary: 'The Subagent completed before the previous execution ended.',
          toolCallCount: historyEvents.filter(
            (event) => event.type === 'subagent.step' && event.subagent.id === id,
          ).length,
          durationMs: matchingTool.outcome?.timing?.executionMs ?? 0,
        },
      });
      continue;
    }
    // A parent Tool can fail or be cancelled after the child Provider already
    // observed completion. Without the full success receipt, leave that child
    // for inspection rather than rewriting its known outcome as failure.
    if (
      invocation.subagentProviderLifecycle.observationStatus === 'completed' ||
      !settledToolIds.has(invocation.toolCallId)
    )
      continue;
    const parentTool = state.tools.calls[invocation.toolCallId];
    const userCancellationConfirmed =
      parentTool?.status === 'cancelled' &&
      historyEvents.some(
        (event) =>
          event.type === 'turn.aborted' &&
          event.cause === 'user' &&
          event.turnId === parentTool.createdAtTurnId,
      );
    const observed = invocation.subagentProviderLifecycle.observationStatus;
    const failureConfirmed =
      observed === 'failed' ||
      observed === 'exhausted' ||
      historyEvents.some(
        (event) =>
          event.type === 'capability.execution_failed' &&
          event.invocationId === invocation.invocationId,
      );
    const status =
      observed === 'failed' || observed === 'exhausted'
        ? 'failed'
        : observed === 'interrupted'
          ? 'interrupted'
          : userCancellationConfirmed
            ? 'cancelled'
            : failureConfirmed
              ? 'failed'
              : 'interrupted';
    settledSubagentEvents.push({
      type: 'subagent.failed',
      subagent: {
        id,
        error: reason,
        summary:
          status === 'cancelled'
            ? 'The Subagent was cancelled.'
            : status === 'failed'
              ? 'The Subagent failed before the previous execution ended.'
              : 'The previous execution was interrupted.',
        status,
        ...(status === 'failed'
          ? {}
          : { diagnostic: { code: 'aborted' as const, stage: 'terminal_projection' as const } }),
      },
    });
  }
  return settledSubagentEvents;
}

function approvalCancellationEvents(
  state: Readonly<RuntimeState>,
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_tool_approval' }>,
  reason: string,
): RuntimeEvent[] {
  return [
    focusedApprovalRejectionEvent(state, interaction, reason),
    ...approvalRejectedTurnTerminationEvents(state, interaction.toolCallId, reason),
  ];
}

function approvalRejectedTurnTerminationEvents(
  state: Readonly<RuntimeState>,
  rejectedToolCallId: string,
  reason: string,
  alreadyTerminalToolCallIds: ReadonlySet<string> = new Set(),
  turnAlreadyAborted = false,
): RuntimeEvent[] {
  const siblingCancellations = unfinishedToolCancellationEvents(
    state,
    reason,
    rejectedToolCallId,
  ).filter((event) => !alreadyTerminalToolCallIds.has(event.toolCallId));
  const terminalToolCallIds = new Set([
    rejectedToolCallId,
    ...siblingCancellations.map((event) => event.toolCallId),
  ]);
  return [
    ...(alreadyTerminalToolCallIds.has(rejectedToolCallId)
      ? []
      : [
          {
            type: 'tool.rejected' as const,
            toolCallId: rejectedToolCallId,
            reason,
            failure: classifyFailure('approval_rejected', reason),
          },
        ]),
    ...siblingCancellations,
    ...capabilityWaiverEventsForToolTerminals(
      state,
      terminalToolCallIds,
      'User rejected tool approval and waived reconciliation of the abandoned turn.',
    ),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    ...(turnAlreadyAborted || state.turn.status !== 'active'
      ? []
      : [
          {
            type: 'turn.aborted' as const,
            turnId: state.turn.turnId,
            reason,
            cause: 'user' as const,
          },
        ]),
  ];
}

function focusedApprovalRejectionEvent(
  state: Readonly<RuntimeState>,
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_tool_approval' }>,
  reason: string,
): RuntimeEvent {
  const pending = state.pendingApprovals.get(interaction.interactionId);
  return {
    type: 'approval.rejected',
    interactionId: interaction.interactionId,
    toolCallId: interaction.toolCallId,
    generation: pending?.generation ?? state.approvalGeneration,
    owner: pending
      ? runtimeInteractionOwnerForPending(pending)
      : rootToolInteractionOwner(interaction.toolCallId),
    reason,
    failure: classifyFailure('approval_rejected', reason),
  };
}

function eventsForPendingApprovalAction(
  state: Readonly<RuntimeState>,
  action: Extract<RuntimeUserAction, { type: 'approve' | 'reject' }>,
): RuntimeEvent[] | null {
  const pending = state.pendingApprovals.get(action.interactionId);
  if (!pending) return null;
  if (
    state.activeApprovalId !== action.interactionId ||
    pending.status !== 'awaiting_user' ||
    pending.generation !== action.generation
  ) {
    return [];
  }
  if (action.type === 'reject') {
    const reason = action.reason ?? 'Tool approval rejected by user.';
    return [
      {
        type: 'approval.rejected',
        interactionId: pending.interactionId,
        toolCallId: pending.toolCallId,
        generation: pending.generation,
        owner: runtimeInteractionOwnerForPending(pending),
        reason,
        failure: classifyFailure('approval_rejected', reason),
        createdAt: new Date().toISOString(),
      },
    ];
  }
  if (action.grant !== 'approve_once' && action.grant !== 'same_command') {
    return [];
  }
  if (!pending.approval.grantOptions.includes(action.grant)) return [];
  if (action.grant === 'approve_once') {
    return [
      {
        type: 'approval.granted',
        interactionId: pending.interactionId,
        toolCallId: pending.toolCallId,
        grant: 'approve_once',
        receiptId: crypto.randomUUID(),
        generation: pending.generation,
        owner: runtimeInteractionOwnerForPending(pending),
        createdAt: new Date().toISOString(),
      },
    ];
  }
  if (!pending.commandIdentity || !pending.commandKey) return [];
  const matches = [...state.pendingApprovals.values()]
    .filter(
      (candidate) =>
        candidate.commandKey === pending.commandKey &&
        candidate.generation === pending.generation &&
        ['queued_auto', 'auto_reviewing', 'queued_user', 'awaiting_user'].includes(
          candidate.status,
        ),
    )
    .sort((left, right) => left.sequence - right.sequence)
    .map((candidate) => ({
      interactionId: candidate.interactionId,
      toolCallId: candidate.toolCallId,
      receiptId: crypto.randomUUID(),
      generation: candidate.generation,
      owner: runtimeInteractionOwnerForPending(candidate),
      bindingDigest: candidate.bindingDigest,
    }));
  if (!matches.some((candidate) => candidate.interactionId === pending.interactionId)) return [];
  return [
    {
      type: 'approval.batch_released',
      interactionId: pending.interactionId,
      toolCallId: pending.toolCallId,
      grant: 'same_command',
      grantKey: pending.commandKey,
      sessionRevision: state.revision,
      generation: pending.generation,
      owner: runtimeInteractionOwnerForPending(pending),
      commandIdentity: pending.commandIdentity,
      matches,
      cancelledReviewIds: [...state.pendingApprovals.values()]
        .filter(
          (candidate) =>
            candidate.commandKey === pending.commandKey &&
            candidate.generation === pending.generation &&
            candidate.route === 'auto' &&
            (candidate.status === 'queued_auto' || candidate.status === 'auto_reviewing'),
        )
        .map((candidate) => candidate.interactionId),
      createdAt: new Date().toISOString(),
    },
  ];
}

/** 生成取消方案审核时的事件，统一处理显式拒绝和 Esc/取消动作。 */
function planReviewCancelledEvents(
  state: Readonly<RuntimeState>,
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_review' }>,
  reason?: string,
): RuntimeEvent[] {
  const cancellationReason = reason ?? 'Plan execution confirmation cancelled by user.';
  return [
    {
      type: 'plan.review_cancelled',
      interactionId: interaction.interactionId,
      toolCallId: interaction.toolCallId,
      planId: interaction.planId,
      version: interaction.version,
      structuralDigest: interaction.structuralDigest,
      reason: cancellationReason,
    },
    {
      type: 'tool.cancelled',
      toolCallId: interaction.toolCallId,
      reason: cancellationReason,
    },
    ...unfinishedToolCancellationEvents(state, cancellationReason, interaction.toolCallId),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason: cancellationReason,
      cause: 'user',
    },
  ];
}

/** 生成取消用户提问时的工具结果，确保挂起的 ask_user 交互可以继续收敛。 */
function userInputCancelledEvents(
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_user_input' }>,
  reason?: string,
): RuntimeEvent[] {
  return [
    {
      type: 'user_input.cancelled',
      interactionId: interaction.interactionId,
      toolCallId: interaction.toolCallId,
      reason: reason ?? 'User input cancelled by user.',
    },
    {
      type: 'tool.finished',
      toolCallId: interaction.toolCallId,
      name: 'ask_user',
      result: {
        ok: false,
        command: '',
        exitCode: -1,
        stdout: 'Cancelled',
        stderr: reason ?? 'User input cancelled by user.',
        status: 'error',
      },
    },
  ];
}

/** Actions accepted by the Kernel.  They are correlated to exactly one waiting interaction. */
export type RuntimeUserAction =
  | {
      type: 'reconcile_invocation';
      invocationId: string;
      decision: 'confirmed_success' | 'confirmed_failure' | 'waived';
      reason?: string;
    }
  | { type: 'waive_verification'; verificationId: string; reason: string }
  | { type: 'replan_verification'; verificationId: string; instruction: string }
  | { type: 'request_verification_compensation'; verificationId: string }
  | { type: 'input'; interactionId: string; text: string; answers?: Record<string, string> }
  | { type: 'superseded_by_user_input'; interactionId: string }
  | {
      type: 'approve';
      interactionId: string;
      generation: number;
      grant: import('@kite-ai/runtime-contract').ShellApprovalGrant;
    }
  | { type: 'reject'; interactionId: string; generation: number; reason?: string }
  // ── Plan Mode v2: unified plan_review_decision ──
  | {
      type: 'plan_review_decision';
      interactionId: string;
      planId: string;
      version: number;
      structuralDigest: string;
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    }
  | {
      type: 'provider_action_result';
      interactionId: string;
      outcome: 'completed' | 'deferred' | 'failed';
      providerDirectoryRevision?: string;
      failureCode?:
        | 'authentication_failed'
        | 'approval_denied'
        | 'provider_unavailable'
        | 'unknown';
    }
  | {
      type: 'provider_admission_decision';
      interactionId: string;
      decision:
        | {
            kind: 'retry';
            outcome: 'ready';
            providerDirectoryRevision: string;
          }
        | {
            kind: 'retry';
            outcome: 'unavailable';
            providerStatus: import('@kite-ai/builtin-runtime/mcp').McpProviderDirectoryStatus;
            diagnosticCode?: import('@kite-ai/builtin-runtime/mcp').McpProviderDirectoryEntry['diagnosticCode'];
          }
        | { kind: 'waive' }
        | { kind: 'cancel' };
    }
  | { type: 'cancel'; interactionId: string; reason?: string };

export type RuntimeActionResult =
  | { status: 'applied'; events: RuntimeEvent[] }
  | { status: 'stale'; reason: string; telemetry: RuntimeEvent }
  | { status: 'rejected'; reason: string; telemetry: RuntimeEvent };

const NON_TERMINAL_TOOL_STATUSES: ReadonlySet<RuntimeState['tools']['calls'][string]['status']> =
  new Set([
    'queued',
    'approved',
    'authorized_queued',
    'running',
    'awaiting_user_input',
    'awaiting_review',
    'awaiting_approval',
    'awaiting_auto_review',
  ]);

/**
 * Complete a focused approval rejection at the Runtime/Store boundary.
 * `approval.rejected` is the user decision and updates the queue projection,
 * but it is not the terminal Tool fact consumed by lifecycle/replay readers.
 * The settlement is computed before the decision is committed so the whole
 * sequence can be persisted atomically by RuntimeSessionCoordinator.
 */
export function approvalRejectionSettlementEvents(
  state: Readonly<RuntimeState>,
  events: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const rejection = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'approval.rejected' }> =>
      event.type === 'approval.rejected',
  );
  if (!rejection) return [];

  const alreadyTerminalToolCallIds = new Set(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: 'tool.rejected' | 'tool.cancelled' }> =>
          event.type === 'tool.rejected' || event.type === 'tool.cancelled',
      )
      .map((event) => event.toolCallId),
  );
  const turnAlreadyAborted = events.some(
    (event) => event.type === 'turn.aborted' && event.turnId === state.turn.turnId,
  );
  if (turnAlreadyAborted) return [];
  return approvalRejectedTurnTerminationEvents(
    state,
    rejection.toolCallId,
    rejection.reason,
    alreadyTerminalToolCallIds,
    turnAlreadyAborted,
  );
}

/**
 * Repair a restored/legacy State that contains an approval rejection without
 * its turn terminal. Current rejection commands persist sibling cancellation
 * and turn.aborted atomically, so this path must normally be a no-op.
 */
export function deferredApprovalRejectionTurnAbortEvent(
  state: Readonly<RuntimeState>,
): Extract<RuntimeEvent, { type: 'turn.aborted' }> | null {
  if (state.turn.status !== 'active') return null;
  const rejectedApproval = Object.values(state.tools.calls).find(
    (call) =>
      call.status === 'rejected' &&
      call.failure?.kind === 'approval_rejected' &&
      call.createdAtTurnId === state.turn.turnId,
  );
  if (!rejectedApproval) return null;
  const unfinishedTool = Object.values(state.tools.calls).some(
    (call) =>
      NON_TERMINAL_TOOL_STATUSES.has(call.status) && call.createdAtTurnId === state.turn.turnId,
  );
  const unfinishedApproval = [...state.pendingApprovals.values()].some((pending) => {
    const call = state.tools.calls[pending.toolCallId];
    return (
      call?.createdAtTurnId === state.turn.turnId &&
      !['rejected', 'succeeded', 'failed', 'cancelled', 'exhausted'].includes(pending.status)
    );
  });
  if (unfinishedTool || unfinishedApproval) return null;
  return {
    type: 'turn.aborted',
    turnId: state.turn.turnId,
    reason:
      rejectedApproval.error ?? rejectedApproval.failure?.message ?? 'Tool approval rejected.',
    cause: 'user',
  };
}

/** Convert a validated user action to facts.  An invalid action intentionally has no effects. */
export function eventsForRuntimeAction(
  state: RuntimeState,
  action: RuntimeUserAction,
  _options: { sandboxAvailable?: boolean } = {},
): RuntimeEvent[] {
  if (action.type === 'reconcile_invocation') {
    const invocation = state.capabilities.invocations[action.invocationId];
    if (invocation?.status !== 'unknown') return [];
    return [
      {
        type: 'capability.reconciliation_resolved',
        invocationId: action.invocationId,
        decision: action.decision,
        reconciledAt: new Date().toISOString(),
        ...(action.reason ? { reason: action.reason } : {}),
      },
    ];
  }
  if (action.type === 'waive_verification') {
    const record = state.verification.records[action.verificationId];
    if (!record || record.status === 'passed' || !action.reason.trim()) return [];
    return [
      {
        type: 'verification.waived',
        verificationId: action.verificationId,
        actor: 'user',
        reason: action.reason.trim(),
        waivedAt: new Date().toISOString(),
      },
    ];
  }
  if (action.type === 'replan_verification') {
    const record = state.verification.records[action.verificationId];
    if (!record || record.status === 'passed' || !action.instruction.trim()) return [];
    return [
      {
        type: 'verification.replan_requested',
        verificationId: action.verificationId,
        instruction: action.instruction.trim(),
        requestedAt: new Date().toISOString(),
      },
    ];
  }
  if (action.type === 'request_verification_compensation') {
    const record = state.verification.records[action.verificationId];
    if (
      !record?.spec.compensation ||
      !['failed', 'inconclusive', 'budget_exhausted'].includes(record.status)
    )
      return [];
    return [
      {
        type: 'verification.compensation_requested',
        verificationId: action.verificationId,
        requestedAt: new Date().toISOString(),
      },
    ];
  }
  if (action.type === 'approve' || action.type === 'reject') {
    const pendingEvents = eventsForPendingApprovalAction(state, action);
    if (pendingEvents !== null) return pendingEvents;
  }
  const interaction = state.interactions;
  if (interaction.kind === 'idle' || interaction.interactionId !== action.interactionId) return [];

  if (interaction.kind === 'awaiting_user_input') {
    if (action.type === 'cancel') {
      return userInputCancelledEvents(interaction, action.reason);
    }
    if (action.type !== 'input') return [];
    const semanticAnswers =
      action.answers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(action.answers).map(([questionId, value]) => {
              const question = interaction.request.questions?.find(
                (candidate) => candidate.id === questionId,
              );
              return [
                questionId,
                question?.options.find((option) => option.id === value)?.label ?? value,
              ];
            }),
          );
    return [
      {
        type: 'user_input.answered',
        interactionId: action.interactionId,
        toolCallId: interaction.toolCallId,
        answer: action.text,
        ...(action.answers === undefined ? {} : { answers: action.answers }),
      },
      {
        type: 'tool.finished',
        toolCallId: interaction.toolCallId,
        name: 'ask_user',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: JSON.stringify({ answer: action.text, answers: semanticAnswers }),
          stderr: '',
          userInput: {
            answer: action.text,
            ...(semanticAnswers === undefined ? {} : { answers: semanticAnswers }),
          },
        },
      },
    ];
  }

  if (interaction.kind === 'awaiting_tool_approval') {
    if (action.type === 'approve') {
      if (action.grant !== 'approve_once' && action.grant !== 'same_command') return [];
      if (!interaction.approval.grantOptions.includes(action.grant)) return [];
      if (action.grant === 'same_command') return [];
      return [
        {
          type: 'approval.granted',
          interactionId: action.interactionId,
          toolCallId: interaction.toolCallId,
          grant: 'approve_once',
          receiptId: crypto.randomUUID(),
          generation: state.approvalGeneration,
          owner:
            state.pendingApprovals.get(action.interactionId) === undefined
              ? rootToolInteractionOwner(interaction.toolCallId)
              : runtimeInteractionOwnerForPending(
                  state.pendingApprovals.get(action.interactionId)!,
                ),
        },
      ];
    }
    if (action.type === 'reject') {
      const reason = action.reason ?? 'Tool approval rejected by user.';
      return [focusedApprovalRejectionEvent(state, interaction, reason)];
    }
    if (action.type === 'cancel') {
      return approvalCancellationEvents(
        state,
        interaction,
        action.reason ?? 'Tool approval cancelled by user.',
      );
    }
    return [];
  }

  if (interaction.kind === 'awaiting_auto_review') {
    if (action.type !== 'cancel') return [];
    return [
      {
        type: 'tool.cancelled',
        toolCallId: interaction.toolCallId,
        reason: action.reason ?? 'user_cancelled',
      },
    ];
  }

  if (interaction.kind === 'awaiting_provider_action') {
    if (action.type === 'cancel') {
      return [
        {
          type: 'provider.action_deferred',
          interactionId: interaction.interactionId,
          originatingToolCallId: interaction.originatingToolCallId,
        },
      ];
    }
    if (action.type !== 'provider_action_result') return [];
    if (action.outcome === 'completed') {
      return [
        {
          type: 'provider.action_completed',
          interactionId: interaction.interactionId,
          originatingToolCallId: interaction.originatingToolCallId,
          ...(action.providerDirectoryRevision
            ? { providerDirectoryRevision: action.providerDirectoryRevision }
            : {}),
        },
        { type: 'turn.started', turnId: crypto.randomUUID() },
      ];
    }
    if (action.outcome === 'deferred') {
      return [
        {
          type: 'provider.action_deferred',
          interactionId: interaction.interactionId,
          originatingToolCallId: interaction.originatingToolCallId,
        },
      ];
    }
    return [
      {
        type: 'provider.action_failed',
        interactionId: interaction.interactionId,
        originatingToolCallId: interaction.originatingToolCallId,
        failureCode: action.failureCode ?? 'unknown',
      },
    ];
  }

  if (interaction.kind === 'awaiting_provider_admission') {
    const decision =
      action.type === 'cancel'
        ? ({ kind: 'cancel' } as const)
        : action.type === 'provider_admission_decision'
          ? action.decision
          : undefined;
    if (!decision) return [];
    if (decision.kind === 'retry') {
      return decision.outcome === 'ready'
        ? [
            {
              type: 'provider.admission_retry_requested',
              interactionId: interaction.interactionId,
            },
            {
              type: 'provider.admission_satisfied',
              interactionId: interaction.interactionId,
              providerDirectoryRevision: decision.providerDirectoryRevision,
            },
          ]
        : [
            {
              type: 'provider.admission_retry_requested',
              interactionId: interaction.interactionId,
            },
            {
              type: 'provider.admission_retry_failed',
              interactionId: interaction.interactionId,
              providerStatus: decision.providerStatus,
              ...(decision.diagnosticCode ? { diagnosticCode: decision.diagnosticCode } : {}),
            },
          ];
    }
    if (decision.kind === 'waive') {
      return [
        {
          type: 'provider.admission_waived',
          interactionId: interaction.interactionId,
          providerId: interaction.providerId,
          source: interaction.source,
          reason: 'user_session_waiver',
          waivedAt: new Date().toISOString(),
        },
      ];
    }
    const activeTask = getActiveTask(state);
    return [
      {
        type: 'provider.admission_cancelled',
        interactionId: interaction.interactionId,
        providerId: interaction.providerId,
      },
      ...(activeTask
        ? [
            {
              type: 'task.cancelled' as const,
              taskId: activeTask.taskId,
              reason: `Required MCP provider '${interaction.providerId}' admission was cancelled.`,
            },
          ]
        : []),
      {
        type: 'turn.aborted',
        turnId: state.turn.turnId,
        reason: `Required MCP provider '${interaction.providerId}' admission was cancelled.`,
        cause: 'user',
      },
    ];
  }

  // TUI 的 Esc/取消操作使用通用 cancel；Plan 审核需要落成完整的审核取消事件，
  // 否则运行循环会收到空事件并报 Runtime action does not match active interaction。
  if (interaction.kind === 'awaiting_review' && action.type === 'cancel') {
    return planReviewCancelledEvents(state, interaction, action.reason);
  }

  // ── Plan Mode v2: unified plan_review_decision ──
  if (interaction.kind === 'awaiting_review' && action.type === 'plan_review_decision') {
    // Validate planId + version + structuralDigest match
    if (
      action.planId !== interaction.planId ||
      action.version !== interaction.version ||
      action.structuralDigest !== interaction.structuralDigest
    ) {
      return [];
    }
    const { decision } = action;
    if (decision.kind === 'approve') {
      const planning = getActivePlanning(state);
      if (planning.kind !== 'awaiting_review') return [];
      return [
        {
          type: 'plan.approved',
          interactionId: action.interactionId,
          toolCallId: interaction.toolCallId,
          planId: interaction.planId,
          version: interaction.version,
          structuralDigest: interaction.structuralDigest,
          executionMode: decision.nextMode,
        },
        {
          type: 'tool.finished',
          toolCallId: interaction.toolCallId,
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'approved',
              plan_id: interaction.planId,
              version: interaction.version,
              structural_digest: interaction.structuralDigest,
              ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
              execution_mode: decision.nextMode,
            }),
            stderr: '',
          },
        },
      ];
    }
    if (decision.kind === 'revise') {
      return [
        {
          type: 'plan.revision_requested',
          interactionId: action.interactionId,
          toolCallId: interaction.toolCallId,
          planId: interaction.planId,
          version: interaction.version,
          structuralDigest: interaction.structuralDigest,
          feedback: decision.feedback,
        },
        {
          type: 'tool.finished',
          toolCallId: interaction.toolCallId,
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'revision_requested',
              plan_id: interaction.planId,
              version: interaction.version,
              structural_digest: interaction.structuralDigest,
              ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
              feedback: decision.feedback,
            }),
            stderr: '',
          },
        },
      ];
    }
    if (decision.kind === 'cancel') {
      return planReviewCancelledEvents(state, interaction, decision.reason);
    }
    return [];
  }

  return [];
}
