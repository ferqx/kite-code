import { expect, test } from 'bun:test';
import { createInitialAgentState, decideNextEffect } from '../src';

const recoveryIdentityKey = '0123456789abcdef'.repeat(4);

test('an unknown capability from an earlier turn remains recorded without blocking a new turn', () => {
  const state = createInitialAgentState({
    threadId: 'session',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'new-turn',
    recoveryIdentityKey,
  });
  const oldCall = {
    toolCallId: 'old-tool',
    name: 'shell_execute',
    modelMessageId: 'old-message',
    args: { command: 'unknown external action' },
    createdAtTurnId: 'old-turn',
    status: 'failed' as const,
  };
  const invocation = {
    invocationId: 'old-invocation',
    toolCallId: oldCall.toolCallId,
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    argumentsDigest: 'arguments',
    authorizationDigest: 'authorization',
    effectiveEffectsDigest: 'effects',
    status: 'unknown' as const,
    taskId: 'continued-task',
    recordedAt: '2026-08-20T00:00:00.000Z',
  };
  const withHistory = {
    ...state,
    activeTaskId: 'continued-task',
    tools: {
      ...state.tools,
      calls: { [oldCall.toolCallId]: { ...oldCall, taskId: 'continued-task' } },
    },
    capabilities: {
      ...state.capabilities,
      invocations: { [invocation.invocationId]: invocation },
    },
  };
  expect(decideNextEffect(withHistory).type).not.toBe('recovery_blocked');
  const current = {
    ...withHistory,
    tools: {
      ...withHistory.tools,
      calls: { [oldCall.toolCallId]: { ...oldCall, createdAtTurnId: state.turn.turnId } },
    },
  };
  expect(decideNextEffect(current)).toMatchObject({
    type: 'recovery_blocked',
    failureKind: 'unknown',
  });
  const ambiguous = {
    ...withHistory,
    tools: { ...state.tools, calls: {} },
    capabilities: {
      ...withHistory.capabilities,
      invocations: { [invocation.invocationId]: { ...invocation, taskId: undefined } },
    },
  };
  expect(decideNextEffect(ambiguous)).toMatchObject({
    type: 'recovery_blocked',
    failureKind: 'unknown',
  });
});
