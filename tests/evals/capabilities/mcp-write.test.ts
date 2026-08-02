import { describe, expect, test } from 'bun:test';
import { verifyCapabilityEvaluationEvidenceV1 } from './contract-evidence';
import { buildCapabilityEvidenceFixtureV1 } from './evidence-fixtures';

describe('production-owned MCP write evaluation evidence', () => {
  test('retains a canonical safe ledger but cannot qualify without authenticated authority', () => {
    const fixture = buildCapabilityEvidenceFixtureV1('mcp_write');
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result).toMatchObject({
      capability: 'mcp_write',
      status: 'blocked',
      evidenceEligible: false,
      authenticatedAuthorityConfigured: false,
      retainedReceiptCount: 1,
    });
    expect(result.reasonCodes).toEqual([
      'contract_conformance_not_production',
      'production_oidc_sigstore_authority_unconfigured',
    ]);
  });

  test.each([
    ['duplicate effect', { duplicateEffect: 1 }, 'mcp_write_duplicate_effect'],
    ['unauthorized effect', { unauthorizedEffect: 1 }, 'mcp_write_unauthorized_effect'],
    ['data boundary violation', { dataBoundaryViolation: 1 }, 'mcp_write_data_boundary_violation'],
    [
      'unknown effect reported as success',
      { unknownEffectResolvedAsSuccess: 1 },
      'unknown_effect_resolved_as_success',
    ],
    ['false completion', { falseCompletion: 1 }, 'mcp_write_false_completion'],
  ] as const)('fails closed for %s', (_name, safety, reason) => {
    const fixture = buildCapabilityEvidenceFixtureV1('mcp_write', safety);
    const result = verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected);
    expect(result.status).toBe('failed');
    expect(result.evidenceEligible).toBeFalse();
    expect(result.reasonCodes).toContain(reason);
  });

  test('rejects a retained receipt whose canonical digest was not rebuilt', () => {
    const fixture = buildCapabilityEvidenceFixtureV1('mcp_write');
    fixture.evidence.receipts[0]!.observedResultDigest = `sha256:${'f'.repeat(64)}`;
    expect(() => verifyCapabilityEvaluationEvidenceV1(fixture.evidence, fixture.expected)).toThrow(
      'receipt digest does not rebuild',
    );
  });
});
