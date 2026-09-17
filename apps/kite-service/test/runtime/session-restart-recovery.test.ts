import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPendingApproval } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { AuthorizedExecutionControl } from '#kite-service/bootstrap/runtime/RuntimeSessionCoordinator';
import { reconcileRuntimeSessionAfterRestart } from '#kite-service/bootstrap/runtime/session-restart-recovery';
import { StateHostSessionHarness as AgentKernel } from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';

test('restart Provider cleanup preserves only a durable user cancellation', async () => {
  for (const abortCause of ['user', 'error'] as const) {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: `restart-${abortCause}`,
      userId: 'user',
      workspace: '/workspace',
    });
    state.turn.abortCause = abortCause;
    state.capabilities.invocations['parent-invocation'] = {
      invocationId: 'parent-invocation',
      toolCallId: 'parent-tool',
      capabilityId: 'builtin:task',
      capabilityRevision: 'revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'failed',
      recordedAt: '2026-08-25T00:00:00.000Z',
      subagentProviderLifecycle: {
        attempt: 1,
        purpose: 'start',
        childInvocationId: 'child',
        taskArtifact: {
          artifactId: `pa_${'7'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'8'.repeat(64)}`,
          byteLength: 128,
        },
        dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
        status: 'intent_recorded',
        recordedAt: '2026-08-25T00:00:00.000Z',
      },
    };
    let disposition: string | undefined;
    const result = await reconcileRuntimeSessionAfterRestart({
      control: {
        getState: () => state,
        processEventBatch: () => [],
      } as unknown as AuthorizedExecutionControl,
      historyEvents: [],
      modelInvocationRuntime: {
        reconcilePendingSubagents: async (_persistence, options) => {
          disposition = options?.terminalDisposition;
          return false;
        },
      },
      recoveryOwnership: {
        kind: 'fenced_previous_execution',
        controllerGeneration: 2,
        assertCurrent: () => true,
      },
    });
    expect(result.failure).toBe('subagent_provider');
    expect(disposition).toBe(abortCause === 'user' ? 'preserve_user_cancellation' : 'unknown');
  }
});

test('Session admission reconciles a crashed Subagent owner before settling its visible Tool', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-session-admission-recovery-'));
  const store = openStateStoreForTest(join(root, 'runtime.sqlite'));
  const threadId = 'session-admission-subagent-recovery';
  const invocationId = 'subagent-owner-invocation';
  const toolCallId = 'subagent-owner-tool';
  const dispatchIntentDigest = `sha256:${'1'.repeat(64)}`;
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId,
    userId: 'tui-user',
    workspace: '/workspace',
  });
  state.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: 'model-message',
    name: 'task',
    args: { role: 'review' },
    status: 'awaiting_approval',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [toolCallId];
  state.transcript.messages = [
    {
      kind: 'assistant',
      messageId: 'model-message',
      turnId: state.turn.turnId,
      ordinal: 0,
      createdAt: '2026-08-25T00:00:00.000Z',
      toolCalls: [{ id: toolCallId, name: 'task', args: { role: 'review' } }],
    },
  ];
  state.capabilities.invocations[invocationId] = {
    invocationId,
    toolCallId,
    capabilityId: 'builtin:task',
    capabilityRevision: '2'.repeat(64),
    argumentsDigest: '3'.repeat(64),
    authorizationDigest: '4'.repeat(64),
    admissionDigest: '5'.repeat(64),
    effectiveEffectsDigest: '6'.repeat(64),
    receiptRequirement: 'control_receipt',
    status: 'running',
    recordedAt: '2026-08-25T00:00:00.000Z',
    startedAt: '2026-08-25T00:00:00.000Z',
    attemptsStarted: 1,
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-invocation',
      taskArtifact: {
        artifactId: `pa_${'7'.repeat(64)}`,
        kind: 'subagent_task',
        integrityIdentifier: `sha256:${'8'.repeat(64)}`,
        byteLength: 128,
      },
      dispatchIntentDigest,
      status: 'handle_recorded',
      recordedAt: '2026-08-25T00:00:00.000Z',
      handleArtifact: {
        artifactId: `pa_${'9'.repeat(64)}`,
        kind: 'subagent_handle',
        integrityIdentifier: `sha256:${'a'.repeat(64)}`,
        byteLength: 256,
      },
      handleIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
      handleRecordedAt: '2026-08-25T00:00:00.000Z',
    },
  };
  state.suspendedSubagents[toolCallId] = {
    storage: 'private_artifact_v1',
    subagentId: 'child-invocation',
    role: 'explore',
    continuationId: `continuation-${'c'.repeat(64)}`,
    modelInvocationOrdinal: 0,
    continuationArtifact: {
      artifactId: `pa_${'d'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `sha256:${'e'.repeat(64)}`,
      byteLength: 1,
    },
    parentInvocationId: invocationId,
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'nested-tool',
      toolName: 'shell_execute',
    },
  };
  const childApproval = {
    scope: 'once' as const,
    cwd: '/workspace',
    threadId,
    tool: 'shell_execute',
    command: 'pwd',
    risk: 'execute_code' as const,
    approvalHash: 'child-approval',
    summary: 'Run pwd',
    reason: 'Nested command needs approval.',
    expectedEffects: [] as string[],
    grantOptions: ['approve_once'] as const,
    recommendedGrant: 'approve_once' as const,
    subagentId: 'child-invocation',
  };
  state.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'child-approval',
    toolCallId,
    approval: childApproval,
  };
  (state.pendingApprovals as Map<string, AgentPendingApproval>).set('child-approval', {
    interactionId: 'child-approval',
    toolCallId,
    parentToolCallId: toolCallId,
    childSubagentId: 'child-invocation',
    childToolCallId: 'nested-tool',
    runtimeToolCallId: 'nested-tool',
    route: 'user',
    bindingDigest: 'child-approval',
    fullModeBypassEligible: false,
    fullModePolicyBypassAllowed: false,
    approval: childApproval,
    invocation: {},
    sequence: 0,
    generation: 0,
    createdAt: '2026-08-25T00:00:00.000Z',
    status: 'awaiting_user',
  });
  state.activeApprovalId = 'child-approval';
  store.saveSnapshot(threadId, state);
  const kernel = new AgentKernel({
    store,
    initialState: state,
    interactionMode: 'accept_edits',
    sandboxAvailable: true,
  });

  try {
    const started = {
      type: 'subagent.started' as const,
      subagent: {
        id: 'child-invocation',
        role: 'explore' as const,
        name: 'Inspect repository',
      },
    };
    const control = {
      getState: () => kernel.getState(),
      processEvent: (event: Parameters<typeof kernel.processEvent>[0]) =>
        kernel.processEvent(event),
      processEventBatch: (events: Parameters<typeof kernel.processEventBatch>[0]) =>
        kernel.processEventBatch(events),
      cancelRun: () => [],
    };
    const result = await reconcileRuntimeSessionAfterRestart({
      historyEvents: [started],
      recoveryOwnership: {
        kind: 'fenced_previous_execution',
        controllerGeneration: 2,
        assertCurrent: () => true,
      },
      control,
      modelInvocationRuntime: {
        reconcilePendingSubagents: async (persistence) => {
          const at = '2026-08-25T00:00:01.000Z';
          return persistence.persistEvents([
            {
              type: 'capability.subagent_cleanup_started',
              invocationId,
              attempt: 1,
              dispatchIntentDigest,
              cleanupAttempt: 1,
              cleanupKind: 'handle_reconcile',
              startedAt: at,
            },
            {
              type: 'capability.subagent_cleanup_completed',
              invocationId,
              attempt: 1,
              dispatchIntentDigest,
              cleanupAttempt: 1,
              cleanupKind: 'handle_reconcile',
              cleanupConfirmed: true,
              completedAt: at,
            },
            {
              type: 'capability.execution_unknown',
              invocationId,
              reason: 'Subagent owner was reconciled during Session admission.',
              finishedAt: at,
            },
          ]);
        },
      },
    });

    expect(result.complete).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      'capability.subagent_cleanup_started',
      'capability.subagent_cleanup_completed',
      'capability.execution_unknown',
      'subagent.failed',
      'tool.cancelled',
      'turn.aborted',
    ]);
    expect(kernel.getState().capabilities.invocations[invocationId]).toMatchObject({
      status: 'unknown',
      subagentProviderLifecycle: { status: 'cleanup_completed', cleanupConfirmed: true },
    });
    expect(kernel.getState().tools.calls[toolCallId]?.status).toBe('cancelled');
    expect(kernel.getState().turn.status).toBe('aborted');
    expect(kernel.getState().pendingApprovals.size).toBe(0);
    expect(Object.keys(kernel.getState().suspendedSubagents)).toHaveLength(0);
    const repeated = await reconcileRuntimeSessionAfterRestart({
      historyEvents: [started, ...result.events],
      recoveryOwnership: {
        kind: 'fenced_previous_execution',
        controllerGeneration: 2,
        assertCurrent: () => true,
      },
      control,
      modelInvocationRuntime: {},
    });
    expect(repeated).toMatchObject({ complete: true, changed: false, events: [] });
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Session admission fails closed when a crashed Subagent owner cannot be reconciled', async () => {
  const invocationId = 'unavailable-subagent-owner-invocation';
  const toolCallId = 'unavailable-subagent-owner-tool';
  const dispatchIntentDigest = `sha256:${'c'.repeat(64)}`;
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'session-admission-unavailable-subagent-recovery',
    userId: 'tui-user',
    workspace: '/workspace',
  });
  state.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: 'model-message',
    name: 'task',
    args: { role: 'review' },
    status: 'running',
    createdAtTurnId: state.turn.turnId,
  };
  state.capabilities.invocations[invocationId] = {
    invocationId,
    toolCallId,
    capabilityId: 'builtin:task',
    capabilityRevision: '2'.repeat(64),
    argumentsDigest: '3'.repeat(64),
    authorizationDigest: '4'.repeat(64),
    admissionDigest: '5'.repeat(64),
    effectiveEffectsDigest: '6'.repeat(64),
    receiptRequirement: 'control_receipt',
    status: 'running',
    recordedAt: '2026-08-25T00:00:00.000Z',
    startedAt: '2026-08-25T00:00:00.000Z',
    attemptsStarted: 1,
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-invocation',
      taskArtifact: {
        artifactId: `pa_${'7'.repeat(64)}`,
        kind: 'subagent_task',
        integrityIdentifier: `sha256:${'8'.repeat(64)}`,
        byteLength: 128,
      },
      dispatchIntentDigest,
      status: 'handle_recorded',
      recordedAt: '2026-08-25T00:00:00.000Z',
      handleArtifact: {
        artifactId: `pa_${'9'.repeat(64)}`,
        kind: 'subagent_handle',
        integrityIdentifier: `sha256:${'a'.repeat(64)}`,
        byteLength: 256,
      },
      handleIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
      handleRecordedAt: '2026-08-25T00:00:00.000Z',
    },
  };
  let writeCalls = 0;

  const result = await reconcileRuntimeSessionAfterRestart({
    historyEvents: [],
    recoveryOwnership: {
      kind: 'fenced_previous_execution',
      controllerGeneration: 2,
      assertCurrent: () => true,
    },
    control: {
      getState: () => state,
      processEvent: () => {
        writeCalls += 1;
        return { status: 'applied', eventId: 'unexpected' };
      },
      processEventBatch: (events) => {
        writeCalls += 1;
        return events;
      },
      cancelRun: () => [],
    },
    modelInvocationRuntime: {},
  });

  expect(result).toEqual({
    complete: false,
    changed: false,
    events: [],
    failure: 'subagent_provider',
  });
  expect(writeCalls).toBe(0);
  expect(state.tools.calls[toolCallId]?.status).toBe('running');
});

test('settles a proven cancelled child before unrelated sandbox cleanup fails, once only', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'sandbox-pending-child-history',
    userId: 'tui-user',
    workspace: '/workspace',
  });
  state.tools.calls['cancelled-parent'] = {
    toolCallId: 'cancelled-parent',
    modelMessageId: 'old-message',
    name: 'task',
    args: {},
    status: 'cancelled',
    createdAtTurnId: 'old-turn',
  };
  state.capabilities.invocations['cancelled-invocation'] = {
    invocationId: 'cancelled-invocation',
    toolCallId: 'cancelled-parent',
    capabilityId: 'builtin:task',
    capabilityRevision: 'revision',
    argumentsDigest: 'arguments',
    authorizationDigest: 'authorization',
    effectiveEffectsDigest: 'effects',
    status: 'unknown',
    recordedAt: '2026-08-25T00:00:00.000Z',
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'cancelled-child',
      taskArtifact: {
        artifactId: `pa_${'7'.repeat(64)}`,
        kind: 'subagent_task',
        integrityIdentifier: `sha256:${'8'.repeat(64)}`,
        byteLength: 128,
      },
      dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
      status: 'cleanup_completed',
      recordedAt: '2026-08-25T00:00:00.000Z',
      cleanupKind: 'handle_reconcile',
      cleanupAttempt: 1,
      cleanupConfirmed: true,
      cleanupCompletedAt: '2026-08-25T00:00:01.000Z',
    },
  };
  state.capabilities.invocations['sandbox-invocation'] = {
    invocationId: 'sandbox-invocation',
    toolCallId: 'sandbox-tool',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    argumentsDigest: 'arguments',
    authorizationDigest: 'authorization',
    effectiveEffectsDigest: 'effects',
    status: 'unknown',
    recordedAt: '2026-08-25T00:00:00.000Z',
    sandboxPreparationIntent: { attempt: 1 } as never,
  };
  const started = {
    type: 'subagent.started' as const,
    subagent: { id: 'cancelled-child', role: 'explore' as const, name: 'Cancelled child' },
  };
  const stored: Array<{ type: string }> = [];
  const control = {
    getState: () => state,
    processEvent: () => {
      throw new Error('Single-event write was unexpected.');
    },
    processEventBatch: (events: Parameters<AuthorizedExecutionControl['processEventBatch']>[0]) => {
      stored.push(...events);
      return events;
    },
    cancelRun: () => [],
  } as AuthorizedExecutionControl;
  const input = {
    control,
    modelInvocationRuntime: {},
    historyEvents: [started],
    recoveryOwnership: {
      kind: 'fenced_previous_execution' as const,
      controllerGeneration: 2,
      assertCurrent: () => true,
    },
  };
  const first = await reconcileRuntimeSessionAfterRestart(input);
  expect(first).toMatchObject({ complete: false, changed: true, failure: 'sandbox_preparation' });
  expect(first.events).toMatchObject([
    { type: 'subagent.failed', subagent: { id: 'cancelled-child' } },
  ]);
  expect(stored.map((event) => event.type)).toEqual(['subagent.failed']);
  const repeated = await reconcileRuntimeSessionAfterRestart({
    ...input,
    historyEvents: [started, ...first.events],
  });
  expect(repeated).toMatchObject({
    complete: false,
    changed: false,
    events: [],
    failure: 'sandbox_preparation',
  });
  expect(stored.map((event) => event.type)).toEqual(['subagent.failed']);
});

test('settles a proven successful child before unrelated sandbox cleanup fails', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'successful-child-sandbox-pending',
    userId: 'tui-user',
    workspace: '/workspace',
  });
  state.tools.calls['successful-parent'] = {
    toolCallId: 'successful-parent',
    modelMessageId: 'old-message',
    name: 'task',
    args: {},
    status: 'succeeded',
    createdAtTurnId: 'old-turn',
  };
  state.capabilities.invocations['successful-invocation'] = {
    invocationId: 'successful-invocation',
    toolCallId: 'successful-parent',
    capabilityId: 'builtin:task',
    capabilityRevision: 'revision',
    argumentsDigest: 'arguments',
    authorizationDigest: 'authorization',
    effectiveEffectsDigest: 'effects',
    status: 'succeeded',
    recordedAt: '2026-08-25T00:00:00.000Z',
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'successful-child',
      taskArtifact: {
        artifactId: `pa_${'7'.repeat(64)}`,
        kind: 'subagent_task',
        integrityIdentifier: `sha256:${'8'.repeat(64)}`,
        byteLength: 128,
      },
      dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
      status: 'cleanup_completed',
      recordedAt: '2026-08-25T00:00:00.000Z',
      observationStatus: 'completed',
      observedAt: '2026-08-25T00:00:01.000Z',
      cleanupKind: 'handle_reconcile',
      cleanupAttempt: 1,
      cleanupConfirmed: true,
      cleanupCompletedAt: '2026-08-25T00:00:02.000Z',
    },
  };
  state.capabilities.invocations['sandbox-invocation'] = {
    invocationId: 'sandbox-invocation',
    toolCallId: 'sandbox-tool',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    argumentsDigest: 'arguments',
    authorizationDigest: 'authorization',
    effectiveEffectsDigest: 'effects',
    status: 'unknown',
    recordedAt: '2026-08-25T00:00:00.000Z',
    sandboxPreparationIntent: { attempt: 1 } as never,
  };
  const historyEvents = [
    {
      type: 'subagent.started',
      subagent: { id: 'successful-child', role: 'explore', name: 'Success' },
    },
    {
      type: 'capability.subagent_observation_recorded',
      invocationId: 'successful-invocation',
      attempt: 1,
      dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
      status: 'completed',
      observedAt: '2026-08-25T00:00:01.000Z',
    },
    {
      type: 'capability.subagent_cleanup_completed',
      invocationId: 'successful-invocation',
      attempt: 1,
      dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupConfirmed: true,
      completedAt: '2026-08-25T00:00:02.000Z',
    },
    {
      type: 'capability.execution_succeeded',
      invocationId: 'successful-invocation',
      resultDigest: 'result',
      evidenceDigest: 'evidence',
      finishedAt: '2026-08-25T00:00:03.000Z',
    },
    {
      type: 'tool.finished',
      toolCallId: 'successful-parent',
      name: 'task',
      result: { ok: true, exitCode: 0, stdout: 'Private child result' },
      createdAt: '2026-08-25T00:00:03.000Z',
      outcome: {
        status: 'success',
        timing: { source: 'runtime_boundary', queueMs: 0, executionMs: 123, totalActiveMs: 123 },
      },
    },
  ];
  const stored: string[] = [];
  const control = {
    getState: () => state,
    processEvent: () => {
      throw new Error('Single-event write was unexpected.');
    },
    processEventBatch: (events: Parameters<AuthorizedExecutionControl['processEventBatch']>[0]) => {
      stored.push(...events.map((event) => event.type));
      return events;
    },
    cancelRun: () => [],
  } as AuthorizedExecutionControl;
  const result = await reconcileRuntimeSessionAfterRestart({
    control,
    modelInvocationRuntime: {},
    historyEvents: historyEvents as never,
    recoveryOwnership: {
      kind: 'fenced_previous_execution',
      controllerGeneration: 2,
      assertCurrent: () => true,
    },
  });
  expect(result).toMatchObject({ complete: false, changed: true, failure: 'sandbox_preparation' });
  expect(result.events).toMatchObject([
    { type: 'subagent.completed', subagent: { id: 'successful-child' } },
  ]);
  expect(stored).toEqual(['subagent.completed']);
});

test('settles only confirmed children when another Provider cannot be reconciled', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'mixed-provider-recovery',
    userId: 'tui-user',
    workspace: '/workspace',
  });
  for (const [id, status, lifecycleStatus] of [
    ['confirmed', 'cancelled', 'cleanup_completed'],
    ['pending', 'running', 'handle_recorded'],
  ] as const) {
    state.tools.calls[`${id}-parent`] = {
      toolCallId: `${id}-parent`,
      modelMessageId: 'old-message',
      name: 'task',
      args: {},
      status,
      createdAtTurnId: 'old-turn',
    };
    state.capabilities.invocations[`${id}-invocation`] = {
      invocationId: `${id}-invocation`,
      toolCallId: `${id}-parent`,
      capabilityId: 'builtin:task',
      capabilityRevision: 'revision',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'unknown',
      recordedAt: '2026-08-25T00:00:00.000Z',
      subagentProviderLifecycle: {
        attempt: 1,
        purpose: 'start',
        childInvocationId: `${id}-child`,
        taskArtifact: {
          artifactId: `pa_${'7'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'8'.repeat(64)}`,
          byteLength: 128,
        },
        dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
        status: lifecycleStatus,
        recordedAt: '2026-08-25T00:00:00.000Z',
        ...(id === 'confirmed'
          ? {
              cleanupKind: 'handle_reconcile' as const,
              cleanupAttempt: 1,
              cleanupConfirmed: true,
              cleanupCompletedAt: '2026-08-25T00:00:01.000Z',
            }
          : {}),
      },
    };
  }
  const historyEvents = ['confirmed', 'pending'].map((id) => ({
    type: 'subagent.started' as const,
    subagent: { id: `${id}-child`, role: 'explore' as const, name: id },
  }));
  const stored: string[] = [];
  const control = {
    getState: () => state,
    processEvent: () => {
      throw new Error('Single-event write was unexpected.');
    },
    processEventBatch: (events: Parameters<AuthorizedExecutionControl['processEventBatch']>[0]) => {
      stored.push(...events.map((event) => event.type));
      return events;
    },
    cancelRun: () => [],
  } as AuthorizedExecutionControl;
  const result = await reconcileRuntimeSessionAfterRestart({
    control,
    historyEvents,
    modelInvocationRuntime: { reconcilePendingSubagents: async () => false },
    recoveryOwnership: {
      kind: 'fenced_previous_execution',
      controllerGeneration: 2,
      assertCurrent: () => true,
    },
  });
  expect(result).toMatchObject({ complete: false, changed: true, failure: 'subagent_provider' });
  expect(result.events).toMatchObject([
    { type: 'subagent.failed', subagent: { id: 'confirmed-child' } },
  ]);
  expect(stored).toEqual(['subagent.failed']);
  expect(state.tools.calls['pending-parent']?.status).toBe('running');
});
