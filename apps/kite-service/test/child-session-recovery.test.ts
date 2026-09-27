import { expect, test } from 'bun:test';
import { childDelegatedUpperBoundDigest } from '@kite-ai/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import { CHILD_SESSION_TASK_USER_GOAL, sealChildGrantPayload } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import {
  childApprovalProxyId,
  type KiteChildApprovalProxyRecord,
} from '@kite-ai/runtime-storage-sqlite';
import type { KiteSessionAppServerStorageOwner } from '../src/bootstrap/kite-session-app-server-storage';
import type { RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import { planChildSessionRecovery } from '../src/bootstrap/runtime/subagent/child-session-recovery';

const NOW = Date.parse('2026-09-25T00:00:00.000Z');
type Intent = NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>;
type Input = Parameters<typeof planChildSessionRecovery>[0];

function fixture() {
  const upper = createZeroResourceUsage('versioned_upper_bound', 'test');
  Object.assign(upper.counters, {
    turns: 1,
    modelRequests: 1,
    toolInvocations: 1,
    inputTokens: 100,
    outputTokens: 100,
    artifactBytes: 100,
  });
  Object.assign(upper.gauges, {
    elapsedRunMs: 60_000,
    activeSubagents: 1,
    activeToolInvocations: 1,
    activeShellInvocations: 1,
  });
  const grant = {
    purpose: 'start',
    issuedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    parentAttempt: 1,
    childInvocationId: 'child-invocation',
    role: 'review',
    taskArtifact: {
      artifactId: 'task',
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${'a'.repeat(64)}`,
      byteLength: 4,
    },
    taskDigest: `sha256:${'b'.repeat(64)}`,
  } as unknown as SubagentDelegationGrant;
  const sealed = sealChildGrantPayload(grant);
  const deadlineAt = new Date(NOW + 60_000).toISOString();
  const intent = {
    childThreadId: 'child',
    parentSessionId: 'parent',
    parentInvocationId: grant.parentInvocationId,
    originRunId: 'parent-run',
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
    disposition: 'required',
    fundingRunId: 'parent-run',
    delegatedReservationId: 'reservation',
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    delegatedUpperBoundJson: JSON.stringify(upper),
    deadlineAt,
    childSessionCreated: false,
    childBudgetActivatedRunId: null,
    childBudgetActivatedEventId: null,
    dispatchAckEventId: null,
    failureReceiptDigest: null,
    parentClaimSettledEventId: null,
  } as unknown as Intent;
  const parentState = createRuntimeHostStateInitialState({
    threadId: 'parent',
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: '1'.repeat(64),
  });
  parentState.resourceBudget = {
    status: 'active',
    runId: 'parent-run',
    startedAt: new Date(NOW).toISOString(),
    deadlineAt,
    budget: INTERNAL_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage(),
    reservations: {
      reservation: {
        version: 1,
        reservationId: 'reservation',
        runId: 'parent-run',
        invocationId: 'child-allotment:child',
        resourceKind: 'subagent',
        executableUpperBound: upper,
        state: 'reserved',
      },
    },
    waiters: {},
    nextWaiterSequence: 0,
  };
  const childState = createRuntimeHostStateInitialState({
    threadId: 'child',
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: '2'.repeat(64),
  });
  childState.childSessionOrigin = {
    parentSessionId: 'parent',
    parentInvocationId: grant.parentInvocationId,
    parentToolCallId: grant.parentToolCallId,
    attempt: 1,
    childInvocationId: grant.childInvocationId,
    grantDigest: sealed.sealedGrantDigest,
    taskArtifactRef: grant.taskArtifact,
    taskArtifactDigest: grant.taskArtifact.integrityIdentifier,
    taskTextDigest: grant.taskDigest,
    role: 'review',
    fundingRunId: 'parent-run',
    delegatedReservationId: 'reservation',
    delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
    deadlineAt,
  };
  let currentIntent = intent;
  let currentChild: RuntimeState | null = null;
  const input: Input = {
    parentSessionId: 'parent',
    parentState,
    listPending: () => ({ entries: [currentIntent] }),
    readIntent: () => currentIntent,
    readSealedGrant: () => sealed,
    readChildState: () => currentChild,
    childApprovalProxyId,
    isParentRunLive: () => true,
    inspectGrant: () => grant,
    inspectActivatedGrant: () => grant,
    nowMs: NOW + 1000,
    limit: 10,
  };
  return {
    input,
    intent,
    childState,
    setIntent(value: Intent) {
      currentIntent = value;
    },
    setChild(value: RuntimeState | null) {
      currentChild = value;
    },
  };
}

test('pending intent without child plans one finite creation', () => {
  const f = fixture();
  const action = planChildSessionRecovery(f.input).actions[0];
  expect(action?.kind).toBe('create_child');
  if (action?.kind !== 'create_child') return;
  expect(action.budget.childBudget.maxRunDurationMs).toBeLessThanOrEqual(59_000);
});

test('a durable child stop request plans pre-dispatch abandonment instead of restart dispatch', () => {
  const f = fixture();
  expect(
    planChildSessionRecovery({
      ...f.input,
      hasStopRequest: (taskId) => taskId === f.intent.childInvocationId,
    }).actions,
  ).toMatchObject([{ kind: 'abandon_stopped_child' }]);
});

test('activated child without ACK only plans ACK if no external work exists', () => {
  const f = fixture();
  const intent = {
    ...f.intent,
    childSessionCreated: true,
    childBudgetActivatedRunId: 'run',
    childBudgetActivatedEventId: 'activation',
  };
  f.setIntent(intent);
  const child = f.childState;
  child.childSessionOrigin = { ...child.childSessionOrigin!, taskInputAdmitted: true };
  child.turn = { turnId: 'run', turnIndex: 1, status: 'active' };
  child.activeTaskId = intent.childInvocationId;
  child.tasks = {
    [intent.childInvocationId]: {
      taskId: intent.childInvocationId,
      userGoal: CHILD_SESSION_TASK_USER_GOAL,
      status: 'active',
      startedAtTurnId: 'run',
    } as never,
  };
  child.resourceBudget = {
    status: 'active',
    runId: 'run',
    startedAt: new Date(NOW + 1000).toISOString(),
    deadlineAt: intent.deadlineAt,
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage(),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  f.setChild(child);
  expect(planChildSessionRecovery(f.input).actions[0]?.kind).toBe('ack_dispatch');
  child.modelInvocations = { model: { status: 'prepared' } as never };
  expect(planChildSessionRecovery(f.input).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'child_work_or_external_attempt_recorded',
  });
  f.setIntent({ ...intent, dispatchAckEventId: 'ack' });
  if (f.input.parentState.resourceBudget.status !== 'active') throw new Error('missing budget');
  (f.input.parentState.resourceBudget.reservations.reservation as { state: string }).state =
    'dispatch_started';
  expect(planChildSessionRecovery(f.input).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'child_work_or_external_attempt_recorded',
  });
  child.modelInvocations = {};
  expect(planChildSessionRecovery(f.input).actions[0]?.kind).toBe('begin_first_turn');
});

test('expired or changed grant abandons a reserved child before dispatch', () => {
  const f = fixture();
  expect(planChildSessionRecovery({ ...f.input, nowMs: NOW + 60_000 }).actions[0]).toMatchObject({
    kind: 'abandon_unstartable_child',
  });
  expect(
    planChildSessionRecovery({
      ...f.input,
      inspectGrant: () => {
        throw new Error('policy');
      },
    }).actions[0],
  ).toMatchObject({
    kind: 'abandon_unstartable_child',
  });
  expect(
    planChildSessionRecovery({ ...f.input, readSealedGrant: () => null }).actions[0],
  ).toMatchObject({ kind: 'abandon_unstartable_child' });
});

test('closed parent Run settles only a reserved child without dispatch ACK', () => {
  const f = fixture();
  const funding = f.input.parentState.resourceBudget;
  if (funding.status !== 'active') throw new Error('missing budget');
  const cancelledParentState = {
    ...f.input.parentState,
    retainedResourceBudgets: { [funding.runId]: funding },
    resourceBudget: f.childState.resourceBudget,
  };
  expect(
    planChildSessionRecovery({
      ...f.input,
      parentState: cancelledParentState,
      isParentRunLive: () => false,
    }).actions[0],
  ).toMatchObject({ kind: 'abandon_unstartable_child' });
  (funding.reservations.reservation as { state: string }).state = 'unknown';
  expect(
    planChildSessionRecovery({
      ...f.input,
      parentState: cancelledParentState,
      isParentRunLive: () => false,
    }).actions[0],
  ).toMatchObject({ kind: 'recovery_required', reason: 'parent_run_not_live' });
  expect(
    planChildSessionRecovery({
      ...f.input,
      parentState: cancelledParentState,
      nowMs: NOW + 60_000,
    }).actions[0],
  ).toMatchObject({
    kind: 'recovery_required',
    reason: 'sealed_grant_expired_or_mismatch',
  });
});

test('user-cancelled parent safely abandons only a released, untouched revision-zero child', () => {
  const f = fixture();
  f.setIntent({ ...f.intent, childSessionCreated: true });
  f.setChild(f.childState);
  const parent = f.input.parentState;
  if (parent.resourceBudget.status !== 'active') throw new Error('missing budget');
  Object.assign(parent, {
    turn: { turnId: f.intent.originRunId, turnIndex: 1, status: 'aborted', abortCause: 'user' },
  });
  const reservation = parent.resourceBudget.reservations.reservation;
  if (!reservation) throw new Error('missing reservation');
  const closed = { ...f.input, isParentRunLive: () => false };
  Object.assign(closed, {
    hasCancelledParentRunProof: (runId: string) =>
      runId === f.intent.originRunId && parent.turn.abortCause === 'user',
  });
  (reservation as { state: string }).state = 'released';
  expect(planChildSessionRecovery(closed).actions[0]).toMatchObject({
    kind: 'abandon_cancelled_unstarted_child',
  });
  Object.assign(parent, { turn: { turnId: 'new-run', status: 'active' } });
  Object.assign(closed, {
    hasCancelledParentRunProof: (runId: string) => runId === f.intent.originRunId,
  });
  expect(planChildSessionRecovery(closed).actions[0]).toMatchObject({
    kind: 'abandon_cancelled_unstarted_child',
  });

  f.childState.modelInvocations = { attempt: { status: 'attempted' } as never };
  expect(planChildSessionRecovery(closed).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'parent_run_not_live',
  });
  f.childState.modelInvocations = {};
  f.childState.revision = 1;
  expect(planChildSessionRecovery(closed).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'parent_run_not_live',
  });
  f.childState.revision = 0;
  Object.assign(closed, { hasCancelledParentRunProof: () => false });
  expect(planChildSessionRecovery(closed).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'parent_run_not_live',
  });
  Object.assign(closed, { hasCancelledParentRunProof: () => true });
  f.setIntent({ ...f.intent, childSessionCreated: true, dispatchAckEventId: 'ack' });
  expect(planChildSessionRecovery(closed).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'parent_run_not_live',
  });
});

test('marked child can be recovered after parent deadline while its signed grant remains live', () => {
  const f = fixture();
  const parentDeadlineAt = new Date(NOW + 30_000).toISOString();
  const reservationId = 'child-allotment:child';
  const funding = f.input.parentState.resourceBudget;
  if (funding.status !== 'active') throw new Error('missing parent budget');
  const original = funding.reservations.reservation!;
  const upper = {
    ...original.executableUpperBound,
    unboundedToolInvocations: true as const,
    independentChildTurnDeadline: true as const,
    counters: { ...original.executableUpperBound.counters, toolInvocations: 0 },
    gauges: { ...original.executableUpperBound.gauges, elapsedRunMs: 30 * 60_000 },
  };
  const intent: Intent = {
    ...f.intent,
    delegatedReservationId: reservationId,
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    delegatedUpperBoundJson: JSON.stringify(upper),
    deadlineAt: parentDeadlineAt,
  };
  f.setIntent(intent);
  const parentState: RuntimeState = {
    ...f.input.parentState,
    resourceBudget: {
      ...funding,
      deadlineAt: parentDeadlineAt,
      reservations: {
        [reservationId]: {
          ...original,
          reservationId,
          invocationId: reservationId,
          executableUpperBound: upper,
        },
      },
    },
  };
  const recovery = { ...f.input, parentState, nowMs: NOW + 40_000, isParentRunLive: () => false };
  expect(planChildSessionRecovery(recovery).actions[0]).toMatchObject({ kind: 'create_child' });
  expect(
    planChildSessionRecovery({
      ...recovery,
      parentState: {
        ...parentState,
        turn: {
          turnId: 'parent-run',
          turnIndex: 1,
          status: 'aborted',
          abortCause: 'user',
          abortReason: 'cancelled',
        },
      },
    }).actions[0],
  ).toMatchObject({ kind: 'abandon_unstartable_child' });
  expect(planChildSessionRecovery({ ...recovery, nowMs: NOW + 60_000 }).actions[0]).toMatchObject({
    kind: 'abandon_unstartable_child',
  });
});

test('marked activated child resumes its first turn against its own deadline', () => {
  const f = fixture();
  const funding = f.input.parentState.resourceBudget;
  if (funding.status !== 'active') throw new Error('missing parent budget');
  const parentDeadlineAt = new Date(NOW + 30_000).toISOString();
  const reservationId = 'child-allotment:child';
  const original = funding.reservations.reservation!;
  const upper = {
    ...original.executableUpperBound,
    unboundedToolInvocations: true as const,
    independentChildTurnDeadline: true as const,
    counters: { ...original.executableUpperBound.counters, toolInvocations: 0 },
    gauges: { ...original.executableUpperBound.gauges, elapsedRunMs: 30 * 60_000 },
  };
  const intent: Intent = {
    ...f.intent,
    delegatedReservationId: reservationId,
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    delegatedUpperBoundJson: JSON.stringify(upper),
    deadlineAt: parentDeadlineAt,
    childSessionCreated: true,
    childBudgetActivatedRunId: 'child-run',
    childBudgetActivatedEventId: 'activation',
    dispatchAckEventId: 'ack',
  };
  f.setIntent(intent);
  const child = f.childState;
  child.childSessionOrigin = {
    ...child.childSessionOrigin!,
    delegatedReservationId: reservationId,
    delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
    deadlineAt: parentDeadlineAt,
    taskInputAdmitted: true,
  };
  child.turn = { turnId: 'child-run', turnIndex: 1, status: 'active' };
  child.activeTaskId = intent.childInvocationId;
  child.tasks = {
    [intent.childInvocationId]: {
      taskId: intent.childInvocationId,
      userGoal: CHILD_SESSION_TASK_USER_GOAL,
      status: 'active',
      startedAtTurnId: 'child-run',
    } as never,
  };
  child.resourceBudget = {
    status: 'active',
    runId: 'child-run',
    startedAt: new Date(NOW + 35_000).toISOString(),
    deadlineAt: new Date(NOW + 35_000 + 30 * 60_000).toISOString(),
    budget: {
      ...LIMITED_RESOURCE_BUDGET_,
      maxToolInvocations: 0,
      unboundedToolInvocations: true,
    },
    reconciledUsage: createZeroResourceUsage(),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  f.setChild(child);
  const parentState: RuntimeState = {
    ...f.input.parentState,
    resourceBudget: {
      ...funding,
      deadlineAt: parentDeadlineAt,
      reservations: {
        [reservationId]: {
          ...original,
          reservationId,
          invocationId: reservationId,
          executableUpperBound: upper,
          state: 'dispatch_started',
        },
      },
    },
  };
  const recovery = { ...f.input, parentState, nowMs: NOW + 40_000, isParentRunLive: () => false };
  expect(planChildSessionRecovery(recovery).actions[0]).toMatchObject({ kind: 'begin_first_turn' });
  expect(
    planChildSessionRecovery({
      ...recovery,
      nowMs: NOW + 60_000,
      inspectGrant: () => {
        throw new Error('Expired start grant cannot authorize a new dispatch.');
      },
    }).actions[0],
  ).toMatchObject({ kind: 'begin_first_turn' });
  expect(
    planChildSessionRecovery({
      ...recovery,
      nowMs: NOW + 35_000 + 30 * 60_000,
    }).actions[0],
  ).toMatchObject({ kind: 'recovery_required' });
});

test('expired grant after ACK retains a diagnostic instead of releasing a dispatched allotment', () => {
  const f = fixture();
  f.setIntent({ ...f.intent, childSessionCreated: true, dispatchAckEventId: 'ack' });
  f.setChild(f.childState);
  expect(planChildSessionRecovery({ ...f.input, nowMs: NOW + 60_000 }).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'sealed_grant_expired_or_mismatch',
  });
});

test('pristine created child plans activation, while changed revision requires recovery', () => {
  const f = fixture();
  f.setIntent({ ...f.intent, childSessionCreated: true });
  f.setChild(f.childState);
  expect(planChildSessionRecovery(f.input).actions[0]?.kind).toBe('activate_child');
  f.childState.revision = 1;
  expect(planChildSessionRecovery(f.input).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'unactivated_child_state_changed',
  });
});

test('recovery keeps a queued revision-zero child identity without dispatching it', () => {
  const f = fixture();
  f.setIntent({ ...f.intent, childSessionCreated: true });
  f.setChild(f.childState);
  const budget = f.input.parentState.resourceBudget;
  if (budget.status !== 'active') throw new Error('Queued child fixture has no parent budget.');
  const parentState: RuntimeState = {
    ...f.input.parentState,
    resourceBudget: {
      ...budget,
      budget: LIMITED_RESOURCE_BUDGET_,
      reservations: {
        ...budget.reservations,
        reservation: {
          ...budget.reservations.reservation!,
          state: 'queued',
        },
      },
    },
  };
  const action = planChildSessionRecovery({ ...f.input, parentState }).actions[0];
  expect(action).toMatchObject({ kind: 'activate_child', intent: { childThreadId: 'child' } });
  expect(f.childState.revision).toBe(0);
  expect(f.childState.resourceBudget.status).toBe('unconfigured');
  expect(parentState.resourceBudget.reservations.reservation?.state).toBe('queued');
});

test('sealed terminal plans import even after the start grant expires', () => {
  const f = fixture();
  f.setIntent({ ...f.intent, childSessionCreated: true, dispatchAckEventId: 'ack' });
  const child = f.childState;
  child.childSessionOrigin = {
    ...child.childSessionOrigin!,
    taskInputAdmitted: true,
    terminal: {
      status: 'completed',
      resultRef: child.childSessionOrigin!.taskArtifactRef,
      cleanupConfirmed: true,
      cancelRequested: false,
      terminalReceiptId: 'terminal',
      sealedRevision: 3,
    },
  };
  child.turn = { turnId: 'run', turnIndex: 1, status: 'completed' };
  child.resourceBudget = {
    status: 'active',
    runId: 'run',
    startedAt: new Date(NOW + 1000).toISOString(),
    deadlineAt: f.intent.deadlineAt,
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage(),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  child.terminalOutcome = {
    version: 1,
    status: 'completed',
    reasonCode: 'completed',
    knownExternalEffects: 'none',
    safeRetry: false,
    recoveryEntry: 'none',
    pendingVerification: false,
  };
  f.setChild(child);
  expect(planChildSessionRecovery({ ...f.input, nowMs: NOW + 70_000 }).actions[0]?.kind).toBe(
    'import_terminal',
  );
});

test('approval recovery requires completed Model evidence, an unstarted Tool, and the exact parent receipt', () => {
  const f = fixture();
  const intent = {
    ...f.intent,
    childSessionCreated: true,
    childBudgetActivatedRunId: 'run',
    childBudgetActivatedEventId: 'activation',
    dispatchAckEventId: 'ack',
  };
  f.setIntent(intent);
  const originalParent = f.input.parentState;
  if (originalParent.resourceBudget.status !== 'active') throw new Error('missing parent budget');
  const parent: RuntimeState = {
    ...originalParent,
    revision: 19,
    turn: { turnId: 'parent-run', turnIndex: 1, status: 'active' },
    capabilities: {
      ...originalParent.capabilities,
      invocations: {
        'parent-invocation': {
          toolCallId: 'parent-tool',
          subagentProviderLifecycle: {
            childInvocationId: 'child-invocation',
            childSession: { childThreadId: 'child', grantDigest: intent.grantDigest },
          },
        } as never,
      },
    },
    resourceBudget: {
      ...originalParent.resourceBudget,
      reservations: {
        ...originalParent.resourceBudget.reservations,
        reservation: {
          ...originalParent.resourceBudget.reservations.reservation!,
          state: 'dispatch_started',
        },
      },
    },
  };
  const child = f.childState;
  child.revision = 19;
  child.childSessionOrigin = { ...child.childSessionOrigin!, taskInputAdmitted: true };
  child.turn = { turnId: 'run', turnIndex: 1, status: 'active' };
  child.activeTaskId = intent.childInvocationId;
  child.tasks = {
    [intent.childInvocationId]: {
      taskId: intent.childInvocationId,
      userGoal: CHILD_SESSION_TASK_USER_GOAL,
      status: 'active',
      startedAtTurnId: 'run',
    } as never,
  };
  child.resourceBudget = {
    status: 'active',
    runId: 'run',
    startedAt: new Date(NOW).toISOString(),
    deadlineAt: intent.deadlineAt,
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage(),
    reservations: {},
    waiters: {},
    nextWaiterSequence: 0,
  };
  child.modelInvocations = {
    model: {
      invocationId: 'model',
      status: 'completed',
      dispatchCertainty: 'attempted',
      responseArtifact: { artifactId: 'response', kind: 'model_response' },
    } as never,
  };
  child.tools.calls = {
    tool: {
      toolCallId: 'tool',
      name: 'shell_execute',
      modelInvocationId: 'model',
      createdAtTurnId: 'run',
      status: 'awaiting_approval',
    } as never,
  };
  child.pendingApprovals = new Map([
    [
      'interaction',
      {
        interactionId: 'interaction',
        toolCallId: 'tool',
        generation: 0,
        route: 'user',
        status: 'awaiting_user',
      } as never,
    ],
  ]);
  child.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'interaction',
    toolCallId: 'tool',
  } as never;
  f.setChild(child);
  const proxy: KiteChildApprovalProxyRecord = {
    proxyInteractionId: childApprovalProxyId({
      childThreadId: 'child',
      childInteractionId: 'interaction',
      childGeneration: 0,
    }),
    parentSessionId: 'parent',
    childThreadId: 'child',
    childInvocationId: intent.childInvocationId,
    parentToolCallId: intent.originToolCallId,
    childToolCallId: 'tool',
    grantDigest: intent.grantDigest,
    childInteractionId: 'interaction',
    childGeneration: 0,
    childRequestRevision: 18,
    approvalDigest: `sha256:${'c'.repeat(64)}`,
    status: 'decided',
    decision: 'approve_once',
    parentCommandId: 'approval-command',
    parentCommandDigest: 'd'.repeat(64),
    parentDecisionRevision: 19,
    childAppliedRevision: null,
  };
  const approvalInput: Input = {
    ...f.input,
    parentState: parent,
    readChildApprovalProxy: () => proxy,
    readParentCommandReceipt: () => ({
      status: 'replay',
      receipt: { targetSessionId: 'parent', committedRevision: 19 } as never,
    }),
  };
  expect(planChildSessionRecovery(approvalInput).actions[0]).toMatchObject({
    kind: 'resume_approval',
    proxyInteractionId: proxy.proxyInteractionId,
  });
  expect(
    planChildSessionRecovery({
      ...approvalInput,
      readParentCommandReceipt: () => ({ status: 'missing' }),
    }).actions[0],
  ).toMatchObject({ kind: 'recovery_required', reason: 'child_approval_parent_receipt_changed' });
  child.modelInvocations.model = {
    invocationId: 'model',
    status: 'completed',
    dispatchCertainty: 'attempted',
  } as never;
  expect(planChildSessionRecovery(approvalInput).actions[0]).toMatchObject({
    kind: 'recovery_required',
    reason: 'child_approval_model_response_unavailable',
  });
  child.modelInvocations.model = {
    invocationId: 'model',
    status: 'completed',
    dispatchCertainty: 'attempted',
    responseArtifact: { artifactId: 'response', kind: 'model_response' },
  } as never;
  child.tools.calls.tool = { ...child.tools.calls.tool!, status: 'running' } as never;
  expect(planChildSessionRecovery(approvalInput).actions[0]?.kind).toBe('reconcile_unknown_child');
});
