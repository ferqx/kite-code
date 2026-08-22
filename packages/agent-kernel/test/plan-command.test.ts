import { describe, expect, test } from 'bun:test';
import {
  decideReadPlanCommandV1,
  decideUpdatePlanCommandV1,
  decideWritePlanCommandV1,
  type PlanCommandStateFactsV1,
  planCommandPhaseV1,
} from '../src/plan-command';
import type { PlanDocument, PlanningState } from '../src/state';

const digest = 'a'.repeat(64);

function document(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    planSchemaVersion: 2,
    planId: 'plan-1',
    version: 1,
    title: 'Runtime plan',
    bodyMarkdown: 'A sufficiently detailed Runtime plan for the decision tests.',
    steps: [
      { id: 'inspect', title: 'Inspect the runtime', status: 'pending' },
      { id: 'implement', title: 'Implement the change', status: 'pending' },
    ],
    structuralDigest: digest,
    createdAtTurnId: 'turn-1',
    updatedAtTurnId: 'turn-1',
    completionEvidence: {
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
    ...overrides,
  };
}

function facts(
  planning: PlanningState,
  overrides: Partial<PlanCommandStateFactsV1> = {},
): PlanCommandStateFactsV1 {
  return {
    taskId: 'task-1',
    planning,
    phase: planCommandPhaseV1(planning),
    sideEffectsStarted: false,
    ...overrides,
  };
}

const saveDocument = {
  title: 'Runtime plan',
  body_markdown: 'A sufficiently detailed Runtime plan for the decision tests.',
  steps: [{ id: 'inspect', title: 'Inspect the runtime' }],
  action: 'save' as const,
};

describe('Kernel plan-command admission', () => {
  test('read admits the active identity and rejects digest drift before artifact access', () => {
    const planning: PlanningState = { kind: 'planning_draft', document: document() };
    expect(
      decideReadPlanCommandV1(facts(planning), {
        plan_id: 'plan-1',
        version: 1,
        structural_digest: digest,
      }),
    ).toEqual({ accepted: true, mode: 'read_artifact', code: 'admitted' });
    expect(
      decideReadPlanCommandV1(facts(planning), {
        plan_id: 'plan-1',
        version: 1,
        structural_digest: 'b'.repeat(64),
      }),
    ).toMatchObject({
      accepted: false,
      code: 'read_plan_structural_digest_mismatch',
      diagnostic: 'read_plan structural_digest does not match the active Artifact.',
    });
  });

  test('write covers auto-enter, initial save, submit, replan, and identity/side-effect gates', () => {
    expect(
      decideWritePlanCommandV1(facts({ kind: 'building_without_plan' }), saveDocument),
    ).toEqual({ accepted: true, mode: 'auto_enter', code: 'admitted' });

    const draft = document();
    expect(decideWritePlanCommandV1(facts({ kind: 'planning_empty' }), saveDocument)).toEqual({
      accepted: true,
      mode: 'draft_save',
      code: 'admitted',
    });
    expect(
      decideWritePlanCommandV1(facts({ kind: 'planning_draft', document: draft }), {
        ...saveDocument,
        title: 'Updated runtime plan',
      }),
    ).toMatchObject({ accepted: false, code: 'plan_identity_required' });
    expect(
      decideWritePlanCommandV1(facts({ kind: 'planning_draft', document: draft }), {
        ...saveDocument,
        plan_id: 'plan-1',
        version: 1,
        structural_digest: 'b'.repeat(64),
      }),
    ).toMatchObject({ accepted: false, code: 'plan_identity_mismatch' });
    expect(
      decideWritePlanCommandV1(facts({ kind: 'planning_draft', document: draft }), {
        action: 'submit',
        plan_id: 'plan-1',
        version: 1,
        structural_digest: digest,
      }),
    ).toEqual({ accepted: true, mode: 'submit_existing', code: 'admitted' });
    expect(
      decideWritePlanCommandV1(
        facts({ kind: 'planning_empty' }, { sideEffectsStarted: true }),
        saveDocument,
      ),
    ).toMatchObject({ accepted: false, code: 'write_plan_side_effects_started' });

    const executing: PlanningState = {
      kind: 'executing',
      document: draft,
      executionMode: 'auto',
      approvedAtTurnId: 'turn-2',
    };
    expect(
      decideWritePlanCommandV1(facts(executing), {
        ...saveDocument,
        plan_id: 'plan-1',
        version: 1,
        structural_digest: digest,
      }),
    ).toEqual({ accepted: true, mode: 'replan_save', code: 'admitted' });

    const replan: PlanningState = {
      kind: 'replanning_draft',
      document: { ...draft, version: 2, supersedesPlanVersion: 1, replanReason: 'retry' },
      supersedesPlanVersion: 1,
      replanReason: 'retry',
    };
    expect(
      decideWritePlanCommandV1(facts(replan), {
        action: 'submit',
        plan_id: 'plan-1',
        version: 2,
        structural_digest: digest,
      }),
    ).toEqual({ accepted: true, mode: 'replanning_save', code: 'admitted' });
  });

  test('update covers phase, identity, duplicate, unknown, rollback, pending and skipped gates', () => {
    const executing: PlanningState = {
      kind: 'executing',
      document: document({
        steps: [
          { id: 'inspect', title: 'Inspect the runtime', status: 'completed' },
          { id: 'implement', title: 'Implement the change', status: 'pending' },
        ],
      }),
      executionMode: 'auto',
      approvedAtTurnId: 'turn-2',
    };
    const identity = { plan_id: 'plan-1', version: 1, structural_digest: digest };
    expect(
      decideUpdatePlanCommandV1(facts(executing), {
        ...identity,
        updates: [{ step_id: 'implement', status: 'completed' }],
      }),
    ).toMatchObject({ accepted: true, mode: 'progress_update', code: 'admitted' });
    expect(
      decideUpdatePlanCommandV1(facts({ kind: 'planning_empty' }), { ...identity, updates: [] }),
    ).toMatchObject({ accepted: false, code: 'update_plan_phase' });
    expect(
      decideUpdatePlanCommandV1(facts(executing), {
        plan_id: 'plan-1',
        updates: [],
      }),
    ).toMatchObject({ accepted: false, code: 'plan_identity_required' });
    expect(
      decideUpdatePlanCommandV1(facts(executing), {
        ...identity,
        updates: [
          { step_id: 'implement', status: 'completed' },
          { step_id: 'implement', status: 'completed' },
        ],
      }),
    ).toMatchObject({ accepted: false, code: 'plan_duplicate_step_update' });
    expect(
      decideUpdatePlanCommandV1(facts(executing), {
        ...identity,
        updates: [{ step_id: 'missing', status: 'completed' }],
      }),
    ).toMatchObject({ accepted: false, code: 'plan_unknown_step' });
    expect(
      decideUpdatePlanCommandV1(facts(executing), {
        ...identity,
        updates: [{ step_id: 'inspect', status: 'pending' }],
      }),
    ).toMatchObject({ accepted: false, code: 'plan_terminal_step_rollback' });
    expect(
      decideUpdatePlanCommandV1(facts(executing), {
        ...identity,
        updates: [],
        complete_plan: true,
      }),
    ).toMatchObject({ accepted: false, code: 'plan_pending_steps' });
    expect(
      decideUpdatePlanCommandV1(
        facts({
          kind: 'executing',
          document: document({
            steps: [
              { id: 'inspect', title: 'Inspect the runtime', status: 'pending' },
              { id: 'implement', title: 'Implement the change', status: 'pending' },
            ],
          }),
          executionMode: 'auto',
          approvedAtTurnId: 'turn-2',
        }),
        {
          ...identity,
          updates: [
            { step_id: 'inspect', status: 'skipped', reason_code: 'not_needed' },
            { step_id: 'implement', status: 'skipped', reason_code: 'not_needed' },
          ],
          complete_plan: true,
        },
      ),
    ).toMatchObject({ accepted: false, code: 'plan_all_steps_skipped' });
  });
});
