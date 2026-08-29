import { describe, expect, test } from 'bun:test';
import { type AgentState, createInitialAgentState, type KernelEvent } from '@kite-ai/agent-kernel';
import type { RuntimeHostExecutionServices } from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateSession,
  type StateRuntimeSessionInput,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  CheckpointPort,
  RuntimeCommandCommitEvidence,
  RuntimeRunStorePort,
  RuntimeStoredRun,
  RuntimeTransactionInput,
  SessionStore,
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
    list: (request) => ({
      entries: [...records.values()].filter((run) => run.sessionId === request.sessionId),
      hasMore: false,
    }),
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

function commandEvidence(): RuntimeCommandCommitEvidence {
  return {
    scopeSessionId: 'scope-session',
    commandId: 'command-1',
    requestDigest: 'a'.repeat(64),
    targetSessionId: 'state-session-test',
    committedAt: 1_700_000_000_000,
  };
}

describe('Runtime Host State session', () => {
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
