import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';
import {
  acquireGitHubActionsDiagnosticModelLeaseV1,
  GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1,
  GITHUB_ACTIONS_DIAGNOSTIC_MODEL_LEASE_SCHEMA_V1,
  GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1,
  type GitHubActionsDiagnosticModelBindingV1,
  type GitHubActionsDiagnosticModelLeaseV1,
  isGitHubActionsDiagnosticModelBindingV1,
} from './github-actions-agent-diagnostic-model-lease-v1';
import {
  buildGitHubActionsAgentEvaluationSuiteV1,
  computeWorkflowIdentityDigestV1,
  GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
  type GitHubActionsAgentEvaluationRunReportV1,
  type GitHubActionsAgentEvaluationWorkflowIdentityV1,
  githubActionsAgentEvaluationRunReportV1Schema,
  runGitHubActionsAgentEvaluationV1,
  verifyGitHubActionsAgentEvaluationRunReportV1,
} from './github-actions-agent-evaluation-v1';
import {
  buildGitHubActionsAutoCompactionSuiteV1,
  type GitHubActionsAutoCompactionDiagnosticReportV1,
  githubActionsAutoCompactionDiagnosticReportV1Schema,
  runGitHubActionsAutoCompactionDiagnosticV1,
  verifyGitHubActionsAutoCompactionDiagnosticReportV1,
} from './github-actions-auto-compaction-v1';

/**
 * A one-run public-safe summary of the three ADR-0072 diagnostic cases. It
 * is deliberately a diagnostic report only; the report never changes another
 * system's admission decision.
 */
export const GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_REPORT_SCHEMA_V1 =
  'GitHubActionsAgentDiagnosticAggregateReportV1' as const;
export const GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_MAX_WALL_CLOCK_MS_V1 = 180_000;
export const GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_CASE_ORDER_V1 = [
  'agent_read',
  'auto_compaction_success',
  'auto_compaction_cancel',
] as const;

const RUNNER_SOURCE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const WORKFLOW_SOURCE_PATH = resolve(
  REPOSITORY_ROOT,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
);
const MODEL_LEASE_SOURCE_PATH = fileURLToPath(
  new URL('./github-actions-agent-diagnostic-model-lease-v1.ts', import.meta.url),
);

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const safeRepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

const workflowIdentityMaterialSchema = z
  .object({
    repository: safeRepositorySchema,
    ref: z.literal('refs/heads/main'),
    commit: commitSchema,
    workflowPath: z.literal(GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1),
    workflowRef: z.literal(
      `${GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1}/${GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1}@refs/heads/main`,
    ),
    workflowSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    job: z.literal('live-agent-evaluation'),
  })
  .strict();

const workflowIdentitySchema = workflowIdentityMaterialSchema
  .extend({ identityDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { identityDigest, ...material } = value;
    if (identityDigest !== computeWorkflowIdentityDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['identityDigest'],
        message: 'workflow identity digest mismatch',
      });
    }
  });
export type GitHubActionsAgentDiagnosticAggregateWorkflowIdentityV1 = z.infer<
  typeof workflowIdentitySchema
>;

const candidateSchema = z
  .object({
    commit: commitSchema,
    candidateDigest: digestSchema,
  })
  .strict();

const suiteSchema = z
  .object({
    suiteId: z.literal('github-actions-agent-diagnostic-aggregate-v1'),
    caseOrderDigest: digestSchema,
    agentReadSuiteDigest: digestSchema,
    autoCompactionSuiteDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    modelLeaseSourceDigest: digestSchema,
    workflowSourceDigest: digestSchema,
    policyDigest: digestSchema,
    suiteDigest: digestSchema,
  })
  .strict();
export type GitHubActionsAgentDiagnosticAggregateSuiteV1 = z.infer<typeof suiteSchema>;

const caseReportsSchema = z
  .tuple([
    githubActionsAgentEvaluationRunReportV1Schema.nullable(),
    githubActionsAutoCompactionDiagnosticReportV1Schema.nullable(),
    githubActionsAutoCompactionDiagnosticReportV1Schema.nullable(),
  ])
  .superRefine((value, context) => {
    if (value[1] && value[1].result.scenario !== 'success') {
      context.addIssue({
        code: 'custom',
        path: [1, 'result', 'scenario'],
        message: 'second fixed case must be auto-compaction success',
      });
    }
    if (value[2] && value[2].result.scenario !== 'cancel') {
      context.addIssue({
        code: 'custom',
        path: [2, 'result', 'scenario'],
        message: 'third fixed case must be auto-compaction cancel',
      });
    }
  });
export type GitHubActionsAgentDiagnosticAggregateCaseReportsV1 = z.infer<typeof caseReportsSchema>;

const resultReasonCodeSchema = z.enum([
  'child_blocked',
  'child_cancelled',
  'child_failed',
  'child_identity_mismatch',
  'child_not_observed',
  'child_verification_failed',
  'external_cancelled',
  'github_context_invalid',
  'model_lease_unavailable',
  'passed',
  'provider_attempt_cap_mismatch',
  'source_binding_invalid',
  'suite_time_limit_exceeded',
  'transport_proof_unavailable',
]);
export type GitHubActionsAgentDiagnosticAggregateReasonCodeV1 = z.infer<
  typeof resultReasonCodeSchema
>;

const statusByReasonCodeV1: Record<
  GitHubActionsAgentDiagnosticAggregateReasonCodeV1,
  'passed' | 'failed' | 'blocked' | 'cancelled'
> = {
  child_blocked: 'blocked',
  child_cancelled: 'cancelled',
  child_failed: 'failed',
  child_identity_mismatch: 'blocked',
  child_not_observed: 'blocked',
  child_verification_failed: 'blocked',
  external_cancelled: 'cancelled',
  github_context_invalid: 'blocked',
  model_lease_unavailable: 'blocked',
  passed: 'passed',
  provider_attempt_cap_mismatch: 'blocked',
  source_binding_invalid: 'blocked',
  suite_time_limit_exceeded: 'blocked',
  transport_proof_unavailable: 'blocked',
};

const resultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'blocked', 'cancelled']),
    reasonCode: resultReasonCodeSchema,
    providerAttempts: z
      .number()
      .int()
      .min(0)
      .max(GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1),
    verifiedChildCount: z
      .number()
      .int()
      .min(0)
      .max(GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_CASE_ORDER_V1.length),
    transportDisposition: z.enum(['provider_fetch_entered', 'contract_only', 'not_observed']),
    durationBucket: z.enum(['under_60s', '60s_to_180s', 'over_180s']),
    costBucket: z.literal('not_observed'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== statusByReasonCodeV1[value.reasonCode]) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'aggregate status must match its closed diagnostic reason code',
      });
    }
    if (
      value.status === 'passed' &&
      (value.reasonCode !== 'passed' ||
        value.providerAttempts !== GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1 ||
        value.verifiedChildCount !==
          GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_CASE_ORDER_V1.length ||
        value.transportDisposition !== 'provider_fetch_entered' ||
        value.durationBucket === 'over_180s')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'passed aggregate violates fixed live diagnostic invariants',
      });
    }
  });

const reportMaterialSchema = z
  .object({
    schema: z.literal(GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_REPORT_SCHEMA_V1),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    candidate: candidateSchema.nullable(),
    execution: workflowIdentitySchema.nullable(),
    suite: suiteSchema,
    caseReports: caseReportsSchema,
    result: resultSchema,
  })
  .strict();

export const githubActionsAgentDiagnosticAggregateReportV1Schema = reportMaterialSchema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    if (reportDigest !== computeGitHubActionsAgentDiagnosticAggregateReportDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: 'aggregate report digest mismatch',
      });
    }
  });
export type GitHubActionsAgentDiagnosticAggregateReportV1 = z.infer<
  typeof githubActionsAgentDiagnosticAggregateReportV1Schema
>;

export interface RunGitHubActionsAgentDiagnosticAggregateV1Input {
  /**
   * The caller acquires one opaque lease before invoking the fixed suite. No
   * raw credential, endpoint, model, case selector, or command is accepted.
   */
  readonly lease?: GitHubActionsDiagnosticModelLeaseV1;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

interface FixedCaseBindingsV1 {
  readonly agentRead: GitHubActionsDiagnosticModelBindingV1;
  readonly autoCompactionSuccess: GitHubActionsDiagnosticModelBindingV1;
  readonly autoCompactionCancel: GitHubActionsDiagnosticModelBindingV1;
}

interface SuiteDeadlineV1 {
  readonly signal: AbortSignal;
  readonly deadlineExceeded: () => boolean;
  readonly externallyCancelled: () => boolean;
  readonly awaitOperation: <Value>(operation: Promise<Value>) => Promise<Value>;
  readonly dispose: () => void;
}

class SuiteDeadlineExceededError extends Error {
  constructor() {
    super('github_actions_agent_diagnostic_aggregate_deadline_exceeded');
    this.name = 'SuiteDeadlineExceededError';
  }
}

export function computeGitHubActionsAgentDiagnosticAggregateReportDigestV1(
  material: z.infer<typeof reportMaterialSchema>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.github-actions-agent-diagnostic-aggregate.report.v1',
    canonicalJsonBytes(reportMaterialSchema.parse(material)),
  );
}

/**
 * Freshly reconstruct source bindings and independently re-verify every
 * present child before accepting an aggregate report.
 */
export function verifyGitHubActionsAgentDiagnosticAggregateReportV1(
  value: unknown,
): GitHubActionsAgentDiagnosticAggregateReportV1 {
  const report = githubActionsAgentDiagnosticAggregateReportV1Schema.parse(value);
  const expectedSuite = buildGitHubActionsAgentDiagnosticAggregateSuiteV1();
  if (JSON.stringify(report.suite) !== JSON.stringify(expectedSuite)) {
    throw new Error('source_owned_suite_mismatch');
  }

  if (report.execution) {
    if (report.execution.repository !== GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1) {
      throw new Error('canonical_repository_mismatch');
    }
    if (report.execution.workflowSha !== report.execution.commit) {
      throw new Error('workflow_commit_mismatch');
    }
    const expectedCandidate = buildCandidateV1(report.execution.commit, expectedSuite);
    if (JSON.stringify(report.candidate) !== JSON.stringify(expectedCandidate)) {
      throw new Error('candidate_binding_mismatch');
    }
  } else if (report.candidate !== null) {
    throw new Error('candidate_without_execution');
  }

  const [agentRead, autoCompactionSuccess, autoCompactionCancel] = report.caseReports;
  const presentReports = report.caseReports.filter(
    (child): child is Exclude<typeof child, null> => child !== null,
  );
  if (report.result.verifiedChildCount !== presentReports.length) {
    throw new Error('verified_child_count_mismatch');
  }
  if (
    report.result.providerAttempts !==
    aggregateProviderAttemptsV1(agentRead, autoCompactionSuccess, autoCompactionCancel)
  ) {
    throw new Error('aggregate_provider_attempt_mismatch');
  }
  if (report.result.providerAttempts > GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1) {
    throw new Error('provider_attempt_cap_exceeded');
  }
  if (
    report.result.transportDisposition !==
    aggregateTransportDispositionV1(agentRead, autoCompactionSuccess, autoCompactionCancel)
  ) {
    throw new Error('aggregate_transport_disposition_mismatch');
  }

  if (agentRead) {
    verifyChildIdentityV1(
      verifyGitHubActionsAgentEvaluationRunReportV1(agentRead),
      report,
      report.suite.agentReadSuiteDigest,
    );
  }
  if (autoCompactionSuccess) {
    verifyChildIdentityV1(
      verifyGitHubActionsAutoCompactionDiagnosticReportV1(autoCompactionSuccess),
      report,
      report.suite.autoCompactionSuiteDigest,
    );
  }
  if (autoCompactionCancel) {
    verifyChildIdentityV1(
      verifyGitHubActionsAutoCompactionDiagnosticReportV1(autoCompactionCancel),
      report,
      report.suite.autoCompactionSuiteDigest,
    );
  }

  if (report.result.status === 'passed') {
    if (
      !agentRead ||
      !autoCompactionSuccess ||
      !autoCompactionCancel ||
      agentRead.result.status !== 'passed' ||
      autoCompactionSuccess.result.status !== 'passed' ||
      autoCompactionCancel.result.status !== 'passed' ||
      !hasExactProviderFetchCountsV1(agentRead, autoCompactionSuccess, autoCompactionCancel)
    ) {
      throw new Error('passed_aggregate_invariant_failed');
    }
  }
  return report;
}

/** Source-owned aggregate identity; output contains only digests and fixed metadata. */
export function buildGitHubActionsAgentDiagnosticAggregateSuiteV1(): GitHubActionsAgentDiagnosticAggregateSuiteV1 {
  const agentReadSuite = buildGitHubActionsAgentEvaluationSuiteV1();
  const autoCompactionSuite = buildGitHubActionsAutoCompactionSuiteV1();
  const caseOrderDigest = digestMaterialV1('case-order.v1', {
    caseOrder: GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_CASE_ORDER_V1,
  });
  const evaluatorDigest = digestMaterialV1('evaluator.v1', {
    implementation: 'fixed-child-report-status-and-identity-aggregate',
    version: 1,
  });
  const verifierDigest = digestMaterialV1('verifier.v1', {
    implementation: 'fresh-child-verifier-and-common-workflow-identity',
    version: 1,
  });
  const runnerDigest = sha256DomainSeparated(
    'kite.github-actions-agent-diagnostic-aggregate.runner-source.v1',
    readFileSync(RUNNER_SOURCE_PATH),
  );
  const modelLeaseSourceDigest = sha256DomainSeparated(
    'kite.github-actions-agent-diagnostic-aggregate.model-lease-source.v1',
    readFileSync(MODEL_LEASE_SOURCE_PATH),
  );
  const workflowSourceDigest = sha256DomainSeparated(
    'kite.github-actions-agent-diagnostic-aggregate.workflow-source.v1',
    readFileSync(WORKFLOW_SOURCE_PATH),
  );
  const policyDigest = digestMaterialV1('policy.v1', {
    expectedProviderAttempts: {
      agent_read: GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxProviderAttempts,
      auto_compaction_success:
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_success.maxProviderAttempts,
      auto_compaction_cancel:
        GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_cancel.maxProviderAttempts,
    },
    maxSuiteWallClockMs: GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_MAX_WALL_CLOCK_MS_V1,
    totalProviderAttemptCap: GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1,
    resultOrdering: GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_CASE_ORDER_V1,
    publicOutput: 'metadata_and_digests_only',
  });
  const material = {
    suiteId: 'github-actions-agent-diagnostic-aggregate-v1' as const,
    caseOrderDigest,
    agentReadSuiteDigest: agentReadSuite.suiteDigest,
    autoCompactionSuiteDigest: autoCompactionSuite.suiteDigest,
    evaluatorDigest,
    verifierDigest,
    runnerDigest,
    modelLeaseSourceDigest,
    workflowSourceDigest,
    policyDigest,
  };
  return suiteSchema.parse({
    ...material,
    suiteDigest: digestMaterialV1('suite.v1', material),
  });
}

/**
 * Execute the three fixed cases in one deterministic sequence. A caller must
 * supply exactly one opaque lease; local contract leases can exercise this
 * flow but cannot produce a passed aggregate.
 */
export async function runGitHubActionsAgentDiagnosticAggregateV1(
  input: RunGitHubActionsAgentDiagnosticAggregateV1Input = {},
): Promise<GitHubActionsAgentDiagnosticAggregateReportV1> {
  let suite: GitHubActionsAgentDiagnosticAggregateSuiteV1;
  try {
    suite = buildGitHubActionsAgentDiagnosticAggregateSuiteV1();
  } catch {
    return buildReportV1({
      suite: fallbackSuiteV1(),
      candidate: null,
      execution: null,
      caseReports: emptyCaseReportsV1(),
      result: resultV1('blocked', 'source_binding_invalid', emptyCaseReportsV1(), 0),
    });
  }

  const environment = input.environment ?? process.env;
  let execution: GitHubActionsAgentDiagnosticAggregateWorkflowIdentityV1;
  try {
    execution = readWorkflowIdentityV1(environment);
  } catch {
    return buildReportV1({
      suite,
      candidate: null,
      execution: null,
      caseReports: emptyCaseReportsV1(),
      result: resultV1('blocked', 'github_context_invalid', emptyCaseReportsV1(), 0),
    });
  }
  const candidate = buildCandidateV1(execution.commit, suite);
  if (input.signal?.aborted) {
    return buildReportV1({
      suite,
      candidate,
      execution,
      caseReports: emptyCaseReportsV1(),
      result: resultV1('cancelled', 'external_cancelled', emptyCaseReportsV1(), 0),
    });
  }

  let bindings: FixedCaseBindingsV1;
  try {
    bindings = takeFixedCaseBindingsV1(input.lease);
  } catch {
    return buildReportV1({
      suite,
      candidate,
      execution,
      caseReports: emptyCaseReportsV1(),
      result: resultV1('blocked', 'model_lease_unavailable', emptyCaseReportsV1(), 0),
    });
  }

  const startedAt = Date.now();
  const deadline = createSuiteDeadlineV1(input.signal);
  let agentRead: GitHubActionsAgentEvaluationRunReportV1 | null = null;
  let autoCompactionSuccess: GitHubActionsAutoCompactionDiagnosticReportV1 | null = null;
  let autoCompactionCancel: GitHubActionsAutoCompactionDiagnosticReportV1 | null = null;
  let runnerReason:
    | Exclude<GitHubActionsAgentDiagnosticAggregateReasonCodeV1, 'passed'>
    | undefined;
  try {
    agentRead = verifyGitHubActionsAgentEvaluationRunReportV1(
      await deadline.awaitOperation(
        runGitHubActionsAgentEvaluationV1({
          mode: 'live',
          environment,
          binding: bindings.agentRead,
          signal: deadline.signal,
        }),
      ),
    );
    if (!deadline.externallyCancelled()) {
      autoCompactionSuccess = verifyGitHubActionsAutoCompactionDiagnosticReportV1(
        await deadline.awaitOperation(
          runGitHubActionsAutoCompactionDiagnosticV1({
            scenario: 'success',
            environment,
            binding: bindings.autoCompactionSuccess,
            signal: deadline.signal,
          }),
        ),
      );
    }
    if (!deadline.externallyCancelled()) {
      autoCompactionCancel = verifyGitHubActionsAutoCompactionDiagnosticReportV1(
        await deadline.awaitOperation(
          runGitHubActionsAutoCompactionDiagnosticV1({
            scenario: 'cancel',
            environment,
            binding: bindings.autoCompactionCancel,
            signal: deadline.signal,
          }),
        ),
      );
    }
  } catch (error) {
    runnerReason =
      error instanceof SuiteDeadlineExceededError || deadline.deadlineExceeded()
        ? 'suite_time_limit_exceeded'
        : 'child_verification_failed';
  } finally {
    deadline.dispose();
  }

  const caseReports: GitHubActionsAgentDiagnosticAggregateCaseReportsV1 = [
    agentRead,
    autoCompactionSuccess,
    autoCompactionCancel,
  ];
  const durationMs = Date.now() - startedAt;
  const result = evaluateAggregateV1({
    caseReports,
    bindings,
    runnerReason,
    deadlineExceeded: deadline.deadlineExceeded(),
    externallyCancelled: deadline.externallyCancelled(),
    durationMs,
  });
  // The producer replays the aggregate verifier before emitting a report, so
  // a cross-child identity splice cannot leave this runner as a valid output.
  return verifyGitHubActionsAgentDiagnosticAggregateReportV1(
    buildReportV1({ suite, candidate, execution, caseReports, result }),
  );
}

function takeFixedCaseBindingsV1(
  lease: GitHubActionsDiagnosticModelLeaseV1 | undefined,
): FixedCaseBindingsV1 {
  if (
    !lease ||
    lease.schema !== GITHUB_ACTIONS_DIAGNOSTIC_MODEL_LEASE_SCHEMA_V1 ||
    typeof lease.bind !== 'function'
  ) {
    throw new Error('diagnostic_model_lease_unavailable');
  }
  const agentRead = lease.bind('agent_read');
  const autoCompactionSuccess = lease.bind('auto_compaction_success');
  const autoCompactionCancel = lease.bind('auto_compaction_cancel');
  if (
    !isGitHubActionsDiagnosticModelBindingV1(agentRead) ||
    !isGitHubActionsDiagnosticModelBindingV1(autoCompactionSuccess) ||
    !isGitHubActionsDiagnosticModelBindingV1(autoCompactionCancel) ||
    agentRead.caseId !== 'agent_read' ||
    autoCompactionSuccess.caseId !== 'auto_compaction_success' ||
    autoCompactionCancel.caseId !== 'auto_compaction_cancel' ||
    new Set([agentRead, autoCompactionSuccess, autoCompactionCancel]).size !== 3
  ) {
    throw new Error('diagnostic_model_lease_unavailable');
  }
  return { agentRead, autoCompactionSuccess, autoCompactionCancel };
}

function createSuiteDeadlineV1(externalSignal: AbortSignal | undefined): SuiteDeadlineV1 {
  const controller = new AbortController();
  let deadlineExceeded = false;
  let externallyCancelled = false;
  let resolveDeadline: (() => void) | undefined;
  const deadlineReached = new Promise<void>((resolvePromise) => {
    resolveDeadline = resolvePromise;
  });
  const onExternalAbort = () => {
    externallyCancelled = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort('github_actions_agent_diagnostic_aggregate_deadline_exceeded');
    resolveDeadline?.();
  }, GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_MAX_WALL_CLOCK_MS_V1);
  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    externallyCancelled: () => externallyCancelled,
    awaitOperation: async <Value>(operation: Promise<Value>): Promise<Value> => {
      const outcome = await Promise.race([
        operation.then(
          (value) => ({ kind: 'value' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        deadlineReached.then(() => ({ kind: 'deadline' as const })),
      ]);
      if (outcome.kind === 'value') return outcome.value;
      if (outcome.kind === 'error') throw outcome.error;
      void operation.catch(() => {});
      throw new SuiteDeadlineExceededError();
    },
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function evaluateAggregateV1(input: {
  readonly caseReports: GitHubActionsAgentDiagnosticAggregateCaseReportsV1;
  readonly bindings: FixedCaseBindingsV1;
  readonly runnerReason:
    | Exclude<GitHubActionsAgentDiagnosticAggregateReasonCodeV1, 'passed'>
    | undefined;
  readonly deadlineExceeded: boolean;
  readonly externallyCancelled: boolean;
  readonly durationMs: number;
}): z.infer<typeof resultSchema> {
  const [agentRead, autoCompactionSuccess, autoCompactionCancel] = input.caseReports;
  if (
    input.durationMs > GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_MAX_WALL_CLOCK_MS_V1 ||
    input.deadlineExceeded
  ) {
    return resultV1('blocked', 'suite_time_limit_exceeded', input.caseReports, input.durationMs);
  }
  if (input.externallyCancelled) {
    return resultV1('cancelled', 'external_cancelled', input.caseReports, input.durationMs);
  }
  if (input.runnerReason) {
    return resultV1('blocked', input.runnerReason, input.caseReports, input.durationMs);
  }
  if (!agentRead || !autoCompactionSuccess || !autoCompactionCancel) {
    return resultV1('blocked', 'child_not_observed', input.caseReports, input.durationMs);
  }
  if (
    agentRead.result.status === 'failed' ||
    autoCompactionSuccess.result.status === 'failed' ||
    autoCompactionCancel.result.status === 'failed'
  ) {
    return resultV1('failed', 'child_failed', input.caseReports, input.durationMs);
  }
  if (agentRead.result.status === 'cancelled') {
    return resultV1('cancelled', 'child_cancelled', input.caseReports, input.durationMs);
  }
  if (
    !hasProviderFetchProvenanceV1(input.caseReports) ||
    !hasBindingProviderFetchProvenanceV1(input.bindings)
  ) {
    return resultV1('blocked', 'transport_proof_unavailable', input.caseReports, input.durationMs);
  }
  if (
    !hasExactProviderFetchCountsV1(agentRead, autoCompactionSuccess, autoCompactionCancel) ||
    !hasExactBindingCountsV1(input.bindings)
  ) {
    return resultV1(
      'blocked',
      'provider_attempt_cap_mismatch',
      input.caseReports,
      input.durationMs,
    );
  }
  if (
    agentRead.result.status === 'blocked' ||
    autoCompactionSuccess.result.status === 'blocked' ||
    autoCompactionCancel.result.status === 'blocked'
  ) {
    return resultV1('blocked', 'child_blocked', input.caseReports, input.durationMs);
  }
  return resultV1('passed', 'passed', input.caseReports, input.durationMs);
}

function hasExactProviderFetchCountsV1(
  agentRead: GitHubActionsAgentEvaluationRunReportV1,
  autoCompactionSuccess: GitHubActionsAutoCompactionDiagnosticReportV1,
  autoCompactionCancel: GitHubActionsAutoCompactionDiagnosticReportV1,
): boolean {
  return (
    agentRead.result.providerAttempts ===
      GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxProviderAttempts &&
    autoCompactionSuccess.result.providerAttempts ===
      GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_success.maxProviderAttempts &&
    autoCompactionCancel.result.providerAttempts ===
      GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_cancel.maxProviderAttempts &&
    aggregateProviderAttemptsV1(agentRead, autoCompactionSuccess, autoCompactionCancel) ===
      GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1
  );
}

function hasExactBindingCountsV1(bindings: FixedCaseBindingsV1): boolean {
  return (
    bindings.agentRead.transportEntries() ===
      GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.agent_read.maxProviderAttempts &&
    bindings.autoCompactionSuccess.transportEntries() ===
      GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_success.maxProviderAttempts &&
    bindings.autoCompactionCancel.transportEntries() ===
      GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1.auto_compaction_cancel.maxProviderAttempts
  );
}

function hasProviderFetchProvenanceV1(
  caseReports: GitHubActionsAgentDiagnosticAggregateCaseReportsV1,
): boolean {
  const [agentRead, autoCompactionSuccess, autoCompactionCancel] = caseReports;
  return (
    agentRead?.result.transportDisposition === 'provider_fetch_entered' &&
    autoCompactionSuccess?.result.transportDisposition === 'provider_fetch_entered' &&
    autoCompactionCancel?.result.transportDisposition === 'provider_fetch_entered'
  );
}

function hasBindingProviderFetchProvenanceV1(bindings: FixedCaseBindingsV1): boolean {
  return (
    bindings.agentRead.transportProofKind === 'provider_fetch' &&
    bindings.autoCompactionSuccess.transportProofKind === 'provider_fetch' &&
    bindings.autoCompactionCancel.transportProofKind === 'provider_fetch'
  );
}

function aggregateProviderAttemptsV1(
  agentRead: GitHubActionsAgentEvaluationRunReportV1 | null,
  autoCompactionSuccess: GitHubActionsAutoCompactionDiagnosticReportV1 | null,
  autoCompactionCancel: GitHubActionsAutoCompactionDiagnosticReportV1 | null,
): number {
  return (
    (agentRead?.result.providerAttempts ?? 0) +
    (autoCompactionSuccess?.result.providerAttempts ?? 0) +
    (autoCompactionCancel?.result.providerAttempts ?? 0)
  );
}

function aggregateTransportDispositionV1(
  agentRead: GitHubActionsAgentEvaluationRunReportV1 | null,
  autoCompactionSuccess: GitHubActionsAutoCompactionDiagnosticReportV1 | null,
  autoCompactionCancel: GitHubActionsAutoCompactionDiagnosticReportV1 | null,
): z.infer<typeof resultSchema>['transportDisposition'] {
  if (!agentRead || !autoCompactionSuccess || !autoCompactionCancel) return 'not_observed';
  const dispositions = [
    agentRead.result.transportDisposition,
    autoCompactionSuccess.result.transportDisposition,
    autoCompactionCancel.result.transportDisposition,
  ];
  if (dispositions.every((disposition) => disposition === 'provider_fetch_entered')) {
    return 'provider_fetch_entered';
  }
  if (dispositions.every((disposition) => disposition === 'contract_only')) {
    return 'contract_only';
  }
  return 'not_observed';
}

function verifyChildIdentityV1(
  child: GitHubActionsAgentEvaluationRunReportV1 | GitHubActionsAutoCompactionDiagnosticReportV1,
  aggregate: GitHubActionsAgentDiagnosticAggregateReportV1,
  expectedSuiteDigest: string,
): void {
  if (!aggregate.execution || !aggregate.candidate) throw new Error('child_identity_mismatch');
  if (!child.execution || !child.candidate) throw new Error('child_identity_mismatch');
  if (
    child.suite.suiteDigest !== expectedSuiteDigest ||
    child.candidate.commit !== aggregate.candidate.commit ||
    !sameWorkflowIdentityV1(child.execution, aggregate.execution)
  ) {
    throw new Error('child_identity_mismatch');
  }
}

function sameWorkflowIdentityV1(
  left: GitHubActionsAgentEvaluationWorkflowIdentityV1,
  right: GitHubActionsAgentDiagnosticAggregateWorkflowIdentityV1,
): boolean {
  return (
    left.repository === right.repository &&
    left.ref === right.ref &&
    left.commit === right.commit &&
    left.workflowPath === right.workflowPath &&
    left.workflowRef === right.workflowRef &&
    left.workflowSha === right.workflowSha &&
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.job === right.job &&
    left.identityDigest === right.identityDigest
  );
}

function resultV1(
  status: z.infer<typeof resultSchema>['status'],
  reasonCode: GitHubActionsAgentDiagnosticAggregateReasonCodeV1,
  caseReports: GitHubActionsAgentDiagnosticAggregateCaseReportsV1,
  durationMs: number,
): z.infer<typeof resultSchema> {
  const [agentRead, autoCompactionSuccess, autoCompactionCancel] = caseReports;
  return resultSchema.parse({
    status,
    reasonCode,
    providerAttempts: aggregateProviderAttemptsV1(
      agentRead,
      autoCompactionSuccess,
      autoCompactionCancel,
    ),
    verifiedChildCount: caseReports.filter((report) => report !== null).length,
    transportDisposition: aggregateTransportDispositionV1(
      agentRead,
      autoCompactionSuccess,
      autoCompactionCancel,
    ),
    durationBucket:
      durationMs < 60_000
        ? 'under_60s'
        : durationMs <= GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_MAX_WALL_CLOCK_MS_V1
          ? '60s_to_180s'
          : 'over_180s',
    costBucket: 'not_observed',
  });
}

function buildReportV1(input: {
  readonly suite: GitHubActionsAgentDiagnosticAggregateSuiteV1;
  readonly candidate: z.infer<typeof candidateSchema> | null;
  readonly execution: GitHubActionsAgentDiagnosticAggregateWorkflowIdentityV1 | null;
  readonly caseReports: GitHubActionsAgentDiagnosticAggregateCaseReportsV1;
  readonly result: z.infer<typeof resultSchema>;
}): GitHubActionsAgentDiagnosticAggregateReportV1 {
  const material = reportMaterialSchema.parse({
    schema: GITHUB_ACTIONS_AGENT_DIAGNOSTIC_AGGREGATE_REPORT_SCHEMA_V1,
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    candidate: input.candidate,
    execution: input.execution,
    suite: input.suite,
    caseReports: input.caseReports,
    result: input.result,
  });
  return githubActionsAgentDiagnosticAggregateReportV1Schema.parse({
    ...material,
    reportDigest: computeGitHubActionsAgentDiagnosticAggregateReportDigestV1(material),
  });
}

function readWorkflowIdentityV1(
  environment: NodeJS.ProcessEnv,
): GitHubActionsAgentDiagnosticAggregateWorkflowIdentityV1 {
  const material = {
    repository: environment.GITHUB_REPOSITORY,
    ref: environment.GITHUB_REF,
    commit: environment.GITHUB_SHA,
    workflowPath: GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    workflowSha: environment.GITHUB_WORKFLOW_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    job: environment.GITHUB_JOB,
  };
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REF_PROTECTED !== 'true' ||
    material.repository !== GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1 ||
    material.ref !== 'refs/heads/main' ||
    material.workflowSha !== material.commit
  ) {
    throw new Error('github_context_invalid');
  }
  const parsed = workflowIdentityMaterialSchema.safeParse(material);
  if (!parsed.success) throw new Error('github_context_invalid');
  return workflowIdentitySchema.parse({
    ...parsed.data,
    identityDigest: computeWorkflowIdentityDigestV1(parsed.data),
  });
}

function buildCandidateV1(
  commit: string,
  suite: GitHubActionsAgentDiagnosticAggregateSuiteV1,
): z.infer<typeof candidateSchema> {
  return candidateSchema.parse({
    commit,
    candidateDigest: digestMaterialV1('candidate.v1', {
      canonicalRepository: GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
      commit,
      suiteDigest: suite.suiteDigest,
      workflowSourceDigest: suite.workflowSourceDigest,
    }),
  });
}

function emptyCaseReportsV1(): GitHubActionsAgentDiagnosticAggregateCaseReportsV1 {
  return [null, null, null];
}

function fallbackSuiteV1(): GitHubActionsAgentDiagnosticAggregateSuiteV1 {
  const digest = digestMaterialV1('fallback-suite.v1', { status: 'source_binding_invalid' });
  return suiteSchema.parse({
    suiteId: 'github-actions-agent-diagnostic-aggregate-v1',
    caseOrderDigest: digest,
    agentReadSuiteDigest: digest,
    autoCompactionSuiteDigest: digest,
    evaluatorDigest: digest,
    verifierDigest: digest,
    runnerDigest: digest,
    modelLeaseSourceDigest: digest,
    workflowSourceDigest: digest,
    policyDigest: digest,
    suiteDigest: digest,
  });
}

function digestMaterialV1(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(
    `kite.github-actions-agent-diagnostic-aggregate.${domain}`,
    canonicalJsonBytes(value),
  );
}

function isLiveWorkflowContextV1(environment: NodeJS.ProcessEnv): boolean {
  try {
    readWorkflowIdentityV1(environment);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // The exact GitHub context is checked before the sole process-level secret
  // acquisition. The aggregate and all child runners receive only its opaque
  // lease/bindings, never an environment-derived credential.
  const lease = isLiveWorkflowContextV1(process.env)
    ? acquireGitHubActionsDiagnosticModelLeaseV1(process.env)
    : undefined;
  const report = await runGitHubActionsAgentDiagnosticAggregateV1({
    environment: process.env,
    lease,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result.status !== 'passed') process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    const report = buildReportV1({
      suite: fallbackSuiteV1(),
      candidate: null,
      execution: null,
      caseReports: emptyCaseReportsV1(),
      result: resultV1('blocked', 'source_binding_invalid', emptyCaseReportsV1(), 0),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  }
}
