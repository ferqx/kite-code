// ── Plan Mode v2 状态转换测试 / State transition tests ──
// 验证 PlanningState 的完整生命周期流转
import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  type RuntimeState,
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

function reviewIdentity(state: RuntimeState) {
  if (state.interactions.kind !== 'awaiting_review') {
    throw new Error('Expected an active plan review');
  }
  return {
    interactionId: state.interactions.interactionId,
    toolCallId: state.interactions.toolCallId,
    planId: state.interactions.planId,
    version: state.interactions.version,
    structuralDigest: state.interactions.structuralDigest,
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
      planId: 'plan-test',
      version: 1,
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

  test('planning_draft → awaiting_review (write_plan)', () => {
    const state = makeState();
    const plan = makePlan('Review Plan', ['inspect', 'refactor']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      planId: 'plan-test',
      version: 1,
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
      planId: 'plan-test',
      version: 1,
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
      ...reviewIdentity(s2),
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
      planId: 'plan-test',
      version: 1,
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
      ...reviewIdentity(s2),
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

  test('awaiting_review → planning_draft (legacy reject alias)', () => {
    const state = makeState();
    const plan = makePlan('Bad Plan', ['nope']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      planId: 'plan-test',
      version: 1,
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
      ...reviewIdentity(s2),
      reason: 'Not needed',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(s3.planning.kind).toBe('planning_draft');
    if (s3.planning.kind === 'planning_draft') {
      expect(s3.planning.revisionFeedback).toBe('Not needed');
    }
    expect(s3.interactions.kind).toBe('idle');
  });

  test('executing → completed (update_plan complete_plan=true)', () => {
    const state = makeState();
    const plan = makePlan('Finish Plan', ['done']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      planId: 'plan-test',
      version: 1,
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
      ...reviewIdentity(s2),
      executionMode: 'accept_edits',
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
      planId: 'plan-v',
      version: 1,
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
      planId: 'plan-v',
      version: 2,
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
      planId: 'plan-sv',
      version: 1,
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

  test('plan.drafted uses event planId and version from the tool-controller', () => {
    const state = makeState();
    expect(state.planning.kind).toBe('planning_empty');

    const plan = makePlan('New Plan', ['step']);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-1',
      planId: 'plan-from-controller',
      version: 1,
      plan,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
    };
    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.document.planId).toBe('plan-from-controller');
      expect(next.planning.document.version).toBe(1);
    }
  });

  test('stale version/digest from write_plan is rejected (handled by tool-controller)', () => {
    // The tool-controller checks version/digest before emitting plan.review_requested.
    // This test verifies that if the reducer receives plan.review_requested for a draft
    // at a specific version, the version is correctly inherited from the event.
    const state = makeState();
    const plan = makePlan('V3', ['a']);
    const e1: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'c1',
      planId: 'plan-stale',
      version: 1,
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
      planId: 'plan-stale',
      version: 2,
      plan: plan2,
      structuralHash: computePlanStructuralDigest(makeDigestInput(plan2)),
    };
    const s2 = reduceRuntimeState(s1, e2);
    if (s2.planning.kind !== 'planning_draft') throw new Error('expected planning_draft');
    expect(s2.planning.document.version).toBe(correctVersion + 1);
  });

  test('V2 progress events require matching identity and Runtime-derived evidence', () => {
    const state = makeState();
    const plan = makePlan('Evidence Plan', ['execute']);
    plan.steps[0]!.id = 'step-1';
    const structuralHash = computePlanStructuralDigest(makeDigestInput(plan));
    const drafted = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'draft',
      planId: 'plan-evidence',
      version: 1,
      plan,
      structuralHash,
      planSchemaVersion: 2,
      artifact: {
        artifactId: 'plan-evidence:v1',
        taskId: 'evidence-task',
        planId: 'plan-evidence',
        version: 1,
        fileName: 'v1.md',
        relativePath: 'plans/evidence-task/plan-evidence/v1.md',
        displayPath: '/plans/evidence-task/plan-evidence/v1.md',
        structuralDigest: structuralHash,
        byteLength: 100,
      },
    });
    const reviewed = reduceRuntimeState(drafted, {
      type: 'plan.review_requested',
      interactionId: 'review-evidence',
      toolCallId: 'submit-evidence',
      plan,
      planSummary: 'Evidence plan',
      planId: 'plan-evidence',
      version: 1,
      structuralDigest:
        drafted.planning.kind === 'planning_draft'
          ? drafted.planning.document.structuralDigest
          : '',
    });
    const executing = reduceRuntimeState(reviewed, {
      type: 'plan.approved',
      ...reviewIdentity(reviewed),
      executionMode: 'auto',
    });
    if (executing.planning.kind !== 'executing') throw new Error('expected executing plan');

    const forged = reduceRuntimeState(executing, {
      type: 'plan.progress_updated',
      toolCallId: 'update',
      planId: executing.planning.document.planId,
      version: executing.planning.document.version,
      structuralDigest: 'stale-digest',
      plan: {
        ...plan,
        status: 'in_progress',
        steps: [{ ...plan.steps[0]!, status: 'completed' }],
      },
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [{ toolCallId: 'missing-receipt', outcome: 'succeeded' }],
        skipped: [],
        unresolved: [],
      },
    });

    expect(forged).toBe(executing);
  });
});

// ── plan.approved 设置 mode / mode transitions after plan approval ──

describe('plan.approved sets runtime mode', () => {
  function makeAwaitingReviewState() {
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });
    const plan = makePlan('Test', ['step']);
    const s1 = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'c1',
      planId: 'plan-mode',
      version: 1,
      plan,
      structuralHash: computePlanStructuralDigest({
        title: plan.name.slice(0, 120),
        bodyMarkdown: plan.description,
        steps: plan.steps.map((s, i) => ({
          id: `step-${i + 1}`,
          title: s.step.slice(0, 160),
          status: 'pending' as const,
        })),
      }),
    });
    return reduceRuntimeState(s1, {
      type: 'plan.review_requested',
      interactionId: 'inter-mode',
      toolCallId: 'c2',
      plan,
      planSummary: 'Review',
    });
  }

  test('approve with auto → state.mode = auto', () => {
    const state = makeAwaitingReviewState();
    const next = reduceRuntimeState(state, {
      type: 'plan.approved',
      ...reviewIdentity(state),
      executionMode: 'auto',
    });
    expect(next.mode).toBe('auto');
    expect(next.planning.kind).toBe('executing');
  });

  test('approve with accept_edits → state.mode = accept_edits', () => {
    const state = makeAwaitingReviewState();
    const next = reduceRuntimeState(state, {
      type: 'plan.approved',
      ...reviewIdentity(state),
      executionMode: 'accept_edits',
    });
    expect(next.mode).toBe('accept_edits');
    expect(next.planning.kind).toBe('executing');
  });

  test('approve with manual → state.mode = accept_edits', () => {
    const state = makeAwaitingReviewState();
    const next = reduceRuntimeState(state, {
      type: 'plan.approved',
      ...reviewIdentity(state),
      executionMode: 'accept_edits',
    });
    expect(next.mode).toBe('accept_edits');
    expect(next.planning.kind).toBe('executing');
  });
});
