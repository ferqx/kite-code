import { describe, expect, test } from 'bun:test';
import {
  evaluateInternalCompactionRollout,
  syntheticInternalRolloutInput,
} from './internal-rollout';

describe('internal compaction rollout contract-only adapter', () => {
  test('keeps every capability off when route, Phase 3, live, G3, and G4 are unobserved', () => {
    const report = evaluateInternalCompactionRollout(syntheticInternalRolloutInput());
    expect(report.status).toBe('blocked');
    expect(report.effectiveStage).toBe('off');
    expect(report.manualEnabled).toBeFalse();
    expect(report.autoShadowEnabled).toBeFalse();
    expect(report.autoLiveEnabled).toBeFalse();
    expect(report.externalCohort).toBe(0);
    expect(report.milestone).toBeNull();
    expect(report.evidenceEligible).toBeFalse();
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        'phase3_operations_ready_missing',
        'route_qualification_not_observed',
        'live_matrix_not_observed',
        'g3_not_observed',
        'g4_not_observed',
      ]),
    );
  });

  test.each([
    'off',
    'internal_manual',
    'internal_auto_shadow',
    'internal_auto_live',
  ] as const)('never advances requested stage %s from contract-only input', (requestedStage) => {
    const report = evaluateInternalCompactionRollout(syntheticInternalRolloutInput(requestedStage));
    expect(report.requestedStage).toBe(requestedStage);
    expect(report.effectiveStage).toBe('off');
    expect(report.milestone).toBeNull();
  });

  test('rejects fabricated observed dependencies', () => {
    expect(() =>
      evaluateInternalCompactionRollout({
        ...syntheticInternalRolloutInput(),
        dependencies: {
          ...syntheticInternalRolloutInput().dependencies,
          phase3OperationsReady: true,
        },
      }),
    ).toThrow();
  });
});
