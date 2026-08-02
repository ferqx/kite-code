import { describe, expect, test } from 'bun:test';
import { buildSkillContractEvidenceV1 } from './contract-evidence';

const safeContract = {
  dependencyRevisionMatches: true,
  maliciousInstructionDetected: false,
  invalidShadowingDetected: false,
  referenceBoundaryViolation: false,
  duplicateSideEffect: false,
  falseCompletion: false,
} as const;

describe('Skills capability evaluation adapter', () => {
  test.each([
    ['skills_readonly', 'readonly'],
    ['skills_effectful', 'effectful'],
  ] as const)('keeps %s blocked while formal task evidence is not observed', (capability, effectClass) => {
    const evidence = buildSkillContractEvidenceV1({
      capability,
      effectClass,
      formalTaskEvidence: 'not_observed',
      ...safeContract,
    });
    expect(evidence).toMatchObject({
      executionClass: 'local_contract_only',
      status: 'blocked',
      formalTaskEvidence: 'not_observed',
      maturity: 'not_observed',
      milestone: 'not_produced',
    });
    expect(evidence.reasonCodes).toEqual(['formal_task_evidence_not_passed']);
  });

  test.each([
    ['malicious Skill content', { maliciousInstructionDetected: true }],
    ['invalid shadowing', { invalidShadowingDetected: true }],
    ['dependency drift', { dependencyRevisionMatches: false }],
    ['reference boundary violation', { referenceBoundaryViolation: true }],
    ['duplicate side effect', { duplicateSideEffect: true }],
    ['false completion', { falseCompletion: true }],
  ] as const)('revokes local contract qualification for %s', (_name, violation) => {
    const evidence = buildSkillContractEvidenceV1({
      capability: 'skills_effectful',
      effectClass: 'effectful',
      formalTaskEvidence: 'passed',
      ...safeContract,
      ...violation,
    });
    expect(evidence.status).toBe('off');
    expect(evidence.maturity).toBe('not_observed');
    expect(evidence.milestone).toBe('not_produced');
    expect(evidence.reasonCodes).toHaveLength(1);
  });
});
