import { createHash, randomBytes } from 'node:crypto';
import {
  createRuntimeHostStateInitialState,
  fundingDeadlineMatches,
  resourceDeadlineMs,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  childDelegatedUpperBoundDigest,
  createRuntimeStoredCommandReceipt,
  type RuntimeChildSessionIntentMutation,
  type RuntimeSessionModelRoute,
} from '@kite-ai/runtime-host/storage';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeState } from '../state-runtime';

type ChildCreation = Parameters<KiteSessionAppServerStorageOwner['createChildSession']>[0];

/** Build the private, atomic Store create input only after the parent receipt exists. */
export function buildChildSessionCreation(input: {
  readonly intent: RuntimeChildSessionIntentMutation;
  readonly parentState: Readonly<RuntimeState>;
  readonly admittedWorkspace: string;
  readonly parentModelRoute: RuntimeSessionModelRoute | null;
  readonly workerInstanceId: string;
  readonly executionClientId: string;
  readonly executionConnectionGeneration: number;
  readonly nowMs: number;
}): ChildCreation {
  const { intent, parentState } = input;
  const parent = parentState.session;
  const ledger =
    parentState.resourceBudget.status === 'active' &&
    parentState.resourceBudget.runId === intent.fundingRunId
      ? parentState.resourceBudget
      : parentState.retainedResourceBudgets[intent.fundingRunId];
  const reservation = ledger?.reservations[intent.delegatedReservationId];
  const deadlineMs = resourceDeadlineMs(intent.deadlineAt);
  const independentTurnDeadline =
    reservation?.executableUpperBound.independentChildTurnDeadline === true;
  if (
    (intent.disposition !== 'required' && intent.disposition !== 'after_turn') ||
    parent.threadId !== intent.parentSessionId ||
    !parent.projectId ||
    !parent.canonicalWorkspaceDigest ||
    parent.workspace !== input.admittedWorkspace ||
    !input.parentModelRoute?.provider.trim() ||
    !input.parentModelRoute.name.trim() ||
    !input.workerInstanceId.trim() ||
    !input.executionClientId.trim() ||
    !Number.isSafeInteger(input.executionConnectionGeneration) ||
    input.executionConnectionGeneration < 1 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    (intent.deadlineAt !== null && !Number.isSafeInteger(deadlineMs)) ||
    (!independentTurnDeadline && deadlineMs <= input.nowMs) ||
    (independentTurnDeadline &&
      (reservation?.reservationId !== `child-allotment:${intent.childThreadId}` ||
        reservation.executableUpperBound.unboundedToolInvocations !== true)) ||
    !ledger ||
    !fundingDeadlineMatches(ledger, intent.deadlineAt) ||
    (reservation?.state !== 'reserved' && reservation?.state !== 'queued') ||
    reservation.runId !== intent.fundingRunId ||
    reservation.invocationId !== `child-allotment:${intent.childThreadId}` ||
    childDelegatedUpperBoundDigest(reservation.executableUpperBound) !==
      intent.delegatedUpperBoundDigest
  )
    throw new Error('Child Session creation lacks exact admitted parent authority.');
  const sealedBytes = Buffer.from(intent.sealedGrantJson, 'utf8');
  if (
    sealedBytes.byteLength !== intent.sealedGrantByteLength ||
    `sha256:${createHash('sha256').update(sealedBytes).digest('hex')}` !==
      intent.sealedGrantDigest ||
    intent.grantDigest !== intent.sealedGrantDigest
  )
    throw new Error('Child Session creation has an altered sealed grant.');

  const recoveryIdentity = randomBytes(32).toString('hex');
  const childState: RuntimeState = {
    ...createRuntimeHostStateInitialState({
      threadId: intent.childThreadId,
      userId: parent.userId,
      workspace: parent.workspace,
      projectId: parent.projectId,
      canonicalWorkspaceDigest: parent.canonicalWorkspaceDigest,
      recoveryIdentityKey: recoveryIdentity,
      interactionMode: parentState.mode,
    }),
    childSessionOrigin: {
      parentSessionId: intent.parentSessionId,
      parentInvocationId: intent.parentInvocationId,
      parentToolCallId: intent.originToolCallId,
      attempt: intent.attempt,
      childInvocationId: intent.childInvocationId,
      grantDigest: intent.grantDigest,
      taskArtifactRef: intent.taskArtifactRef,
      taskArtifactDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
      role: intent.role,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
      deadlineAt: intent.deadlineAt,
    },
  };
  const commandId = `create-child:${intent.childThreadId}`;
  const requestDigest = createHash('sha256')
    .update(
      JSON.stringify(['kite.child-session-create.v1', intent.childThreadId, intent.grantDigest]),
    )
    .digest('hex');
  const expiryMs = independentTurnDeadline
    ? input.nowMs + 60_000
    : Math.min(deadlineMs, input.nowMs + 60_000);
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= input.nowMs)
    throw new Error('Child Session controller lease has no live deadline.');
  return {
    childSessionIntent: intent,
    runtime: {
      sessionId: intent.childThreadId,
      events: [],
      snapshot: childState,
      sessionModelRoute: input.parentModelRoute,
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: intent.childThreadId,
          commandId,
          requestDigest,
          targetSessionId: intent.childThreadId,
          committedAt: input.nowMs,
        },
        0,
      ),
    },
    controller: {
      sessionId: intent.childThreadId,
      requestId: `${commandId}:controller`,
      requestDigest,
      clientId: input.executionClientId,
      connectionGeneration: input.executionConnectionGeneration,
      workerInstanceId: input.workerInstanceId,
      resumeSecret: randomBytes(32).toString('base64url'),
      resumeExpiresAtMs: expiryMs,
      executionLeaseUntilMs: expiryMs,
    },
    recoveryIdentity,
  };
}
