import { assertChildBudgetWithinDelegation } from '@kite-ai/runtime-host/kernel-adapter';
import {
  CHILD_SESSION_TASK_USER_GOAL,
  childDelegatedUpperBoundDigest,
  type RuntimeCommandCommitEvidence,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeSessionCoordinator } from '../RuntimeSessionCoordinator';
import type { RuntimeEvent } from '../state-runtime';
import { childBudgetAtActivation } from './child-delegated-allotment';

type ChildOwner = Pick<
  KiteSessionAppServerStorageOwner,
  | 'createChildSession'
  | 'readChildSessionIntent'
  | 'readChildSealedGrant'
  | 'runWithSessionExecution'
>;

type ChildCreation = Parameters<ChildOwner['createChildSession']>[0];
type ChildBudget = Extract<RuntimeEvent, { type: 'resource_budget.configured' }>['budget'];

/**
 * Finish one accepted parent Task receipt. The returned grant may be handed to
 * Provider.start only after the parent dispatch marker has been re-read.
 */
export function activateAcceptedChildSession(input: {
  readonly owner: ChildOwner;
  readonly parent: Pick<
    RuntimeSessionCoordinator,
    'sessionId' | 'getState' | 'commitChildDispatchAck'
  >;
  readonly ensureChild: () => Pick<
    RuntimeSessionCoordinator,
    'sessionId' | 'getState' | 'commitChildBudgetActivation'
  >;
  readonly creation: ChildCreation;
  readonly childBudget: ChildBudget;
  readonly childDeadlineAt: string;
  readonly childRunId: string;
  readonly evidence: Omit<RuntimeCommandCommitEvidence, 'runStart'>;
  /** The caller validates the signed grant and current policy without consuming it. */
  readonly inspectGrant: (serialized: unknown) => Readonly<SubagentDelegationGrant>;
  readonly startedAt: number;
}): Readonly<SubagentDelegationGrant> {
  const { owner, parent, creation } = input;
  const intended = creation.childSessionIntent;
  if (
    !intended ||
    intended.parentSessionId !== parent.sessionId ||
    (intended.disposition !== 'required' && intended.disposition !== 'after_turn')
  )
    throw new Error('Child activation requires an accepted required parent intent.');
  const intent = owner.readChildSessionIntent(intended.childThreadId);
  if (
    !intent ||
    intent.parentSessionId !== parent.sessionId ||
    intent.childInvocationId !== intended.childInvocationId ||
    intent.grantDigest !== intended.grantDigest ||
    intent.taskArtifactDigest !== intended.taskArtifactDigest ||
    intent.taskTextDigest !== intended.taskTextDigest ||
    intent.delegatedReservationId !== intended.delegatedReservationId ||
    intent.delegatedUpperBoundDigest !== intended.delegatedUpperBoundDigest ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId ||
    intent.dispatchAckEventId
  )
    throw new Error('Child activation has no exact unsettled parent receipt.');
  const sealed = owner.runWithSessionExecution(parent.sessionId, () =>
    owner.readChildSealedGrant(intent.childThreadId),
  );
  if (
    !sealed ||
    sealed.sealedGrantByteLength !== intent.sealedGrantByteLength ||
    sealed.sealedGrantDigest !== intent.sealedGrantDigest ||
    sealed.sealedGrantDigest !== intent.grantDigest
  )
    throw new Error('Child activation sealed grant is unavailable or altered.');
  const grant = input.inspectGrant(JSON.parse(sealed.sealedGrantJson) as unknown);
  const resealed = sealChildGrantPayload(grant);
  if (
    resealed.sealedGrantJson !== sealed.sealedGrantJson ||
    grant.purpose !== 'start' ||
    grant.parentInvocationId !== intent.parentInvocationId ||
    grant.parentToolCallId !== intent.originToolCallId ||
    grant.parentAttempt !== intent.attempt ||
    grant.childInvocationId !== intent.childInvocationId ||
    grant.role !== intent.role ||
    grant.taskDigest !== intent.taskTextDigest ||
    grant.taskArtifact.artifactId !== intent.taskArtifactId ||
    grant.taskArtifact.integrityIdentifier !== intent.taskArtifactDigest ||
    grant.taskArtifact.byteLength !== intent.taskArtifactByteLength ||
    grant.expiresAtMs <= input.startedAt
  )
    throw new Error('Child activation grant tuple or lifetime conflicts.');
  const parentState = parent.getState();
  const ledger =
    parentState.resourceBudget.status === 'active' &&
    parentState.resourceBudget.runId === intent.fundingRunId
      ? parentState.resourceBudget
      : parentState.retainedResourceBudgets[intent.fundingRunId];
  const reservation = ledger?.reservations[intent.delegatedReservationId];
  if (
    reservation?.state !== 'reserved' ||
    childDelegatedUpperBoundDigest(reservation.executableUpperBound) !==
      intent.delegatedUpperBoundDigest ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt < 0 ||
    !input.childRunId
  )
    throw new Error('Child activation has no live finite parent allotment.');
  const independentTurnDeadline =
    reservation.executableUpperBound.independentChildTurnDeadline === true;
  if (
    independentTurnDeadline !== (input.childBudget.unboundedToolInvocations === true) ||
    independentTurnDeadline !== (reservation.executableUpperBound.unboundedToolInvocations === true)
  )
    throw new Error('Child activation budget conflicts with its persisted delegation.');
  const budget = childBudgetAtActivation({
    childBudget: input.childBudget,
    deadlineAt: input.childDeadlineAt,
    startedAt: input.startedAt,
    independentTurnDeadline,
  });
  const startedAt = new Date(input.startedAt).toISOString();
  const deadlineMs = independentTurnDeadline
    ? input.startedAt + budget.maxRunDurationMs
    : Math.min(Date.parse(input.childDeadlineAt), input.startedAt + budget.maxRunDurationMs);
  if (!Number.isSafeInteger(deadlineMs))
    throw new Error('Child activation deadline exceeds the supported clock.');
  const deadlineAt = new Date(deadlineMs).toISOString();
  assertChildBudgetWithinDelegation({
    reservation,
    childBudget: budget,
    childStartedAt: startedAt,
    childDeadlineAt: deadlineAt,
    fundingDeadlineAt: intent.deadlineAt,
    childMaySpawn: false,
    childMayWrite: intent.role === 'code',
  });

  if (!intent.childSessionCreated) owner.createChildSession(creation);
  if (owner.readChildSessionIntent(intent.childThreadId)?.childSessionCreated !== true)
    throw new Error('Child Session creation did not persist.');
  owner.runWithSessionExecution(intent.childThreadId, () => {
    const child = input.ensureChild();
    if (child.sessionId !== intent.childThreadId)
      throw new Error('Child coordinator identity conflicts with the accepted intent.');
    if (intent.childBudgetActivatedRunId) {
      if (intent.childBudgetActivatedRunId !== input.childRunId)
        throw new Error('Child activation replay uses a different Run.');
      return;
    }
    const events: RuntimeEvent[] = [
      {
        type: 'subagent.child_session_adopted',
        parentSessionId: intent.parentSessionId,
        parentInvocationId: intent.parentInvocationId,
        parentToolCallId: intent.originToolCallId,
        attempt: intent.attempt,
        childInvocationId: intent.childInvocationId,
        grantDigest: intent.grantDigest,
        fundingRunId: intent.fundingRunId,
        delegatedReservationId: intent.delegatedReservationId,
        delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
        deadlineAt: intent.deadlineAt,
      },
      {
        type: 'subagent.child_task_input_admitted',
        childInvocationId: intent.childInvocationId,
        taskArtifactRef: intent.taskArtifactRef,
        taskDigest: intent.taskArtifactDigest,
        taskTextDigest: intent.taskTextDigest,
        grantDigest: intent.grantDigest,
      },
      {
        type: 'resource_budget.configured',
        runId: input.childRunId,
        startedAt,
        deadlineAt,
        budget,
      },
      { type: 'turn.started', turnId: input.childRunId },
      {
        type: 'task.started',
        taskId: intent.childInvocationId,
        turnId: input.childRunId,
        userGoal: CHILD_SESSION_TASK_USER_GOAL,
      },
    ];
    child.commitChildBudgetActivation(
      events,
      {
        childThreadId: intent.childThreadId,
        parentSessionId: intent.parentSessionId,
        parentInvocationId: intent.parentInvocationId,
        childInvocationId: intent.childInvocationId,
        grantDigest: intent.grantDigest,
        taskArtifactRef: intent.taskArtifactRef,
        taskArtifactDigest: intent.taskArtifactDigest,
        taskTextDigest: intent.taskTextDigest,
        fundingRunId: intent.fundingRunId,
        delegatedReservationId: intent.delegatedReservationId,
        delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
        childRunId: input.childRunId,
        childMaySpawn: false,
        childMayWrite: intent.role === 'code',
      },
      {
        ...input.evidence,
        targetSessionId: intent.childThreadId,
        scopeSessionId: intent.childThreadId,
        runStart: {
          runId: input.childRunId,
          phase: 'building',
          originSessionId: intent.parentSessionId,
          originRunId: intent.originRunId,
        },
      },
    );
  });
  const activated = owner.readChildSessionIntent(intent.childThreadId);
  if (activated?.childBudgetActivatedRunId !== input.childRunId)
    throw new Error('Child activation did not persist the exact Run.');
  if (!activated.dispatchAckEventId)
    owner.runWithSessionExecution(parent.sessionId, () =>
      parent.commitChildDispatchAck(intent.childThreadId),
    );
  const acknowledged = owner.readChildSessionIntent(intent.childThreadId);
  if (
    acknowledged?.dispatchAckEventId == null ||
    acknowledged.childBudgetActivatedRunId !== input.childRunId ||
    acknowledged.failureReceiptDigest ||
    acknowledged.parentClaimSettledEventId
  )
    throw new Error('Child dispatch ACK is not durable.');
  return grant;
}
