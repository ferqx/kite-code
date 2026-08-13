import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessPromptAbNonInferiority,
  assessPromptAbProviderEvidence,
  assessUnpairedPromptAbNonInferiority,
  buildPromptAbMessages,
  buildPromptAbSchedule,
  classifyPromptAbAttempt,
  countForbiddenTaskRoleViolations,
  countOverlappingToolCalls,
  isFirstDecisionCandidateQualified,
  isPromptAbCandidatePerfect,
  isPromptAbForbiddenToolCall,
  LIVE_EVAL_AUTHORIZATION_MODE,
  LIVE_EVAL_INTERACTION_MODE,
  PROJECT_INSTRUCTION_EFFECT_CASES,
  PROMPT_AB_CASES,
  resolvePromptAbRunStatus,
  runPromptContractAb,
  sanitizePromptAbSampleOutcome,
  TASK_DELEGATION_DIAGNOSTIC_CASES,
  TOOL_DESCRIPTION_CASES,
} from '@/../scripts/evals/prompt-contract-ab';
import type { AgentConfig } from '@/core/config';
import { createAgentTools } from '@/core/tools/definitions';

describe('Prompt Contract A/B runner', () => {
  test('counts only exact overlapping calls as repeats', () => {
    expect(
      countOverlappingToolCalls([
        { name: 'search_files', valid: true, args: { pattern: 'a.ts' } },
        { name: 'search_files', valid: true, args: { pattern: 'b.ts' } },
      ]),
    ).toBe(0);
    expect(
      countOverlappingToolCalls([
        { name: 'search_files', valid: true, args: { pattern: 'a.ts' } },
        { name: 'search_files', valid: true, args: { pattern: 'a.ts' } },
      ]),
    ).toBe(1);
  });
  test('covers the required task categories without Provider access', async () => {
    expect(new Set(PROMPT_AB_CASES.map((testCase) => testCase.category))).toEqual(
      new Set([
        'single_file_edit',
        'multi_file_plan',
        'debugging',
        'planning_immutability',
        'tool_selection',
        'mcp_discovery',
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

  test('has one unambiguous fixture for each targeted tool description', async () => {
    expect(TOOL_DESCRIPTION_CASES).toHaveLength(7);
    expect(TOOL_DESCRIPTION_CASES.map((testCase) => testCase.expectedTools)).toEqual([
      ['read_file'],
      ['search_files'],
      ['search_content'],
      ['tool_search'],
      ['task'],
      ['write_plan'],
      ['write_file'],
    ]);
    const report = await runPromptContractAb({
      live: false,
      comparison: 'legacy_vs_published',
      suite: 'tool_description',
    });
    expect(report.comparison).toBe('legacy_vs_published');
    expect(report.suite).toBe('tool_description');
    expect(report.caseCount).toBe(7);
  });

  test('uses production V2 project snapshots after the user turn, including nested instructions', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-prompt-ab-instructions-'));
    try {
      mkdirSync(join(workspace, 'docs'), { recursive: true });
      writeFileSync(join(workspace, 'AGENTS.md'), 'root prompt-rule', 'utf8');
      writeFileSync(join(workspace, 'docs', 'AGENTS.md'), 'nested prompt-rule', 'utf8');
      const testCase = PROJECT_INSTRUCTION_EFFECT_CASES[0]!;
      const projectionCase = { ...testCase, projectInstructionTargets: ['docs/sample.md'] };
      const legacy = buildPromptAbMessages('legacy', workspace, projectionCase);
      const v2 = buildPromptAbMessages('v2_published', workspace, projectionCase);
      expect(legacy.map((message) => String(message.content)).join('\n')).not.toContain(
        '<project-instructions',
      );
      const v2Content = v2.map((message) => String(message.content));
      const userIndex = v2Content.indexOf(testCase.prompt);
      const projectIndex = v2Content.findIndex((content) =>
        content.includes('<project-instructions role="workspace-context">'),
      );
      const runtimeIndex = v2Content.findIndex((content) => content.includes('<runtime-state'));
      expect(v2Content[projectIndex]).toContain('root prompt-rule');
      expect(v2Content[projectIndex]).toContain('nested prompt-rule');
      expect(projectIndex).toBeGreaterThan(userIndex);
      expect(runtimeIndex).toBeGreaterThan(projectIndex);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('counterbalances legacy and published V2 descriptions', () => {
    const schedule = buildPromptAbSchedule(10, TOOL_DESCRIPTION_CASES, ['legacy', 'v2_published']);
    for (const testCase of TOOL_DESCRIPTION_CASES) {
      const entries = schedule.filter((entry) => entry.caseId === testCase.id);
      expect(entries.filter((entry) => entry.order[0] === 'legacy')).toHaveLength(5);
      expect(entries.filter((entry) => entry.order[0] === 'v2_published')).toHaveLength(5);
    }
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
      expect(entries.filter((entry) => entry.order[0] === 'v2_published')).toHaveLength(5);
      expect(entries.every((entry) => new Set(entry.order).size === 2)).toBe(true);
    }
  });

  test('keeps the V2 project-rule treatment/control probe out of migration scoring', async () => {
    expect(PROJECT_INSTRUCTION_EFFECT_CASES).toHaveLength(1);
    expect(PROMPT_AB_CASES.some((entry) => entry.id === 'instructions')).toBe(false);
    const report = await runPromptContractAb({
      live: false,
      suite: 'project_instruction_effect',
    });
    expect(report.suite).toBe('project_instruction_effect');
    expect(report.caseCount).toBe(1);
  });

  test('keeps task-only reliability diagnostics out of migration scoring', async () => {
    expect(TASK_DELEGATION_DIAGNOSTIC_CASES.map((testCase) => testCase.id)).toEqual([
      'subagent-plan',
    ]);
    const report = await runPromptContractAb({
      live: false,
      suite: 'task_delegation_diagnostic',
    });
    expect(report.suite).toBe('task_delegation_diagnostic');
    expect(report.caseCount).toBe(1);
  });

  test('uses existing repository targets and the default V2 tool surface for migration cases', () => {
    expect(existsSync('src/core/model/runtime-context.ts')).toBe(true);
    expect(existsSync('src/core/tools/registry/builtins/task.ts')).toBe(true);
    const tools = createAgentTools({
      workspace: process.cwd(),
      phase: 'planning',
      config: { features: { promptContractV2: true } } as AgentConfig,
      toolSearch: true,
      subagentEventSink: () => {},
    });
    expect(tools).toHaveProperty('tool_search');
    expect(tools).toHaveProperty('task');
    expect(tools).not.toHaveProperty('activate_skill');
  });

  test('builds every real-model evaluation context in full interaction mode', () => {
    const messages = buildPromptAbMessages('v2_published', process.cwd(), PROMPT_AB_CASES[0]!);
    const runtime = messages
      .map((message) => String(message.content))
      .find((content) => content.includes('<runtime-state'));
    expect(LIVE_EVAL_INTERACTION_MODE).toBe('full');
    expect(LIVE_EVAL_AUTHORIZATION_MODE).toBe('full_access');
    expect(runtime).toContain('interaction_mode: full');
    expect(runtime).toContain('authorization_mode: full_access');
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

  test('uses comparison-neutral paired outcomes without changing default compatibility inputs', () => {
    expect(
      assessPromptAbNonInferiority({
        bothPassed: 80,
        baselineOnly: 3,
        candidateOnly: 5,
        bothFailed: 12,
      }).status,
    ).toBe('passed');
  });

  test('rejects a candidate with complete provider evidence unless every admission gate passes', () => {
    const evidence = assessPromptAbProviderEvidence({
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
    });
    const nonInferiority = assessPromptAbNonInferiority({
      bothPassed: 95,
      baselineOnly: 0,
      candidateOnly: 5,
      bothFailed: 0,
    });
    expect(
      resolvePromptAbRunStatus({
        providerEvidence: evidence,
        providerEvidenceByArm: { baseline: evidence, candidate: evidence },
        candidatePerfect: false,
        nonInferiority,
      }),
    ).toBe('candidate_rejected');
    expect(
      resolvePromptAbRunStatus({
        providerEvidence: evidence,
        providerEvidenceByArm: { baseline: evidence, candidate: evidence },
        candidatePerfect: true,
        nonInferiority,
      }),
    ).toBe('completed');
  });

  test('keeps repeated tool calls inside the candidate admission gate', () => {
    expect(
      isPromptAbCandidatePerfect({
        attempts: 10,
        passed: 10,
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 1,
        safetyViolations: 0,
        caseBreakdown: [{ attempts: 10, passed: 10 }],
      }),
    ).toBe(false);
  });

  test('moves task argument recovery out of the first-decision admission gate', () => {
    expect(
      isFirstDecisionCandidateQualified({
        attempts: 70,
        passed: 60,
        invalidToolCalls: 0,
        repeatedToolCalls: 0,
        safetyViolations: 0,
        caseBreakdown: [
          { category: 'tool_selection', attempts: 10, passed: 9, invalidArgumentCalls: 0 },
          { category: 'subagent_planning', attempts: 10, passed: 8, invalidArgumentCalls: 3 },
        ],
      }),
    ).toBe(true);
    expect(
      isFirstDecisionCandidateQualified({
        attempts: 70,
        passed: 60,
        invalidToolCalls: 0,
        repeatedToolCalls: 0,
        safetyViolations: 0,
        caseBreakdown: [
          { category: 'tool_selection', attempts: 10, passed: 9, invalidArgumentCalls: 1 },
        ],
      }),
    ).toBe(false);
  });

  test('requires an absolute first-decision quality floor in addition to non-inferiority', () => {
    expect(
      isFirstDecisionCandidateQualified({
        attempts: 70,
        passed: 0,
        invalidToolCalls: 0,
        repeatedToolCalls: 0,
        safetyViolations: 0,
        caseBreakdown: [
          { category: 'tool_selection', attempts: 10, passed: 0, invalidArgumentCalls: 0 },
        ],
      }),
    ).toBe(false);
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

  test('retains privacy-safe per-sample evidence without argument values or model content', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'subagent-plan')!;
    const outcome = sanitizePromptAbSampleOutcome({
      run: 4,
      testCase,
      arm: 'v2_published',
      orderPosition: 2,
      calls: [
        {
          name: 'task',
          valid: false,
          args: { task: 'sensitive task body', subagent_type: 'plan' },
          invalidArgumentField: 'task',
          subagentType: 'plan',
        },
      ],
      classification: {
        passed: false,
        failureClasses: ['invalid_expected_tool_call', 'invalid_arguments'],
      },
    });
    expect(outcome).toEqual({
      run: 4,
      caseId: 'subagent-plan',
      category: 'subagent_planning',
      arm: 'v2_published',
      orderPosition: 2,
      passed: false,
      selectedToolNames: ['task'],
      validCallCount: 0,
      invalidCallCount: 1,
      argumentShapes: ['object'],
      invalidArgumentLocations: ['task'],
      shellEffects: [],
      failureClasses: ['invalid_expected_tool_call', 'invalid_arguments'],
    });
    expect(JSON.stringify(outcome)).not.toContain('sensitive task body');
  });

  test('uses the production shell classifier instead of forbidding every planning shell call', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'plan-write-trap')!;
    const readOnlyCall = {
      name: 'shell_execute',
      valid: true,
      args: { command: 'pwd' },
      shellEffect: 'read_only' as const,
    };
    const writeCall = {
      name: 'shell_execute',
      valid: true,
      args: { command: 'touch changed.txt' },
      shellEffect: 'side_effectful' as const,
    };
    expect(isPromptAbForbiddenToolCall(testCase, readOnlyCall)).toBe(false);
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [readOnlyCall],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }),
    ).toEqual({ passed: true, failureClasses: [] });
    expect(isPromptAbForbiddenToolCall(testCase, writeCall)).toBe(true);
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [writeCall],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }),
    ).toEqual({ passed: false, failureClasses: ['forbidden_tool_selected'] });
  });

  test('records only planning shell effect classes, never command text', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'plan-write-trap')!;
    const outcome = sanitizePromptAbSampleOutcome({
      run: 1,
      testCase,
      arm: 'v2_published',
      orderPosition: 1,
      calls: [
        {
          name: 'shell_execute',
          valid: true,
          args: { command: 'sensitive command text' },
          shellEffect: 'side_effectful',
        },
      ],
      classification: { passed: false, failureClasses: ['forbidden_tool_selected'] },
    });
    expect(outcome.shellEffects).toEqual(['side_effectful']);
    expect(outcome.argumentShapes).toEqual(['object']);
    expect(JSON.stringify(outcome)).not.toContain('sensitive command text');
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

  test('requires the instruction-selected path in the V2 project-rule probe', () => {
    const testCase = PROJECT_INSTRUCTION_EFFECT_CASES[0]!;
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [{ name: 'read_file', valid: true, args: { path: 'AGENTS.md' } }],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }),
    ).toEqual({ passed: false, failureClasses: ['expected_arguments_mismatch'] });
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [{ name: 'read_file', valid: true, args: { path: 'rules/required.md' } }],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }).passed,
    ).toBe(true);
    expect(
      classifyPromptAbAttempt({
        testCase,
        calls: [{ name: 'read_file', valid: true, args: { path: './rules/required.md' } }],
        invalidToolCalls: 0,
        invalidArgumentCalls: 0,
        repeatedToolCalls: 0,
      }).passed,
    ).toBe(true);
  });

  test('counts a forbidden task role for the task-level safety aggregate', () => {
    const testCase = PROMPT_AB_CASES.find((entry) => entry.id === 'subagent-plan')!;
    expect(
      countForbiddenTaskRoleViolations(testCase, [
        { name: 'task', valid: true, subagentType: 'code' },
      ]),
    ).toBe(1);
  });
});
