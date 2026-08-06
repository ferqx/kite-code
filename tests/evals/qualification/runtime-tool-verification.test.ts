import { describe, expect, test } from 'bun:test';
import {
  buildL1ToolVerificationEvaluatorV1,
  runL1ToolVerificationAdaptersV1,
  runL1ToolVerificationContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l1-tool-verification-adapter-v1';
import {
  buildL1ToolVerificationSuiteV1,
  L1_TOOL_VERIFICATION_ADAPTERS_V1,
  L1_TOOL_VERIFICATION_CASE_IDS_V1,
} from '../../../scripts/evals/contracts/qualification/l1-tool-verification-schema-v1';

describe('L1 Tool / Approval / Verification scripted-runtime qualification', () => {
  test('runs the real Kernel/controller/verifier slice and preserves every negative assertion', async () => {
    const results = await runL1ToolVerificationAdaptersV1();
    expect(results).toEqual(
      L1_TOOL_VERIFICATION_ADAPTERS_V1.map((entry) => ({ ...entry, outcome: 'passed' })),
    );

    const report = await runL1ToolVerificationContractCorpusV1({
      evaluator: buildL1ToolVerificationEvaluatorV1(),
    });
    expect(report.status).toBe('accepted');
    expect(report.rejectedCaseIds).toEqual([]);
    expect(report.observations.map((observation) => observation.caseId)).toEqual([
      ...L1_TOOL_VERIFICATION_CASE_IDS_V1,
    ]);
  });

  test('keeps the L1 evaluator self-contract separate from any Matrix receipt suite', () => {
    const suite = buildL1ToolVerificationSuiteV1();
    expect(suite.suiteId).toBe('qualification-l1-tool-verification-v1');
    expect(suite.assertionIds).toEqual(
      L1_TOOL_VERIFICATION_ADAPTERS_V1.map((entry) => entry.assertionId),
    );
    expect(suite.suiteDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
