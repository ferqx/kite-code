import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  countPendingSteerInputs,
  createInitialAgentState,
  type KernelEvent,
  reduceAgentState,
} from '../src';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function reduce(state: AgentState, event: KernelEvent): AgentState {
  return reduceAgentState(state, event);
}

function activeState(): AgentState {
  let state = createInitialAgentState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-before',
    recoveryIdentityKey: IDENTITY_KEY,
  });
  state = reduce(state, { type: 'user.message_appended', messageId: 'start', content: 'start' });
  state = reduce(state, { type: 'turn.started', turnId: 'turn-1' });
  state = reduce(state, { type: 'user.message_appended', messageId: 'steer-1', content: 'one' });
  state = reduce(state, { type: 'user.message_appended', messageId: 'steer-2', content: 'two' });
  return state;
}

describe('deterministic input delivery facts', () => {
  test('counts current-Turn steer inputs after the latest primary request watermark', () => {
    let state = activeState();
    expect(
      countPendingSteerInputs(state, [
        { messageId: 'start', revision: 1 },
        { messageId: 'steer-1', revision: 3 },
        { messageId: 'steer-2', revision: 4 },
      ]),
    ).toBe(2);

    state = reduce(state, {
      type: 'model.invocation_prepared',
      invocationId: 'model-1',
      purpose: 'primary_agent',
      surfaceArtifact: {
        artifactId: 'surface-1',
        kind: 'model_surface',
        integrityIdentifier: 'sha256:surface-1',
        byteLength: 1,
      },
      surfaceIntegrityIdentifier: 'sha256:surface-1',
      routeFingerprint: `sha256:${'1'.repeat(64)}`,
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 1, totalTimeBudgetMs: 1 },
      preparedStateRevision: 3,
      parentInvocationId: null,
      parentToolCallId: null,
    });
    expect(
      countPendingSteerInputs(state, [
        { messageId: 'start', revision: 1 },
        { messageId: 'steer-1', revision: 3 },
        { messageId: 'steer-2', revision: 4 },
      ]),
    ).toBe(1);
  });

  test('does not treat subagent preparation as root input delivery', () => {
    let state = activeState();
    state = reduce(state, {
      type: 'model.invocation_prepared',
      invocationId: 'child-model',
      purpose: 'subagent',
      surfaceArtifact: {
        artifactId: 'surface-child',
        kind: 'model_surface',
        integrityIdentifier: 'sha256:surface-child',
        byteLength: 1,
      },
      surfaceIntegrityIdentifier: 'sha256:surface-child',
      routeFingerprint: `sha256:${'2'.repeat(64)}`,
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 1, totalTimeBudgetMs: 1 },
      preparedStateRevision: 4,
      parentInvocationId: 'parent',
      parentToolCallId: 'tool',
    });
    expect(
      countPendingSteerInputs(state, [
        { messageId: 'start', revision: 1 },
        { messageId: 'steer-1', revision: 3 },
        { messageId: 'steer-2', revision: 4 },
      ]),
    ).toBe(2);
  });
});
