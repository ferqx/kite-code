import { describe, expect, test } from 'bun:test';
import { decideCompletionV1 } from '@/core/runtime/completion-guard';
import { AgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState, setActivePlanning } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

function activePlanningState() {
  let state = createInitialRuntimeState({
    threadId: 'guard',
    userId: 'u',
    workspace: '/tmp',
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'task-1',
    userGoal: 'Make a plan before implementation.',
    turnId: state.turn.turnId,
  });
  return reduceRuntimeState(state, {
    type: 'planning.entered',
    taskId: 'task-1',
    source: 'user_command',
  });
}

describe('CompletionGuard V1', () => {
  test('blocks every incomplete Plan lifecycle before it can become task completion', () => {
    const state = activePlanningState();
    expect(decideCompletionV1(state)).toMatchObject({
      status: 'blocked',
      code: 'planning_empty',
      nextAction: 'save_plan',
    });

    const draft = setActivePlanning(state, {
      kind: 'planning_draft',
      document: {
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'a'.repeat(64),
        title: 'Plan',
        bodyMarkdown: 'Describe the implementation and validation work.',
        steps: [{ id: 'inspect', title: 'Inspect', status: 'pending' }],
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      },
    });
    expect(decideCompletionV1(draft)).toMatchObject({
      status: 'blocked',
      code: 'plan_draft_pending',
      nextAction: 'submit_plan',
    });

    const executing = setActivePlanning(draft, {
      kind: 'executing',
      document: {
        ...(draft.planning.kind === 'planning_draft'
          ? draft.planning.document
          : (() => {
              throw new Error('expected planning draft');
            })()),
        steps: [{ id: 'inspect', title: 'Inspect', status: 'in_progress' }],
      },
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    });
    expect(decideCompletionV1(executing)).toMatchObject({
      status: 'blocked',
      code: 'plan_execution_incomplete',
      nextAction: 'complete_plan',
    });
  });

  test('reducer rejects a bypassed run.completed event while a plan is incomplete', () => {
    const state = activePlanningState();
    const next = reduceRuntimeState(state, {
      type: 'run.completed',
      turnId: state.turn.turnId,
      output: 'I am done.',
    });
    expect(next.activeTaskId).toBe(state.activeTaskId);
    expect(next.tasks[state.activeTaskId!]?.status).toBe('active');
  });

  test('allows an unplanned building task to complete with a bound guard decision', () => {
    let state = createInitialRuntimeState({ threadId: 'building', userId: 'u', workspace: '/tmp' });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-1',
      content: 'Answer the question.',
    });
    expect(decideCompletionV1(state)).toEqual({
      status: 'accepted',
      version: 'completion_guard_v1',
    });
    const next = reduceRuntimeState(state, {
      type: 'run.completed',
      turnId: state.turn.turnId,
      output: 'Done.',
      completionGuardVersion: 'completion_guard_v1',
    });
    expect(next.activeTaskId).toBeNull();
    expect(Object.values(next.tasks).at(0)?.status).toBe('completed');
  });

  test('uses exactly one correction, then ends as blocked instead of completed', async () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: activePlanningState(),
      interactionMode: 'accept_edits',
    });
    let modelCalls = 0;
    const events: string[] = [];
    for await (const event of runRuntimeLoop(
      kernel,
      async () => {
        modelCalls++;
        return [
          { type: 'model.responded' as const, messageId: `final-${modelCalls}`, text: 'Done.' },
        ];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(modelCalls).toBe(2);
    expect(events).toEqual([
      'model.responded',
      'completion.blocked',
      'model.responded',
      'completion.blocked',
      'turn.aborted',
      'run.error',
    ]);
    expect(events).not.toContain('run.completed');
    expect(kernel.getState().tasks[kernel.getState().activeTaskId!]?.status).toBe('active');
    kernel.close();
  });
});
