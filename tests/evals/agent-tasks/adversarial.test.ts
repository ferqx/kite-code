import { describe, expect, test } from 'bun:test';
import {
  ADVERSARIAL_CONTRACT_CATALOG_V1,
  createAdversarialContractReceipt,
  summarizeAdversarialContracts,
} from './adversarial-contract';

describe('adversarial evaluation contract catalog', () => {
  test('covers the required security threats without claiming a formal G0 artifact', () => {
    const caseIds = ADVERSARIAL_CONTRACT_CATALOG_V1.map((entry) => entry.caseId);
    expect(caseIds).toHaveLength(21);
    expect(caseIds).toContain('repository-instruction-policy-override.v1');
    expect(caseIds).toContain('dependency-source-exfiltration.v1');
    expect(caseIds).toContain('forged-test-success-output.v1');
    expect(caseIds).toContain('symlink-path-traversal.v1');
    expect(caseIds).toContain('protected-credential-read.v1');
    expect(caseIds).toContain('allowlist-redirect-private-endpoint.v1');
    expect(caseIds).toContain('plan-complete-verification-missing.v1');
    expect(caseIds).toContain('compaction-constraint-loss.v1');
    expect(
      ADVERSARIAL_CONTRACT_CATALOG_V1.every(
        (entry) =>
          entry.formalEvidenceEligible === false && entry.requiredMilestones.includes('MS:1B-DONE'),
      ),
    ).toBe(true);
  });

  test('summarizes complete local schema exercise as contract-only and not observed', () => {
    const receipts = ADVERSARIAL_CONTRACT_CATALOG_V1.map((entry) =>
      createAdversarialContractReceipt(entry, 'schema_exercised'),
    );
    const summary = summarizeAdversarialContracts(receipts);

    expect(summary.status).toBe('contract_only');
    expect(summary.formalG0Outcome).toBe('not_observed');
    expect(summary.formalEvidenceEligible).toBe(false);
    expect(summary.missingCaseIds).toEqual([]);
  });

  test('missing cases remain blocked and synthetic bypass fixtures cannot look formally failed/passed', () => {
    const first = ADVERSARIAL_CONTRACT_CATALOG_V1[0];
    if (!first) throw new Error('Adversarial catalog is empty.');
    const missing = summarizeAdversarialContracts([
      createAdversarialContractReceipt(first, 'schema_exercised'),
    ]);
    expect(missing.status).toBe('blocked_missing');
    expect(missing.formalG0Outcome).toBe('not_observed');

    const syntheticBypass = summarizeAdversarialContracts(
      ADVERSARIAL_CONTRACT_CATALOG_V1.map((entry, index) =>
        createAdversarialContractReceipt(
          entry,
          index === 0 ? 'synthetic_bypass_fixture' : 'schema_exercised',
        ),
      ),
    );
    expect(syntheticBypass.status).toBe('synthetic_bypass_detected');
    expect(syntheticBypass.formalEvidenceEligible).toBe(false);
  });
});
