import { describe, expect, test } from 'bun:test';
import {
  APPROVED_AGENT_TASK_CASE_IDS_V1,
  APPROVED_AGENT_TASK_SUITE_V1,
  parseApprovedAgentTaskSuite,
} from './approved-suite';

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

describe('D-07 approved Agent task suite', () => {
  test('has the immutable approved identity and canonical digest', () => {
    const parsed = parseApprovedAgentTaskSuite(APPROVED_AGENT_TASK_SUITE_V1);
    expect(parsed.decision).toEqual({
      id: 'D-07',
      status: 'approved',
      scope: 'single_maintainer_first_local_development',
      approver: 'github:@ferqx',
    });
    expect(parsed.cases.map((task) => task.caseId)).toEqual([...APPROVED_AGENT_TASK_CASE_IDS_V1]);
    expect(parsed.suiteDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed.cases)).toBeTrue();
    expect(Object.isFrozen(parsed.cases[0]?.requiredChecks)).toBeTrue();
  });

  test('locks the approved distributions and covers all eight categories', () => {
    const cases = APPROVED_AGENT_TASK_SUITE_V1.cases;
    expect(counts(cases.map((task) => task.difficulty))).toEqual({
      simple: 4,
      medium: 6,
      complex: 2,
    });
    expect(counts(cases.map((task) => task.contextClass))).toEqual({ short: 8, long: 4 });
    expect(counts(cases.map((task) => task.accessMode))).toEqual({
      read_only: 3,
      workspace_write: 9,
    });
    expect(counts(cases.map((task) => task.expectedInteractions.entrypoint))).toEqual({
      headless_cli: 8,
      tui: 4,
    });
    expect(new Set(cases.map((task) => task.category))).toEqual(
      new Set([
        'repository_research',
        'bug_fix',
        'small_feature',
        'refactor',
        'test',
        'documentation',
        'failure_recovery',
        'adversarial',
      ]),
    );
  });

  test('uses the approved local language/build matrix with MCP write and effectful Skills off', () => {
    const cases = APPROVED_AGENT_TASK_SUITE_V1.cases;
    expect(new Set(cases.map((task) => task.primaryLanguage))).toEqual(
      new Set(['typescript', 'javascript', 'language-neutral']),
    );
    expect(new Set(cases.map((task) => task.buildSystem))).toEqual(
      new Set(['bun', 'node', 'none']),
    );
    expect(cases.every((task) => task.fixtureId === 'approved-local-dev-v1')).toBeTrue();
    expect(cases.every((task) => task.repositoryType === 'synthetic_local')).toBeTrue();
    expect(cases.every((task) => task.capabilities.mcp === false)).toBeTrue();
    expect(
      cases.flatMap((task) => task.requiredChecks).every((check) => check.network === 'off'),
    ).toBe(true);
    expect(APPROVED_AGENT_TASK_SUITE_V1.capabilityPolicy).toEqual({
      mcpWrite: 'excluded',
      effectfulSkills: 'excluded',
    });
  });

  test('contains no live or external execution claim', () => {
    expect(APPROVED_AGENT_TASK_SUITE_V1.executionEvidence).toEqual({
      status: 'not_observed',
      evidenceEligible: false,
      executionClass: 'definition_only',
      liveProvider: 'off',
      externalCohort: 'off',
    });

    const fabricated = structuredClone(APPROVED_AGENT_TASK_SUITE_V1) as unknown as Record<
      string,
      unknown
    >;
    fabricated.runId = 123;
    expect(() => parseApprovedAgentTaskSuite(fabricated)).toThrow('unknown fields');
  });

  test('rejects distribution, identity, capability, and digest tampering', () => {
    const distribution = structuredClone(APPROVED_AGENT_TASK_SUITE_V1);
    const first = distribution.cases[0];
    if (!first) throw new Error('approved suite unexpectedly empty');
    first.difficulty = 'complex';
    expect(() => parseApprovedAgentTaskSuite(distribution)).toThrow('difficulty.simple');

    const capability = structuredClone(APPROVED_AGENT_TASK_SUITE_V1);
    const capabilityCase = capability.cases[0];
    if (!capabilityCase) throw new Error('approved suite unexpectedly empty');
    capabilityCase.capabilities.mcp = true;
    expect(() => parseApprovedAgentTaskSuite(capability)).toThrow('excluded MCP');

    const digest = structuredClone(APPROVED_AGENT_TASK_SUITE_V1);
    digest.suiteDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => parseApprovedAgentTaskSuite(digest)).toThrow('digest');
  });
});
