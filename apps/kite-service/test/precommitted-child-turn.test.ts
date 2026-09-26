import { expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  assertPrecommittedChildActivation,
  type PrecommittedChildActivationDescriptor,
} from '../src/bootstrap/runtime/turn-coordinator';

function fixture() {
  const descriptor: PrecommittedChildActivationDescriptor = {
    sessionId: 'child-session',
    committedRevision: 5,
    childRunId: 'child-run',
    parentSessionId: 'parent-session',
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    attempt: 1,
    childInvocationId: 'child-invocation',
    grantDigest: `sha256:${'a'.repeat(64)}`,
    taskArtifactId: 'task-artifact',
    taskArtifactByteLength: 24,
    taskArtifactDigest: `sha256:${'b'.repeat(64)}`,
    taskTextDigest: `sha256:${'c'.repeat(64)}`,
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
      userGoal: 'Complete the delegated task.',
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
    taskArtifactRef: {
      artifactId: descriptor.taskArtifactId,
      kind: 'subagent_task',
      integrityIdentifier: descriptor.taskArtifactDigest,
      byteLength: descriptor.taskArtifactByteLength,
    },
    taskArtifactDigest: descriptor.taskArtifactDigest,
    taskTextDigest: descriptor.taskTextDigest,
    taskInputAdmitted: true,
    role: 'review',
    fundingRunId: descriptor.fundingRunId,
    delegatedReservationId: descriptor.delegatedReservationId,
    delegatedUpperBoundDigest: descriptor.delegatedUpperBoundDigest,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  state.resourceBudget = {
    status: 'active',
    runId: descriptor.childRunId,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage('actual', 'test'),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  return { descriptor, state };
}

test('first child turn accepts only the exact activated child State and Run', () => {
  const { descriptor, state } = fixture();
  expect(() =>
    assertPrecommittedChildActivation(
      state,
      descriptor,
      descriptor.sessionId,
      descriptor.childRunId,
    ),
  ).not.toThrow();
  for (const changed of [
    { ...descriptor, committedRevision: descriptor.committedRevision - 1 },
    { ...descriptor, childRunId: 'other-run' },
    { ...descriptor, grantDigest: `sha256:${'e'.repeat(64)}` },
    { ...descriptor, taskTextDigest: `sha256:${'f'.repeat(64)}` },
    { ...descriptor, delegatedReservationId: 'other-reservation' },
  ]) {
    expect(() =>
      assertPrecommittedChildActivation(
        state,
        changed,
        descriptor.sessionId,
        descriptor.childRunId,
      ),
    ).toThrow('does not match current State and Run');
  }
  expect(() =>
    assertPrecommittedChildActivation(state, descriptor, descriptor.sessionId, undefined),
  ).toThrow('does not match current State and Run');
});

test('first child turn rejects missing task admission, a terminal child, and user transcript input', () => {
  const { descriptor, state } = fixture();
  state.childSessionOrigin = { ...state.childSessionOrigin!, taskInputAdmitted: false };
  expect(() =>
    assertPrecommittedChildActivation(
      state,
      descriptor,
      descriptor.sessionId,
      descriptor.childRunId,
    ),
  ).toThrow();
  state.childSessionOrigin = {
    ...state.childSessionOrigin!,
    taskInputAdmitted: true,
    terminal: {
      status: 'failed',
      resultRef: state.childSessionOrigin!.taskArtifactRef,
      cleanupConfirmed: true,
      cancelRequested: false,
      terminalReceiptId: 'receipt',
      sealedRevision: state.revision,
    },
  };
  expect(() =>
    assertPrecommittedChildActivation(
      state,
      descriptor,
      descriptor.sessionId,
      descriptor.childRunId,
    ),
  ).toThrow();
  state.childSessionOrigin = { ...state.childSessionOrigin!, terminal: undefined };
  state.transcript = {
    messages: [
      {
        kind: 'user',
        messageId: 'untrusted-message',
        turnId: descriptor.childRunId,
        ordinal: 0,
        createdAt: new Date().toISOString(),
        content: 'not delegated input',
      },
    ],
  };
  expect(() =>
    assertPrecommittedChildActivation(
      state,
      descriptor,
      descriptor.sessionId,
      descriptor.childRunId,
    ),
  ).toThrow();
});
