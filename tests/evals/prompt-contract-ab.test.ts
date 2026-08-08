import { describe, expect, test } from 'bun:test';
import { PROMPT_AB_CASES, runPromptContractAb } from '@/../scripts/evals/prompt-contract-ab';

describe('Prompt Contract A/B runner', () => {
  test('covers the required task categories without Provider access', async () => {
    expect(new Set(PROMPT_AB_CASES.map((testCase) => testCase.category))).toEqual(
      new Set([
        'single_file_edit',
        'multi_file_plan',
        'debugging',
        'project_instructions',
        'planning_immutability',
        'tool_selection',
        'mcp_discovery',
        'approval_resume',
        'skill_activation',
        'subagent_planning',
      ]),
    );
    const report = await runPromptContractAb({ live: false });
    expect(report.status).toBe('live_eval_skipped');
    expect(report.contentLogged).toBe(false);
  });
});
