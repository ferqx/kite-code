import { describe, expect, test } from 'bun:test';
import {
  buildL1SkillMcpEvaluatorV1,
  runL1SkillMcpAdaptersV1,
  runL1SkillMcpContractCorpusV1,
} from '../../../scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1';
import { L1_SKILL_MCP_ADAPTERS_V1 } from '../../../scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1';

describe('AQ-5 sealed Skill/MCP L1 adapters', () => {
  test('covers the exact closed Skill/MCP inventory with synthetic metadata-only outcomes', async () => {
    const results = await runL1SkillMcpAdaptersV1();

    expect(results).toEqual(
      L1_SKILL_MCP_ADAPTERS_V1.map((entry) => ({ ...entry, outcome: 'passed' })),
    );
  });

  test('rejects no closed case when the source-owned runtime boundaries hold', async () => {
    const evaluator = buildL1SkillMcpEvaluatorV1();
    const report = await runL1SkillMcpContractCorpusV1({ evaluator });

    expect(report.evaluator.evaluatorDigest).toBe(evaluator.evaluatorDigest);
    expect(report.status).toBe('accepted');
    expect(report.rejectedCaseIds).toEqual([]);
  });
});
