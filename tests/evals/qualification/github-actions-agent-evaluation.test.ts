import { describe, expect, test, vi } from 'bun:test';
import {
  agentQualificationEvidenceV1Schema,
  liveCompatibilityObservationV1Schema,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import { createGitHubActionsDiagnosticContractBindingForTestV1 } from '../../../scripts/evals/qualification/github-actions-agent-diagnostic-model-lease-v1';
import {
  computeGitHubActionsAgentEvaluationReportDigestV1,
  createGitHubActionsAgentEvaluationConfigV1,
  GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
  runGitHubActionsAgentEvaluationV1,
  sourceOwnedAgentEvaluationFixtureV1,
  verifyGitHubActionsAgentEvaluationRunReportV1,
} from '../../../scripts/evals/qualification/github-actions-agent-evaluation-v1';
import { releaseEvidenceV1Schema } from '../../../scripts/release/evidence-schema';
import { aiMessage } from '../../../src/core/messages';
import { createAgentTools } from '../../../src/core/tools/definitions';
import { createMockModel } from '../../mock-model';

const COMMIT = 'a'.repeat(40);

function agentReadContractBinding(model: ReturnType<typeof createMockModel>) {
  return createGitHubActionsDiagnosticContractBindingForTestV1({
    caseId: 'agent_read',
    model,
  });
}

function githubEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  job: 'preflight' | 'live-agent-evaluation' = 'live-agent-evaluation',
): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_REPOSITORY: GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: COMMIT,
    GITHUB_WORKFLOW_REF: `${GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1}/${GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: COMMIT,
    GITHUB_RUN_ID: '1234567',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: job,
    [GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1]: 'credential-sentinel-must-not-escape',
    ...overrides,
  };
}

describe('GitHub Actions real-Agent diagnostic run report', () => {
  test('pins the reviewed repository rather than accepting a caller-provided repository', () => {
    expect(GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1).toBe('ferqx/kite-code');
  });

  test('exposes exactly the sealed read_file capability to the model', () => {
    const config = createGitHubActionsAgentEvaluationConfigV1(process.cwd());

    expect(Object.keys(createAgentTools({ workspace: process.cwd(), config })).sort()).toEqual([
      'read_file',
    ]);
  });

  test('runs a real Runtime read_file cycle but never lets a local contract model claim Provider entry', async () => {
    const fixture = sourceOwnedAgentEvaluationFixtureV1();
    const model = createMockModel([
      {
        message: aiMessage({
          content: '',
          tool_calls: [
            {
              id: 'read-token',
              name: 'read_file',
              args: { path: fixture.relativePath },
            },
          ],
        }),
      },
      { message: aiMessage({ content: fixture.expectedAnswer }) },
    ]);

    const environment = githubEnvironment();
    const report = await runGitHubActionsAgentEvaluationV1({
      environment,
      binding: agentReadContractBinding(model),
    });

    expect(report).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      candidate: { commit: COMMIT },
      execution: { job: 'live-agent-evaluation' },
      result: {
        status: 'blocked',
        reasonCode: 'transport_proof_unavailable',
        providerAttempts: 2,
        modelResponses: 2,
        readFileCalls: 1,
        rejectedToolCalls: 0,
        transportDisposition: 'contract_only',
      },
    });
    expect(verifyGitHubActionsAgentEvaluationRunReportV1(report)).toEqual(report);
    // The runner cannot consume a credential. The outer CLI/aggregate
    // supervisor owns the one-shot opaque lease acquisition instead.
    expect(environment[GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1]).toBe(
      'credential-sentinel-must-not-escape',
    );
    expect(report.suite.modelLeaseSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const serialized = JSON.stringify(report);
    for (const prohibited of [
      'credential-sentinel-must-not-escape',
      fixture.expectedAnswer,
      'Read facts/verification-token.txt',
      'token-plan.cn-beijing.maas.aliyuncs.com',
      'verification-token.txt',
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  test('rejects an external path even if the model later supplies the expected answer', async () => {
    const fixture = sourceOwnedAgentEvaluationFixtureV1();
    const model = createMockModel([
      {
        message: aiMessage({
          content: '',
          tool_calls: [{ id: 'path-escape', name: 'read_file', args: { path: '../forbidden' } }],
        }),
      },
      { message: aiMessage({ content: fixture.expectedAnswer }) },
    ]);

    const report = await runGitHubActionsAgentEvaluationV1({
      environment: githubEnvironment(),
      binding: agentReadContractBinding(model),
    });

    expect(report.result).toMatchObject({
      status: 'failed',
      reasonCode: 'tool_policy_violation',
      rejectedToolCalls: 1,
    });
  });

  test('fails closed when provider usage is absent or exceeds the source-owned token cap', async () => {
    const fixture = sourceOwnedAgentEvaluationFixtureV1();
    const makeModel = () =>
      createMockModel([
        {
          message: aiMessage({
            content: '',
            tool_calls: [
              { id: 'read-token', name: 'read_file', args: { path: fixture.relativePath } },
            ],
          }),
        },
        { message: aiMessage({ content: fixture.expectedAnswer }) },
      ]);

    const noUsageModel = makeModel();
    const originalNoUsage = noUsageModel.model.doGenerate.bind(noUsageModel.model);
    noUsageModel.model.doGenerate = async () => ({
      ...(await originalNoUsage()),
      usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
    });
    const noUsageReport = await runGitHubActionsAgentEvaluationV1({
      environment: githubEnvironment(),
      binding: agentReadContractBinding(noUsageModel),
    });
    expect(noUsageReport.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'usage_unavailable',
    });

    const overCapModel = makeModel();
    const originalOverCap = overCapModel.model.doGenerate.bind(overCapModel.model);
    overCapModel.model.doGenerate = async () => ({
      ...(await originalOverCap()),
      usage: {
        inputTokens: { total: 9_000, noCache: 9_000 },
        outputTokens: { total: 50 },
        totalTokens: 9_050,
      },
    });
    const overCapReport = await runGitHubActionsAgentEvaluationV1({
      environment: githubEnvironment(),
      binding: agentReadContractBinding(overCapModel),
    });
    expect(overCapReport.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'token_quota_exceeded',
    });
  });

  test('blocks before reading a credential or dispatching a model outside the exact GitHub context', async () => {
    const model = createMockModel([{ message: aiMessage({ content: 'should-not-run' }) }]);
    const report = await runGitHubActionsAgentEvaluationV1({
      environment: githubEnvironment({ GITHUB_REF_PROTECTED: 'false' }),
      binding: agentReadContractBinding(model),
    });

    expect(report).toMatchObject({
      candidate: null,
      execution: null,
      result: { status: 'blocked', reasonCode: 'github_context_invalid', providerAttempts: 0 },
    });
    expect(model.callCount.count).toBe(0);
  });

  test('rejects an unbranded raw model before dispatching it', async () => {
    const model = createMockModel([{ message: aiMessage({ content: 'should-not-run' }) }]);
    const environment = githubEnvironment();
    const report = await runGitHubActionsAgentEvaluationV1({
      environment,
      binding: model as never,
    });

    expect(report.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'model_binding_unavailable',
      providerAttempts: 0,
      transportDisposition: 'not_observed',
    });
    expect(model.callCount.count).toBe(0);
    expect(environment[GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1]).toBe(
      'credential-sentinel-must-not-escape',
    );
  });

  test('rejects a binding issued for a different fixed diagnostic case', async () => {
    const model = createMockModel([{ message: aiMessage({ content: 'should-not-run' }) }]);
    const report = await runGitHubActionsAgentEvaluationV1({
      environment: githubEnvironment(),
      binding: createGitHubActionsDiagnosticContractBindingForTestV1({
        caseId: 'auto_compaction_success',
        model,
      }),
    });

    expect(report.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'model_binding_unavailable',
      providerAttempts: 0,
    });
    expect(model.callCount.count).toBe(0);
  });

  test('has an explicit zero-secret preflight mode and binds its distinct job identity', async () => {
    const model = createMockModel([{ message: aiMessage({ content: 'should-not-run' }) }]);
    const report = await runGitHubActionsAgentEvaluationV1({
      mode: 'preflight',
      environment: githubEnvironment(
        { [GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1]: undefined },
        'preflight',
      ),
      binding: agentReadContractBinding(model),
    });

    expect(report).toMatchObject({
      candidate: { commit: COMMIT },
      execution: { job: 'preflight' },
      result: { status: 'blocked', reasonCode: 'preflight_only', providerAttempts: 0 },
    });
    expect(model.callCount.count).toBe(0);
  });

  test('races a non-cooperative Provider operation at the AQ-8 hard deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    try {
      const model = createMockModel([{ message: aiMessage({ content: 'must-not-settle' }) }]);
      let calls = 0;
      let markEntered: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      model.model.doGenerate = async () => {
        calls++;
        markEntered?.();
        return await new Promise<never>(() => {});
      };

      const reportPromise = runGitHubActionsAgentEvaluationV1({
        environment: githubEnvironment(),
        binding: agentReadContractBinding(model),
      });
      await entered;
      expect(calls).toBe(1);
      vi.advanceTimersByTime(60_001);

      const report = await reportPromise;
      expect(report.result).toMatchObject({
        status: 'blocked',
        reasonCode: 'time_limit_exceeded',
        providerAttempts: 1,
        modelResponses: 0,
      });
      expect(calls).toBe(1);
      // The hard race terminates Runtime before the temporary process
      // boundary is restored, so no detached work retains fixture state.
      expect(process.cwd()).toBe(originalCwd);
      expect(process.env.HOME).toBe(originalHome);
    } finally {
      vi.useRealTimers();
    }
  });

  test('detects report tampering and cannot parse as either existing qualification evidence shape', async () => {
    const fixture = sourceOwnedAgentEvaluationFixtureV1();
    const model = createMockModel([
      {
        message: aiMessage({
          content: '',
          tool_calls: [
            { id: 'read-token', name: 'read_file', args: { path: fixture.relativePath } },
          ],
        }),
      },
      { message: aiMessage({ content: fixture.expectedAnswer }) },
    ]);
    const report = await runGitHubActionsAgentEvaluationV1({
      environment: githubEnvironment(),
      binding: agentReadContractBinding(model),
    });

    expect(() =>
      verifyGitHubActionsAgentEvaluationRunReportV1({
        ...report,
        result: { ...report.result, tokenBucket: 'over_2048' },
      }),
    ).toThrow('diagnostic report digest mismatch');
    expect(agentQualificationEvidenceV1Schema.safeParse(report).success).toBe(false);
    expect(liveCompatibilityObservationV1Schema.safeParse(report).success).toBe(false);
    expect(releaseEvidenceV1Schema.safeParse(report).success).toBe(false);

    const { reportDigest: _reportDigest, ...reportMaterial } = report;
    const forgedPassedResult = {
      ...report.result,
      status: 'passed' as const,
      reasonCode: 'passed' as const,
      providerAttempts: 2,
      modelResponses: 2,
      readFileCalls: 1,
      rejectedToolCalls: 0,
      transportDisposition: 'provider_fetch_entered' as const,
      durationBucket: 'under_15s' as const,
    };
    const forgedPassedReport = {
      ...report,
      candidate: null,
      execution: null,
      result: forgedPassedResult,
      reportDigest: computeGitHubActionsAgentEvaluationReportDigestV1({
        ...reportMaterial,
        candidate: null,
        execution: null,
        result: forgedPassedResult,
      }),
    };
    expect(() => verifyGitHubActionsAgentEvaluationRunReportV1(forgedPassedReport)).toThrow(
      'passed_report_invariant_failed',
    );
  });
});
