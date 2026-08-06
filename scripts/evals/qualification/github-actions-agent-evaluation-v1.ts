import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { AgentConfig } from '../../../src/core/config';
import { parseExecutionBoundaryV1 } from '../../../src/core/config/execution-boundary';
import {
  computeInProcessReadOnlyToolCatalogDigestV1,
  inProcessReadOnlyToolCatalogV1Schema,
} from '../../../src/core/config/execution-qualification';
import type { SupportedChatModel } from '../../../src/core/model/factory';
import { runRuntimeAgent } from '../../../src/core/runtime/agent';
import type { RuntimeEvent } from '../../../src/core/runtime/events';
import type { ExecutionCapabilitySurfaceV1 } from '../../../src/core/sandbox/types';
import { builtinToolRegistry } from '../../../src/core/tools/registry/builtins';
import { readFileSpec } from '../../../src/core/tools/registry/builtins/read-file';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';
import {
  type GitHubActionsDiagnosticModelBindingV1,
  isGitHubActionsDiagnosticModelBindingV1,
  GITHUB_ACTIONS_DIAGNOSTIC_QWEN_BASE_URL_V1 as QWEN_BASE_URL,
  GITHUB_ACTIONS_DIAGNOSTIC_QWEN_MODEL_V1 as QWEN_MODEL,
  GITHUB_ACTIONS_DIAGNOSTIC_ROUTE_ALIAS_V1 as ROUTE_ALIAS,
} from './github-actions-agent-diagnostic-model-lease-v1';

export { GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1 as GITHUB_ACTIONS_AGENT_EVALUATION_SECRET_V1 } from './github-actions-agent-diagnostic-model-lease-v1';

/**
 * This module is intentionally separate from the ADR-0070 L3 observation
 * path. It emits a public-safe diagnostic run report, never qualification or
 * release evidence.
 */
export const GITHUB_ACTIONS_AGENT_EVALUATION_REPORT_SCHEMA_V1 =
  'GitHubActionsAgentEvaluationRunReportV1' as const;
export const GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1 =
  '.github/workflows/agent-live-evaluation.yml' as const;
/** Fixed to this reviewed repository's origin; it is never workflow input. */
export const GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1 = 'ferqx/kite-code' as const;

const MAX_PROVIDER_ATTEMPTS = 2;
const MAX_TOTAL_INPUT_TOKENS = 4_096;
const MAX_OUTPUT_TOKENS = 256;
const MAX_TOTAL_OUTPUT_TOKENS = MAX_PROVIDER_ATTEMPTS * MAX_OUTPUT_TOKENS;
const MAX_WALL_CLOCK_MS = 60_000;
const FIXTURE_RELATIVE_PATH = 'facts/verification-token.txt';
const FIXTURE_DIRECTORY = join(import.meta.dir, 'fixtures/github-actions-agent-evaluation-v1');
const RUNNER_SOURCE_PATH = fileURLToPath(import.meta.url);
const MODEL_LEASE_SOURCE_PATH = fileURLToPath(
  new URL('./github-actions-agent-diagnostic-model-lease-v1.ts', import.meta.url),
);
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const WORKFLOW_SOURCE_PATH = resolve(
  REPOSITORY_ROOT,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
);
const SAFE_ENVIRONMENT_KEYS = [
  'HOME',
  'KITE_CODE_HOME',
  'PWD',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const safeIdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/);
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
    job: z.enum(['preflight', 'live-agent-evaluation']),
  })
  .strict();
type WorkflowIdentityMaterialV1 = z.infer<typeof workflowIdentityMaterialSchema>;

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
export type GitHubActionsAgentEvaluationWorkflowIdentityV1 = z.infer<typeof workflowIdentitySchema>;

const suiteSchema = z
  .object({
    suiteId: safeIdentifierSchema,
    caseId: safeIdentifierSchema,
    routeAlias: safeIdentifierSchema,
    model: safeIdentifierSchema,
    fixtureDigest: digestSchema,
    corpusDigest: digestSchema,
    oracleDigest: digestSchema,
    evaluatorDigest: digestSchema,
    runnerDigest: digestSchema,
    modelLeaseSourceDigest: digestSchema,
    workflowSourceDigest: digestSchema,
    toolCatalogDigest: digestSchema,
    policyDigest: digestSchema,
    suiteDigest: digestSchema,
  })
  .strict();
export type GitHubActionsAgentEvaluationSuiteV1 = z.infer<typeof suiteSchema>;

const candidateSchema = z
  .object({
    commit: commitSchema,
    candidateDigest: digestSchema,
  })
  .strict();

const reportReasonCodeSchema = z.enum([
  'cancelled',
  'cleanup_failed',
  'fixture_invalid',
  'fixture_mutated',
  'github_context_invalid',
  'model_call_limit_exceeded',
  'model_binding_unavailable',
  'model_dispatch_failed',
  'oracle_mismatch',
  'passed',
  'preflight_only',
  'runtime_terminal_failure',
  'time_limit_exceeded',
  'token_quota_exceeded',
  'transport_proof_unavailable',
  'tool_policy_violation',
  'usage_unavailable',
]);
export type GitHubActionsAgentEvaluationReasonCodeV1 = z.infer<typeof reportReasonCodeSchema>;

const reportStatusByReasonCodeV1: Record<
  GitHubActionsAgentEvaluationReasonCodeV1,
  'passed' | 'failed' | 'blocked' | 'cancelled'
> = {
  cancelled: 'cancelled',
  cleanup_failed: 'blocked',
  fixture_invalid: 'blocked',
  fixture_mutated: 'failed',
  github_context_invalid: 'blocked',
  model_call_limit_exceeded: 'failed',
  model_binding_unavailable: 'blocked',
  model_dispatch_failed: 'failed',
  oracle_mismatch: 'failed',
  passed: 'passed',
  preflight_only: 'blocked',
  runtime_terminal_failure: 'failed',
  time_limit_exceeded: 'blocked',
  token_quota_exceeded: 'blocked',
  transport_proof_unavailable: 'blocked',
  tool_policy_violation: 'failed',
  usage_unavailable: 'blocked',
};

const resultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'blocked', 'cancelled']),
    reasonCode: reportReasonCodeSchema,
    providerAttempts: z.number().int().min(0).max(MAX_PROVIDER_ATTEMPTS),
    modelResponses: z.number().int().min(0).max(MAX_PROVIDER_ATTEMPTS),
    readFileCalls: z.number().int().min(0).max(MAX_PROVIDER_ATTEMPTS),
    rejectedToolCalls: z.number().int().min(0).max(MAX_PROVIDER_ATTEMPTS),
    transportDisposition: z.enum(['provider_fetch_entered', 'contract_only', 'not_observed']),
    durationBucket: z.enum(['under_15s', '15s_to_60s', 'over_60s']),
    tokenBucket: z.enum(['unknown', 'under_512', '512_to_2048', 'over_2048']),
    costBucket: z.literal('not_observed'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== reportStatusByReasonCodeV1[value.reasonCode]) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'report status must match its closed diagnostic reason code',
      });
    }
    if (
      value.status === 'passed' &&
      (value.transportDisposition !== 'provider_fetch_entered' ||
        value.durationBucket === 'over_60s')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['transportDisposition'],
        message: 'passed reports require bounded Provider-fetch provenance',
      });
    }
  });

const reportMaterialSchema = z
  .object({
    schema: z.literal(GITHUB_ACTIONS_AGENT_EVALUATION_REPORT_SCHEMA_V1),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    candidate: candidateSchema.nullable(),
    execution: workflowIdentitySchema.nullable(),
    suite: suiteSchema,
    result: resultSchema,
  })
  .strict();

export const githubActionsAgentEvaluationRunReportV1Schema = reportMaterialSchema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    if (reportDigest !== computeGitHubActionsAgentEvaluationReportDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: 'diagnostic report digest mismatch',
      });
    }
  });
export type GitHubActionsAgentEvaluationRunReportV1 = z.infer<
  typeof githubActionsAgentEvaluationRunReportV1Schema
>;

export type GitHubActionsAgentEvaluationModeV1 = 'live' | 'preflight';

export interface RunGitHubActionsAgentEvaluationV1Input {
  mode?: GitHubActionsAgentEvaluationModeV1;
  environment?: NodeJS.ProcessEnv;
  /** Opaque fixed-case binding; raw credentials and arbitrary models are rejected. */
  binding?: GitHubActionsDiagnosticModelBindingV1;
  signal?: AbortSignal;
}

interface SourceFixtureV1 {
  root: string;
  relativePath: typeof FIXTURE_RELATIVE_PATH;
  content: string;
  fixtureDigest: `sha256:${string}`;
  corpusDigest: `sha256:${string}`;
}

interface MaterializedFixtureV1 {
  root: string;
  workspace: string;
  home: string;
  config: string;
  data: string;
  state: string;
  cwd: string;
  fixturePath: string;
}

class ProviderAttemptQuotaError extends Error {
  constructor() {
    super('provider_attempt_quota_exceeded');
    this.name = 'ProviderAttemptQuotaError';
  }
}

class GithubContextError extends Error {
  constructor() {
    super('github_context_invalid');
    this.name = 'GithubContextError';
  }
}

class AgentEvaluationDeadlineExceededError extends Error {
  constructor() {
    super('github_actions_agent_evaluation_deadline_exceeded');
    this.name = 'AgentEvaluationDeadlineExceededError';
  }
}

interface DeadlineBoundRunV1 {
  readonly signal: AbortSignal;
  readonly deadlineExceeded: () => boolean;
  /**
   * The Provider must be raced independently of AbortSignal cooperation. A
   * late model promise is observed but cannot resume Runtime's next effect.
   */
  readonly awaitOperation: <Value>(operation: PromiseLike<Value>) => Promise<Value>;
  readonly dispose: () => void;
}

/** Compose caller cancellation with a non-bypassable per-run wall-clock cap. */
function createDeadlineBoundRunV1(externalSignal: AbortSignal | undefined): DeadlineBoundRunV1 {
  const controller = new AbortController();
  let deadlineExceeded = false;
  let resolveDeadline: (() => void) | undefined;
  const deadlineReached = new Promise<void>((resolvePromise) => {
    resolveDeadline = resolvePromise;
  });
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort('github_actions_agent_evaluation_deadline_exceeded');
    resolveDeadline?.();
  }, MAX_WALL_CLOCK_MS);
  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    awaitOperation: async <Value>(operation: PromiseLike<Value>): Promise<Value> => {
      const settled = Promise.resolve(operation);
      const outcome = await Promise.race([
        settled.then(
          (value) => ({ kind: 'value' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        deadlineReached.then(() => ({ kind: 'deadline' as const })),
      ]);
      if (outcome.kind === 'value') return outcome.value;
      if (outcome.kind === 'error') throw outcome.error;
      // The signal was aborted before this branch. The unresolved operation is
      // deliberately detached with an observed rejection; its wrapper has
      // already failed, so it cannot cause a later Runtime/tool dispatch.
      void settled.catch(() => {});
      throw new AgentEvaluationDeadlineExceededError();
    },
    dispose: () => {
      clearTimeout(deadline);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

export function computeWorkflowIdentityDigestV1(
  material: WorkflowIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.github-actions-agent-evaluation.workflow-identity.v1',
    canonicalJsonBytes(workflowIdentityMaterialSchema.parse(material)),
  );
}

export function computeGitHubActionsAgentEvaluationReportDigestV1(
  material: z.infer<typeof reportMaterialSchema>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.github-actions-agent-evaluation.run-report.v1',
    canonicalJsonBytes(reportMaterialSchema.parse(material)),
  );
}

/** Rebuild all source-owned bindings before accepting a public-safe report. */
export function verifyGitHubActionsAgentEvaluationRunReportV1(
  value: unknown,
): GitHubActionsAgentEvaluationRunReportV1 {
  const report = githubActionsAgentEvaluationRunReportV1Schema.parse(value);
  const expectedSuite = buildGitHubActionsAgentEvaluationSuiteV1();
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
  if (report.result.status === 'passed') {
    if (
      !report.execution ||
      !report.candidate ||
      report.execution.job !== 'live-agent-evaluation' ||
      report.result.reasonCode !== 'passed' ||
      report.result.providerAttempts !== MAX_PROVIDER_ATTEMPTS ||
      report.result.modelResponses !== MAX_PROVIDER_ATTEMPTS ||
      report.result.readFileCalls !== 1 ||
      report.result.rejectedToolCalls !== 0 ||
      report.result.transportDisposition !== 'provider_fetch_entered' ||
      report.result.durationBucket === 'over_60s'
    ) {
      throw new Error('passed_report_invariant_failed');
    }
  }
  if (
    report.execution?.job === 'preflight' &&
    (report.result.status !== 'blocked' || report.result.reasonCode !== 'preflight_only')
  ) {
    throw new Error('preflight_report_invariant_failed');
  }
  if (report.result.reasonCode === 'preflight_only' && report.execution?.job !== 'preflight') {
    throw new Error('preflight_execution_mismatch');
  }
  return report;
}

/**
 * A source-owned suite is reconstructed from reviewed fixture/runner/workflow
 * bytes. It contains digests only; no task or fixture content is reportable.
 */
export function buildGitHubActionsAgentEvaluationSuiteV1(): GitHubActionsAgentEvaluationSuiteV1 {
  const fixture = readSourceFixtureV1();
  const toolCatalog = createReadOnlyToolCatalogV1();
  const corpusDigest = fixture.corpusDigest;
  const oracleDigest = digestMaterial('oracle.v1', {
    caseId: 'gha-agent-read-synthetic-v1',
    expectedAnswerDigest: digestText('expected-answer.v1', fixture.content),
    requiredTool: 'read_file',
  });
  const evaluatorDigest = digestMaterial('evaluator.v1', {
    implementation: 'runtime-event-memory-oracle',
    version: 1,
  });
  const runnerSourceDigest = sha256DomainSeparated(
    'kite.github-actions-agent-evaluation.runner-source-bytes.v1',
    readFileSync(RUNNER_SOURCE_PATH),
  );
  const modelLeaseSourceDigest = sha256DomainSeparated(
    'kite.github-actions-agent-evaluation.model-lease-source.v1',
    readFileSync(MODEL_LEASE_SOURCE_PATH),
  );
  // The runner cannot safely be interpreted without its opaque model lease.
  // Bind both reviewed source bytes into the runner identity as well as the
  // explicit policy closure below.
  const runnerDigest = sha256DomainSeparated(
    'kite.github-actions-agent-evaluation.runner-source.v2',
    canonicalJsonBytes({ runnerSourceDigest, modelLeaseSourceDigest }),
  );
  const workflowSourceDigest = sha256DomainSeparated(
    'kite.github-actions-agent-evaluation.workflow-source.v1',
    readFileSync(WORKFLOW_SOURCE_PATH),
  );
  const policyDigest = digestMaterial('policy.v1', {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxTotalInputTokens: MAX_TOTAL_INPUT_TOKENS,
    maxTotalOutputTokens: MAX_TOTAL_OUTPUT_TOKENS,
    maxProviderAttempts: MAX_PROVIDER_ATTEMPTS,
    maxWallClockMs: MAX_WALL_CLOCK_MS,
    model: QWEN_MODEL,
    routeAlias: ROUTE_ALIAS,
    modelBinding: 'opaque_fixed_case_agent_read_v1',
    modelLeaseSourceDigest,
    endpointIdentityDigest: sha256DomainSeparated(
      'kite.github-actions-agent-evaluation.endpoint-identity.v1',
      canonicalJsonBytes({ origin: new URL(QWEN_BASE_URL).origin }),
    ),
    capabilityPolicy: 'in_process_read_file_only',
  });
  const material = {
    suiteId: 'github-actions-agent-evaluation-v1',
    caseId: 'gha-agent-read-synthetic-v1',
    routeAlias: ROUTE_ALIAS,
    model: QWEN_MODEL,
    fixtureDigest: fixture.fixtureDigest,
    corpusDigest,
    oracleDigest,
    evaluatorDigest,
    runnerDigest,
    modelLeaseSourceDigest,
    workflowSourceDigest,
    toolCatalogDigest: toolCatalog.digest,
    policyDigest,
  };
  return suiteSchema.parse({
    ...material,
    suiteDigest: digestMaterial('suite.v1', material),
  });
}

/** The checked-in synthetic fixture is readable only as a sealed two-file tree. */
export function sourceOwnedAgentEvaluationFixtureV1(): {
  readonly relativePath: typeof FIXTURE_RELATIVE_PATH;
  readonly expectedAnswer: string;
  readonly fixtureDigest: `sha256:${string}`;
} {
  const fixture = readSourceFixtureV1();
  return Object.freeze({
    relativePath: fixture.relativePath,
    expectedAnswer: fixture.content,
    fixtureDigest: fixture.fixtureDigest,
  });
}

/** Explicit preflight never reads the credential or constructs a model binding. */
export async function runGitHubActionsAgentEvaluationV1(
  input: RunGitHubActionsAgentEvaluationV1Input = {},
): Promise<GitHubActionsAgentEvaluationRunReportV1> {
  const mode = input.mode ?? 'live';
  const environment = input.environment ?? process.env;
  let suite: GitHubActionsAgentEvaluationSuiteV1;
  try {
    suite = buildGitHubActionsAgentEvaluationSuiteV1();
  } catch {
    return buildReportV1({
      suite: fallbackSuiteV1(),
      candidate: null,
      execution: null,
      result: resultV1('blocked', 'fixture_invalid', 0, 0, 0, 0, 0, undefined),
    });
  }

  let execution: GitHubActionsAgentEvaluationWorkflowIdentityV1;
  try {
    execution = readWorkflowIdentityV1(environment, mode);
  } catch {
    return buildReportV1({
      suite,
      candidate: null,
      execution: null,
      result: resultV1('blocked', 'github_context_invalid', 0, 0, 0, 0, 0, undefined),
    });
  }
  const candidate = buildCandidateV1(execution.commit, suite);

  if (mode === 'preflight') {
    return buildReportV1({
      suite,
      candidate,
      execution,
      result: resultV1('blocked', 'preflight_only', 0, 0, 0, 0, 0, undefined),
    });
  }

  if (input.signal?.aborted) {
    return buildReportV1({
      suite,
      candidate,
      execution,
      result: resultV1('cancelled', 'cancelled', 0, 0, 0, 0, 0, undefined),
    });
  }
  if (
    !isGitHubActionsDiagnosticModelBindingV1(input.binding) ||
    input.binding.caseId !== 'agent_read' ||
    typeof input.binding.model.model === 'string'
  ) {
    return buildReportV1({
      suite,
      candidate,
      execution,
      result: resultV1('blocked', 'model_binding_unavailable', 0, 0, 0, 0, 0, undefined),
    });
  }

  let fixture: MaterializedFixtureV1 | undefined;
  const startedAt = Date.now();
  const deadline = createDeadlineBoundRunV1(input.signal);
  const quotaBinding = createQuotaBoundModelV1(input.binding.model, deadline);
  let events: RuntimeEvent[] = [];
  let outcome: {
    status: z.infer<typeof resultSchema>['status'];
    reason: GitHubActionsAgentEvaluationReasonCodeV1;
  } = {
    status: 'failed',
    reason: 'runtime_terminal_failure',
  };
  try {
    const materializedFixture = materializeFixtureV1(readSourceFixtureV1());
    fixture = materializedFixture;
    events = await withEphemeralProcessBoundaryV1(materializedFixture, async () => {
      const config = createGitHubActionsAgentEvaluationConfigV1(
        materializedFixture.workspace,
        suite.toolCatalogDigest,
      );
      const observed: RuntimeEvent[] = [];
      for await (const event of runRuntimeAgent(
        {
          task: 'Read facts/verification-token.txt with the available tool and return exactly its content, with no explanation.',
          userId: 'github-actions-diagnostic',
          threadId: `gha-agent-eval-${randomUUID()}`,
          workspace: materializedFixture.workspace,
          runtimeStorePath: ':memory:',
          config,
          model: quotaBinding.model,
          sessionLoggingPolicy: {
            version: 1,
            mode: 'off',
            retentionDays: 1,
            maxTotalBytes: 1024,
            maxSessionBytes: 1024,
            includeReasoning: false,
            includeFileContent: false,
            includeToolContent: false,
          },
          signal: deadline.signal,
          sandboxBackend: 'unknown',
        },
        {
          requestAction: async (effect) => ({
            type: 'cancel' as const,
            interactionId: effect.interactionId,
          }),
        },
      )) {
        observed.push(event);
      }
      return observed;
    });
    outcome = evaluateRuntimeEventsV1(
      events,
      readSourceFixtureV1().content,
      input.signal?.aborted === true,
      deadline.deadlineExceeded(),
      quotaBinding.attempts(),
    );
    if (!fixtureContentMatchesV1(materializedFixture, readSourceFixtureV1())) {
      outcome = { status: 'failed', reason: 'fixture_mutated' };
    }
  } catch (error) {
    outcome = {
      status: deadline.deadlineExceeded()
        ? 'blocked'
        : input.signal?.aborted
          ? 'cancelled'
          : 'failed',
      reason: deadline.deadlineExceeded()
        ? 'time_limit_exceeded'
        : input.signal?.aborted
          ? 'cancelled'
          : error instanceof ProviderAttemptQuotaError
            ? 'model_call_limit_exceeded'
            : 'model_dispatch_failed',
    };
  } finally {
    deadline.dispose();
    if (fixture && !cleanupFixtureV1(fixture)) {
      outcome = { status: 'blocked', reason: 'cleanup_failed' };
    }
  }

  const modelResponses = events.filter((event) => event.type === 'model.responded').length;
  const readFileCalls = events.filter(
    (event) => event.type === 'tool.queued' && event.name === 'read_file',
  ).length;
  const rejectedToolCalls = toolPolicyViolationCallIdsV1(events).size;
  const tokenCount = events.reduce((total, event) => {
    if (event.type !== 'model.responded') return total;
    const inputTokens = typeof event.inputTokens === 'number' ? event.inputTokens : 0;
    const outputTokens = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
    return total + inputTokens + outputTokens;
  }, 0);
  const durationMs = Date.now() - startedAt;
  if (durationMs > MAX_WALL_CLOCK_MS || deadline.deadlineExceeded()) {
    outcome = { status: 'blocked', reason: 'time_limit_exceeded' };
  } else if (
    outcome.reason === 'passed' &&
    (input.binding.transportProofKind !== 'provider_fetch' ||
      input.binding.transportEntries() !== MAX_PROVIDER_ATTEMPTS)
  ) {
    // A local contract model can exercise the runtime chain, but it can never
    // claim that the fixed provider transport was actually entered.
    outcome = { status: 'blocked', reason: 'transport_proof_unavailable' };
  }
  return buildReportV1({
    suite,
    candidate,
    execution,
    result: resultV1(
      outcome.status,
      outcome.reason,
      quotaBinding.attempts(),
      modelResponses,
      readFileCalls,
      rejectedToolCalls,
      durationMs,
      tokenCount > 0 ? tokenCount : undefined,
      transportDispositionV1(input.binding),
    ),
  });
}

function buildReportV1(input: {
  suite: GitHubActionsAgentEvaluationSuiteV1;
  candidate: z.infer<typeof candidateSchema> | null;
  execution: GitHubActionsAgentEvaluationWorkflowIdentityV1 | null;
  result: z.infer<typeof resultSchema>;
}): GitHubActionsAgentEvaluationRunReportV1 {
  const material = reportMaterialSchema.parse({
    schema: GITHUB_ACTIONS_AGENT_EVALUATION_REPORT_SCHEMA_V1,
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    candidate: input.candidate,
    execution: input.execution,
    suite: input.suite,
    result: input.result,
  });
  return githubActionsAgentEvaluationRunReportV1Schema.parse({
    ...material,
    reportDigest: computeGitHubActionsAgentEvaluationReportDigestV1(material),
  });
}

function resultV1(
  status: z.infer<typeof resultSchema>['status'],
  reasonCode: GitHubActionsAgentEvaluationReasonCodeV1,
  providerAttempts: number,
  modelResponses: number,
  readFileCalls: number,
  rejectedToolCalls: number,
  durationMs: number,
  tokenCount: number | undefined,
  transportDisposition: z.infer<typeof resultSchema>['transportDisposition'] = 'not_observed',
): z.infer<typeof resultSchema> {
  return resultSchema.parse({
    status,
    reasonCode,
    providerAttempts: Math.min(MAX_PROVIDER_ATTEMPTS, Math.max(0, providerAttempts)),
    modelResponses: Math.min(MAX_PROVIDER_ATTEMPTS, Math.max(0, modelResponses)),
    readFileCalls: Math.min(MAX_PROVIDER_ATTEMPTS, Math.max(0, readFileCalls)),
    rejectedToolCalls: Math.min(MAX_PROVIDER_ATTEMPTS, Math.max(0, rejectedToolCalls)),
    transportDisposition,
    durationBucket:
      durationMs < 15_000
        ? 'under_15s'
        : durationMs <= MAX_WALL_CLOCK_MS
          ? '15s_to_60s'
          : 'over_60s',
    tokenBucket:
      tokenCount === undefined
        ? 'unknown'
        : tokenCount < 512
          ? 'under_512'
          : tokenCount <= 2048
            ? '512_to_2048'
            : 'over_2048',
    costBucket: 'not_observed',
  });
}

function transportDispositionV1(
  binding: GitHubActionsDiagnosticModelBindingV1,
): z.infer<typeof resultSchema>['transportDisposition'] {
  if (binding.transportProofKind === 'contract_only') return 'contract_only';
  return binding.transportEntries() > 0 ? 'provider_fetch_entered' : 'not_observed';
}

function readWorkflowIdentityV1(
  environment: NodeJS.ProcessEnv,
  mode: GitHubActionsAgentEvaluationModeV1,
): GitHubActionsAgentEvaluationWorkflowIdentityV1 {
  const job = mode === 'preflight' ? 'preflight' : 'live-agent-evaluation';
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
    material.job !== job ||
    material.workflowSha !== material.commit
  ) {
    throw new GithubContextError();
  }
  const parsed = workflowIdentityMaterialSchema.safeParse(material);
  if (!parsed.success) throw new GithubContextError();
  return workflowIdentitySchema.parse({
    ...parsed.data,
    identityDigest: computeWorkflowIdentityDigestV1(parsed.data),
  });
}

function buildCandidateV1(
  commit: string,
  suite: GitHubActionsAgentEvaluationSuiteV1,
): z.infer<typeof candidateSchema> {
  return candidateSchema.parse({
    commit,
    candidateDigest: digestMaterial('candidate.v1', {
      canonicalRepository: GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
      commit,
      suiteDigest: suite.suiteDigest,
      workflowSourceDigest: suite.workflowSourceDigest,
    }),
  });
}

function createReadOnlyToolCatalogV1() {
  const descriptor = builtinToolRegistry.descriptorOf(readFileSpec);
  const material = {
    version: 1 as const,
    revision: 'github-actions-agent-evaluation-read-only-v1',
    tools: [
      {
        toolId: descriptor.capabilityId,
        descriptorRevision: descriptor.revision,
        filesystem: 'workspace_read' as const,
        network: 'none' as const,
        process: false as const,
        write: false as const,
        externalPath: false as const,
      },
    ],
  };
  return inProcessReadOnlyToolCatalogV1Schema.parse({
    ...material,
    digest: computeInProcessReadOnlyToolCatalogDigestV1(material),
  });
}

export function createGitHubActionsAgentEvaluationExecutionCapabilitySurfaceV1(): ExecutionCapabilitySurfaceV1 {
  return {
    inProcessReadOnlyTools: createReadOnlyToolCatalogV1(),
    network: false,
    process: false,
    write: false,
    workspaceWrite: false,
    shell: false,
    skillChild: false,
    localStdioMcp: false,
  };
}

export function createGitHubActionsAgentEvaluationConfigV1(
  workspace: string,
  expectedToolCatalogDigest?: string,
): AgentConfig {
  const executionCapabilitySurface =
    createGitHubActionsAgentEvaluationExecutionCapabilitySurfaceV1();
  const toolCatalog = executionCapabilitySurface.inProcessReadOnlyTools;
  if (!toolCatalog) throw new Error('tool_catalog_unavailable');
  if (expectedToolCatalogDigest !== undefined && toolCatalog.digest !== expectedToolCatalogDigest) {
    throw new Error('tool_catalog_identity_mismatch');
  }
  return {
    providerName: ROUTE_ALIAS,
    providerType: 'openai-compatible',
    // The actual credential belongs only to the model binding closure. The
    // Runtime config intentionally cannot carry it into tools or child paths.
    apiKey: 'credential-unavailable-to-runtime',
    baseURL: 'https://diagnostic.invalid',
    modelName: QWEN_MODEL,
    modelKwargs: { maxOutputTokens: MAX_OUTPUT_TOKENS, supportsToolCalls: true },
    modelCapabilities: { maxOutputTokens: MAX_OUTPUT_TOKENS, streaming: false },
    sandbox: { enabled: false },
    executionBoundary: parseExecutionBoundaryV1({
      filesystemScope: 'read_only',
      workspaceRoot: workspace,
      networkMode: 'off',
      networkAllowlist: [],
      allowLocalAndPrivateNetwork: false,
      protectedPathPolicy: 'deny',
      maxProcessTreeSizePerShellInvocation: 1,
      sandboxRequired: false,
      sandboxUnavailable: 'verified_in_process_read_only',
    }),
    executionCapabilitySurface,
  };
}

function createQuotaBoundModelV1(
  base: SupportedChatModel,
  deadline: DeadlineBoundRunV1,
): {
  model: SupportedChatModel;
  attempts: () => number;
} {
  let attempts = 0;
  const quotaMiddleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params }) => {
      // The first check rejects an already-aborted call before it can reserve
      // an attempt. The second lives inside the scheduled operation, closing
      // the microtask gap where the deadline can fire after this wrapper is
      // entered but before the concrete adapter is invoked.
      assertProviderDispatchAllowedV1(deadline, params.abortSignal);
      const operation = Promise.resolve().then(() => {
        assertProviderDispatchAllowedV1(deadline, params.abortSignal);
        if (attempts >= MAX_PROVIDER_ATTEMPTS) throw new ProviderAttemptQuotaError();
        attempts++;
        return doGenerate();
      });
      // `doGenerate` may ignore AbortSignal. Race the concrete Provider
      // operation before Runtime can wait indefinitely or issue a follow-up.
      return await deadline.awaitOperation(operation);
    },
    wrapStream: async () => {
      throw new Error('streaming_not_admitted');
    },
  };
  const baseModel = base.model;
  if (typeof baseModel === 'string') throw new Error('model_binding_not_concrete');
  return {
    model: {
      ...base,
      model: wrapLanguageModel({
        model: baseModel as Parameters<typeof wrapLanguageModel>[0]['model'],
        middleware: quotaMiddleware,
      }),
      supportsToolCalls: true,
      capabilityMetadata: {
        ...base.capabilityMetadata,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        streaming: false,
      },
    },
    attempts: () => attempts,
  };
}

function assertProviderDispatchAllowedV1(
  deadline: DeadlineBoundRunV1,
  operationSignal: AbortSignal | undefined,
): void {
  if (!deadline.signal.aborted && !operationSignal?.aborted) return;
  if (deadline.deadlineExceeded()) throw new AgentEvaluationDeadlineExceededError();
  throw new Error('github_actions_agent_evaluation_dispatch_cancelled');
}

function evaluateRuntimeEventsV1(
  events: readonly RuntimeEvent[],
  expectedAnswer: string,
  externallyCancelled: boolean,
  deadlineExceeded: boolean,
  providerAttempts: number,
): {
  status: z.infer<typeof resultSchema>['status'];
  reason: GitHubActionsAgentEvaluationReasonCodeV1;
} {
  if (deadlineExceeded) {
    return { status: 'blocked', reason: 'time_limit_exceeded' };
  }
  if (externallyCancelled || events.some((event) => event.type === 'turn.aborted')) {
    return { status: 'cancelled', reason: 'cancelled' };
  }
  const queued = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'tool.queued' }> =>
      event.type === 'tool.queued',
  );
  const finished = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
      event.type === 'tool.finished',
  );
  const responses = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'model.responded' }> =>
      event.type === 'model.responded',
  );
  const finalAnswer = responses.at(-1)?.text?.trim();
  if (
    providerAttempts >= MAX_PROVIDER_ATTEMPTS &&
    events.some((event) => event.type === 'run.error')
  ) {
    return { status: 'failed', reason: 'model_call_limit_exceeded' };
  }
  if (events.some((event) => event.type === 'model.retry')) {
    return { status: 'failed', reason: 'model_call_limit_exceeded' };
  }
  if (toolPolicyViolationCallIdsV1(events).size > 0) {
    return { status: 'failed', reason: 'tool_policy_violation' };
  }
  if (events.some((event) => event.type === 'run.error')) {
    return { status: 'failed', reason: 'runtime_terminal_failure' };
  }
  if (
    responses.some(
      (event) =>
        !isKnownNonNegativeTokenCountV1(event.inputTokens) ||
        !isKnownNonNegativeTokenCountV1(event.outputTokens),
    )
  ) {
    return { status: 'blocked', reason: 'usage_unavailable' };
  }
  const totalInputTokens = responses.reduce((total, event) => total + event.inputTokens!, 0);
  const totalOutputTokens = responses.reduce((total, event) => total + event.outputTokens!, 0);
  if (totalInputTokens > MAX_TOTAL_INPUT_TOKENS || totalOutputTokens > MAX_TOTAL_OUTPUT_TOKENS) {
    return { status: 'blocked', reason: 'token_quota_exceeded' };
  }
  const onlyQueuedRead = queued.length === 1 ? queued[0] : undefined;
  const onlyFinishedRead = finished.length === 1 ? finished[0] : undefined;
  if (
    !onlyQueuedRead ||
    !onlyFinishedRead ||
    onlyFinishedRead.name !== 'read_file' ||
    onlyFinishedRead.toolCallId !== onlyQueuedRead.toolCallId ||
    onlyFinishedRead.result.ok !== true
  ) {
    return { status: 'failed', reason: 'oracle_mismatch' };
  }
  if (responses.length < 2 || finalAnswer !== expectedAnswer) {
    return { status: 'failed', reason: 'oracle_mismatch' };
  }
  if (!events.some((event) => event.type === 'run.completed')) {
    return { status: 'failed', reason: 'runtime_terminal_failure' };
  }
  return { status: 'passed', reason: 'passed' };
}

function isKnownNonNegativeTokenCountV1(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The public report retains only a count, but its in-memory oracle must bind
 * the exact canonical read call to the successful tool completion. A failed
 * read is a policy violation here even when Runtime models it as
 * `tool.finished { ok: false }` instead of `tool.rejected`.
 */
function toolPolicyViolationCallIdsV1(events: readonly RuntimeEvent[]): Set<string> {
  const violationCallIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === 'tool.rejected' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.cancelled' ||
      (event.type === 'tool.finished' && event.result.ok !== true)
    ) {
      violationCallIds.add(event.toolCallId);
      continue;
    }
    if (
      event.type === 'tool.queued' &&
      (event.name !== 'read_file' || !isCanonicalFixtureReadArgsV1(event.args))
    ) {
      violationCallIds.add(event.toolCallId);
    }
  }
  return violationCallIds;
}

function isCanonicalFixtureReadArgsV1(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  const entries = Object.entries(args);
  return (
    entries.length === 1 && entries[0]?.[0] === 'path' && entries[0][1] === FIXTURE_RELATIVE_PATH
  );
}

function readSourceFixtureV1(): SourceFixtureV1 {
  const root = resolve(FIXTURE_DIRECTORY);
  const factsRoot = join(root, 'facts');
  const filePath = join(root, FIXTURE_RELATIVE_PATH);
  try {
    if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) throw new Error();
    if (lstatSync(factsRoot).isSymbolicLink() || !statSync(factsRoot).isDirectory())
      throw new Error();
    if (lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) throw new Error();
    if ((statSync(filePath).mode & 0o111) !== 0) throw new Error();
    if (readdirSync(root).sort().join(',') !== 'facts') throw new Error();
    if (readdirSync(factsRoot).sort().join(',') !== basename(FIXTURE_RELATIVE_PATH))
      throw new Error();
    if (relative(root, realpathSync(filePath)) !== FIXTURE_RELATIVE_PATH) throw new Error();
  } catch {
    throw new Error('fixture_invalid');
  }
  const content = readFileSync(filePath, 'utf8').trim();
  if (!/^KITE-GHA-READ-VERIFY-[0-9]{2}$/.test(content)) throw new Error('fixture_invalid');
  const corpusDigest = digestText('fixture-content.v1', content);
  return {
    root,
    relativePath: FIXTURE_RELATIVE_PATH,
    content,
    corpusDigest,
    fixtureDigest: digestMaterial('fixture.v1', {
      fixtureId: 'github-actions-agent-evaluation-v1',
      files: [{ path: FIXTURE_RELATIVE_PATH, contentDigest: corpusDigest }],
    }),
  };
}

function materializeFixtureV1(source: SourceFixtureV1): MaterializedFixtureV1 {
  const root = mkdtempSync(join(tmpdir(), 'kite-gh-agent-evaluation-'));
  const workspace = join(root, 'workspace');
  const facts = join(workspace, 'facts');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  const fixturePath = join(workspace, source.relativePath);
  try {
    for (const directory of [workspace, facts, home, config, data, state, cwd]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(fixturePath, `${source.content}\n`, { encoding: 'utf8', mode: 0o400 });
    chmodSync(fixturePath, 0o400);
    chmodSync(facts, 0o500);
    chmodSync(workspace, 0o500);
    return { root, workspace, home, config, data, state, cwd, fixturePath };
  } catch {
    rmSync(root, { recursive: true, force: true });
    throw new Error('fixture_invalid');
  }
}

let processBoundaryTail: Promise<void> = Promise.resolve();

async function withEphemeralProcessBoundaryV1<Result>(
  fixture: MaterializedFixtureV1,
  callback: () => Promise<Result>,
): Promise<Result> {
  let release: (() => void) | undefined;
  const previousBoundary = processBoundaryTail;
  processBoundaryTail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previousBoundary;
  const previousCwd = process.cwd();
  const previousEnvironment = new Map<string, string | undefined>(
    SAFE_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    process.chdir(fixture.cwd);
    process.env.HOME = fixture.home;
    process.env.KITE_CODE_HOME = join(fixture.home, '.kite-code');
    process.env.PWD = fixture.cwd;
    process.env.USERPROFILE = fixture.home;
    process.env.XDG_CONFIG_HOME = fixture.config;
    process.env.XDG_DATA_HOME = fixture.data;
    process.env.XDG_STATE_HOME = fixture.state;
    return await callback();
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    release?.();
  }
}

function fixtureContentMatchesV1(fixture: MaterializedFixtureV1, source: SourceFixtureV1): boolean {
  try {
    return readFileSync(fixture.fixturePath, 'utf8').trim() === source.content;
  } catch {
    return false;
  }
}

function cleanupFixtureV1(fixture: MaterializedFixtureV1): boolean {
  try {
    // `root` is not caller-controlled: it is the private result of mkdtempSync
    // in materializeFixtureV1. Do not resolve it here because macOS can expose
    // /var and /private/var spellings for the same temporary parent.
    if (!basename(fixture.root).startsWith('kite-gh-agent-evaluation-')) {
      return false;
    }
    // The fixture is intentionally read-only during Agent execution. Restore
    // permissions only on this runner-created tree before removing it; no
    // caller-provided path can reach this cleanup path.
    if (existsSync(fixture.fixturePath)) chmodSync(fixture.fixturePath, 0o600);
    for (const directory of [
      join(fixture.workspace, 'facts'),
      fixture.workspace,
      fixture.home,
      fixture.config,
      fixture.data,
      fixture.state,
      fixture.cwd,
      fixture.root,
    ]) {
      if (existsSync(directory)) chmodSync(directory, 0o700);
    }
    rmSync(fixture.root, { recursive: true, force: true });
    return !existsSync(fixture.root);
  } catch {
    return false;
  }
}

function fallbackSuiteV1(): GitHubActionsAgentEvaluationSuiteV1 {
  const digest = digestMaterial('fallback-suite.v1', { status: 'fixture_invalid' });
  return suiteSchema.parse({
    suiteId: 'github-actions-agent-evaluation-v1',
    caseId: 'gha-agent-read-synthetic-v1',
    routeAlias: ROUTE_ALIAS,
    model: QWEN_MODEL,
    fixtureDigest: digest,
    corpusDigest: digest,
    oracleDigest: digest,
    evaluatorDigest: digest,
    runnerDigest: digest,
    modelLeaseSourceDigest: digest,
    workflowSourceDigest: digest,
    toolCatalogDigest: digest,
    policyDigest: digest,
    suiteDigest: digest,
  });
}

function digestMaterial(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(
    `kite.github-actions-agent-evaluation.${domain}`,
    canonicalJsonBytes(value),
  );
}

function digestText(domain: string, value: string): `sha256:${string}` {
  return digestMaterial(domain, { value });
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--preflight') ? 'preflight' : 'live';
  // Secret acquisition belongs solely to the GitHub Actions aggregate
  // supervisor. This standalone entrypoint intentionally has no way to turn
  // a raw Environment secret into a model binding.
  const report = await runGitHubActionsAgentEvaluationV1({ mode, environment: process.env });
  // This is the only external output. Its exact schema deliberately excludes
  // raw Runtime events, model output, task text, fixture bytes, paths, and errors.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (mode === 'live' && report.result.status !== 'passed') process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    const report = buildReportV1({
      suite: fallbackSuiteV1(),
      candidate: null,
      execution: null,
      result: resultV1('failed', 'model_dispatch_failed', 0, 0, 0, 0, 0, undefined),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  }
}
