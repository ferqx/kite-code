import { expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import { CHILD_SESSION_TASK_USER_GOAL, sealChildGrantPayload } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import type { KiteSessionAppServerStorageOwner } from '../src/bootstrap/kite-session-app-server-storage';
import { classifyChildFirstTurnRecovery } from '../src/bootstrap/runtime/subagent/child-first-turn-recovery';

type Input = Parameters<typeof classifyChildFirstTurnRecovery>[0];
type Intent = NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>;

function fixture(): Input {
  const nowMs = Date.now();
  const grant = {
    purpose: 'start',
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    parentAttempt: 1,
    childInvocationId: 'child-invocation',
    role: 'review',
    taskArtifact: {
      artifactId: 'task-artifact',
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${'a'.repeat(64)}`,
      byteLength: 24,
    },
    taskDigest: `sha256:${'b'.repeat(64)}`,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
  } as unknown as SubagentDelegationGrant;
  const sealed = sealChildGrantPayload(grant);
  const childThreadId = 'child-session';
  const childRunId = 'child-run';
  const deadlineAt = new Date(nowMs + 60_000).toISOString();
  const intent = {
    childThreadId,
    parentSessionId: 'parent-session',
    parentInvocationId: grant.parentInvocationId,
    originToolCallId: grant.parentToolCallId,
    attempt: grant.parentAttempt,
    childInvocationId: grant.childInvocationId,
    grantDigest: sealed.sealedGrantDigest,
    sealedGrantDigest: sealed.sealedGrantDigest,
    sealedGrantByteLength: sealed.sealedGrantByteLength,
    taskArtifactId: grant.taskArtifact.artifactId,
    taskArtifactByteLength: grant.taskArtifact.byteLength,
    taskArtifactDigest: grant.taskArtifact.integrityIdentifier,
    taskTextDigest: grant.taskDigest,
    role: grant.role,
    fundingRunId: 'parent-run',
    delegatedReservationId: 'parent-reservation',
    delegatedUpperBoundDigest: `sha256:${'c'.repeat(64)}`,
    deadlineAt,
    childSessionCreated: true,
    childBudgetActivatedRunId: childRunId,
    childBudgetActivatedEventId: 'activation-event',
    dispatchAckEventId: 'ack-event',
    failureReceiptDigest: null,
    parentClaimSettledEventId: null,
  } as unknown as Intent;
  const state = createRuntimeHostStateInitialState({
    threadId: childThreadId,
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: '1'.repeat(64),
  });
  state.turn = { turnId: childRunId, turnIndex: 1, status: 'active' };
  state.activeTaskId = grant.childInvocationId;
  state.tasks = {
    [grant.childInvocationId]: {
      taskId: grant.childInvocationId,
      userGoal: CHILD_SESSION_TASK_USER_GOAL,
      status: 'active',
      startedAtTurnId: childRunId,
    } as never,
  };
  state.childSessionOrigin = {
    parentSessionId: intent.parentSessionId,
    parentInvocationId: intent.parentInvocationId,
    parentToolCallId: intent.originToolCallId,
    attempt: intent.attempt,
    childInvocationId: intent.childInvocationId,
    grantDigest: intent.grantDigest,
    taskArtifactRef: grant.taskArtifact,
    taskArtifactDigest: intent.taskArtifactDigest,
    taskTextDigest: intent.taskTextDigest,
    taskInputAdmitted: true,
    role: intent.role,
    fundingRunId: intent.fundingRunId,
    delegatedReservationId: intent.delegatedReservationId,
    delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
    deadlineAt,
  };
  state.resourceBudget = {
    status: 'active',
    runId: childRunId,
    startedAt: new Date(nowMs).toISOString(),
    deadlineAt,
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage('actual', 'test'),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  return { childState: state, intent, grant, nowMs };
}

test('ACK child with no model or tool evidence can begin its first turn', () => {
  expect(classifyChildFirstTurnRecovery(fixture())).toEqual({ kind: 'begin_first_turn' });
});

test('a prepared or dispatching model invocation is never replayed', () => {
  for (const status of ['prepared', 'dispatching', 'interrupted'] as const) {
    const input = fixture();
    expect(
      classifyChildFirstTurnRecovery({
        ...input,
        childState: {
          ...input.childState,
          modelInvocations: { model: { status } as never },
        },
      }),
    ).toEqual({
      kind: 'recovery_required',
      reason: 'child_work_or_external_attempt_recorded',
    });
  }
});

test('an activated child can resume after grant expiry, while missing ACK and Tool activity remain blocked', () => {
  const expired = fixture();
  const grantExpiry = expired.nowMs + 30_000;
  const expiredGrant = { ...expired.grant, expiresAtMs: grantExpiry };
  const resealed = sealChildGrantPayload(expiredGrant);
  const expiredIntent = {
    ...expired.intent,
    grantDigest: resealed.sealedGrantDigest,
    sealedGrantDigest: resealed.sealedGrantDigest,
    sealedGrantByteLength: resealed.sealedGrantByteLength,
  };
  const expiredState = {
    ...expired.childState,
    childSessionOrigin: {
      ...expired.childState.childSessionOrigin!,
      grantDigest: resealed.sealedGrantDigest,
    },
  };
  if (expiredState.resourceBudget.status !== 'active') throw new Error('Missing child budget.');
  expect(
    classifyChildFirstTurnRecovery({
      ...expired,
      grant: expiredGrant,
      intent: expiredIntent,
      childState: expiredState,
      nowMs: grantExpiry,
    }),
  ).toEqual({ kind: 'begin_first_turn' });
  expect(
    classifyChildFirstTurnRecovery({
      ...expired,
      grant: expiredGrant,
      intent: expiredIntent,
      childState: {
        ...expiredState,
        resourceBudget: {
          ...expiredState.resourceBudget,
          startedAt: new Date(grantExpiry).toISOString(),
        },
      },
      nowMs: grantExpiry,
    }),
  ).toMatchObject({ kind: 'recovery_required', reason: 'sealed_grant_expired_or_mismatch' });
  const missingAck = fixture();
  expect(
    classifyChildFirstTurnRecovery({
      ...missingAck,
      intent: { ...missingAck.intent, dispatchAckEventId: null },
    }),
  ).toMatchObject({ kind: 'recovery_required', reason: 'child_activation_or_ack_incomplete' });
  const tool = fixture();
  expect(
    classifyChildFirstTurnRecovery({
      ...tool,
      childState: {
        ...tool.childState,
        tools: { ...tool.childState.tools, calls: { call: { status: 'queued' } as never } },
      },
    }),
  ).toMatchObject({
    kind: 'recovery_required',
    reason: 'child_work_or_external_attempt_recorded',
  });
});

test('missing or altered delegated Task cannot begin first turn', () => {
  const input = fixture();
  expect(
    classifyChildFirstTurnRecovery({
      ...input,
      childState: { ...input.childState, activeTaskId: null },
    }),
  ).toMatchObject({ kind: 'recovery_required', reason: 'child_activation_or_ack_incomplete' });
  expect(
    classifyChildFirstTurnRecovery({
      ...input,
      childState: {
        ...input.childState,
        tasks: {
          ...input.childState.tasks,
          [input.intent.childInvocationId]: {
            ...input.childState.tasks[input.intent.childInvocationId]!,
            userGoal: 'Changed task',
          },
        },
      },
    }),
  ).toMatchObject({ kind: 'recovery_required', reason: 'child_activation_or_ack_incomplete' });
});

test('durably sealed child terminal routes to import without restarting', () => {
  const input = fixture();
  const state = input.childState;
  const terminalOutcome = {
    version: 1,
    status: 'completed',
    reasonCode: 'completed',
    knownExternalEffects: 'none',
    safeRetry: false,
    recoveryEntry: 'none',
    pendingVerification: false,
  } as const;
  const childSessionOrigin = {
    ...state.childSessionOrigin!,
    terminal: {
      status: 'completed' as const,
      resultRef: state.childSessionOrigin!.taskArtifactRef,
      cleanupConfirmed: true,
      cancelRequested: false,
      terminalReceiptId: 'terminal-receipt',
      sealedRevision: 5,
    },
  };
  expect(
    classifyChildFirstTurnRecovery({
      ...input,
      childState: {
        ...state,
        turn: { ...state.turn, status: 'completed' },
        terminalOutcome,
        childSessionOrigin,
      },
    }),
  ).toEqual({ kind: 'terminal', status: 'completed' });
});
