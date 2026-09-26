import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AgentState,
  childThreadIdForToolAttempt,
  createInitialAgentState,
  getActivePlanning,
  type KernelEvent,
} from '@kite-ai/agent-kernel';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import type { RuntimeHostExecutionServices } from '@kite-ai/runtime-host';
import {
  childSessionAcceptanceEffectId,
  createRuntimeHostStateSession,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
  type StateRuntimeSessionInput,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  CheckpointPort,
  RuntimeAgentMailboxMutation,
  RuntimeCommandCommitEvidence,
  RuntimeRunStorePort,
  RuntimeStoredRun,
  RuntimeTransactionInput,
  SessionStore,
} from '@kite-ai/runtime-host/storage';
import {
  childDelegatedUpperBoundDigest,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';

const NOW = '2026-08-21T00:00:00.000Z';
const RECOVERY_KEY = 'a'.repeat(64);

function initialState(): AgentState {
  return createInitialAgentState({
    threadId: 'state-session-test',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
}

test('after_turn child ACK uses the retained origin funding Run without a required claim', () => {
  const originalRunId = 'origin-run';
  const childThreadId = 'child-after-turn';
  const childInvocationId = 'task-after-turn';
  const deadlineAt = '2026-08-21T00:01:00.000Z';
  const taskArtifactRef = {
    kind: 'subagent_task' as const,
    artifactId: `pa_${'a'.repeat(64)}`,
    integrityIdentifier: `sha256:${'b'.repeat(64)}`,
    byteLength: 1,
  };
  const upper = createZeroResourceUsage('versioned_upper_bound', 'after-turn-test');
  upper.gauges.activeSubagents = 1;
  const reserved = {
    version: 1 as const,
    reservationId: 'child-after-turn-reserve',
    runId: originalRunId,
    invocationId: `child-allotment:${childThreadId}`,
    resourceKind: 'subagent' as const,
    executableUpperBound: upper,
    state: 'reserved' as const,
  };
  const report = {
    ...reserved,
    reservationId: 'after-turn-report',
    invocationId: `model-invocation:after-turn:${childInvocationId}`,
    resourceKind: 'model' as const,
  };
  const funding = {
    status: 'active' as const,
    runId: originalRunId,
    startedAt: NOW,
    deadlineAt,
    budget: LIMITED_RESOURCE_BUDGET_,
    reconciledUsage: createZeroResourceUsage(),
    reservations: { [reserved.reservationId]: reserved, [report.reservationId]: report },
    waiters: {},
    nextWaiterSequence: 0,
  };
  const initial = initialState();
  const state: AgentState = {
    ...initial,
    resourceBudget: { ...funding, runId: 'new-human-run', reservations: {} },
    retainedResourceBudgets: { [originalRunId]: funding },
    tools: {
      ...initial.tools,
      calls: {
        'task-after-turn-tool': {
          toolCallId: 'task-after-turn-tool',
          name: 'task',
          modelMessageId: 'message-1',
          args: { background: true, result_disposition: 'after_turn' },
          createdAtTurnId: 'turn-1',
          status: 'succeeded',
          result: {
            ok: true,
            summary: 'accepted',
            resultMeta: {
              taskId: childInvocationId,
              taskStatus: 'running',
              taskDisposition: 'after_turn',
            },
          },
        },
      },
    },
    capabilities: {
      ...initial.capabilities,
      invocations: {
        afterTurn: {
          invocationId: 'afterTurn',
          toolCallId: 'task-after-turn-tool',
          capabilityId: 'builtin:task',
          capabilityRevision: 'v1',
          argumentsDigest: 'args',
          authorizationDigest: 'auth',
          admissionDigest: 'admission',
          effectiveEffectsDigest: 'effects',
          receiptRequirement: 'observation_receipt',
          status: 'succeeded',
          recordedAt: NOW,
          attemptsStarted: 1,
          resultDigest: `sha256:${'1'.repeat(64)}`,
          evidenceDigest: `sha256:${'2'.repeat(64)}`,
          artifact: {
            kind: 'capability_result',
            artifactId: `pa_${'3'.repeat(64)}`,
            integrityIdentifier: `sha256:${'4'.repeat(64)}`,
            byteLength: 1,
          },
          subagentProviderLifecycle: {
            attempt: 1,
            purpose: 'start',
            childInvocationId,
            taskArtifact: taskArtifactRef,
            dispatchIntentDigest: `sha256:${'c'.repeat(64)}`,
            status: 'intent_recorded',
            recordedAt: NOW,
            childSession: {
              childThreadId,
              grantDigest: `sha256:${'d'.repeat(64)}`,
              taskArtifactRef,
              taskArtifactDigest: taskArtifactRef.integrityIdentifier,
              taskTextDigest: `sha256:${'e'.repeat(64)}`,
              originRunId: originalRunId,
              originTurnId: 'turn-1',
              originToolCallId: 'task-after-turn-tool',
              disposition: 'after_turn',
              role: 'review',
              fundingRunId: originalRunId,
              delegatedReservationId: reserved.reservationId,
              delegatedUpperBoundDigest: `sha256:${'f'.repeat(64)}`,
              deadlineAt,
            },
          },
        },
      },
    },
  };
  const make = (status: RuntimeStoredRun['status'], candidate = state) => {
    const f = fixture(candidate, true);
    f.runs.set(`state-session-test\0${originalRunId}`, {
      sessionId: 'state-session-test',
      runId: originalRunId,
      startCommandId: 'start-original',
      phase: 'building',
      status,
      createdRevision: 0,
      lastRevision: 0,
      createdAtMs: 1,
    });
    return { f, session: createRuntimeHostStateSession(f.input) };
  };
  const completed = make('completed');
  expect(completed.session.commitChildDispatchAck(childThreadId)).toEqual([
    { type: 'resource_budget.dispatch_started', reservationId: reserved.reservationId },
  ]);
  expect(completed.f.writes.at(-1)?.childDispatchAck).toMatchObject({
    childThreadId,
    originRunId: originalRunId,
  });
  expect(
    completed.session.getState().retainedResourceBudgets[originalRunId]?.reservations[
      reserved.reservationId
    ]?.state,
  ).toBe('dispatch_started');
  expect(() => make('cancelled').session.commitChildDispatchAck(childThreadId)).toThrow(
    'eligible parent Run',
  );
  const expired: AgentState = {
    ...state,
    capabilities: {
      ...state.capabilities,
      invocations: {
        afterTurn: {
          ...state.capabilities.invocations.afterTurn!,
          subagentProviderLifecycle: {
            ...state.capabilities.invocations.afterTurn!.subagentProviderLifecycle!,
            childSession: {
              ...state.capabilities.invocations.afterTurn!.subagentProviderLifecycle!.childSession!,
              deadlineAt: '2026-08-20T00:00:00.000Z',
            },
          },
        },
      },
    },
  };
  expect(() => make('completed', expired).session.commitChildDispatchAck(childThreadId)).toThrow(
    'eligible parent Run',
  );
});

test('after_turn child admission atomically receipts both reserves without a required claim', () => {
  const parentSessionId = 'state-session-test';
  const parentInvocationId = 'after-turn-invocation';
  const toolCallId = 'after-turn-tool';
  const childInvocationId = 'after-turn-child';
  const childThreadId = childThreadIdForToolAttempt({
    parentSessionId,
    parentInvocationId,
    parentToolCallId: toolCallId,
    attempt: 1,
  });
  const runId = 'origin-run';
  const deadlineAt = '2026-08-21T00:01:00.000Z';
  const taskArtifact = {
    kind: 'subagent_task' as const,
    artifactId: `pa_${'a'.repeat(64)}`,
    integrityIdentifier: `sha256:${'b'.repeat(64)}`,
    byteLength: 1,
  };
  const taskTextDigest = `sha256:${'c'.repeat(64)}`;
  const transientUpper = createZeroResourceUsage('versioned_upper_bound', 'test');
  transientUpper.counters.toolInvocations = 1;
  const transient = {
    version: 1 as const,
    reservationId: 'transient',
    runId,
    invocationId: `tool:${toolCallId}`,
    resourceKind: 'subagent' as const,
    executableUpperBound: transientUpper,
    state: 'dispatch_started' as const,
  };
  const allotmentUpper = createZeroResourceUsage('versioned_upper_bound', 'child-test');
  allotmentUpper.gauges.activeSubagents = 1;
  const allotment = {
    ...transient,
    reservationId: 'allotment',
    invocationId: `child-allotment:${childThreadId}`,
    executableUpperBound: allotmentUpper,
    state: 'reserved' as const,
  };
  const reportUpper = createZeroResourceUsage('versioned_upper_bound', 'model-surface-v2');
  reportUpper.counters.modelRequests = 1;
  reportUpper.counters.inputTokens = 10;
  reportUpper.counters.outputTokens = 10;
  const report = {
    ...transient,
    reservationId: 'report',
    invocationId: `model-invocation:after-turn:${childInvocationId}`,
    resourceKind: 'model' as const,
    executableUpperBound: reportUpper,
    state: 'reserved' as const,
  };
  const grantPayload = {
    purpose: 'start',
    parentInvocationId,
    parentToolCallId: toolCallId,
    parentAttempt: 1,
    childInvocationId,
    role: 'review',
    taskArtifact,
    taskDigest: taskTextDigest,
    capabilityCeiling: { allowedTools: [], bindingIds: [] },
    authorization: {},
    executionBoundary: {},
    resource: {},
    model: {},
    grantId: 'grant',
    seal: 'seal',
    expiresAtMs: Date.parse(deadlineAt),
  };
  const sealedGrant = sealChildGrantPayload(grantPayload);
  const initial = initialState();
  const state: AgentState = {
    ...initial,
    tools: {
      calls: {
        [toolCallId]: {
          toolCallId,
          name: 'task',
          modelMessageId: 'message-1',
          args: {
            background: true,
            result_disposition: 'after_turn',
            subagent_type: 'review',
          },
          createdAtTurnId: 'turn-1',
          status: 'running',
        },
      },
      queue: [],
      active: [toolCallId],
    },
    capabilities: {
      ...initial.capabilities,
      invocations: {
        [parentInvocationId]: {
          invocationId: parentInvocationId,
          toolCallId,
          capabilityId: 'builtin:task',
          capabilityRevision: 'v1',
          argumentsDigest: 'args',
          authorizationDigest: 'auth',
          admissionDigest: 'admission',
          effectiveEffectsDigest: 'effects',
          receiptRequirement: 'observation_receipt',
          status: 'running',
          recordedAt: NOW,
          attemptsStarted: 1,
          startedAt: NOW,
          subagentProviderLifecycle: {
            attempt: 1,
            purpose: 'start',
            childInvocationId,
            taskArtifact,
            dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
            status: 'intent_recorded',
            recordedAt: NOW,
          },
        },
      },
    },
    resourceBudget: {
      status: 'active',
      runId,
      startedAt: NOW,
      deadlineAt,
      budget: LIMITED_RESOURCE_BUDGET_,
      reconciledUsage: createZeroResourceUsage(),
      reservations: { [transient.reservationId]: transient },
      waiters: {},
      nextWaiterSequence: 0,
    },
  };
  const f = fixture(state, true);
  f.runs.set(`${parentSessionId}\0${runId}`, {
    sessionId: parentSessionId,
    runId,
    startCommandId: 'start-original',
    phase: 'building',
    status: 'running',
    createdRevision: 0,
    lastRevision: 0,
    createdAtMs: 1,
  });
  const session = createRuntimeHostStateSession(f.input);
  const lease = session.beginEffect({ type: 'run_tools', toolCallIds: [toolCallId] });
  const resultArtifact = {
    kind: 'capability_result' as const,
    artifactId: `pa_${'e'.repeat(64)}`,
    integrityIdentifier: `sha256:${'f'.repeat(64)}`,
    byteLength: 1,
  };
  const intent: Extract<KernelEvent, { type: 'subagent.child_session_intended' }> = {
    type: 'subagent.child_session_intended',
    parentSessionId,
    parentInvocationId,
    originRunId: runId,
    originTurnId: 'turn-1',
    originToolCallId: toolCallId,
    attempt: 1,
    childInvocationId,
    childThreadId,
    grantDigest: sealedGrant.sealedGrantDigest,
    taskArtifactRef: taskArtifact,
    taskArtifactDigest: taskArtifact.integrityIdentifier,
    taskTextDigest,
    disposition: 'after_turn',
    role: 'review',
    fundingRunId: runId,
    delegatedReservationId: allotment.reservationId,
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(allotmentUpper),
    deadlineAt,
  };
  const actual = createZeroResourceUsage('actual', 'test');
  actual.counters.toolInvocations = 1;
  const events: KernelEvent[] = [
    { type: 'resource_budget.reconciled', reservationId: transient.reservationId, actual },
    { type: 'resource_budget.reserved', reservation: allotment },
    { type: 'resource_budget.reserved', reservation: report },
    {
      type: 'capability.subagent_dispatch_intent_recorded',
      invocationId: parentInvocationId,
      attempt: 1,
      purpose: 'start',
      childInvocationId,
      taskArtifact,
      dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
      recordedAt: NOW,
    },
    {
      type: 'subagent.started',
      subagent: {
        id: childInvocationId,
        role: 'review',
        name: 'Child',
        parentToolCallId: toolCallId,
      },
    },
    intent,
    {
      type: 'capability.execution_succeeded',
      invocationId: parentInvocationId,
      resultDigest: `sha256:${'1'.repeat(64)}`,
      evidenceDigest: `sha256:${'2'.repeat(64)}`,
      artifact: resultArtifact,
      finishedAt: NOW,
    },
    {
      type: 'tool.finished',
      toolCallId,
      name: 'task',
      result: {
        ok: true,
        command: 'task',
        exitCode: 0,
        stdout: 'accepted',
        stderr: '',
        resultMeta: {
          taskId: childInvocationId,
          taskStatus: 'running',
          taskDisposition: 'after_turn',
        },
      },
    },
  ];
  expect(
    session.commitBackgroundChildAcceptance(
      lease,
      events,
      {
        sessionId: parentSessionId,
        effectId: childSessionAcceptanceEffectId(childThreadId),
        ownerId: 'owner',
      },
      sealedGrant,
    ),
  ).toBe(true);
  expect(f.writes.at(-1)?.childSessionIntent).toMatchObject({
    childThreadId,
    disposition: 'after_turn',
  });
  expect(
    session.getState().capabilities.invocations[parentInvocationId]?.subagentProviderLifecycle
      ?.childSession?.disposition,
  ).toBe('after_turn');
  expect(session.getState().tools.calls[toolCallId]?.result?.resultMeta?.taskDisposition).toBe(
    'after_turn',
  );
});

function runningTaskWaitState(): AgentState {
  const state = initialState();
  return {
    ...state,
    tools: {
      calls: {
        wait: {
          toolCallId: 'wait',
          name: 'task_wait',
          modelMessageId: 'message-1',
          args: { task_ids: ['child-a', 'child-b'], timeout_ms: 30_000 },
          createdAtTurnId: 'turn-1',
          status: 'running',
          effectClass: 'read_only',
          sideEffect: false,
        },
      },
      queue: [],
      active: ['wait'],
    },
    capabilities: {
      ...state.capabilities,
      invocations: {
        waitInvocation: {
          invocationId: 'waitInvocation',
          toolCallId: 'wait',
          capabilityId: 'builtin:task_wait',
          capabilityRevision: 'revision-1',
          argumentsDigest: 'arguments-1',
          authorizationDigest: 'authorization-1',
          effectiveEffectsDigest: 'effects-1',
          retryEligibility: 'none',
          status: 'running',
          recordedAt: NOW,
          startedAt: NOW,
        },
      },
    },
  };
}

interface Fixture {
  input: StateRuntimeSessionInput;
  readonly writes: RuntimeTransactionInput<KernelEvent, AgentState>[];
  readonly requiredLeases: {
    readonly sessionId: string;
    readonly effectId: string;
    readonly ownerId: string;
  }[];
  readonly acknowledgements: string[];
  readonly leaseCalls: string[];
  readonly runs: Map<string, RuntimeStoredRun>;
  failCommit: boolean;
  leaseAvailable: boolean;
}

function fixture(state: AgentState = initialState(), withRunAuthority = false): Fixture {
  const writes: RuntimeTransactionInput<KernelEvent, AgentState>[] = [];
  const acknowledgements: string[] = [];
  const requiredLeases: Fixture['requiredLeases'] = [];
  const leaseCalls: string[] = [];
  const runs = new Map<string, RuntimeStoredRun>();
  const fixtureState: Fixture = {
    input: undefined as never,
    writes,
    requiredLeases,
    acknowledgements,
    leaseCalls,
    runs,
    failCommit: false,
    leaseAvailable: true,
  };
  const sessions = sessionStore();
  const services: RuntimeHostExecutionServices<KernelEvent, AgentState> = {
    sessions,
    transactions: {
      commit: (acknowledgement, input, requiredLease) => {
        if (fixtureState.failCommit) throw new Error('commit refused');
        if (requiredLease && !fixtureState.leaseAvailable) throw new Error('lease lost');
        applyRunMutation(runs, input);
        acknowledgements.push(acknowledgement);
        writes.push(input);
        if (requiredLease) requiredLeases.push(requiredLease);
      },
      commitCommandDecision: (input) => {
        if (fixtureState.failCommit) throw new Error('commit refused');
        applyRunMutation(runs, input);
        acknowledgements.push('command_decision');
        writes.push(input);
      },
      commitCommandReceiptEvidence: (input, requiredLease) => {
        if (fixtureState.failCommit) throw new Error('commit refused');
        if (!fixtureState.leaseAvailable) throw new Error('lease lost');
        applyRunMutation(runs, input);
        acknowledgements.push('command_receipt_evidence');
        writes.push(input);
        requiredLeases.push(requiredLease);
      },
    },
    leases: {
      tryAcquire: (_sessionId, effectId, ownerId) => {
        leaseCalls.push(`acquire:${effectId}:${ownerId}`);
        return fixtureState.leaseAvailable;
      },
      renew: () => fixtureState.leaseAvailable,
      release: (_sessionId, effectId, ownerId) => {
        leaseCalls.push(`release:${effectId}:${ownerId}`);
      },
      hasClaim: () => fixtureState.leaseAvailable,
    },
    checkpoints: checkpointPort(),
    recoveryIdentities: {
      read: () => RECOVERY_KEY,
      getOrCreate: (_sessionId, allocate) => allocate(),
      remove: () => undefined,
    },
    ...(withRunAuthority ? { runs: runStore(runs) } : {}),
  };
  fixtureState.input = {
    state,
    services,
    clock: () => NOW,
    id: (kind) => `${kind}-${fixtureState.writes.length + fixtureState.leaseCalls.length + 1}`,
    sandboxAvailable: true,
  };
  return fixtureState;
}

function runStore(records: Map<string, RuntimeStoredRun>): RuntimeRunStorePort {
  return {
    get: (sessionId, runId) => records.get(`${sessionId}\0${runId}`) ?? null,
    getActive: (sessionId) =>
      [...records.values()].find(
        (run) =>
          run.sessionId === sessionId &&
          (run.status === 'queued' || run.status === 'running' || run.status === 'waiting'),
      ) ?? null,
    list: (request) => {
      const candidates = [...records.values()]
        .filter(
          (run) =>
            run.sessionId === request.sessionId &&
            (request.status === undefined || run.status === request.status) &&
            (request.phase === undefined || run.phase === request.phase),
        )
        .sort(
          (left, right) =>
            left.createdRevision - right.createdRevision || left.runId.localeCompare(right.runId),
        )
        .filter(
          (run) =>
            request.cursor === undefined ||
            run.createdRevision > request.cursor.createdRevision ||
            (run.createdRevision === request.cursor.createdRevision &&
              run.runId.localeCompare(request.cursor.runId) > 0),
        );
      const entries = candidates.slice(0, request.limit);
      const last = entries.at(-1);
      return {
        entries,
        hasMore: candidates.length > entries.length,
        ...(candidates.length > entries.length && last
          ? { nextCursor: { createdRevision: last.createdRevision, runId: last.runId } }
          : {}),
      };
    },
    insert: (run) => {
      const key = `${run.sessionId}\0${run.runId}`;
      if (records.has(key)) throw new Error('duplicate Run');
      records.set(key, run);
    },
    transition: (input) => {
      const key = `${input.sessionId}\0${input.runId}`;
      const current = records.get(key);
      if (!current) return 'missing';
      if (current.lastRevision !== input.expectedLastRevision) return 'conflict';
      records.set(key, input.next);
      return 'applied';
    },
    rewindSession: () => ({ status: 'applied', deletedCount: 0 }),
    forkSession: () => ({ status: 'applied', copiedCount: 0 }),
  };
}

function applyRunMutation(
  records: Map<string, RuntimeStoredRun>,
  input: RuntimeTransactionInput<KernelEvent, AgentState>,
): void {
  if (!input.runMutation) return;
  const store = runStore(records);
  if (input.runMutation.type === 'insert') store.insert(input.runMutation.run);
  else if (store.transition(input.runMutation.transition) !== 'applied') {
    throw new Error('Run transition failed');
  }
}

function sessionStore(): SessionStore<KernelEvent, AgentState> {
  return {
    appendEvents: () => undefined,
    loadEventsStrict: () => [],
    saveSnapshot: () => undefined,
    loadSnapshot: () => null,
    loadSnapshotRecord: () => null,
    getLastEventPosition: () => 0,
    listSessions: () => [],
    setSessionName: () => undefined,
    getSessionModelRoute: () => null,
    setSessionModelRoute: () => undefined,
    deleteSession: () => undefined,
  };
}

function checkpointPort(): CheckpointPort<AgentState> {
  return {
    saveNamedSnapshot: () => undefined,
    loadNamedSnapshot: () => null,
    listNamedSnapshots: () => [],
    getNamedSnapshotEntry: () => null,
    restoreNamedSnapshot: () => false,
    forkSession: () => false,
    forkSessionForCommand: () => ({ status: 'unavailable' }),
    forkCurrentSession: () => false,
    recordFilePreimage: () => undefined,
    recordFilePostimage: () => undefined,
    fileRestorePlan: () => [],
  };
}

function message(messageId: string, content = 'hello'): KernelEvent {
  return { type: 'user.message_appended', messageId, content };
}

function preparedModelEvent(invocationId = 'model-1'): KernelEvent {
  const surfaceArtifact = {
    kind: 'model_surface' as const,
    artifactId: `pa_${'b'.repeat(64)}`,
    integrityIdentifier: `sha256:${'c'.repeat(64)}`,
    byteLength: 1,
  };
  return {
    type: 'model.invocation_prepared',
    invocationId,
    purpose: 'primary_agent',
    surfaceArtifact,
    surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
    routeFingerprint: `sha256:${'d'.repeat(64)}`,
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
    limits: { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
    preparedStateRevision: 0,
    parentInvocationId: null,
    parentToolCallId: null,
  };
}

function completedModelEvent(invocationId = 'model-1'): KernelEvent {
  return {
    type: 'model.invocation_completed',
    invocationId,
    responseArtifact: {
      kind: 'model_response',
      artifactId: `pa_${'e'.repeat(64)}`,
      integrityIdentifier: `sha256:${'f'.repeat(64)}`,
      byteLength: 2,
    },
    finishReason: 'stop',
  };
}

function commandEvidence(): RuntimeCommandCommitEvidence {
  return {
    scopeSessionId: 'scope-session',
    commandId: 'command-1',
    requestDigest: 'a'.repeat(64),
    targetSessionId: 'state-session-test',
    committedAt: 1_700_000_000_000,
  };
}

function agentMailAcceptance(mode: 'queue_only' | 'reply' = 'queue_only'): {
  event: Extract<KernelEvent, { type: 'agent.mail_accepted' }>;
  mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'accept_mail' }>;
} {
  const source = {
    runId: 'run-1',
    turnId: 'turn-1',
    modelInvocationId: 'model-1',
    toolCallId: 'tool-1',
    effectAttemptId: 'effect-attempt-1',
  };
  const bodyRef = {
    artifactId: `pa_${'b'.repeat(64)}`,
    kind: 'agent_mail' as const,
    integrityIdentifier: `sha256:${'c'.repeat(64)}`,
    byteLength: 5,
  };
  const event = {
    type: 'agent.mail_accepted' as const,
    messageId: 'mail-command-1',
    senderAgentId: 'sender',
    targetAgentId: 'target',
    mode,
    source,
    bodyRef,
    bodyDigest: `sha256:${'d'.repeat(64)}`,
    sequence: 1,
  };
  return {
    event,
    mutation: {
      kind: 'accept_mail',
      messageId: event.messageId,
      senderAgentId: event.senderAgentId,
      targetAgentId: event.targetAgentId,
      mode,
      source,
      bodyRef,
      bodyDigest: event.bodyDigest,
      bodyText: 'hello',
      requestDigest: 'a'.repeat(64),
      sequence: 1,
      acceptedAtMs: 1_700_000_000_000,
    },
  };
}

function triggerMailAcceptance() {
  const fundingRunId = 'funding-run';
  const deadlineAt = Date.parse(NOW) + 5 * 60_000;
  const base = agentMailAcceptance();
  const source = { ...base.event.source, runId: fundingRunId };
  const initial = initialState();
  const state: AgentState = {
    ...initial,
    capabilities: {
      ...initial.capabilities,
      invocations: {
        'trigger-invocation': {
          invocationId: 'trigger-invocation',
          toolCallId: source.toolCallId,
          capabilityId: 'builtin:followup_task',
          capabilityRevision: 'revision-1',
          argumentsDigest: 'arguments-1',
          authorizationDigest: 'authorization-1',
          admissionDigest: 'admission-1',
          effectiveEffectsDigest: 'effects-1',
          status: 'running',
          recordedAt: NOW,
          startedAt: NOW,
        },
      },
    },
    resourceBudget: {
      status: 'active',
      runId: fundingRunId,
      startedAt: NOW,
      deadlineAt: new Date(deadlineAt).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_,
      reconciledUsage: createZeroResourceUsage(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 0,
    },
  };
  const upper = createZeroResourceUsage('versioned_upper_bound', 'trigger-backup-test-v1');
  upper.counters.turns = 1;
  upper.counters.modelRequests = 1;
  upper.counters.inputTokens = 100;
  upper.counters.outputTokens = 50;
  upper.gauges.activeSubagents = 1;
  const reservation = {
    version: 1 as const,
    reservationId: 'backup-1',
    runId: fundingRunId,
    invocationId: 'trigger-command-1',
    resourceKind: 'subagent' as const,
    executableUpperBound: upper,
    state: 'reserved' as const,
  };
  const canonicalJson = JSON.stringify({
    artifactFormatVersion: 1,
    backupReservationId: reservation.reservationId,
    deadlineAt,
    executableUpperBound: upper,
    fundingRunId,
    source,
    senderAgentId: base.event.senderAgentId,
    targetAgentId: base.event.targetAgentId,
    targetTaskId: null,
    targetTurnOrdinal: 1,
    submissionId: 'submission-1',
    messageId: base.event.messageId,
    authorization: {
      phaseCeiling: getAgentPhase(getActivePlanning(state)),
      authorizationDigest: 'authorization-1',
      admissionDigest: 'admission-1',
      effectiveEffectsDigest: 'effects-1',
      capabilityDigest: state.capabilities.catalogRevision,
      policyRevision: 'policy-1',
      workspaceDigest: state.session.canonicalWorkspaceDigest,
      interactionMode: state.mode,
      interactionModeRevision: state.interactionModeRevision,
      workspaceAccess: state.workspaceAccess,
      boundedContext: true,
      contextWindowTokens: 4096,
      maxOutputTokens: 512,
      firstAttemptTimeoutMs: 30_000,
    },
  });
  const digest = `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`;
  const admissionRef = {
    artifactId: `pa_${'e'.repeat(64)}`,
    kind: 'agent_followup_admission' as const,
    integrityIdentifier: digest,
    byteLength: Buffer.byteLength(canonicalJson),
  };
  const event = {
    ...base.event,
    mode: 'trigger_turn' as const,
    submissionId: 'submission-1',
    source,
    followupAdmissionRef: admissionRef,
    followupAdmissionDigest: digest,
  };
  const mutation = {
    ...base.mutation,
    mode: 'trigger_turn' as const,
    submissionId: event.submissionId,
    source,
    followupAdmission: { ref: admissionRef, digest, canonicalJson, createdAt: Date.parse(NOW) },
  };
  return { event, mutation, reservation, state, canonicalJson, deadlineAt };
}

describe('Runtime Host State session', () => {
  test('binds TriggerTurn receipt to one exact funding reservation and admission', () => {
    const trigger = triggerMailAcceptance();
    const lease = { sessionId: 'state-session-test', effectId: 'effect-1', ownerId: 'owner-1' };
    const evidence = { ...commandEvidence(), commandId: trigger.event.messageId };
    const reserved = {
      type: 'resource_budget.reserved' as const,
      reservation: trigger.reservation,
    };
    const accepted = fixture(trigger.state);
    const session = createRuntimeHostStateSession(accepted.input);
    expect(
      session.commitAgentMailboxCommand(
        [reserved, trigger.event],
        [trigger.mutation],
        evidence,
        lease,
      ).events,
    ).toEqual([reserved, trigger.event]);
    expect(accepted.writes[0]).toMatchObject({
      events: [reserved, trigger.event],
      agentMailboxMutations: [trigger.mutation],
      commandReceipt: { commandId: trigger.event.messageId },
    });
    const retainedState: AgentState = {
      ...trigger.state,
      resourceBudget: {
        ...trigger.state.resourceBudget,
        runId: 'new-foreground-run',
      } as Extract<AgentState['resourceBudget'], { status: 'active' }>,
      retainedResourceBudgets: {
        [trigger.reservation.runId]: {
          ...(trigger.state.resourceBudget as Extract<
            AgentState['resourceBudget'],
            { status: 'active' }
          >),
          reservations: {
            'existing-backup': {
              ...trigger.reservation,
              reservationId: 'existing-backup',
              invocationId: 'existing-trigger',
            },
          },
        },
      },
    };
    const retained = fixture(retainedState);
    const retainedSession = createRuntimeHostStateSession(retained.input);
    retainedSession.commitAgentMailboxCommand(
      [reserved, trigger.event],
      [trigger.mutation],
      evidence,
      lease,
    );
    expect(
      retainedSession.getState().retainedResourceBudgets[trigger.reservation.runId]?.reservations[
        trigger.reservation.reservationId
      ]?.state,
    ).toBe('reserved');
    for (const changed of [
      { events: [trigger.event], mutation: trigger.mutation },
      {
        events: [reserved, trigger.event],
        mutation: {
          ...trigger.mutation,
          followupAdmission: {
            ...trigger.mutation.followupAdmission,
            canonicalJson: JSON.stringify({
              ...JSON.parse(trigger.canonicalJson),
              backupReservationId: 'other',
            }),
          },
        },
      },
      {
        events: [reserved, trigger.event],
        mutation: {
          ...trigger.mutation,
          followupAdmission: {
            ...trigger.mutation.followupAdmission,
            canonicalJson: JSON.stringify({
              ...JSON.parse(trigger.canonicalJson),
              deadlineAt: trigger.deadlineAt + 1,
            }),
          },
        },
      },
      {
        events: [reserved, trigger.event],
        mutation: {
          ...trigger.mutation,
          followupAdmission: {
            ...trigger.mutation.followupAdmission,
            canonicalJson: JSON.stringify({
              ...JSON.parse(trigger.canonicalJson),
              authorization: {
                ...JSON.parse(trigger.canonicalJson).authorization,
                firstAttemptTimeoutMs: 300_000,
              },
            }),
          },
        },
      },
      {
        events: [reserved, trigger.event],
        mutation: {
          ...trigger.mutation,
          followupAdmission: {
            ...trigger.mutation.followupAdmission,
            canonicalJson: JSON.stringify({
              ...JSON.parse(trigger.canonicalJson),
              executableUpperBound: {
                ...trigger.reservation.executableUpperBound,
                counters: {
                  ...trigger.reservation.executableUpperBound.counters,
                  outputTokens: 51,
                },
              },
            }),
          },
        },
      },
      { events: [reserved, reserved, trigger.event], mutation: trigger.mutation },
      {
        events: [
          reserved,
          {
            ...trigger.event,
            mode: 'queue_only' as const,
            submissionId: undefined,
            followupAdmissionRef: undefined,
            followupAdmissionDigest: undefined,
          },
        ],
        mutation: {
          ...trigger.mutation,
          mode: 'queue_only' as const,
          submissionId: undefined,
          followupAdmission: undefined,
        },
      },
    ]) {
      const rejected = fixture(trigger.state);
      const rejectedSession = createRuntimeHostStateSession(rejected.input);
      expect(() =>
        rejectedSession.commitAgentMailboxCommand(
          changed.events as KernelEvent[],
          [changed.mutation],
          evidence,
          lease,
        ),
      ).toThrow();
      expect(rejected.writes).toHaveLength(0);
      expect(rejectedSession.getState().revision).toBe(0);
    }
    for (const staleState of [
      { ...trigger.state, interactionModeRevision: trigger.state.interactionModeRevision + 1 },
      {
        ...trigger.state,
        capabilities: {
          ...trigger.state.capabilities,
          catalogRevision: 'stale-catalog',
        },
      },
      {
        ...trigger.state,
        session: { ...trigger.state.session, canonicalWorkspaceDigest: 'stale-workspace' },
      },
      {
        ...trigger.state,
        capabilities: {
          ...trigger.state.capabilities,
          invocations: {
            'trigger-invocation': {
              ...trigger.state.capabilities.invocations['trigger-invocation']!,
              authorizationDigest: 'stale-authorization',
            },
          },
        },
      },
    ]) {
      const rejected = fixture(staleState);
      const rejectedSession = createRuntimeHostStateSession(rejected.input);
      expect(() =>
        rejectedSession.commitAgentMailboxCommand(
          [reserved, trigger.event],
          [trigger.mutation],
          evidence,
          lease,
        ),
      ).toThrow('TriggerTurn backup does not match its funding ledger and admission.');
      expect(rejected.writes).toHaveLength(0);
    }
  });

  test('commits Agent mail, its exact command receipt and State revision in one fenced transaction', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const { event, mutation } = agentMailAcceptance();
    const lease = { sessionId: 'state-session-test', effectId: 'effect-1', ownerId: 'owner-1' };
    const evidence = { ...commandEvidence(), commandId: event.messageId };
    const committed = session.commitAgentMailboxCommand([event], [mutation], evidence, lease);
    expect(committed.receipt.committedRevision).toBe(1);
    expect(f.acknowledgements).toEqual(['command_decision']);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      agentMailboxMutations: [mutation],
      commandReceipt: committed.receipt,
      requiredEffectLease: { effectId: 'effect-1', ownerId: 'owner-1' },
      snapshot: { revision: 1 },
    });
    expect(f.writes[0]?.requiredEffectLease?.observedAtMs).toBe(Date.parse(NOW));
    expect(session.getState().revision).toBe(1);
    expect(() => session.commitAgentMailboxCommand([event], [mutation], evidence, lease)).toThrow();
    expect(f.writes).toHaveLength(1);
  });

  test('cross-Session QueueOnly source commits its Tool receipt and outbox mutation atomically', () => {
    const base = initialState();
    const state: AgentState = {
      ...base,
      tools: {
        ...base.tools,
        active: ['mail-tool'],
        calls: {
          'mail-tool': {
            toolCallId: 'mail-tool',
            name: 'send_message',
            modelMessageId: 'assistant-mail',
            args: {},
            modelInvocationId: 'model-mail',
            createdAtTurnId: base.turn.turnId,
            status: 'running',
          },
        },
      },
      transcript: {
        messages: [
          {
            kind: 'assistant',
            messageId: 'assistant-mail',
            turnId: base.turn.turnId,
            ordinal: 0,
            createdAt: NOW,
            modelInvocationId: 'model-mail',
            toolCalls: [{ id: 'mail-tool', name: 'send_message', args: {} }],
          },
        ],
      },
      capabilities: {
        ...base.capabilities,
        invocations: {
          'mail-invocation': {
            invocationId: 'mail-invocation',
            toolCallId: 'mail-tool',
            capabilityId: 'builtin:send_message',
            capabilityRevision: 'revision-1',
            argumentsDigest: 'arguments-1',
            authorizationDigest: 'authorization-1',
            effectiveEffectsDigest: 'effects-1',
            status: 'running',
            recordedAt: NOW,
            attemptsStarted: 1,
          },
        },
      },
    };
    const f = fixture(state, true);
    f.runs.set('state-session-test\0run-mail', {
      sessionId: 'state-session-test',
      runId: 'run-mail',
      startCommandId: 'start-mail',
      phase: 'building',
      status: 'running',
      createdRevision: 0,
      lastRevision: 0,
      createdAtMs: 1,
    });
    const session = createRuntimeHostStateSession(f.input);
    const lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['mail-tool'] });
    const bodyDigest = `sha256:${'b'.repeat(64)}`;
    const event = {
      type: 'agent.mail_accepted',
      messageId: 'mail-cross-1',
      senderAgentId: 'state-session-test',
      targetAgentId: 'child-1',
      mode: 'queue_only',
      source: {
        runId: 'run-mail',
        turnId: base.turn.turnId,
        modelInvocationId: 'model-mail',
        toolCallId: 'mail-tool',
        effectAttemptId: 'mail-invocation:attempt:1',
      },
      bodyRef: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'agent_mail',
        integrityIdentifier: bodyDigest,
        byteLength: 5,
      },
      bodyDigest,
      sequence: 1,
    } as const;
    const mutation = {
      kind: 'accept_queue',
      messageId: event.messageId,
      targetSessionId: event.targetAgentId,
      commandId: event.messageId,
      requestDigest: 'a'.repeat(64),
      sourceRunId: event.source.runId,
      sourceTurnId: event.source.turnId,
      sourceModelInvocationId: event.source.modelInvocationId,
      sourceToolCallId: event.source.toolCallId,
      sourceEffectAttemptId: event.source.effectAttemptId,
      sourceSequence: 1,
      bodyText: 'hello',
      acceptedAtMs: 1,
    } as const;
    const evidence = {
      ...commandEvidence(),
      scopeSessionId: 'state-session-test',
      commandId: event.messageId,
    };
    expect(() =>
      session.commitCrossSessionQueueMailCommand(
        lease,
        { ...event, source: { ...event.source, effectAttemptId: 'wrong-attempt' } },
        mutation,
        evidence,
        { sessionId: 'state-session-test', effectId: 'mail-effect', ownerId: 'owner' },
      ),
    ).toThrow();
    expect(f.writes).toHaveLength(0);
    f.failCommit = true;
    expect(() =>
      session.commitCrossSessionQueueMailCommand(lease, event, mutation, evidence, {
        sessionId: 'state-session-test',
        effectId: 'mail-effect',
        ownerId: 'owner',
      }),
    ).toThrow('commit refused');
    expect(session.getState().revision).toBe(0);
    f.failCommit = false;
    const committed = session.commitCrossSessionQueueMailCommand(lease, event, mutation, evidence, {
      sessionId: 'state-session-test',
      effectId: 'mail-effect',
      ownerId: 'owner',
    });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      crossSessionAgentMailMutation: mutation,
      commandReceipt: committed.receipt,
      requiredEffectLease: { effectId: 'mail-effect', ownerId: 'owner' },
    });
    expect(committed.receipt.committedRevision).toBe(1);
    expect(f.acknowledgements).toEqual(['command_receipt_evidence']);
  });

  test('cross-Session interrupt binds exact Tool attempt, target task and leased receipt', () => {
    const base = initialState();
    const state: AgentState = {
      ...base,
      tools: {
        ...base.tools,
        active: ['interrupt-tool'],
        calls: {
          'interrupt-tool': {
            toolCallId: 'interrupt-tool',
            name: 'interrupt_agent',
            modelMessageId: 'assistant-interrupt',
            args: { agent_id: 'child-1' },
            modelInvocationId: 'model-interrupt',
            createdAtTurnId: base.turn.turnId,
            status: 'running',
          },
        },
      },
      transcript: {
        messages: [
          {
            kind: 'assistant',
            messageId: 'assistant-interrupt',
            turnId: base.turn.turnId,
            ordinal: 0,
            createdAt: NOW,
            modelInvocationId: 'model-interrupt',
            toolCalls: [
              { id: 'interrupt-tool', name: 'interrupt_agent', args: { agent_id: 'child-1' } },
            ],
          },
        ],
      },
      capabilities: {
        ...base.capabilities,
        invocations: {
          'interrupt-invocation': {
            invocationId: 'interrupt-invocation',
            toolCallId: 'interrupt-tool',
            capabilityId: 'builtin:interrupt_agent',
            capabilityRevision: 'revision-1',
            argumentsDigest: 'arguments-1',
            authorizationDigest: 'authorization-1',
            effectiveEffectsDigest: 'effects-1',
            status: 'running',
            recordedAt: NOW,
            attemptsStarted: 1,
          },
        },
      },
    };
    const f = fixture(state, true);
    f.runs.set('state-session-test\0run-interrupt', {
      sessionId: 'state-session-test',
      runId: 'run-interrupt',
      startCommandId: 'start-interrupt',
      phase: 'building',
      status: 'running',
      createdRevision: 0,
      lastRevision: 0,
      createdAtMs: 1,
    });
    const session = createRuntimeHostStateSession(f.input);
    const lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['interrupt-tool'] });
    const event = {
      type: 'background_execution.stop_requested',
      commandId: 'interrupt-1',
      executionId: 'child-task-1',
      executionKind: 'subagent',
      ownerGeneration: 'child:2',
    } as const;
    const mutation = {
      kind: 'request_interrupt',
      commandId: 'interrupt-1',
      requestDigest: 'a'.repeat(64),
      sourceRunId: 'run-interrupt',
      sourceTurnId: base.turn.turnId,
      sourceModelInvocationId: 'model-interrupt',
      sourceToolCallId: 'interrupt-tool',
      sourceEffectAttemptId: 'interrupt-invocation:attempt:1',
      targetSessionId: 'child-1',
      targetRunId: 'child-run-1',
      targetTaskId: 'child-task-1',
      targetOwnerGeneration: 2,
      targetRevision: 8,
      createdAtMs: 1,
    } as const;
    const evidence = {
      ...commandEvidence(),
      scopeSessionId: 'state-session-test',
      commandId: 'interrupt-1',
    };
    const required = {
      sessionId: 'state-session-test',
      effectId: 'interrupt-effect',
      ownerId: 'owner',
    };
    expect(() =>
      session.commitCrossSessionInterruptCommand(
        lease,
        { ...event, executionId: 'sibling-task' },
        mutation,
        evidence,
        required,
      ),
    ).toThrow();
    expect(() =>
      session.commitCrossSessionInterruptCommand(
        lease,
        event,
        { ...mutation, sourceEffectAttemptId: 'stale-attempt' },
        evidence,
        required,
      ),
    ).toThrow();
    expect(f.writes).toHaveLength(0);
    const committed = session.commitCrossSessionInterruptCommand(
      lease,
      event,
      mutation,
      evidence,
      required,
    );
    expect(committed.receipt.committedRevision).toBe(1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      crossSessionAgentMailMutation: mutation,
      commandReceipt: committed.receipt,
      requiredEffectLease: { effectId: 'interrupt-effect', ownerId: 'owner' },
    });
    expect(f.acknowledgements).toEqual(['command_receipt_evidence']);
  });

  test('cross-Session TriggerTurn source commits backup, mail, receipt, and private mutation atomically', () => {
    const base = initialState();
    const runId = 'run-followup';
    const state: AgentState = {
      ...base,
      tools: {
        ...base.tools,
        active: ['follow-tool'],
        calls: {
          'follow-tool': {
            toolCallId: 'follow-tool',
            name: 'followup_task',
            modelMessageId: 'assistant-follow',
            args: {},
            modelInvocationId: 'model-follow',
            createdAtTurnId: base.turn.turnId,
            status: 'running',
          },
        },
      },
      transcript: {
        messages: [
          {
            kind: 'assistant',
            messageId: 'assistant-follow',
            turnId: base.turn.turnId,
            ordinal: 0,
            createdAt: NOW,
            modelInvocationId: 'model-follow',
            toolCalls: [{ id: 'follow-tool', name: 'followup_task', args: {} }],
          },
        ],
      },
      capabilities: {
        ...base.capabilities,
        invocations: {
          'follow-invocation': {
            invocationId: 'follow-invocation',
            toolCallId: 'follow-tool',
            capabilityId: 'builtin:followup_task',
            capabilityRevision: 'revision-1',
            argumentsDigest: 'arguments-1',
            authorizationDigest: 'authorization-1',
            effectiveEffectsDigest: 'effects-1',
            status: 'running',
            recordedAt: NOW,
            attemptsStarted: 1,
          },
        },
      },
      resourceBudget: {
        status: 'active',
        runId,
        startedAt: NOW,
        deadlineAt: new Date(Date.parse(NOW) + 180_000).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_,
        reconciledUsage: createZeroResourceUsage(),
        reservations: {},
        waiters: {},
        nextWaiterSequence: 0,
      },
    };
    const f = fixture(state, true);
    f.runs.set(`state-session-test\0${runId}`, {
      sessionId: 'state-session-test',
      runId,
      startCommandId: 'start-followup',
      phase: 'building',
      status: 'running',
      createdRevision: 0,
      lastRevision: 0,
      createdAtMs: 1,
    });
    const session = createRuntimeHostStateSession(f.input);
    const lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['follow-tool'] });
    const bodyDigest = `sha256:${'b'.repeat(64)}`;
    const reservationEvent = {
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'backup-followup',
        runId,
        invocationId: 'submission-followup',
        resourceKind: 'subagent',
        executableUpperBound: {
          ...createZeroResourceUsage('versioned_upper_bound', 'test-followup'),
          counters: {
            ...createZeroResourceUsage().counters,
            turns: 1,
            modelRequests: 1,
            inputTokens: 1_800,
            outputTokens: 100,
          },
          gauges: { ...createZeroResourceUsage().gauges, activeSubagents: 1 },
        },
        state: 'reserved',
      },
    } as const;
    const event = {
      type: 'agent.mail_accepted',
      messageId: 'mail-followup',
      senderAgentId: 'state-session-test',
      targetAgentId: 'child-1',
      mode: 'trigger_turn',
      source: {
        runId,
        turnId: base.turn.turnId,
        modelInvocationId: 'model-follow',
        toolCallId: 'follow-tool',
        effectAttemptId: 'follow-invocation:attempt:1',
      },
      bodyRef: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'agent_mail',
        integrityIdentifier: bodyDigest,
        byteLength: 5,
      },
      bodyDigest,
      sequence: 1,
      submissionId: 'submission-followup',
      followupAdmissionRef: {
        artifactId: `pa_${'c'.repeat(64)}`,
        kind: 'agent_followup_admission',
        integrityIdentifier: `sha256:${'c'.repeat(64)}`,
        byteLength: 2,
      },
      followupAdmissionDigest: `sha256:${'c'.repeat(64)}`,
    } as const;
    const mutation = {
      kind: 'accept_followup',
      messageId: event.messageId,
      targetSessionId: event.targetAgentId,
      commandId: event.messageId,
      requestDigest: 'a'.repeat(64),
      sourceRunId: runId,
      sourceTurnId: event.source.turnId,
      sourceModelInvocationId: event.source.modelInvocationId,
      sourceToolCallId: event.source.toolCallId,
      sourceEffectAttemptId: event.source.effectAttemptId,
      sourceSequence: 1,
      bodyText: 'hello',
      acceptedAtMs: 1,
      submissionId: event.submissionId,
      admission: {
        ref: event.followupAdmissionRef,
        digest: event.followupAdmissionDigest,
        canonicalJson: '{}',
        createdAt: 1,
      },
    } as const;
    const evidence = {
      ...commandEvidence(),
      scopeSessionId: 'state-session-test',
      commandId: event.messageId,
    };
    expect(() =>
      session.commitCrossSessionFollowupCommand(
        lease,
        reservationEvent,
        { ...event, source: { ...event.source, effectAttemptId: 'wrong' } },
        mutation,
        evidence,
        { sessionId: 'state-session-test', effectId: 'mail-effect', ownerId: 'owner' },
      ),
    ).toThrow();
    expect(f.writes).toHaveLength(0);
    f.failCommit = true;
    expect(() =>
      session.commitCrossSessionFollowupCommand(
        lease,
        reservationEvent,
        event,
        mutation,
        evidence,
        { sessionId: 'state-session-test', effectId: 'mail-effect', ownerId: 'owner' },
      ),
    ).toThrow('commit refused');
    expect(session.getState().revision).toBe(0);
    f.failCommit = false;
    const committed = session.commitCrossSessionFollowupCommand(
      lease,
      reservationEvent,
      event,
      mutation,
      evidence,
      { sessionId: 'state-session-test', effectId: 'mail-effect', ownerId: 'owner' },
    );
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      events: [reservationEvent, event],
      crossSessionAgentMailMutation: mutation,
      commandReceipt: committed.receipt,
      requiredEffectLease: { effectId: 'mail-effect', ownerId: 'owner' },
    });
    expect(committed.receipt.committedRevision).toBe(2);
    expect(f.acknowledgements).toEqual(['command_receipt_evidence']);
    const releaseMutation = {
      kind: 'release_current_turn_backup' as const,
      targetSessionId: 'child-1',
      submissionId: 'submission-followup',
      targetRunId: 'old-child-run',
      invocationId: 'old-child-model',
      modelAdmissionId: 'old-child-model-reservation',
      reservationId: 'old-child-model-reservation',
      targetRevision: 4,
      createdAtMs: 5,
    };
    expect(() => session.commitCrossSessionFollowupFunding([], releaseMutation)).toThrow();
    const releaseEvent = {
      type: 'resource_budget.released' as const,
      reservationId: 'backup-followup',
    };
    expect(session.commitCrossSessionFollowupFunding([releaseEvent], releaseMutation)).toEqual([
      releaseEvent,
    ]);
    expect(f.writes.at(-1)).toMatchObject({
      events: [releaseEvent],
      crossSessionAgentMailMutation: releaseMutation,
    });
  });

  test('cross-Session target receipt commits only its own State and inbox mutation', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const event = {
      type: 'agent.mail_accepted',
      messageId: 'mail-target-1',
      senderAgentId: 'child-1',
      targetAgentId: 'state-session-test',
      mode: 'queue_only',
      source: {
        runId: 'child-run',
        turnId: 'child-turn',
        modelInvocationId: 'child-model',
        toolCallId: 'child-tool',
        effectAttemptId: 'child-invocation:attempt:1',
      },
      bodyRef: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'agent_mail',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 5,
      },
      bodyDigest: `sha256:${'b'.repeat(64)}`,
      sequence: 1,
    } as const;
    const mutation = {
      kind: 'receive_queue',
      sourceSessionId: 'child-1',
      messageId: 'mail-target-1',
      receivedAtMs: 1,
    } as const;
    expect(() =>
      session.commitCrossSessionQueueMailReceive(event, {
        ...mutation,
        sourceSessionId: 'other-child',
      }),
    ).toThrow();
    expect(f.writes).toHaveLength(0);
    f.failCommit = true;
    expect(() => session.commitCrossSessionQueueMailReceive(event, mutation)).toThrow(
      'commit refused',
    );
    expect(session.getState().revision).toBe(0);
    f.failCommit = false;
    expect(session.commitCrossSessionQueueMailReceive(event, mutation)).toEqual([event]);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      crossSessionAgentMailMutation: mutation,
      snapshot: { revision: 1 },
    });
    expect(f.writes[0]?.commandReceipt).toBeUndefined();
    expect(f.acknowledgements).toEqual(['decision']);
  });

  test('cross-Session model input commits prepared model and mail watermark together', () => {
    const f = fixture(initialState(), true);
    f.runs.set('state-session-test\0run-model-mail', {
      sessionId: 'state-session-test',
      runId: 'run-model-mail',
      startCommandId: 'start-model-mail',
      phase: 'building',
      status: 'running',
      createdRevision: 0,
      lastRevision: 0,
      createdAtMs: 1,
    });
    const session = createRuntimeHostStateSession(f.input);
    const lease = session.beginEffect({ type: 'call_model' });
    const events: KernelEvent[] = [
      preparedModelEvent('model-cross'),
      {
        type: 'agent.mail_input_prepared',
        targetAgentId: 'state-session-test',
        invocationId: 'model-cross',
        modelAdmissionId: 'model-cross',
        fromSequence: 0,
        throughSequence: 7,
        messageIds: ['mail-7'],
      },
    ];
    const mutation = {
      kind: 'prepare_queue_input',
      modelInvocationId: 'model-cross',
      modelAdmissionId: 'model-cross',
      currentRunId: 'run-model-mail',
      fromSequence: 0,
      throughSequence: 7,
      messageIds: ['mail-7'],
    } as const;
    expect(() =>
      session.commitCrossSessionQueueMailModelInput(lease, events, {
        ...mutation,
        currentRunId: 'later-run',
      }),
    ).toThrow();
    expect(f.writes).toHaveLength(0);
    f.failCommit = true;
    expect(() => session.commitCrossSessionQueueMailModelInput(lease, events, mutation)).toThrow(
      'commit refused',
    );
    expect(session.getState().revision).toBe(0);
    f.failCommit = false;
    expect(session.commitCrossSessionQueueMailModelInput(lease, events, mutation)).toEqual(events);
    expect(f.writes[0]).toMatchObject({
      events,
      crossSessionAgentMailMutation: mutation,
      snapshot: { revision: 2 },
    });
    expect(f.writes[0]?.commandReceipt).toBeUndefined();
    expect(f.acknowledgements).toEqual(['decision']);
  });

  test('rejects Agent mail identity or Store refusal without partial receipt, row, or State', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const { event, mutation } = agentMailAcceptance();
    const lease = { sessionId: 'state-session-test', effectId: 'effect-1', ownerId: 'owner-1' };
    const evidence = { ...commandEvidence(), commandId: event.messageId };
    expect(() =>
      session.commitAgentMailboxCommand(
        [event],
        [{ ...mutation, requestDigest: 'f'.repeat(64) }],
        evidence,
        lease,
      ),
    ).toThrow(/receipt/u);
    expect(f.writes).toHaveLength(0);
    f.failCommit = true;
    expect(() => session.commitAgentMailboxCommand([event], [mutation], evidence, lease)).toThrow(
      'commit refused',
    );
    expect(f.writes).toHaveLength(0);
    expect(session.getState().revision).toBe(0);
  });

  test('commits terminal-derived Agent reply without inventing a command receipt', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const { event, mutation } = agentMailAcceptance('reply');
    expect(session.commitAgentMailboxDerived([event], [mutation])).toEqual([event]);
    expect(f.acknowledgements).toEqual(['receipt_evidence']);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      agentMailboxMutations: [mutation],
      snapshot: { revision: 1 },
    });
    expect(f.writes[0]?.commandReceipt).toBeUndefined();
    expect(() =>
      session.commitAgentMailboxDerived(
        [{ ...event, mode: 'queue_only' }],
        [{ ...mutation, mode: 'queue_only' }],
      ),
    ).toThrow(/terminal-derived/u);
  });

  test('adds root Agent identity to the existing Session command transaction', () => {
    const f = fixture(initialState(), true);
    const runs = f.input.services.runs!;
    f.input = {
      ...f.input,
      services: {
        ...f.input.services,
        runs: {
          ...runs,
          list: () => {
            throw new Error('Runtime Session is not admitted.');
          },
        },
      },
    };
    const session = createRuntimeHostStateSession(f.input);
    const event: KernelEvent = {
      type: 'agent.created',
      agentId: 'state-session-test',
      parentAgentId: null,
    };
    const mutation: RuntimeAgentMailboxMutation = {
      kind: 'create_agent',
      agentId: 'state-session-test',
      parentAgentId: null,
      createdAtMs: 1_700_000_000_000,
    };
    const committed = session.commitCommandBatch([event], commandEvidence(), undefined, [mutation]);
    expect(committed.receipt.committedRevision).toBe(1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      agentMailboxMutations: [mutation],
      commandReceipt: committed.receipt,
      snapshot: { revision: 1 },
    });
  });

  test('commits a child turn start as one metadata transaction and rejects mismatched rows', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const event: KernelEvent = {
      type: 'agent.turn_started',
      agentId: 'child',
      taskId: 'child-turn-2',
      turnOrdinal: 1,
      submissionId: 'submission-1',
      ownerGeneration: 'owner-1',
      grantDigest: `sha256:${'e'.repeat(64)}`,
    };
    const mutation: RuntimeAgentMailboxMutation = {
      kind: 'turn_started',
      agentId: 'child',
      taskId: 'child-turn-2',
      turnOrdinal: 1,
      submissionId: 'submission-1',
    };
    expect(() =>
      session.commitAgentMailboxFacts([event], [{ ...mutation, taskId: 'wrong-task' }]),
    ).toThrow(/exact canonical event/u);
    expect(f.writes).toHaveLength(0);
    expect(session.commitAgentMailboxFacts([event], [mutation])).toEqual([event]);
    expect(f.writes[0]).toMatchObject({
      events: [event],
      agentMailboxMutations: [mutation],
      snapshot: { revision: 1 },
    });
    expect(f.writes[0]?.commandReceipt).toBeUndefined();
  });

  test('settles an exact background child and Agent row atomically, then replays without another result', () => {
    const f = fixture(initialState(), true);
    const session = createRuntimeHostStateSession(f.input);
    session.commitCommandBatch([{ type: 'turn.started', turnId: 'run-1' }], {
      ...commandEvidence(),
      runStart: { runId: 'run-1', phase: 'building' },
    });
    session.activateRun('run-1');
    session.processEventBatch([
      {
        type: 'tool.queued',
        toolCallId: 'task-1',
        name: 'task',
        modelInvocationId: 'parent-model-1',
        args: {
          name: 'Child',
          subagent_type: 'review',
          task: 'Inspect',
          background: true,
          result_disposition: 'required',
        },
      },
      { type: 'tool.started', toolCallId: 'task-1' },
      {
        type: 'capability.invocation_recorded',
        invocationId: 'inv-1',
        toolCallId: 'task-1',
        capabilityId: 'builtin:task',
        capabilityRevision: 'task-v1',
        argumentsDigest: 'args',
        authorizationDigest: 'auth',
        admissionDigest: 'admission',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
        receiptRequirement: 'observation_receipt',
        recordedAt: NOW,
      },
      { type: 'capability.execution_started', invocationId: 'inv-1', attempt: 1, startedAt: NOW },
      {
        type: 'capability.subagent_dispatch_intent_recorded',
        invocationId: 'inv-1',
        attempt: 1,
        purpose: 'start',
        childInvocationId: 'child-1',
        taskArtifact: {
          kind: 'subagent_task',
          artifactId: `pa_${'a'.repeat(64)}`,
          integrityIdentifier: `sha256:${'b'.repeat(64)}`,
          byteLength: 1,
        },
        dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
        recordedAt: NOW,
      },
      {
        type: 'capability.subagent_handle_recorded',
        invocationId: 'inv-1',
        attempt: 1,
        dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
        handleArtifact: {
          kind: 'subagent_handle',
          artifactId: `pa_${'c'.repeat(64)}`,
          integrityIdentifier: `sha256:${'e'.repeat(64)}`,
          byteLength: 1,
        },
        handleIntegrityIdentifier: `sha256:${'e'.repeat(64)}`,
        recordedAt: NOW,
      },
      {
        type: 'capability.subagent_observation_recorded',
        invocationId: 'inv-1',
        attempt: 1,
        dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
        status: 'completed',
        observedAt: NOW,
      },
      {
        type: 'capability.subagent_cleanup_started',
        invocationId: 'inv-1',
        attempt: 1,
        dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
        cleanupAttempt: 1,
        cleanupKind: 'handle_reconcile',
        startedAt: NOW,
      },
      {
        type: 'capability.subagent_cleanup_completed',
        invocationId: 'inv-1',
        attempt: 1,
        dispatchIntentDigest: `sha256:${'d'.repeat(64)}`,
        cleanupAttempt: 1,
        cleanupKind: 'handle_reconcile',
        cleanupConfirmed: true,
        completedAt: NOW,
      },
    ]);
    const ref = {
      kind: 'subagent_task' as const,
      artifactId: `pa_${'f'.repeat(64)}`,
      integrityIdentifier: `sha256:${'1'.repeat(64)}`,
      byteLength: 128,
    };
    const resultEvent = {
      type: 'subagent.background_result_persisted' as const,
      taskId: 'child-1',
      notificationId: `subagent:child-1:${ref.integrityIdentifier}`,
      artifactIntegrityIdentifier: ref.integrityIdentifier,
      shortReport: 'Completed.',
      source: 'subagent' as const,
      modelRole: 'user' as const,
      originRunId: 'run-1',
      originTurnId: 'run-1',
      originToolCallId: 'task-1',
      attempt: 1,
    };
    const grantDigest = `sha256:${'2'.repeat(64)}`;
    const active = { agentId: 'child-1', currentTaskId: 'child-1', status: 'active' as const };
    const input = {
      resultEvent,
      resultRef: ref,
      grantDigest,
      readResultArtifact: () => ({ ok: true, terminalStatus: 'completed' }),
      activeTaskProof: { ownerGeneration: '7', grantDigest },
      agent: active,
    };
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const bodyText =
      'Agent task child-1 completed. Use task_read with this task_id for the full result.';
    const bodyHex = hash(bodyText);
    const bodyDigest = `sha256:${bodyHex}`;
    const messageId = `mail_${hash(
      JSON.stringify([
        'background_terminal_reply_v1',
        'state-session-test',
        'child-1',
        resultEvent.notificationId,
      ]),
    )}`;
    const source = {
      runId: 'run-1',
      turnId: 'run-1',
      modelInvocationId: 'parent-model-1',
      toolCallId: 'task-1',
      effectAttemptId: 'inv-1:attempt:1',
      sourceTaskId: 'child-1',
    };
    const bodyRef = {
      artifactId: `pa_${bodyHex}`,
      kind: 'agent_mail' as const,
      integrityIdentifier: bodyDigest,
      byteLength: Buffer.byteLength(bodyText, 'utf8'),
    };
    const replyEvent = {
      type: 'agent.mail_accepted' as const,
      messageId,
      senderAgentId: 'child-1',
      targetAgentId: 'state-session-test',
      mode: 'reply' as const,
      source,
      bodyRef,
      bodyDigest,
      sequence: 1,
    };
    const replyMutation = {
      kind: 'accept_mail' as const,
      ...replyEvent,
      bodyText,
      requestDigest: hash(
        JSON.stringify([messageId, 'state-session-test', 'reply', bodyDigest, source]),
      ),
      acceptedAtMs: 1_700_000_000_000,
    };
    const withReply = { ...input, reply: { event: replyEvent, mutation: replyMutation } };
    const writesBefore = f.writes.length;
    expect(() =>
      session.commitBackgroundAgentSettlement({
        ...input,
        activeTaskProof: { ownerGeneration: '7', grantDigest: `sha256:${'3'.repeat(64)}` },
      }),
    ).toThrow('active task proof');
    expect(() =>
      session.commitBackgroundAgentSettlement({
        ...input,
        resultRef: { ...ref, byteLength: ref.byteLength + 1 },
        readResultArtifact: () => {
          throw new Error('full-ref mismatch');
        },
      }),
    ).toThrow('full-ref mismatch');
    expect(() =>
      session.commitBackgroundAgentSettlement({
        ...input,
        resultEvent: { ...resultEvent, originToolCallId: 'wrong-tool' },
      }),
    ).toThrow('origin is not an exact settled child');
    expect(() =>
      session.commitBackgroundAgentSettlement({
        ...withReply,
        reply: { event: replyEvent, mutation: { ...replyMutation, bodyText: 'changed' } },
      }),
    ).toThrow('terminal reply identity is invalid');
    expect(f.writes).toHaveLength(writesBefore);
    const stateBeforeJoint = session.getState();
    expect(session.commitBackgroundAgentSettlement(withReply)).toMatchObject({ mode: 'joint' });
    expect(f.writes).toHaveLength(writesBefore + 1);
    expect(f.writes.at(-1)).toMatchObject({
      events: [
        resultEvent,
        {
          type: 'agent.task_settled',
          agentId: 'child-1',
          taskId: 'child-1',
          ownerGeneration: '7',
          status: 'completed',
          resultRef: ref,
        },
        replyEvent,
      ],
      agentMailboxMutations: [
        { kind: 'task_settled', agentId: 'child-1', taskId: 'child-1' },
        replyMutation,
      ],
    });
    expect(
      session.commitBackgroundAgentSettlement({
        ...withReply,
        activeTaskProof: null,
        agent: { ...active, status: 'context_unavailable' },
      }),
    ).toMatchObject({ mode: 'replay', events: [] });
    expect(f.writes).toHaveLength(writesBefore + 1);

    // The original result may have committed just before a crash. Recovery
    // fills only the missing Agent row, without re-emitting the old result.
    const recovered = fixture(stateBeforeJoint, true);
    for (const [key, run] of f.runs) recovered.runs.set(key, run);
    const recoverySession = createRuntimeHostStateSession(recovered.input);
    recoverySession.processEvent(resultEvent);
    const recoveryWrites = recovered.writes.length;
    expect(recoverySession.commitBackgroundAgentSettlement(withReply)).toMatchObject({
      mode: 'agent_only',
      events: [{ type: 'agent.task_settled', taskId: 'child-1' }, replyEvent],
    });
    expect(recovered.writes).toHaveLength(recoveryWrites + 1);
    expect(recovered.writes.at(-1)?.events.map((event) => event.type)).toEqual([
      'agent.task_settled',
      'agent.mail_accepted',
    ]);
  });

  test('commits before publishing state and makes duplicate replay a no-write', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    f.failCommit = true;
    expect(() => session.processEvent(message('message-1'))).toThrow('commit refused');
    expect(session.getState().revision).toBe(0);
    expect(f.writes).toHaveLength(0);

    f.failCommit = false;
    expect(session.processEvent(message('message-1')).status).toBe('applied');
    expect(session.getState().revision).toBe(1);
    expect(f.writes).toHaveLength(1);
    expect(session.processEvent(message('message-1')).status).toBe('duplicate');
    expect(f.writes).toHaveLength(1);
    expect(session.getLastAppliedEvents()).toEqual([]);
  });

  test('binds an applied receipt to the accepted State revision in one command decision', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const committed = session.commitCommandBatch([message('command-message')], commandEvidence());

    expect(committed.events).toMatchObject([message('command-message')]);
    expect(committed.receipt).toMatchObject({
      scopeSessionId: 'scope-session',
      commandId: 'command-1',
      requestDigest: 'a'.repeat(64),
      targetSessionId: 'state-session-test',
      committedRevision: 1,
      committedAt: 1_700_000_000_000,
      originalReceiptJson:
        '{"status":"applied","commandId":"command-1","sessionId":"state-session-test","revision":1}',
    });
    expect(f.acknowledgements).toEqual(['command_decision']);
    expect(f.writes[0]?.commandReceipt).toEqual(committed.receipt);
    expect(session.getState().revision).toBe(1);
  });

  test('commits queued Run/resource, activation, interaction and cancellation from one clock', () => {
    const f = fixture(initialState(), true);
    const session = createRuntimeHostStateSession(f.input);
    const evidence = {
      ...commandEvidence(),
      runStart: { runId: 'run-1', phase: 'building' as const },
    };
    const committed = session.commitCommandBatch(
      [{ type: 'turn.started', turnId: 'run-1' }],
      evidence,
    );
    expect(f.writes[0]?.runMutation).toMatchObject({
      type: 'insert',
      run: {
        runId: 'run-1',
        status: 'queued',
        createdRevision: 1,
        createdAtMs: Date.parse(NOW),
      },
    });
    expect(committed.receipt.resourceResult).toMatchObject({
      schema: 'kite.runtime.run-resource-result.v1',
    });
    expect(f.runs.get('state-session-test\0run-1')).toMatchObject({ status: 'queued' });

    session.activateRun('run-1');
    expect(f.acknowledgements).toEqual(['command_decision', 'attempt_start']);
    expect(f.runs.get('state-session-test\0run-1')).toMatchObject({
      status: 'running',
      startedAtMs: Date.parse(NOW),
    });

    session.processEventBatch([
      { type: 'tool.queued', toolCallId: 'ask-1', name: 'ask_user', args: {} },
      {
        type: 'user_input.requested',
        interactionId: 'input-1',
        toolCallId: 'ask-1',
        request: { question: 'Continue?', options: [], allow_free_text: true },
      },
    ]);
    expect(f.runs.get('state-session-test\0run-1')).toMatchObject({ status: 'waiting' });
    session.processEvent({
      type: 'user_input.answered',
      interactionId: 'input-1',
      toolCallId: 'ask-1',
      answer: 'yes',
    });
    expect(f.runs.get('state-session-test\0run-1')).toMatchObject({ status: 'running' });

    session.processEvent({
      type: 'turn.aborted',
      turnId: 'run-1',
      reason: 'Cancelled by user.',
      cause: 'user',
    });
    expect(f.runs.get('state-session-test\0run-1')).toMatchObject({
      status: 'cancelled',
      finishedAtMs: Date.parse(NOW),
      terminal: { reasonCode: 'cancelled', recoveryEntry: 'new_run' },
    });
  });

  test('settles an old admission and resumes its waiting Run in the command transaction', () => {
    const f = fixture(initialState(), true);
    const session = createRuntimeHostStateSession(f.input);
    session.commitCommandBatch([{ type: 'turn.started', turnId: 'run-1' }], {
      ...commandEvidence(),
      runStart: { runId: 'run-1', phase: 'building' },
    });
    session.activateRun('run-1');
    session.processEvent({
      type: 'provider.admission_required',
      interactionId: 'old-global-gate',
      providerId: 'offline-provider',
      source: 'explicit',
      providerStatus: 'login_required',
      retryable: true,
    });
    expect(f.runs.get('state-session-test\0run-1')?.status).toBe('waiting');
    const before = session.getState();
    f.failCommit = true;
    expect(() =>
      session.commitCommandBatch(
        [
          {
            type: 'provider.admission_cancelled',
            interactionId: 'old-global-gate',
            providerId: 'offline-provider',
          },
        ],
        commandEvidence(),
      ),
    ).toThrow('commit refused');
    expect(session.getState()).toBe(before);
    expect(f.runs.get('state-session-test\0run-1')?.status).toBe('waiting');

    f.failCommit = false;
    const committed = session.commitCommandBatch(
      [
        {
          type: 'provider.admission_cancelled',
          interactionId: 'old-global-gate',
          providerId: 'offline-provider',
        },
      ],
      commandEvidence(),
    );
    const transaction = f.writes.at(-1);
    expect(transaction?.events.map((event) => event.type)).toEqual([
      'provider.admission_cancelled',
    ]);
    expect(transaction?.commandReceipt).toEqual(committed.receipt);
    expect(transaction?.runMutation).toMatchObject({
      type: 'transition',
      transition: { next: { runId: 'run-1', status: 'running' } },
    });
    expect(f.runs.get('state-session-test\0run-1')?.status).toBe('running');
    expect(session.getState().providerAdmission.waivers).toEqual({});
  });

  test('projects required background waiting as non-terminal and resumes the same Run on wake', () => {
    const f = fixture(initialState(), true);
    const session = createRuntimeHostStateSession(f.input);
    session.commitCommandBatch([{ type: 'turn.started', turnId: 'run-background' }], {
      ...commandEvidence(),
      runStart: { runId: 'run-background', phase: 'building' },
    });
    session.activateRun('run-background');
    session.processEventBatch([
      {
        type: 'tool.queued',
        toolCallId: 'task-background',
        name: 'task',
        args: {
          name: 'inspect',
          subagent_type: 'explore',
          task: 'inspect runtime',
          background: true,
          result_disposition: 'required',
        },
      },
      { type: 'tool.started', toolCallId: 'task-background' },
      {
        type: 'tool.finished',
        toolCallId: 'task-background',
        name: 'task',
        result: {
          ok: true,
          command: 'task',
          exitCode: 0,
          stdout: 'accepted',
          stderr: '',
          resultMeta: {
            taskId: 'child-background',
            taskStatus: 'running',
            taskDisposition: 'required',
          },
        },
      },
      { type: 'model.responded', messageId: 'premature-final', text: 'Done.' },
    ]);
    session.processEvent({
      type: 'completion.blocked',
      turnId: 'run-background',
      guardVersion: 'completion_guard_v1',
      code: 'tool_pending',
      nextAction: 'wait_for_background',
      planning: 'building_without_plan',
      correctionAttempt: 0,
      backgroundTaskIds: ['child-background'],
    });
    expect(f.runs.get('state-session-test\0run-background')).toMatchObject({
      runId: 'run-background',
      status: 'waiting',
    });
    expect(f.runs.get('state-session-test\0run-background')?.finishedAtMs).toBeUndefined();
    expect(session.getLifecycleProjection().currentRun).toMatchObject({
      runId: 'run-background',
      status: 'waiting',
      waitingReason: {
        kind: 'required_background',
        taskIds: ['child-background'],
      },
    });

    session.processEvent({
      type: 'subagent.background_result_persisted',
      taskId: 'child-background',
      notificationId: `subagent:child-background:sha256:${'a'.repeat(64)}`,
      artifactIntegrityIdentifier: `sha256:${'a'.repeat(64)}`,
      shortReport: 'Child completed.',
      source: 'subagent',
      modelRole: 'user',
      originRunId: 'run-background',
      originTurnId: 'run-background',
      originToolCallId: 'tool-background',
      attempt: 1,
    });
    expect(f.runs.get('state-session-test\0run-background')?.status).toBe('waiting');
    session.processEvent(preparedModelEvent('model-after-background-wake'));
    expect(f.runs.get('state-session-test\0run-background')).toMatchObject({
      runId: 'run-background',
      status: 'running',
    });
    expect(f.runs.get('state-session-test\0run-background')?.finishedAtMs).toBeUndefined();
  });

  test('keeps a queued Run unchanged when its activation transaction fails', () => {
    const f = fixture(initialState(), true);
    const session = createRuntimeHostStateSession(f.input);
    session.commitCommandBatch([{ type: 'turn.started', turnId: 'run-1' }], {
      ...commandEvidence(),
      runStart: { runId: 'run-1', phase: 'building' },
    });
    f.failCommit = true;

    expect(() => session.activateRun('run-1')).toThrow('commit refused');
    expect(f.runs.get('state-session-test\0run-1')).toMatchObject({ status: 'queued' });
  });

  test('keeps the accepted Run identity across a continuation Turn and terminal closure', () => {
    const f = fixture(initialState(), true);
    const session = createRuntimeHostStateSession(f.input);
    session.commitCommandBatch([{ type: 'turn.started', turnId: 'run-initial' }], {
      ...commandEvidence(),
      runStart: { runId: 'run-initial', phase: 'building' },
    });
    session.activateRun('run-initial');

    session.processEvent({ type: 'turn.started', turnId: 'turn-continuation' });
    expect(session.getState().turn).toMatchObject({
      turnId: 'turn-continuation',
      status: 'active',
    });
    expect(f.writes.at(-1)?.runMutation).toMatchObject({
      type: 'transition',
      transition: {
        runId: 'run-initial',
        next: { runId: 'run-initial', status: 'running', lastRevision: 2 },
      },
    });

    session.processEvent({ type: 'turn.completed', turnId: 'turn-continuation' });
    expect(f.runs.get('state-session-test\0run-initial')).toMatchObject({
      runId: 'run-initial',
      status: 'completed',
      lastRevision: 3,
    });
    expect(f.runs.has('state-session-test\0turn-continuation')).toBe(false);
    expect(session.getLifecycleProjection()).toEqual({
      currentRun: {
        runId: 'run-initial',
        initialTurnId: 'run-initial',
        activeTurnId: 'turn-continuation',
        status: 'completed',
        revision: 3,
        outcome: { reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' },
      },
    });
  });

  test('hydrates the most recently settled Run when no Run remains active', () => {
    const state = { ...initialState(), revision: 6 } as AgentState;
    const f = fixture(state, true);
    f.runs.set('state-session-test\0run-old', {
      sessionId: 'state-session-test',
      runId: 'run-old',
      startCommandId: 'start-old',
      phase: 'building',
      status: 'completed',
      createdRevision: 1,
      lastRevision: 3,
      createdAtMs: 100,
      startedAtMs: 110,
      finishedAtMs: 120,
      terminal: { reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' },
    });
    f.runs.set('state-session-test\0run-new', {
      sessionId: 'state-session-test',
      runId: 'run-new',
      startCommandId: 'start-new',
      phase: 'building',
      status: 'cancelled',
      createdRevision: 4,
      lastRevision: 6,
      createdAtMs: 200,
      startedAtMs: 210,
      finishedAtMs: 220,
      terminal: { reasonCode: 'cancelled', safeRetry: true, recoveryEntry: 'new_run' },
    });
    const session = createRuntimeHostStateSession(f.input);

    expect(session.getLifecycleProjection()).toEqual({
      currentRun: {
        runId: 'run-new',
        initialTurnId: 'run-new',
        activeTurnId: 'turn-1',
        status: 'cancelled',
        revision: 6,
        outcome: { reasonCode: 'cancelled', safeRetry: true, recoveryEntry: 'new_run' },
      },
    });
  });

  test('projects a queued predecessor revision with the Run visible at that revision', () => {
    const state = { ...initialState(), revision: 5 } as AgentState;
    const f = fixture(state, true);
    f.runs.set('state-session-test\0run-old', {
      sessionId: 'state-session-test',
      runId: 'run-old',
      startCommandId: 'start-old',
      phase: 'building',
      status: 'cancelled',
      createdRevision: 1,
      lastRevision: 4,
      createdAtMs: 100,
      startedAtMs: 110,
      finishedAtMs: 120,
      terminal: { reasonCode: 'cancelled', safeRetry: false, recoveryEntry: 'new_run' },
    });
    f.runs.set('state-session-test\0run-new', {
      sessionId: 'state-session-test',
      runId: 'run-new',
      startCommandId: 'start-new',
      phase: 'building',
      status: 'queued',
      createdRevision: 6,
      lastRevision: 6,
      createdAtMs: 200,
    });
    const session = createRuntimeHostStateSession(f.input);

    expect(session.getLifecycleProjection(state).currentRun).toMatchObject({
      runId: 'run-old',
      initialTurnId: 'run-old',
      status: 'cancelled',
      revision: 4,
    });
  });

  test('refines a recovered unknown Run only to a precise terminal without moving its finish clock', () => {
    const f = fixture(initialState(), true);
    f.runs.set('state-session-test\0turn-1', {
      sessionId: 'state-session-test',
      runId: 'turn-1',
      startCommandId: 'start-turn-1',
      phase: 'building',
      status: 'unknown',
      createdRevision: 0,
      lastRevision: 0,
      createdAtMs: 100,
      startedAtMs: 110,
      finishedAtMs: 120,
      terminal: {
        reasonCode: 'outcome_unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      },
    });
    const session = createRuntimeHostStateSession(f.input);

    session.processEventBatch([{ type: 'turn.completed', turnId: 'turn-1' }], {
      acknowledgement: 'terminal_recovery',
      source: 'host_fact',
    });

    expect(f.acknowledgements).toEqual(['terminal_recovery']);
    expect(f.runs.get('state-session-test\0turn-1')).toMatchObject({
      status: 'completed',
      lastRevision: 1,
      finishedAtMs: 120,
      terminal: { reasonCode: 'completed', recoveryEntry: 'none' },
    });
  });

  test('atomically receipts a snapshot-only lifecycle decision without advancing State', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const receipt = session.commitCommandSnapshot(commandEvidence());

    expect(receipt).toMatchObject({
      scopeSessionId: 'scope-session',
      commandId: 'command-1',
      targetSessionId: 'state-session-test',
      committedRevision: 0,
    });
    expect(f.acknowledgements).toEqual(['command_decision']);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      sessionId: 'state-session-test',
      events: [],
      metadata: [],
      commandReceipt: receipt,
    });
    expect(session.getState().revision).toBe(0);
    expect(session.getLastAppliedEvents()).toEqual([]);
  });

  test('commits a recovered followup unknown ACK without repeating budget events', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const mutation = {
      kind: 'settle_followup_funding_after_unknown_recovery' as const,
      targetSessionId: 'child',
      submissionId: 'submission',
      targetRunId: 'child-run',
      modelInvocationId: 'model',
      targetRevision: 7,
      createdAtMs: 40,
    };
    session.commitCrossSessionFollowupUnknownAck(mutation);
    expect(f.acknowledgements).toEqual(['decision']);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      sessionId: 'state-session-test',
      events: [],
      metadata: [],
      crossSessionAgentMailMutation: mutation,
    });
    expect(session.getState().revision).toBe(0);
    expect(session.getLastAppliedEvents()).toEqual([]);
    f.failCommit = true;
    expect(() => session.commitCrossSessionFollowupUnknownAck(mutation)).toThrow('commit refused');
    expect(f.writes).toHaveLength(1);
  });

  test('keeps snapshot-only State unchanged when the receipt transaction fails', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    f.failCommit = true;

    expect(() => session.commitCommandSnapshot(commandEvidence())).toThrow('commit refused');
    expect(f.writes).toHaveLength(0);
    expect(session.getState().revision).toBe(0);
    expect(session.getLastAppliedEvents()).toEqual([]);
  });

  test('fails closed for invalid receipt evidence and failed command transactions', () => {
    const invalid = fixture();
    const invalidSession = createRuntimeHostStateSession(invalid.input);
    expect(() =>
      invalidSession.commitCommandBatch([message('invalid-command')], {
        ...commandEvidence(),
        requestDigest: 'not-a-digest',
      }),
    ).toThrow('digest is invalid');
    expect(invalid.writes).toHaveLength(0);
    expect(invalidSession.getState().revision).toBe(0);

    const wrongTarget = fixture();
    const wrongTargetSession = createRuntimeHostStateSession(wrongTarget.input);
    expect(() =>
      wrongTargetSession.commitCommandBatch([message('wrong-target')], {
        ...commandEvidence(),
        targetSessionId: 'another-session',
      }),
    ).toThrow('target does not match');
    expect(wrongTarget.writes).toHaveLength(0);

    const failed = fixture();
    const failedSession = createRuntimeHostStateSession(failed.input);
    failed.failCommit = true;
    expect(() =>
      failedSession.commitCommandBatch([message('failed-command')], commandEvidence()),
    ).toThrow('commit refused');
    expect(failed.writes).toHaveLength(0);
    expect(failedSession.getState().revision).toBe(0);
  });

  test('binds one Host timestamp to the returned and persisted event identity', () => {
    const f = fixture();
    let tick = 0;
    const session = createRuntimeHostStateSession({
      ...f.input,
      clock: () => {
        tick += 1;
        return `2026-08-21T00:00:0${tick}.000Z`;
      },
    });
    const result = session.processEvent(message('single-clock'));
    expect(result.eventId).toBe(f.writes[0]?.metadata?.[0]?.eventId ?? '');
    expect(tick).toBe(1);
  });

  test('fails closed on invalid facts, admission, and invariant input without a write', () => {
    const invalidClock = fixture();
    const invalidSession = createRuntimeHostStateSession({
      ...invalidClock.input,
      clock: () => 'not-a-state-time',
    });
    expect(() => invalidSession.processEvent(message('invalid-time'))).toThrow(/timestamp/u);
    expect(invalidClock.writes).toHaveLength(0);

    const rejected = fixture();
    const admitted = createRuntimeHostStateSession({
      ...rejected.input,
      eventBatchAdmissionValidator: () => false,
    });
    expect(() => admitted.processEvent(message('rejected'))).toThrow(/admission/u);
    expect(rejected.writes).toHaveLength(0);

    expect(() =>
      createRuntimeHostStateSession({
        ...fixture().input,
        state: { ...initialState(), revision: -1 },
      }),
    ).toThrow();
  });

  test('retains a failed-restore State hard block until the runner durably aborts it', () => {
    const blockedState: AgentState = {
      ...initialState(),
      recoveryState: { kind: 'corrupted', reason: 'snapshot checksum mismatch' },
    };
    const f = fixture(blockedState);
    const session = createRuntimeHostStateSession(f.input);
    expect(session.selectPendingEffects()[0]).toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
    });
    expect(f.writes).toHaveLength(0);
  });

  test('keeps one runner and fences effect transactions to the exact lease owner', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const runner = session.acquireRunner();
    expect(runner).toBeString();
    expect(session.acquireRunner()).toBeNull();
    session.releaseRunner('wrong-runner');
    expect(session.acquireRunner()).toBeNull();
    session.releaseRunner(runner!);
    const replacementRunner = session.acquireRunner();
    expect(replacementRunner).toBeString();
    session.releaseRunner(replacementRunner!);

    const lease = session.beginEffect({ type: 'call_model' });
    expect(session.isEffectLeaseCurrent(lease)).toBe(true);
    expect(session.applyEvent(lease, message('effect-event'))).toBe(true);
    expect(f.acknowledgements).toEqual(['receipt_evidence']);
    expect(f.writes[0]?.requiredEffectLease).toBeUndefined();
    expect(f.leaseCalls).toEqual([]);

    const externalLease = {
      sessionId: session.sessionId,
      effectId: 'compaction-effect-1',
      ownerId: 'compaction-owner-1',
    };
    expect(session.applyEvent(lease, message('external-lease-event'), externalLease)).toBe(true);
    expect(f.requiredLeases[0]).toEqual(externalLease);

    const lost = session.beginEffect({ type: 'call_model' });
    session.releaseEffect(lost);
    expect(session.isEffectLeaseCurrent(lost)).toBe(false);
    expect(session.applyEvent(lost, message('lost-event'))).toBe(false);
    expect(f.writes).toHaveLength(2);
  });

  test('rejects current-turn routing outside the exact live Model effect lease', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const events = [
      {
        type: 'agent.followup_routed',
        submissionId: 'submission',
        targetAgentId: session.sessionId,
        route: 'current_turn',
        taskId: 'task',
        invocationId: 'model',
        modelAdmissionId: 'reservation',
        reservationId: 'reservation',
        fundingRunId: 'turn-1',
        sequence: 1,
      },
      {
        type: 'agent.mail_input_prepared',
        targetAgentId: session.sessionId,
        invocationId: 'model',
        modelAdmissionId: 'reservation',
        fromSequence: 0,
        throughSequence: 1,
        messageIds: ['message'],
      },
    ] as unknown as Parameters<typeof session.commitCrossSessionFollowupRouteForModelEffect>[1];
    const mutation = {
      kind: 'route_followup',
      sourceSessionId: 'parent',
      messageId: 'message',
      submissionId: 'submission',
      route: 'current_turn',
      targetRunId: 'turn-1',
      taskId: 'task',
      invocationId: 'model',
      modelAdmissionId: 'reservation',
      reservationId: 'reservation',
      createdAtMs: 1,
    } as const;
    const stale = session.beginEffect({ type: 'call_model' });
    session.releaseEffect(stale);
    expect(() =>
      session.commitCrossSessionFollowupRouteForModelEffect(stale, events, mutation),
    ).toThrow('exact live Model effect lease');
    const wrong = session.beginEffect({ type: 'run_tools', toolCallIds: [] });
    expect(() =>
      session.commitCrossSessionFollowupRouteForModelEffect(wrong, events, mutation),
    ).toThrow('exact live Model effect lease');
    expect(f.writes).toHaveLength(0);
  });

  test('routes explicit effect acknowledgements and rejects stale or failed publication', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const attemptLease = session.beginEffect({ type: 'call_model' });

    expect(
      session.applyEffectEvents(attemptLease, [message('attempt-start')], 'attempt_start'),
    ).toBe(true);
    expect(f.acknowledgements).toEqual(['attempt_start']);
    expect(attemptLease.expectedRevision).toBe(session.getState().revision);

    const staleLease = session.beginEffect({ type: 'call_model' });
    session.releaseEffect(staleLease);
    expect(
      session.applyEffectEvents(staleLease, [message('stale-terminal')], 'terminal_recovery'),
    ).toBe(false);
    expect(f.acknowledgements).toEqual(['attempt_start']);

    const failedLease = session.beginEffect({ type: 'call_model' });
    f.failCommit = true;
    expect(() =>
      session.applyEffectEvents(failedLease, [message('failed-terminal')], 'terminal_recovery'),
    ).toThrow('commit refused');
    expect(f.acknowledgements).toEqual(['attempt_start']);
    expect(f.writes).toHaveLength(1);
    expect(session.getState().revision).toBe(1);

    f.failCommit = false;
    f.leaseAvailable = false;
    const externalLease = {
      sessionId: session.sessionId,
      effectId: 'external-attempt-lease',
      ownerId: 'external-owner',
    };
    const externalLeaseAttempt = session.beginEffect({ type: 'call_model' });
    expect(() =>
      session.applyEffectEvents(
        externalLeaseAttempt,
        [message('external-lease-failure')],
        'attempt_start',
        externalLease,
      ),
    ).toThrow('lease lost');
    expect(f.acknowledgements).toEqual(['attempt_start']);
    expect(f.writes).toHaveLength(1);
    expect(session.getState().revision).toBe(1);
  });

  test('preserves dispatched Model completion across an unrelated interaction-mode revision', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    const lease = session.beginEffect({ type: 'call_model' });
    expect(session.applyEffectResult(lease, [preparedModelEvent()])).toBe(true);
    expect(
      session.applyEffectEvents(
        lease,
        [
          {
            type: 'model.invocation_attempt_started',
            invocationId: 'model-1',
            attempt: 1,
            maxAttempts: 1,
          },
        ],
        'attempt_start',
      ),
    ).toBe(true);

    session.processEvent({
      type: 'interaction_mode.changed',
      mode: 'auto',
      source: 'user',
      changedAt: NOW,
    });
    expect(session.isEffectLeaseCurrent(lease)).toBe(false);
    expect(session.applyEffectResult(lease, [completedModelEvent()])).toBe(true);
    expect(session.getState().modelInvocations['model-1']?.status).toBe('completed');
  });

  test('admits only an acknowledged exact task-control result after a child settlement revision', () => {
    const f = fixture(runningTaskWaitState());
    const session = createRuntimeHostStateSession(f.input);
    const lease = session.beginEffect({ type: 'run_tools', toolCallIds: ['wait'] });
    session.processEvent({
      type: 'interaction_mode.changed',
      mode: 'auto',
      source: 'user',
      changedAt: NOW,
    });
    const terminal: KernelEvent = {
      type: 'tool.finished',
      toolCallId: 'wait',
      name: 'task_wait',
      result: { ok: true, command: '', exitCode: 0, stdout: '{}', stderr: '' },
    };
    const capabilityTerminal: KernelEvent = {
      type: 'capability.execution_succeeded',
      invocationId: 'waitInvocation',
      resultDigest: 'result-digest',
      evidenceDigest: 'evidence-digest',
      finishedAt: NOW,
      artifact: {
        artifactId: 'task-wait-result',
        kind: 'capability_result',
        integrityIdentifier: 'task-wait-integrity',
        byteLength: 1,
      },
    };

    expect(session.isEffectLeaseCurrent(lease)).toBe(false);
    expect(session.applyEffectResult(lease, [capabilityTerminal, terminal])).toBe(true);
    expect(session.getState().tools.calls.wait?.status).toBe('succeeded');
    expect(f.acknowledgements.at(-1)).toBe('receipt_evidence');

    const attemptFixture = fixture(runningTaskWaitState());
    const attemptSession = createRuntimeHostStateSession(attemptFixture.input);
    const attemptLease = attemptSession.beginEffect({ type: 'run_tools', toolCallIds: ['wait'] });
    attemptSession.processEvent({
      type: 'interaction_mode.changed',
      mode: 'auto',
      source: 'user',
      changedAt: NOW,
    });
    expect(attemptSession.applyEffectEvents(attemptLease, [terminal], 'attempt_start')).toBe(false);
    expect(attemptFixture.acknowledgements).toEqual(['decision']);

    const wrongFixture = fixture(runningTaskWaitState());
    const wrongSession = createRuntimeHostStateSession(wrongFixture.input);
    const wrongLease = wrongSession.beginEffect({ type: 'run_tools', toolCallIds: ['other'] });
    wrongSession.processEvent({
      type: 'interaction_mode.changed',
      mode: 'auto',
      source: 'user',
      changedAt: NOW,
    });
    expect(wrongSession.applyEffectResult(wrongLease, [terminal])).toBe(false);
  });

  test('rejects stale Model attempt-start and completion after its Turn is aborted', () => {
    const staleAttemptFixture = fixture();
    const staleAttemptSession = createRuntimeHostStateSession(staleAttemptFixture.input);
    const staleAttemptLease = staleAttemptSession.beginEffect({ type: 'call_model' });
    staleAttemptSession.processEvent({
      type: 'interaction_mode.changed',
      mode: 'auto',
      source: 'user',
      changedAt: NOW,
    });
    expect(
      staleAttemptSession.applyEffectEvents(
        staleAttemptLease,
        [preparedModelEvent()],
        'attempt_start',
      ),
    ).toBe(false);

    const abortedFixture = fixture();
    const abortedSession = createRuntimeHostStateSession(abortedFixture.input);
    const abortedLease = abortedSession.beginEffect({ type: 'call_model' });
    expect(abortedSession.applyEffectResult(abortedLease, [preparedModelEvent()])).toBe(true);
    expect(
      abortedSession.applyEffectEvents(
        abortedLease,
        [
          {
            type: 'model.invocation_attempt_started',
            invocationId: 'model-1',
            attempt: 1,
            maxAttempts: 1,
          },
        ],
        'attempt_start',
      ),
    ).toBe(true);
    abortedSession.processEvent({
      type: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'cancelled',
      cause: 'user',
    });
    expect(
      abortedSession.applyEffectEvents(abortedLease, [completedModelEvent()], 'receipt_evidence'),
    ).toBe(false);
  });

  test('does not run run_tools terminal validation for attempt-start facts', () => {
    const f = fixture();
    let terminalValidationCalls = 0;
    const session = createRuntimeHostStateSession({
      ...f.input,
      toolTerminalBatchValidator: () => {
        terminalValidationCalls += 1;
        return true;
      },
    });
    const lease = session.beginEffect({ type: 'run_tools', toolCallIds: [] });

    expect(session.applyEffectEvents(lease, [message('run-tools-attempt')], 'attempt_start')).toBe(
      true,
    );
    expect(terminalValidationCalls).toBe(0);
    expect(f.acknowledgements).toEqual(['attempt_start']);

    const terminalLease = session.beginEffect({ type: 'run_tools', toolCallIds: [] });
    expect(
      session.applyEffectEvents(
        terminalLease,
        [message('run-tools-terminal-recovery')],
        'terminal_recovery',
      ),
    ).toBe(true);
    expect(terminalValidationCalls).toBe(1);
    expect(f.acknowledgements).toEqual(['attempt_start', 'terminal_recovery']);
  });

  test('only reconciles active dispatch_started or unknown resource reservations', () => {
    const f = fixture();
    const session = createRuntimeHostStateSession(f.input);
    expect(
      session.applyLateResourceReconciliation([
        {
          type: 'resource_budget.reconciled',
          reservationId: 'missing',
          actual: usage(),
        },
      ]),
    ).toBe(false);
    expect(f.writes).toHaveLength(0);

    session.processEvent({
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: NOW,
      deadlineAt: '2026-08-21T00:00:30.000Z',
      budget: budget(),
    });
    session.processEvent({
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'reservation-1',
        runId: 'run-1',
        invocationId: 'invocation-1',
        resourceKind: 'tool',
        executableUpperBound: usage('versioned_upper_bound'),
        state: 'reserved',
      },
    });
    session.processEvent({
      type: 'resource_budget.dispatch_started',
      reservationId: 'reservation-1',
    });
    expect(
      session.applyLateResourceReconciliation([
        {
          type: 'resource_budget.reconciled',
          reservationId: 'reservation-1',
          actual: usage(),
        },
      ]),
    ).toBe(true);
    expect(f.writes).toHaveLength(4);
  });
});

function budget() {
  return {
    version: 1 as const,
    maxRunDurationMs: 60_000,
    maxTurns: 10,
    maxModelRequests: 10,
    maxToolInvocations: 10,
    maxRunInputTokens: 10_000,
    maxRunOutputTokens: 10_000,
    maxConcurrentSubagents: 2,
    maxConcurrentWriters: 2,
    maxConcurrentToolInvocations: 2,
    maxConcurrentShellInvocations: 2,
    maxConcurrencyWaitMs: 1_000,
    maxArtifactBytes: 1_000_000,
  };
}

function usage(source: 'actual' | 'versioned_upper_bound' = 'actual') {
  return {
    counters: {
      turns: 0,
      modelRequests: 0,
      toolInvocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 0,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
    source,
    ...(source === 'versioned_upper_bound' ? { estimatorVersion: 'test-estimator-v1' } : {}),
  };
}
