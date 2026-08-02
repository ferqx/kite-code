import { describe, expect, test } from 'bun:test';
import { evaluateAutoCompactionAdmissionV1 } from '../../scripts/release/auto-compaction-admission';

const digest = `sha256:${'b'.repeat(64)}` as const;
const input = {
  schema: 'AutoCompactionAdmissionInputV1',
  artifactDigest: digest,
  profileDigest: digest,
  routeDigest: digest,
  cohortDigest: digest,
  dependencies: [],
  safetyObservation: {
    g0Count: 0,
    g1Count: 0,
    ledgerDigest: digest,
  },
} as const;

const dependencyIds = [
  'manual_stable',
  'internal_auto_fresh',
  'limited_approved',
  'limited_slo',
  'external_shadow',
  'owner_approval',
  'kill_switch',
  'consent_provider_policy',
  'incident_rehearsal',
] as const;

const dependencies = dependencyIds.map((dependency) => ({
  schema: 'AutoCompactionDependencyDecisionV1' as const,
  dependency,
  status: 'passed' as const,
  artifactDigest: digest,
  profileDigest: digest,
  routeDigest: digest,
  cohortDigest: digest,
  verifiedAt: '2026-08-02T00:00:00.000Z',
  verifierIdentity: 'fixture:contract-only',
  decisionDigest: digest,
}));

describe('external auto-compaction admission contract', () => {
  test('keeps auto off with zero model/checkpoint effects while evidence is absent', () => {
    const result = evaluateAutoCompactionAdmissionV1(input);
    expect(result).toMatchObject({
      status: 'blocked',
      liveAdmissionEligible: false,
      summaryDispatches: 0,
      checkpointWrites: 0,
      profileDiff: { capability: 'auto_compaction', maxRollout: 'off', cohortMaximum: 0 },
    });
    expect(result.reasonCodes).toContain('ms_manual_stable_missing');
    expect(result.reasonCodes).toContain('external_shadow_missing');
  });

  test('keeps shape-valid dependency fixtures contract-only and live-off', () => {
    const result = evaluateAutoCompactionAdmissionV1({
      ...input,
      dependencies,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      liveAdmissionEligible: false,
      summaryDispatches: 0,
      checkpointWrites: 0,
      profileDiff: { maxRollout: 'off', cohortMaximum: 0 },
    });
    expect(result.reasonCodes).toEqual(['authenticated_auto_compaction_verifier_not_configured']);
    expect(result.dependencyDecisionDigests).toHaveLength(dependencyIds.length);
  });

  test('G0/G1 and unknown fields fail closed', () => {
    expect(
      evaluateAutoCompactionAdmissionV1({
        ...input,
        safetyObservation: { ...input.safetyObservation, g0Count: 1, g1Count: 1 },
      }).reasonCodes,
    ).toEqual(expect.arrayContaining(['g0_observed', 'g1_observed']));
    expect(() => evaluateAutoCompactionAdmissionV1({ ...input, hiddenGrant: true })).toThrow();
  });
});
