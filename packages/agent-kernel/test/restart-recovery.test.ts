import { describe, expect, test } from 'bun:test';
import { createInitialAgentState, projectStateRestartRecoveryEventsV1 } from '@kite/agent-kernel';

const RECOVERY_KEY = 'a'.repeat(64);

describe('State restart recovery projection', () => {
  test('is a pure no-op for a fresh session', () => {
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: RECOVERY_KEY,
    });
    expect(
      projectStateRestartRecoveryEventsV1(state, {
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
      projectStateRestartRecoveryEventsV1(state, {
        capabilityFinishedAtByInvocationId: {},
        pendingModelEvidenceFailures: {},
        completedModelEvidenceFailures: {},
      }),
    ).toEqual([]);
  });
});
