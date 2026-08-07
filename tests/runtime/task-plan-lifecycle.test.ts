import { describe, expect, test } from 'bun:test';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { eventsForRuntimeAction } from '@/core/runtime/actions';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { decideNextEffect } from '@/core/runtime/scheduler';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  getActivePlanning,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import type { AgentPlan } from '@/protocol/events';

function plan(name = 'Plan', status: AgentPlan['status'] = 'pending'): AgentPlan {
  return {
    name,
    description: 'A sufficiently detailed plan for lifecycle testing.',
    status,
    steps: [{ id: 'inspect', step: 'Inspect the runtime', status }],
  };
}

function withCall(
  state: ReturnType<typeof createInitialRuntimeState>,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): ReturnType<typeof createInitialRuntimeState> {
  return {
    ...state,
    tools: {
      ...state.tools,
      calls: {
        ...state.tools.calls,
        [toolCallId]: {
          toolCallId,
          modelMessageId: 'model-1',
          ordinal: 0,
          name,
          args,
          status: 'queued',
          createdAtTurnId: state.turn.turnId,
        },
      },
      queue: [...state.tools.queue, toolCallId],
    },
  };
}

function startTask(state: ReturnType<typeof createInitialRuntimeState>, taskId = 'task-1') {
  return reduceRuntimeState(state, {
    type: 'task.started',
    taskId,
    userGoal: 'Implement the lifecycle fix',
    turnId: state.turn.turnId,
  });
}

describe('Task-scoped Plan Mode lifecycle', () => {
  test('/plan enters through durable RuntimeEvents and creates an active task', () => {
    const state = reduceRuntimeState(
      startTask(createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/tmp' })),
      { type: 'planning.entered', taskId: 'task-1', source: 'user_command' },
    );

    expect(state.activeTaskId).toBe('task-1');
    expect(state.tasks['task-1']?.planning.kind).toBe('planning_empty');
    expect(state.planning.kind).toBe('planning_empty');
  });

  test('initial submit can self-enter planning, but side effects block it', async () => {
    const initial = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: process.cwd() }),
    );
    const submitArgs = {
      title: 'Inspect runtime',
      body_markdown: 'Inspect the runtime before changing implementation details.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
      action: 'submit' as const,
    };
    const submitted = await executeRuntimeTools({
      state: withCall(initial, 'submit', 'write_plan', submitArgs),
      toolCallIds: ['submit'],
    });
    expect(submitted.map((event) => event.type)).toEqual([
      'planning.entered',
      'plan.drafted',
      'plan.review_requested',
    ]);

    let withSideEffect = reduceRuntimeState(initial, {
      type: 'tool.queued',
      toolCallId: 'write',
      name: 'write_file',
      args: { path: 'x.txt', content: 'x' },
    });
    withSideEffect = reduceRuntimeState(withSideEffect, {
      type: 'tool.started',
      toolCallId: 'write',
    });
    const blocked = await executeRuntimeTools({
      state: withCall(withSideEffect, 'submit-2', 'write_plan', submitArgs),
      toolCallIds: ['submit-2'],
    });
    expect(blocked).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', toolCallId: 'submit-2' }),
    );
    expect(blocked).not.toContainEqual(expect.objectContaining({ type: 'planning.entered' }));
  });

  test('read-only exploration does not block automatic planning entry', async () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: process.cwd() }),
    );
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'search',
      name: 'shell_execute',
      args: { command: 'rg -n "PlanningState" src' },
    });
    state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: 'search' });
    expect(state.tasks['task-1']?.sideEffectsStarted).toBe(false);

    const submitted = await executeRuntimeTools({
      state: withCall(state, 'submit', 'write_plan', {
        title: 'Inspect runtime',
        body_markdown: 'Inspect the runtime before changing implementation details.',
        steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
        action: 'submit',
      }),
      toolCallIds: ['submit'],
    });
    expect(submitted[0]?.type).toBe('planning.entered');
  });

  test.each([
    'explore',
    'plan',
    'review',
  ] as const)('%s sub-agents do not block saving the initial plan', async (subagentType) => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: process.cwd() }),
    );
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: `subagent-${subagentType}`,
      name: 'task',
      args: { subagent_type: subagentType, task: 'Inspect the codebase.' },
    });
    state = reduceRuntimeState(state, {
      type: 'tool.started',
      toolCallId: `subagent-${subagentType}`,
    });

    expect(state.tasks['task-1']?.sideEffectsStarted).toBe(false);

    const submitted = await executeRuntimeTools({
      state: withCall(state, `submit-${subagentType}`, 'write_plan', {
        title: 'Inspect runtime',
        body_markdown: 'Inspect the runtime before changing implementation details.',
        steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
        action: 'save',
      }),
      toolCallIds: [`submit-${subagentType}`],
    });

    expect(submitted).toContainEqual(expect.objectContaining({ type: 'plan.drafted' }));
    expect(submitted).not.toContainEqual(expect.objectContaining({ type: 'tool.rejected' }));
  });

  test.each(['code', 'unknown'] as const)('%s task calls remain side-effectful', (subagentType) => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: process.cwd() }),
    );
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: `subagent-${subagentType}`,
      name: 'task',
      args: { subagent_type: subagentType, task: 'Change the codebase.' },
    });
    state = reduceRuntimeState(state, {
      type: 'tool.started',
      toolCallId: `subagent-${subagentType}`,
    });

    expect(state.tasks['task-1']?.sideEffectsStarted).toBe(true);
  });

  test('reports the side-effect boundary when a complete initial plan is too late', async () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: process.cwd() }),
    );
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'write',
      name: 'write_file',
      args: { path: 'x.txt', content: 'x' },
    });
    state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: 'write' });

    const rejected = await executeRuntimeTools({
      state: withCall(state, 'submit-late', 'write_plan', {
        title: 'Complete plan',
        body_markdown: 'This is a complete plan document that should be rejected late.',
        steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
        action: 'save',
      }),
      toolCallIds: ['submit-late'],
    });

    expect(rejected).toContainEqual({
      type: 'tool.rejected',
      toolCallId: 'submit-late',
      reason: 'write_plan cannot save a new plan after side effects have started.',
    });
  });

  test('cancel review closes the write_plan tool and keeps planning_draft', () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/tmp' }),
    );
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });
    state = withCall(state, 'plan-call', 'write_plan', {});
    const draft = plan();
    state = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      plan: draft,
      planId: 'plan-1',
      version: 1,
      structuralHash: computePlanStructuralDigest({
        title: draft.name,
        bodyMarkdown: draft.description,
        steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' }],
      }),
    });
    state = reduceRuntimeState(state, {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'plan-call',
      plan: draft,
      planId: 'plan-1',
      version: 1,
      planSummary: 'Plan',
    });
    if (state.interactions.kind !== 'awaiting_review') throw new Error('review missing');
    const events = eventsForRuntimeAction(state, {
      type: 'plan_review_decision',
      interactionId: 'review-1',
      planId: state.interactions.planId,
      version: state.interactions.version,
      structuralDigest: state.interactions.structuralDigest,
      decision: { kind: 'cancel', reason: 'Need to revisit the draft.' },
    });
    expect(events.map((event) => event.type)).toEqual([
      'plan.review_cancelled',
      'tool.cancelled',
      'turn.aborted',
    ]);
    for (const event of events) state = reduceRuntimeState(state, event);
    expect(getActivePlanning(state).kind).toBe('planning_draft');
    expect(state.interactions.kind).toBe('idle');
    expect(state.tools.calls['plan-call']?.status).toBe('cancelled');
    expect(state.turn.status).toBe('aborted');
    expect(decideNextEffect(state)).toEqual({ type: 'stop' });
  });

  test('executing supports structural replan and retains the superseded version', async () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/tmp' }),
    );
    const document = {
      planId: 'plan-1',
      version: 1,
      title: 'Plan',
      bodyMarkdown: 'A sufficiently detailed plan for lifecycle testing.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'completed' as const }],
      structuralDigest: 'digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    };
    state = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      plan: plan('Plan', 'completed'),
      planId: 'plan-1',
      version: 1,
      structuralHash: 'digest',
    });
    state = {
      ...state,
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: state.turn.turnId,
      },
      tasks: {
        ...state.tasks,
        'task-1': {
          ...state.tasks['task-1']!,
          planning: {
            kind: 'executing',
            document,
            executionMode: 'auto',
            approvedAtTurnId: state.turn.turnId,
          },
          executionMode: 'auto',
        },
      },
    };
    state = reduceRuntimeState(state, {
      type: 'plan.replan_requested',
      toolCallId: 'replan-call',
      reason: 'The runtime assumptions changed.',
      supersedesPlanVersion: 1,
    });
    expect(getActivePlanning(state).kind).toBe('replanning_draft');
    expect(state.tasks['task-1']?.planHistory).toHaveLength(1);
    expect(state.tasks['task-1']?.planHistory[0]?.version).toBe(1);

    const submit = await executeRuntimeTools({
      state: withCall(state, 'replan-call', 'write_plan', {
        title: 'Replanned execution',
        body_markdown: 'A sufficiently detailed structural replan.',
        steps: [{ id: 'inspect', title: 'Inspect the runtime again' }],
        action: 'submit',
      }),
      toolCallIds: ['replan-call'],
    });
    expect(submit.map((event) => event.type)).toEqual(['plan.drafted', 'plan.review_requested']);
    for (const event of submit) state = reduceRuntimeState(state, event);
    const awaiting = getActivePlanning(state);
    expect(awaiting.kind).toBe('awaiting_review');
    if (awaiting.kind === 'awaiting_review') {
      expect(awaiting.document.supersedesPlanVersion).toBe(1);
      expect(awaiting.document.replanReason).toBe('The runtime assumptions changed.');
    }
  });

  test('complete_plan is rejected while any effective step is pending', async () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: process.cwd() }),
    );
    const document = {
      planId: 'plan-pending',
      version: 1,
      title: 'Pending plan',
      bodyMarkdown: 'A sufficiently detailed plan for lifecycle testing.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' as const }],
      structuralDigest: 'digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    };
    state = {
      ...state,
      planning: {
        kind: 'executing',
        document,
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      },
      tasks: {
        ...state.tasks,
        'task-1': {
          ...state.tasks['task-1']!,
          planning: {
            kind: 'executing',
            document,
            executionMode: 'accept_edits',
            approvedAtTurnId: state.turn.turnId,
          },
        },
      },
    };
    const args = {
      plan_id: 'plan-pending',
      updates: [{ step_id: 'inspect', status: 'pending' }],
      complete_plan: true,
    };
    const events = await executeRuntimeTools({
      state: withCall(state, 'complete', 'update_plan', args),
      toolCallIds: ['complete'],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'complete',
        reason: 'Cannot complete plan while steps are pending or in progress.',
      }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'plan.completed' }));
  });

  test('task completion clears execution mode before the next task starts', () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/tmp' }),
    );
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });
    state = reduceRuntimeState(state, {
      type: 'plan.approved',
      interactionId: 'missing',
      executionMode: 'auto',
    });
    // The task-scoped value is explicitly cleared by task completion even when
    // the old compatibility mirror is still present in the snapshot.
    state = reduceRuntimeState(state, {
      type: 'run.completed',
      turnId: state.turn.turnId,
      output: 'done',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'message-2',
      content: 'Start a fresh task',
    });
    expect(state.activeTaskId).not.toBe('task-1');
    expect(state.tasks['task-1']?.executionMode).toBeUndefined();
  });

  test('approval mode stays on the active task and cannot leak to the next task', () => {
    let state = startTask(
      createInitialRuntimeState({ threadId: 't', userId: 'u', workspace: '/tmp' }),
    );
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });
    state = withCall(state, 'plan-call', 'write_plan', {});
    const draft = plan();
    state = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      plan: draft,
      planId: 'plan-1',
      version: 1,
      structuralHash: computePlanStructuralDigest({
        title: draft.name,
        bodyMarkdown: draft.description,
        steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' }],
      }),
    });
    state = reduceRuntimeState(state, {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'plan-call',
      plan: draft,
      planSummary: 'Plan',
    });
    if (state.interactions.kind !== 'awaiting_review') throw new Error('review missing');
    const approvalEvents = eventsForRuntimeAction(state, {
      type: 'plan_review_decision',
      interactionId: 'review-1',
      planId: state.interactions.planId,
      version: state.interactions.version,
      structuralDigest: state.interactions.structuralDigest,
      decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
    });
    for (const event of approvalEvents) state = reduceRuntimeState(state, event);

    expect(getActivePlanning(state).kind).toBe('executing');
    expect(state.tasks['task-1']?.executionMode).toBe('auto');
    expect(state.mode).toBe('accept_edits');
    expect(getEffectiveInteractionMode(state)).toBe('auto');

    state = reduceRuntimeState(state, {
      type: 'run.completed',
      turnId: state.turn.turnId,
      output: 'done',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'message-2',
      content: 'Start a fresh task',
    });
    expect(getEffectiveInteractionMode(state)).toBe('accept_edits');
    expect(state.tasks[state.activeTaskId ?? '']?.taskId).not.toBe('task-1');
  });
});
