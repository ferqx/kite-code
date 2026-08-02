import { describe, expect, test } from 'bun:test';
import { mapPlanRecoveryUx, type PlanRecoveryObservationV1 } from './plan-recovery-mapper';

describe('Plan/discovery/recovery UX mapper', () => {
  test('maps verified TUI and CLI observations consistently to review-ready, not product success', () => {
    const tui = readyObservation('tui');
    const cli = readyObservation('headless_cli');
    const tuiResult = mapPlanRecoveryUx(tui);
    const cliResult = mapPlanRecoveryUx(cli);

    expect(tuiResult.outcome).toBe('ready_for_review');
    expect(cliResult.outcome).toBe('ready_for_review');
    expect(tuiResult.completionLabel).toBe('verified');
    expect(tuiResult.evidenceEligible).toBe(false);
    expect({ ...tuiResult, entrypoint: 'headless_cli', digest: cliResult.digest }).toEqual(
      cliResult,
    );
  });

  test('does not confuse completed Plan with verified completion', () => {
    const observation = readyObservation('tui');
    observation.planState = 'completed';
    observation.verification = 'not_run';
    observation.claimedComplete = true;
    const result = mapPlanRecoveryUx(observation);

    expect(result.outcome).toBe('unverified');
    expect(result.completionLabel).toBe('unverified');
    expect(result.reasonCodes).toContain('plan_not_completion');
    expect(result.reasonCodes).toContain('false_completion_claim');
    expect(result.reasonCodes).toContain('verification_not_run');
  });

  test('keeps denied, cancelled, failed, and unknown states distinct and rejects unknown fields', () => {
    const denied = readyObservation('headless_cli');
    denied.approval = 'denied';
    expect(mapPlanRecoveryUx(denied).outcome).toBe('blocked');

    const failed = readyObservation('headless_cli');
    failed.recovery = 'failed';
    expect(mapPlanRecoveryUx(failed).outcome).toBe('failed');

    const unknown = readyObservation('headless_cli');
    unknown.verification = 'unknown';
    expect(mapPlanRecoveryUx(unknown).outcome).toBe('unknown');

    expect(() => mapPlanRecoveryUx({ ...unknown, rawTranscript: 'forbidden' } as never)).toThrow(
      'unknown fields',
    );
  });
});

function readyObservation(
  entrypoint: PlanRecoveryObservationV1['entrypoint'],
): PlanRecoveryObservationV1 {
  return {
    version: 1,
    caseId: 'synthetic.plan-recovery.v1',
    entrypoint,
    planState: 'reviewed',
    toolDiscovery: 'found',
    approval: 'approved',
    recovery: 'recovered',
    verification: 'passed',
    claimedComplete: false,
    userCorrections: 0,
    approvalCount: 1,
  };
}
