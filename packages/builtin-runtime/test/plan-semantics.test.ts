import { describe, expect, test } from 'bun:test';
import {
  computePlanStructuralDigest,
  createBuiltinPlanDocument,
  initialPlanId,
  isBuiltinSavedReplanRevision,
  isPlanDocument,
  projectBuiltinPublicPlan,
} from '../src/planning';

const input = {
  taskId: 'task-plan-semantics',
  turnId: 'turn-1',
  title: 'Runtime modularization',
  bodyMarkdown: 'A sufficiently detailed plan body for the State plan document.',
  steps: [
    { id: 'inspect', title: 'Inspect the current runtime' },
    { id: 'implement', title: 'Implement the package seam' },
  ],
} as const;

describe('Builtin plan document semantics', () => {
  test('keeps the task-derived identity and State V2 structural digest', () => {
    const plan = createBuiltinPlanDocument(input);
    expect(plan.planId).toBe('plan-4ad62e8d9a7ab27b18abe5deba5fddcf');
    expect(plan.version).toBe(1);
    expect(plan.planSchemaVersion).toBe(2);
    expect(plan.structuralDigest).toBe(computePlanStructuralDigest(plan));
    expect(isPlanDocument(plan)).toBe(true);
    expect(plan.completionEvidence).toEqual({
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    });
  });

  test('projects only the public plan shape and preserves notes/statuses', () => {
    const plan = createBuiltinPlanDocument(input);
    const progressed = {
      ...plan,
      steps: [{ ...plan.steps[0]!, status: 'completed' as const, note: 'done' }, plan.steps[1]!],
    };
    expect(projectBuiltinPublicPlan(progressed)).toEqual({
      name: input.title,
      description: input.bodyMarkdown,
      status: 'pending',
      steps: [
        { id: 'inspect', step: 'Inspect the current runtime', status: 'completed', note: 'done' },
        { id: 'implement', step: 'Implement the package seam', status: 'pending' },
      ],
    });
  });

  test('preserves explicit replan metadata and idempotently reuses a saved canonical revision', () => {
    const first = createBuiltinPlanDocument(input);
    const replan = createBuiltinPlanDocument({
      ...input,
      turnId: 'turn-2',
      previous: first,
      revision: { supersedesPlanVersion: first.version, replanReason: 'address-review' },
    });
    expect(replan).toMatchObject({
      planId: first.planId,
      version: 2,
      supersedesPlanVersion: 1,
      replanReason: 'address-review',
    });
    expect(
      isBuiltinSavedReplanRevision(replan, {
        supersedesPlanVersion: 1,
        replanReason: 'address-review',
      }),
    ).toBe(true);

    const retried = createBuiltinPlanDocument({
      ...input,
      turnId: 'turn-3',
      previous: first,
      canonicalRevisionIsSaved: true,
    });
    expect(retried).toBe(first);
  });

  test('rejects malformed candidate documents before artifact-facing code', () => {
    expect(() =>
      createBuiltinPlanDocument({
        ...input,
        title: '',
      }),
    ).toThrow('PlanDocument V2 schema validation failed.');
    expect(initialPlanId(input.taskId)).toBe('plan-4ad62e8d9a7ab27b18abe5deba5fddcf');
  });
});
