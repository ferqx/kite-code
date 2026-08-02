import { z } from 'zod';
import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const armSchema = z
  .object({
    version: z.literal(1),
    arm: z.enum(['control', 'treatment']),
    routeDigest: digest,
    modelConfigDigest: digest,
    toolFixtureDigest: digest,
    budgetDigest: digest,
    seedPolicyDigest: digest,
    sampleCount: z.number().int().positive(),
    successRate: z.number().min(0).max(1),
    confidenceLower: z.number().min(0).max(1),
    confidenceUpper: z.number().min(0).max(1),
    safetyViolations: z.number().int().nonnegative(),
    resourceBounded: z.boolean(),
  })
  .strict();

const thresholdSchema = z
  .object({
    version: z.literal(1),
    decisionId: z.literal('D-COMPACTION-NONINFERIORITY'),
    status: z.literal('preregistered'),
    minimumSamplesPerArm: z.number().int().positive(),
    maximumSuccessRateDelta: z.number().min(0).max(1),
    registeredAt: z.string().datetime(),
    registrationDigest: digest,
  })
  .strict();

const inputSchema = z
  .object({
    version: z.literal(1),
    executionClass: z.literal('synthetic_fixture'),
    runStartedAt: z.string().datetime(),
    thresholds: thresholdSchema.nullable(),
    control: armSchema,
    treatment: armSchema,
  })
  .strict();

export type ContinuationComparisonInputV1 = z.infer<typeof inputSchema>;

export interface ContinuationComparisonReportV1 {
  version: 1;
  kind: 'compaction_continuation_comparison';
  executionClass: 'synthetic_fixture';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  status: 'blocked';
  contractOutcome: 'passed' | 'failed' | 'not_observed';
  reasonCodes: string[];
  inputDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
}

export function compareSyntheticContinuation(value: unknown): ContinuationComparisonReportV1 {
  const input = inputSchema.parse(value);
  const reasons: string[] = [];
  if (input.control.arm !== 'control' || input.treatment.arm !== 'treatment') {
    throw new Error('Continuation comparison arms are mislabeled.');
  }
  for (const key of [
    'routeDigest',
    'modelConfigDigest',
    'toolFixtureDigest',
    'budgetDigest',
    'seedPolicyDigest',
  ] as const) {
    if (input.control[key] !== input.treatment[key]) reasons.push(`${key}_mismatch`);
  }
  let contractOutcome: ContinuationComparisonReportV1['contractOutcome'] = 'not_observed';
  if (input.thresholds === null) {
    reasons.push('thresholds_not_preregistered');
  } else {
    if (Date.parse(input.thresholds.registeredAt) >= Date.parse(input.runStartedAt)) {
      reasons.push('thresholds_registered_after_run_start');
    }
    if (
      input.control.sampleCount < input.thresholds.minimumSamplesPerArm ||
      input.treatment.sampleCount < input.thresholds.minimumSamplesPerArm
    ) {
      reasons.push('sample_count_below_preregistered_minimum');
    }
    if (input.control.safetyViolations !== 0 || input.treatment.safetyViolations !== 0) {
      reasons.push('safety_violation');
    }
    if (!input.control.resourceBounded || !input.treatment.resourceBounded) {
      reasons.push('unbounded_resource_growth');
    }
    const lowerBoundDelta = input.treatment.confidenceLower - input.control.confidenceLower;
    if (lowerBoundDelta < -input.thresholds.maximumSuccessRateDelta) {
      reasons.push('noninferiority_threshold_failed');
    }
    contractOutcome = reasons.length === 0 ? 'passed' : 'failed';
  }
  reasons.push('synthetic_fixture_not_release_evidence');
  const inputDigest = sha256Digest(canonicalJsonBytes(input));
  const withoutDigest = {
    version: 1 as const,
    kind: 'compaction_continuation_comparison' as const,
    executionClass: 'synthetic_fixture' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    status: 'blocked' as const,
    contractOutcome,
    reasonCodes: [...new Set(reasons)].sort(),
    inputDigest,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

export function syntheticContinuationInput(
  thresholds: ContinuationComparisonInputV1['thresholds'] = null,
): ContinuationComparisonInputV1 {
  const identity = {
    routeDigest: `sha256:${'1'.repeat(64)}` as const,
    modelConfigDigest: `sha256:${'2'.repeat(64)}` as const,
    toolFixtureDigest: `sha256:${'3'.repeat(64)}` as const,
    budgetDigest: `sha256:${'4'.repeat(64)}` as const,
    seedPolicyDigest: `sha256:${'5'.repeat(64)}` as const,
  };
  return {
    version: 1,
    executionClass: 'synthetic_fixture',
    runStartedAt: '2026-08-02T00:00:00.000Z',
    thresholds,
    control: {
      version: 1,
      arm: 'control',
      ...identity,
      sampleCount: 8,
      successRate: 0.875,
      confidenceLower: 0.55,
      confidenceUpper: 0.98,
      safetyViolations: 0,
      resourceBounded: true,
    },
    treatment: {
      version: 1,
      arm: 'treatment',
      ...identity,
      sampleCount: 8,
      successRate: 0.875,
      confidenceLower: 0.55,
      confidenceUpper: 0.98,
      safetyViolations: 0,
      resourceBounded: true,
    },
  };
}
