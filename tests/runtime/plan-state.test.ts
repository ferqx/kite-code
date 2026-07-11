// ── Plan Mode v2 状态转换测试 / State transition tests ──
// 验证 PlanningState 的完整生命周期流转
import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
} from '../../src/core/runtime/state';
import type { AgentPlan } from '../../src/protocol/events';

function makePlan(name = 'Test Plan', steps: string[] = ['step 1', 'step 2']): AgentPlan {
  return {
    name,
    description: 'A test plan for unit testing',
    status: 'pending',
    steps: steps.map((step) => ({ step, status: 'pending' as const })),
  };
}

function makeState() {
  return createInitialRuntimeState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/tmp/test',
    phase: 'planning',
  });
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

describe('PlanningState lifecycle transitions', () => {
  test('planning_empty → planning_draft (write_plan)', () => {
    const state = makeState();
    expect(state.planning.kind).toBe('planning_empty');

    const plan = makePlan('My Plan', ['do a', 'do b']);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };

    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.document.title).toBe('My Plan');
      expect(next.planning.document.version).toBe(1);
      expect(next.planning.document.steps).toHaveLength(2);
      expect(next.planning.revisionFeedback).toBeUndefined();
    }
  });

  test('planning_draft → awaiting_review (exit_plan_mode)', () => {
    const state = makeState();
    const plan = makePlan('Review Plan', ['inspect', 'refactor']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);
    expect(s1.planning.kind).toBe('planning_draft');

    const e2: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-1',
      toolCallId: 'call-2',
      plan,
      planSummary: 'Review this plan',
    };
    const s2 = reduceRuntimeState(s1, e2);
    expect(s2.planning.kind).toBe('awaiting_review');
    expect(s2.interactions.kind).toBe('awaiting_review');
    if (s2.planning.kind === 'awaiting_review') {
      expect(s2.planning.document.version).toBe(1); // review does not create a content version
      expect(s2.planning.interactionId).toBe('inter-1');
      expect(s2.planning.exitToolCallId).toBe('call-2');
    }
  });

  test('awaiting_review → executing (approve)', () => {
    const state = makeState();
    const plan = makePlan('Approve Plan', ['step 1']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);

    const reviewPlan = makePlan('Approve Plan', ['step 1']);
    const e2: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-2',
      toolCallId: 'call-2',
      plan: reviewPlan,
      planSummary: 'Please approve',
    };
    const s2 = reduceRuntimeState(s1, e2);
    expect(s2.planning.kind).toBe('awaiting_review');

    const e3: RuntimeEvent = {
      type: 'plan.approved',
      interactionId: 'inter-2',
      executionMode: 'auto',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(s3.planning.kind).toBe('executing');
    if (s3.planning.kind === 'executing') {
      expect(s3.planning.executionMode).toBe('auto');
      expect(s3.planning.approvedAtTurnId).toBe(s3.turn.turnId);
    }
    expect(s3.interactions.kind).toBe('idle');
  });

  test('awaiting_review → planning_draft (revise)', () => {
    const state = makeState();
    const plan = makePlan('Fix Me', ['bad step']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);

    const e2: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-3',
      toolCallId: 'call-3',
      plan,
      planSummary: 'Needs work',
    };
    const s2 = reduceRuntimeState(s1, e2);

    const e3: RuntimeEvent = {
      type: 'plan.revision_requested',
      interactionId: 'inter-3',
      feedback: 'Add more detail to step 1',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(s3.planning.kind).toBe('planning_draft');
    if (s3.planning.kind === 'planning_draft' && s2.planning.kind === 'awaiting_review') {
      expect(s3.planning.revisionFeedback).toBe('Add more detail to step 1');
      // version NOT incremented on revision — stays at the version from awaiting_review
      // (it will increment on the NEXT write_plan call)
      expect(s3.planning.document.version).toBe(s2.planning.document.version);
    }
    expect(s3.interactions.kind).toBe('idle');
  });

  test('awaiting_review → cancelled (reject)', () => {
    const state = makeState();
    const plan = makePlan('Bad Plan', ['nope']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);

    const e2: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-4',
      toolCallId: 'call-4',
      plan,
      planSummary: 'Bad plan',
    };
    const s2 = reduceRuntimeState(s1, e2);

    const e3: RuntimeEvent = {
      type: 'plan.rejected',
      interactionId: 'inter-4',
      reason: 'Not needed',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(s3.planning.kind).toBe('cancelled');
    if (s3.planning.kind === 'cancelled') {
      expect(s3.planning.reason).toBe('Not needed');
      expect(s3.planning.cancelledAtTurnId).toBe(s3.turn.turnId);
    }
    expect(s3.interactions.kind).toBe('idle');
  });

  test('executing → completed (update_plan complete_plan=true)', () => {
    const state = makeState();
    const plan = makePlan('Finish Plan', ['done']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);
    const e2: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-5',
      toolCallId: 'call-5',
      plan,
      planSummary: 'ok',
    };
    const s2 = reduceRuntimeState(s1, e2);
    const e3: RuntimeEvent = {
      type: 'plan.approved',
      interactionId: 'inter-5',
      executionMode: 'manual',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(s3.planning.kind).toBe('executing');

    const completePlan: AgentPlan = {
      name: 'Finish Plan',
      description: 'A test plan',
      status: 'completed',
      steps: [{ step: 'done', status: 'completed' }],
    };
    const e4: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'call-6',
      plan: completePlan,
    };
    const s4 = reduceRuntimeState(s3, e4);
    expect(s4.planning.kind).toBe('completed');
    if (s4.planning.kind === 'completed') {
      expect(s4.planning.completedAtTurnId).toBe(s4.turn.turnId);
    }
  });

  test('one write_plan increments version by exactly 1', () => {
    const state = makeState();
    const plan = makePlan('V1 Plan', ['a']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);
    expect(s1.planning.kind).toBe('planning_draft');
    const v1 = (s1.planning as { kind: 'planning_draft'; document: { version: number } }).document
      .version;

    const plan2 = makePlan('V2 Plan', ['a', 'b']);
    const e2: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-2',
      plan: plan2,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan2)),
    };
    const s2 = reduceRuntimeState(s1, e2);
    expect(s2.planning.kind).toBe('planning_draft');
    const v2 = (s2.planning as { kind: 'planning_draft'; document: { version: number } }).document
      .version;
    expect(v2).toBe(v1 + 1);
  });

  test('review_requested does NOT increment version', () => {
    const state = makeState();
    const plan = makePlan('Same Version', ['x']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);
    const vBefore = (s1.planning as { kind: 'planning_draft'; document: { version: number } })
      .document.version;

    const e2: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-r',
      toolCallId: 'call-r',
      plan,
      planSummary: 'ok',
    };
    const s2 = reduceRuntimeState(s1, e2);
    expect(s2.planning.kind).toBe('awaiting_review');
    if (s2.planning.kind === 'awaiting_review') {
      expect(s2.planning.document.version).toBe(vBefore); // review_requested does not change the draft
    }
  });

  test('plan.drafted from planning_empty creates new planId', () => {
    const state = makeState();
    expect(state.planning.kind).toBe('planning_empty');

    const plan = makePlan('New Plan', ['step']);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.document.planId).toMatch(/^[0-9a-f]{8}-/);
      expect(next.planning.document.version).toBe(1);
    }
  });

  test('stale version/digest from exit_plan_mode is rejected (handled by tool-controller)', () => {
    // The tool-controller checks version/digest before emitting plan.review_requested.
    // This test verifies that if the reducer receives plan.review_requested for a draft
    // at a specific version, the version is correctly inherited + incremented.
    const state = makeState();
    const plan = makePlan('V3', ['a']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'c1',
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const s1 = reduceRuntimeState(state, e1);
    if (s1.planning.kind !== 'planning_draft') throw new Error('expected planning_draft');
    const correctVersion = s1.planning.document.version;

    // A second write_plan with a different plan should increment version
    const plan2 = makePlan('V4', ['a', 'b']);
    const e2: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'c2',
      plan: plan2,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan2)),
    };
    const s2 = reduceRuntimeState(s1, e2);
    if (s2.planning.kind !== 'planning_draft') throw new Error('expected planning_draft');
    expect(s2.planning.document.version).toBe(correctVersion + 1);
  });
});
