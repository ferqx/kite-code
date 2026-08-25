import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { reconcileRuntimeSessionAfterRestart } from '#app/bootstrap/runtime/session-restart-recovery';
import { StateHostSessionHarness as AgentKernel } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';

test('Session admission reconciles a crashed Subagent owner before settling its visible Tool', async () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-session-admission-recovery-'));
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
    status: 'running',
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
  store.saveSnapshot(threadId, state);
  const kernel = new AgentKernel({
    store,
    initialState: state,
    interactionMode: 'accept_edits',
    sandboxAvailable: true,
  });

  try {
    const result = await reconcileRuntimeSessionAfterRestart({
      control: {
        getState: () => kernel.getState(),
        processEvent: (event) => kernel.processEvent(event),
        processEventBatch: (events) => kernel.processEventBatch(events),
        cancelRun: () => [],
      },
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
      'tool.failed',
      'turn.aborted',
    ]);
    expect(kernel.getState().capabilities.invocations[invocationId]).toMatchObject({
      status: 'unknown',
      subagentProviderLifecycle: { status: 'cleanup_completed', cleanupConfirmed: true },
    });
    expect(kernel.getState().tools.calls[toolCallId]?.status).toBe('failed');
    expect(kernel.getState().turn.status).toBe('aborted');
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
