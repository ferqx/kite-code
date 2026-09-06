import { describe, expect, test } from 'bun:test';
import { type AgentState, createInitialAgentState } from '@kite-ai/agent-kernel';
import { isRunStoreMigrationSessionSettled } from '../../src/coordinator/run-store-maintenance';

function state(): AgentState {
  return createInitialAgentState({
    threadId: 'session-maintenance',
    userId: 'user-maintenance',
    workspace: '/workspace/maintenance',
    projectId: 'project-maintenance',
    canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
    turnId: 'turn-maintenance',
    recoveryIdentityKey: 'b'.repeat(64),
  });
}

function settled(): AgentState {
  return {
    ...state(),
    turn: { turnId: 'turn-maintenance', turnIndex: 0, status: 'completed' },
    terminalOutcome: {
      version: 1,
      status: 'completed',
      reasonCode: 'completed',
      knownExternalEffects: 'known',
      safeRetry: false,
      recoveryEntry: 'none',
      pendingVerification: false,
    },
  };
}

describe('Run Store maintenance State convergence', () => {
  test('accepts only a terminal State with no retained authority', () => {
    expect(isRunStoreMigrationSessionSettled(state())).toBe(false);
    expect(isRunStoreMigrationSessionSettled(settled())).toBe(true);
  });

  test('rejects unknown external effects and nonterminal owner records', () => {
    expect(
      isRunStoreMigrationSessionSettled({
        ...settled(),
        terminalOutcome: {
          ...settled().terminalOutcome!,
          status: 'unknown',
          reasonCode: 'unknown',
          knownExternalEffects: 'unknown',
          recoveryEntry: 'reconcile',
        },
      }),
    ).toBe(false);
    expect(
      isRunStoreMigrationSessionSettled({
        ...settled(),
        capabilities: {
          ...settled().capabilities,
          invocations: {
            invocation: {
              invocationId: 'invocation',
              toolCallId: 'tool-call',
              capabilityId: 'shell',
              capabilityRevision: '1',
              argumentsDigest: 'arguments',
              authorizationDigest: 'authorization',
              effectiveEffectsDigest: 'effects',
              status: 'unknown',
              recordedAt: '2026-08-30T00:00:00.000Z',
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      isRunStoreMigrationSessionSettled({
        ...settled(),
        interactions: {
          kind: 'awaiting_user_input',
          interactionId: 'interaction',
          toolCallId: 'tool-call',
          request: { questions: [] },
        },
      } as unknown as AgentState),
    ).toBe(false);
  });
});
