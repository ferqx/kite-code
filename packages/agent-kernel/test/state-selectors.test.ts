import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  type AgentTaskState,
  createInitialAgentState,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
} from '../src';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function initial(): AgentState {
  return createInitialAgentState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: IDENTITY_KEY,
  });
}

function withTask(
  state: AgentState,
  task: AgentTaskState,
  mode: AgentState['mode'] = state.mode,
): AgentState {
  return {
    ...state,
    activeTaskId: task.taskId,
    tasks: { [task.taskId]: task },
    mode,
  };
}

describe('State26 selectors', () => {
  test('returns the active task and its planning state from the explicit identity', () => {
    const state = initial();
    const task: AgentTaskState = {
      taskId: 'task-1',
      userGoal: 'Inspect the repository',
      status: 'active',
      startedAtTurnId: 'turn-1',
      sideEffectsStarted: false,
      planning: { kind: 'planning_empty' },
      executionMode: 'auto',
      planHistory: [],
    };
    const active = withTask(state, task);

    expect(getActiveTask(active)).toBe(task);
    expect(getActivePlanning(active)).toEqual({ kind: 'planning_empty' });
    expect(getEffectiveInteractionMode(active)).toBe('auto');
  });

  test('uses the top-level interaction mode when the active task has no execution mode', () => {
    const task: AgentTaskState = {
      taskId: 'task-2',
      userGoal: 'Review a plan',
      status: 'active',
      startedAtTurnId: 'turn-1',
      sideEffectsStarted: false,
      planning: { kind: 'building_without_plan' },
      planHistory: [],
    };
    const state = withTask(initial(), task, 'full');

    expect(getEffectiveInteractionMode(state)).toBe('full');
  });

  test('fails closed to State26 fallbacks when the active-task identity is absent or stale', () => {
    const state = initial();

    expect(getActiveTask(state)).toBeNull();
    expect(getActivePlanning(state)).toEqual({ kind: 'building_without_plan' });
    expect(getEffectiveInteractionMode(state)).toBe('accept_edits');

    const stale = { ...state, activeTaskId: 'missing-task' };
    expect(getActiveTask(stale)).toBeNull();
    expect(getActivePlanning(stale)).toEqual({ kind: 'building_without_plan' });
    expect(getEffectiveInteractionMode(stale)).toBe('accept_edits');
  });
});
