import { describe, expect, it } from 'bun:test';
import type { CodeAgentState } from '@/core/harness/state';
import { agentStateToRuntimeState, runtimeStateToAgentStatePartial } from '@/core/runtime/bridge';
import type { WorkspaceAccess } from '@/protocol/events';

function makeAgentState(overrides?: Partial<CodeAgentState>): CodeAgentState {
  return {
    messages: [],
    workspace: '/tmp/test',
    threadId: 'thread-1',
    userId: 'user-1',
    workspaceAccess: 'write' as WorkspaceAccess,
    phase: 'building' as const,
    plan: null,
    planReviewed: false,
    interactionMode: 'ask' as const,
    authorization: { mode: 'default' as const, commandGrants: {} },
    autoReviewState: {
      pendingWarnings: {},
      consecutiveRejects: 0,
      rejectionHistory: [],
      circuitBreakerTripped: false,
    },
    doomLoopTracker: {},
    ...overrides,
  } as unknown as CodeAgentState;
}

describe('agentStateToRuntimeState', () => {
  it('should map basic session fields', () => {
    const state = agentStateToRuntimeState(makeAgentState(), 'thread-1', 'user-1', '/tmp/test', 0);
    expect(state.session.threadId).toBe('thread-1');
    expect(state.session.userId).toBe('user-1');
    expect(state.session.workspace).toBe('/tmp/test');
  });

  it('should map interaction mode', () => {
    const state = agentStateToRuntimeState(
      makeAgentState({ interactionMode: 'auto' }),
      't1',
      'u1',
      '/w',
      0,
    );
    expect(state.mode).toBe('auto');
  });

  it('should map phase', () => {
    const state = agentStateToRuntimeState(
      makeAgentState({ phase: 'planning' }),
      't1',
      'u1',
      '/w',
      0,
    );
    expect(state.phase).toBe('planning');
  });

  it('should map workspace access', () => {
    const state = agentStateToRuntimeState(
      makeAgentState({ workspaceAccess: 'read' as WorkspaceAccess }),
      't1',
      'u1',
      '/w',
      0,
    );
    expect(state.workspaceAccess as string).toBe('read');
  });

  it('should map null plan to none', () => {
    const state = agentStateToRuntimeState(makeAgentState({ plan: null }), 't1', 'u1', '/w', 0);
    expect(state.plan.kind).toBe('none');
  });

  it('should map approved plan', () => {
    const plan = { name: 'Test', description: 'Desc', status: 'pending' as const, steps: [] };
    const state = agentStateToRuntimeState(
      makeAgentState({ plan, planReviewed: true }),
      't1',
      'u1',
      '/w',
      0,
    );
    expect(state.plan.kind).toBe('approved');
  });

  it('should map un-reviewed plan to drafted', () => {
    const plan = { name: 'Test', description: 'Desc', status: 'pending' as const, steps: [] };
    const state = agentStateToRuntimeState(
      makeAgentState({ plan, planReviewed: false }),
      't1',
      'u1',
      '/w',
      0,
    );
    expect(state.plan.kind).toBe('drafted');
  });

  it('should map authorization mode', () => {
    const state = agentStateToRuntimeState(
      makeAgentState({
        authorization: {
          mode: 'full_access',
          commandGrants: { key1: { workspace: '/w', threadId: 't1', command: 'ls' } },
        },
      }),
      't1',
      'u1',
      '/w',
      0,
    );
    expect(state.authorization.mode).toBe('full_access');
    expect(state.authorization.commandGrants.key1).toBeDefined();
  });

  it('should preserve turn index', () => {
    const state = agentStateToRuntimeState(makeAgentState(), 't1', 'u1', '/w', 5);
    expect(state.turn.turnIndex).toBe(5);
  });
});

describe('runtimeStateToAgentStatePartial', () => {
  it('should project none plan to null', () => {
    const rt = agentStateToRuntimeState(makeAgentState({ plan: null }), 't1', 'u1', '/w', 0);
    const partial = runtimeStateToAgentStatePartial(rt);
    expect(partial.plan).toBeNull();
    expect(partial.planReviewed).toBe(false);
  });

  it('should project approved plan with planReviewed=true', () => {
    const plan = { name: 'T', description: 'D', status: 'pending' as const, steps: [] };
    const rt = agentStateToRuntimeState(
      makeAgentState({ plan, planReviewed: true }),
      't1',
      'u1',
      '/w',
      0,
    );
    const partial = runtimeStateToAgentStatePartial(rt);
    expect(partial.plan?.name).toBe('T');
    expect(partial.planReviewed).toBe(true);
  });

  it('should project interaction mode', () => {
    const rt = agentStateToRuntimeState(
      makeAgentState({ interactionMode: 'full' }),
      't1',
      'u1',
      '/w',
      0,
    );
    const partial = runtimeStateToAgentStatePartial(rt);
    expect(partial.interactionMode).toBe('full');
  });

  it('should project phase', () => {
    const rt = agentStateToRuntimeState(makeAgentState({ phase: 'planning' }), 't1', 'u1', '/w', 0);
    const partial = runtimeStateToAgentStatePartial(rt);
    expect(partial.phase).toBe('planning');
  });

  it('should project authorization', () => {
    const rt = agentStateToRuntimeState(
      makeAgentState({ authorization: { mode: 'full_access', commandGrants: {} } }),
      't1',
      'u1',
      '/w',
      0,
    );
    const partial = runtimeStateToAgentStatePartial(rt);
    expect(partial.authorization?.mode).toBe('full_access');
  });

  it('should round-trip basic state', () => {
    const original = makeAgentState({
      interactionMode: 'auto',
      phase: 'building',
      workspaceAccess: 'write',
      authorization: { mode: 'default', commandGrants: {} },
    });
    const rt = agentStateToRuntimeState(original, 'thread-1', 'user-1', '/tmp/test', 0);
    const partial = runtimeStateToAgentStatePartial(rt);
    expect(partial.interactionMode).toBe(original.interactionMode);
    expect(partial.phase).toBe(original.phase);
    expect(partial.workspaceAccess).toBe(original.workspaceAccess);
    expect(partial.authorization?.mode).toBe(original.authorization?.mode);
  });
});
