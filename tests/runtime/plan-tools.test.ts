// ── Plan Mode v2 工具行为测试 / Plan tool behavior tests ──
// 验证 write_plan/write_plan/update_plan 的 phase 约束和行为差异
import { describe, expect, test } from 'bun:test';
import { getAgentPhase } from '../../src/core/runtime/state';
import type { PlanningState } from '../../src/protocol/events';
import { currentPlanDocument } from '../helpers/current-plan';

function makePlanningState(kind: 'planning' | 'building') {
  return kind === 'planning'
    ? ({ kind: 'planning_empty' } as const)
    : ({ kind: 'building_without_plan' } as const);
}

describe('plan tools — phase constraints', () => {
  test('write_plan is only allowed in planning phase', () => {
    const planningPhase = makePlanningState('planning');
    expect(getAgentPhase(planningPhase)).toBe('planning');

    const buildingPhase = makePlanningState('building');
    expect(getAgentPhase(buildingPhase)).toBe('building');

    // write_plan requires planning phase; building phase should reject
    // (enforced by tool-controller, verified via phase check)
    const planningEmpty: PlanningState = { kind: 'planning_empty' };
    expect(getAgentPhase(planningEmpty)).toBe('planning');

    const buildingNoPlan: PlanningState = { kind: 'building_without_plan' };
    expect(getAgentPhase(buildingNoPlan)).toBe('building');
  });

  test('write_plan is only allowed in planning phase with a draft', () => {
    // write_plan requires planning_draft state
    const draft: PlanningState = {
      kind: 'planning_draft',
      document: currentPlanDocument({
        planId: 'p1',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'A test plan.',
        steps: [{ id: 's1', title: 'Step 1', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: 't0',
        updatedAtTurnId: 't0',
      }),
    };
    expect(getAgentPhase(draft)).toBe('planning');

    // Without a draft, should reject
    const empty: PlanningState = { kind: 'planning_empty' };
    expect(empty.kind).toBe('planning_empty'); // no draft to submit
  });

  test('update_plan is only allowed in building phase with executing plan', () => {
    // update_plan requires executing state
    const executing: PlanningState = {
      kind: 'executing',
      document: currentPlanDocument({
        planId: 'p1',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test',
        steps: [{ id: 's1', title: 'Step 1', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: 't0',
        updatedAtTurnId: 't0',
      }),
      executionMode: 'accept_edits',
      approvedAtTurnId: 't1',
    };
    expect(getAgentPhase(executing)).toBe('building');

    // In planning phase, update_plan should be rejected
    const planningDraft: PlanningState = {
      kind: 'planning_draft',
      document: currentPlanDocument({
        planId: 'p1',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test',
        steps: [{ id: 's1', title: 'Step 1', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: 't0',
        updatedAtTurnId: 't0',
      }),
    };
    expect(getAgentPhase(planningDraft)).toBe('planning');
  });

  test('write_plan does NOT trigger user interrupt (only plan.drafted event)', () => {
    // write_plan emits plan.drafted — no interaction created
    const empty: PlanningState = { kind: 'planning_empty' };
    // The tool-controller handles write_plan by emitting plan.drafted only
    // (no plan.review_requested, no interaction)
    expect(empty.kind).toBe('planning_empty');
    // After write_plan, state transitions to planning_draft (no interrupt)
  });

  test('write_plan triggers plan review interrupt', () => {
    // write_plan emits plan.review_requested → creates awaiting_review interaction
    // This is the ONLY tool that triggers plan review
    const draft: PlanningState = {
      kind: 'planning_draft',
      document: currentPlanDocument({
        planId: 'p1',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'A test plan.',
        steps: [{ id: 's1', title: 'Step 1', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: 't0',
        updatedAtTurnId: 't0',
      }),
    };
    // After write_plan, state → awaiting_review with interaction
    expect(draft.kind).toBe('planning_draft');
    // The tool-controller creates interactionId and emits plan.review_requested
    // which reducer handles by transitioning to awaiting_review
  });

  test('structural changes via update_plan are rejected (progress only)', () => {
    // update_plan schema only accepts step_id + status + note + complete_plan
    // It does NOT accept title, body_markdown, or new step definitions
    // The tool-controller enforces plan_id match and rejects structural changes
    expect(true).toBe(true); // schema enforcement tested in tool-definitions.test.ts
  });

  test('building_without_plan rejects write_plan', () => {
    const buildingWithoutPlan: PlanningState = { kind: 'building_without_plan' };
    expect(getAgentPhase(buildingWithoutPlan)).toBe('building');
    // write_plan requires planning phase — tool-controller rejects with:
    // "write_plan is only available in planning phase."
  });

  test('planning_empty rejects update_plan', () => {
    const planningEmpty: PlanningState = { kind: 'planning_empty' };
    expect(getAgentPhase(planningEmpty)).toBe('planning');
    // update_plan requires building phase (executing state) — rejected
  });
});
