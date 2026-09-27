import { fundingBudgetForRun } from '@kite-ai/runtime-host/kernel-adapter';
import {
  childDelegatedUpperBoundDigest,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeState } from '../state-runtime';
import { recoverChildDelegatedBudget } from './child-budget-recovery';
import {
  classifyChildApprovalFirstTurnRecovery,
  classifyChildFirstTurnRecovery,
} from './child-first-turn-recovery';

type Intent = NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>;
type Budget = ReturnType<typeof recoverChildDelegatedBudget>;

export type ChildSessionRecoveryAction =
  | { readonly kind: 'create_child'; readonly intent: Intent; readonly budget: Budget }
  | { readonly kind: 'activate_child'; readonly intent: Intent; readonly budget: Budget }
  | { readonly kind: 'ack_dispatch'; readonly intent: Intent }
  | { readonly kind: 'begin_first_turn'; readonly intent: Intent }
  | { readonly kind: 'resume_current_turn_model'; readonly intent: Intent }
  | {
      readonly kind: 'resume_approval';
      readonly intent: Intent;
      readonly proxyInteractionId: string;
    }
  | { readonly kind: 'reconcile_unknown_child'; readonly intent: Intent }
  | { readonly kind: 'abandon_stopped_child'; readonly intent: Intent }
  | { readonly kind: 'abandon_unstartable_child'; readonly intent: Intent }
  | { readonly kind: 'cancel_acknowledged_child'; readonly intent: Intent }
  | { readonly kind: 'import_terminal'; readonly intent: Intent }
  | { readonly kind: 'recovery_required'; readonly intent: Intent; readonly reason: string };

/** A bounded, read-only parent sweep. The caller supplies an exact parent-scoped sealed-grant read. */
export function planChildSessionRecovery(input: {
  readonly parentSessionId: string;
  readonly parentState: Readonly<RuntimeState>;
  readonly listPending: KiteSessionAppServerStorageOwner['listPendingChildSessionIntents'];
  readonly readIntent: KiteSessionAppServerStorageOwner['readChildSessionIntent'];
  readonly readSealedGrant: KiteSessionAppServerStorageOwner['readChildSealedGrant'];
  readonly readChildState: (childThreadId: string) => Readonly<RuntimeState> | null;
  readonly readChildApprovalProxy?: KiteSessionAppServerStorageOwner['readChildApprovalProxy'];
  readonly childApprovalProxyId: KiteSessionAppServerStorageOwner['childApprovalProxyId'];
  readonly readParentCommandReceipt?: KiteSessionAppServerStorageOwner['storage']['commandReceipts']['lookup'];
  /** Must reflect the current Store Run status, not a cached parent turn. */
  readonly isParentRunLive: (runId: string) => boolean;
  /** A nonrequired child may start while its original Run is durably completed. */
  readonly isAfterTurnOriginCompleted?: (runId: string) => boolean;
  /** A durable stop request blocks new child dispatch even after its stop receipt is settled. */
  readonly hasStopRequest?: (childInvocationId: string) => boolean;
  /** Read-only target Event check; the action must obtain a fenced Store proof before dispatch. */
  readonly hasPreparedCurrentTurnRoute?: (childThreadId: string) => boolean;
  /** Must validate signature, expiry, and current policy without consuming the start grant. */
  readonly inspectGrant: (value: unknown) => Readonly<SubagentDelegationGrant>;
  readonly nowMs: number;
  readonly limit: number;
  readonly cursor?: string;
}): { readonly actions: readonly ChildSessionRecoveryAction[]; readonly nextCursor?: string } {
  if (input.parentState.session.threadId !== input.parentSessionId)
    throw new Error('Child recovery parent scope differs from parent State.');
  const page = input.listPending(input.parentSessionId, input.limit, input.cursor);
  const actions = page.entries.map((listed): ChildSessionRecoveryAction => {
    const intent = input.readIntent(listed.childThreadId);
    const required = (reason: string): ChildSessionRecoveryAction => ({
      kind: 'recovery_required',
      intent: listed,
      reason,
    });
    if (
      !intent ||
      intent.parentSessionId !== input.parentSessionId ||
      JSON.stringify(intent) !== JSON.stringify(listed) ||
      intent.failureReceiptDigest ||
      intent.parentClaimSettledEventId ||
      (intent.disposition !== 'required' && intent.disposition !== 'after_turn')
    )
      return required('intent_changed_or_settled');
    const abandonIfReserved = (reason: string): ChildSessionRecoveryAction => {
      const reservation = fundingBudgetForRun(input.parentState, intent.fundingRunId)?.reservations[
        intent.delegatedReservationId
      ];
      return !intent.dispatchAckEventId &&
        (reservation?.state === 'reserved' || reservation?.state === 'queued')
        ? { kind: 'abandon_unstartable_child', intent }
        : required(reason);
    };
    const funding = fundingBudgetForRun(input.parentState, intent.fundingRunId);
    const reservation = funding?.reservations[intent.delegatedReservationId];
    const independentTurnDeadline =
      intent.fundingRunId === intent.originRunId &&
      reservation?.reservationId === `child-allotment:${intent.childThreadId}` &&
      reservation.invocationId === reservation.reservationId &&
      reservation.resourceKind === 'subagent' &&
      (reservation.state === 'reserved' ||
        reservation.state === 'queued' ||
        reservation.state === 'dispatch_started') &&
      reservation.executableUpperBound.independentChildTurnDeadline === true &&
      reservation.executableUpperBound.unboundedToolInvocations === true &&
      funding?.deadlineAt === intent.deadlineAt &&
      childDelegatedUpperBoundDigest(reservation.executableUpperBound) ===
        intent.delegatedUpperBoundDigest &&
      !(
        input.parentState.turn.turnId === intent.originRunId &&
        input.parentState.turn.abortCause === 'user'
      );
    const child = input.readChildState(intent.childThreadId);
    if (Boolean(child) !== intent.childSessionCreated) return required('child_presence_mismatch');
    if (child?.childSessionOrigin?.terminal) {
      if (!intent.dispatchAckEventId) return required('terminal_without_dispatch_ack');
      const origin = child.childSessionOrigin;
      const terminal = origin.terminal!;
      const unknownRecovery = terminal.status === 'unknown' && terminal.cleanupConfirmed === false;
      const cleanCancellation =
        terminal.status === 'cancelled' &&
        terminal.cleanupConfirmed &&
        child.turn.status === 'aborted' &&
        child.turn.abortCause === 'user' &&
        !child.terminalOutcome;
      if (
        child.session.threadId !== intent.childThreadId ||
        origin.parentSessionId !== intent.parentSessionId ||
        origin.parentInvocationId !== intent.parentInvocationId ||
        origin.parentToolCallId !== intent.originToolCallId ||
        origin.attempt !== intent.attempt ||
        origin.childInvocationId !== intent.childInvocationId ||
        origin.grantDigest !== intent.grantDigest ||
        origin.taskArtifactRef.artifactId !== intent.taskArtifactId ||
        origin.taskArtifactRef.integrityIdentifier !== intent.taskArtifactDigest ||
        origin.taskTextDigest !== intent.taskTextDigest ||
        origin.role !== intent.role ||
        origin.fundingRunId !== intent.fundingRunId ||
        origin.delegatedReservationId !== intent.delegatedReservationId ||
        origin.delegatedUpperBoundDigest !== intent.delegatedUpperBoundDigest ||
        !origin.taskInputAdmitted ||
        child.resourceBudget.status !== 'active' ||
        (!terminal.cleanupConfirmed && !unknownRecovery) ||
        (!child.terminalOutcome && !cleanCancellation) ||
        child.turn.status === 'active' ||
        (unknownRecovery &&
          (child.terminalOutcome?.status !== 'unknown' ||
            child.terminalOutcome?.knownExternalEffects !== 'unknown')) ||
        (terminal.status === 'completed') !== (child.terminalOutcome?.status === 'completed')
      )
        return required('terminal_seal_incomplete');
      return { kind: 'import_terminal', intent };
    }
    if (child && intent.dispatchAckEventId && !input.hasStopRequest?.(intent.childInvocationId)) {
      const approvalCandidates = [...child.pendingApprovals.values()].filter((approval) => {
        const tool = child.tools.calls[approval.toolCallId];
        return (
          tool?.status === 'awaiting_approval' ||
          tool?.status === 'authorized_queued' ||
          tool?.status === 'rejected'
        );
      });
      if (approvalCandidates.length > 1) return required('multiple_child_approvals');
      const approval = approvalCandidates[0];
      if (approval) {
        const proxyInteractionId = input.childApprovalProxyId({
          childThreadId: intent.childThreadId,
          childInteractionId: approval.interactionId,
          childGeneration: approval.generation,
        });
        const proxy = input.readChildApprovalProxy?.(intent.parentSessionId, proxyInteractionId);
        if (!proxy) return required('child_approval_proxy_unavailable');
        const classified = classifyChildApprovalFirstTurnRecovery({
          childState: child,
          parentState: input.parentState,
          intent,
          proxy,
        });
        if (classified.kind === 'recovery_required') return required(classified.reason);
        if (proxy.status === 'decided' || proxy.status === 'applied') {
          if (
            !proxy.parentCommandId ||
            !proxy.parentCommandDigest ||
            proxy.parentDecisionRevision === null ||
            proxy.parentDecisionRevision > input.parentState.revision
          )
            return required('child_approval_parent_receipt_missing');
          const lookup = input.readParentCommandReceipt?.({
            scopeSessionId: intent.parentSessionId,
            commandId: proxy.parentCommandId,
            requestDigest: proxy.parentCommandDigest,
          });
          if (
            lookup?.status !== 'replay' ||
            lookup.receipt.targetSessionId !== intent.parentSessionId ||
            lookup.receipt.committedRevision !== proxy.parentDecisionRevision
          )
            return required('child_approval_parent_receipt_changed');
        }
        return { kind: 'resume_approval', intent, proxyInteractionId };
      }
    }
    const externalAttempt = Boolean(
      child &&
        intent.dispatchAckEventId &&
        intent.childBudgetActivatedRunId &&
        child.childSessionOrigin?.parentSessionId === intent.parentSessionId &&
        child.childSessionOrigin.childInvocationId === intent.childInvocationId &&
        child.childSessionOrigin.grantDigest === intent.grantDigest &&
        child.childSessionOrigin.taskInputAdmitted &&
        child.resourceBudget.status === 'active' &&
        (Object.values(child.modelInvocations).some(
          (invocation) =>
            invocation.dispatchCertainty === 'attempted' ||
            invocation.dispatchCertainty === 'unknown',
        ) ||
          Object.values(child.tools.calls).some((call) => call.status === 'running')),
    );
    if (input.hasStopRequest?.(intent.childInvocationId))
      return !intent.dispatchAckEventId
        ? { kind: 'abandon_stopped_child', intent }
        : externalAttempt
          ? { kind: 'reconcile_unknown_child', intent }
          : child &&
              child.revision === 5 &&
              child.turn.status === 'active' &&
              child.activeTaskId === intent.childInvocationId &&
              Object.keys(child.modelInvocations).length === 0 &&
              Object.keys(child.tools.calls).length === 0 &&
              Object.keys(child.capabilities.invocations).length === 0
            ? { kind: 'cancel_acknowledged_child', intent }
            : required('child_stop_requested_after_ack');
    if (externalAttempt) return { kind: 'reconcile_unknown_child', intent };
    if (
      !input.isParentRunLive(intent.originRunId) &&
      !independentTurnDeadline &&
      !(
        intent.disposition === 'after_turn' &&
        input.isAfterTurnOriginCompleted?.(intent.originRunId) === true
      )
    )
      return abandonIfReserved('parent_run_not_live');
    let grant: Readonly<SubagentDelegationGrant>;
    try {
      const sealed = input.readSealedGrant(intent.childThreadId);
      if (
        !sealed ||
        sealed.sealedGrantDigest !== intent.sealedGrantDigest ||
        sealed.sealedGrantByteLength !== intent.sealedGrantByteLength
      )
        return abandonIfReserved('sealed_grant_unavailable');
      grant = input.inspectGrant(JSON.parse(sealed.sealedGrantJson) as unknown);
      const resealed = sealChildGrantPayload(grant);
      if (
        resealed.sealedGrantJson !== sealed.sealedGrantJson ||
        grant.purpose !== 'start' ||
        grant.expiresAtMs <= input.nowMs ||
        grant.parentInvocationId !== intent.parentInvocationId ||
        grant.parentToolCallId !== intent.originToolCallId ||
        grant.parentAttempt !== intent.attempt ||
        grant.childInvocationId !== intent.childInvocationId ||
        grant.role !== intent.role ||
        grant.taskDigest !== intent.taskTextDigest ||
        grant.taskArtifact.artifactId !== intent.taskArtifactId ||
        grant.taskArtifact.integrityIdentifier !== intent.taskArtifactDigest ||
        grant.taskArtifact.byteLength !== intent.taskArtifactByteLength ||
        intent.grantDigest !== intent.sealedGrantDigest
      )
        return abandonIfReserved('sealed_grant_expired_or_mismatch');
    } catch {
      return abandonIfReserved('sealed_grant_unavailable_or_policy_changed');
    }
    if (child && intent.childBudgetActivatedRunId && intent.dispatchAckEventId) {
      const reservation = fundingBudgetForRun(input.parentState, intent.fundingRunId)?.reservations[
        intent.delegatedReservationId
      ];
      if (reservation?.state !== 'dispatch_started')
        return required('acknowledged_parent_allotment_changed');
      if (input.hasPreparedCurrentTurnRoute?.(intent.childThreadId)) {
        const prepared = Object.values(child.modelInvocations).filter(
          (model) => model.status === 'prepared' && model.attempts === 0,
        );
        if (
          prepared.length === 1 &&
          child.turn.turnId === intent.childBudgetActivatedRunId &&
          child.turn.status === 'active' &&
          child.activeTaskId === intent.childInvocationId &&
          !child.activeFollowupTurn
        )
          return { kind: 'resume_current_turn_model', intent };
        return required('current_turn_model_not_safely_prepared');
      }
      const firstTurn = classifyChildFirstTurnRecovery({
        childState: child,
        intent,
        grant,
        nowMs: input.nowMs,
        independentTurnDeadline,
      });
      if (firstTurn.kind === 'terminal') return { kind: 'import_terminal', intent };
      if (firstTurn.kind === 'begin_first_turn') return { kind: 'begin_first_turn', intent };
      return required(firstTurn.reason);
    }
    let budget: Budget;
    try {
      budget = recoverChildDelegatedBudget({
        intent,
        parentState: input.parentState,
        grantIssuedAtMs: grant.issuedAtMs,
        nowMs: input.nowMs,
      });
    } catch {
      return required('delegated_budget_unavailable');
    }
    if (!child) {
      if (intent.childBudgetActivatedRunId || intent.dispatchAckEventId)
        return required('missing_activated_child');
      return { kind: 'create_child', intent, budget };
    }
    if (!intent.childBudgetActivatedRunId || !intent.childBudgetActivatedEventId) {
      if (
        intent.dispatchAckEventId ||
        child.revision !== 0 ||
        child.resourceBudget.status !== 'unconfigured' ||
        child.childSessionOrigin?.taskInputAdmitted ||
        child.childSessionOrigin?.parentSessionId !== intent.parentSessionId ||
        child.childSessionOrigin?.childInvocationId !== intent.childInvocationId ||
        Object.keys(child.modelInvocations).length > 0 ||
        Object.keys(child.tools.calls).length > 0
      )
        return required('unactivated_child_state_changed');
      return { kind: 'activate_child', intent, budget };
    }
    const firstTurn = classifyChildFirstTurnRecovery({
      childState: child,
      intent: intent.dispatchAckEventId
        ? intent
        : { ...intent, dispatchAckEventId: 'recovery-check' },
      grant,
      nowMs: input.nowMs,
      independentTurnDeadline,
    });
    if (firstTurn.kind === 'recovery_required') return required(firstTurn.reason);
    if (firstTurn.kind === 'terminal') return { kind: 'import_terminal', intent };
    return { kind: 'ack_dispatch', intent };
  });
  return { actions, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}
