import { describe, expect, test } from 'bun:test';
import { compareSyntheticContinuation, syntheticContinuationInput } from './continuation';

describe('control/treatment continuation contract', () => {
  test('blocks when noninferiority thresholds were not preregistered', () => {
    const report = compareSyntheticContinuation(syntheticContinuationInput());
    expect(report.contractOutcome).toBe('not_observed');
    expect(report.reasonCodes).toContain('thresholds_not_preregistered');
    expect(report.status).toBe('blocked');
    expect(report.evidenceEligible).toBeFalse();
  });

  test('checks identical execution identity and preregistration time', () => {
    const input = syntheticContinuationInput({
      version: 1,
      decisionId: 'D-COMPACTION-NONINFERIORITY',
      status: 'preregistered',
      minimumSamplesPerArm: 8,
      maximumSuccessRateDelta: 0.1,
      registeredAt: '2026-08-01T00:00:00.000Z',
      registrationDigest: `sha256:${'6'.repeat(64)}`,
    });
    expect(compareSyntheticContinuation(input).contractOutcome).toBe('passed');

    input.treatment.routeDigest = `sha256:${'7'.repeat(64)}`;
    input.treatment.safetyViolations = 1;
    const failed = compareSyntheticContinuation(input);
    expect(failed.contractOutcome).toBe('failed');
    expect(failed.reasonCodes).toEqual(
      expect.arrayContaining(['routeDigest_mismatch', 'safety_violation']),
    );
  });

  test('does not allow post-run registration', () => {
    const input = syntheticContinuationInput({
      version: 1,
      decisionId: 'D-COMPACTION-NONINFERIORITY',
      status: 'preregistered',
      minimumSamplesPerArm: 8,
      maximumSuccessRateDelta: 0.1,
      registeredAt: '2026-08-03T00:00:00.000Z',
      registrationDigest: `sha256:${'6'.repeat(64)}`,
    });
    expect(compareSyntheticContinuation(input).reasonCodes).toContain(
      'thresholds_registered_after_run_start',
    );
  });
});
