// ── Plan Mode v2 审批行为测试 / Plan approval action tests ──
// 验证 plan_review_decision 的 approve/revise/cancel 事件生成
import { describe, expect, test } from 'bun:test';
import { eventsForRuntimeAction, type RuntimeUserAction } from '../../src/core/runtime/actions';
import { createInitialRuntimeState } from '../../src/core/runtime/state';
import type { AgentPlan } from '../../src/protocol/events';

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A test plan.',
    status: 'pending',
    steps: [{ step: 'Step 1', status: 'pending' }],
  };
}

function makeAwaitingReviewState() {
  const base = createInitialRuntimeState({
    threadId: 't1',
    userId: 'u1',
    workspace: '/tmp',
    phase: 'planning',
  });
  const plan = makePlan();
  return {
    ...base,
    planning: {
      kind: 'awaiting_review' as const,
      document: {
        planId: 'plan-99',
        version: 2,
        title: 'Test Plan',
        bodyMarkdown: 'A test plan for approval.',
        steps: [{ id: 's1', title: 'Step 1', status: 'pending' as const }],
        structuralDigest: 'test-digest-abc123',
        createdAtTurnId: 'turn-0',
        updatedAtTurnId: 'turn-0',
      },
      interactionId: 'inter-99',
      exitToolCallId: 'call-99',
    },
    interactions: {
      kind: 'awaiting_review' as const,
      interactionId: 'inter-99',
      toolCallId: 'call-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      plan,
      planSummary: 'Please approve this plan',
    },
  };
}

describe('plan_review_decision actions', () => {
  test('approve auto → mode auto + plan.approved + tool.finished', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('plan.approved');
    expect(eventTypes).toContain('tool.finished');

    const approved = events.find((e) => e.type === 'plan.approved');
    expect(approved).toBeDefined();
    if (approved && approved.type === 'plan.approved') {
      expect(approved.executionMode).toBe('auto');
    }

    const finished = events.find((e) => e.type === 'tool.finished');
    expect(finished).toBeDefined();
    if (finished && finished.type === 'tool.finished') {
      expect(finished.name).toBe('write_plan');
      expect(finished.result.ok).toBe(true);
    }
  });

  test('approve accept_edits → mode accept_edits', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: true },
    };

    const events = eventsForRuntimeAction(state, action);
    const approved = events.find((e) => e.type === 'plan.approved');
    expect(approved).toBeDefined();
    if (approved && approved.type === 'plan.approved') {
      expect(approved.executionMode).toBe('accept_edits');
    }
  });

  test('approve manual → mode accept_edits', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    const approved = events.find((e) => e.type === 'plan.approved');
    expect(approved).toBeDefined();
    if (approved && approved.type === 'plan.approved') {
      expect(approved.executionMode).toBe('accept_edits');
    }
  });

  test('approve does NOT grant full_access', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    // No authorization.changed event for plan approvals
    const authEvents = events.filter((e) => e.type === 'authorization.changed');
    expect(authEvents).toHaveLength(0);
  });

  test('revise → plan.revision_requested + tool.finished with feedback', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'revise', feedback: 'Please add error handling' },
    };

    const events = eventsForRuntimeAction(state, action);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('plan.revision_requested');

    const revision = events.find((e) => e.type === 'plan.revision_requested');
    expect(revision).toBeDefined();
    if (revision && revision.type === 'plan.revision_requested') {
      expect(revision.feedback).toBe('Please add error handling');
    }
  });

  test('cancel → plan.review_cancelled + tool.finished with reason', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'cancel', reason: 'Not needed' },
    };

    const events = eventsForRuntimeAction(state, action);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('plan.review_cancelled');
    expect(eventTypes).toContain('tool.finished');

    const cancelled = events.find((e) => e.type === 'plan.review_cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled && cancelled.type === 'plan.review_cancelled') {
      expect(cancelled.reason).toBe('Not needed');
    }

    const finished = events.find((e) => e.type === 'tool.finished');
    expect(finished).toBeDefined();
    if (finished && finished.type === 'tool.finished') {
      expect(finished.name).toBe('write_plan');
      expect(finished.result.ok).toBe(true);
      expect(finished.result.stdout).toContain('review_cancelled');
    }
  });

  test('generic cancel from Esc → plan.review_cancelled + tool.finished', () => {
    const state = makeAwaitingReviewState();
    const events = eventsForRuntimeAction(state, {
      type: 'cancel',
      interactionId: 'inter-99',
      reason: 'Cancelled with Esc.',
    });

    expect(events.map((event) => event.type)).toEqual(['plan.review_cancelled', 'tool.finished']);
    expect(events[0]).toMatchObject({
      type: 'plan.review_cancelled',
      reason: 'Cancelled with Esc.',
    });
  });

  test('wrong interactionId → no events', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'wrong-id',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    expect(events).toHaveLength(0);
  });

  test('wrong planId → no events', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'wrong-plan',
      version: 2,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    expect(events).toHaveLength(0);
  });

  test('wrong version → no events', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 999,
      structuralDigest: 'test-digest-abc123',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    expect(events).toHaveLength(0);
  });

  test('wrong digest → no events', () => {
    const state = makeAwaitingReviewState();
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'inter-99',
      planId: 'plan-99',
      version: 2,
      structuralDigest: 'wrong-digest',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    expect(events).toHaveLength(0);
  });

  test('idle interaction → no events for any action type', () => {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
    });
    const action: RuntimeUserAction = {
      type: 'plan_review_decision',
      interactionId: 'any',
      planId: 'any',
      version: 1,
      structuralDigest: 'any',
      decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
    };

    const events = eventsForRuntimeAction(state, action);
    expect(events).toHaveLength(0);
  });
});
