import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const compactionContinuationArmMaterialV1Schema = z
  .object({
    version: z.literal(1),
    arm: z.enum(['control', 'treatment']),
    routeDigest: digestSchema,
    modelConfigDigest: digestSchema,
    toolFixtureDigest: digestSchema,
    budgetDigest: digestSchema,
    seedPolicyDigest: digestSchema,
    sampleCount: z.number().int().positive(),
    successRate: z.number().min(0).max(1),
    confidenceLower: z.number().min(0).max(1),
    confidenceUpper: z.number().min(0).max(1),
    safetyViolations: z.number().int().nonnegative(),
    resourceBounded: z.boolean(),
  })
  .strict();

export const compactionContinuationArmV1Schema = compactionContinuationArmMaterialV1Schema
  .extend({ armDigest: digestSchema })
  .strict();

export const compactionContinuationPreregistrationMaterialV1Schema = z
  .object({
    version: z.literal(1),
    decisionId: z.literal('D-COMPACTION-NONINFERIORITY'),
    status: z.literal('preregistered'),
    minimumSamplesPerArm: z.number().int().positive(),
    maximumSuccessRateDelta: z.number().min(0).max(1),
    registeredAt: timestampSchema,
  })
  .strict();

export const compactionContinuationPreregistrationV1Schema =
  compactionContinuationPreregistrationMaterialV1Schema
    .extend({ registrationDigest: digestSchema })
    .strict();

export const compactionContinuationInputV1Schema = z
  .object({
    version: z.literal(1),
    executionClass: z.literal('synthetic_fixture'),
    runStartedAt: timestampSchema,
    thresholds: compactionContinuationPreregistrationV1Schema.nullable(),
    control: compactionContinuationArmV1Schema,
    treatment: compactionContinuationArmV1Schema,
  })
  .strict();

export type CompactionContinuationArmMaterialV1 = z.infer<
  typeof compactionContinuationArmMaterialV1Schema
>;
export type CompactionContinuationArmV1 = z.infer<typeof compactionContinuationArmV1Schema>;
export type CompactionContinuationPreregistrationMaterialV1 = z.infer<
  typeof compactionContinuationPreregistrationMaterialV1Schema
>;
export type CompactionContinuationPreregistrationV1 = z.infer<
  typeof compactionContinuationPreregistrationV1Schema
>;
export type ContinuationComparisonInputV1 = z.infer<typeof compactionContinuationInputV1Schema>;

export interface ContinuationComparisonReportV1 {
  version: 1;
  kind: 'compaction_continuation_comparison';
  executionClass: 'synthetic_fixture';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  status: 'blocked';
  contractOutcome: 'passed' | 'failed' | 'not_observed';
  reasonCodes: string[];
  thresholdDigest: `sha256:${string}` | null;
  controlArmDigest: `sha256:${string}`;
  treatmentArmDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
}

export function computeCompactionContinuationArmDigestV1(rawMaterial: unknown): `sha256:${string}` {
  const material = compactionContinuationArmMaterialV1Schema.parse(rawMaterial);
  return sha256DomainSeparated('kite.compaction.continuation-arm.v1', canonicalJsonBytes(material));
}

export function buildCompactionContinuationArmV1(
  rawMaterial: unknown,
): CompactionContinuationArmV1 {
  const material = compactionContinuationArmMaterialV1Schema.parse(rawMaterial);
  return compactionContinuationArmV1Schema.parse({
    ...material,
    armDigest: computeCompactionContinuationArmDigestV1(material),
  });
}

export function computeCompactionContinuationPreregistrationDigestV1(
  rawMaterial: unknown,
): `sha256:${string}` {
  const material = compactionContinuationPreregistrationMaterialV1Schema.parse(rawMaterial);
  return sha256DomainSeparated(
    'kite.compaction.continuation-preregistration.v1',
    canonicalJsonBytes(material),
  );
}

export function buildCompactionContinuationPreregistrationV1(
  rawMaterial: unknown,
): CompactionContinuationPreregistrationV1 {
  const material = compactionContinuationPreregistrationMaterialV1Schema.parse(rawMaterial);
  return compactionContinuationPreregistrationV1Schema.parse({
    ...material,
    registrationDigest: computeCompactionContinuationPreregistrationDigestV1(material),
  });
}

/**
 * Rebuilds the complete local control/treatment contract. The execution class
 * remains synthetic and can never produce release-eligible evidence.
 */
export function compareSyntheticContinuation(value: unknown): ContinuationComparisonReportV1 {
  const input = compactionContinuationInputV1Schema.parse(value);
  const reasons = new Set<string>();
  if (input.control.arm !== 'control' || input.treatment.arm !== 'treatment') {
    throw new Error('Continuation comparison arms are mislabeled.');
  }

  const { armDigest: _controlDigest, ...controlMaterial } = input.control;
  const { armDigest: _treatmentDigest, ...treatmentMaterial } = input.treatment;
  const controlArmDigest = computeCompactionContinuationArmDigestV1(controlMaterial);
  const treatmentArmDigest = computeCompactionContinuationArmDigestV1(treatmentMaterial);
  if (input.control.armDigest !== controlArmDigest) reasons.add('control_arm_digest_mismatch');
  if (input.treatment.armDigest !== treatmentArmDigest) {
    reasons.add('treatment_arm_digest_mismatch');
  }
  for (const [label, arm] of [
    ['control', input.control],
    ['treatment', input.treatment],
  ] as const) {
    if (
      arm.confidenceLower > arm.confidenceUpper ||
      arm.successRate < arm.confidenceLower ||
      arm.successRate > arm.confidenceUpper
    ) {
      reasons.add(`${label}_confidence_interval_invalid`);
    }
  }
  for (const key of [
    'routeDigest',
    'modelConfigDigest',
    'toolFixtureDigest',
    'budgetDigest',
    'seedPolicyDigest',
  ] as const) {
    if (input.control[key] !== input.treatment[key]) reasons.add(`${key}_mismatch`);
  }

  let contractOutcome: ContinuationComparisonReportV1['contractOutcome'] = 'not_observed';
  let thresholdDigest: `sha256:${string}` | null = null;
  if (input.thresholds === null) {
    reasons.add('thresholds_not_preregistered');
  } else {
    const { registrationDigest, ...thresholdMaterial } = input.thresholds;
    thresholdDigest = computeCompactionContinuationPreregistrationDigestV1(thresholdMaterial);
    if (registrationDigest !== thresholdDigest) reasons.add('preregistration_digest_mismatch');
    if (Date.parse(input.thresholds.registeredAt) >= Date.parse(input.runStartedAt)) {
      reasons.add('thresholds_registered_after_run_start');
    }
    if (
      input.control.sampleCount < input.thresholds.minimumSamplesPerArm ||
      input.treatment.sampleCount < input.thresholds.minimumSamplesPerArm
    ) {
      reasons.add('sample_count_below_preregistered_minimum');
    }
    if (input.control.safetyViolations !== 0 || input.treatment.safetyViolations !== 0) {
      reasons.add('safety_violation');
    }
    if (!input.control.resourceBounded || !input.treatment.resourceBounded) {
      reasons.add('unbounded_resource_growth');
    }
    const lowerBoundDelta = input.treatment.confidenceLower - input.control.confidenceLower;
    if (lowerBoundDelta < -input.thresholds.maximumSuccessRateDelta) {
      reasons.add('noninferiority_threshold_failed');
    }
    contractOutcome = reasons.size === 0 ? 'passed' : 'failed';
  }

  reasons.add('synthetic_fixture_not_release_evidence');
  const inputDigest = sha256DomainSeparated(
    'kite.compaction.continuation-input.v1',
    canonicalJsonBytes(input),
  );
  const withoutDigest = {
    version: 1 as const,
    kind: 'compaction_continuation_comparison' as const,
    executionClass: 'synthetic_fixture' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    status: 'blocked' as const,
    contractOutcome,
    reasonCodes: [...reasons].sort(),
    thresholdDigest,
    controlArmDigest,
    treatmentArmDigest,
    inputDigest,
  };
  return {
    ...withoutDigest,
    digest: sha256DomainSeparated(
      'kite.compaction.continuation-report.v1',
      canonicalJsonBytes(withoutDigest),
    ),
  };
}
