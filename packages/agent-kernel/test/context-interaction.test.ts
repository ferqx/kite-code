import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  createInitialAgentState,
  createToolRecoveryJournalV1,
  type KernelEvent,
  type PlanDocument,
  recordRecoveryFailureV1,
  reduceAgentState,
  type ToolOutcomeV1,
} from '../src';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EPOCH = '1970-01-01T00:00:00.000Z';
const PLAN_DIGEST = '1ce84d5af6c0ef23c61c0dedc03f9bf007006af20e078c94a394898df1e033c2';
const ROOT_STATE_MODULE = '@kite/runtime-host';
const ROOT_ID_SOURCE_MODULE = '@kite/runtime-host';
const STATE26_TEST_REDUCER_MODULE = '../../../scripts/support/runtime-state26-reducer.ts';
const TOKEN_ESTIMATE = {
  systemTokens: 256,
  toolSchemaTokens: 128,
  transcriptTokens: 1408,
  summaryTokens: 128,
  dynamicRuntimeTokens: 64,
  framingTokens: 64,
  totalInputTokens: 2048,
} as const;

function initial(): AgentState {
  return createInitialAgentState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: IDENTITY_KEY,
  });
}

function reduce(state: AgentState, event: KernelEvent): AgentState {
  return reduceAgentState(state, event);
}

function checkpoint(compactionId: string) {
  return {
    compactionId,
    version: 1,
    sourceRevision: 1,
    sourceDigest: 'source-1',
    coveredThroughMessageId: 'message-1',
    coveredThroughTurnId: 'turn-1',
    summary: 'A canonical summary.',
    inputTokensBefore: 2048,
    inputTokensAfter: 1024,
    reason: 'manual',
    createdAt: '2026-08-20T00:00:00.000Z',
  } as const;
}

describe('State26 context and interaction reducer parity', () => {
  test('compaction uses pending identity, records history, and gates reset by identity', () => {
    let state = initial();
    state = reduce(state, {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'keep this boundary',
    });
    state = reduce(state, {
      type: 'context.compaction_requested',
      compactionId: 'compact-1',
      reason: 'manual',
      requestedAtRevision: 1,
      requestedAtTurnId: 'turn-1',
      force: true,
      estimate: TOKEN_ESTIMATE,
    });
    expect(state.context.pendingCompaction).toEqual({
      compactionId: 'compact-1',
      reason: 'manual',
      requestedAtRevision: 1,
      requestedAtTurnId: 'turn-1',
      force: false,
      estimate: TOKEN_ESTIMATE,
    });

    state = reduce(state, {
      type: 'context.compaction_completed',
      compactionId: 'compact-1',
      sourceRevision: 1,
      checkpoint: checkpoint('compact-1'),
    });
    expect(state.context.pendingCompaction).toBeUndefined();
    expect(state.context.activeCheckpoint?.compactionId).toBe('compact-1');
    expect(state.context.history).toEqual([
      { kind: 'completed', checkpoint: checkpoint('compact-1') },
    ]);
    expect(state.context.autoGuard).toEqual({
      recentAutomaticCompactions: [],
      consecutiveLowGain: 0,
      disabledUntilManualAction: false,
      recoveryAttempted: false,
    });

    const stale = reduce(state, {
      type: 'context.compaction_reset',
      checkpointId: 'other-checkpoint',
      reason: 'manual',
    });
    expect(stale).toEqual(state);
    state = reduce(state, {
      type: 'context.compaction_reset',
      checkpointId: 'compact-1',
      reason: 'manual',
    });
    expect(state.context.activeCheckpoint).toBeUndefined();
    expect(state.context.history.at(-1)).toEqual({
      kind: 'reset',
      compactionId: 'compact-1',
      reason: 'manual',
    });
  });

  test('rejects stale or invalid compaction and hard-block events without changing state', () => {
    let state = initial();
    state = reduce(state, {
      type: 'context.compaction_requested',
      compactionId: 'compact-1',
      reason: 'auto',
      requestedAtRevision: 1,
      requestedAtTurnId: 'turn-1',
      force: false,
      estimate: TOKEN_ESTIMATE,
    });
    expect(
      reduce(state, {
        type: 'context.compaction_requested',
        compactionId: 'compact-2',
        reason: 'manual',
        requestedAtRevision: 2,
        requestedAtTurnId: 'turn-1',
        force: false,
        estimate: TOKEN_ESTIMATE,
      }),
    ).toEqual(state);
    expect(
      reduce(state, {
        type: 'context.compaction_failed',
        compactionId: 'compact-1',
        sourceRevision: 1,
        errorKind: 'not-a-compaction-error',
        message: 'invalid',
        retryable: true,
      } as unknown as KernelEvent),
    ).toEqual(state);

    state = reduce(state, {
      type: 'context.hard_blocked',
      reason: 'corrupted_event_tail',
      sourceDigest: 'digest-1',
      message: '  replay evidence is corrupt  ',
      createdAtTurnId: 'turn-1',
    });
    expect(state.context.hardBlock).toEqual({
      reason: 'corrupted_event_tail',
      sourceDigest: 'digest-1',
      message: 'replay evidence is corrupt',
      createdAtTurnId: 'turn-1',
    });
    expect(
      reduce(state, {
        type: 'context.hard_block_cleared',
        reason: 'corrupted_event_tail',
        sourceDigest: 'wrong-digest',
      }),
    ).toEqual(state);
    expect(
      reduce(state, {
        type: 'context.hard_blocked',
        reason: 'unknown-hard-block',
        sourceDigest: 'digest-2',
        message: 'invalid',
        createdAtTurnId: 'turn-1',
      } as unknown as KernelEvent),
    ).toEqual(state);
  });

  test('model response has deterministic timestamp, final projection, and recovery progression', () => {
    let state = initial();
    state = reduce(state, {
      type: 'model.responded',
      messageId: 'model-1',
      text: 'first answer',
    } as KernelEvent);
    expect(state.transcript.final).toBe('first answer');
    expect(state.transcript.messages.at(-1)).toMatchObject({
      kind: 'assistant',
      messageId: 'model-1',
      createdAt: EPOCH,
      content: 'first answer',
      toolCalls: [],
    });

    state = reduce(state, {
      type: 'model.responded',
      messageId: 'model-2',
      toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a' } }],
    } as KernelEvent);
    expect(state.transcript.final).toBeUndefined();
    expect(state.transcript.messages.at(-1)).toMatchObject({
      messageId: 'model-2',
      createdAt: EPOCH,
      toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a' } }],
    });

    const outcome: ToolOutcomeV1 = {
      schemaVersion: 1,
      status: 'failed',
      failure: { kind: 'tool_invalid_args', detailCode: 'invalid_arguments' },
      dispatchState: 'not_started',
      externalEffects: 'none',
      replaySafety: 'pre_dispatch',
      recovery: {
        disposition: 'correct_args',
        maximumAdditionalCalls: 1,
        requiresNewModelResponse: true,
        safeAutomaticRetry: false,
      },
      timing: { source: 'legacy_unknown' },
    };
    state = {
      ...state,
      toolRecovery: recordRecoveryFailureV1(createToolRecoveryJournalV1(IDENTITY_KEY), {
        toolCallId: 'failed-call',
        toolName: 'read_file',
        invocationFingerprint: 'a'.repeat(64),
        modelMessageId: 'old-model',
        outcome,
        turnId: 'turn-1',
      }),
    };
    state = reduce(state, {
      type: 'model.responded',
      messageId: 'repair-model',
      toolCalls: [{ id: 'repair-call', name: 'read_file', args: {} }],
    } as KernelEvent);
    const failure = Object.values(state.toolRecovery.failures)[0];
    expect(failure?.eligibleModelMessageId).toBe('repair-model');
    expect(failure?.eligibleToolCallId).toBe('repair-call');
  });

  test('fails closed on own undefined response fields while canonical replay stays applicable', () => {
    const state = initial();
    const malformed = {
      type: 'model.responded',
      messageId: 'model-undefined-field',
      text: 'done',
      reasoningText: undefined,
    } as unknown as KernelEvent;

    expect(Object.hasOwn(malformed, 'reasoningText')).toBe(true);
    expect(reduce(state, malformed)).toBe(state);

    const canonical = JSON.parse(JSON.stringify(malformed)) as KernelEvent;
    expect(Object.hasOwn(canonical, 'reasoningText')).toBe(false);
    const replayed = reduce(state, canonical);
    expect(replayed.transcript.final).toBe('done');
    expect(replayed.transcript.messages.at(-1)).toMatchObject({
      kind: 'assistant',
      messageId: 'model-undefined-field',
      content: 'done',
    });
  });

  test('user messages update the active task goal exactly once while preserving transcript order', () => {
    let state = initial();
    state = {
      ...state,
      activeTaskId: 'task-1',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          userGoal: 'old goal',
          status: 'active',
          startedAtTurnId: state.turn.turnId,
          sideEffectsStarted: false,
          planning: { kind: 'building_without_plan' },
          planHistory: [],
        },
      },
    };
    state = reduce(state, {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'new content',
      userGoal: 'new goal',
      createdAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
    expect(state.tasks['task-1']?.userGoal).toBe('new goal');
    expect(state.transcript.messages).toEqual([
      {
        kind: 'user',
        messageId: 'message-1',
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-20T00:00:00.000Z',
        content: 'new content',
      },
    ]);
  });

  test('model invocation lifecycle uses exact root fields and rejects stale attempts', () => {
    const artifact = {
      kind: 'model_surface',
      artifactId: `pa_${'b'.repeat(64)}`,
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    } as const;
    const responseArtifact = { ...artifact, kind: 'model_response' } as const;
    const preparedPayload = {
      type: 'model.invocation_prepared',
      invocationId: 'inv-1',
      purpose: 'primary_agent',
      surfaceArtifact: artifact,
      surfaceIntegrityIdentifier: artifact.integrityIdentifier,
      routeFingerprint: `sha256:${'d'.repeat(64)}`,
      admission: {
        providerAdmissionRevision: null,
        routeIdentityDigest: `sha256:${'e'.repeat(64)}`,
        payloadClassificationDigest: `sha256:${'f'.repeat(64)}`,
        admitted: true,
      },
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 2, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 2_000 },
      preparedStateRevision: 0,
      parentInvocationId: null,
      parentToolCallId: null,
    } as const;
    const prepared = preparedPayload as unknown as KernelEvent;
    let state = initial();
    state = reduce(state, prepared);
    const expectedPrepared = {
      invocationId: 'inv-1',
      purpose: 'primary_agent',
      status: 'prepared',
      surfaceArtifact: artifact,
      surfaceIntegrityIdentifier: artifact.integrityIdentifier,
      routeFingerprint: `sha256:${'d'.repeat(64)}`,
      admission: preparedPayload.admission,
      budget: preparedPayload.budget,
      limits: preparedPayload.limits,
      preparedStateRevision: 0,
      parentInvocationId: null,
      parentToolCallId: null,
      attempts: 0,
    } as const;
    expect(state.modelInvocations['inv-1']).toEqual(expectedPrepared);
    expect(state.modelInvocations['inv-1']).not.toHaveProperty('type');
    const duplicate = reduce(state, prepared);
    expect(duplicate).toEqual(state);
    const staleCompletion = reduce(state, {
      type: 'model.invocation_completed',
      invocationId: 'inv-1',
      responseArtifact,
      finishReason: 'stop',
    } as KernelEvent);
    expect(staleCompletion).toEqual(state);

    const staleAttempt = reduce(state, {
      type: 'model.invocation_attempt_started',
      invocationId: 'inv-1',
      attempt: 2,
      maxAttempts: 2,
      startedAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
    expect(staleAttempt).toEqual(state);
    state = reduce(state, {
      type: 'model.invocation_attempt_started',
      invocationId: 'inv-1',
      attempt: 1,
      maxAttempts: 2,
      startedAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
    expect(state.modelInvocations['inv-1']).toMatchObject({
      status: 'dispatching',
      attempts: 1,
      dispatchCertainty: 'attempted',
    });

    state = reduce(state, {
      type: 'model.invocation_completed',
      invocationId: 'inv-1',
      responseArtifact,
      finishReason: 'stop',
    } as KernelEvent);
    state = reduce(state, {
      type: 'model.invocation_evidence_unavailable',
      invocationId: 'inv-1',
      reasonCode: 'artifact_missing',
    } as KernelEvent);
    expect(state.modelInvocations['inv-1']).toMatchObject({
      status: 'completed',
      attempts: 1,
      responseArtifact,
      finishReason: 'stop',
      modelEvidenceUnavailable: 'artifact_missing',
    });
    expect(
      reduce(state, {
        type: 'model.invocation_attempt_started',
        invocationId: 'inv-1',
        attempt: 2,
        maxAttempts: 2,
        startedAt: '2026-08-20T00:00:00.000Z',
      } as KernelEvent),
    ).toEqual(state);

    let interrupted = initial();
    interrupted = reduce(interrupted, prepared);
    interrupted = reduce(interrupted, {
      type: 'model.invocation_interrupted',
      invocationId: 'inv-1',
      dispatchCertainty: 'none',
      reasonCode: 'cancelled_before_dispatch',
    } as KernelEvent);
    expect(interrupted.modelInvocations['inv-1']).toMatchObject({
      status: 'interrupted',
      attempts: 0,
      dispatchCertainty: 'none',
      interruptionReason: 'cancelled_before_dispatch',
    });
    expect(
      reduce(interrupted, {
        type: 'model.invocation_evidence_unavailable',
        invocationId: 'inv-1',
        reasonCode: 'artifact_missing',
      } as KernelEvent),
    ).toEqual(interrupted);
  });

  test('provider admission canonical sequence preserves pending order, waiver, and transcript bytes', () => {
    let state = initial();
    state = reduce(state, {
      type: 'provider.admission_required',
      interactionId: 'admission-1',
      providerId: 'provider-1',
      source: 'explicit',
      providerStatus: 'login_required',
      retryable: true,
    });
    const afterFirst = state;
    expect(
      reduce(state, {
        type: 'provider.admission_required',
        interactionId: 'duplicate',
        providerId: 'provider-1',
        source: 'explicit',
        providerStatus: 'failed',
        retryable: false,
      }),
    ).toEqual(afterFirst);
    expect(
      reduce(state, {
        type: 'provider.admission_retry_failed',
        interactionId: 'stale-interaction',
        providerStatus: 'failed',
      }),
    ).toEqual(state);
    state = reduce(state, {
      type: 'provider.admission_required',
      interactionId: 'admission-2',
      providerId: 'provider-2',
      source: 'explicit',
      providerStatus: 'connecting',
      retryable: false,
    });
    state = reduce(state, {
      type: 'provider.admission_retry_failed',
      interactionId: 'admission-1',
      providerStatus: 'failed',
      diagnosticCode: 'auth_required',
    } as KernelEvent);
    expect(state.interactions).toMatchObject({
      kind: 'awaiting_provider_admission',
      interactionId: 'admission-1',
      providerStatus: 'failed',
      diagnosticCode: 'auth_required',
    });
    state = reduce(state, {
      type: 'provider.admission_waived',
      interactionId: 'admission-1',
      providerId: 'provider-1',
      source: 'explicit',
      reason: 'user_session_waiver',
      waivedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(state.interactions).toMatchObject({
      kind: 'awaiting_provider_admission',
      interactionId: 'admission-2',
      providerId: 'provider-2',
    });
    expect(state.providerAdmission.waivers['provider-1']).toEqual({
      providerId: 'provider-1',
      source: 'explicit',
      reason: 'user_session_waiver',
      waivedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(state.transcript.messages).toEqual([
      {
        kind: 'runtime',
        messageId: 'provider-admission-waiver-admission-1',
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '2026-08-20T00:00:00.000Z',
        content:
          "Required MCP provider 'provider-1' is unavailable. " +
          'The user waived it for this session; its capabilities remain unavailable.',
      },
    ]);
  });

  test('plan review requires the active draft identity and projects the canonical plan', () => {
    let state = initial();
    state = reduce(state, {
      type: 'task.started',
      taskId: 'task-1',
      userGoal: 'write a safe change',
      turnId: 'turn-1',
    });
    const document: PlanDocument = {
      planSchemaVersion: 2,
      planId: 'plan-1',
      version: 1,
      title: 'Safe plan',
      bodyMarkdown: 'A plan with a sufficiently clear body.',
      steps: [{ id: 'step-1', title: 'Inspect the change', status: 'pending' }],
      structuralDigest: PLAN_DIGEST,
      createdAtTurnId: 'turn-1',
      updatedAtTurnId: 'turn-1',
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    };
    state = {
      ...state,
      activeTaskId: 'task-1',
      tasks: {
        ...state.tasks,
        'task-1': {
          ...state.tasks['task-1']!,
          planning: { kind: 'planning_draft', document },
        },
      },
    };
    state = reduce(state, {
      type: 'tool.queued',
      toolCallId: 'write-plan-call',
      name: 'write_plan',
      args: {},
      modelMessageId: 'model-1',
    } as KernelEvent);
    const stale = reduce(state, {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'write-plan-call',
      taskId: 'task-1',
      plan: {
        name: 'Safe plan',
        description: 'A plan with a sufficiently clear body.',
        status: 'pending',
        steps: [{ id: 'step-1', step: 'Inspect the change', status: 'pending' }],
      },
      planSummary: 'forged summary',
      planId: 'plan-1',
      version: 2,
      structuralDigest: 'digest-2',
      artifact: undefined,
    } as unknown as KernelEvent);
    expect(stale).toEqual(state);

    expect(
      reduce(state, {
        type: 'plan.review_requested',
        interactionId: 'review-1',
        toolCallId: 'write-plan-call',
        taskId: 'task-1',
        plan: {
          name: 'Safe plan',
          description: 'A plan with a sufficiently clear body.',
          status: 'pending',
          steps: [
            {
              id: 'step-1',
              step: 'Inspect the change',
              status: 'pending',
              forged: true,
            },
          ],
        },
        planSummary: 'forged summary',
        planId: 'plan-1',
        version: 1,
        structuralDigest: PLAN_DIGEST,
        artifact: undefined,
      } as unknown as KernelEvent),
    ).toEqual(state);

    state = reduce(state, {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'write-plan-call',
      taskId: 'task-1',
      plan: {
        name: 'Safe plan',
        description: 'A plan with a sufficiently clear body.',
        status: 'pending',
        steps: [{ id: 'step-1', step: 'Inspect the change', status: 'pending' }],
      },
      planSummary: 'forged summary',
      planId: 'plan-1',
      version: 1,
      structuralDigest: PLAN_DIGEST,
      artifact: undefined,
    } as unknown as KernelEvent);
    expect(state.interactions).toMatchObject({
      kind: 'awaiting_review',
      plan: {
        name: 'Safe plan',
        description: 'A plan with a sufficiently clear body.',
        status: 'pending',
        steps: [{ id: 'step-1', step: 'Inspect the change', status: 'pending' }],
      },
      planSummary: 'Safe plan\n\n1. Inspect the change',
    });
    expect(state.tasks['task-1']?.planning.kind).toBe('awaiting_review');
  });

  test('provider action requires idle state and a failed tool, with one tool transcript result', () => {
    let state = initial();
    state = reduce(state, {
      type: 'tool.queued',
      toolCallId: 'failed-call',
      name: 'mcp_tool',
      args: {},
      modelMessageId: 'model-1',
    } as KernelEvent);
    state = reduce(state, { type: 'tool.started', toolCallId: 'failed-call' });
    state = reduce(state, {
      type: 'tool.failed',
      toolCallId: 'failed-call',
      failure: {
        kind: 'provider_auth_required',
        message: 'login required',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: true,
        terminatesTurn: false,
        journal: true,
      },
      outcomeV1: {
        schemaVersion: 1,
        status: 'failed',
        failure: { kind: 'provider_auth_required', detailCode: 'unknown' },
        dispatchState: 'started',
        externalEffects: 'unknown',
        recovery: {
          disposition: 'user_action',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
        timing: { source: 'legacy_unknown' },
      },
    } as KernelEvent);
    state = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          ...state.tools.calls,
          'failed-call': { ...state.tools.calls['failed-call']!, error: 'please login' },
        },
      },
    };
    state = reduce(state, {
      type: 'provider.action_required',
      interactionId: 'provider-1',
      providerId: 'provider-1',
      action: 'login',
      originatingToolCallId: 'failed-call',
    });
    expect(state.interactions).toMatchObject({
      kind: 'awaiting_provider_action',
      interactionId: 'provider-1',
      originatingToolCallId: 'failed-call',
    });
    expect(
      state.transcript.messages.filter(
        (message) => message.kind === 'tool' && message.toolCallId === 'failed-call',
      ),
    ).toHaveLength(1);
    expect(
      reduce(state, {
        type: 'provider.action_required',
        interactionId: 'provider-2',
        providerId: 'provider-1',
        action: 'login',
        originatingToolCallId: 'failed-call',
      }),
    ).toEqual(state);
  });

  test('canonical model and provider-admission sequences match the State26 test adapter', async () => {
    const rootStateModule = await import(ROOT_STATE_MODULE);
    const rootIdSourceModule = await import(ROOT_ID_SOURCE_MODULE);
    const rootReducerModule = await import(STATE26_TEST_REDUCER_MODULE);
    const rootInitial = rootStateModule.createRuntimeHostState26InitialStateV1({
      threadId: 'thread-1',
      userId: 'user-1',
      workspace: '/workspace',
      interactionMode: 'accept_edits',
      recoveryIdentityKey: IDENTITY_KEY,
      runtimeIdSource: rootIdSourceModule.createDeterministicRuntimeIdSourceV1({
        seed: 'context-interaction-parity',
        epochMs: 0,
      }),
    });
    const root = {
      ...rootInitial,
      toolRecovery: { ...rootInitial.toolRecovery, identityKey: IDENTITY_KEY },
    };
    const packageState = createInitialAgentState({
      threadId: 'thread-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: root.turn.turnId,
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const modelEvents = [
      {
        type: 'model.invocation_prepared',
        invocationId: 'inv-1',
        purpose: 'primary_agent',
        surfaceArtifact: {
          kind: 'model_surface',
          artifactId: `pa_${'b'.repeat(64)}`,
          integrityIdentifier: `sha256:${'c'.repeat(64)}`,
          byteLength: 1,
        },
        surfaceIntegrityIdentifier: `sha256:${'c'.repeat(64)}`,
        routeFingerprint: `sha256:${'d'.repeat(64)}`,
        admission: {
          providerAdmissionRevision: null,
          routeIdentityDigest: `sha256:${'e'.repeat(64)}`,
          payloadClassificationDigest: `sha256:${'f'.repeat(64)}`,
          admitted: true,
        },
        budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
        limits: { maxAttempts: 2, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 2_000 },
        preparedStateRevision: 0,
        parentInvocationId: null,
        parentToolCallId: null,
      },
      {
        type: 'model.invocation_attempt_started',
        invocationId: 'inv-1',
        attempt: 2,
        maxAttempts: 2,
      },
      {
        type: 'model.invocation_attempt_started',
        invocationId: 'inv-1',
        attempt: 1,
        maxAttempts: 2,
      },
    ] as const;
    let rootAfter = root;
    let packageAfter = packageState;
    for (const event of modelEvents) {
      rootAfter = rootReducerModule.reduceRuntimeState(rootAfter, event);
      packageAfter = reduceAgentState(packageAfter, event as unknown as KernelEvent);
    }
    expect(JSON.stringify(packageAfter)).toBe(JSON.stringify(rootAfter));

    const providerEvents = [
      {
        type: 'provider.admission_required',
        interactionId: 'admission-1',
        providerId: 'provider-1',
        source: 'explicit',
        providerStatus: 'login_required',
        retryable: true,
      },
      {
        type: 'provider.admission_required',
        interactionId: 'duplicate',
        providerId: 'provider-1',
        source: 'explicit',
        providerStatus: 'failed',
        retryable: false,
      },
      {
        type: 'provider.admission_retry_failed',
        interactionId: 'admission-1',
        providerStatus: 'failed',
        diagnosticCode: 'auth_required',
      },
    ] as const;
    let rootProvider = root;
    let packageProvider = packageState;
    for (const event of providerEvents) {
      rootProvider = rootReducerModule.reduceRuntimeState(rootProvider, event);
      packageProvider = reduceAgentState(packageProvider, event as unknown as KernelEvent);
    }
    expect(JSON.stringify(packageProvider)).toBe(JSON.stringify(rootProvider));

    const planDocument = {
      planSchemaVersion: 2,
      planId: 'plan-1',
      version: 1,
      title: 'Safe plan',
      bodyMarkdown: 'A plan with a sufficiently clear body.',
      steps: [{ id: 'step-1', title: 'Inspect the change', status: 'pending' }],
      structuralDigest: PLAN_DIGEST,
      createdAtTurnId: root.turn.turnId,
      updatedAtTurnId: root.turn.turnId,
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    } as const;
    const planTask = {
      taskId: 'task-1',
      userGoal: 'goal',
      status: 'active',
      startedAtTurnId: root.turn.turnId,
      sideEffectsStarted: false,
      planning: { kind: 'planning_draft', document: planDocument },
      planHistory: [],
    } as const;
    let rootPlan = {
      ...root,
      activeTaskId: 'task-1',
      tasks: { 'task-1': planTask },
      tools: {
        ...root.tools,
        calls: {
          c1: {
            toolCallId: 'c1',
            name: 'write_plan',
            modelMessageId: 'm1',
            args: {},
            createdAtTurnId: root.turn.turnId,
            status: 'queued',
          },
        },
      },
    };
    let packagePlan: AgentState = {
      ...createInitialAgentState({
        threadId: 'thread-1',
        userId: 'user-1',
        workspace: '/workspace',
        turnId: root.turn.turnId,
        recoveryIdentityKey: IDENTITY_KEY,
      }),
      activeTaskId: 'task-1',
      tasks: { 'task-1': planTask },
      tools: {
        ...packageState.tools,
        calls: {
          c1: {
            toolCallId: 'c1',
            name: 'write_plan',
            modelMessageId: 'm1',
            args: {},
            createdAtTurnId: root.turn.turnId,
            status: 'queued',
          },
        },
      },
    } as AgentState;
    const planReviewEvent = {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'c1',
      taskId: 'task-1',
      plan: {
        name: planDocument.title,
        description: planDocument.bodyMarkdown,
        status: 'pending',
        steps: [{ id: 'step-1', step: 'Inspect the change', status: 'pending' }],
      },
      planSummary: 'forged summary',
      planId: 'plan-1',
      version: 1,
      structuralDigest: PLAN_DIGEST,
      artifact: undefined,
    } as const;
    rootPlan = rootReducerModule.reduceRuntimeState(rootPlan, planReviewEvent);
    packagePlan = reduceAgentState(packagePlan, planReviewEvent as unknown as KernelEvent);
    expect(JSON.stringify(packagePlan)).toBe(JSON.stringify(rootPlan));
    const planApprovalEvent = {
      type: 'plan.approved',
      interactionId: 'review-1',
      toolCallId: 'c1',
      planId: 'plan-1',
      version: 1,
      structuralDigest: PLAN_DIGEST,
      executionMode: 'auto',
    } as const;
    rootPlan = rootReducerModule.reduceRuntimeState(rootPlan, planApprovalEvent);
    packagePlan = reduceAgentState(packagePlan, planApprovalEvent as unknown as KernelEvent);
    expect(JSON.stringify(packagePlan)).toBe(JSON.stringify(rootPlan));

    const failedCall = {
      toolCallId: 'failed-call',
      name: 'mcp_tool',
      modelMessageId: 'm1',
      args: {},
      createdAtTurnId: root.turn.turnId,
      status: 'failed',
      error: 'please login',
    } as const;
    const rootAction = {
      ...root,
      tools: { ...root.tools, calls: { 'failed-call': failedCall } },
    };
    const packageAction = {
      ...packageState,
      tools: { ...packageState.tools, calls: { 'failed-call': failedCall } },
    };
    const actionEvent = {
      type: 'provider.action_required',
      interactionId: 'action-1',
      providerId: 'provider-1',
      action: 'login',
      originatingToolCallId: 'failed-call',
    } as const;
    const rootActionAfter = rootReducerModule.reduceRuntimeState(rootAction, actionEvent);
    const packageActionAfter = reduceAgentState(
      packageAction,
      actionEvent as unknown as KernelEvent,
    );
    expect(JSON.stringify(packageActionAfter)).toBe(JSON.stringify(rootActionAfter));
    const malformedActionEvent = {
      ...actionEvent,
      interactionId: 'action-malformed',
      action: { forged: true },
    } as const;
    const rootMalformedAction = rootReducerModule.reduceRuntimeState(
      rootAction,
      malformedActionEvent,
    );
    const packageMalformedAction = reduceAgentState(
      packageAction,
      malformedActionEvent as unknown as KernelEvent,
    );
    expect(JSON.stringify(packageMalformedAction)).toBe(JSON.stringify(rootMalformedAction));
  });
});
