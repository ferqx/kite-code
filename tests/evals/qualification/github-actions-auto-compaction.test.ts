import { describe, expect, test, vi } from 'bun:test';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import {
  agentQualificationEvidenceV1Schema,
  liveCompatibilityObservationV1Schema,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import { createGitHubActionsDiagnosticContractBindingForTestV1 } from '../../../scripts/evals/qualification/github-actions-agent-diagnostic-model-lease-v1';
import {
  GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
} from '../../../scripts/evals/qualification/github-actions-agent-evaluation-v1';
import {
  computeGitHubActionsAutoCompactionDiagnosticReportDigestV1,
  createGitHubActionsAutoCompactionDiagnosticConfigV1,
  GITHUB_ACTIONS_AUTO_COMPACTION_DIAGNOSTIC_REPORT_SCHEMA_V1,
  runGitHubActionsAutoCompactionDiagnosticV1,
  verifyGitHubActionsAutoCompactionDiagnosticReportV1,
} from '../../../scripts/evals/qualification/github-actions-auto-compaction-v1';
import { releaseEvidenceV1Schema } from '../../../scripts/release/evidence-schema';
import { aiMessage } from '../../../src/core/messages';
import { createMockModel } from '../../mock-model';

const COMMIT = 'b'.repeat(40);

function githubEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_REPOSITORY: GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: COMMIT,
    GITHUB_WORKFLOW_REF: `${GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1}/${GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: COMMIT,
    GITHUB_RUN_ID: '87654321',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'live-agent-evaluation',
    ...overrides,
  };
}

function successModel() {
  return createMockModel([
    { message: aiMessage({ content: `${'safe summary '.repeat(298)}safe` }) },
    { message: aiMessage({ content: 'safe primary result' }) },
  ]);
}

function contractBinding(
  caseId: 'auto_compaction_success' | 'auto_compaction_cancel',
  model:
    | ReturnType<typeof successModel>
    | ReturnType<typeof abortingSummaryModel>
    | ReturnType<typeof abortIgnoringSummaryModel>,
) {
  return createGitHubActionsDiagnosticContractBindingForTestV1({ caseId, model });
}

function abortingSummaryModel(): {
  model: LanguageModelV4;
  callCount: { count: number };
  setRetryListener(): void;
} {
  const callCount = { count: 0 };
  return {
    model: {
      specificationVersion: 'v4',
      provider: 'github-actions-auto-compaction-test',
      modelId: 'github-actions-auto-compaction-test',
      supportedUrls: {},
      async doGenerate(
        options: LanguageModelV4CallOptions,
      ): Promise<LanguageModelV4GenerateResult> {
        callCount.count += 1;
        return await new Promise<LanguageModelV4GenerateResult>((_resolve, reject) => {
          const abort = () => reject(new DOMException('test abort', 'AbortError'));
          if (options.abortSignal?.aborted) abort();
          else options.abortSignal?.addEventListener('abort', abort, { once: true });
        });
      },
      async doStream(): Promise<never> {
        throw new Error('streaming_not_admitted');
      },
    },
    callCount,
    setRetryListener() {},
  };
}

function abortIgnoringSummaryModel(): {
  model: LanguageModelV4;
  callCount: { count: number };
  setRetryListener(): void;
} {
  const callCount = { count: 0 };
  return {
    model: {
      specificationVersion: 'v4',
      provider: 'github-actions-auto-compaction-test',
      modelId: 'github-actions-auto-compaction-test',
      supportedUrls: {},
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        callCount.count += 1;
        return {
          content: [{ type: 'text', text: `${'safe summary '.repeat(298)}safe` }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 100, text: 100, reasoning: 0 },
          },
          warnings: [],
        };
      },
      async doStream(): Promise<never> {
        throw new Error('streaming_not_admitted');
      },
    },
    callCount,
    setRetryListener() {},
  };
}

function nonCooperativeSummaryModel(): {
  model: LanguageModelV4;
  callCount: { count: number };
  entered: Promise<void>;
  setRetryListener(): void;
} {
  const callCount = { count: 0 };
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return {
    model: {
      specificationVersion: 'v4',
      provider: 'github-actions-auto-compaction-test',
      modelId: 'github-actions-auto-compaction-test',
      supportedUrls: {},
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        callCount.count += 1;
        markEntered?.();
        return await new Promise<LanguageModelV4GenerateResult>(() => {});
      },
      async doStream(): Promise<never> {
        throw new Error('streaming_not_admitted');
      },
    },
    callCount,
    entered,
    setRetryListener() {},
  };
}

describe('GitHub Actions auto-compaction diagnostic', () => {
  test('uses the product chain, but a local contract binding cannot claim a real-model success path', async () => {
    const model = successModel();
    const report = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'success',
      environment: githubEnvironment(),
      binding: contractBinding('auto_compaction_success', model),
    });

    expect(report).toMatchObject({
      schema: GITHUB_ACTIONS_AUTO_COMPACTION_DIAGNOSTIC_REPORT_SCHEMA_V1,
      authority: 'diagnostic',
      evidenceEligible: false,
      candidate: { commit: COMMIT },
      execution: { job: 'live-agent-evaluation' },
      result: {
        scenario: 'success',
        status: 'blocked',
        reasonCode: 'transport_proof_unavailable',
        outcome: 'not_observed',
        providerAttempts: 2,
        summaryDispatches: 1,
        primaryDispatches: 1,
        automaticCompactionRequests: 1,
        transportDisposition: 'contract_only',
      },
    });
    expect(model.callCount.count).toBe(2);
    expect(verifyGitHubActionsAutoCompactionDiagnosticReportV1(report)).toEqual(report);
  });

  test('drives cancellation state-machine coverage locally but cannot claim Provider transport entry', async () => {
    const model = abortingSummaryModel();
    const report = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'cancel',
      environment: githubEnvironment(),
      binding: contractBinding('auto_compaction_cancel', model),
    });

    expect(report.result).toEqual(
      expect.objectContaining({
        scenario: 'cancel',
        status: 'blocked',
        reasonCode: 'transport_proof_unavailable',
        outcome: 'not_observed',
        providerAttempts: 1,
        summaryDispatches: 1,
        primaryDispatches: 0,
        automaticCompactionRequests: 2,
        nextUserTurnRetryPreflight: true,
        transportDisposition: 'contract_only',
      }),
    );
    expect(model.callCount.count).toBe(1);
    expect(verifyGitHubActionsAutoCompactionDiagnosticReportV1(report)).toEqual(report);
  });

  test('blocks before dispatch outside protected manual GitHub context or when externally cancelled', async () => {
    const model = successModel();
    const contextReport = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'success',
      environment: githubEnvironment({ GITHUB_REF_PROTECTED: 'false' }),
      binding: contractBinding('auto_compaction_success', model),
    });
    expect(contextReport).toMatchObject({
      candidate: null,
      execution: null,
      result: { status: 'blocked', reasonCode: 'github_context_invalid', providerAttempts: 0 },
    });
    expect(model.callCount.count).toBe(0);

    const abortController = new AbortController();
    abortController.abort('test external cancellation');
    const cancellationReport = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'cancel',
      environment: githubEnvironment(),
      binding: contractBinding('auto_compaction_cancel', successModel()),
      signal: abortController.signal,
    });
    expect(cancellationReport.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'external_cancelled',
      providerAttempts: 0,
    });
  });

  test('rejects an unbranded pre-transport model object before it can dispatch', async () => {
    const model = successModel();
    const report = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'success',
      environment: githubEnvironment(),
      binding: model as never,
    });

    expect(report.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'model_binding_unavailable',
      providerAttempts: 0,
      transportDisposition: 'not_observed',
    });
    expect(model.callCount.count).toBe(0);
  });

  test('does not pass an abort that the bound model fails to observe and never dispatches primary afterward', async () => {
    const model = abortIgnoringSummaryModel();
    const report = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'cancel',
      environment: githubEnvironment(),
      binding: contractBinding('auto_compaction_cancel', model),
    });

    expect(report.result.status).not.toBe('passed');
    expect(report.result.primaryDispatches).toBe(0);
    expect(model.callCount.count).toBe(1);
  });

  test('fails closed on missing usage and serializes no Provider-sensitive content', async () => {
    const model = successModel();
    const original = model.model.doGenerate.bind(model.model);
    model.model.doGenerate = async () => ({
      ...(await original()),
      usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
    });
    const report = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'success',
      environment: githubEnvironment(),
      binding: contractBinding('auto_compaction_success', model),
    });
    expect(report.result).toMatchObject({ status: 'blocked', reasonCode: 'usage_unavailable' });

    const serialized = JSON.stringify(report);
    for (const prohibited of [
      'safe summary',
      'safe primary result',
      'github-actions-auto-compaction-synthetic-root-v1',
      'https://diagnostic.invalid',
      'credential',
      'token-plan.cn-beijing.maas.aliyuncs.com',
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  test('does not use product model-window configuration and cannot parse as formal or release evidence', async () => {
    const config = createGitHubActionsAutoCompactionDiagnosticConfigV1();
    expect(JSON.stringify(config)).not.toContain('contextWindowTokens');
    expect(config.executionCapabilitySurface).toEqual({
      inProcessReadOnlyTools: null,
      network: false,
      process: false,
      write: false,
      workspaceWrite: false,
      shell: false,
      skillChild: false,
      localStdioMcp: false,
    });

    const report = await runGitHubActionsAutoCompactionDiagnosticV1({
      scenario: 'success',
      environment: githubEnvironment(),
      binding: contractBinding('auto_compaction_success', successModel()),
    });
    expect(agentQualificationEvidenceV1Schema.safeParse(report).success).toBe(false);
    expect(liveCompatibilityObservationV1Schema.safeParse(report).success).toBe(false);
    expect(releaseEvidenceV1Schema.safeParse(report).success).toBe(false);

    const { reportDigest: _reportDigest, ...material } = report;
    expect(() =>
      verifyGitHubActionsAutoCompactionDiagnosticReportV1({
        ...report,
        suite: { ...report.suite, model: 'not-qwen' },
        reportDigest: computeGitHubActionsAutoCompactionDiagnosticReportDigestV1({
          ...material,
          suite: { ...report.suite, model: 'not-qwen' },
        }),
      }),
    ).toThrow('source_owned_suite_mismatch');
  });

  test('makes a wall-clock overrun blocked even when an operation otherwise completes', async () => {
    const originalNow = Date.now;
    let reads = 0;
    Date.now = () => (reads++ === 0 ? 0 : 60_001);
    try {
      const report = await runGitHubActionsAutoCompactionDiagnosticV1({
        scenario: 'success',
        environment: githubEnvironment(),
        binding: contractBinding('auto_compaction_success', successModel()),
      });
      expect(report.result).toMatchObject({
        status: 'blocked',
        reasonCode: 'time_limit_exceeded',
        durationBucket: 'over_60s',
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test('races a non-cooperative model operation against the hard deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const model = nonCooperativeSummaryModel();
      const reportPromise = runGitHubActionsAutoCompactionDiagnosticV1({
        scenario: 'success',
        environment: githubEnvironment(),
        binding: contractBinding('auto_compaction_success', model),
      });
      await model.entered;
      expect(model.callCount.count).toBe(1);
      vi.advanceTimersByTime(60_001);
      const report = await reportPromise;
      expect(report.result).toMatchObject({
        status: 'blocked',
        reasonCode: 'time_limit_exceeded',
        primaryDispatches: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
