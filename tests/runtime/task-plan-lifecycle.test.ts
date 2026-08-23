import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { computePlanStructuralDigest } from '@kite/builtin-runtime/planning';
import type { AgentPlan } from '@kite/runtime-contract';
import {
  createRuntimeHostStateInitialState,
  getActivePlanning,
  getEffectiveInteractionMode,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
} from '@kite/runtime-host';
import { eventsForRuntimeAction } from '#app/bootstrap/runtime/state-actions';
import { reduceRuntimeState as reduceCanonicalRuntimeState } from '#runtime-support/runtime-state-reducer';
import { decideNextEffect } from '../helpers/agent-kernel-scheduler';
import { currentPlanDocument } from '../helpers/current-plan';
import { executeTestRuntimeTools, testBuiltinToolCatalog } from '../helpers/runtime-model';

function reduceRuntimeState(
  state: ReturnType<typeof createRuntimeHostStateInitialState>,
  event: RuntimeEvent,
): ReturnType<typeof createRuntimeHostStateInitialState> {
  return reduceCanonicalRuntimeState(
    state,
    normalizeCurrentToolOutcomeEvent(event, state, '2026-08-11T00:00:00.000Z'),
  );
}

function plan(name = 'Plan', status: AgentPlan['status'] = 'pending'): AgentPlan {
  return {
    name,
    description: 'A sufficiently detailed plan for lifecycle testing.',
    status,
    steps: [{ id: 'inspect', step: 'Inspect the runtime', status }],
  };
}

function planArtifact(taskId: string, planId: string, version: number, structuralDigest: string) {
  return {
    artifactId: `${planId}:v${version}`,
    taskId,
    planId,
    version,
    fileName: `v${version}.md`,
    relativePath: `plans/${taskId}/${planId}/v${version}.md`,
    displayPath: `/plans/${taskId}/${planId}/v${version}.md`,
    structuralDigest,
    byteLength: 100,
  };
}

function withCall(
  state: ReturnType<typeof createRuntimeHostStateInitialState>,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): ReturnType<typeof createRuntimeHostStateInitialState> {
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

function startTask(
  state: ReturnType<typeof createRuntimeHostStateInitialState>,
  taskId = 'task-1',
) {
  return reduceRuntimeState(state, {
    type: 'task.started',
    taskId,
    userGoal: 'Implement the lifecycle fix',
    turnId: state.turn.turnId,
  });
}

describe('Task-scoped Plan Mode lifecycle', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.KITE_CODE_HOME;
    home = mkdtempSync(join(tmpdir(), 'kite-code-task-plan-lifecycle-'));
    process.env.KITE_CODE_HOME = home;
  });

  afterEach(() => {
    if (previousHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('/plan enters through durable RuntimeEvents and creates an active task', () => {
    const state = reduceRuntimeState(
      startTask(
        createRuntimeHostStateInitialState({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId: 't',
          userId: 'u',
          workspace: '/tmp',
        }),
      ),
      { type: 'planning.entered', taskId: 'task-1', source: 'user_command' },
    );

    expect(state.activeTaskId).toBe('task-1');
    expect(state.tasks['task-1']?.planning.kind).toBe('planning_empty');
    expect(getActivePlanning(state).kind).toBe('planning_empty');
  });

  test('initial save can self-enter planning, then the saved Artifact can be submitted', async () => {
    const initial = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: process.cwd(),
      }),
    );
    const saveArgs = {
      title: 'Inspect runtime',
      body_markdown: 'Inspect the runtime before changing implementation details.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
      action: 'save' as const,
    };
    const saveState = withCall(initial, 'save', 'write_plan', saveArgs);
    const saved = await executeTestRuntimeTools({
      state: saveState,
      toolCallIds: ['save'],
    });
    expect(saved.map((event) => event.type)).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
      'tool.started',
      'capability.execution_succeeded',
      'planning.entered',
      'plan.drafted',
      'tool.finished',
    ]);
    let savedState = saveState;
    for (const event of saved) savedState = reduceRuntimeState(savedState, event);
    const draft = getActivePlanning(savedState);
    if (draft.kind !== 'planning_draft') throw new Error('saved plan missing');
    const submitted = await executeTestRuntimeTools({
      state: withCall(savedState, 'submit', 'write_plan', {
        action: 'submit',
        plan_id: draft.document.planId,
        version: draft.document.version,
        structural_digest: draft.document.structuralDigest,
      }),
      toolCallIds: ['submit'],
    });
    expect(submitted.map((event) => event.type)).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
      'tool.started',
      'capability.execution_result_recorded',
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
    const blocked = await executeTestRuntimeTools({
      state: withCall(withSideEffect, 'save-2', 'write_plan', saveArgs),
      toolCallIds: ['save-2'],
    });
    expect(blocked).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', toolCallId: 'save-2' }),
    );
    expect(blocked).not.toContainEqual(expect.objectContaining({ type: 'planning.entered' }));
  });

  test('read-only exploration does not block automatic planning entry', async () => {
    let state = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: process.cwd(),
      }),
    );
    const shellEntry = testBuiltinToolCatalog().entries.find(
      (entry) => entry.visibility === 'model' && entry.name === 'shell_execute',
    );
    if (!shellEntry) throw new Error('Builtin shell catalog entry missing');
    const shellArgs = { command: 'rg -n "PlanningState" src' };
    const shellEffects = shellEntry.classifyEffects(shellArgs);
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'search',
      name: 'shell_execute',
      args: shellArgs,
      effectClass: shellEffects.effectClass,
      sideEffect: shellEffects.sideEffect,
      classificationReason: shellEffects.classificationReason,
    });
    state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: 'search' });
    expect(state.tasks['task-1']?.sideEffectsStarted).toBe(false);

    const submitted = await executeTestRuntimeTools({
      state: withCall(state, 'submit', 'write_plan', {
        title: 'Inspect runtime',
        body_markdown: 'Inspect the runtime before changing implementation details.',
        steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
        action: 'save',
      }),
      toolCallIds: ['submit'],
    });
    expect(submitted).toContainEqual(expect.objectContaining({ type: 'planning.entered' }));
  });

  test.each([
    'explore',
    'plan',
    'review',
  ] as const)('%s sub-agents do not block saving the initial plan', async (subagentType) => {
    let state = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: process.cwd(),
      }),
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

    const submitted = await executeTestRuntimeTools({
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

  test('successful plan child cannot replace Runtime-owned save and submit lifecycle facts', () => {
    let state = reduceRuntimeState(
      startTask(
        createRuntimeHostStateInitialState({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId: 't',
          userId: 'u',
          workspace: '/tmp',
        }),
      ),
      { type: 'planning.entered', taskId: 'task-1', source: 'user_command' },
    );
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'plan-child',
      modelMessageId: 'model-child',
      name: 'task',
      args: { subagent_type: 'plan', task: 'Design the Runtime architecture change.' },
    });
    state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: 'plan-child' });
    state = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'plan-child',
      name: 'task',
      result: { ok: true, command: 'task', exitCode: 0, stdout: 'plan summary', stderr: '' },
    });
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'model-final',
      text: 'The child supplied a plan, so this task is done.',
    });

    expect(getActivePlanning(state).kind).toBe('planning_empty');
    expect(decideNextEffect(state)).toMatchObject({ type: 'completion_blocked' });
  });

  test.each(['code', 'unknown'] as const)('%s task calls remain side-effectful', (subagentType) => {
    let state = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: process.cwd(),
      }),
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
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: process.cwd(),
      }),
    );
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'write',
      name: 'write_file',
      args: { path: 'x.txt', content: 'x' },
    });
    state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: 'write' });

    const rejected = await executeTestRuntimeTools({
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
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: '/tmp',
      }),
    );
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });
    state = withCall(state, 'plan-call', 'write_plan', {});
    const draft = plan();
    const structuralHash = computePlanStructuralDigest({
      title: draft.name,
      bodyMarkdown: draft.description,
      steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' }],
    });
    state = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      taskId: 'task-1',
      plan: draft,
      planId: 'plan-1',
      version: 1,
      structuralHash,
      planSchemaVersion: 2,
      artifact: planArtifact('task-1', 'plan-1', 1, structuralHash),
    });
    state = reduceRuntimeState(state, {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'plan-call',
      taskId: 'task-1',
      plan: draft,
      planId: 'plan-1',
      version: 1,
      structuralDigest: structuralHash,
      artifact: planArtifact('task-1', 'plan-1', 1, structuralHash),
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
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: '/tmp',
      }),
    );
    const document = currentPlanDocument({
      planId: 'plan-1',
      version: 1,
      title: 'Plan',
      bodyMarkdown: 'A sufficiently detailed plan for lifecycle testing.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'completed' as const }],
      structuralDigest: 'digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    });
    state = {
      ...state,
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

    const replanSaveState = withCall(state, 'replan-save', 'write_plan', {
      plan_id: document.planId,
      version: document.version,
      structural_digest: document.structuralDigest,
      title: 'Replanned execution',
      body_markdown: 'A sufficiently detailed structural replan.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime again' }],
      action: 'save',
    });
    const saved = await executeTestRuntimeTools({
      state: replanSaveState,
      toolCallIds: ['replan-save'],
    });
    expect(saved.map((event) => event.type)).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
      'tool.started',
      'capability.execution_succeeded',
      'plan.drafted',
      'tool.finished',
    ]);
    state = replanSaveState;
    for (const event of saved) state = reduceRuntimeState(state, event);
    const replanned = getActivePlanning(state);
    if (replanned.kind !== 'replanning_draft') throw new Error('replanned draft missing');
    const replanSubmitState = withCall(state, 'replan-submit', 'write_plan', {
      plan_id: replanned.document.planId,
      version: replanned.document.version,
      structural_digest: replanned.document.structuralDigest,
      action: 'submit',
    });
    const submitted = await executeTestRuntimeTools({
      state: replanSubmitState,
      toolCallIds: ['replan-submit'],
    });
    expect(submitted.map((event) => event.type)).toEqual([
      'capability.invocation_recorded',
      'capability.execution_started',
      'tool.started',
      'capability.execution_result_recorded',
      'plan.review_requested',
    ]);
    state = replanSubmitState;
    for (const event of submitted) state = reduceRuntimeState(state, event);
    const awaiting = getActivePlanning(state);
    expect(awaiting.kind).toBe('awaiting_review');
    if (awaiting.kind === 'awaiting_review') {
      expect(awaiting.document.supersedesPlanVersion).toBe(1);
      expect(awaiting.document.replanReason).toBe('The runtime assumptions changed.');
    }
  });

  test('complete_plan is rejected while any effective step is pending', async () => {
    let state = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: process.cwd(),
      }),
    );
    const document = {
      planSchemaVersion: 2 as const,
      planId: 'plan-pending',
      version: 1,
      title: 'Pending plan',
      bodyMarkdown: 'A sufficiently detailed plan for lifecycle testing.',
      steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' as const }],
      structuralDigest: 'digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
      completionEvidence: {
        schemaVersion: 1 as const,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    };
    state = {
      ...state,
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
      version: 1,
      structural_digest: 'digest',
      updates: [{ step_id: 'inspect', status: 'pending' }],
      complete_plan: true,
    };
    const events = await executeTestRuntimeTools({
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

  test('an incomplete planning task cannot be cleared by a bypassed completion event', () => {
    let state = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: '/tmp',
      }),
    );
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });
    state = reduceRuntimeState(state, {
      type: 'plan.approved',
      interactionId: 'missing',
      toolCallId: 'missing',
      planId: 'missing',
      version: 1,
      structuralDigest: 'missing',
      executionMode: 'auto',
    });
    // CompletionGuard rejects the old shortcut: the Plan lifecycle is still
    // incomplete, so this is not task completion.
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
    expect(state.activeTaskId).toBe('task-1');
    expect(state.tasks['task-1']?.executionMode).toBeUndefined();
  });

  test('approval mode stays on the active task and cannot leak to the next task', () => {
    let state = startTask(
      createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't',
        userId: 'u',
        workspace: '/tmp',
      }),
    );
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });
    state = withCall(state, 'plan-call', 'write_plan', {});
    const draft = plan();
    const structuralHash = computePlanStructuralDigest({
      title: draft.name,
      bodyMarkdown: draft.description,
      steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' }],
    });
    state = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      taskId: 'task-1',
      plan: draft,
      planId: 'plan-1',
      version: 1,
      structuralHash,
      planSchemaVersion: 2,
      artifact: planArtifact('task-1', 'plan-1', 1, structuralHash),
    });
    state = reduceRuntimeState(state, {
      type: 'plan.review_requested',
      interactionId: 'review-1',
      toolCallId: 'plan-call',
      taskId: 'task-1',
      plan: draft,
      planSummary: 'Plan',
      planId: 'plan-1',
      version: 1,
      structuralDigest: structuralHash,
      artifact: planArtifact('task-1', 'plan-1', 1, structuralHash),
    });
    if (state.interactions.kind !== 'awaiting_review') throw new Error('review missing');
    const approvalEvents = eventsForRuntimeAction(state, {
      type: 'plan_review_decision',
      interactionId: 'review-1',
      planId: state.interactions.planId,
      version: state.interactions.version,
      structuralDigest: state.interactions.structuralDigest,
      decision: { kind: 'approve', nextMode: 'auto' },
    });
    for (const event of approvalEvents) state = reduceRuntimeState(state, event);

    expect(getActivePlanning(state).kind).toBe('executing');
    expect(state.tasks['task-1']?.executionMode).toBe('auto');
    expect(state.mode).toBe('accept_edits');
    expect(getEffectiveInteractionMode(state)).toBe('auto');

    state = reduceRuntimeState(state, {
      type: 'interaction_mode.changed',
      mode: 'full',
      source: 'user',
      changedAt: '2026-08-09T00:00:00.000Z',
    });
    expect(state.mode).toBe('full');
    expect(state.authorization.mode).toBe('full_access');
    expect(state.authorization.modeSource).toBe('user');
    expect(state.authorization.modeGrantedAt).toBe('2026-08-09T00:00:00.000Z');
    expect(state.tasks['task-1']?.executionMode).toBeUndefined();
    expect(getEffectiveInteractionMode(state)).toBe('full');

    state = reduceRuntimeState(state, {
      type: 'interaction_mode.changed',
      mode: 'accept_edits',
      source: 'user',
      changedAt: '2026-08-09T00:01:00.000Z',
    });
    expect(state.mode).toBe('accept_edits');
    expect(state.authorization.mode).toBe('default');
    expect(state.authorization.modeSource).toBeUndefined();
    expect(state.authorization.modeGrantedAt).toBeUndefined();
    expect(getEffectiveInteractionMode(state)).toBe('accept_edits');

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
    expect(state.tasks[state.activeTaskId ?? '']?.taskId).toBe('task-1');
  });
});
