// ── Plan Mode v2 状态转换测试 / State transition tests ──
// 验证 PlanningState 的完整生命周期流转
import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  getActivePlanning,
  type RuntimeState,
} from '../../src/core/runtime/state';
import type { AgentPlan, PlanDocument, PlanningState } from '../../src/protocol/events';
import { currentPlanDraftedEvent } from '../helpers/current-plan';

type PlanningTestView = {
  kind: PlanningState['kind'];
  document: PlanDocument & { artifact: NonNullable<PlanDocument['artifact']> };
  revisionFeedback: string | undefined;
  interactionId: string;
  exitToolCallId: string;
  executionMode: 'auto' | 'accept_edits';
  approvedAtTurnId: string;
  completedAtTurnId: string;
};

function planning(state: RuntimeState): PlanningTestView {
  return getActivePlanning(state) as PlanningTestView;
}

function makePlan(name = 'Test Plan', steps: string[] = ['step 1', 'step 2']): AgentPlan {
  return {
    name,
    description: 'A test plan for unit testing',
    status: 'pending',
    steps: steps.map((step, index) => ({
      id: `step-${index + 1}`,
      step,
      status: 'pending' as const,
    })),
  };
}

function makeState() {
  let state = createInitialRuntimeState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/tmp/test',
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'task-1',
    userGoal: 'Exercise the current Plan lifecycle.',
    turnId: state.turn.turnId,
  });
  return reduceRuntimeState(state, {
    type: 'planning.entered',
    taskId: 'task-1',
    source: 'user_command',
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

function draftEvent(
  plan: AgentPlan,
  toolCallId: string,
  planId: string,
  version: number,
): Extract<RuntimeEvent, { type: 'plan.drafted' }> {
  return currentPlanDraftedEvent({
    toolCallId,
    planId,
    version,
    plan,
    taskId: 'task-1',
  });
}

function reviewEvent(
  state: RuntimeState,
  plan: AgentPlan,
  interactionId: string,
  toolCallId: string,
): Extract<RuntimeEvent, { type: 'plan.review_requested' }> {
  if (planning(state).kind !== 'planning_draft' || !planning(state).document.artifact) {
    throw new Error('Expected a current saved Plan draft');
  }
  return {
    type: 'plan.review_requested',
    interactionId,
    toolCallId,
    taskId: 'task-1',
    plan,
    planSummary: 'Review the current Plan.',
    planId: planning(state).document.planId,
    version: planning(state).document.version,
    structuralDigest: planning(state).document.structuralDigest,
    artifact: planning(state).document.artifact,
  };
}

describe('PlanningState lifecycle transitions', () => {
  test('planning_empty → planning_draft (write_plan)', () => {
    const state = makeState();
    expect(planning(state).kind).toBe('planning_empty');

    const plan = makePlan('My Plan', ['do a', 'do b']);
    const event = draftEvent(plan, 'call-1', 'plan-test', 1);

    const next = reduceRuntimeState(state, event);
    expect(planning(next).kind).toBe('planning_draft');
    if (planning(next).kind === 'planning_draft') {
      expect(planning(next).document.title).toBe('My Plan');
      expect(planning(next).document.version).toBe(1);
      expect(planning(next).document.steps).toHaveLength(2);
      expect(planning(next).revisionFeedback).toBeUndefined();
    }
  });

  test('planning_draft → awaiting_review (write_plan)', () => {
    const state = makeState();
    const plan = makePlan('Review Plan', ['inspect', 'refactor']);
    const e1 = draftEvent(plan, 'call-1', 'plan-test', 1);
    const s1 = reduceRuntimeState(state, e1);
    expect(planning(s1).kind).toBe('planning_draft');

    const e2 = reviewEvent(s1, plan, 'inter-1', 'call-2');
    const s2 = reduceRuntimeState(s1, e2);
    expect(planning(s2).kind).toBe('awaiting_review');
    expect(s2.interactions.kind).toBe('awaiting_review');
    if (planning(s2).kind === 'awaiting_review') {
      expect(planning(s2).document.version).toBe(1); // review does not create a content version
      expect(planning(s2).interactionId).toBe('inter-1');
      expect(planning(s2).exitToolCallId).toBe('call-2');
    }
  });

  test('awaiting_review → executing (approve)', () => {
    const state = makeState();
    const plan = makePlan('Approve Plan', ['step 1']);
    const e1 = draftEvent(plan, 'call-1', 'plan-test', 1);
    const s1 = reduceRuntimeState(state, e1);

    const reviewPlan = makePlan('Approve Plan', ['step 1']);
    const e2 = reviewEvent(s1, reviewPlan, 'inter-2', 'call-2');
    const s2 = reduceRuntimeState(s1, e2);
    expect(planning(s2).kind).toBe('awaiting_review');

    const e3: RuntimeEvent = {
      type: 'plan.approved',
      ...reviewIdentity(s2),
      executionMode: 'auto',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(planning(s3).kind).toBe('executing');
    if (planning(s3).kind === 'executing') {
      expect(planning(s3).executionMode).toBe('auto');
      expect(planning(s3).approvedAtTurnId).toBe(s3.turn.turnId);
    }
    expect(s3.interactions.kind).toBe('idle');
  });

  test('awaiting_review → planning_draft (revise)', () => {
    const state = makeState();
    const plan = makePlan('Fix Me', ['bad step']);
    const e1 = draftEvent(plan, 'call-1', 'plan-test', 1);
    const s1 = reduceRuntimeState(state, e1);

    const e2 = reviewEvent(s1, plan, 'inter-3', 'call-3');
    const s2 = reduceRuntimeState(s1, e2);

    const e3: RuntimeEvent = {
      type: 'plan.revision_requested',
      ...reviewIdentity(s2),
      feedback: 'Add more detail to step 1',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(planning(s3).kind).toBe('planning_draft');
    if (planning(s3).kind === 'planning_draft' && planning(s2).kind === 'awaiting_review') {
      expect(planning(s3).revisionFeedback).toBe('Add more detail to step 1');
      // version NOT incremented on revision — stays at the version from awaiting_review
      // (it will increment on the NEXT write_plan call)
      expect(planning(s3).document.version).toBe(planning(s2).document.version);
    }
    expect(s3.interactions.kind).toBe('idle');
  });

  test('executing → completed (update_plan complete_plan=true)', () => {
    const state = makeState();
    const plan = makePlan('Finish Plan', ['done']);
    const e1 = draftEvent(plan, 'call-1', 'plan-test', 1);
    const s1 = reduceRuntimeState(state, e1);
    const e2 = reviewEvent(s1, plan, 'inter-5', 'call-5');
    const s2 = reduceRuntimeState(s1, e2);
    const e3: RuntimeEvent = {
      type: 'plan.approved',
      ...reviewIdentity(s2),
      executionMode: 'accept_edits',
    };
    const s3 = reduceRuntimeState(s2, e3);
    expect(planning(s3).kind).toBe('executing');

    const completePlan: AgentPlan = {
      name: 'Finish Plan',
      description: plan.description,
      status: 'completed',
      steps: [{ id: 'step-1', step: 'done', status: 'completed' }],
    };
    if (planning(s3).kind !== 'executing') throw new Error('expected executing plan');
    const e4: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'call-6',
      taskId: 'task-1',
      plan: completePlan,
      planId: planning(s3).document.planId,
      version: planning(s3).document.version,
      structuralDigest: planning(s3).document.structuralDigest,
      completionEvidence: planning(s3).document.completionEvidence,
    };
    const s4 = reduceRuntimeState(s3, e4);
    expect(planning(s4).kind).toBe('completed');
    if (planning(s4).kind === 'completed') {
      expect(planning(s4).completedAtTurnId).toBe(s4.turn.turnId);
    }
  });

  test('one write_plan increments version by exactly 1', () => {
    const state = makeState();
    const plan = makePlan('V1 Plan', ['a']);
    const e1 = draftEvent(plan, 'call-1', 'plan-v', 1);
    const s1 = reduceRuntimeState(state, e1);
    expect(planning(s1).kind).toBe('planning_draft');
    const v1 = (planning(s1) as { kind: 'planning_draft'; document: { version: number } }).document
      .version;

    const plan2 = makePlan('V2 Plan', ['a', 'b']);
    const e2 = draftEvent(plan2, 'call-2', 'plan-v', 2);
    const s2 = reduceRuntimeState(s1, e2);
    expect(planning(s2).kind).toBe('planning_draft');
    const v2 = (planning(s2) as { kind: 'planning_draft'; document: { version: number } }).document
      .version;
    expect(v2).toBe(v1 + 1);
  });

  test('review_requested does NOT increment version', () => {
    const state = makeState();
    const plan = makePlan('Same Version', ['x']);
    const e1 = draftEvent(plan, 'call-1', 'plan-sv', 1);
    const s1 = reduceRuntimeState(state, e1);
    const vBefore = (planning(s1) as { kind: 'planning_draft'; document: { version: number } })
      .document.version;

    const e2 = reviewEvent(s1, plan, 'inter-r', 'call-r');
    const s2 = reduceRuntimeState(s1, e2);
    expect(planning(s2).kind).toBe('awaiting_review');
    if (planning(s2).kind === 'awaiting_review') {
      expect(planning(s2).document.version).toBe(vBefore); // review_requested does not change the draft
    }
  });

  test('plan.drafted uses event planId and version from the tool-controller', () => {
    const state = makeState();
    expect(planning(state).kind).toBe('planning_empty');

    const plan = makePlan('New Plan', ['step']);
    const event = draftEvent(plan, 'call-1', 'plan-from-controller', 1);
    const next = reduceRuntimeState(state, event);
    expect(planning(next).kind).toBe('planning_draft');
    if (planning(next).kind === 'planning_draft') {
      expect(planning(next).document.planId).toBe('plan-from-controller');
      expect(planning(next).document.version).toBe(1);
    }
  });

  test('stale version/digest from write_plan is rejected (handled by tool-controller)', () => {
    // The tool-controller checks version/digest before emitting plan.review_requested.
    // This test verifies that if the reducer receives plan.review_requested for a draft
    // at a specific version, the version is correctly inherited from the event.
    const state = makeState();
    const plan = makePlan('V3', ['a']);
    const e1 = draftEvent(plan, 'c1', 'plan-stale', 1);
    const s1 = reduceRuntimeState(state, e1);
    if (planning(s1).kind !== 'planning_draft') throw new Error('expected planning_draft');
    const correctVersion = planning(s1).document.version;

    // A second write_plan with a different plan should increment version
    const plan2 = makePlan('V4', ['a', 'b']);
    const e2 = draftEvent(plan2, 'c2', 'plan-stale', 2);
    const s2 = reduceRuntimeState(s1, e2);
    if (planning(s2).kind !== 'planning_draft') throw new Error('expected planning_draft');
    expect(planning(s2).document.version).toBe(correctVersion + 1);
  });

  test('V2 progress events require matching identity and Runtime-derived evidence', () => {
    const state = makeState();
    const plan = makePlan('Evidence Plan', ['execute']);
    plan.steps[0]!.id = 'step-1';
    const structuralHash = computePlanStructuralDigest(makeDigestInput(plan));
    const drafted = reduceRuntimeState(state, {
      type: 'plan.drafted',
      toolCallId: 'draft',
      taskId: 'task-1',
      planId: 'plan-evidence',
      version: 1,
      plan,
      structuralHash,
      planSchemaVersion: 2,
      artifact: {
        artifactId: 'plan-evidence:v1',
        taskId: 'task-1',
        planId: 'plan-evidence',
        version: 1,
        fileName: 'v1.md',
        relativePath: 'plans/task-1/plan-evidence/v1.md',
        displayPath: '/plans/task-1/plan-evidence/v1.md',
        structuralDigest: structuralHash,
        byteLength: 100,
      },
    });
    const reviewed = reduceRuntimeState(drafted, {
      type: 'plan.review_requested',
      interactionId: 'review-evidence',
      toolCallId: 'submit-evidence',
      taskId: 'task-1',
      plan,
      planSummary: 'Evidence plan',
      planId: 'plan-evidence',
      version: 1,
      structuralDigest:
        planning(drafted).kind === 'planning_draft'
          ? planning(drafted).document.structuralDigest
          : '',
      artifact:
        planning(drafted).kind === 'planning_draft' && planning(drafted).document.artifact
          ? planning(drafted).document.artifact
          : (() => {
              throw new Error('expected Plan Artifact');
            })(),
    });
    const executing = reduceRuntimeState(reviewed, {
      type: 'plan.approved',
      ...reviewIdentity(reviewed),
      executionMode: 'auto',
    });
    if (planning(executing).kind !== 'executing') throw new Error('expected executing plan');

    const forged = reduceRuntimeState(executing, {
      type: 'plan.progress_updated',
      toolCallId: 'update',
      taskId: 'task-1',
      planId: planning(executing).document.planId,
      version: planning(executing).document.version,
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
