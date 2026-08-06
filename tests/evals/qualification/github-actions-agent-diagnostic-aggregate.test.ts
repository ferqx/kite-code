import { describe, expect, test } from 'bun:test';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  agentQualificationEvidenceV1Schema,
  liveCompatibilityObservationV1Schema,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  computeGitHubActionsAgentDiagnosticAggregateReportDigestV1,
  GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_REPORT_SCHEMA_V1,
  runGitHubActionsAgentDiagnosticAggregateV1,
  verifyGitHubActionsAgentDiagnosticAggregateReportV1,
} from '../../../scripts/evals/qualification/github-actions-agent-diagnostic-aggregate-v1';
import {
  createGitHubActionsDiagnosticContractLeaseForTestV1,
  GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1,
} from '../../../scripts/evals/qualification/github-actions-agent-diagnostic-model-lease-v1';
import {
  GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
  sourceOwnedAgentEvaluationFixtureV1,
} from '../../../scripts/evals/qualification/github-actions-agent-evaluation-v1';
import { releaseEvidenceV1Schema } from '../../../scripts/release/evidence-schema';
import { aiMessage } from '../../../src/core/messages';
import type { SupportedChatModel } from '../../../src/core/model/factory';
import { createMockModel } from '../../mock-model';

const COMMIT = 'c'.repeat(40);

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
    GITHUB_RUN_ID: '91234567',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'live-agent-evaluation',
    ...overrides,
  };
}

function agentReadModel() {
  const fixture = sourceOwnedAgentEvaluationFixtureV1();
  return createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [{ id: 'read-token', name: 'read_file', args: { path: fixture.relativePath } }],
      }),
    },
    { message: aiMessage({ content: fixture.expectedAnswer }) },
  ]);
}

function autoCompactionSuccessModel() {
  return createMockModel([
    { message: aiMessage({ content: `${'safe summary '.repeat(298)}safe` }) },
    { message: aiMessage({ content: 'safe primary result' }) },
  ]);
}

function autoCompactionCancelledModel(): SupportedChatModel {
  return {
    model: {
      specificationVersion: 'v4',
      provider: 'github-actions-aggregate-test',
      modelId: 'github-actions-aggregate-test',
      supportedUrls: {},
      async doGenerate(
        options: LanguageModelV4CallOptions,
      ): Promise<LanguageModelV4GenerateResult> {
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
    supportsToolCalls: false,
    capabilityMetadata: { maxOutputTokens: 600, streaming: false },
    setRetryListener: () => {},
  };
}

function contractLease() {
  return createGitHubActionsDiagnosticContractLeaseForTestV1({
    agent_read: agentReadModel(),
    auto_compaction_success: autoCompactionSuccessModel(),
    auto_compaction_cancel: autoCompactionCancelledModel(),
  });
}

describe('GitHub Actions real-Agent diagnostic aggregate', () => {
  test('freshly verifies all fixed local contract cases but cannot claim a live aggregate', async () => {
    const report = await runGitHubActionsAgentDiagnosticAggregateV1({
      environment: githubEnvironment(),
      lease: contractLease(),
    });

    expect(report).toMatchObject({
      schema: GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_REPORT_SCHEMA_V1,
      authority: 'diagnostic',
      evidenceEligible: false,
      candidate: { commit: COMMIT },
      execution: { job: 'live-agent-evaluation' },
      result: {
        status: 'blocked',
        reasonCode: 'transport_proof_unavailable',
        providerAttempts: 5,
        verifiedChildCount: 3,
        transportDisposition: 'contract_only',
      },
    });
    expect(report.caseReports.map((child) => child?.result.status)).toEqual([
      'blocked',
      'blocked',
      'blocked',
    ]);
    expect(verifyGitHubActionsAgentDiagnosticAggregateReportV1(report)).toEqual(report);
    expect(agentQualificationEvidenceV1Schema.safeParse(report).success).toBe(false);
    expect(liveCompatibilityObservationV1Schema.safeParse(report).success).toBe(false);
    expect(releaseEvidenceV1Schema.safeParse(report).success).toBe(false);
  });

  test('does not acquire a credential or dispatch outside the aggregate-owned lease', async () => {
    const environment = githubEnvironment({
      [GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]: 'aggregate-test-sentinel',
    });
    const report = await runGitHubActionsAgentDiagnosticAggregateV1({ environment });

    expect(report.result).toMatchObject({
      status: 'blocked',
      reasonCode: 'model_lease_unavailable',
      providerAttempts: 0,
      verifiedChildCount: 0,
    });
    expect(environment[GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]).toBe('aggregate-test-sentinel');
  });

  test('rejects a recomputed aggregate whose child report digest has been tampered', async () => {
    const report = await runGitHubActionsAgentDiagnosticAggregateV1({
      environment: githubEnvironment(),
      lease: contractLease(),
    });
    const [agentRead, autoSuccess, autoCancel] = report.caseReports;
    const { reportDigest: _reportDigest, ...material } = report;
    expect(() =>
      verifyGitHubActionsAgentDiagnosticAggregateReportV1({
        ...report,
        caseReports: [
          agentRead ? { ...agentRead, reportDigest: `sha256:${'0'.repeat(64)}` } : null,
          autoSuccess,
          autoCancel,
        ],
        reportDigest: computeGitHubActionsAgentDiagnosticAggregateReportDigestV1({
          ...material,
          caseReports: [
            agentRead ? { ...agentRead, reportDigest: `sha256:${'0'.repeat(64)}` } : null,
            autoSuccess,
            autoCancel,
          ],
        }),
      }),
    ).toThrow('diagnostic report digest mismatch');
  });
});
