import { describe, expect, test } from 'bun:test';
import {
  computePlanStructuralDigest,
  createBuiltinPlanDocumentV2V1,
  initialPlanIdV1,
  isBuiltinSavedReplanRevisionV1,
  isPlanDocumentV2,
  projectBuiltinPublicPlanV2V1,
} from '../src/planning';

const input = {
  taskId: 'task-plan-semantics',
  turnId: 'turn-1',
  title: 'Runtime modularization',
  bodyMarkdown: 'A sufficiently detailed plan body for the State25 plan document.',
  steps: [
    { id: 'inspect', title: 'Inspect the current runtime' },
    { id: 'implement', title: 'Implement the package seam' },
  ],
} as const;

describe('Builtin plan document semantics', () => {
  test('keeps the task-derived identity and State25 V2 structural digest', () => {
    const plan = createBuiltinPlanDocumentV2V1(input);
    expect(plan.planId).toBe('plan-4ad62e8d9a7ab27b18abe5deba5fddcf');
    expect(plan.version).toBe(1);
    expect(plan.planSchemaVersion).toBe(2);
    expect(plan.structuralDigest).toBe(computePlanStructuralDigest(plan));
    expect(isPlanDocumentV2(plan)).toBe(true);
    expect(plan.completionEvidence).toEqual({
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    });
  });

  test('projects only the public plan shape and preserves notes/statuses', () => {
    const plan = createBuiltinPlanDocumentV2V1(input);
    const progressed = {
      ...plan,
      steps: [{ ...plan.steps[0]!, status: 'completed' as const, note: 'done' }, plan.steps[1]!],
    };
    expect(projectBuiltinPublicPlanV2V1(progressed)).toEqual({
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
    const first = createBuiltinPlanDocumentV2V1(input);
    const replan = createBuiltinPlanDocumentV2V1({
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
      isBuiltinSavedReplanRevisionV1(replan, {
        supersedesPlanVersion: 1,
        replanReason: 'address-review',
      }),
    ).toBe(true);

    const retried = createBuiltinPlanDocumentV2V1({
      ...input,
      turnId: 'turn-3',
      previous: first,
      canonicalRevisionIsSaved: true,
    });
    expect(retried).toBe(first);
  });

  test('rejects malformed candidate documents before artifact-facing code', () => {
    expect(() =>
      createBuiltinPlanDocumentV2V1({
        ...input,
        title: '',
      }),
    ).toThrow('PlanDocument V2 schema validation failed.');
    expect(initialPlanIdV1(input.taskId)).toBe('plan-4ad62e8d9a7ab27b18abe5deba5fddcf');
  });
});
