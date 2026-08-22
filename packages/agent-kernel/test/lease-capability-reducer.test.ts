import { describe, expect, test } from 'bun:test';
import { reduceLeaseState } from '../src/core/lease/reducer';
import { reduceCapabilityState } from '../src/domains/capability/reducer';
import type { KernelEvent } from '../src/events';
import { type AgentState, createInitialAgentState } from '../src/state';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const STARTED_AT = '2026-08-20T00:00:00.000Z';
const DEADLINE_AT = '2026-08-20T00:01:00.000Z';

function initialState(): AgentState {
  return createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: IDENTITY_KEY,
  });
}

function budget(maxToolInvocations = 2) {
  return {
    version: 1 as const,
    maxRunDurationMs: 60_000,
    maxTurns: 10,
    maxModelRequests: 10,
    maxToolInvocations,
    maxRunInputTokens: 10_000,
    maxRunOutputTokens: 10_000,
    maxConcurrentSubagents: 2,
    maxConcurrentWriters: 1,
    maxConcurrentToolInvocations: 2,
    maxConcurrentShellInvocations: 1,
    maxConcurrencyWaitMs: 10_000,
    maxArtifactBytes: 10_000,
  };
}

function usage(
  source: 'actual' | 'versioned_upper_bound',
  toolInvocations = 0,
): Record<string, unknown> {
  return {
    counters: {
      turns: 0,
      modelRequests: 0,
      toolInvocations,
      inputTokens: 0,
      outputTokens: 0,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 0,
      activeWriters: 0,
      activeToolInvocations: toolInvocations,
      activeShellInvocations: 0,
    },
    source,
    ...(source === 'versioned_upper_bound' ? { estimatorVersion: 'fixture-v1' } : {}),
  };
}

function configure(state = initialState(), maxToolInvocations = 2): AgentState {
  return reduceLeaseState(state, {
    type: 'resource_budget.configured',
    runId: 'run-1',
    startedAt: STARTED_AT,
    deadlineAt: DEADLINE_AT,
    budget: budget(maxToolInvocations),
  } as KernelEvent);
}

function reservation(
  reservationId: string,
  invocationId: string,
  toolInvocations = 1,
): KernelEvent {
  return {
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId,
      runId: 'run-1',
      invocationId,
      resourceKind: 'tool',
      executableUpperBound: usage('versioned_upper_bound', toolInvocations),
      state: 'reserved',
    },
  } as KernelEvent;
}

describe('State26 lease reducer', () => {
  test('uses the active ledger and fails closed for unconfigured or unknown facts', () => {
    expect(() =>
      reduceLeaseState(initialState(), {
        type: 'resource_budget.dispatch_started',
        reservationId: 'missing',
      } as KernelEvent),
    ).toThrow(/ledger is unconfigured/u);

    let state = configure();
    expect(() =>
      reduceLeaseState(state, {
        type: 'resource_budget.dispatch_started',
        reservationId: 'missing',
      } as KernelEvent),
    ).toThrow(/Unknown reservation/u);
    expect(() =>
      reduceLeaseState(state, {
        type: 'resource_budget.waiter_promoted',
        invocationId: 'missing',
      } as KernelEvent),
    ).toThrow(/Unknown concurrency waiter/u);

    state = reduceLeaseState(state, reservation('reservation-1', 'invocation-1'));
    state = reduceLeaseState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'reservation-1',
    } as unknown as KernelEvent);
    state = reduceLeaseState(state, {
      type: 'resource_budget.unknown',
      reservationId: 'reservation-1',
    } as KernelEvent);
    state = reduceLeaseState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'reservation-1',
      actual: usage('actual'),
    } as KernelEvent);
    expect(state.resourceBudget).toMatchObject({
      status: 'active',
      reconciledUsage: { source: 'actual' },
      reservations: { 'reservation-1': { state: 'reconciled' } },
    });
    expect(() =>
      reduceLeaseState(state, {
        type: 'resource_budget.unknown',
        reservationId: 'reservation-1',
      } as KernelEvent),
    ).toThrow(/pending reservation/u);
  });

  test('enforces identity, upper bounds, FIFO, deadlines, and current budget', () => {
    let state = configure(undefined, 1);
    expect(() => reduceLeaseState(state, reservation('reservation-1', 'invocation-1', 2))).toThrow(
      /budget exhausted/u,
    );

    state = configure();
    expect(() =>
      reduceLeaseState(state, reservation('reservation-1', 'invocation-1')),
    ).not.toThrow();
    state = reduceLeaseState(state, reservation('reservation-1', 'invocation-1'));
    expect(() => reduceLeaseState(state, reservation('reservation-1', 'invocation-other'))).toThrow(
      /idempotency key/u,
    );
    expect(() => reduceLeaseState(state, reservation('reservation-2', 'invocation-1'))).toThrow(
      /already has a non-released reservation/u,
    );

    state = reduceLeaseState(state, {
      type: 'resource_budget.waiter_enqueued',
      waiter: {
        version: 1,
        runId: 'run-1',
        invocationId: 'waiter-1',
        requiredPermits: ['tool'],
        sequence: 0,
        enqueuedAt: STARTED_AT,
        deadlineAt: '2026-08-20T00:00:30.000Z',
        state: 'waiting',
      },
    } as KernelEvent);
    expect(() =>
      reduceLeaseState(state, {
        type: 'resource_budget.waiter_enqueued',
        waiter: {
          version: 1,
          runId: 'run-1',
          invocationId: 'waiter-2',
          requiredPermits: ['tool'],
          sequence: 2,
          enqueuedAt: STARTED_AT,
          deadlineAt: '2026-08-20T00:00:30.000Z',
          state: 'waiting',
        },
      } as KernelEvent),
    ).toThrow(/FIFO sequence/u);
    expect(() =>
      reduceLeaseState(state, {
        type: 'resource_budget.waiter_enqueued',
        waiter: {
          version: 1,
          runId: 'run-1',
          invocationId: 'waiter-2',
          requiredPermits: ['tool'],
          sequence: 1,
          enqueuedAt: STARTED_AT,
          deadlineAt: '2026-08-20T00:02:00.000Z',
          state: 'waiting',
        },
      } as KernelEvent),
    ).toThrow(/persisted run deadline/u);
    state = reduceLeaseState(state, {
      type: 'resource_budget.waiter_promoted',
      invocationId: 'waiter-1',
    } as KernelEvent);
    expect(state.resourceBudget).toMatchObject({
      status: 'active',
      waiters: { 'waiter-1': { state: 'promoted' } },
    });
  });

  test('projects provider readiness with lifecycle and attempt guards', () => {
    let state = initialState();
    state = reduceLeaseState(state, {
      type: 'provider.readiness_intent_recorded',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      providerId: 'provider-1',
      routeRevision: 'route-1',
      executionBoundaryDigest: 'boundary-1',
      requestedAt: STARTED_AT,
      expiresAt: DEADLINE_AT,
      maxAttempts: 2,
    } as KernelEvent);
    const prepared = state.providerReadiness['provider-1'];
    expect(prepared).toEqual({
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      providerId: 'provider-1',
      routeRevision: 'route-1',
      executionBoundaryDigest: 'boundary-1',
      status: 'prepared',
      requestedAt: STARTED_AT,
      expiresAt: DEADLINE_AT,
      maxAttempts: 2,
      attempts: 0,
      waiters: {},
    });
    const stale = reduceLeaseState(state, {
      type: 'provider.readiness_attempt_started',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      attempt: 2,
      maxAttempts: 2,
      startedAt: STARTED_AT,
    } as KernelEvent);
    expect(stale).toBe(state);
    state = reduceLeaseState(state, {
      type: 'provider.readiness_attempt_started',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      attempt: 1,
      maxAttempts: 2,
      startedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceLeaseState(state, {
      type: 'provider.readiness_succeeded',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      providerDirectoryRevision: 'providers-1',
      readyAt: STARTED_AT,
      expiresAt: DEADLINE_AT,
    } as KernelEvent);
    expect(state.providerReadiness['provider-1']).toMatchObject({
      status: 'ready',
      attempts: 1,
      providerDirectoryRevision: 'providers-1',
    });
    const staleFailure = reduceLeaseState(state, {
      type: 'provider.readiness_failed',
      readinessKey: 'provider-1',
      lifecycleId: 'lifecycle-1',
      failure: { reason: 'late' },
      dispatchCertainty: 'attempted',
      failedAt: DEADLINE_AT,
    } as unknown as KernelEvent);
    expect(staleFailure).toBe(state);
  });
});

describe('State26 capability reducer', () => {
  test('stores search completion as pendingSearch and consumes only matching bindings', () => {
    let state = initialState();
    const result = {
      searchId: 'search-1',
      query: 'git',
      catalogRevision: 'catalog-1',
      requestedAtTurnId: 'turn-1',
      candidates: [],
    };
    state = reduceCapabilityState(state, {
      type: 'capability.search_completed',
      result,
    } as KernelEvent);
    expect(state.capabilities.pendingSearch).toEqual(result);
    expect(Object.hasOwn(state.capabilities as object, 'lastSearchResult')).toBe(false);
    state = reduceCapabilityState(state, {
      type: 'capability.bindings_issued',
      catalogRevision: 'catalog-1',
      bindings: [],
      searchId: 'search-1',
    } as KernelEvent);
    expect(state.capabilities.pendingSearch).toBeUndefined();
  });

  test('projects invocation_recorded exactly once without storing effectiveEffects', () => {
    let state = initialState();
    const event = {
      type: 'capability.invocation_recorded',
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'revision-1',
      taskId: 'task-1',
      planId: 'plan-1',
      planStepId: 'step-1',
      argumentsDigest: 'arguments-1',
      authorizationDigest: 'authorization-1',
      admissionDigest: 'admission-1',
      effectiveEffectsDigest: 'effects-digest-1',
      effectiveEffects: { workspace: 'write' },
      receiptRequirement: 'effect_receipt',
      retryEligibility: 'none',
      recordedAt: STARTED_AT,
      idempotencyKey: 'idempotency-1',
    } as unknown as KernelEvent;
    state = reduceCapabilityState(state, event);
    const recorded = state.capabilities.invocations['invocation-1'];
    expect(recorded).toEqual({
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'revision-1',
      taskId: 'task-1',
      planId: 'plan-1',
      planStepId: 'step-1',
      argumentsDigest: 'arguments-1',
      authorizationDigest: 'authorization-1',
      admissionDigest: 'admission-1',
      effectiveEffectsDigest: 'effects-digest-1',
      receiptRequirement: 'effect_receipt',
      retryEligibility: 'none',
      status: 'recorded',
      recordedAt: STARTED_AT,
      idempotencyKey: 'idempotency-1',
    });
    state = reduceCapabilityState(state, {
      ...event,
      argumentsDigest: 'tampered',
      effectiveEffectsDigest: 'tampered',
    } as KernelEvent);
    expect(state.capabilities.invocations['invocation-1']).toBe(recorded);
  });

  test('matches the root lifecycle projection and keeps stale lifecycle facts byte-stable', () => {
    let state = initialState();
    state = reduceCapabilityState(state, {
      type: 'capability.invocation_recorded',
      invocationId: 'shell-invocation',
      toolCallId: 'shell-call',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: 'shell-revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      admissionDigest: 'admission',
      effectiveEffectsDigest: 'effects',
      effectiveEffects: {},
      recordedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.execution_started',
      invocationId: 'shell-invocation',
      startedAt: STARTED_AT,
      attempt: 1,
    } as KernelEvent);

    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: 'shell-invocation',
      attempt: 1,
      toolCallId: 'shell-call',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: 'shell-revision',
      canonicalWorkspace: '/workspace',
      effectiveEffectsDigest: 'effects',
      admissionDigest: 'admission',
      preparationDigest: 'preparation',
      commandDigest: 'command',
      executionBoundaryDigest: 'boundary',
      resourceSemantics: 'allocating',
      intentDigest: 'intent',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    const stalePreparation = reduceCapabilityState(state, {
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: 'shell-invocation',
      attempt: 1,
      toolCallId: 'shell-call',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'shell-revision',
      canonicalWorkspace: '/workspace',
      effectiveEffectsDigest: 'effects',
      admissionDigest: 'admission',
      preparationDigest: 'preparation',
      commandDigest: 'command',
      executionBoundaryDigest: 'boundary',
      resourceSemantics: 'allocating',
      intentDigest: 'intent-forged',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    expect(JSON.stringify(stalePreparation)).toBe(JSON.stringify(state));

    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_preparation_ready',
      invocationId: 'shell-invocation',
      attempt: 1,
      intentDigest: 'intent',
      preparationDigest: 'preparation',
      commandDigest: 'command',
      planDigest: 'plan',
      backend: 'none',
      backendCapabilitiesDigest: 'backend-capabilities',
      enforcement: 'full',
      resourceSemantics: 'allocating',
      cleanupDigest: 'cleanup',
      preparationArtifact: {
        artifactId: 'artifact-preparation',
        kind: 'sandbox_preparation',
        integrityIdentifier: 'integrity-preparation',
        byteLength: 1,
      },
      readyDigest: 'ready',
      readyAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_execution_dispatch_intent_recorded',
      invocationId: 'shell-invocation',
      attempt: 1,
      readyDigest: 'ready',
      planDigest: 'plan',
      dispatchId: 'dispatch',
      supervisorNonce: 'nonce',
      dispatchIntentDigest: 'dispatch-intent',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_execution_supervisor_started',
      invocationId: 'shell-invocation',
      attempt: 1,
      dispatchId: 'dispatch',
      dispatchIntentDigest: 'dispatch-intent',
      supervisorPid: 10,
      processGroupId: 11,
      processStartIdentity: 'process-identity',
      startedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_disposal_started',
      invocationId: 'shell-invocation',
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'lifecycle',
      startedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_disposal_completed',
      invocationId: 'shell-invocation',
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'lifecycle',
      cleanupAttempt: 1,
      disposed: false,
      disposedAt: DEADLINE_AT,
    } as KernelEvent);
    expect(state.capabilities.invocations['shell-invocation']?.sandboxDisposal).toEqual({
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'lifecycle',
      status: 'pending',
      startedAt: STARTED_AT,
      attempts: 1,
      disposedAt: undefined,
      lastFailureAt: DEADLINE_AT,
    });
    const staleDisposal = reduceCapabilityState(state, {
      type: 'capability.sandbox_disposal_completed',
      invocationId: 'shell-invocation',
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'lifecycle',
      cleanupAttempt: 1,
      disposed: true,
      disposedAt: DEADLINE_AT,
    } as KernelEvent);
    expect(JSON.stringify(staleDisposal)).toBe(JSON.stringify(state));
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_disposal_completed',
      invocationId: 'shell-invocation',
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'lifecycle',
      cleanupAttempt: 2,
      disposed: true,
      disposedAt: DEADLINE_AT,
    } as KernelEvent);
    expect(state.capabilities.invocations['shell-invocation']?.sandboxDisposal).toEqual({
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'lifecycle',
      status: 'completed',
      startedAt: STARTED_AT,
      attempts: 2,
      disposedAt: DEADLINE_AT,
      lastFailureAt: undefined,
    });
    state = reduceCapabilityState(state, {
      type: 'capability.execution_started',
      invocationId: 'shell-invocation',
      startedAt: DEADLINE_AT,
      attempt: 2,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: 'shell-invocation',
      attempt: 2,
      toolCallId: 'shell-call',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: 'shell-revision',
      canonicalWorkspace: '/workspace',
      effectiveEffectsDigest: 'effects',
      admissionDigest: 'admission',
      preparationDigest: 'preparation-2',
      commandDigest: 'command-2',
      executionBoundaryDigest: 'boundary-2',
      resourceSemantics: 'allocating',
      intentDigest: 'intent-2',
      recordedAt: DEADLINE_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_preparation_abandonment_started',
      invocationId: 'shell-invocation',
      attempt: 2,
      intentDigest: 'intent-2',
      lifecycleIntentDigest: 'lifecycle-2',
      startedAt: DEADLINE_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.sandbox_preparation_abandonment_completed',
      invocationId: 'shell-invocation',
      attempt: 2,
      intentDigest: 'intent-2',
      lifecycleIntentDigest: 'lifecycle-2',
      cleanupAttempt: 1,
      disposed: true,
      disposedAt: DEADLINE_AT,
    } as KernelEvent);
    expect(
      state.capabilities.invocations['shell-invocation']?.sandboxPreparationAbandonment,
    ).toEqual({
      attempt: 2,
      intentDigest: 'intent-2',
      lifecycleIntentDigest: 'lifecycle-2',
      status: 'completed',
      startedAt: DEADLINE_AT,
      attempts: 1,
      disposedAt: DEADLINE_AT,
      lastFailureAt: undefined,
    });
  });

  test('projects governed subagent lifecycle and terminal receipts without event spread', () => {
    let state = initialState();
    state = reduceCapabilityState(state, {
      type: 'capability.invocation_recorded',
      invocationId: 'task-invocation',
      toolCallId: 'task-call',
      capabilityId: 'builtin:task',
      capabilityRevision: 'task-revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      effectiveEffects: {},
      recordedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.execution_started',
      invocationId: 'task-invocation',
      startedAt: STARTED_AT,
      attempt: 1,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.subagent_dispatch_intent_recorded',
      invocationId: 'task-invocation',
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-invocation',
      taskArtifact: {
        artifactId: 'artifact-task',
        kind: 'subagent_task',
        integrityIdentifier: 'integrity-task',
        byteLength: 1,
      },
      dispatchIntentDigest: 'dispatch',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.subagent_handle_recorded',
      invocationId: 'task-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch',
      handleArtifact: {
        artifactId: 'artifact-handle',
        kind: 'subagent_handle',
        integrityIdentifier: 'integrity-handle',
        byteLength: 1,
      },
      handleIntegrityIdentifier: 'handle-integrity',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    const staleObservation = reduceCapabilityState(state, {
      type: 'capability.subagent_observation_recorded',
      invocationId: 'task-invocation',
      attempt: 2,
      dispatchIntentDigest: 'dispatch',
      status: 'completed',
      observedAt: STARTED_AT,
    } as KernelEvent);
    expect(JSON.stringify(staleObservation)).toBe(JSON.stringify(state));
    state = reduceCapabilityState(state, {
      type: 'capability.subagent_observation_recorded',
      invocationId: 'task-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch',
      status: 'completed',
      observedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.subagent_cleanup_started',
      invocationId: 'task-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch',
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      startedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.subagent_cleanup_completed',
      invocationId: 'task-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch',
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupConfirmed: true,
      completedAt: DEADLINE_AT,
    } as KernelEvent);
    expect(state.capabilities.invocations['task-invocation']?.subagentProviderLifecycle).toEqual({
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-invocation',
      taskArtifact: {
        artifactId: 'artifact-task',
        kind: 'subagent_task',
        integrityIdentifier: 'integrity-task',
        byteLength: 1,
      },
      dispatchIntentDigest: 'dispatch',
      status: 'cleanup_completed',
      recordedAt: STARTED_AT,
      handleArtifact: {
        artifactId: 'artifact-handle',
        kind: 'subagent_handle',
        integrityIdentifier: 'integrity-handle',
        byteLength: 1,
      },
      handleIntegrityIdentifier: 'handle-integrity',
      handleRecordedAt: STARTED_AT,
      observationStatus: 'completed',
      observedAt: STARTED_AT,
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupStartedAt: STARTED_AT,
      cleanupConfirmed: true,
      cleanupCompletedAt: DEADLINE_AT,
    });

    let terminal = initialState();
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.invocation_recorded',
      invocationId: 'receipt-invocation',
      toolCallId: 'receipt-call',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'read-revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.execution_started',
      invocationId: 'receipt-invocation',
      startedAt: STARTED_AT,
      attempt: 1,
    } as KernelEvent);
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.execution_result_recorded',
      invocationId: 'receipt-invocation',
      resultDigest: 'result',
      evidenceDigest: 'evidence',
      recordedAt: DEADLINE_AT,
      artifact: {
        artifactId: 'artifact-result',
        kind: 'capability_result',
        integrityIdentifier: 'integrity-result',
        byteLength: 1,
      },
    } as KernelEvent);
    expect(terminal.capabilities.invocations['receipt-invocation']).toEqual({
      invocationId: 'receipt-invocation',
      toolCallId: 'receipt-call',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'read-revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'running',
      recordedAt: STARTED_AT,
      startedAt: STARTED_AT,
      attemptsStarted: 1,
      resultDigest: 'result',
      evidenceDigest: 'evidence',
      artifact: {
        artifactId: 'artifact-result',
        kind: 'capability_result',
        integrityIdentifier: 'integrity-result',
        byteLength: 1,
      },
    });
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.execution_succeeded',
      invocationId: 'receipt-invocation',
      resultDigest: 'result-2',
      evidenceDigest: 'evidence-2',
      finishedAt: DEADLINE_AT,
      artifact: {
        artifactId: 'artifact-result-2',
        kind: 'capability_result',
        integrityIdentifier: 'integrity-result-2',
        byteLength: 2,
      },
    } as KernelEvent);
    expect(terminal.capabilities.invocations['receipt-invocation']).toMatchObject({
      status: 'succeeded',
      resultDigest: 'result-2',
      evidenceDigest: 'evidence-2',
    });
    expect(Object.hasOwn(terminal.capabilities.invocations['receipt-invocation']!, 'error')).toBe(
      false,
    );
    const staleResult = reduceCapabilityState(terminal, {
      type: 'capability.execution_result_recorded',
      invocationId: 'receipt-invocation',
      resultDigest: 'forged',
      evidenceDigest: 'forged',
      recordedAt: DEADLINE_AT,
      artifact: {
        artifactId: 'artifact-forged',
        kind: 'capability_result',
        integrityIdentifier: 'integrity-forged',
        byteLength: 1,
      },
    } as KernelEvent);
    expect(JSON.stringify(staleResult)).toBe(JSON.stringify(terminal));
  });

  test('projects filesystem evidence and failed/unknown/reconciled receipts exactly', () => {
    let state = initialState();
    state = reduceCapabilityState(state, {
      type: 'capability.invocation_recorded',
      invocationId: 'filesystem-invocation',
      toolCallId: 'filesystem-call',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'filesystem-revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      effectiveEffects: {},
      recordedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.execution_started',
      invocationId: 'filesystem-invocation',
      startedAt: STARTED_AT,
      attempt: 1,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'filesystem-invocation',
      attempt: 1,
      capabilityRevision: 'filesystem-revision',
      argumentsDigest: 'arguments',
      admissionDigest: 'admission',
      operationDigest: 'operation',
      searchBoundaryDigest: null,
      lexicalTargetDigest: 'lexical',
      canonicalWorkspaceDigest: 'workspace',
      protectedPathRevision: 'protected',
      approvalSummaryDigest: 'approval',
      effectiveEffectsDigest: 'effects',
      intentDigest: 'intent',
      recordedAt: STARTED_AT,
    } as KernelEvent);
    state = reduceCapabilityState(state, {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'filesystem-invocation',
      attempt: 1,
      intentDigest: 'intent',
      operationDigest: 'operation',
      targetIdentityDigest: 'target',
      preimageDigest: null,
      preimageArtifact: {
        artifactId: 'artifact-preimage',
        kind: 'filesystem_preimage',
        integrityIdentifier: 'integrity-preimage',
        byteLength: 1,
      },
      readyDigest: 'ready',
      readyAt: DEADLINE_AT,
    } as KernelEvent);
    expect(state.capabilities.invocations['filesystem-invocation']).toMatchObject({
      filesystemIntent: {
        attempt: 1,
        capabilityRevision: 'filesystem-revision',
        argumentsDigest: 'arguments',
        admissionDigest: 'admission',
        operationDigest: 'operation',
        searchBoundaryDigest: null,
        lexicalTargetDigest: 'lexical',
        canonicalWorkspaceDigest: 'workspace',
        protectedPathRevision: 'protected',
        approvalSummaryDigest: 'approval',
        effectiveEffectsDigest: 'effects',
        intentDigest: 'intent',
        recordedAt: STARTED_AT,
      },
      filesystemMutationReady: {
        attempt: 1,
        intentDigest: 'intent',
        operationDigest: 'operation',
        targetIdentityDigest: 'target',
        preimageDigest: null,
        readyDigest: 'ready',
        readyAt: DEADLINE_AT,
      },
    });
    const staleReady = reduceCapabilityState(state, {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'filesystem-invocation',
      attempt: 2,
      intentDigest: 'intent',
      operationDigest: 'forged-operation',
      targetIdentityDigest: 'forged-target',
      preimageDigest: null,
      preimageArtifact: {
        artifactId: 'artifact-forged',
        kind: 'filesystem_preimage',
        integrityIdentifier: 'integrity-forged',
        byteLength: 1,
      },
      readyDigest: 'forged-ready',
      readyAt: DEADLINE_AT,
    } as KernelEvent);
    expect(JSON.stringify(staleReady)).toBe(JSON.stringify(state));

    let terminal = initialState();
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.invocation_recorded',
      invocationId: 'unknown-invocation',
      toolCallId: 'unknown-call',
      capabilityId: 'builtin:web_fetch',
      capabilityRevision: 'web-revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      effectiveEffects: {},
      recordedAt: STARTED_AT,
    } as KernelEvent);
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.execution_started',
      invocationId: 'unknown-invocation',
      startedAt: STARTED_AT,
      attempt: 1,
    } as KernelEvent);
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.execution_unknown',
      invocationId: 'unknown-invocation',
      reason: 'provider outcome unavailable',
      finishedAt: DEADLINE_AT,
    } as KernelEvent);
    terminal = reduceCapabilityState(terminal, {
      type: 'capability.reconciliation_resolved',
      invocationId: 'unknown-invocation',
      decision: 'confirmed_failure',
      reconciledAt: DEADLINE_AT,
      reason: 'provider rejected',
    } as KernelEvent);
    expect(terminal.capabilities.invocations['unknown-invocation']).toMatchObject({
      status: 'failed',
      finishedAt: DEADLINE_AT,
      reconciliation: 'confirmed_failure',
      reconciledAt: DEADLINE_AT,
      error: 'provider rejected',
    });
  });
});
