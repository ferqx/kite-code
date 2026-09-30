import { resourceDeadlineMs } from '@kite-ai/runtime-host/kernel-adapter';
import { CHILD_SESSION_TASK_USER_GOAL, sealChildGrantPayload } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import type { KiteChildApprovalProxyRecord } from '@kite-ai/runtime-storage-sqlite';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeState } from '../state-runtime';
import {
  type ChildApprovalRecoveryAction,
  classifyChildApprovalRecovery,
} from './child-approval-proxy';

type ChildIntent = NonNullable<
  ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>
>;

export type ChildFirstTurnRecovery =
  | { readonly kind: 'begin_first_turn' }
  | {
      readonly kind: 'terminal';
      readonly status: NonNullable<
        NonNullable<RuntimeState['childSessionOrigin']>['terminal']
      >['status'];
    }
  | { readonly kind: 'recovery_required'; readonly reason: string };

/** A completed Model response can be reused only at this exact approval boundary. */
export function classifyChildApprovalFirstTurnRecovery(input: {
  readonly childState: Readonly<RuntimeState>;
  readonly parentState: Readonly<RuntimeState>;
  readonly intent: Readonly<ChildIntent>;
  readonly proxy: Readonly<KiteChildApprovalProxyRecord>;
}): ChildApprovalRecoveryAction {
  const { childState: child, parentState: parent, intent, proxy } = input;
  const blocked = (reason: string): ChildApprovalRecoveryAction => ({
    kind: 'recovery_required',
    reason,
  });
  const origin = child.childSessionOrigin;
  if (
    !intent.dispatchAckEventId ||
    !intent.childBudgetActivatedRunId ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId ||
    child.session.threadId !== intent.childThreadId ||
    origin?.parentSessionId !== intent.parentSessionId ||
    origin.parentInvocationId !== intent.parentInvocationId ||
    origin.parentToolCallId !== intent.originToolCallId ||
    origin.attempt !== intent.attempt ||
    origin.childInvocationId !== intent.childInvocationId ||
    origin.grantDigest !== intent.grantDigest ||
    origin.taskArtifactRef.artifactId !== intent.taskArtifactId ||
    origin.taskArtifactRef.integrityIdentifier !== intent.taskArtifactDigest ||
    origin.taskArtifactRef.byteLength !== intent.taskArtifactByteLength ||
    origin.taskArtifactDigest !== intent.taskArtifactDigest ||
    origin.taskTextDigest !== intent.taskTextDigest ||
    origin.role !== intent.role ||
    origin.fundingRunId !== intent.fundingRunId ||
    origin.delegatedReservationId !== intent.delegatedReservationId ||
    origin.delegatedUpperBoundDigest !== intent.delegatedUpperBoundDigest ||
    origin.deadlineAt !== intent.deadlineAt ||
    !origin.taskInputAdmitted ||
    origin.terminal ||
    child.resourceBudget.status !== 'active' ||
    child.resourceBudget.runId !== intent.childBudgetActivatedRunId ||
    child.turn.turnId !== intent.childBudgetActivatedRunId ||
    child.turn.status !== 'active' ||
    child.activeTaskId !== intent.childInvocationId ||
    child.tasks[intent.childInvocationId]?.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
    child.terminalOutcome ||
    proxy.parentSessionId !== intent.parentSessionId ||
    proxy.childThreadId !== intent.childThreadId ||
    proxy.childInvocationId !== intent.childInvocationId ||
    proxy.parentToolCallId !== intent.originToolCallId ||
    proxy.grantDigest !== intent.grantDigest ||
    proxy.childRequestRevision > child.revision
  )
    return blocked('child_approval_activation_or_lineage_changed');
  return classifyChildApprovalRecovery({ parentState: parent, childState: child, proxy });
}

/**
 * Classify only persisted facts. A begun model/tool attempt is never replayed
 * by this classifier, even when its later outcome is still unknown.
 */
export function classifyChildFirstTurnRecovery(input: {
  readonly childState: Readonly<RuntimeState>;
  readonly intent: Readonly<ChildIntent>;
  /** Exact sealed grant read from Store and inspected against current policy by the caller. */
  readonly grant: Readonly<SubagentDelegationGrant>;
  readonly nowMs: number;
  /** Re-proven from the exact parent allotment by the recovery planner. */
  readonly independentTurnDeadline?: boolean;
}): ChildFirstTurnRecovery {
  const { childState: state, intent, grant, nowMs } = input;
  const origin = state.childSessionOrigin;
  const stale = (reason: string): ChildFirstTurnRecovery => ({ kind: 'recovery_required', reason });
  if (
    !origin ||
    state.session.threadId !== intent.childThreadId ||
    origin.parentSessionId !== intent.parentSessionId ||
    origin.parentInvocationId !== intent.parentInvocationId ||
    origin.parentToolCallId !== intent.originToolCallId ||
    origin.attempt !== intent.attempt ||
    origin.childInvocationId !== intent.childInvocationId ||
    origin.grantDigest !== intent.grantDigest ||
    origin.taskArtifactRef.artifactId !== intent.taskArtifactId ||
    origin.taskArtifactRef.integrityIdentifier !== intent.taskArtifactDigest ||
    origin.taskArtifactRef.byteLength !== intent.taskArtifactByteLength ||
    origin.taskArtifactDigest !== intent.taskArtifactDigest ||
    origin.taskTextDigest !== intent.taskTextDigest ||
    origin.role !== intent.role ||
    origin.fundingRunId !== intent.fundingRunId ||
    origin.delegatedReservationId !== intent.delegatedReservationId ||
    origin.delegatedUpperBoundDigest !== intent.delegatedUpperBoundDigest ||
    origin.deadlineAt !== intent.deadlineAt
  )
    return stale('child_origin_mismatch');

  if (origin.terminal) {
    const cleanCancellation =
      origin.terminal.status === 'cancelled' &&
      origin.terminal.cleanupConfirmed &&
      state.turn.status === 'aborted' &&
      state.turn.abortCause === 'user' &&
      !state.terminalOutcome;
    if (
      !origin.terminal.cleanupConfirmed ||
      (!state.terminalOutcome && !cleanCancellation) ||
      (origin.terminal.status === 'completed') !==
        (state.terminalOutcome?.status === 'completed') ||
      state.turn.status === 'active'
    )
      return stale('terminal_seal_incomplete');
    return { kind: 'terminal', status: origin.terminal.status };
  }

  if (
    !intent.childSessionCreated ||
    !intent.childBudgetActivatedRunId ||
    !intent.childBudgetActivatedEventId ||
    !intent.dispatchAckEventId ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId ||
    !origin.taskInputAdmitted ||
    state.resourceBudget.status !== 'active' ||
    state.resourceBudget.runId !== intent.childBudgetActivatedRunId ||
    state.turn.turnId !== intent.childBudgetActivatedRunId ||
    state.turn.status !== 'active' ||
    state.activeTaskId !== intent.childInvocationId ||
    state.tasks[intent.childInvocationId]?.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
    state.tasks[intent.childInvocationId]?.status !== 'active' ||
    state.terminalOutcome ||
    state.recoveryState.kind !== 'normal'
  )
    return stale('child_activation_or_ack_incomplete');

  const sealed = sealChildGrantPayload(grant);
  if (
    grant.purpose !== 'start' ||
    sealed.sealedGrantDigest !== intent.sealedGrantDigest ||
    sealed.sealedGrantByteLength !== intent.sealedGrantByteLength ||
    intent.grantDigest !== intent.sealedGrantDigest ||
    grant.parentInvocationId !== intent.parentInvocationId ||
    grant.parentToolCallId !== intent.originToolCallId ||
    grant.parentAttempt !== intent.attempt ||
    grant.childInvocationId !== intent.childInvocationId ||
    grant.role !== intent.role ||
    grant.taskArtifact.artifactId !== intent.taskArtifactId ||
    grant.taskArtifact.integrityIdentifier !== intent.taskArtifactDigest ||
    grant.taskArtifact.byteLength !== intent.taskArtifactByteLength ||
    grant.taskDigest !== intent.taskTextDigest ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(grant.issuedAtMs) ||
    !Number.isSafeInteger(grant.expiresAtMs) ||
    !Number.isSafeInteger(Date.parse(state.resourceBudget.startedAt)) ||
    Date.parse(state.resourceBudget.startedAt) < grant.issuedAtMs ||
    Date.parse(state.resourceBudget.startedAt) >= grant.expiresAtMs ||
    (input.independentTurnDeadline
      ? state.resourceBudget.budget.unboundedToolInvocations !== true ||
        resourceDeadlineMs(state.resourceBudget.deadlineAt) <= nowMs
      : resourceDeadlineMs(intent.deadlineAt) <= nowMs)
  )
    return stale('sealed_grant_expired_or_mismatch');

  // Gateway commits invocation_prepared before any Provider attempt and
  // invocation_attempt_started before dispatch. Any such record remains a
  // recovery case, including interrupted/prepared records after restart.
  if (
    Object.keys(state.modelInvocations).length > 0 ||
    Object.keys(state.providerReadiness).length > 0 ||
    Object.keys(state.tools.calls).length > 0 ||
    state.tools.queue.length > 0 ||
    Object.keys(state.capabilities.invocations).length > 0 ||
    Object.keys(state.resourceBudget.reservations).length > 0 ||
    Object.keys(state.resourceBudget.waiters).length > 0 ||
    state.transcript.messages.length > 0 ||
    state.interactions.kind !== 'idle' ||
    state.pendingApprovals.size > 0 ||
    Object.keys(state.verification.records).length > 0
  )
    return stale('child_work_or_external_attempt_recorded');

  return { kind: 'begin_first_turn' };
}
