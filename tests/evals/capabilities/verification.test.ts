import { describe, expect, test } from 'bun:test';
import { verifyCapabilityEvaluationEvidenceV1 } from './contract-evidence';
import { buildCapabilityEvidenceFixtureV1 } from './evidence-fixtures';

describe('production-owned Verification evaluation evidence', () => {
  test('rebuilds retained evidence but remains fixed blocked without authenticated authority', () => {
    const fixture = buildCapabilityEvidenceFixtureV1('verification');
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result).toMatchObject({
      capability: 'verification',
      status: 'blocked',
      evidenceEligible: false,
      authenticatedAuthorityConfigured: false,
      productionAuthenticationModel: 'github_actions_oidc_keyless_sigstore',
      retainedReceiptCount: 1,
    });
  });

  test.each([
    ['false pass', { falsePass: 1 }, 'verification_false_pass'],
    [
      'required Verification bypass',
      { requiredVerificationBypass: 1 },
      'required_verification_bypass',
    ],
    ['fabricated evidence', { fabricatedEvidence: 1 }, 'verification_evidence_fabricated'],
    [
      'unknown effect reported as success',
      { unknownEffectResolvedAsSuccess: 1 },
      'unknown_effect_resolved_as_success',
    ],
  ] as const)('fails closed for %s', (_name, safety, reason) => {
    const fixture = buildCapabilityEvidenceFixtureV1('verification', safety);
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result.status).toBe('failed');
    expect(result.evidenceEligible).toBeFalse();
    expect(result.reasonCodes).toContain(reason);
  });

  test('fails expired evidence without relaxing the authenticated-authority block', () => {
    const fixture = buildCapabilityEvidenceFixtureV1('verification');
    fixture.expected.now = fixture.evidence.expiresAt;
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result.status).toBe('failed');
    expect(result.reasonCodes).toContain('evidence_stale');
    expect(result.reasonCodes).toContain('production_oidc_sigstore_authority_unconfigured');
  });

  test('rejects artifact, profile, route, or evaluator cross-binding', () => {
    const fixture = buildCapabilityEvidenceFixtureV1('verification');
    fixture.expected.routeDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected)).toThrow(
      'route identity',
    );
  });
});
