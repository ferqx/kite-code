import { describe, expect, test } from 'bun:test';
import {
  assessPromptAbNonInferiority,
  assessPromptAbProviderEvidence,
  assessUnpairedPromptAbNonInferiority,
  buildPromptAbSchedule,
  classifyPromptAbAttempt,
  PROMPT_AB_CASES,
  runPromptContractAb,
} from '@/../scripts/evals/prompt-contract-ab';

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
    expect(report.schema).toBe('FirstDecisionEvalV1');
    expect(report.evaluationScope).toBe('first_decision_only');
    expect(report.status).toBe('live_eval_skipped');
    expect(report.schedule).toBe('counterbalanced_ab_ba');
    expect(report.configuredRuns).toBe(10);
    expect(report.maxOutputTokens).toBe(1024);
    expect(report.contentLogged).toBe(false);

    const invalidRunsReport = await runPromptContractAb({ live: false, runs: Number.NaN });
    expect(invalidRunsReport.configuredRuns).toBe(10);
  });

  test('requires complete provider accounting evidence for every model attempt', () => {
    expect(
      assessPromptAbProviderEvidence({
        expectedModelAttempts: 2,
        modelAttemptsStarted: 2,
        modelResponsesSucceeded: 2,
        httpRequestsDispatched: 2,
        httpResponsesReceived: 2,
        http2xxResponses: 2,
        httpTransportFailures: 0,
        responsesWithUsage: 2,
        responsesWithProviderId: 2,
        uniqueProviderResponseIds: 2,
        inputTokens: 200,
        outputTokens: 20,
        totalTokens: 220,
        cacheReadTokens: 50,
      }),
    ).toMatchObject({ status: 'verified', failures: [] });

    expect(
      assessPromptAbProviderEvidence({
        expectedModelAttempts: 2,
        modelAttemptsStarted: 2,
        modelResponsesSucceeded: 2,
        httpRequestsDispatched: 2,
        httpResponsesReceived: 2,
        http2xxResponses: 2,
        httpTransportFailures: 0,
        responsesWithUsage: 0,
        responsesWithProviderId: 1,
        uniqueProviderResponseIds: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
      }).failures,
    ).toEqual(['usage_coverage_mismatch', 'usage_total_zero', 'response_id_coverage_mismatch']);

    expect(
      assessPromptAbProviderEvidence({
        expectedModelAttempts: 2,
        modelAttemptsStarted: 2,
        modelResponsesSucceeded: 2,
        httpRequestsDispatched: 3,
        httpResponsesReceived: 3,
        http2xxResponses: 3,
        httpTransportFailures: 0,
        responsesWithUsage: 2,
        responsesWithProviderId: 2,
        uniqueProviderResponseIds: 2,
        inputTokens: 200,
        outputTokens: 20,
        totalTokens: 220,
        cacheReadTokens: 50,
      }).failures,
    ).toEqual(['http_dispatch_missing', 'http_success_count_mismatch']);
  });

  test('counterbalances legacy and V2 first position for every case', () => {
    const schedule = buildPromptAbSchedule(10);
    expect(schedule).toHaveLength(PROMPT_AB_CASES.length * 10);
    for (const testCase of PROMPT_AB_CASES) {
      const entries = schedule.filter((entry) => entry.caseId === testCase.id);
      expect(entries.filter((entry) => entry.order[0] === 'legacy')).toHaveLength(5);
      expect(entries.filter((entry) => entry.order[0] === 'v2')).toHaveLength(5);
      expect(entries.every((entry) => new Set(entry.order).size === 2)).toBe(true);
    }
  });

  test('classifies the final-candidate aggregate as statistically inconclusive', () => {
    const assessment = assessUnpairedPromptAbNonInferiority({
      legacyPassed: 25,
      legacyAttempts: 30,
      v2Passed: 23,
      v2Attempts: 30,
    });
    expect(assessment.margin).toBe(0.05);
    expect(assessment.method).toBe('unpaired_rate_difference');
    expect(assessment.confidenceLevel).toBe(0.95);
    expect(assessment.successRateDelta).toBeCloseTo(-2 / 30);
    expect(assessment.interval.lower).toBeLessThan(-0.05);
    expect(assessment.interval.upper).toBeGreaterThan(-0.05);
    expect(assessment.status).toBe('inconclusive');
  });

  test('distinguishes a non-inferior result from a clear regression', () => {
    expect(
      assessPromptAbNonInferiority({
        bothPassed: 80,
        legacyOnly: 3,
        v2Only: 5,
        bothFailed: 12,
      }).status,
    ).toBe('passed');
    expect(
      assessPromptAbNonInferiority({
        bothPassed: 60,
        legacyOnly: 30,
        v2Only: 0,
        bothFailed: 10,
      }).status,
    ).toBe('failed');
  });

  test('reports only fixed failure classes for category diagnostics', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'plan-write-trap')!;
    const classification = classifyPromptAbAttempt({
      testCase,
      calls: [
        { name: 'write_file', valid: true },
        { name: 'write_file', valid: true },
        { name: 'unknown_tool', valid: false },
      ],
      invalidToolCalls: 1,
      invalidArgumentCalls: 1,
      repeatedToolCalls: 1,
    });
    expect(classification.passed).toBe(false);
    expect(classification.failureClasses).toEqual([
      'forbidden_tool_selected',
      'invalid_tool_call',
      'invalid_arguments',
      'repeated_tool_call',
    ]);
  });

  test('treats a safe planning refusal as a successful immutability outcome', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'plan-write-trap')!;
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }),
    ).toEqual({ passed: true, failureClasses: [] });
  });

  test('requires a valid planning subagent call for the delegation case', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'subagent-plan')!;
    expect(testCase.prompt).toContain('scripts/evals/prompt-contract-ab.ts');
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [{ name: 'task', valid: true, subagentType: 'plan' }],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }),
    ).toEqual({ passed: true, failureClasses: [] });
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [
          {
            name: 'task',
            valid: false,
            invalidArgumentField: 'task',
            subagentType: 'unknown',
          },
        ],
        invalidToolCalls: 0,
        invalidArgumentCalls: 1,
        repeatedToolCalls: 0,
      }).failureClasses,
    ).toEqual(['invalid_expected_tool_call', 'invalid_arguments', 'task_argument_invalid']);
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [{ name: 'task', valid: true, subagentType: 'code' }],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }),
    ).toEqual({
      passed: false,
      failureClasses: ['wrong_subagent_type', 'forbidden_subagent_type'],
    });
  });
});
