import { describe, expect, test } from 'bun:test';
import { evaluateAutoCompactionAdmissionV1 } from '../../scripts/release/auto-compaction-admission';

const digest = `sha256:${'b'.repeat(64)}` as const;
const input = {
  schema: 'AutoCompactionAdmissionInputV1',
  artifactDigest: digest,
  profileDigest: digest,
  routeQualificationDigest: digest,
  internalAutoEvidenceDigest: digest,
  manualStableDecisionDigest: digest,
  limitedSloEvidenceDigest: digest,
  incidentRehearsalDigest: digest,
  dependencies: {
    msManualStable: false,
    msInternalAutoFresh: false,
    msLimitedApproved: false,
    msLimitedSlo: false,
    externalShadowPassed: false,
    ownerApprovalValid: false,
    killSwitchAvailable: false,
    consentAndProviderPolicyValid: false,
    g0Count: 0,
    g1Count: 0,
  },
} as const;

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

  test('tests the admission-only pass branch without invoking a live canary', () => {
    const result = evaluateAutoCompactionAdmissionV1({
      ...input,
      dependencies: {
        msManualStable: true,
        msInternalAutoFresh: true,
        msLimitedApproved: true,
        msLimitedSlo: true,
        externalShadowPassed: true,
        ownerApprovalValid: true,
        killSwitchAvailable: true,
        consentAndProviderPolicyValid: true,
        g0Count: 0,
        g1Count: 0,
      },
    });
    expect(result).toMatchObject({
      status: 'passed',
      liveAdmissionEligible: true,
      summaryDispatches: 0,
      checkpointWrites: 0,
      profileDiff: { maxRollout: 'canary', cohortMaximum: 1 },
    });
  });

  test('G0/G1 and unknown fields fail closed', () => {
    expect(
      evaluateAutoCompactionAdmissionV1({
        ...input,
        dependencies: { ...input.dependencies, g0Count: 1, g1Count: 1 },
      }).reasonCodes,
    ).toEqual(expect.arrayContaining(['g0_observed', 'g1_observed']));
    expect(() => evaluateAutoCompactionAdmissionV1({ ...input, hiddenGrant: true })).toThrow();
  });
});
