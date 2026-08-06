import { describe, expect, test } from 'bun:test';
import {
  evaluateL0ContractCorpusV1,
  l0ExpectedOutcomeForCaseV1,
  parseL0EvaluatorReportV1,
} from '../../../scripts/evals/contracts/qualification/l0-contract-evaluator-v1';
import {
  buildL0EvaluatorIdentityV1,
  buildL0SourceOwnedBindingV1,
  L0_EVALUATOR_CASE_IDS_V1,
  l0SourceOwnedContractDeclarationV1Schema,
} from '../../../scripts/evals/contracts/qualification/l0-contract-schema-v1';

function evaluator(overrides: Partial<Parameters<typeof buildL0EvaluatorIdentityV1>[0]> = {}) {
  return buildL0EvaluatorIdentityV1({
    oracle: { sourceFactDigest: 'oracle-a' },
    verifier: { sourceFactDigest: 'verifier-a' },
    adapterDependency: { sourceFactDigest: 'adapter-a' },
    runnerDependency: { sourceFactDigest: 'runner-a' },
    ...overrides,
  });
}

function expectedObservations() {
  return L0_EVALUATOR_CASE_IDS_V1.map((caseId) => ({
    caseId,
    observedOutcome: l0ExpectedOutcomeForCaseV1(caseId),
  }));
}

describe('L0 evaluator contract', () => {
  test('seals all evaluator identity composition inputs under distinct canonical digests', () => {
    const baseline = evaluator();
    const changedOracle = evaluator({ oracle: { sourceFactDigest: 'oracle-b' } });
    const changedVerifier = evaluator({ verifier: { sourceFactDigest: 'verifier-b' } });
    const changedAdapter = evaluator({ adapterDependency: { sourceFactDigest: 'adapter-b' } });
    const changedRunner = evaluator({ runnerDependency: { sourceFactDigest: 'runner-b' } });

    expect(changedOracle.oracleDigest).not.toBe(baseline.oracleDigest);
    expect(changedVerifier.verifierDigest).not.toBe(baseline.verifierDigest);
    expect(changedAdapter.adapterDependencyDigest).not.toBe(baseline.adapterDependencyDigest);
    expect(changedRunner.runnerDependencyDigest).not.toBe(baseline.runnerDependencyDigest);
    expect(changedOracle.evaluatorDigest).not.toBe(baseline.evaluatorDigest);
    expect(baseline.goodBadCorpusDigest).toMatch(/^sha256:/);
    expect(baseline.mutationCorpusDigest).toMatch(/^sha256:/);
  });

  test('accepts only a registered source-owner adapter/assertion pair without a feature map', () => {
    const declaration = l0SourceOwnedContractDeclarationV1Schema.parse({
      adapterId: 'approval-policy-decision-v1',
      assertionId: 'l0.authorization-approval.decision-v1',
    });
    const binding = buildL0SourceOwnedBindingV1({
      sourceSurfaceId: 'authorization:approval',
      declaration,
    });
    expect(binding.sourceSurfaceId).toBe('authorization:approval');
    expect(binding.bindingDigest).toMatch(/^sha256:/);
    expect(() =>
      l0SourceOwnedContractDeclarationV1Schema.parse({
        adapterId: 'approval-policy-decision-v1',
        assertionId: 'l0.verification-policy.requirement-v1',
      }),
    ).toThrow();
  });

  test('requires the exact corpus inventory and reports false rejects and accepted negatives separately', () => {
    const identity = evaluator();
    const accepted = evaluateL0ContractCorpusV1({
      evaluator: identity,
      observations: expectedObservations(),
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.falseRejectCaseIds).toEqual([]);
    expect(accepted.acceptedNegativeCaseIds).toEqual([]);
    expect(parseL0EvaluatorReportV1(accepted)).toEqual(accepted);

    const observations = expectedObservations();
    observations[0] = { ...observations[0]!, observedOutcome: 'accepted' };
    observations[4] = { ...observations[4]!, observedOutcome: 'rejected' };
    const blocked = evaluateL0ContractCorpusV1({ evaluator: identity, observations });
    expect(blocked.status).toBe('blocked');
    expect(blocked.acceptedNegativeCaseIds).toEqual(['l0-bad-approval-policy-rejected-v1']);
    expect(blocked.falseRejectCaseIds).toEqual(['l0-good-approval-policy-decision-v1']);

    expect(() =>
      evaluateL0ContractCorpusV1({
        evaluator: identity,
        observations: expectedObservations().slice(1),
      }),
    ).toThrow();
    expect(() =>
      parseL0EvaluatorReportV1({ ...accepted, reportDigest: blocked.reportDigest }),
    ).toThrow();
  });
});
