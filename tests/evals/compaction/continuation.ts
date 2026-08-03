import {
  buildCompactionContinuationArmV1,
  buildCompactionContinuationPreregistrationV1,
  type ContinuationComparisonInputV1,
} from '../../../scripts/evals/contracts/compaction-continuation';

export * from '../../../scripts/evals/contracts/compaction-continuation';

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
    control: buildCompactionContinuationArmV1({
      version: 1,
      arm: 'control',
      ...identity,
      sampleCount: 8,
      successRate: 0.875,
      confidenceLower: 0.55,
      confidenceUpper: 0.98,
      safetyViolations: 0,
      resourceBounded: true,
    }),
    treatment: buildCompactionContinuationArmV1({
      version: 1,
      arm: 'treatment',
      ...identity,
      sampleCount: 8,
      successRate: 0.875,
      confidenceLower: 0.55,
      confidenceUpper: 0.98,
      safetyViolations: 0,
      resourceBounded: true,
    }),
    thresholds:
      thresholds === null
        ? null
        : buildCompactionContinuationPreregistrationV1({
            version: thresholds.version,
            decisionId: thresholds.decisionId,
            status: thresholds.status,
            minimumSamplesPerArm: thresholds.minimumSamplesPerArm,
            maximumSuccessRateDelta: thresholds.maximumSuccessRateDelta,
            registeredAt: thresholds.registeredAt,
          }),
  };
}
