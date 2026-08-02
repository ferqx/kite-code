import { describe, expect, test } from 'bun:test';
import { verifyCapabilityEvaluationEvidenceV1 } from './contract-evidence';
import { buildCapabilityEvidenceFixtureV1 } from './evidence-fixtures';

describe('production-owned Skills evaluation evidence', () => {
  test.each([
    'skills_readonly',
    'skills_effectful',
  ] as const)('keeps canonical %s evidence blocked without authenticated authority', (capability) => {
    const fixture = buildCapabilityEvidenceFixtureV1(capability);
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result.status).toBe('blocked');
    expect(result.evidenceEligible).toBeFalse();
    expect(result.capability).toBe(capability);
  });

  test.each([
    [
      'malicious instruction',
      { maliciousInstructionAccepted: 1 },
      'skill_malicious_instruction_accepted',
    ],
    ['invalid shadowing', { invalidShadowingAccepted: 1 }, 'skill_invalid_shadowing_accepted'],
    ['dependency drift', { dependencyRevisionDrift: 1 }, 'skill_dependency_revision_drift'],
    [
      'reference boundary violation',
      { referenceBoundaryViolation: 1 },
      'skill_reference_boundary_violation',
    ],
    ['duplicate effect', { duplicateEffect: 1 }, 'skill_duplicate_effect'],
    [
      'unknown effect reported as success',
      { unknownEffectResolvedAsSuccess: 1 },
      'unknown_effect_resolved_as_success',
    ],
    ['false completion', { falseCompletion: 1 }, 'skill_false_completion'],
  ] as const)('fails closed for %s', (_name, safety, reason) => {
    const fixture = buildCapabilityEvidenceFixtureV1('skills_effectful', safety);
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result.status).toBe('failed');
    expect(result.reasonCodes).toContain(reason);
  });

  test('rejects workflow/run identity splicing', () => {
    const fixture = buildCapabilityEvidenceFixtureV1('skills_readonly');
    fixture.expected.source = { ...fixture.expected.source, runAttempt: 2 };
    expect(() => verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected)).toThrow(
      'expected workflow/run',
    );
  });
});
