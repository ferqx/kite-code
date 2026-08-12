import { describe, expect, test } from 'bun:test';
import {
  type ContextStrategyAttemptV1,
  type ContextStrategyEvaluationInputV1,
  evaluateProgressiveContextStrategyV1,
  progressiveContextStrategyEvaluationDigestV1,
} from '../../scripts/evals/contracts/progressive-context-strategy-evaluation';

function input(): ContextStrategyEvaluationInputV1 {
  const attempts: ContextStrategyAttemptV1[] = [];
  for (let attempt = 1; attempt <= 24; attempt++) {
    for (const profile of ['raw', 'rolling_summary', 'local_projection', 'progressive'] as const) {
      const treatment = profile === 'local_projection' || profile === 'progressive';
      attempts.push({
        caseId: `case-${Math.ceil(attempt / 3)}`,
        attempt,
        profile,
        terminal: 'completed',
        taskSucceeded: treatment || attempt % 3 !== 0,
        invariantFailureCount: 0,
        unauthorizedSideEffectCount: 0,
        totalBilledTokens: profile === 'progressive' ? 70 : 100,
        endToEndMs: profile === 'progressive' ? 110 : 100,
        selectedTierCounts: {
          micro: treatment ? 1 : 0,
          workingSet: treatment ? 1 : 0,
          offload: treatment && attempt === 1 ? 1 : 0,
          summary: profile === 'rolling_summary' || profile === 'progressive' ? 1 : 0,
        },
      });
    }
  }
  return {
    suiteDigest: 'suite-digest',
    routeDigest: 'route-digest',
    configDigest: 'config-digest',
    fixtureDigest: 'fixture-digest',
    attempts,
  };
}

describe('progressive context strategy evaluation contract', () => {
  test('accepts a complete, safe, non-inferior evaluation with a pre-registered benefit', () => {
    const report = evaluateProgressiveContextStrategyV1(input());
    expect(report).toMatchObject({ status: 'passed' });
    expect(report.successDeltaLowerBound.local_projection).toBeGreaterThanOrEqual(-0.05);
    expect(report.successDeltaLowerBound.progressive).toBeGreaterThanOrEqual(-0.05);
    expect(report.progressiveMedianTokenReduction).toBeCloseTo(0.3);
    expect(report.progressiveP95LatencyIncrease).toBeCloseTo(0.1);
    expect(report.notExercised).toEqual([]);
    expect(progressiveContextStrategyEvaluationDigestV1(input())).toBe(
      progressiveContextStrategyEvaluationDigestV1(structuredClone(input())),
    );
  });

  test('fails closed for correctness, safety, quality, benefit, and latency regressions', () => {
    const unsafe = input();
    unsafe.attempts[0]!.unauthorizedSideEffectCount = 1;
    expect(evaluateProgressiveContextStrategyV1(unsafe)).toMatchObject({
      status: 'failed',
      reasons: expect.arrayContaining(['unauthorized_side_effect']),
    });

    const noBenefit = input();
    for (const item of noBenefit.attempts) {
      if (item.profile === 'progressive') {
        item.totalBilledTokens = 100;
        item.endToEndMs = 125;
      }
    }
    expect(evaluateProgressiveContextStrategyV1(noBenefit)).toMatchObject({
      status: 'failed',
      reasons: expect.arrayContaining([
        'progressive_benefit_not_met',
        'progressive_latency_regression',
      ]),
    });
  });

  test('returns inconclusive rather than manufacturing a metric from incomplete pairs or usage', () => {
    const incomplete = input();
    incomplete.attempts = incomplete.attempts.filter(
      (item) => !(item.attempt === 1 && item.profile === 'rolling_summary'),
    );
    expect(evaluateProgressiveContextStrategyV1(incomplete)).toMatchObject({
      status: 'inconclusive',
      reasons: expect.arrayContaining(['incomplete_paired_coverage']),
    });

    const missingUsage = input();
    missingUsage.attempts.find((item) => item.profile === 'progressive')!.totalBilledTokens = null;
    expect(evaluateProgressiveContextStrategyV1(missingUsage)).toMatchObject({
      status: 'inconclusive',
      reasons: expect.arrayContaining(['progressive_cost_or_latency_unavailable']),
    });
  });
});
