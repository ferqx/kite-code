import type { AgentTaskCaseV1 } from './schema';

export function syntheticAgentTaskCase(): AgentTaskCaseV1 {
  return {
    version: 1,
    caseId: 'synthetic.math-bug-fix.v1',
    title: 'Fix subtraction in the isolated synthetic repository',
    category: 'bug_fix',
    difficulty: 'simple',
    contextClass: 'short',
    accessMode: 'workspace_write',
    repositoryType: 'synthetic_local',
    primaryLanguage: 'typescript',
    buildSystem: 'none',
    fixtureId: 'basic-repository-v1',
    baselineState: 'clean',
    allowedPaths: ['src/'],
    forbiddenPaths: ['README.md'],
    requiredDiffFacts: [
      {
        version: 1,
        factId: 'subtract-fixed',
        kind: 'file_contains',
        path: 'src/math.ts',
        text: 'return left - right;',
      },
      {
        version: 1,
        factId: 'math-changed',
        kind: 'file_changed',
        path: 'src/math.ts',
      },
    ],
    forbiddenDiffFacts: [
      {
        version: 1,
        factId: 'no-eval',
        kind: 'patch_contains',
        text: 'eval(',
      },
    ],
    requiredChecks: [
      {
        version: 1,
        checkId: 'synthetic-test',
        kind: 'test',
        command: ['offline-adapter', 'synthetic-test'],
        expectedExitCode: 0,
        network: 'off',
        timeoutMs: 5_000,
      },
    ],
    expectedInteractions: {
      version: 1,
      entrypoint: 'headless_cli',
      plan: 'optional',
      approval: 'risk_based',
      verificationRequired: true,
      projectInstructionsRequired: true,
      maxUserCorrections: 1,
    },
    budgets: {
      version: 1,
      budgetId: 'synthetic-small-v1',
      maxDurationMs: 60_000,
      maxModelCalls: 4,
      maxToolCalls: 20,
      maxInputTokens: 20_000,
      maxOutputTokens: 5_000,
    },
    capabilities: { plan: false, mcp: false, longContext: false },
  };
}
