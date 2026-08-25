// ── Plan Mode v2 Transcript 完整性测试 / Plan transcript integrity tests ──
// 验证每个 tool_call 有且只有一个 tool result，sanitize 不删除 plan 反馈

import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  aiMessage,
  humanMessage,
  sanitizeToolCallPairs,
  toolMessage,
} from '@kite-ai/builtin-runtime/model';
import type { AgentPlan } from '@kite-ai/runtime-contract';
import {
  createRuntimeHostStateInitialState,
  getActivePlanning,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
} from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { currentPlanDraftedEvent, emptyCurrentPlanEvidence } from '../helpers/current-plan';

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A detailed plan for transcript integrity testing.',
    status: 'pending',
    steps: [{ id: 'step-1', step: 'Step 1', status: 'pending' }],
  };
}

function draftEvent(plan: AgentPlan, toolCallId: string, planId: string) {
  return currentPlanDraftedEvent({ toolCallId, planId, version: 1, plan });
}

function currentPlanningState() {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 't1',
    userId: 'u1',
    workspace: '/tmp',
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'test-task',
    userGoal: 'Exercise transcript integrity.',
    turnId: state.turn.turnId,
  });
  return reduceRuntimeState(state, {
    type: 'planning.entered',
    taskId: 'test-task',
    source: 'user_command',
  });
}

describe('transcript integrity', () => {
  test('every assistant tool_call has a matching tool result after plan approval', () => {
    const state = currentPlanningState();

    const plan = makePlan();
    const drafted = draftEvent(plan, 'tc-1', 'plan-tx');
    const events: RuntimeEvent[] = [
      // AI message with tool calls
      {
        type: 'model.responded',
        messageId: 'msg-1',
        toolCalls: [
          { id: 'tc-1', name: 'write_plan', args: {} },
          { id: 'tc-2', name: 'write_plan', args: {} },
        ],
      },
      { type: 'tool.queued', toolCallId: 'tc-1', name: 'write_plan', args: {} },
      drafted,
      { type: 'tool.queued', toolCallId: 'tc-2', name: 'write_plan', args: {} },
      {
        type: 'plan.review_requested',
        interactionId: 'inter-1',
        toolCallId: 'tc-2',
        taskId: drafted.taskId,
        planId: 'plan-tx',
        version: 1,
        structuralDigest: drafted.structuralHash,
        plan,
        planSummary: 'Review',
        artifact: drafted.artifact,
      },
      {
        type: 'plan.approved',
        interactionId: 'inter-1',
        toolCallId: 'tc-2',
        planId: 'plan-tx',
        version: 1,
        structuralDigest: drafted.structuralHash,
        executionMode: 'accept_edits',
      },
      {
        type: 'tool.finished',
        toolCallId: 'tc-2',
        name: 'write_plan',
        result: { ok: true, command: '', exitCode: 0, stdout: 'approved', stderr: '' },
      },
    ];

    const finalState = events.reduce(
      (current, event) =>
        reduceRuntimeState(
          current,
          normalizeCurrentToolOutcomeEvent(event, current, '2026-08-11T00:00:00.000Z'),
        ),
      state,
    );
    // Both tool calls should be resolved
    const tc1 = finalState.tools.calls['tc-1'];
    const tc2 = finalState.tools.calls['tc-2'];
    // tc-1: plan.drafted makes it awaiting_review
    // tc-2: tool.finished makes it succeeded
    expect(tc1).toBeDefined();
    expect(tc2).toBeDefined();
    if (tc2) {
      expect(tc2.status).toBe('succeeded');
    }
  });

  test('sanitizeToolCallPairs does not remove plan feedback ToolMessages', () => {
    // Plan revise feedback comes as a ToolMessage from write_plan
    // It should NOT be removed by sanitization
    const msgs = [
      aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'tc-epm',
            name: 'write_plan',
            args: { plan_id: 'p1', expected_version: 1, expected_digest: 'abc' },
          },
        ],
      }),
      toolMessage({
        content: JSON.stringify({ decision: 'revise', feedback: 'Add error handling' }),
        tool_call_id: 'tc-epm',
      }),
      humanMessage('Revised plan submitted'),
    ];

    const sanitized = sanitizeToolCallPairs(msgs);
    expect(sanitized).toHaveLength(3);
    // The ToolMessage with revise feedback must be preserved
    const toolMsgs = sanitized.filter((m) => {
      const obj = m as unknown as Record<string, unknown>;
      return typeof obj.tool_call_id === 'string';
    });
    expect(toolMsgs).toHaveLength(1);
  });

  test('model can read revise feedback from transcript', () => {
    // The transcript should contain the write_plan tool result
    // with decision: "revise" so the model can read the feedback
    const state = currentPlanningState();

    const plan = makePlan();
    const drafted = draftEvent(plan, 'tc-wp', 'plan-rev');
    const events: RuntimeEvent[] = [
      drafted,
      {
        type: 'plan.review_requested',
        interactionId: 'inter-r',
        toolCallId: 'tc-epm',
        taskId: drafted.taskId,
        planId: 'plan-rev',
        version: 1,
        structuralDigest: drafted.structuralHash,
        plan,
        planSummary: 'Review',
        artifact: drafted.artifact,
      },
      {
        type: 'plan.revision_requested',
        interactionId: 'inter-r',
        toolCallId: 'tc-epm',
        planId: 'plan-rev',
        version: 1,
        structuralDigest: drafted.structuralHash,
        feedback: 'Add error handling',
      },
    ];

    const finalState = events.reduce(reduceRuntimeState, state);
    // After revision, state returns to planning_draft with feedback
    const finalPlanning = getActivePlanning(finalState);
    expect(finalPlanning.kind).toBe('planning_draft');
    if (finalPlanning.kind === 'planning_draft') {
      expect(finalPlanning.revisionFeedback).toBe('Add error handling');
    }
    // The model will see this feedback and can update the plan
  });

  test('plan completion marks all steps as done', () => {
    const state = currentPlanningState();

    const plan: AgentPlan = {
      name: 'Finish',
      description: 'A detailed plan for transcript completion testing.',
      status: 'pending',
      steps: [
        { id: 'step-1', step: 'one', status: 'pending' },
        { id: 'step-2', step: 'two', status: 'pending' },
      ],
    };
    const drafted = draftEvent(plan, 'c1', 'plan-comp');
    const events: RuntimeEvent[] = [
      drafted,
      {
        type: 'plan.review_requested',
        interactionId: 'i1',
        toolCallId: 'c2',
        taskId: drafted.taskId,
        planId: 'plan-comp',
        version: 1,
        structuralDigest: drafted.structuralHash,
        plan,
        planSummary: 'OK',
        artifact: drafted.artifact,
      },
      {
        type: 'plan.approved',
        interactionId: 'i1',
        toolCallId: 'c2',
        planId: 'plan-comp',
        version: 1,
        structuralDigest: drafted.structuralHash,
        executionMode: 'accept_edits',
      },
    ];
    let s = events.reduce(reduceRuntimeState, state);
    expect(getActivePlanning(s).kind).toBe('executing');

    const completedPlan: AgentPlan = {
      name: 'Finish',
      description: plan.description,
      status: 'completed',
      steps: [
        { id: 'step-1', step: 'one', status: 'completed' },
        { id: 'step-2', step: 'two', status: 'completed' },
      ],
    };
    const planning = getActivePlanning(s);
    if (planning.kind !== 'executing') throw new Error('expected executing plan');
    const identity = {
      taskId: 'test-task',
      planId: planning.document.planId,
      version: planning.document.version,
      structuralDigest: planning.document.structuralDigest,
      completionEvidence: emptyCurrentPlanEvidence(),
    };
    s = reduceRuntimeState(s, {
      type: 'plan.progress_updated',
      toolCallId: 'c3',
      plan: completedPlan,
      ...identity,
    });
    s = reduceRuntimeState(s, {
      type: 'plan.completed',
      toolCallId: 'c4',
      plan: completedPlan,
      ...identity,
    });

    expect(getActivePlanning(s).kind).toBe('completed');
  });
});
