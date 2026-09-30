import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { runStateRuntimeLoop } from '#kite-service/bootstrap/runtime/state-runner';
import type { RuntimeEvent, RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';
import { StateHostSessionHarness } from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOTIFICATION_ID = 'subagent:completed-child:result';
const RESPONSE_ARTIFACT = {
  artifactId: `pa_${'c'.repeat(64)}`,
  kind: 'model_response' as const,
  integrityIdentifier: DIGEST,
  byteLength: 1,
};

function createSession(): StateHostSessionHarness {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'model-input-boundary',
    userId: 'user',
    workspace: '/workspace',
  });
  state.modelInvocations.model = {
    invocationId: 'model',
    purpose: 'primary_agent',
    status: 'dispatching',
    surfaceArtifact: {
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'model_surface',
      integrityIdentifier: DIGEST,
      byteLength: 1,
    },
    surfaceIntegrityIdentifier: DIGEST,
    routeFingerprint: DIGEST,
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
    limits: { maxAttempts: 1, perAttemptTimeoutMs: 1000, totalTimeBudgetMs: 1000 },
    preparedStateRevision: 0,
    parentInvocationId: null,
    parentToolCallId: null,
    attempts: 1,
  };
  state.tools.calls.task = {
    toolCallId: 'task',
    name: 'task',
    args: {},
    modelMessageId: 'earlier-response',
    createdAtTurnId: state.turn.turnId,
    status: 'succeeded',
  };
  state.capabilities.invocations.child = {
    invocationId: 'child',
    toolCallId: 'task',
    capabilityId: 'builtin:task',
    capabilityRevision: DIGEST,
    argumentsDigest: DIGEST,
    authorizationDigest: DIGEST,
    admissionDigest: DIGEST,
    effectiveEffectsDigest: DIGEST,
    receiptRequirement: 'control_receipt',
    attemptsStarted: 1,
    status: 'succeeded',
    recordedAt: new Date(0).toISOString(),
    resultDigest: DIGEST,
    evidenceDigest: DIGEST,
    artifact: {
      artifactId: `pa_${'d'.repeat(64)}`,
      kind: 'capability_result',
      integrityIdentifier: DIGEST,
      byteLength: 1,
    },
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'completed-child',
      taskArtifact: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'subagent_task',
        integrityIdentifier: DIGEST,
        byteLength: 1,
      },
      dispatchIntentDigest: DIGEST,
      status: 'cleanup_completed',
      recordedAt: new Date(0).toISOString(),
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupStartedAt: new Date(0).toISOString(),
      cleanupConfirmed: true,
      cleanupCompletedAt: new Date(0).toISOString(),
    },
  };
  const session = new StateHostSessionHarness({
    store: openStateStoreForTest(':memory:'),
    initialState: state,
    interactionMode: 'accept_edits',
  });
  session.processEvent({
    type: 'user.message_appended',
    messageId: 'original-input',
    content: 'Test tools.',
  });
  return session;
}

function childResult(state: Readonly<RuntimeState>): RuntimeEvent {
  return {
    type: 'subagent.background_result_persisted',
    taskId: 'completed-child',
    notificationId: NOTIFICATION_ID,
    shortReport: 'Child finished.',
    artifactIntegrityIdentifier: DIGEST,
    originRunId: 'parent-run',
    originTurnId: state.turn.turnId,
    originToolCallId: 'task',
    attempt: 1,
    source: 'subagent',
    modelRole: 'user',
  };
}

async function runOneModel(
  session: StateHostSessionHarness,
  arrive: () => void,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let invoked = false;
  for await (const event of runStateRuntimeLoop(
    session,
    async (effect) => {
      expect(effect.type).toBe('call_model');
      invoked = true;
      arrive();
      return [
        {
          type: 'model.invocation_completed',
          invocationId: 'model',
          responseArtifact: RESPONSE_ARTIFACT,
          finishReason: 'tool_calls',
        },
        {
          type: 'model.responded',
          messageId: 'response',
          invocationId: 'model',
          toolCalls: [
            { id: 'list', name: 'list_agents', args: {} },
            { id: 'wait', name: 'task_wait', args: { task_id: 'completed-child' } },
          ],
        },
        ...[
          { id: 'list', name: 'list_agents', args: {} },
          { id: 'wait', name: 'task_wait', args: { task_id: 'completed-child' } },
        ].map(
          (call): RuntimeEvent => ({
            type: 'tool.queued',
            toolCallId: call.id,
            name: call.name,
            args: call.args,
            modelMessageId: 'response',
            modelInvocationId: 'model',
          }),
        ),
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    1,
    (effect) => (invoked ? { type: 'stop' } : effect),
  ))
    events.push(event);
  return events;
}

test('a durable child result during model execution preserves tool calls and recovery eligibility', async () => {
  const session = createSession();
  try {
    const events = await runOneModel(session, () =>
      session.processEvent(childResult(session.getState())),
    );
    expect(session.getState().transcript.messages).toContainEqual(
      expect.objectContaining({
        kind: 'user',
        messageId: NOTIFICATION_ID,
      }),
    );
    expect(
      session.getState().capabilities.invocations.child?.subagentProviderLifecycle?.backgroundResult
        ?.notificationId,
    ).toBe(NOTIFICATION_ID);
    expect(events.some((event) => event.type === 'model.response_superseded')).toBe(false);
    expect(events.some((event) => event.type === 'tool.rejected')).toBe(false);
    expect(session.getState().tools.calls.list?.status).toBe('queued');
    expect(session.getState().tools.calls.wait?.status).toBe('queued');
    expect(session.getState().toolRecovery.order).toHaveLength(0);
  } finally {
    session.close();
  }
});

test('real user input still supersedes a model response even alongside a child result', async () => {
  const session = createSession();
  try {
    const events = await runOneModel(session, () => {
      session.processEvent(childResult(session.getState()));
      session.processEvent({
        type: 'user.message_appended',
        messageId: 'input_actual-steer',
        content: 'Change the task.',
      });
    });
    expect(events.filter((event) => event.type === 'tool.rejected')).toEqual([
      expect.objectContaining({ toolCallId: 'list', reason: 'superseded_by_user_input' }),
      expect.objectContaining({ toolCallId: 'wait', reason: 'superseded_by_user_input' }),
    ]);
    expect(events).toContainEqual({
      type: 'model.response_superseded',
      messageId: 'response',
      invocationId: 'model',
    });
    expect(session.getState().tools.calls.list?.status).toBe('rejected');
  } finally {
    session.close();
  }
});

test('a user message with a subagent-shaped ID is still user input without durable child admission', async () => {
  const session = createSession();
  try {
    const events = await runOneModel(session, () =>
      session.processEvent({
        type: 'user.message_appended',
        messageId: NOTIFICATION_ID,
        content: 'Change the task.',
      }),
    );
    expect(events.some((event) => event.type === 'model.response_superseded')).toBe(true);
    expect(session.getState().tools.calls.list?.status).toBe('rejected');
  } finally {
    session.close();
  }
});
