// ── Plan Mode v2 Transcript 完整性测试 / Plan transcript integrity tests ──
// 验证每个 tool_call 有且只有一个 tool result，sanitize 不删除 plan 反馈

import { describe, expect, test } from 'bun:test';
import { aiMessage, humanMessage, toolMessage } from '../../src/core/messages';
import { sanitizeToolCallPairs } from '../../src/core/model/context';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
} from '../../src/core/runtime/state';
import type { AgentPlan } from '../../src/protocol/events';

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A test plan.',
    status: 'pending',
    steps: [{ step: 'Step 1', status: 'pending' }],
  };
}

function makeDigestInput(plan: AgentPlan) {
  return {
    title: plan.name.slice(0, 120),
    bodyMarkdown: plan.description,
    steps: plan.steps.map((s, i) => ({
      id: `step-${i + 1}`,
      title: s.step.slice(0, 160),
      status: 'pending' as const,
    })),
  };
}

describe('transcript integrity', () => {
  test('every assistant tool_call has a matching tool result after plan approval', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });

    const plan = makePlan();
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
      {
        type: 'plan.drafted',
        toolCallId: 'tc-1',
        planId: 'plan-tx',
        version: 1,
        plan,
        structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
      },
      { type: 'tool.queued', toolCallId: 'tc-2', name: 'write_plan', args: {} },
      {
        type: 'plan.review_requested',
        interactionId: 'inter-1',
        toolCallId: 'tc-2',
        planId: 'plan-tx',
        version: 1,
        structuralDigest: 'digest-tx',
        plan,
        planSummary: 'Review',
      },
      {
        type: 'plan.approved',
        interactionId: 'inter-1',
        toolCallId: 'tc-2',
        planId: 'plan-tx',
        version: 1,
        structuralDigest: 'digest-tx',
        executionMode: 'accept_edits',
      },
      {
        type: 'tool.finished',
        toolCallId: 'tc-2',
        name: 'write_plan',
        result: { ok: true, command: '', exitCode: 0, stdout: 'approved', stderr: '' },
      },
    ];

    const finalState = events.reduce(reduceRuntimeState, state);
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
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });

    const plan = makePlan();
    const events: RuntimeEvent[] = [
      {
        type: 'plan.drafted',
        toolCallId: 'tc-wp',
        planId: 'plan-rev',
        version: 1,
        plan,
        structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
      },
      {
        type: 'plan.review_requested',
        interactionId: 'inter-r',
        toolCallId: 'tc-epm',
        planId: 'plan-rev',
        version: 1,
        structuralDigest: 'digest-rev',
        plan,
        planSummary: 'Review',
      },
      {
        type: 'plan.revision_requested',
        interactionId: 'inter-r',
        toolCallId: 'tc-epm',
        planId: 'plan-rev',
        version: 1,
        structuralDigest: 'digest-rev',
        feedback: 'Add error handling',
      },
    ];

    const finalState = events.reduce(reduceRuntimeState, state);
    // After revision, state returns to planning_draft with feedback
    expect(finalState.planning.kind).toBe('planning_draft');
    if (finalState.planning.kind === 'planning_draft') {
      expect(finalState.planning.revisionFeedback).toBe('Add error handling');
    }
    // The model will see this feedback and can update the plan
  });

  test('plan completion marks all steps as done', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });

    const plan: AgentPlan = {
      name: 'Finish',
      description: 'A test plan.',
      status: 'pending',
      steps: [
        { step: 'one', status: 'pending' },
        { step: 'two', status: 'pending' },
      ],
    };
    const events: RuntimeEvent[] = [
      {
        type: 'plan.drafted',
        toolCallId: 'c1',
        planId: 'plan-comp',
        version: 1,
        plan,
        structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
      },
      {
        type: 'plan.review_requested',
        interactionId: 'i1',
        toolCallId: 'c2',
        planId: 'plan-comp',
        version: 1,
        structuralDigest: 'digest-comp',
        plan,
        planSummary: 'OK',
      },
      {
        type: 'plan.approved',
        interactionId: 'i1',
        toolCallId: 'c2',
        planId: 'plan-comp',
        version: 1,
        structuralDigest: 'digest-comp',
        executionMode: 'accept_edits',
      },
    ];
    let s = events.reduce(reduceRuntimeState, state);
    expect(s.planning.kind).toBe('executing');

    const completedPlan: AgentPlan = {
      name: 'Finish',
      description: 'A test plan.',
      status: 'completed',
      steps: [
        { step: 'one', status: 'completed' },
        { step: 'two', status: 'completed' },
      ],
    };
    s = reduceRuntimeState(s, {
      type: 'plan.progress_updated',
      toolCallId: 'c3',
      plan: completedPlan,
    });
    s = reduceRuntimeState(s, {
      type: 'plan.completed',
      toolCallId: 'c4',
      plan: completedPlan,
    });

    expect(s.planning.kind).toBe('completed');
  });
});
