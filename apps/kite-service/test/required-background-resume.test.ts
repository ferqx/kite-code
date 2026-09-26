import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { canContinueBlockedIndependentChild } from '../src/bootstrap/runtime/state-actions';
import type { RuntimeEvent, RuntimeState } from '../src/bootstrap/runtime/state-runtime';

function fixture() {
  const state = createRuntimeHostStateInitialState({
    threadId: 'parent',
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state.revision = 7;
  state.turn = { turnId: 'turn', turnIndex: 1, status: 'active' };
  state.activeTaskId = 'task';
  state.tasks = { task: { status: 'active' } } as never;
  state.completionGuard = {
    correctionAttempts: 0,
    waitingReason: { kind: 'required_background', taskIds: ['child-invocation'] },
  };
  state.modelInvocations = {
    model: {
      purpose: 'primary_agent',
      status: 'completed',
      responseArtifact: {
        kind: 'model_response',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      },
    },
  } as never;
  state.tools.calls = { 'parent-tool': { status: 'succeeded' } } as never;
  state.capabilities.invocations = {
    'parent-invocation': {
      subagentProviderLifecycle: { childSession: { childThreadId: 'child-thread' } },
    },
  } as never;
  const events: RuntimeEvent[] = [
    { type: 'turn.started', turnId: 'turn' },
    {
      type: 'subagent.child_session_intended',
      childInvocationId: 'child-invocation',
      childThreadId: 'child-thread',
      parentSessionId: 'parent',
      parentInvocationId: 'parent-invocation',
      originRunId: 'turn',
      originTurnId: 'turn',
      originToolCallId: 'parent-tool',
      disposition: 'required',
    } as RuntimeEvent,
    {
      type: 'model.invocation_completed',
      invocationId: 'model',
      responseArtifact: state.modelInvocations.model!.responseArtifact,
    } as RuntimeEvent,
    { type: 'model.responded', invocationId: 'model', messageId: 'message' },
    {
      type: 'completion.blocked',
      turnId: 'turn',
      nextAction: 'wait_for_background',
      modelInvocationId: 'model',
      backgroundTaskIds: ['child-invocation'],
    } as RuntimeEvent,
    {
      type: 'subagent.child_approval_proxy_changed',
      proxyInteractionId: 'proxy',
      childInvocationId: 'child-invocation',
      status: 'decided',
    },
  ];
  const journal = events.map((event, index) => ({ event, revision: index === 5 ? 7 : index + 1 }));
  return { state: state as RuntimeState, journal };
}

test('resumes only the exact completed provisional final waiting on a required child', () => {
  const { state, journal } = fixture();
  expect(canContinueBlockedIndependentChild(state, journal)).toBe(true);
  expect(
    canContinueBlockedIndependentChild(
      { ...state, completionGuard: { correctionAttempts: 0 } },
      journal,
    ),
  ).toBe(false);
  expect(
    canContinueBlockedIndependentChild(
      {
        ...state,
        modelInvocations: { model: { ...state.modelInvocations.model!, status: 'interrupted' } },
      },
      journal,
    ),
  ).toBe(false);
  expect(
    canContinueBlockedIndependentChild({ ...state, revision: 8 }, [
      ...journal,
      {
        event: { type: 'model.invocation_prepared', invocationId: 'new-model' } as RuntimeEvent,
        revision: 8,
      },
    ]),
  ).toBe(false);
  expect(
    canContinueBlockedIndependentChild(state, [
      ...journal.slice(0, -1),
      { event: { type: 'tool.started', toolCallId: 'other' } as RuntimeEvent, revision: 7 },
    ]),
  ).toBe(false);
});
