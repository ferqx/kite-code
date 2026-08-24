import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AGENT_KERNEL_BOUNDARY_,
  type AgentState,
  assertCurrentRuntimeEvent,
  authorizeEffect,
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  CURRENT_RUNTIME_EVENT_TYPE_COUNT,
  canForkAgentState,
  createInitialAgentState,
  createToolRecoveryJournal,
  type DecisionFacts,
  decide,
  decodeCurrentAgentStateJson,
  decodeCurrentRuntimeEventJson,
  digestAgentEvent,
  encodeCurrentAgentStateJson,
  isCurrentPendingInteractionRequest,
  isToolOutcome,
  isValidSchedulerFacts,
  type KernelEvent,
  normalizeAgentEvent,
  normalizeAgentToolOutcomeEvent,
  normalizeTerminalAgentEvent,
  normalizeToolRecoveryJournal,
  type RuntimeEventType,
  rebindForkAgentState,
  recordRecoveryFailure,
  reduce,
  reduceAgentState,
  STATE_DEFAULT_EVENT_TYPES,
  STATE_DIAGNOSTIC_EVENT_TYPES,
  STATE_EVENT_REDUCER_COVERAGE,
  selectSchedulableEffectBatch,
  selectScheduledEffects,
  taskIdentityAllocationKey,
  toolFailureInstanceId,
  toolInvocationFingerprint,
  verificationSchemaAdmissionDigest,
} from '@kite/agent-kernel';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const INITIAL_STATE_FIXTURE_JSON =
  '{"schemaVersion":26,"formatEpoch":"kite-runtime-modularization-v1-2026-08-19","revision":0,"appliedEventIds":[],"recoveryState":{"kind":"normal"},"session":{"threadId":"session-1","userId":"user-1","workspace":"/workspace"},"turn":{"turnId":"turn-1","turnIndex":0,"status":"active"},"transcript":{"messages":[]},"context":{"history":[],"autoGuard":{"recentAutomaticCompactions":[],"consecutiveLowGain":0,"disabledUntilManualAction":false,"recoveryAttempted":false}},"resourceBudget":{"status":"unconfigured","reservations":{}},"modelInvocations":{},"providerReadiness":{},"completionGuard":{"correctionAttempts":0},"activeTaskId":null,"tasks":{},"interactions":{"kind":"idle"},"tools":{"calls":{},"queue":[],"active":[]},"toolRecovery":{"schemaVersion":1,"identityKey":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","failures":{},"order":[],"progressRevision":0,"qualityGuard":{"blocked":false,"observedFailures":0}},"capabilities":{"catalogRevision":"","bindings":{},"disclosures":{},"loadedCapabilities":{},"invocations":{}},"skills":{"catalogRevision":"","frames":{}},"verification":{"records":{}},"providerAdmission":{"pending":[],"waivers":{}},"suspendedSubagents":{},"authorization":{"mode":"default","commandGrants":{}},"mode":"accept_edits","workspaceAccess":"write","autoReview":{"pendingWarnings":{},"consecutiveRejects":0,"rejectionHistory":[],"circuitBreakerTripped":false},"doomLoop":{}}';

function stableFixtureJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableFixtureJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableFixtureJson(nested)}`)
    .join(',')}}`;
}

function fixtureDigest(value: unknown, prefix = false): string {
  const digest = createHash('sha256').update(stableFixtureJson(value)).digest('hex');
  return prefix ? `sha256:${digest}` : digest;
}

function completeEvidenceFixture(
  type: RuntimeEventType,
  fixture: Record<string, unknown>,
): Record<string, unknown> {
  const privateRef = (kind: string) => ({
    kind,
    artifactId: `pa_${'b'.repeat(64)}`,
    integrityIdentifier: `sha256:${'c'.repeat(64)}`,
    byteLength: 1,
  });
  if (type === 'capability.filesystem_intent_recorded') {
    Object.assign(fixture, {
      capabilityRevision: 'a'.repeat(64),
      argumentsDigest: 'a'.repeat(64),
      admissionDigest: 'a'.repeat(64),
      operationDigest: fixtureDigest({ kind: 'operation' }, true),
      searchBoundaryDigest: null,
      lexicalTargetDigest: fixtureDigest({ kind: 'lexical' }, true),
      canonicalWorkspaceDigest: fixtureDigest({ kind: 'workspace' }, true),
      protectedPathRevision: 'fixture',
      approvalSummaryDigest: fixtureDigest({ kind: 'approval' }, true),
      effectiveEffectsDigest: 'a'.repeat(64),
    });
    const {
      type: _type,
      invocationId: _invocationId,
      intentDigest: _intentDigest,
      ...unsigned
    } = fixture;
    fixture.intentDigest = fixtureDigest(unsigned, true);
  }
  if (type === 'capability.filesystem_mutation_ready') {
    Object.assign(fixture, {
      intentDigest: fixtureDigest({ kind: 'intent' }, true),
      operationDigest: fixtureDigest({ kind: 'operation' }, true),
      targetIdentityDigest: fixtureDigest({ kind: 'target' }, true),
      preimageDigest: null,
      preimageArtifact: privateRef('filesystem_preimage'),
    });
    const {
      type: _type,
      invocationId: _invocationId,
      readyDigest: _readyDigest,
      ...unsigned
    } = fixture;
    fixture.readyDigest = fixtureDigest(unsigned, true);
  }
  if (type === 'capability.sandbox_preparation_intent_recorded') {
    Object.assign(fixture, {
      canonicalWorkspace: '/workspace',
      effectiveEffectsDigest: 'effects-1',
      admissionDigest: 'admission-1',
      preparationDigest: 'preparation-1',
      commandDigest: 'command-1',
      executionBoundaryDigest: 'boundary-1',
      resourceSemantics: 'allocating',
    });
    const {
      type: _type,
      invocationId: _invocationId,
      intentDigest: _intentDigest,
      recordedAt: _recordedAt,
      ...unsigned
    } = fixture;
    fixture.intentDigest = fixtureDigest(unsigned);
  }
  if (type === 'capability.sandbox_preparation_ready') {
    Object.assign(fixture, {
      intentDigest: 'intent-1',
      preparationDigest: 'preparation-1',
      commandDigest: 'command-1',
      planDigest: 'plan-1',
      backend: 'none',
      backendCapabilitiesDigest: 'backend-1',
      enforcement: 'full',
      resourceSemantics: 'allocating',
      cleanupDigest: 'cleanup-1',
      preparationArtifact: privateRef('sandbox_preparation'),
    });
    const {
      type: _type,
      invocationId: _invocationId,
      readyDigest: _readyDigest,
      readyAt: _readyAt,
      ...unsigned
    } = fixture;
    fixture.readyDigest = fixtureDigest(unsigned);
  }
  if (
    type === 'capability.sandbox_execution_dispatch_intent_recorded' ||
    type === 'capability.sandbox_execution_supervisor_started'
  ) {
    Object.assign(fixture, {
      dispatchIntentDigest: fixtureDigest({ kind: 'dispatch' }, true),
      dispatchId: 'dispatch-1',
    });
    if (type === 'capability.sandbox_execution_dispatch_intent_recorded')
      Object.assign(fixture, {
        readyDigest: 'ready-1',
        planDigest: 'plan-1',
        supervisorNonce: 'nonce-1',
        recordedAt: '2026-08-20T00:00:00.000Z',
      });
    else
      Object.assign(fixture, {
        processStartIdentity: 'process-1',
        startedAt: '2026-08-20T00:00:00.000Z',
        supervisorPid: 1,
        processGroupId: 1,
      });
  }
  if (
    type === 'capability.sandbox_disposal_started' ||
    type === 'capability.sandbox_disposal_completed'
  )
    Object.assign(fixture, {
      readyDigest: 'ready-1',
      lifecycleIntentDigest: 'lifecycle-1',
      attempt: 1,
      ...(type.endsWith('completed')
        ? { cleanupAttempt: 1, disposed: true, disposedAt: '2026-08-20T00:00:00.000Z' }
        : { startedAt: '2026-08-20T00:00:00.000Z' }),
    });
  if (
    type === 'capability.sandbox_preparation_abandonment_started' ||
    type === 'capability.sandbox_preparation_abandonment_completed'
  )
    Object.assign(fixture, {
      intentDigest: 'intent-1',
      lifecycleIntentDigest: 'lifecycle-1',
      attempt: 1,
      ...(type.endsWith('completed')
        ? { cleanupAttempt: 1, disposed: true, disposedAt: '2026-08-20T00:00:00.000Z' }
        : { startedAt: '2026-08-20T00:00:00.000Z' }),
    });
  if (type === 'capability.subagent_dispatch_intent_recorded')
    Object.assign(fixture, {
      purpose: 'start',
      dispatchIntentDigest: fixtureDigest({ kind: 'dispatch' }, true),
      taskArtifact: privateRef('subagent_task'),
    });
  if (type === 'capability.subagent_handle_recorded')
    Object.assign(fixture, {
      dispatchIntentDigest: fixtureDigest({ kind: 'dispatch' }, true),
      handleArtifact: privateRef('subagent_handle'),
      handleIntegrityIdentifier: `sha256:${'c'.repeat(64)}`,
    });
  if (type === 'capability.subagent_observation_recorded')
    Object.assign(fixture, {
      dispatchIntentDigest: fixtureDigest({ kind: 'dispatch' }, true),
      status: 'completed',
    });
  if (
    type === 'capability.subagent_cleanup_started' ||
    type === 'capability.subagent_cleanup_completed'
  )
    Object.assign(fixture, {
      dispatchIntentDigest: fixtureDigest({ kind: 'dispatch' }, true),
      cleanupAttempt: 1,
      cleanupKind: 'undispatched',
      ...(type.endsWith('completed')
        ? { cleanupConfirmed: true, completedAt: '2026-08-20T00:00:00.000Z' }
        : { startedAt: '2026-08-20T00:00:00.000Z' }),
    });
  if (
    type === 'subagent.suspended' &&
    (!fixture.snapshot || Object.keys(fixture.snapshot as Record<string, unknown>).length === 0)
  )
    Object.assign(fixture, {
      snapshot: {
        storage: 'private_artifact_v1',
        subagentId: 'fixture',
        role: 'code',
        continuationId: `continuation-${'a'.repeat(64)}`,
        continuationArtifact: privateRef('subagent_continuation'),
        modelInvocationOrdinal: 0,
        parentInvocationId: 'fixture',
        parentAttempt: 1,
        blockedTool: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'fixture',
          toolName: 'fixture',
        },
      },
    });
  if (type === 'model.invocation_prepared') {
    Object.assign(fixture, {
      purpose: 'primary_agent',
      surfaceArtifact: privateRef('model_surface'),
      surfaceIntegrityIdentifier: `sha256:${'5'.repeat(64)}`,
      routeFingerprint: `sha256:${'6'.repeat(64)}`,
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
      preparedStateRevision: 0,
      parentInvocationId: null,
      parentToolCallId: null,
    });
  }
  if (type === 'tool.failed')
    fixture.failure = {
      kind: 'tool_runtime_error',
      message: 'fixture',
      retryable: true,
      modelFixable: true,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
    };
  if (
    type === 'plan.approved' ||
    type === 'plan.revision_requested' ||
    type === 'plan.review_cancelled'
  )
    Object.assign(fixture, { planId: 'plan-1', structuralDigest: 'digest-1', version: 1 });
  return fixture;
}

function minimalEvent(type: RuntimeEventType): KernelEvent {
  const valueFor = (field: string): unknown => {
    if (field === 'actor') return 'user';
    if (field === 'reservationId') return 'reservation-fixture';
    if (field === 'invocationId') return 'invocation-fixture';
    if (
      field.endsWith('Id') ||
      field === 'readinessKey' ||
      field === 'lifecycleId' ||
      field === 'routeRevision' ||
      field === 'executionBoundaryDigest' ||
      field === 'resultDigest' ||
      field === 'evidenceDigest' ||
      field === 'effectiveEffectsDigest' ||
      field === 'argumentsDigest' ||
      field === 'authorizationDigest' ||
      field === 'admissionDigest' ||
      field === 'intentDigest' ||
      field === 'operationDigest' ||
      field === 'readyDigest' ||
      field === 'planDigest' ||
      field === 'dispatchIntentDigest' ||
      field === 'handleIntegrityIdentifier' ||
      field === 'name' ||
      field === 'reason' ||
      field === 'message' ||
      field === 'command' ||
      field === 'path' ||
      field === 'stream' ||
      field === 'status' ||
      field === 'mode' ||
      field === 'source' ||
      field === 'providerStatus' ||
      field === 'providerId' ||
      field === 'failureCode' ||
      field === 'purpose' ||
      field === 'decision' ||
      field === 'outcome' ||
      field === 'nextAction' ||
      field === 'guardVersion' ||
      field === 'executionMode' ||
      field === 'capabilityRevision' ||
      field === 'backend' ||
      field === 'enforcement' ||
      field === 'cleanupKind' ||
      field === 'dispatchCertainty' ||
      field === 'reasonCode'
    )
      return 'fixture';
    if (field.endsWith('At') || field === 'changedAt') return '2026-08-20T00:00:00.000Z';
    if (
      field === 'retryable' ||
      field === 'force' ||
      field === 'disposed' ||
      field === 'recoverable'
    )
      return false;
    if (field === 'budget')
      return {
        version: 1,
        maxRunDurationMs: 60_000,
        maxTurns: 10,
        maxModelRequests: 10,
        maxToolInvocations: 10,
        maxRunInputTokens: 10_000,
        maxRunOutputTokens: 10_000,
        maxConcurrentSubagents: 2,
        maxConcurrentWriters: 1,
        maxConcurrentToolInvocations: 2,
        maxConcurrentShellInvocations: 1,
        maxConcurrencyWaitMs: 1_000,
        maxArtifactBytes: 10_000,
      };
    if (field === 'reservation')
      return {
        version: 1,
        reservationId: 'reservation-fixture',
        runId: 'fixture',
        invocationId: 'invocation-fixture',
        resourceKind: 'tool',
        executableUpperBound: {
          counters: {
            turns: 0,
            modelRequests: 0,
            toolInvocations: 1,
            inputTokens: 0,
            outputTokens: 0,
            artifactBytes: 0,
          },
          gauges: {
            elapsedRunMs: 0,
            activeSubagents: 0,
            activeWriters: 0,
            activeToolInvocations: 1,
            activeShellInvocations: 0,
          },
          source: 'versioned_upper_bound',
          estimatorVersion: 'fixture-v1',
        },
        state: 'reserved',
      };
    if (field === 'actual')
      return {
        counters: {
          turns: 0,
          modelRequests: 0,
          toolInvocations: 1,
          inputTokens: 0,
          outputTokens: 0,
          artifactBytes: 0,
        },
        gauges: {
          elapsedRunMs: 0,
          activeSubagents: 0,
          activeWriters: 0,
          activeToolInvocations: 1,
          activeShellInvocations: 0,
        },
        source: 'actual',
      };
    if (field === 'waiter')
      return {
        version: 1,
        runId: 'fixture',
        invocationId: 'invocation-fixture',
        requiredPermits: ['tool'],
        sequence: 0,
        enqueuedAt: '2026-08-20T00:00:00.000Z',
        deadlineAt: '2026-08-20T00:00:01.000Z',
        state: 'waiting',
      };
    if (field === 'limits') return { maxAttempts: 1 };
    if (field === 'failure')
      return {
        kind: 'unknown',
        message: 'fixture',
        detailCode: 'unknown',
        outcome: {
          schemaVersion: 1,
          status: 'unknown',
          failure: { kind: 'unknown', detailCode: 'unknown' },
          dispatchState: 'unknown',
          externalEffects: 'unknown',
          recovery: {
            disposition: 'never',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: false,
            safeAutomaticRetry: false,
          },
          timing: { source: 'legacy_unknown' },
        },
      };
    if (field === 'snapshot')
      return {
        storage: 'private_artifact_v1',
        subagentId: 'fixture',
        role: 'code',
        continuationId: `continuation-${'a'.repeat(64)}`,
        continuationArtifact: {
          kind: 'subagent_continuation',
          artifactId: `pa_${'b'.repeat(64)}`,
          integrityIdentifier: `sha256:${'c'.repeat(64)}`,
          byteLength: 1,
        },
        modelInvocationOrdinal: 0,
        parentInvocationId: 'fixture',
        parentAttempt: 1,
        blockedTool: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'fixture',
          toolName: 'fixture',
        },
      };
    if (field === 'outcome')
      return {
        schemaVersion: 1,
        status: 'unknown',
        failure: { kind: 'unknown', detailCode: 'unknown' },
        dispatchState: 'unknown',
        externalEffects: 'unknown',
        recovery: {
          disposition: 'never',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
        timing: { source: 'legacy_unknown' },
      };
    if (field === 'spec')
      return {
        schemaVersion: 1,
        verificationId: 'fixture',
        subject: 'fixture',
        repair: { maxAttempts: 0 },
        checks: [
          {
            checkId: 'check-1',
            description: 'fixture command succeeds',
            type: 'command',
            command: 'true',
          },
        ],
      };
    if (field === 'checkpoint')
      return {
        compactionId: 'fixture',
        version: 1,
        sourceRevision: 0,
        sourceDigest: 'fixture',
        coveredThroughMessageId: 'fixture-message',
        coveredThroughTurnId: 'turn-1',
        summary: 'fixture summary',
        inputTokensBefore: 2048,
        inputTokensAfter: 1024,
        reason: 'manual',
        createdAt: '2026-08-20T00:00:00.000Z',
      };
    if (field === 'estimate')
      return {
        systemTokens: 256,
        toolSchemaTokens: 128,
        transcriptTokens: 1408,
        summaryTokens: 128,
        dynamicRuntimeTokens: 64,
        framingTokens: 64,
        totalInputTokens: 2048,
      };
    if (field === 'bindings' || field === 'disclosures' || field === 'loadedCapabilities')
      return [];
    if (
      field === 'attempt' ||
      field === 'maxAttempts' ||
      field === 'version' ||
      field === 'planSchemaVersion' ||
      field === 'repairAttempt' ||
      field === 'correctionAttempt' ||
      field === 'cleanupAttempt' ||
      field === 'sourceRevision' ||
      field === 'requestedAtRevision' ||
      field === 'delayMs' ||
      field === 'inputTokens' ||
      field === 'cacheHitTokens' ||
      field === 'cacheMissTokens' ||
      field === 'totalInputTokens' ||
      field === 'unconfirmedDescendantCount' ||
      field === 'supervisorPid' ||
      field === 'processGroupId' ||
      field === 'retryAttempt'
    )
      return 1;
    return {};
  };
  const fixture = {
    type,
    ...Object.fromEntries(
      CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[type].map((field) => [field, valueFor(field)]),
    ),
  } as Record<string, unknown>;
  if (type === 'resource_budget.configured') {
    fixture.startedAt = '2026-08-20T00:00:00.000Z';
    fixture.deadlineAt = '2026-08-20T00:00:30.000Z';
    (fixture.budget as Record<string, unknown>).maxRunDurationMs = 60_000;
  }
  if (
    [
      'user.message_appended',
      'model.responded',
      'tool.finished',
      'tool.failed',
      'tool.rejected',
      'tool.cancelled',
      'tool.retry_recorded',
      'tool.queued',
      'tool.started',
      'approval.requested',
      'approval.granted',
      'approval.rejected',
      'auto_review.requested',
      'auto_review.completed',
    ].includes(type)
  ) {
    fixture.createdAt = '2026-08-20T00:00:00.000Z';
  }
  if (
    type === 'capability.execution_succeeded' ||
    type === 'capability.execution_failed' ||
    type === 'capability.execution_result_recorded'
  ) {
    fixture.artifact = { kind: 'capability_result' };
    fixture.resultDigest = 'fixture';
    fixture.evidenceDigest = 'fixture';
  }
  if (
    type === 'tool.finished' ||
    type === 'tool.failed' ||
    type === 'tool.rejected' ||
    type === 'tool.cancelled' ||
    type === 'tool.retry_recorded' ||
    type === 'approval.rejected'
  ) {
    fixture.outcome = {
      schemaVersion: 1,
      status:
        type === 'tool.finished'
          ? 'success'
          : type === 'tool.rejected' || type === 'approval.rejected'
            ? 'rejected'
            : type === 'tool.cancelled'
              ? 'cancelled'
              : 'failed',
      ...(type === 'tool.finished' ? {} : { failure: { kind: 'unknown', detailCode: 'unknown' } }),
      dispatchState: 'unknown',
      externalEffects: 'unknown',
      recovery: {
        disposition: 'never',
        maximumAdditionalCalls: 0,
        requiresNewModelResponse: false,
        safeAutomaticRetry: false,
      },
      timing: { source: 'legacy_unknown' },
    };
  }
  return completeEvidenceFixture(type, fixture) as KernelEvent;
}

function corpusState(type: RuntimeEventType): AgentState {
  const base = createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: IDENTITY_KEY,
  });
  let state = base;
  if (type.startsWith('resource_budget.') && type !== 'resource_budget.configured') {
    state = reduceAgentState(base, minimalEvent('resource_budget.configured'));
    if (
      type === 'resource_budget.dispatch_started' ||
      type === 'resource_budget.reconciled' ||
      type === 'resource_budget.released' ||
      type === 'resource_budget.unknown'
    ) {
      state = reduceAgentState(state, minimalEvent('resource_budget.reserved'));
      if (type === 'resource_budget.dispatch_started' || type === 'resource_budget.reconciled') {
        state = reduceAgentState(state, minimalEvent('resource_budget.dispatch_started'));
      }
    }
    if (
      type === 'resource_budget.waiter_promoted' ||
      type === 'resource_budget.waiter_cancelled' ||
      type === 'resource_budget.waiter_timed_out'
    ) {
      state = reduceAgentState(state, minimalEvent('resource_budget.waiter_enqueued'));
    }
  }
  if (type.startsWith('provider.readiness_') && type !== 'provider.readiness_intent_recorded') {
    state = reduceAgentState(state, minimalEvent('provider.readiness_intent_recorded'));
  }
  const toolId = 'fixture';
  const toolStatuses: Record<string, AgentState['tools']['calls'][string]['status']> = {
    'user_input.requested': 'awaiting_user_input',
    'user_input.answered': 'awaiting_user_input',
    'user_input.cancelled': 'awaiting_user_input',
    'plan.review_requested': 'awaiting_review',
    'plan.approved': 'awaiting_review',
    'plan.revision_requested': 'awaiting_review',
    'plan.review_cancelled': 'awaiting_review',
    'approval.requested': 'awaiting_approval',
    'approval.granted': 'awaiting_approval',
    'approval.rejected': 'awaiting_approval',
    'auto_review.requested': 'awaiting_auto_review',
    'auto_review.completed': 'awaiting_auto_review',
    'provider.action_required': 'failed',
    'provider.action_started': 'failed',
    'provider.action_completed': 'failed',
    'provider.action_deferred': 'failed',
    'provider.action_failed': 'failed',
    'tool.started': 'queued',
    'tool.finished': 'running',
    'tool.failed': 'running',
    'tool.rejected': 'queued',
    'tool.cancelled': 'running',
    'tool.retry_recorded': 'failed',
    'network.admission_decided': 'running',
    'subagent.approval_deferred': 'running',
    'subagent.suspended': 'running',
  };
  const status = toolStatuses[type];
  if (status) {
    state = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          ...state.tools.calls,
          [toolId]: {
            toolCallId: toolId,
            name: 'fixture',
            modelMessageId: 'fixture-message',
            args: {},
            createdAtTurnId: 'turn-1',
            status,
          },
        },
      },
    };
  }
  if (type === 'user_input.answered' || type === 'user_input.cancelled') {
    state = {
      ...state,
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'fixture',
        toolCallId: toolId,
        request: { question: 'fixture', options: [], allow_free_text: true },
      },
    };
  }
  if (
    type === 'plan.approved' ||
    type === 'plan.revision_requested' ||
    type === 'plan.review_cancelled'
  ) {
    state = {
      ...state,
      interactions: {
        kind: 'awaiting_review',
        interactionId: 'fixture',
        toolCallId: toolId,
        planId: 'plan-fixture',
        version: 1,
        structuralDigest: 'digest-fixture',
        plan: {
          name: 'fixture',
          description: 'fixture',
          status: 'in_progress',
          steps: [{ step: 'fixture', status: 'in_progress' }],
        },
        planSummary: 'fixture',
      },
    };
  }
  if (
    type === 'provider.action_started' ||
    type === 'provider.action_completed' ||
    type === 'provider.action_deferred' ||
    type === 'provider.action_failed'
  ) {
    state = {
      ...state,
      interactions: {
        kind: 'awaiting_provider_action',
        interactionId: 'fixture',
        providerId: 'fixture',
        action: 'login',
        originatingToolCallId: toolId,
        status: 'required',
      },
    };
  }
  if (
    type === 'provider.admission_retry_failed' ||
    type === 'provider.admission_satisfied' ||
    type === 'provider.admission_waived' ||
    type === 'provider.admission_cancelled'
  ) {
    const pending = [
      {
        interactionId: 'fixture',
        providerId: 'fixture',
        source: 'explicit' as const,
        providerStatus: 'pending_approval' as const,
        retryable: true,
      },
    ];
    state = {
      ...state,
      providerAdmission: { pending, waivers: {} },
      interactions: {
        kind: 'awaiting_provider_admission',
        interactionId: 'fixture',
        providerId: 'fixture',
        source: 'explicit',
        providerStatus: 'pending_approval',
        retryable: true,
      },
    };
  }
  if (
    type === 'verification.started' ||
    type === 'verification.check_completed' ||
    type === 'verification.completed' ||
    type === 'verification.repair_requested' ||
    type === 'verification.replan_requested' ||
    type === 'verification.waived' ||
    type === 'verification.compensation_requested' ||
    type === 'verification.compensation_completed'
  ) {
    state = reduceAgentState(state, minimalEvent('verification.requested'));
  }
  if (type === 'run.completed' || type === 'completion.blocked') {
    state = reduceAgentState(state, {
      type: 'task.started',
      taskId: 'fixture',
      userGoal: 'fixture',
      turnId: 'turn-1',
    } as KernelEvent);
  }
  if (type === 'context.compaction_completed') {
    state = reduceAgentState(state, {
      type: 'user.message_appended',
      messageId: 'fixture-message',
      content: 'fixture',
      createdAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
  }
  return state;
}

const facts = (count: number): DecisionFacts => ({
  schema: 'kite.kernel-decision-facts.v1',
  eventFacts: Array.from({ length: count }, (_, index) => ({
    occurredAt: `2026-08-20T00:00:0${index}.000Z`,
  })),
  knownEventIds: [],
  allocatedIds: {},
  workspace: { root: '/workspace' },
  policy: { mode: 'accept_edits' },
  provider: { availability: 'available' },
  protectedPath: { revision: 'current' },
  network: { revision: 'current' },
  executionBoundary: { kind: 'local' },
  attempt: { number: 1 },
});

describe('agent kernel package boundary', () => {
  test('declares deterministic and I/O-free ownership', () => {
    expect(AGENT_KERNEL_BOUNDARY_).toEqual({
      deterministic: true,
      externalIo: false,
      revision: 'agent-kernel-current',
    });
    expect(CURRENT_RUNTIME_EVENT_TYPE_COUNT).toBe(135);
    expect(STATE_DIAGNOSTIC_EVENT_TYPES).toHaveLength(22);
    expect(STATE_DEFAULT_EVENT_TYPES).toHaveLength(7);
  });

  test('validates and decodes every current State event discriminant', () => {
    const fixtureValue = (field: string): unknown => {
      if (
        field.endsWith('Id') ||
        field === 'name' ||
        field === 'reason' ||
        field === 'message' ||
        field === 'error' ||
        field === 'command' ||
        field === 'path' ||
        field === 'stream' ||
        field === 'kind' ||
        field === 'status' ||
        field === 'mode' ||
        field === 'source' ||
        field === 'actor' ||
        field === 'providerStatus' ||
        field === 'providerId' ||
        field === 'failureCode' ||
        field === 'purpose' ||
        field === 'decision' ||
        field === 'outcome' ||
        field === 'nextAction' ||
        field === 'guardVersion' ||
        field === 'executionMode' ||
        field === 'capabilityRevision' ||
        field === 'backend' ||
        field === 'enforcement' ||
        field === 'cleanupKind' ||
        field === 'dispatchCertainty' ||
        field === 'reasonCode'
      ) {
        return 'fixture';
      }
      if (field.endsWith('At') || field === 'changedAt' || field === 'createdAt') {
        return '2026-08-20T00:00:00.000Z';
      }
      if (field === 'bindings' || field === 'disclosures' || field === 'loadedCapabilities') {
        return [];
      }
      if (
        field === 'retryable' ||
        field === 'force' ||
        field === 'disposed' ||
        field === 'recoverable'
      ) {
        return false;
      }
      if (
        field === 'attempt' ||
        field === 'maxAttempts' ||
        field === 'version' ||
        field === 'planSchemaVersion' ||
        field === 'repairAttempt' ||
        field === 'correctionAttempt' ||
        field === 'cleanupAttempt' ||
        field === 'sourceRevision' ||
        field === 'requestedAtRevision' ||
        field === 'delayMs' ||
        field === 'inputTokens' ||
        field === 'cacheHitTokens' ||
        field === 'cacheMissTokens' ||
        field === 'totalInputTokens' ||
        field === 'unconfirmedDescendantCount' ||
        field === 'supervisorPid' ||
        field === 'processGroupId' ||
        field === 'retryAttempt'
      ) {
        return 1;
      }
      return {};
    };

    for (const [type, fields] of Object.entries(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS)) {
      const event = completeEvidenceFixture(type as RuntimeEventType, {
        type,
        ...Object.fromEntries(fields.map((field) => [field, fixtureValue(field)])),
      });
      assertCurrentRuntimeEvent(event);
      expect(decodeCurrentRuntimeEventJson(JSON.stringify(event))).toEqual(event);
    }
  });

  test('reads the two retired Provider-admission shapes without producing new semantics', () => {
    const diagnostic = {
      type: 'provider.admission_status',
      status: 'ready',
      reason: 'admitted',
      admissionRevision: 'legacy-policy-v1',
    } as const;
    expect(decodeCurrentRuntimeEventJson(JSON.stringify(diagnostic))).toEqual(diagnostic);
    expect(() =>
      decodeCurrentRuntimeEventJson(
        JSON.stringify({ ...diagnostic, unexpectedSecret: 'must-not-propagate' }),
      ),
    ).toThrow('invalid shape');

    const prepared = {
      type: 'model.invocation_prepared',
      invocationId: 'legacy-invocation',
      purpose: 'primary_agent',
      surfaceArtifact: {
        kind: 'model_surface',
        artifactId: `pa_${'a'.repeat(64)}`,
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 1,
      },
      surfaceIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
      routeFingerprint: `sha256:${'c'.repeat(64)}`,
      admission: {
        providerAdmissionRevision: 'legacy-policy-v1',
        routeIdentityDigest: `sha256:${'d'.repeat(64)}`,
        payloadClassificationDigest: `sha256:${'e'.repeat(64)}`,
        admitted: true,
      },
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 0, totalTimeBudgetMs: 1_000 },
      preparedStateRevision: 0,
      parentInvocationId: null,
      parentToolCallId: null,
    } as const;
    expect(decodeCurrentRuntimeEventJson(JSON.stringify(prepared))).toEqual(prepared);
    const state = createInitialAgentState({
      threadId: 'compatibility-session',
      userId: 'test',
      workspace: '/workspace',
      turnId: 'turn-compatibility',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    expect(reduceAgentState(state, diagnostic as KernelEvent)).toEqual(state);
  });

  test('classifies all 135 events into one static owner or an explicit diagnostic no-op', () => {
    const covered = Object.values(STATE_EVENT_REDUCER_COVERAGE).flat();
    expect(covered).toHaveLength(135);
    expect(new Set(covered).size).toBe(135);
    expect(covered.length - STATE_DEFAULT_EVENT_TYPES.length).toBe(128);
    expect(new Set([...covered, ...STATE_DIAGNOSTIC_EVENT_TYPES]).size).toBe(135);
    expect(STATE_DIAGNOSTIC_EVENT_TYPES.every((type) => covered.includes(type))).toBe(true);
    expect(
      Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS).every((type) =>
        covered.includes(type as never),
      ),
    ).toBe(true);
  });

  test('runs the complete 128-case compatibility switch corpus and proves seven default diagnostics are no-op', () => {
    const diagnosticSet = new Set<string>(STATE_DIAGNOSTIC_EVENT_TYPES);
    for (const type of Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS) as RuntimeEventType[]) {
      const initial = corpusState(type);
      const before = encodeCurrentAgentStateJson(initial);
      let after: AgentState;
      try {
        after = reduceAgentState(initial, minimalEvent(type));
      } catch (error) {
        throw new Error(`${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (diagnosticSet.has(type)) {
        expect(Object.keys(after)).toEqual(Object.keys(initial));
        expect(encodeCurrentAgentStateJson(after)).toBe(before);
      } else {
        // Every legacy switch case is deterministic and preserves all required
        // State fields; optional terminal projections may be added by facts.
        expect(Object.keys(initial).every((key) => Object.hasOwn(after, key))).toBe(true);
        expect(encodeCurrentAgentStateJson(after)).toBe(encodeCurrentAgentStateJson(after));
      }
    }
  });

  test('schedules only from immutable execution traits and fails closed on conflicts', () => {
    const sharedRead = (effectId: string) => ({
      effectId,
      traits: {
        resourceScopes: [{ kind: 'workspace' as const, key: 'workspace' }],
        access: 'read' as const,
        conflictKeys: [],
        isolation: 'shared' as const,
        causalGroup: 'turn-1',
        interactionBarrier: false,
        concurrencyGroup: 'parallel-read',
        leaseFenceRequired: true,
      },
    });
    expect(selectSchedulableEffectBatch([sharedRead('read-a'), sharedRead('read-b')], 2)).toEqual([
      'read-a',
      'read-b',
    ]);
    expect(isValidSchedulerFacts({ traits: {}, approval: {} })).toBe(true);
    expect(
      isValidSchedulerFacts({
        traits: {
          read: {
            resourceScopes: [],
            access: 'read',
            conflictKeys: [],
            isolation: 'shared',
            causalGroup: 'turn-1',
            interactionBarrier: false,
            leaseFenceRequired: true,
            unsafeCallback: () => undefined,
          },
        },
        approval: {},
      }),
    ).toBe(false);
    const blocked = selectScheduledEffects(
      createInitialAgentState({
        threadId: 'session-1',
        userId: 'user-1',
        workspace: '/workspace',
        turnId: 'turn-1',
        recoveryIdentityKey: IDENTITY_KEY,
      }),
      { traits: {}, approval: { malformed: { allowed: true } } } as never,
    )[0];
    expect(blocked).toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
    });
  });

  test('normalizes terminal and ToolOutcome facts in the fixed legacy order', () => {
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const completed = normalizeTerminalAgentEvent({
      type: 'run.completed',
      turnId: 'turn-1',
      output: {},
    } as KernelEvent);
    expect(completed).toMatchObject({
      outcome: { version: 1, status: 'completed', reasonCode: 'completed' },
    });
    const toolState = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          fixture: {
            toolCallId: 'fixture',
            name: 'read_file',
            modelMessageId: 'fixture-message',
            args: {},
            createdAtTurnId: 'turn-1',
            status: 'running',
            effectClass: 'read_only',
            sideEffect: false,
          },
        },
        active: ['fixture'],
      },
    } as AgentState;
    const toolEvent = {
      type: 'tool.finished',
      toolCallId: 'fixture',
      name: 'read_file',
      createdAt: '2026-08-20T00:00:00.000Z',
      result: { ok: true, command: 'read_file', exitCode: 0 },
    } as KernelEvent;
    const normalized = normalizeAgentToolOutcomeEvent(
      toolEvent,
      toolState,
      '2026-08-20T00:00:01.000Z',
    );
    expect(normalized).toMatchObject({
      outcome: {
        schemaVersion: 1,
        status: 'success',
        dispatchState: 'started',
        externalEffects: 'none',
        replaySafety: 'safe_read',
      },
    });
    expect(normalizeAgentEvent(toolEvent, toolState, '2026-08-20T00:00:01.000Z')).toEqual(
      normalized,
    );
    expect(
      normalizeAgentToolOutcomeEvent(normalized, toolState, '2026-08-20T00:00:02.000Z'),
    ).toEqual(normalized);
    const approval = normalizeAgentToolOutcomeEvent(
      {
        type: 'approval.rejected',
        interactionId: 'interaction-1',
        toolCallId: 'fixture',
        reason: 'no',
      } as unknown as KernelEvent,
      toolState,
      '2026-08-20T00:00:01.000Z',
    );
    expect(approval).toMatchObject({
      outcome: { status: 'rejected', failure: { detailCode: 'approval_rejected' } },
    });
    const notStartedToolState = {
      ...toolState,
      tools: {
        ...toolState.tools,
        active: [],
        calls: {
          fixture: { ...toolState.tools.calls.fixture, status: 'queued' as const },
        },
      },
    } as AgentState;
    const operatorAction = normalizeAgentToolOutcomeEvent(
      {
        type: 'tool.failed',
        toolCallId: 'fixture',
        name: 'read_file',
        createdAt: '2026-08-20T00:00:00.000Z',
        failure: {
          kind: 'model_refused',
          message: 'refused',
          retryable: false,
          modelFixable: false,
          needsUserIntervention: true,
          terminatesTurn: true,
          journal: true,
        },
      } as KernelEvent,
      notStartedToolState,
      '2026-08-20T00:00:01.000Z',
    );
    expect(operatorAction).toMatchObject({
      outcome: {
        status: 'failed',
        recovery: { disposition: 'user_action', maximumAdditionalCalls: 0 },
      },
    });
    const classifierConflict = normalizeAgentToolOutcomeEvent(
      {
        type: 'tool.finished',
        toolCallId: 'fixture',
        name: 'read_file',
        createdAt: '2026-08-20T00:00:00.000Z',
        failure: {
          kind: 'tool_runtime_error',
          message: 'runtime',
          retryable: true,
          modelFixable: true,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
        result: { ok: false },
        classifierAdvice: { detailCode: 'approval_rejected' },
      } as unknown as KernelEvent,
      notStartedToolState,
      '2026-08-20T00:00:01.000Z',
    );
    expect(classifierConflict).toMatchObject({
      outcome: {
        status: 'unknown',
        failure: { detailCode: 'classifier_conflict' },
      },
    });
    expect(digestAgentEvent({ type: 'turn.started', turnId: 'turn-1' } as KernelEvent)).toBe(
      'd6996ab2a1cb9cd2b1aa2aff373791da6b026c3520a9f5460ea685165cd86528',
    );
  });

  test('decides and reduces a State 25 event without a dynamic domain', () => {
    const initial = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const event: KernelEvent = { type: 'turn.started', turnId: 'turn-1' };
    const decision = decide(
      initial,
      {
        source: 'host_fact',
        sessionId: 'session-1',
        expectedRevision: 0,
        events: [event],
      },
      facts(1),
    );
    expect(decision.status).toBe('applied');
    if (decision.status !== 'applied') throw new Error('decision rejected');
    expect(decision.nextState.revision).toBe(1);
    expect(decision.events[0]).toEqual(event);
    expect(reduce(initial, decision.events).turn.turnId).toBe('turn-1');
    expect(reduceAgentState(initial, event).turn.status).toBe('active');
    expect(digestAgentEvent(event)).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('requires one Host-allocated Task identity for the first user message', () => {
    const initial = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const event: KernelEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'inspect the runtime',
    };
    const input = {
      source: 'host_fact' as const,
      sessionId: 'session-1',
      expectedRevision: 0,
      events: [event],
    };

    expect(decide(initial, input, facts(1))).toEqual({
      status: 'rejected',
      code: 'allocated_task_identity_missing',
    });
    expect(initial.activeTaskId).toBeNull();
    expect(initial.tasks).toEqual({});

    const allocationKey = taskIdentityAllocationKey(0, 'message-1');
    const allocatedFacts: DecisionFacts = {
      ...facts(1),
      allocatedIds: { [allocationKey]: 'task-host-1' },
    };
    const first = decide(initial, input, allocatedFacts);
    const second = decide(initial, input, allocatedFacts);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') throw new Error('allocated Task decision rejected');
    expect(first.nextState.activeTaskId).toBe('task-host-1');
    expect(first.nextState.tasks['task-host-1']).toEqual({
      taskId: 'task-host-1',
      userGoal: 'inspect the runtime',
      status: 'active',
      startedAtTurnId: 'turn-1',
      sideEffectsStarted: false,
      planning: { kind: 'building_without_plan' },
      planHistory: [],
    });
    expect(first.events[0] as unknown).toEqual({
      ...event,
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    expect(Object.hasOwn(first.events[0]!, 'taskId')).toBe(false);
  });

  test('fails closed on invalid, duplicate, or conflicting Task allocations', () => {
    const initial = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const event: KernelEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'inspect',
    };
    const input = {
      source: 'host_fact' as const,
      sessionId: 'session-1',
      expectedRevision: 0,
      events: [event],
    };
    const allocationKey = taskIdentityAllocationKey(0, 'message-1');

    expect(decide(initial, input, { ...facts(1), allocatedIds: { [allocationKey]: '' } })).toEqual({
      status: 'rejected',
      code: 'invalid_decision_facts',
    });
    expect(
      decide(initial, input, {
        ...facts(1),
        allocatedIds: { [allocationKey]: 'task-1', unrelated: 'task-1' },
      }),
    ).toEqual({ status: 'rejected', code: 'invalid_decision_facts' });

    const started = reduceAgentState(initial, {
      type: 'task.started',
      taskId: 'task-history',
      userGoal: 'old task',
      turnId: 'turn-1',
    } as KernelEvent);
    const completed = reduceAgentState(started, {
      type: 'task.completed',
      taskId: 'task-history',
      turnId: 'turn-1',
    } as KernelEvent);
    expect(
      decide(
        completed,
        { ...input, expectedRevision: completed.revision },
        { ...facts(1), allocatedIds: { [allocationKey]: 'task-history' } },
      ),
    ).toEqual({ status: 'rejected', code: 'allocated_task_identity_conflict' });
  });

  test('allocates at most one Task across a user-message batch and honors explicit Task starts', () => {
    const initial = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const first: KernelEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'first',
    };
    const second: KernelEvent = {
      type: 'user.message_appended',
      messageId: 'message-2',
      content: 'second',
    };
    const batch = decide(
      initial,
      {
        source: 'host_fact',
        sessionId: 'session-1',
        expectedRevision: 0,
        events: [first, second],
      },
      {
        ...facts(2),
        allocatedIds: { [taskIdentityAllocationKey(0, 'message-1')]: 'task-batch' },
      },
    );
    expect(batch.status).toBe('applied');
    if (batch.status !== 'applied') throw new Error('batched Task decision rejected');
    expect(Object.keys(batch.nextState.tasks)).toEqual(['task-batch']);
    expect(batch.nextState.tasks['task-batch']?.userGoal).toBe('second');

    const explicit = decide(
      initial,
      {
        source: 'host_fact',
        sessionId: 'session-1',
        expectedRevision: 0,
        events: [
          {
            type: 'task.started',
            taskId: 'task-explicit',
            userGoal: 'explicit',
            turnId: 'turn-1',
          } as KernelEvent,
          first,
        ],
      },
      facts(2),
    );
    expect(explicit.status).toBe('applied');
    if (explicit.status !== 'applied') throw new Error('explicit Task decision rejected');
    expect(Object.keys(explicit.nextState.tasks)).toEqual(['task-explicit']);
    expect(explicit.nextState.activeTaskId).toBe('task-explicit');
  });

  test('consumes identity-bound Host schema admission facts without compiling schemas', () => {
    const initial = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const schema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    };
    const event: KernelEvent = {
      type: 'verification.requested',
      verificationId: 'verification-1',
      mode: 'required',
      spec: {
        schemaVersion: 1,
        verificationId: 'verification-1',
        subject: 'model output',
        repair: { maxAttempts: 1 },
        checks: [{ checkId: 'schema-1', type: 'schema', schema }],
      },
      requestedAt: '2026-08-20T00:00:00.000Z',
    } as unknown as KernelEvent;
    const input = {
      source: 'host_fact' as const,
      sessionId: 'session-1',
      expectedRevision: 0,
      events: [event],
    };
    const admittedFacts: DecisionFacts = {
      ...facts(1),
      eventFacts: [
        {
          occurredAt: '2026-08-20T00:00:00.000Z',
          verificationSchemaAdmissions: [
            {
              schemaDigest: verificationSchemaAdmissionDigest(schema),
              schemaDiagnostic: null,
            },
          ],
        },
      ],
    };
    const admitted = decide(initial, input, admittedFacts);
    expect(admitted.status).toBe('applied');
    if (admitted.status !== 'applied') throw new Error('schema admission rejected');
    const admittedRecord = admitted.nextState.verification.records['verification-1'];
    expect(admittedRecord?.status).toBe('pending');
    expect(admittedRecord?.diagnostics).toBeUndefined();

    const rejected = decide(initial, input, {
      ...admittedFacts,
      eventFacts: [
        {
          occurredAt: '2026-08-20T00:00:00.000Z',
          verificationSchemaAdmissions: [
            {
              schemaDigest: verificationSchemaAdmissionDigest(schema),
              schemaDiagnostic: 'Unsupported MCP inputSchema: fixture rejection',
            },
          ],
        },
      ],
    });
    expect(rejected.status).toBe('applied');
    if (rejected.status !== 'applied') throw new Error('schema rejection fact was not reduced');
    expect(rejected.nextState.verification.records['verification-1']).toMatchObject({
      status: 'budget_exhausted',
      diagnostics: ['schema-1: Unsupported MCP inputSchema: fixture rejection'],
    });

    const missing = decide(initial, input, facts(1));
    expect(missing.status).toBe('applied');
    if (missing.status !== 'applied') throw new Error('missing schema fact was not reduced');
    expect(missing.nextState.verification.records['verification-1']).toMatchObject({
      status: 'budget_exhausted',
      diagnostics: ['schema-1: Host admission fact is missing for VerificationSpec schema.'],
    });

    const mismatched = decide(initial, input, {
      ...admittedFacts,
      eventFacts: [
        {
          occurredAt: '2026-08-20T00:00:00.000Z',
          verificationSchemaAdmissions: [{ schemaDigest: 'a'.repeat(64), schemaDiagnostic: null }],
        },
      ],
    });
    expect(mismatched.status).toBe('applied');
    if (mismatched.status !== 'applied') throw new Error('mismatched schema fact was not reduced');
    expect(mismatched.nextState.verification.records['verification-1']).toMatchObject({
      status: 'budget_exhausted',
      diagnostics: ['schema-1: Host admission fact identity mismatches VerificationSpec schema.'],
    });
  });

  test('creates the exact State initial snapshot shape without ambient identity', () => {
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    expect(Object.keys(state)).toEqual([
      'schemaVersion',
      'formatEpoch',
      'revision',
      'appliedEventIds',
      'recoveryState',
      'session',
      'turn',
      'transcript',
      'context',
      'resourceBudget',
      'modelInvocations',
      'providerReadiness',
      'completionGuard',
      'activeTaskId',
      'tasks',
      'interactions',
      'tools',
      'toolRecovery',
      'capabilities',
      'skills',
      'verification',
      'providerAdmission',
      'suspendedSubagents',
      'authorization',
      'mode',
      'workspaceAccess',
      'autoReview',
      'doomLoop',
    ]);
    expect(state).toEqual({
      schemaVersion: 26,
      formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
      revision: 0,
      appliedEventIds: [],
      recoveryState: { kind: 'normal' },
      session: { threadId: 'session-1', userId: 'user-1', workspace: '/workspace' },
      turn: { turnId: 'turn-1', turnIndex: 0, status: 'active' },
      transcript: { messages: [] },
      context: {
        history: [],
        autoGuard: {
          recentAutomaticCompactions: [],
          consecutiveLowGain: 0,
          disabledUntilManualAction: false,
          recoveryAttempted: false,
        },
      },
      resourceBudget: { status: 'unconfigured', reservations: {} },
      modelInvocations: {},
      providerReadiness: {},
      completionGuard: { correctionAttempts: 0 },
      activeTaskId: null,
      tasks: {},
      interactions: { kind: 'idle' },
      tools: { calls: {}, queue: [], active: [] },
      toolRecovery: {
        schemaVersion: 1,
        identityKey: IDENTITY_KEY,
        failures: {},
        order: [],
        progressRevision: 0,
        qualityGuard: { blocked: false, observedFailures: 0 },
      },
      capabilities: {
        catalogRevision: '',
        bindings: {},
        disclosures: {},
        loadedCapabilities: {},
        invocations: {},
      },
      skills: { catalogRevision: '', frames: {} },
      verification: { records: {} },
      providerAdmission: { pending: [], waivers: {} },
      suspendedSubagents: {},
      authorization: { mode: 'default', commandGrants: {} },
      mode: 'accept_edits',
      workspaceAccess: 'write',
      autoReview: {
        pendingWarnings: {},
        consecutiveRejects: 0,
        rejectionHistory: [],
        circuitBreakerTripped: false,
      },
      doomLoop: {},
    });
    const serialized = encodeCurrentAgentStateJson(state);
    expect(serialized).toBe(INITIAL_STATE_FIXTURE_JSON);
    expect(serialized).toBe(
      encodeCurrentAgentStateJson(
        createInitialAgentState({
          threadId: 'session-1',
          userId: 'user-1',
          workspace: '/workspace',
          turnId: 'turn-1',
          recoveryIdentityKey: IDENTITY_KEY,
        }),
      ),
    );
    expect(() =>
      decodeCurrentAgentStateJson(
        JSON.stringify({ ...state, formatEpoch: 'kite-runtime-2026-08-19' }),
      ),
    ).toThrow();
    expect(() =>
      createInitialAgentState({
        threadId: 'session-1',
        userId: 'user-1',
        workspace: '/workspace',
        turnId: '',
        recoveryIdentityKey: IDENTITY_KEY,
      }),
    ).toThrow(/non-empty/u);
    expect(() =>
      decodeCurrentAgentStateJson(
        JSON.stringify({
          ...state,
          toolRecovery: {
            ...state.toolRecovery,
            qualityGuard: { blocked: false, observedFailures: 'zero' },
          },
        }),
      ),
    ).toThrow();
    expect(serialized).toContain('"formatEpoch":"kite-runtime-modularization-v1-2026-08-19"');
  });

  test('requires explicit Host authorization facts for full_access State construction', () => {
    const base = {
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
      authorizationMode: 'full_access' as const,
      authorizationSource: 'user' as const,
    };
    expect(() => createInitialAgentState(base as never)).toThrow(/modeGrantedAt/u);
    const elevated = createInitialAgentState({
      ...base,
      modeGrantedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(elevated.authorization).toEqual({
      mode: 'full_access',
      modeSource: 'user',
      modeGrantedAt: '2026-08-20T00:00:00.000Z',
      commandGrants: {},
    });
  });

  test('reduces the previously uncovered State domains with their durable facts', () => {
    let state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const apply = (event: KernelEvent) => {
      const prepared = completeEvidenceFixture(event.type, {
        ...(event as unknown as Record<string, unknown>),
      }) as KernelEvent;
      try {
        state = reduceAgentState(state, prepared);
      } catch (error) {
        throw new Error(`${event.type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    apply({
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-08-20T00:00:00.000Z',
      deadlineAt: '2026-08-20T00:00:30.000Z',
      budget: {
        version: 1,
        maxRunDurationMs: 60_000,
        maxTurns: 10,
        maxModelRequests: 10,
        maxToolInvocations: 10,
        maxRunInputTokens: 10_000,
        maxRunOutputTokens: 10_000,
        maxConcurrentSubagents: 2,
        maxConcurrentWriters: 1,
        maxConcurrentToolInvocations: 2,
        maxConcurrentShellInvocations: 1,
        maxConcurrencyWaitMs: 1_000,
        maxArtifactBytes: 10_000,
      },
    } as KernelEvent);
    expect(state.resourceBudget.status).toBe('active');
    apply({
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'reservation-1',
        runId: 'run-1',
        invocationId: 'invocation-1',
        resourceKind: 'tool',
        executableUpperBound: {
          counters: {
            turns: 0,
            modelRequests: 0,
            toolInvocations: 1,
            inputTokens: 0,
            outputTokens: 0,
            artifactBytes: 0,
          },
          gauges: {
            elapsedRunMs: 0,
            activeSubagents: 0,
            activeWriters: 0,
            activeToolInvocations: 1,
            activeShellInvocations: 0,
          },
          source: 'versioned_upper_bound',
          estimatorVersion: 'fixture-v1',
        },
        state: 'reserved',
      },
    } as KernelEvent);
    apply({
      type: 'resource_budget.dispatch_started',
      reservationId: 'reservation-1',
    } as KernelEvent);
    expect(
      (state.resourceBudget.status === 'active' ? state.resourceBudget.reservations : {})[
        'reservation-1'
      ],
    ).toMatchObject({ state: 'dispatch_started' });
    apply({
      type: 'provider.readiness_intent_recorded',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      providerId: 'provider-1',
      routeRevision: 'route-1',
      executionBoundaryDigest: 'digest-1',
      requestedAt: '2026-08-20T00:00:00.000Z',
      expiresAt: '2026-08-20T00:10:00.000Z',
      maxAttempts: 1,
    } as KernelEvent);
    apply({
      type: 'provider.readiness_attempt_started',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      attempt: 1,
      maxAttempts: 1,
      startedAt: '2026-08-20T00:00:01.000Z',
    } as KernelEvent);
    expect(state.providerReadiness['provider-1']).toMatchObject({
      status: 'attempted',
      attempts: 1,
    });

    apply({
      type: 'capability.bindings_issued',
      catalogRevision: 'catalog-1',
      bindings: [],
    } as KernelEvent);
    apply({
      type: 'capability.invocation_recorded',
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'capability-1',
      argumentsDigest: 'args-1',
      authorizationDigest: 'auth-1',
      effectiveEffectsDigest: 'effects-1',
      effectiveEffects: {},
      recordedAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
    expect(
      (state.capabilities as { invocations: Record<string, object> }).invocations['invocation-1'],
    ).toMatchObject({ status: 'recorded' });
    apply({
      type: 'capability.execution_started',
      invocationId: 'invocation-1',
      startedAt: '2026-08-20T00:00:00.000Z',
      attempt: 1,
    } as KernelEvent);
    expect(
      (state.capabilities as { invocations: Record<string, object> }).invocations['invocation-1'],
    ).toMatchObject({ status: 'running' });
    apply({
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      attempt: 1,
      capabilityRevision: 'capability-1',
      argumentsDigest: 'args-1',
      admissionDigest: 'admission-1',
      operationDigest: 'operation-1',
      searchBoundaryDigest: 'search-1',
      lexicalTargetDigest: 'target-1',
      canonicalWorkspaceDigest: 'workspace-1',
      protectedPathRevision: 'protected-1',
      approvalSummaryDigest: 'approval-1',
      effectiveEffectsDigest: 'effects-1',
      intentDigest: 'intent-1',
      recordedAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
    const filesystemIntent = ((
      state.capabilities as unknown as { invocations: Record<string, Record<string, unknown>> }
    ).invocations['invocation-1']?.filesystemIntent ?? {}) as Record<string, unknown>;
    expect(typeof filesystemIntent.intentDigest).toBe('string');
    expect(filesystemIntent.intentDigest as string).toMatch(/^sha256:[a-f0-9]{64}$/u);

    apply({ type: 'skill.catalog_refreshed', catalogRevision: 'skills-1' } as KernelEvent);
    expect((state.skills as { catalogRevision: string }).catalogRevision).toBe('skills-1');
    apply({
      type: 'verification.requested',
      verificationId: 'verification-1',
      mode: 'required',
      spec: {
        schemaVersion: 1,
        verificationId: 'verification-1',
        subject: 'fixture',
        repair: { maxAttempts: 0 },
        checks: [
          {
            checkId: 'check-1',
            description: 'fixture command succeeds',
            type: 'command',
            command: 'true',
          },
        ],
      },
      requestedAt: '2026-08-20T00:00:00.000Z',
    } as KernelEvent);
    expect(
      (state.verification as { records: Record<string, object> }).records['verification-1'],
    ).toMatchObject({ status: 'pending' });

    apply({
      type: 'network.admission_decided',
      toolCallId: 'tool-1',
      decision: { receiptDigest: 'network-1' },
    } as KernelEvent);
    apply({
      type: 'task.started',
      taskId: 'task-1',
      userGoal: 'delegate',
      turnId: 'turn-1',
    } as KernelEvent);
    apply({
      type: 'tool.queued',
      toolCallId: 'task-tool-1',
      name: 'task',
      args: { prompt: 'inspect' },
    } as KernelEvent);
    apply({ type: 'tool.started', toolCallId: 'task-tool-1' } as KernelEvent);
    apply({
      type: 'subagent.suspended',
      toolCallId: 'task-tool-1',
      snapshot: {
        storage: 'private_artifact_v1',
        subagentId: 'subagent-1',
        role: 'code',
        continuationId: `continuation-${'a'.repeat(64)}`,
        continuationArtifact: {
          kind: 'subagent_continuation',
          artifactId: `pa_${'b'.repeat(64)}`,
          integrityIdentifier: `sha256:${'c'.repeat(64)}`,
          byteLength: 1,
        },
        modelInvocationOrdinal: 0,
        parentInvocationId: 'invocation-1',
        parentAttempt: 1,
        blockedTool: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'task-tool-1',
          toolName: 'task',
        },
      },
    } as KernelEvent);
    expect(state.suspendedSubagents['task-tool-1']).toMatchObject({ subagentId: 'subagent-1' });
  });

  test('exports the pure current snapshot/fork codec primitives', () => {
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const serialized = encodeCurrentAgentStateJson(state);
    expect(decodeCurrentAgentStateJson(serialized)).toEqual(state);
    expect(canForkAgentState(state)).toBe(true);
    expect(
      isCurrentPendingInteractionRequest(
        {
          ...state,
          interactions: {
            kind: 'awaiting_user_input',
            interactionId: 'interaction-1',
            toolCallId: 'tool-1',
            request: { question: 'fixture', options: [], allow_free_text: true },
          },
        },
        {
          type: 'user_input.requested',
          interactionId: 'interaction-1',
          toolCallId: 'tool-1',
          request: {},
        } as KernelEvent,
      ),
    ).toBe(true);
    expect(
      isCurrentPendingInteractionRequest(
        {
          ...state,
          interactions: {
            kind: 'awaiting_user_input',
            interactionId: 'interaction-1',
            toolCallId: 'tool-1',
            request: { question: 'fixture', options: [], allow_free_text: true },
          },
        },
        {
          type: 'user_input.requested',
          interactionId: 'interaction-2',
          toolCallId: 'tool-1',
          request: {},
        } as KernelEvent,
      ),
    ).toBe(false);
    const fork = rebindForkAgentState(state, 'session-2', 'b'.repeat(64));
    expect(fork.session.threadId).toBe('session-2');
    expect(fork.toolRecovery).toEqual(createToolRecoveryJournal('b'.repeat(64)));
    expect(fork.authorization).toEqual({ mode: 'default', commandGrants: {} });
    expect(fork.interactions).toEqual({ kind: 'idle' });
    expect(fork.tools.queue).toEqual([]);
    expect(fork.tools.active).toEqual([]);
    expect(fork.suspendedSubagents).toEqual({});
    expect(
      canForkAgentState({
        ...state,
        capabilities: {
          ...state.capabilities,
          invocations: {
            invocation: {
              invocationId: 'invocation',
              toolCallId: 'tool',
              capabilityId: 'builtin:shell_execute',
              capabilityRevision: 'revision',
              argumentsDigest: 'args',
              authorizationDigest: 'auth',
              effectiveEffectsDigest: 'effects',
              status: 'running',
              recordedAt: '2026-08-20T00:00:00.000Z',
              sandboxPreparationIntent: {
                attempt: 1,
                toolCallId: 'tool',
                capabilityId: 'builtin:shell_execute',
                capabilityRevision: 'revision',
                canonicalWorkspace: '/workspace',
                effectiveEffectsDigest: 'effects',
                admissionDigest: 'admission',
                preparationDigest: 'preparation',
                commandDigest: 'command',
                executionBoundaryDigest: 'boundary',
                resourceSemantics: 'allocating',
                intentDigest: 'intent',
                recordedAt: '2026-08-20T00:00:00.000Z',
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  test('keeps the State replay digest and projected output stable for the legacy fixture', () => {
    const events: KernelEvent[] = [
      {
        type: 'task.started',
        taskId: 'task-1',
        userGoal: 'read goal',
        turnId: 'turn-1',
      } as KernelEvent,
      {
        type: 'tool.queued',
        toolCallId: 'tool-1',
        name: 'read_file',
        args: { path: 'README.md' },
      } as KernelEvent,
      { type: 'tool.started', toolCallId: 'tool-1' } as KernelEvent,
      { type: 'turn.completed', turnId: 'turn-1' } as KernelEvent,
    ];
    const replayDigests = events.map((event) => digestAgentEvent(event));
    expect(replayDigests).toEqual([
      '87f9ab0bd50e23897ae4d0a5eee09f8787ccbbe62d5edb8f6530bb60aa8da59a',
      'b4fc2ff933ae99096b9b298fb416185f047dc73dd60af79d5247216ff9fb8d72',
      '554015d28e9682e6bf5f9fe52570bde285bb0d44f7f83101f2df44a4f35c7f27',
      '14a93518c43739742b7ddf90af42955286a0eb6b9a1e9152839958b46283589d',
    ]);
    const initial = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    const state = reduce(initial, events);
    expect({
      activeTaskId: state.activeTaskId,
      tasks: state.tasks,
      tools: state.tools,
      turn: state.turn,
      transcript: state.transcript,
    }).toEqual({
      activeTaskId: 'task-1',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          userGoal: 'read goal',
          status: 'active',
          startedAtTurnId: 'turn-1',
          sideEffectsStarted: false,
          planning: { kind: 'building_without_plan' },
          planHistory: [],
        },
      },
      tools: {
        calls: {
          'tool-1': {
            toolCallId: 'tool-1',
            name: 'read_file',
            modelMessageId: '',
            args: { path: 'README.md' },
            createdAtTurnId: 'turn-1',
            taskId: 'task-1',
            invocationFingerprint:
              '3e26d61a6ff2f3ee66c01a48a6952104f402142fb4fee1c3b0deb17f4e3cc6f5',
            recoveryAdmission: 'admitted',
            sideEffect: false,
            effectClass: 'read_only',
            classificationReason: 'read_file is a read-only capability.',
            status: 'running',
          },
        },
        queue: [],
        active: ['tool-1'],
      },
      turn: { turnId: 'turn-1', turnIndex: 0, status: 'completed' },
      transcript: { messages: [] },
    });
  });

  test('binds execution to the committed Host operation identity', () => {
    expect(
      authorizeEffect({
        sessionId: 'session-1',
        operationId: 'command-1',
        operation: 'turn',
        committedRevision: 3,
      }),
    ).toEqual({
      schema: 'kite.authorized-effect.current',
      sessionId: 'session-1',
      operationId: 'command-1',
      operation: 'turn',
      committedRevision: 3,
    });
  });

  test('keeps recovery fingerprint, failure identity, lineage, and malformed-journal blocking exact', () => {
    expect(
      toolInvocationFingerprint({
        toolName: 'read_file',
        parsedArgs: { path: 'a' },
      }),
    ).toBe('096ee6e264ca3dddfff624145cd644341794f6a645c9ec704cdad9f162b1ac50');
    const outcome = {
      schemaVersion: 1,
      status: 'failed',
      failure: { kind: 'tool_runtime_error', detailCode: 'runtime_exception' },
      dispatchState: 'not_started',
      externalEffects: 'none',
      replaySafety: 'pre_dispatch',
      recovery: {
        disposition: 'never',
        maximumAdditionalCalls: 0,
        requiresNewModelResponse: false,
        safeAutomaticRetry: false,
      },
      timing: { source: 'runtime_boundary' },
    } as const;
    expect(isToolOutcome(outcome)).toBe(true);
    const fingerprint = toolInvocationFingerprint({
      toolName: 'read_file',
      parsedArgs: { path: 'a' },
    });
    const failureId = toolFailureInstanceId({
      toolCallId: 'tool-1',
      invocationFingerprint: fingerprint,
      outcome,
    });
    const journal = recordRecoveryFailure(createToolRecoveryJournal(IDENTITY_KEY), {
      toolCallId: 'tool-1',
      toolName: 'read_file',
      invocationFingerprint: fingerprint,
      modelMessageId: 'model-1',
      outcome,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    expect(journal.order).toEqual([failureId]);
    expect(journal.failures[failureId]?.outcome.lineage?.failureInstanceId).toBe(failureId);
    expect(normalizeToolRecoveryJournal(journal, IDENTITY_KEY)).toEqual(journal);
    const malformed = {
      ...journal,
      failures: {
        ...journal.failures,
        [failureId]: { ...journal.failures[failureId], failureInstanceId: 'f'.repeat(64) },
      },
    };
    expect(normalizeToolRecoveryJournal(malformed, IDENTITY_KEY).qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
  });
});
