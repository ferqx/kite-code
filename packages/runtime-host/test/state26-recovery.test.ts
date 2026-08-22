import { describe, expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite/agent-kernel';
import {
  isRuntimeHostState26ToolRecoveryInvalidV1,
  projectRuntimeHostState26RestartRecoveryEventsV1,
  runtimeHostState26RestartRecoveryCapabilityInvocationIdsV1,
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

describe('Runtime Host State26 recovery port', () => {
  test('projects the Kernel-owned restart policy without ambient evidence', () => {
    const state = freshState();
    expect(runtimeHostState26RestartRecoveryCapabilityInvocationIdsV1(state)).toEqual([]);
    expect(
      projectRuntimeHostState26RestartRecoveryEventsV1(state, {
        capabilityFinishedAtByInvocationId: {},
        pendingModelEvidenceFailures: {},
        completedModelEvidenceFailures: {},
      }),
    ).toEqual([]);
  });

  test('fails closed on the exact durable journal-invalid marker', () => {
    const state = freshState();
    expect(isRuntimeHostState26ToolRecoveryInvalidV1(state)).toBe(false);
    expect(
      isRuntimeHostState26ToolRecoveryInvalidV1({
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
