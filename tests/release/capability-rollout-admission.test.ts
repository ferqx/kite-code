import { describe, expect, test } from 'bun:test';
import {
  evaluateCapabilityRolloutAdmission,
  type RolloutCapability,
  type RolloutStage,
  requiredRolloutDependencies,
} from '../../scripts/release/capability-rollout-admission';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const identity = {
  artifactDigest: digest('1'),
  profileDigest: digest('2'),
  routeDigest: digest('3'),
  platformDigest: digest('4'),
  cohortDigest: digest('5'),
  capabilityContractDigest: digest('6'),
} as const;

function input(capability: RolloutCapability, stage: RolloutStage) {
  return {
    schema: 'CapabilityRolloutAdmissionInput' as const,
    capability,
    stage,
    identity,
    dependencies: requiredRolloutDependencies(capability, stage).map((dependency, index) => ({
      schema: 'CapabilityRolloutDependencyDecision' as const,
      dependency,
      status: 'passed' as const,
      ...identity,
      verifiedAt: '2026-08-03T00:00:00.000Z',
      verifierIdentity: 'fixture-verifier',
      decisionDigest: digest(((index + 7) % 10).toString()),
    })),
    safety: {
      g0Count: 0,
      g1Count: 0,
      duplicateOrUnauthorizedEffectCount: 0,
      verificationBypassCount: 0,
      retainedLedgerDigest: digest('f'),
    },
  };
}

describe('capability rollout admission', () => {
  test.each([
    'verification',
    'mcp_write',
    'skills_readonly',
    'skills_effectful',
    'manual_compaction',
  ] as const)('keeps %s internal rollout off without authenticated authority', (capability) => {
    const decision = evaluateCapabilityRolloutAdmission(input(capability, 'internal'));
    expect(decision).toMatchObject({
      capability,
      requestedStage: 'internal',
      status: 'blocked',
      admissionEligible: false,
      effectiveRollout: 'off',
      cohortPercent: 0,
      reasonCodes: ['authenticated_rollout_authority_not_configured'],
    });
  });

  test('requires external cohort, SLO, consent, policy, and rehearsal dependencies', () => {
    const candidate = input('verification', 'external_canary');
    candidate.dependencies = candidate.dependencies.filter(
      (dependency) => dependency.dependency === 'evaluation',
    );
    const decision = evaluateCapabilityRolloutAdmission(candidate);
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        'dependency_missing:internal_rollout',
        'dependency_missing:limited_approved',
        'dependency_missing:limited_slo',
        'dependency_missing:telemetry_consent',
        'dependency_missing:provider_data_policy',
        'dependency_missing:incident_rehearsal',
      ]),
    );
    expect(decision.cohortPercent).toBe(0);
  });

  test('fails closed on identity splicing, safety failures, and duplicate dependencies', () => {
    const candidate = input('mcp_write', 'internal');
    candidate.dependencies[0]!.artifactDigest = digest('0');
    candidate.safety.g0Count = 1;
    candidate.safety.duplicateOrUnauthorizedEffectCount = 1;
    candidate.safety.verificationBypassCount = 1;
    const decision = evaluateCapabilityRolloutAdmission(candidate);
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        `dependency_identity_mismatch:${candidate.dependencies[0]!.dependency}:artifactDigest`,
        'g0_observed',
        'duplicate_or_unauthorized_effect_observed',
        'verification_bypass_observed',
      ]),
    );

    candidate.dependencies.push({ ...candidate.dependencies[0]! });
    expect(() => evaluateCapabilityRolloutAdmission(candidate)).toThrow('duplicated');
  });
});
