import { describe, expect, test } from 'bun:test';
import {
  buildL1SubagentRecoveryEvaluatorV1,
  runL1SubagentRecoveryAdaptersV1,
  runL1SubagentRecoveryContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l1-subagent-recovery-adapter-v1';
import { L1_SUBAGENT_RECOVERY_ADAPTERS_V1 } from '../../../scripts/evals/contracts/qualification/l1-subagent-recovery-schema-v1';

describe('AQ-6 sealed Subagent/Runtime recovery L1 adapters', () => {
  test('covers every closed cut point with metadata-only synthetic outcomes', async () => {
    const results = await runL1SubagentRecoveryAdaptersV1();

    expect(results).toEqual(
      L1_SUBAGENT_RECOVERY_ADAPTERS_V1.map((entry) => ({ ...entry, outcome: 'passed' })),
    );
  });

  test('rejects no cut point while durable claim, terminality, and recovery boundaries hold', async () => {
    const evaluator = buildL1SubagentRecoveryEvaluatorV1();
    const report = await runL1SubagentRecoveryContractCorpusV1({ evaluator });

    expect(report.evaluator.evaluatorDigest).toBe(evaluator.evaluatorDigest);
    expect(report.status).toBe('accepted');
    expect(report.rejectedCaseIds).toEqual([]);
  });
});
