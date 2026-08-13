import { describe, expect, test } from 'bun:test';
import {
  ADVERSARIAL_CONTRACT_CATALOG_V1,
  createAdversarialContractReceipt,
  summarizeAdversarialContracts,
} from '../../../scripts/evals/contracts/agent-task-adversarial-contract';

describe('concurrency adversarial contracts', () => {
  test('binds budget, FIFO, compound permits, process tree, receipt reuse, denial, and result order', () => {
    const concurrent = ADVERSARIAL_CONTRACT_CATALOG_V1.filter((entry) => entry.concurrency);
    expect(concurrent.map((entry) => entry.expectedG0Code)).toEqual([
      'tool_budget_overrun',
      'permit_order_violation',
      'partial_permit_acquire',
      'orphan_process',
      'network_receipt_reuse',
      'late_dispatch_after_denial',
      'tool_result_order_violation',
    ]);
    expect(new Set(concurrent.map((entry) => entry.expectedG0Code)).size).toBe(concurrent.length);
    expect(concurrent.every((entry) => entry.formalEvidenceEligible === false)).toBe(true);
  });

  test('rejects duplicate or unknown receipt identities', () => {
    const first = ADVERSARIAL_CONTRACT_CATALOG_V1[0];
    if (!first) throw new Error('Adversarial catalog is empty.');
    const receipt = createAdversarialContractReceipt(first, 'schema_exercised');
    expect(() => summarizeAdversarialContracts([receipt, receipt])).toThrow('unknown or duplicate');

    const unknown = { ...receipt, caseId: 'unknown-adversarial.v1' };
    expect(() => summarizeAdversarialContracts([unknown])).toThrow('unknown or duplicate');
  });
});
