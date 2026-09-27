import { expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import { CHILD_SESSION_TASK_USER_GOAL, sealChildGrantPayload } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import {
  HiddenChildInteractionUnavailableError,
  hiddenChildActionProvider,
  runAcceptedChildSession,
} from '../src/bootstrap/runtime/subagent/child-session-runner';

type RunnerInput = Parameters<typeof runAcceptedChildSession>[0];

function fixture(ack = true, grantLifetimeMs = 60_000) {
  const calls: string[] = [];
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
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 24,
    },
    taskDigest: `sha256:${'c'.repeat(64)}`,
    capabilityCeiling: { allowedTools: ['read_file'] },
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + grantLifetimeMs,
  } as unknown as SubagentDelegationGrant;
  const sealed = sealChildGrantPayload(grant);
  const descriptor: RunnerInput['descriptor'] = {
    sessionId: 'child-session',
    committedRevision: 5,
    childRunId: 'child-run',
    parentSessionId: 'parent-session',
    parentInvocationId: grant.parentInvocationId,
    parentToolCallId: grant.parentToolCallId,
    attempt: grant.parentAttempt,
    childInvocationId: grant.childInvocationId,
    grantDigest: sealed.sealedGrantDigest,
    taskArtifactId: grant.taskArtifact.artifactId,
    taskArtifactByteLength: grant.taskArtifact.byteLength,
    taskArtifactDigest: grant.taskArtifact.integrityIdentifier,
    taskTextDigest: grant.taskDigest,
    fundingRunId: 'parent-run',
    delegatedReservationId: 'parent-reservation',
    delegatedUpperBoundDigest: `sha256:${'d'.repeat(64)}`,
  };
  const state = createRuntimeHostStateInitialState({
    threadId: descriptor.sessionId,
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: '1'.repeat(64),
  });
  state.revision = descriptor.committedRevision;
  state.turn = { turnId: descriptor.childRunId, turnIndex: 1, status: 'active' };
  state.activeTaskId = descriptor.childInvocationId;
  state.tasks = {
    [descriptor.childInvocationId]: {
      taskId: descriptor.childInvocationId,
      userGoal: CHILD_SESSION_TASK_USER_GOAL,
      status: 'active',
      startedAtTurnId: descriptor.childRunId,
      sideEffectsStarted: false,
      planning: { kind: 'building_without_plan' },
      planHistory: [],
    },
  };
  state.childSessionOrigin = {
    parentSessionId: descriptor.parentSessionId,
    parentInvocationId: descriptor.parentInvocationId,
    parentToolCallId: descriptor.parentToolCallId,
    attempt: descriptor.attempt,
    childInvocationId: descriptor.childInvocationId,
    grantDigest: descriptor.grantDigest,
    taskArtifactRef: grant.taskArtifact,
    taskArtifactDigest: descriptor.taskArtifactDigest,
    taskTextDigest: descriptor.taskTextDigest,
    taskInputAdmitted: true,
    role: grant.role,
    fundingRunId: descriptor.fundingRunId,
    delegatedReservationId: descriptor.delegatedReservationId,
    delegatedUpperBoundDigest: descriptor.delegatedUpperBoundDigest,
    deadlineAt: new Date(nowMs + 60_000).toISOString(),
  };
  state.resourceBudget = {
    status: 'active',
    runId: descriptor.childRunId,
    startedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + 60_000).toISOString(),
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage('actual', 'test'),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  const intent = {
    childSessionCreated: true,
    childThreadId: descriptor.sessionId,
    childBudgetActivatedRunId: descriptor.childRunId,
    childBudgetActivatedEventId: 'activation-event',
    dispatchAckEventId: ack ? 'durable-ack' : null,
    failureReceiptDigest: null,
    parentClaimSettledEventId: null,
    grantDigest: sealed.sealedGrantDigest,
    sealedGrantDigest: sealed.sealedGrantDigest,
    sealedGrantByteLength: sealed.sealedGrantByteLength,
    parentSessionId: descriptor.parentSessionId,
    parentInvocationId: descriptor.parentInvocationId,
    originToolCallId: descriptor.parentToolCallId,
    attempt: descriptor.attempt,
    childInvocationId: descriptor.childInvocationId,
    taskArtifactId: descriptor.taskArtifactId,
    taskArtifactByteLength: descriptor.taskArtifactByteLength,
    taskArtifactDigest: descriptor.taskArtifactDigest,
    taskTextDigest: descriptor.taskTextDigest,
    fundingRunId: descriptor.fundingRunId,
    delegatedReservationId: descriptor.delegatedReservationId,
    delegatedUpperBoundDigest: descriptor.delegatedUpperBoundDigest,
    role: grant.role,
    deadlineAt: state.childSessionOrigin.deadlineAt,
  };
  const input = {
    owner: { readChildSessionIntent: () => intent },
    child: {
      sessionId: descriptor.sessionId,
      getState: () => state,
      session: {
        activateRun: (runId: string) => {
          expect(runId).toBe(descriptor.childRunId);
          calls.push('activate');
        },
        getLifecycleProjection: () => ({ currentRun: { runId: descriptor.childRunId } }),
      },
      executeTurn: async function* (turn: unknown, provider: unknown) {
        calls.push('execute');
        expect(turn).toMatchObject({
          task: '',
          precommittedChildActivation: descriptor,
          childToolCeiling: {
            grantDigest: descriptor.grantDigest,
            role: 'review',
            allowedTools: ['read_file'],
          },
        });
        expect(provider).toBe(hiddenChildActionProvider);
        yield { type: 'turn.completed' };
      },
    },
    descriptor,
    grant,
    turn: { threadId: descriptor.sessionId },
    consumeStartGrant: (value: SubagentDelegationGrant) => {
      calls.push('consume');
      return value;
    },
  } as unknown as RunnerInput;
  return { input, calls };
}

test('fenced activated first turn survives grant expiry without consuming it again', async () => {
  const { input, calls } = fixture(true, 1_000);
  const events = [];
  for await (const event of runAcceptedChildSession({
    ...input,
    now: () => input.grant.expiresAtMs + 1,
    activatedRecovery: { independentTurnDeadline: false },
  }))
    events.push(event);
  expect(events).toHaveLength(1);
  expect(calls).toEqual(['activate', 'execute']);
});

test('hidden child begins only after durable ACK and exact sealed grant consumption', async () => {
  const { input, calls } = fixture(true);
  const events = [];
  for await (const event of runAcceptedChildSession(input)) events.push(event);
  expect(events).toHaveLength(1);
  expect(calls).toEqual(['activate', 'consume', 'execute']);
});

test('an expired grant cannot start a fresh child without the activated recovery path', async () => {
  const { input, calls } = fixture(true, 1_000);
  const attempt = (async () => {
    for await (const _event of runAcceptedChildSession({
      ...input,
      now: () => input.grant.expiresAtMs + 1,
    }))
      void _event;
  })();
  await expect(attempt).rejects.toThrow('durable dispatch ACK and grant');
  expect(calls).toEqual([]);
});

test('missing parent dispatch ACK prevents grant consumption and child execution', async () => {
  const { input, calls } = fixture(false);
  const attempt = (async () => {
    for await (const _event of runAcceptedChildSession(input)) void _event;
  })();
  await expect(attempt).rejects.toThrow('durable dispatch ACK');
  expect(calls).toEqual([]);
});

test('hidden child interaction provider rejects promptly without synthesizing an approval', async () => {
  const action = hiddenChildActionProvider.requestAction(
    { type: 'request_tool_approval', interactionId: 'approval' } as Parameters<
      typeof hiddenChildActionProvider.requestAction
    >[0],
    {} as Parameters<typeof hiddenChildActionProvider.requestAction>[1],
    {} as Parameters<typeof hiddenChildActionProvider.requestAction>[2],
  );
  await expect(action).rejects.toBeInstanceOf(HiddenChildInteractionUnavailableError);
});
