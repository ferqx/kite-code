import { describe, expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite/agent-kernel';
import {
  isRuntimeHostState25ToolRecoveryInvalidV1,
  projectRuntimeHostState25RestartRecoveryEventsV1,
  runtimeHostState25RestartRecoveryCapabilityInvocationIdsV1,
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

describe('Runtime Host State25 recovery port', () => {
  test('projects the Kernel-owned restart policy without ambient evidence', () => {
    const state = freshState();
    expect(runtimeHostState25RestartRecoveryCapabilityInvocationIdsV1(state)).toEqual([]);
    expect(
      projectRuntimeHostState25RestartRecoveryEventsV1(state, {
        capabilityFinishedAtByInvocationId: {},
        pendingModelEvidenceFailures: {},
        completedModelEvidenceFailures: {},
      }),
    ).toEqual([]);
  });

  test('fails closed on the exact durable journal-invalid marker', () => {
    const state = freshState();
    expect(isRuntimeHostState25ToolRecoveryInvalidV1(state)).toBe(false);
    expect(
      isRuntimeHostState25ToolRecoveryInvalidV1({
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
