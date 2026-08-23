import { describe, expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite/agent-kernel';
import {
  isRuntimeHostStateToolRecoveryInvalid,
  projectRuntimeHostStateRestartRecoveryEvents,
  runtimeHostStateRestartRecoveryCapabilityInvocationIds,
} from '@kite/runtime-host';

const RECOVERY_KEY = 'a'.repeat(64);

function freshState() {
  return createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
}

describe('Runtime Host State recovery port', () => {
  test('projects the Kernel-owned restart policy without ambient evidence', () => {
    const state = freshState();
    expect(runtimeHostStateRestartRecoveryCapabilityInvocationIds(state)).toEqual([]);
    expect(
      projectRuntimeHostStateRestartRecoveryEvents(state, {
        capabilityFinishedAtByInvocationId: {},
        pendingModelEvidenceFailures: {},
        completedModelEvidenceFailures: {},
      }),
    ).toEqual([]);
  });

  test('fails closed on the exact durable journal-invalid marker', () => {
    const state = freshState();
    expect(isRuntimeHostStateToolRecoveryInvalid(state)).toBe(false);
    expect(
      isRuntimeHostStateToolRecoveryInvalid({
        ...state,
        toolRecovery: {
          ...state.toolRecovery,
          qualityGuard: {
            blocked: true,
            reasonCode: 'journal_invalid',
            observedFailures: 0,
          },
        },
      }),
    ).toBe(true);
  });
});
