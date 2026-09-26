import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  childThreadIdForToolAttempt,
  createInitialAgentState,
  projectStateRestartRecoveryEvents,
  reduceAgentState,
  verifiedDispatchedChildDelegationIds,
  verifiedLiveAfterTurnReservationIds,
  verifiedPendingAfterTurnReservationIds,
  verifiedPendingFollowupReservationIds,
  verifiedPreparedCurrentTurnModelReservationIds,
  verifiedPreparedFollowupModelReservationIds,
  verifiedSealedAfterTurnReportReservationIds,
} from '@kite-ai/agent-kernel';

const RECOVERY_KEY = 'a'.repeat(64);
const backupId = `backup_${'b'.repeat(64)}`;
const turnId = `followup_turn_${'c'.repeat(64)}`;
const modelId = `followup_model_${'d'.repeat(64)}`;

function fundedFollowupState(replaced = false, queued = false) {
  const initial = createInitialAgentState({
    threadId: 'funding-session',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'funding-run',
    recoveryIdentityKey: RECOVERY_KEY,
  });
  const configured = reduceAgentState(initial, {
    type: 'resource_budget.configured',
    runId: 'funding-run',
    startedAt: '2026-09-25T00:00:00.000Z',
    deadlineAt: '2026-09-25T00:01:00.000Z',
    budget: {
      version: 1,
      maxRunDurationMs: 60_000,
      maxTurns: 2,
      maxModelRequests: 2,
      maxToolInvocations: 1,
      maxRunInputTokens: 1_000,
      maxRunOutputTokens: 1_000,
      maxArtifactBytes: 1,
      maxConcurrentSubagents: 2,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 1_000,
    },
  });
  const upper = {
    source: 'versioned_upper_bound' as const,
    estimatorVersion: 'followup-test-v1',
    counters: {
      turns: 1,
      modelRequests: 1,
      toolInvocations: 0,
      inputTokens: 100,
      outputTokens: 50,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 1,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
  };
  const reserved = reduceAgentState(configured, {
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: backupId,
      runId: 'funding-run',
      invocationId: 'submission-1',
      resourceKind: 'subagent',
      executableUpperBound: upper,
      state: queued ? 'queued' : 'reserved',
    },
  });
  if (!replaced) return reserved;
  return reduceAgentState(reserved, {
    type: 'resource_budget.bounded_replaced',
    reservationId: backupId,
    turnReservation: {
      version: 1,
      reservationId: turnId,
      runId: 'funding-run',
      invocationId: 'followup-turn:model-1',
      replacesReservationId: backupId,
      resourceKind: 'subagent',
      executableUpperBound: {
        ...upper,
        counters: { ...upper.counters, modelRequests: 0, inputTokens: 0, outputTokens: 0 },
      },
      state: 'reserved',
    },
    replacement: {
      version: 1,
      reservationId: modelId,
      runId: 'funding-run',
      invocationId: 'model-invocation:model-1',
      parentReservationId: turnId,
      replacesReservationId: backupId,
      resourceKind: 'model',
      executableUpperBound: {
        ...upper,
        counters: { ...upper.counters, turns: 0 },
        gauges: { ...upper.gauges, activeSubagents: 0 },
      },
      state: 'reserved',
    },
  });
}

const noOtherRecovery = {
  capabilityFinishedAtByInvocationId: {},
  pendingModelEvidenceFailures: {},
  completedModelEvidenceFailures: {},
};

describe('State restart recovery projection', () => {
  test('preserves only the exact Store-proven, never-dispatched followup Model', () => {
    const initial = createInitialAgentState({
      threadId: 'target-child',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'followup-run',
      recoveryIdentityKey: RECOVERY_KEY,
    });
    const surfaceRef = {
      artifactId: `pa_${'e'.repeat(64)}`,
      kind: 'model_surface' as const,
      integrityIdentifier: `sha256:${'e'.repeat(64)}`,
      byteLength: 42,
    };
    const reservationId = 'local-followup-model';
    const funded = fundedFollowupState();
    if (funded.resourceBudget.status !== 'active') throw new Error('Missing fixture budget.');
    const state = {
      ...initial,
      revision: 9,
      activeFollowupTurn: {
        sourceSessionId: 'parent',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        checkpointRef: {
          artifactId: `pa_${'c'.repeat(64)}`,
          kind: 'subagent_checkpoint',
          integrityIdentifier: `sha256:${'c'.repeat(64)}`,
          byteLength: 40,
        },
        grantRef: {
          artifactId: `pa_${'d'.repeat(64)}`,
          kind: 'agent_followup_grant',
          integrityIdentifier: `sha256:${'d'.repeat(64)}`,
          byteLength: 40,
        },
        grantDigest: `sha256:${'d'.repeat(64)}`,
      },
      modelInvocations: {
        first: {
          invocationId: 'first',
          purpose: 'primary_agent',
          status: 'prepared',
          surfaceArtifact: surfaceRef,
          surfaceIntegrityIdentifier: surfaceRef.integrityIdentifier,
          routeFingerprint: `sha256:${'f'.repeat(64)}`,
          budget: { kind: 'reservation', reservationId, parentReservationId: null },
          limits: { maxAttempts: 1, perAttemptTimeoutMs: 10_000, totalTimeBudgetMs: 10_000 },
          preparedStateRevision: 7,
          estimatedInputTokens: 12,
          parentInvocationId: null,
          parentToolCallId: null,
          attempts: 0,
        },
      },
      resourceBudget: {
        status: 'active',
        runId: 'followup-run',
        startedAt: '2026-09-25T00:00:00.000Z',
        deadlineAt: '2026-09-25T00:01:00.000Z',
        budget: funded.resourceBudget.budget,
        reconciledUsage: funded.resourceBudget.reconciledUsage,
        reservations: {
          [reservationId]: {
            version: 1,
            reservationId,
            runId: 'followup-run',
            invocationId: 'model-invocation:first',
            resourceKind: 'model',
            executableUpperBound: {
              source: 'versioned_upper_bound',
              estimatorVersion: 'followup-test-v1',
              counters: {
                turns: 0,
                modelRequests: 1,
                toolInvocations: 0,
                inputTokens: 12,
                outputTokens: 50,
                artifactBytes: 0,
              },
              gauges: {
                elapsedRunMs: 0,
                activeSubagents: 0,
                activeWriters: 0,
                activeToolInvocations: 0,
                activeShellInvocations: 0,
              },
            },
            state: 'reserved',
          },
        },
        waiters: {},
        nextWaiterSequence: 0,
      },
    } as AgentState;
    const proof = {
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      invocationId: 'first',
      modelReservationId: reservationId,
      preparedStateRevision: 9,
      surfaceRef,
      surfaceDigest: surfaceRef.integrityIdentifier,
      estimatedInputTokens: 12,
      activationSourceRevision: 5,
    };
    expect([...verifiedPreparedFollowupModelReservationIds(state, [proof])]).toEqual([
      ['first', reservationId],
    ]);
    expect(
      projectStateRestartRecoveryEvents(state, {
        ...noOtherRecovery,
        preservePreparedFollowupModels: [proof],
      }),
    ).toEqual([]);
    expect(projectStateRestartRecoveryEvents(state, noOtherRecovery)).toContainEqual({
      type: 'model.invocation_interrupted',
      invocationId: 'first',
      dispatchCertainty: 'none',
      reasonCode: 'runtime_restored',
    });
    expect(projectStateRestartRecoveryEvents(state, noOtherRecovery)).toContainEqual({
      type: 'resource_budget.released',
      reservationId,
    });
    const attempted: AgentState = {
      ...state,
      modelInvocations: {
        first: { ...state.modelInvocations.first!, status: 'dispatching', attempts: 1 },
      },
    };
    expect(() => verifiedPreparedFollowupModelReservationIds(attempted, [proof])).toThrow(
      'conflicts with target State',
    );
    expect(() => verifiedPreparedFollowupModelReservationIds(state, [proof, proof])).toThrow(
      'Only one prepared first Model',
    );
    expect(() =>
      verifiedPreparedFollowupModelReservationIds(state, [
        {
          ...proof,
          surfaceDigest: `sha256:${'0'.repeat(64)}`,
        },
      ]),
    ).toThrow('conflicts with target State');

    const oldRun = {
      ...state,
      activeFollowupTurn: undefined,
      activeTaskId: 'old-child-task',
      childSessionOrigin: { terminal: undefined },
    } as unknown as AgentState;
    const currentTurnProof = {
      submissionId: proof.submissionId,
      targetRunId: proof.targetRunId,
      invocationId: proof.invocationId,
      modelReservationId: proof.modelReservationId,
      preparedStateRevision: proof.preparedStateRevision,
      surfaceRef: proof.surfaceRef,
      surfaceDigest: proof.surfaceDigest,
      estimatedInputTokens: proof.estimatedInputTokens,
      releaseSourceRevision: 5,
      routeDigest: `sha256:${'a'.repeat(64)}`,
    };
    expect([...verifiedPreparedCurrentTurnModelReservationIds(oldRun, [currentTurnProof])]).toEqual(
      [['first', reservationId]],
    );
    expect(
      projectStateRestartRecoveryEvents(oldRun, {
        ...noOtherRecovery,
        preservePreparedCurrentTurnModels: [currentTurnProof],
      }),
    ).toEqual([]);
    const attemptedOld = {
      ...oldRun,
      modelInvocations: {
        first: { ...oldRun.modelInvocations.first!, status: 'dispatching', attempts: 1 },
      },
    } as AgentState;
    expect(() =>
      verifiedPreparedCurrentTurnModelReservationIds(attemptedOld, [currentTurnProof]),
    ).toThrow('conflicts with target State');
    expect(() =>
      verifiedPreparedCurrentTurnModelReservationIds(
        { ...oldRun, childSessionOrigin: undefined } as AgentState,
        [currentTurnProof],
      ),
    ).toThrow('conflicts with target State');
    expect(() =>
      verifiedPreparedCurrentTurnModelReservationIds(oldRun, [
        { ...currentTurnProof, surfaceDigest: `sha256:${'0'.repeat(64)}` },
      ]),
    ).toThrow('conflicts with target State');
  });
  test('preserves only Store-proven accepted and replaced TriggerTurn reservations', () => {
    const accepted = fundedFollowupState();
    const acceptedProof = [
      {
        fundingRunId: 'funding-run',
        submissionId: 'submission-1',
        stage: 'accepted' as const,
        backupReservationId: backupId,
        turnReservationId: null,
        modelReservationId: null,
        modelInvocationId: null,
      },
    ];
    expect(
      projectStateRestartRecoveryEvents(accepted, {
        ...noOtherRecovery,
        preservePendingFollowupFunding: acceptedProof,
      }).some((event) => event.type === 'resource_budget.released'),
    ).toBe(false);
    expect(projectStateRestartRecoveryEvents(accepted, noOtherRecovery)).toContainEqual({
      type: 'resource_budget.released',
      reservationId: backupId,
    });
    const queued = fundedFollowupState(false, true);
    expect([...verifiedPendingFollowupReservationIds(queued, acceptedProof)]).toEqual([backupId]);
    expect(
      projectStateRestartRecoveryEvents(queued, {
        ...noOtherRecovery,
        preservePendingFollowupFunding: acceptedProof,
      }).some((event) => event.type === 'resource_budget.released'),
    ).toBe(false);
    expect(() =>
      verifiedPendingFollowupReservationIds(accepted, [
        {
          ...acceptedProof[0]!,
          submissionId: 'wrong-submission',
        },
      ]),
    ).toThrow('conflicts with State');

    const replaced = fundedFollowupState(true);
    const replacedProof = [
      {
        ...acceptedProof[0]!,
        stage: 'replaced' as const,
        turnReservationId: turnId,
        modelReservationId: modelId,
        modelInvocationId: 'model-1',
      },
    ];
    expect([...verifiedPendingFollowupReservationIds(replaced, replacedProof)]).toEqual([
      turnId,
      modelId,
    ]);
    expect(
      projectStateRestartRecoveryEvents(replaced, {
        ...noOtherRecovery,
        preservePendingFollowupFunding: replacedProof,
      }).filter((event) => event.type === 'resource_budget.released'),
    ).toEqual([]);
    const activated = reduceAgentState(
      reduceAgentState(replaced, {
        type: 'resource_budget.dispatch_started',
        reservationId: turnId,
      }),
      { type: 'resource_budget.dispatch_started', reservationId: modelId },
    );
    expect(
      projectStateRestartRecoveryEvents(activated, {
        ...noOtherRecovery,
        preservePendingFollowupFunding: [{ ...replacedProof[0]!, stage: 'activated' }],
      }).filter((event) => event.type === 'resource_budget.unknown'),
    ).toEqual([
      { type: 'resource_budget.unknown', reservationId: turnId },
      { type: 'resource_budget.unknown', reservationId: modelId },
    ]);
    const noAttempt = {
      submissionId: 'submission-1',
      targetRunId: 'target-run',
      invocationId: 'model-1',
      modelReservationId: 'target-local-model',
      preparedStateRevision: 5,
      surfaceRef: {
        artifactId: `pa_${'e'.repeat(64)}`,
        kind: 'model_surface' as const,
        integrityIdentifier: `sha256:${'e'.repeat(64)}`,
        byteLength: 1,
      },
      surfaceDigest: `sha256:${'e'.repeat(64)}`,
      estimatedInputTokens: 10,
      activationSourceRevision: 6,
    };
    expect(
      projectStateRestartRecoveryEvents(activated, {
        ...noOtherRecovery,
        preservePendingFollowupFunding: [
          { ...replacedProof[0]!, stage: 'activated', targetPreparedNoAttempt: noAttempt },
        ],
      }).filter((event) => event.type === 'resource_budget.unknown'),
    ).toEqual([]);
    expect(() =>
      verifiedPendingFollowupReservationIds(activated, [
        {
          ...replacedProof[0]!,
          stage: 'activated',
          targetPreparedNoAttempt: { ...noAttempt, invocationId: 'other-model' },
        },
      ]),
    ).toThrow('no-attempt proof conflicts');
  });

  test('retains one dispatched child allotment only with routed no-attempt proof', () => {
    const childThreadId = `child_${'a'.repeat(64)}`;
    const reservationId = `child-allotment:${childThreadId}`;
    const initial = createInitialAgentState({
      threadId: 'parent',
      userId: 'user',
      workspace: '/workspace',
      turnId: 'funding-run',
      recoveryIdentityKey: RECOVERY_KEY,
    });
    const funded = fundedFollowupState();
    if (funded.resourceBudget.status !== 'active') throw new Error('Missing fixture budget.');
    const source = {
      ...initial,
      turn: { ...initial.turn, turnId: 'funding-run', status: 'active' },
      tools: {
        ...initial.tools,
        calls: {
          task: {
            toolCallId: 'task',
            name: 'task',
            modelMessageId: 'model',
            args: {},
            createdAtTurnId: 'funding-run',
            status: 'succeeded',
          },
        },
      },
      capabilities: {
        ...initial.capabilities,
        invocations: {
          invocation: {
            invocationId: 'invocation',
            toolCallId: 'task',
            status: 'succeeded',
            subagentProviderLifecycle: {
              childSession: { childThreadId, delegatedReservationId: reservationId },
            },
          },
        },
      },
      resourceBudget: {
        status: 'active',
        runId: 'funding-run',
        startedAt: '2026-09-25T00:00:00.000Z',
        deadlineAt: '2026-09-25T00:01:00.000Z',
        budget: funded.resourceBudget.budget,
        reconciledUsage: funded.resourceBudget.reconciledUsage,
        reservations: {
          [reservationId]: {
            reservationId,
            runId: 'funding-run',
            invocationId: reservationId,
            resourceKind: 'subagent',
            state: 'dispatch_started',
          },
        },
        waiters: {},
        nextWaiterSequence: 0,
      },
    } as unknown as AgentState;
    const proof = {
      stage: 'routed' as const,
      sourceSessionId: 'parent',
      delegatedReservationId: reservationId,
      childThreadId,
      parentInvocationId: 'invocation',
      originToolCallId: 'task',
      fundingRunId: 'funding-run',
      targetRunId: 'child-run',
      modelInvocationId: 'child-model',
      submissionId: 'submission',
      preparedStateRevision: 7,
      sourceRevision: 9,
      routedTargetRevision: 7,
    };
    expect([...verifiedDispatchedChildDelegationIds(source, [proof])]).toEqual([reservationId]);
    expect(
      projectStateRestartRecoveryEvents(source, {
        ...noOtherRecovery,
        preserveDispatchedChildDelegations: [proof],
      }),
    ).toEqual([]);
    expect(projectStateRestartRecoveryEvents(source, noOtherRecovery)).toContainEqual({
      type: 'resource_budget.unknown',
      reservationId,
    });
    expect(() =>
      verifiedDispatchedChildDelegationIds(source, [{ ...proof, sourceSessionId: 'other-parent' }]),
    ).toThrow('conflicts with the source ledger');
    expect(() =>
      verifiedDispatchedChildDelegationIds(source, [{ ...proof, sourceRevision: 0 }]),
    ).toThrow('conflicts with the source ledger');
  });

  test('preserves only Store-proven after_turn child and report debts after the origin Run', () => {
    const funded = fundedFollowupState();
    if (funded.resourceBudget.status !== 'active') throw new Error('Missing fixture budget.');
    const childThreadId = childThreadIdForToolAttempt({
      parentSessionId: 'funding-session',
      parentInvocationId: 'parent-invocation',
      parentToolCallId: 'task-tool',
      attempt: 1,
    });
    const childInvocationId = 'after-turn-child';
    const delegatedReservationId = `child-allotment:${childThreadId}`;
    const reportReservationId = 'after-turn-report';
    const childUpper = {
      ...funded.resourceBudget.reservations[backupId]!.executableUpperBound,
    };
    const reportUpper = {
      ...childUpper,
      counters: {
        ...childUpper.counters,
        turns: 0,
        modelRequests: 1,
        inputTokens: 100,
        outputTokens: 50,
      },
      gauges: { ...childUpper.gauges, activeSubagents: 0 },
    };
    const originBudget = {
      ...funded.resourceBudget,
      reservations: {
        [delegatedReservationId]: {
          version: 1 as const,
          reservationId: delegatedReservationId,
          runId: 'funding-run',
          invocationId: delegatedReservationId,
          resourceKind: 'subagent' as const,
          executableUpperBound: childUpper,
          state: 'reserved' as const,
        },
        [reportReservationId]: {
          version: 1 as const,
          reservationId: reportReservationId,
          runId: 'funding-run',
          invocationId: `model-invocation:after-turn:${childInvocationId}`,
          resourceKind: 'model' as const,
          executableUpperBound: reportUpper,
          state: 'reserved' as const,
        },
      },
    };
    const source = {
      ...funded,
      turn: { ...funded.turn, status: 'completed' },
      tools: {
        ...funded.tools,
        calls: {
          'task-tool': {
            toolCallId: 'task-tool',
            createdAtTurnId: 'funding-run',
            status: 'succeeded',
            args: { background: true, result_disposition: 'after_turn' },
            result: {
              ok: true,
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
        ...funded.capabilities,
        invocations: {
          'parent-invocation': {
            invocationId: 'parent-invocation',
            toolCallId: 'task-tool',
            status: 'succeeded',
            subagentProviderLifecycle: {
              attempt: 1,
              childInvocationId,
              childSession: {
                childThreadId,
                disposition: 'after_turn',
                originRunId: 'funding-run',
                originTurnId: 'funding-run',
                originToolCallId: 'task-tool',
                fundingRunId: 'funding-run',
                delegatedReservationId,
                deadlineAt: originBudget.deadlineAt,
              },
            },
          },
        },
      },
      resourceBudget: originBudget,
    } as unknown as AgentState;
    const proof = {
      childThreadId,
      parentInvocationId: 'parent-invocation',
      childInvocationId,
      fundingRunId: 'funding-run',
      delegatedReservationId,
      reportReservationId,
    };
    expect([...verifiedPendingAfterTurnReservationIds(source, [proof])]).toEqual([
      delegatedReservationId,
      reportReservationId,
    ]);
    expect(
      projectStateRestartRecoveryEvents(source, {
        ...noOtherRecovery,
        preservePendingAfterTurnDelegations: [proof],
      }),
    ).toEqual([]);
    expect(projectStateRestartRecoveryEvents(source, noOtherRecovery)).toEqual([
      { type: 'resource_budget.released', reservationId: delegatedReservationId },
      { type: 'resource_budget.released', reservationId: reportReservationId },
    ]);
    const newHumanRun = {
      ...source,
      turn: { ...source.turn, turnId: 'new-human-run', status: 'active' },
      resourceBudget: { ...originBudget, runId: 'new-human-run', reservations: {} },
      retainedResourceBudgets: { 'funding-run': originBudget },
    } as AgentState;
    expect([...verifiedPendingAfterTurnReservationIds(newHumanRun, [proof])]).toEqual([
      delegatedReservationId,
      reportReservationId,
    ]);
    const queued = {
      ...source,
      resourceBudget: {
        ...originBudget,
        reservations: {
          ...originBudget.reservations,
          [delegatedReservationId]: {
            ...originBudget.reservations[delegatedReservationId]!,
            state: 'queued',
          },
        },
      },
    } as AgentState;
    expect([...verifiedPendingAfterTurnReservationIds(queued, [proof])]).toEqual([
      delegatedReservationId,
      reportReservationId,
    ]);
    expect(
      projectStateRestartRecoveryEvents(queued, {
        ...noOtherRecovery,
        preservePendingAfterTurnDelegations: [proof],
      }),
    ).toEqual([]);
    const dispatched = {
      ...source,
      resourceBudget: {
        ...originBudget,
        reservations: {
          ...originBudget.reservations,
          [delegatedReservationId]: {
            ...originBudget.reservations[delegatedReservationId]!,
            state: 'dispatch_started',
          },
        },
      },
    } as AgentState;
    const sealedProof = {
      ...proof,
      sealEventId: 'child-terminal-seal',
      sealRevision: 9,
      terminalReceiptId: 'terminal-receipt',
      status: 'unknown' as const,
    };
    expect([...verifiedSealedAfterTurnReportReservationIds(dispatched, [sealedProof])]).toEqual([
      reportReservationId,
    ]);
    expect(
      projectStateRestartRecoveryEvents(dispatched, {
        ...noOtherRecovery,
        preserveSealedAfterTurnReports: [sealedProof],
      }),
    ).toEqual([{ type: 'resource_budget.unknown', reservationId: delegatedReservationId }]);
    const liveProof = {
      ...proof,
      dispatchAckEventId: 'parent-dispatch-ack',
      dispatchAckRevision: 8,
      controllerGeneration: 1,
    };
    expect([...verifiedLiveAfterTurnReservationIds(dispatched, [liveProof])]).toEqual([
      delegatedReservationId,
      reportReservationId,
    ]);
    expect(
      projectStateRestartRecoveryEvents(dispatched, {
        ...noOtherRecovery,
        preserveLiveAfterTurnDelegations: [liveProof],
      }),
    ).toEqual([]);
    expect(projectStateRestartRecoveryEvents(dispatched, noOtherRecovery)).toEqual([
      { type: 'resource_budget.unknown', reservationId: delegatedReservationId },
      { type: 'resource_budget.released', reservationId: reportReservationId },
    ]);
    expect(() =>
      verifiedLiveAfterTurnReservationIds(dispatched, [{ ...liveProof, controllerGeneration: 0 }]),
    ).toThrow('conflicts with the source ledger');
    expect(() =>
      verifiedPendingAfterTurnReservationIds(source, [
        { ...proof, reportReservationId: delegatedReservationId },
      ]),
    ).toThrow('conflicts with the source ledger');
    expect(() => verifiedPendingAfterTurnReservationIds(source, [proof, proof])).toThrow(
      'conflicts with the source ledger',
    );
    expect(() =>
      verifiedPendingAfterTurnReservationIds(
        {
          ...source,
          resourceBudget: {
            ...originBudget,
            reservations: {
              [delegatedReservationId]: originBudget.reservations[delegatedReservationId]!,
            },
          },
        } as AgentState,
        [proof],
      ),
    ).toThrow('conflicts with the source ledger');
  });

  test('is a pure no-op for a fresh session', () => {
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: RECOVERY_KEY,
    });
    expect(
      projectStateRestartRecoveryEvents(state, {
        capabilityFinishedAtByInvocationId: {},
        pendingModelEvidenceFailures: {},
        completedModelEvidenceFailures: {},
      }),
    ).toEqual([]);
  });

  test('does not read an ambient recovery clock for a fresh session', () => {
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: RECOVERY_KEY,
    });
    expect(
      projectStateRestartRecoveryEvents(state, {
        capabilityFinishedAtByInvocationId: {},
        pendingModelEvidenceFailures: {},
        completedModelEvidenceFailures: {},
      }),
    ).toEqual([]);
  });
});
