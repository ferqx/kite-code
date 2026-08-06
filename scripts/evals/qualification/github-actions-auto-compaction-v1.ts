import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { z } from 'zod';
import type { AgentConfig } from '../../../src/core/config';
import { buildContextProjection } from '../../../src/core/model/context-projection';
import type { SupportedChatModel } from '../../../src/core/model/factory';
import type { RuntimeEffect } from '../../../src/core/runtime/effects';
import type { RuntimeEvent } from '../../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../../src/core/runtime/executor';
import { AgentKernel, type RuntimeEffectExecutor } from '../../../src/core/runtime/kernel';
import { type RuntimeActionProvider, runRuntimeLoop } from '../../../src/core/runtime/runner';
import { decideNextEffect } from '../../../src/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '../../../src/core/runtime/state';
import { createRuntimeStore } from '../../../src/core/runtime/store';
import { countTokens } from '../../../src/core/token-counter';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';
import {
  type GitHubActionsDiagnosticModelBindingV1,
  isGitHubActionsDiagnosticModelBindingV1,
} from './github-actions-agent-diagnostic-model-lease-v1';
import {
  computeWorkflowIdentityDigestV1,
  GITHUB_ACTIONS_AGENT_EVALUATION_CANONICAL_REPOSITORY_V1,
  GITHUB_ACTIONS_AGENT_EVALUATION_WORKFLOW_PATH_V1,
} from './github-actions-agent-evaluation-v1';

/**
 * ADR-0072 public-safe diagnostic only. This is deliberately not the formal
 * ADR-0071 L3 observation runner and cannot produce release evidence.
 */
export const GITHUB_ACTIONS_AUTO_COMPACTION_DIAGNOSTIC_REPORT_SCHEMA_V1 =
  'GitHubActionsAutoCompactionDiagnosticReportV1' as const;

const ROUTE_ALIAS = 'gha-diagnostic-qwen';
const MODEL = 'qwen3.6-flash';
const MAX_PROVIDER_ATTEMPTS = 2;
const MAX_WALL_CLOCK_MS = 60_000;
const SUMMARY_INPUT_CAP = 7_800;
const SUMMARY_OUTPUT_CAP = 600;
const PRIMARY_INPUT_CAP = 3_229;
const PRIMARY_OUTPUT_CAP = 600;
const AUTO_COMPACTION_THRESHOLD = 8_192;
const FULL_PROJECTION_MIN_TOKENS = 9_000;
const FULL_PROJECTION_MAX_TOKENS = 10_000;
const HISTORY_REPEATS = 532;
const SAFE_HISTORY_CHUNK =
  'stable synthetic historical qualification material with no secrets and no instructions. ';
const SAFE_CURRENT_TURN = 'go';
const RUNNER_SOURCE_PATH = new URL('./github-actions-auto-compaction-v1.ts', import.meta.url);
const MODEL_LEASE_SOURCE_PATH = new URL(
  './github-actions-agent-diagnostic-model-lease-v1.ts',
  import.meta.url,
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
export type GitHubActionsAutoCompactionWorkflowIdentityV1 = z.infer<typeof workflowIdentitySchema>;

const candidateSchema = z
  .object({
    commit: commitSchema,
    candidateDigest: digestSchema,
  })
  .strict();

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
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    workflowSourceDigest: digestSchema,
    policyDigest: digestSchema,
    suiteDigest: digestSchema,
  })
  .strict();
export type GitHubActionsAutoCompactionSuiteV1 = z.infer<typeof suiteSchema>;

const scenarioSchema = z.enum(['success', 'cancel']);
export type GitHubActionsAutoCompactionScenarioV1 = z.infer<typeof scenarioSchema>;

const reasonCodeSchema = z.enum([
  'automatic_compaction_not_observed',
  'cleanup_failed',
  'effect_sequence_violation',
  'external_cancelled',
  'github_context_invalid',
  'harness_abort_not_observed',
  'model_binding_unavailable',
  'model_dispatch_failed',
  'model_output_policy_violation',
  'passed_client_abort_after_transport_entry',
  'passed_success',
  'runtime_terminal_failure',
  'source_binding_invalid',
  'time_limit_exceeded',
  'token_quota_exceeded',
  'transport_proof_unavailable',
  'usage_unavailable',
]);
export type GitHubActionsAutoCompactionReasonCodeV1 = z.infer<typeof reasonCodeSchema>;
type BlockedReasonCodeV1 = Exclude<
  GitHubActionsAutoCompactionReasonCodeV1,
  'passed_success' | 'passed_client_abort_after_transport_entry'
>;

const resultSchema = z
  .object({
    scenario: scenarioSchema,
    status: z.enum(['passed', 'failed', 'blocked']),
    reasonCode: reasonCodeSchema,
    outcome: z.enum(['success', 'client_abort_after_transport_entry', 'not_observed']),
    providerAttempts: z.number().int().min(0).max(MAX_PROVIDER_ATTEMPTS),
    summaryDispatches: z.number().int().min(0).max(1),
    primaryDispatches: z.number().int().min(0).max(1),
    automaticCompactionRequests: z.number().int().min(0).max(2),
    nextUserTurnRetryPreflight: z.boolean(),
    usageDisposition: z.enum(['observed', 'conservative_abort_charge', 'not_observed']),
    transportDisposition: z.enum(['provider_fetch_entered', 'contract_only', 'not_observed']),
    durationBucket: z.enum(['under_15s', '15s_to_60s', 'over_60s']),
    costBucket: z.literal('not_observed'),
  })
  .strict()
  .superRefine((value, context) => {
    const passedSuccess =
      value.scenario === 'success' &&
      value.status === 'passed' &&
      value.reasonCode === 'passed_success' &&
      value.outcome === 'success' &&
      value.providerAttempts === 2 &&
      value.summaryDispatches === 1 &&
      value.primaryDispatches === 1 &&
      value.automaticCompactionRequests === 1 &&
      value.nextUserTurnRetryPreflight === false &&
      value.usageDisposition === 'observed' &&
      value.transportDisposition === 'provider_fetch_entered' &&
      value.durationBucket !== 'over_60s';
    const passedCancel =
      value.scenario === 'cancel' &&
      value.status === 'passed' &&
      value.reasonCode === 'passed_client_abort_after_transport_entry' &&
      value.outcome === 'client_abort_after_transport_entry' &&
      value.providerAttempts === 1 &&
      value.summaryDispatches === 1 &&
      value.primaryDispatches === 0 &&
      value.automaticCompactionRequests === 2 &&
      value.nextUserTurnRetryPreflight === true &&
      value.usageDisposition === 'conservative_abort_charge' &&
      value.transportDisposition === 'provider_fetch_entered' &&
      value.durationBucket !== 'over_60s';
    if (value.status === 'passed' && !passedSuccess && !passedCancel) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'passed diagnostic result violates its closed scenario invariant',
      });
    }
    if (value.status !== 'passed' && value.outcome !== 'not_observed') {
      context.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'non-passed diagnostic result must remain not observed',
      });
    }
  });

const reportMaterialSchema = z
  .object({
    schema: z.literal(GITHUB_ACTIONS_AUTO_COMPACTION_DIAGNOSTIC_REPORT_SCHEMA_V1),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    candidate: candidateSchema.nullable(),
    execution: workflowIdentitySchema.nullable(),
    suite: suiteSchema,
    result: resultSchema,
  })
  .strict();

export const githubActionsAutoCompactionDiagnosticReportV1Schema = reportMaterialSchema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    if (reportDigest !== computeGitHubActionsAutoCompactionDiagnosticReportDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: 'diagnostic report digest mismatch',
      });
    }
  });
export type GitHubActionsAutoCompactionDiagnosticReportV1 = z.infer<
  typeof githubActionsAutoCompactionDiagnosticReportV1Schema
>;

export interface RunGitHubActionsAutoCompactionDiagnosticV1Input {
  /** Opaque fixed-case binding; raw credentials and arbitrary models are rejected. */
  readonly binding?: GitHubActionsDiagnosticModelBindingV1;
  readonly scenario: GitHubActionsAutoCompactionScenarioV1;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

interface IsolatedSyntheticRootV1 {
  readonly root: string;
  readonly fixture: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cwd: string;
}

interface DeadlineBoundRunV1 {
  readonly signal: AbortSignal;
  readonly deadlineExceeded: () => boolean;
  readonly externallyCancelled: () => boolean;
  readonly abortForHarness: () => void;
  readonly harnessAborted: () => boolean;
  readonly awaitOperation: <Value>(operation: Promise<Value>) => Promise<Value>;
  readonly dispose: () => void;
}

interface PhaseUsageV1 {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface AutoCompactionTrackerV1 {
  providerAttempts: number;
  summaryDispatches: number;
  primaryDispatches: number;
  summaryTransportEntered: boolean;
  harnessAbortAfterTransportEntry: boolean;
  automaticCompactionRequests: number;
  compactionCompleted: boolean;
  summaryAborted: boolean;
  primaryResponded: boolean;
  nextUserTurnRetryPreflight: boolean;
  unexpectedEffect: boolean;
  runtimeTerminalFailure: boolean;
  modelOutputPolicyViolation: boolean;
  usageUnavailable: boolean;
  tokenQuotaExceeded: boolean;
  fullProjectionInRange: boolean;
  summaryUsage?: PhaseUsageV1;
  primaryUsage?: PhaseUsageV1;
}

const noInteractionProvider: RuntimeActionProvider = {
  async requestAction() {
    throw new Error('interaction_not_admitted');
  },
};

class UnexpectedDiagnosticEffectError extends Error {
  constructor() {
    super('unexpected_diagnostic_effect');
    this.name = 'UnexpectedDiagnosticEffectError';
  }
}

class DiagnosticDeadlineExceededError extends Error {
  constructor() {
    super('github_actions_auto_compaction_deadline_exceeded');
    this.name = 'DiagnosticDeadlineExceededError';
  }
}

export function computeGitHubActionsAutoCompactionDiagnosticReportDigestV1(
  material: z.infer<typeof reportMaterialSchema>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.github-actions-auto-compaction-diagnostic.report.v1',
    canonicalJsonBytes(reportMaterialSchema.parse(material)),
  );
}

/** Rebuild source-owned policy and all execution bindings before accepting a report. */
export function verifyGitHubActionsAutoCompactionDiagnosticReportV1(
  value: unknown,
): GitHubActionsAutoCompactionDiagnosticReportV1 {
  const report = githubActionsAutoCompactionDiagnosticReportV1Schema.parse(value);
  const expectedSuite = buildGitHubActionsAutoCompactionSuiteV1();
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
      report.execution.job !== 'live-agent-evaluation'
    ) {
      throw new Error('passed_report_execution_invariant_failed');
    }
  }
  return report;
}

/**
 * Source-owned suite identity contains digests only. It intentionally omits
 * transcript, summary, model response, endpoint, paths, credentials and raw
 * Provider errors from every serializable output.
 */
export function buildGitHubActionsAutoCompactionSuiteV1(): GitHubActionsAutoCompactionSuiteV1 {
  const fixtureDigest = digestMaterial('fixture.v1', {
    fixtureId: 'github-actions-auto-compaction-synthetic-v1',
    fixtureRoot: 'sealed-empty-read-only-root',
  });
  const corpusDigest = digestMaterial('corpus.v1', {
    historyDigest: digestText('history.v1', SAFE_HISTORY_CHUNK.repeat(HISTORY_REPEATS)),
    currentTurnDigest: digestText('current-turn.v1', SAFE_CURRENT_TURN),
    historyRepeats: HISTORY_REPEATS,
  });
  const oracleDigest = digestMaterial('oracle.v1', {
    expectedEffects: ['call_model', 'compact_context', 'call_model'],
    cancellationExpectedEffects: ['call_model', 'compact_context'],
    cancellationOutcome: 'client_abort_after_transport_entry',
    requiredNextTurn: 'scheduler_preflight_only',
  });
  const evaluatorDigest = digestMaterial('evaluator.v1', {
    implementation: 'runtime-events-and-bound-model-in-memory-oracle',
    version: 1,
  });
  const verifierDigest = digestMaterial('verifier.v1', {
    implementation: 'fresh-source-suite-and-workflow-binding',
    version: 1,
  });
  // The direct model binding's fetch policy is part of the runner closure.
  // Hashing only this file would allow that policy to drift without changing
  // the source-owned suite identity.
  const runnerDigest = digestMaterial('runner-closure.v1', {
    runnerSourceDigest: sha256DomainSeparated(
      'kite.github-actions-auto-compaction-diagnostic.runner-source.v1',
      readFileSync(RUNNER_SOURCE_PATH),
    ),
    modelLeaseSourceDigest: sha256DomainSeparated(
      'kite.github-actions-auto-compaction-diagnostic.model-lease-source.v1',
      readFileSync(MODEL_LEASE_SOURCE_PATH),
    ),
  });
  const workflowSourceDigest = sha256DomainSeparated(
    'kite.github-actions-auto-compaction-diagnostic.workflow-source.v1',
    readFileSync(WORKFLOW_SOURCE_PATH),
  );
  const policyDigest = digestMaterial('policy.v1', {
    autoCompactionThreshold: AUTO_COMPACTION_THRESHOLD,
    fullProjectionTokens: {
      minimum: FULL_PROJECTION_MIN_TOKENS,
      maximum: FULL_PROJECTION_MAX_TOKENS,
    },
    providerAttempts: MAX_PROVIDER_ATTEMPTS,
    summary: { inputCap: SUMMARY_INPUT_CAP, outputCap: SUMMARY_OUTPUT_CAP },
    primary: { inputCap: PRIMARY_INPUT_CAP, outputCap: PRIMARY_OUTPUT_CAP },
    maxWallClockMs: MAX_WALL_CLOCK_MS,
    routeAlias: ROUTE_ALIAS,
    model: MODEL,
    capabilityPolicy: 'no_tools_no_children_no_network_surface',
  });
  const material = {
    suiteId: 'github-actions-auto-compaction-diagnostic-v1',
    caseId: 'gha-auto-compaction-synthetic-v1',
    routeAlias: ROUTE_ALIAS,
    model: MODEL,
    fixtureDigest,
    corpusDigest,
    oracleDigest,
    evaluatorDigest,
    verifierDigest,
    runnerDigest,
    workflowSourceDigest,
    policyDigest,
  };
  return suiteSchema.parse({
    ...material,
    suiteDigest: digestMaterial('suite.v1', material),
  });
}

/** The bounded test-only product config has no Provider credential or tool surface. */
export function createGitHubActionsAutoCompactionDiagnosticConfigV1(): AgentConfig {
  return {
    apiKey: 'credential-unavailable-to-runtime',
    baseURL: 'https://diagnostic.invalid',
    modelName: MODEL,
    providerName: ROUTE_ALIAS,
    providerType: 'openai-compatible',
    sandbox: { enabled: false },
    features: {
      contextCompactionV2: true,
      contextCompactionAutoV1: true,
    },
    modelKwargs: {
      maxOutputTokens: PRIMARY_OUTPUT_CAP,
      supportsToolCalls: false,
      streaming: false,
    },
    modelCapabilities: {
      maxOutputTokens: PRIMARY_OUTPUT_CAP,
      streaming: false,
    },
    executionCapabilitySurface: {
      inProcessReadOnlyTools: null,
      network: false,
      process: false,
      write: false,
      workspaceWrite: false,
      shell: false,
      skillChild: false,
      localStdioMcp: false,
    },
    compaction: {
      autoMode: 'live',
      compactAfterEstimatedTokens: AUTO_COMPACTION_THRESHOLD,
      maxSummaryTokens: SUMMARY_OUTPUT_CAP,
      maxNarrativeTokens: 800,
      maxSummaryInputTokens: SUMMARY_INPUT_CAP,
    },
  };
}

/**
 * Explicitly opt-in public-safe case runner. It cannot acquire a credential,
 * cannot construct a route, and does not use any config/session/workspace
 * overlay; a caller must supply an already-bound direct model.
 */
export async function runGitHubActionsAutoCompactionDiagnosticV1(
  input: RunGitHubActionsAutoCompactionDiagnosticV1Input,
): Promise<GitHubActionsAutoCompactionDiagnosticReportV1> {
  let suite: GitHubActionsAutoCompactionSuiteV1;
  try {
    suite = buildGitHubActionsAutoCompactionSuiteV1();
  } catch {
    return buildReportV1({
      suite: fallbackSuiteV1(),
      candidate: null,
      execution: null,
      result: blockedResultV1(input.scenario, 'source_binding_invalid', 0, 0, 0, 0, false),
    });
  }

  let execution: GitHubActionsAutoCompactionWorkflowIdentityV1;
  try {
    execution = readWorkflowIdentityV1(input.environment ?? process.env);
  } catch {
    return buildReportV1({
      suite,
      candidate: null,
      execution: null,
      result: blockedResultV1(input.scenario, 'github_context_invalid', 0, 0, 0, 0, false),
    });
  }
  const candidate = buildCandidateV1(execution.commit, suite);
  if (input.signal?.aborted) {
    return buildReportV1({
      suite,
      candidate,
      execution,
      result: blockedResultV1(input.scenario, 'external_cancelled', 0, 0, 0, 0, false),
    });
  }
  const expectedCaseId =
    input.scenario === 'success' ? 'auto_compaction_success' : 'auto_compaction_cancel';
  if (
    !isGitHubActionsDiagnosticModelBindingV1(input.binding) ||
    input.binding.caseId !== expectedCaseId ||
    typeof input.binding.model.model === 'string'
  ) {
    return buildReportV1({
      suite,
      candidate,
      execution,
      result: blockedResultV1(input.scenario, 'model_binding_unavailable', 0, 0, 0, 0, false),
    });
  }

  const tracker: AutoCompactionTrackerV1 = {
    providerAttempts: 0,
    summaryDispatches: 0,
    primaryDispatches: 0,
    summaryTransportEntered: false,
    harnessAbortAfterTransportEntry: false,
    automaticCompactionRequests: 0,
    compactionCompleted: false,
    summaryAborted: false,
    primaryResponded: false,
    nextUserTurnRetryPreflight: false,
    unexpectedEffect: false,
    runtimeTerminalFailure: false,
    modelOutputPolicyViolation: false,
    usageUnavailable: false,
    tokenQuotaExceeded: false,
    fullProjectionInRange: false,
  };
  const startedAt = Date.now();
  const boundedRun = createDeadlineBoundRunV1(input.signal);
  let syntheticRoot: IsolatedSyntheticRootV1 | undefined;
  let reasonCode: BlockedReasonCodeV1 | undefined;
  try {
    syntheticRoot = materializeSyntheticRootV1();
    await withEphemeralProcessBoundaryV1(syntheticRoot, async () => {
      await runProductChainV1({
        binding: input.binding!,
        scenario: input.scenario,
        signal: boundedRun.signal,
        abortForHarness: boundedRun.abortForHarness,
        awaitOperation: boundedRun.awaitOperation,
        tracker,
      });
    });
  } catch {
    reasonCode = tracker.unexpectedEffect
      ? 'effect_sequence_violation'
      : tracker.modelOutputPolicyViolation
        ? 'model_output_policy_violation'
        : 'model_dispatch_failed';
  } finally {
    boundedRun.dispose();
    if (syntheticRoot && !cleanupSyntheticRootV1(syntheticRoot)) reasonCode = 'cleanup_failed';
  }

  const result = evaluateRunV1({
    scenario: input.scenario,
    binding: input.binding!,
    tracker,
    reasonCode,
    deadlineExceeded: boundedRun.deadlineExceeded(),
    externallyCancelled: boundedRun.externallyCancelled(),
    harnessAborted: boundedRun.harnessAborted(),
    durationMs: Date.now() - startedAt,
  });
  return buildReportV1({ suite, candidate, execution, result });
}

function readWorkflowIdentityV1(
  environment: NodeJS.ProcessEnv,
): GitHubActionsAutoCompactionWorkflowIdentityV1 {
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
  suite: GitHubActionsAutoCompactionSuiteV1,
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

function createDeadlineBoundRunV1(externalSignal: AbortSignal | undefined): DeadlineBoundRunV1 {
  const controller = new AbortController();
  let deadlineExceeded = false;
  let externallyCancelled = false;
  let harnessAborted = false;
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
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort('github_actions_auto_compaction_deadline_exceeded');
    resolveDeadline?.();
  }, MAX_WALL_CLOCK_MS);
  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    externallyCancelled: () => externallyCancelled,
    abortForHarness: () => {
      if (controller.signal.aborted) return;
      harnessAborted = true;
      controller.abort('github_actions_auto_compaction_harness_abort');
    },
    harnessAborted: () => harnessAborted,
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
      // A non-cooperative model operation may still settle later. Its signal
      // has already been aborted, it cannot start a follow-up dispatch, and
      // its late rejection is observed to avoid an unhandled promise.
      void operation.catch(() => {});
      throw new DiagnosticDeadlineExceededError();
    },
    dispose: () => {
      clearTimeout(deadline);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

async function runProductChainV1(input: {
  readonly binding: GitHubActionsDiagnosticModelBindingV1;
  readonly scenario: GitHubActionsAutoCompactionScenarioV1;
  readonly signal: AbortSignal;
  readonly abortForHarness: () => void;
  readonly awaitOperation: <Value>(operation: Promise<Value>) => Promise<Value>;
  readonly tracker: AutoCompactionTrackerV1;
}): Promise<void> {
  const state = createSyntheticStateV1();
  const fullProjectionTokens = buildContextProjection({ role: 'agent', state }).estimate
    .totalInputTokens;
  input.tracker.fullProjectionInRange =
    fullProjectionTokens >= FULL_PROJECTION_MIN_TOKENS &&
    fullProjectionTokens <= FULL_PROJECTION_MAX_TOKENS;
  if (!input.tracker.fullProjectionInRange) throw new Error('synthetic_projection_drift');

  const kernel = new AgentKernel({
    store: createRuntimeStore(':memory:'),
    initialState: state,
    interactionMode: 'accept_edits',
  });
  const model = createObservedModelV1({
    binding: input.binding,
    scenario: input.scenario,
    abortForHarness: input.abortForHarness,
    awaitOperation: input.awaitOperation,
    tracker: input.tracker,
  });
  const executor = createRuntimeEffectExecutor({
    config: createGitHubActionsAutoCompactionDiagnosticConfigV1(),
    model,
    signal: input.signal,
  });
  try {
    if (input.scenario === 'success') {
      const events = await consumeRuntimeLoopV1({
        kernel,
        executor,
        expectedEffects: ['call_model', 'compact_context', 'call_model'],
        terminalEffect: 'emit_final',
        signal: input.signal,
        tracker: input.tracker,
      });
      observeEventsV1(events, input.tracker, kernel.getState().turn.turnId);
      return;
    }

    const events = await consumeRuntimeLoopV1({
      kernel,
      executor,
      expectedEffects: ['call_model', 'compact_context'],
      terminalEffect: 'stop',
      signal: input.signal,
      tracker: input.tracker,
    });
    observeEventsV1(events, input.tracker, kernel.getState().turn.turnId);
    if (
      !input.tracker.summaryAborted ||
      input.tracker.primaryDispatches !== 0 ||
      decideNextEffect(kernel.getState()).type !== 'stop'
    ) {
      return;
    }
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'gha-auto-compaction-next-user-v1',
      content: SAFE_CURRENT_TURN,
    });
    kernel.processEvent({ type: 'turn.started', turnId: 'gha-auto-compaction-next-turn-v1' });
    if (decideNextEffect(kernel.getState()).type !== 'call_model') return;
    input.tracker.nextUserTurnRetryPreflight = true;
    const nextEvents = await consumeRuntimeLoopV1({
      kernel,
      executor,
      expectedEffects: ['call_model'],
      terminalEffect: 'compact_context',
      // The harness cancellation only terminates the old turn. This new user
      // turn verifies scheduling preflight with no model dispatch at all.
      signal: undefined,
      tracker: input.tracker,
    });
    observeEventsV1(nextEvents, input.tracker, kernel.getState().turn.turnId);
  } finally {
    kernel.close();
  }
}

function createSyntheticStateV1(): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: 'github-actions-auto-compaction-diagnostic-thread-v1',
    userId: 'github-actions-diagnostic',
    // This is intentionally not an OS path. The process boundary is isolated
    // separately, and no workspace/project/session overlay is consulted.
    workspace: 'github-actions-auto-compaction-synthetic-root-v1',
    interactionMode: 'accept_edits',
  });
  state.turn = {
    turnId: 'github-actions-auto-compaction-current-turn-v1',
    turnIndex: 2,
    status: 'active',
  };
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'github-actions-auto-compaction-history-v1',
      turnId: 'github-actions-auto-compaction-history-turn-v1',
      ordinal: 0,
      createdAt: '2026-08-06T00:00:00.000Z',
      content: SAFE_HISTORY_CHUNK.repeat(HISTORY_REPEATS),
    },
    {
      kind: 'user',
      messageId: 'github-actions-auto-compaction-current-v1',
      turnId: 'github-actions-auto-compaction-current-turn-v1',
      ordinal: 1,
      createdAt: '2026-08-06T00:00:01.000Z',
      content: SAFE_CURRENT_TURN,
    },
  ];
  return state;
}

function createObservedModelV1(input: {
  readonly binding: GitHubActionsDiagnosticModelBindingV1;
  readonly scenario: GitHubActionsAutoCompactionScenarioV1;
  readonly abortForHarness: () => void;
  readonly awaitOperation: <Value>(operation: Promise<Value>) => Promise<Value>;
  readonly tracker: AutoCompactionTrackerV1;
}): SupportedChatModel {
  if (typeof input.binding.model.model === 'string') throw new Error('model_binding_unavailable');
  const baseModel = input.binding.model.model as unknown as LanguageModelV4;
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'github-actions-auto-compaction-diagnostic-wrapper',
    modelId: 'github-actions-auto-compaction-diagnostic-wrapper',
    supportedUrls: {},
    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      // Never begin a new Provider operation after the hard deadline, an
      // external cancellation, or the cancellation harness has fired.
      if (options.abortSignal?.aborted) {
        throw new DOMException('diagnostic operation aborted before dispatch', 'AbortError');
      }
      if (input.tracker.providerAttempts >= MAX_PROVIDER_ATTEMPTS) {
        throw new Error('provider_attempt_quota_exceeded');
      }
      const phase = input.tracker.providerAttempts === 0 ? 'summary' : 'primary';
      const measurement = measurePromptV1(options);
      const caps =
        phase === 'summary'
          ? { input: SUMMARY_INPUT_CAP, output: SUMMARY_OUTPUT_CAP }
          : { input: PRIMARY_INPUT_CAP, output: PRIMARY_OUTPUT_CAP };
      if (measurement.inputTokens > caps.input || measurement.maxOutputTokens !== caps.output) {
        input.tracker.tokenQuotaExceeded = true;
        throw new Error('phase_request_quota_exceeded');
      }
      input.tracker.providerAttempts += 1;
      if (phase === 'summary') input.tracker.summaryDispatches += 1;
      else input.tracker.primaryDispatches += 1;

      // Calling the already-bound model is the narrow Provider transport
      // boundary. The cancellation microtask is armed only after that call
      // has returned a pending operation to this harness.
      const transportEntriesBeforeDispatch = input.binding.transportEntries();
      const operation = Promise.resolve(baseModel.doGenerate(options));
      if (phase === 'summary') {
        if (input.scenario === 'cancel') {
          const transport = await input.awaitOperation(
            Promise.race([
              input.binding
                .waitForNextTransportEntry(transportEntriesBeforeDispatch, options.abortSignal)
                .then(() => 'entered' as const),
              operation.then(() => 'operation_settled' as const),
            ]),
          );
          if (transport !== 'entered') throw new Error('transport_entry_not_observed');
          input.tracker.summaryTransportEntered = true;
          input.abortForHarness();
          input.tracker.harnessAbortAfterTransportEntry = true;
        }
      }
      const result = await input.awaitOperation(operation);
      inspectModelResultV1(result, phase, input.tracker);
      return result;
    },
    async doStream(): Promise<never> {
      throw new Error('streaming_not_admitted');
    },
  };
  return {
    ...input.binding.model,
    model: model as unknown as SupportedChatModel['model'],
    supportsToolCalls: false,
    capabilityMetadata: {
      ...input.binding.model.capabilityMetadata,
      maxOutputTokens: PRIMARY_OUTPUT_CAP,
      streaming: false,
    },
    setRetryListener: () => {},
  };
}

function measurePromptV1(
  options: Pick<LanguageModelV4CallOptions, 'prompt' | 'maxOutputTokens' | 'tools'>,
): { inputTokens: number; maxOutputTokens: number | undefined } {
  if (options.tools !== undefined && options.tools.length !== 0) {
    throw new Error('tools_not_admitted');
  }
  if (!Array.isArray(options.prompt)) throw new Error('prompt_not_admitted');
  const text = options.prompt
    .map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('prompt_not_admitted');
      }
      const record = message as Record<string, unknown>;
      if (record.role === 'system') {
        if (typeof record.content !== 'string') throw new Error('prompt_not_admitted');
        return `system\n${record.content}`;
      }
      if (
        (record.role !== 'user' && record.role !== 'assistant') ||
        !Array.isArray(record.content)
      ) {
        throw new Error('prompt_not_admitted');
      }
      const content = record.content
        .map((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) {
            throw new Error('prompt_not_admitted');
          }
          const value = part as Record<string, unknown>;
          if (value.type !== 'text' || typeof value.text !== 'string') {
            throw new Error('prompt_not_admitted');
          }
          return value.text;
        })
        .join('');
      return `${record.role}\n${content}`;
    })
    .join('\n');
  return { inputTokens: countTokens(text), maxOutputTokens: options.maxOutputTokens };
}

function inspectModelResultV1(
  result: LanguageModelV4GenerateResult,
  phase: 'summary' | 'primary',
  tracker: AutoCompactionTrackerV1,
): void {
  const text = result.content
    .map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') {
        tracker.modelOutputPolicyViolation = true;
        return '';
      }
      return part.text;
    })
    .join('');
  if (!text.trim() || result.finishReason.unified === 'length') {
    tracker.modelOutputPolicyViolation = true;
  }
  const usage = readUsageV1(result);
  if (!usage) {
    tracker.usageUnavailable = true;
    return;
  }
  const caps =
    phase === 'summary'
      ? { input: SUMMARY_INPUT_CAP, output: SUMMARY_OUTPUT_CAP }
      : { input: PRIMARY_INPUT_CAP, output: PRIMARY_OUTPUT_CAP };
  if (usage.inputTokens > caps.input || usage.outputTokens > caps.output) {
    tracker.tokenQuotaExceeded = true;
  }
  if (phase === 'summary') tracker.summaryUsage = usage;
  else tracker.primaryUsage = usage;
}

function readUsageV1(result: LanguageModelV4GenerateResult): PhaseUsageV1 | undefined {
  const inputTokens = result.usage?.inputTokens?.total;
  const outputTokens = result.usage?.outputTokens?.total;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

async function consumeRuntimeLoopV1(input: {
  readonly kernel: AgentKernel;
  readonly executor: RuntimeEffectExecutor;
  readonly expectedEffects: readonly Exclude<RuntimeEffect['type'], 'stop'>[];
  readonly terminalEffect: RuntimeEffect['type'];
  readonly signal: AbortSignal | undefined;
  readonly tracker: AutoCompactionTrackerV1;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  let index = 0;
  for await (const event of runRuntimeLoop(
    input.kernel,
    input.executor,
    noInteractionProvider,
    input.expectedEffects.length + 1,
    (effect) => {
      if (effect.type === 'stop') return effect;
      const expected = input.expectedEffects[index];
      if (expected !== undefined && effect.type === expected) {
        index += 1;
        return effect;
      }
      if (expected === undefined && effect.type === input.terminalEffect) return { type: 'stop' };
      input.tracker.unexpectedEffect = true;
      throw new UnexpectedDiagnosticEffectError();
    },
    input.signal,
  )) {
    events.push(event);
  }
  if (index !== input.expectedEffects.length) input.tracker.unexpectedEffect = true;
  return events;
}

function observeEventsV1(
  events: readonly RuntimeEvent[],
  tracker: AutoCompactionTrackerV1,
  currentTurnId: string,
): void {
  for (const event of events) {
    if (event.type === 'context.compaction_requested') {
      if (event.reason !== 'auto' || event.requestedAtTurnId !== currentTurnId)
        tracker.unexpectedEffect = true;
      else tracker.automaticCompactionRequests += 1;
    }
    if (event.type === 'context.compaction_completed') tracker.compactionCompleted = true;
    if (event.type === 'context.compaction_failed') {
      if (event.errorKind === 'summary_aborted') tracker.summaryAborted = true;
      else tracker.runtimeTerminalFailure = true;
    }
    if (event.type === 'model.responded') tracker.primaryResponded = true;
    if (
      event.type === 'model.retry' ||
      event.type === 'tool.queued' ||
      event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected' ||
      event.type === 'tool.cancelled' ||
      event.type === 'run.error'
    ) {
      tracker.runtimeTerminalFailure = true;
    }
  }
}

function evaluateRunV1(input: {
  readonly scenario: GitHubActionsAutoCompactionScenarioV1;
  readonly binding: GitHubActionsDiagnosticModelBindingV1;
  readonly tracker: AutoCompactionTrackerV1;
  readonly reasonCode: BlockedReasonCodeV1 | undefined;
  readonly deadlineExceeded: boolean;
  readonly externallyCancelled: boolean;
  readonly harnessAborted: boolean;
  readonly durationMs: number;
}): z.infer<typeof resultSchema> {
  const { tracker } = input;
  const transportDisposition = transportDispositionV1(input.binding);
  if (input.durationMs > MAX_WALL_CLOCK_MS || input.deadlineExceeded) {
    return blockedResultV1(
      input.scenario,
      'time_limit_exceeded',
      tracker.providerAttempts,
      tracker.summaryDispatches,
      tracker.primaryDispatches,
      tracker.automaticCompactionRequests,
      tracker.nextUserTurnRetryPreflight,
      input.durationMs,
      transportDisposition,
    );
  }
  if (input.reasonCode) {
    return blockedResultV1(
      input.scenario,
      input.reasonCode,
      tracker.providerAttempts,
      tracker.summaryDispatches,
      tracker.primaryDispatches,
      tracker.automaticCompactionRequests,
      tracker.nextUserTurnRetryPreflight,
      input.durationMs,
      transportDisposition,
    );
  }
  if (input.externallyCancelled) {
    return blockedResultV1(
      input.scenario,
      'external_cancelled',
      tracker.providerAttempts,
      tracker.summaryDispatches,
      tracker.primaryDispatches,
      tracker.automaticCompactionRequests,
      tracker.nextUserTurnRetryPreflight,
      input.durationMs,
      transportDisposition,
    );
  }
  if (tracker.tokenQuotaExceeded) {
    return blockedResultV1(
      input.scenario,
      'token_quota_exceeded',
      tracker.providerAttempts,
      tracker.summaryDispatches,
      tracker.primaryDispatches,
      tracker.automaticCompactionRequests,
      tracker.nextUserTurnRetryPreflight,
      input.durationMs,
      transportDisposition,
    );
  }
  if (tracker.usageUnavailable) {
    return blockedResultV1(
      input.scenario,
      'usage_unavailable',
      tracker.providerAttempts,
      tracker.summaryDispatches,
      tracker.primaryDispatches,
      tracker.automaticCompactionRequests,
      tracker.nextUserTurnRetryPreflight,
      input.durationMs,
      transportDisposition,
    );
  }
  if (
    input.binding.transportProofKind !== 'provider_fetch' ||
    (input.scenario === 'success'
      ? input.binding.transportEntries() !== 2
      : input.binding.transportEntries() !== 1)
  ) {
    return blockedResultV1(
      input.scenario,
      'transport_proof_unavailable',
      tracker.providerAttempts,
      tracker.summaryDispatches,
      tracker.primaryDispatches,
      tracker.automaticCompactionRequests,
      tracker.nextUserTurnRetryPreflight,
      input.durationMs,
      transportDisposition,
    );
  }
  if (tracker.modelOutputPolicyViolation) {
    return failedResultV1(
      input.scenario,
      'model_output_policy_violation',
      tracker,
      input.durationMs,
      transportDisposition,
    );
  }
  if (tracker.unexpectedEffect) {
    return failedResultV1(
      input.scenario,
      'effect_sequence_violation',
      tracker,
      input.durationMs,
      transportDisposition,
    );
  }
  if (tracker.runtimeTerminalFailure || !tracker.fullProjectionInRange) {
    return failedResultV1(
      input.scenario,
      'runtime_terminal_failure',
      tracker,
      input.durationMs,
      transportDisposition,
    );
  }
  if (input.scenario === 'success') {
    if (
      tracker.providerAttempts === 2 &&
      tracker.summaryDispatches === 1 &&
      tracker.primaryDispatches === 1 &&
      tracker.automaticCompactionRequests === 1 &&
      tracker.compactionCompleted &&
      tracker.primaryResponded &&
      !tracker.summaryAborted &&
      tracker.summaryUsage &&
      tracker.primaryUsage
    ) {
      return resultSchema.parse({
        scenario: 'success',
        status: 'passed',
        reasonCode: 'passed_success',
        outcome: 'success',
        providerAttempts: 2,
        summaryDispatches: 1,
        primaryDispatches: 1,
        automaticCompactionRequests: 1,
        nextUserTurnRetryPreflight: false,
        usageDisposition: 'observed',
        transportDisposition: 'provider_fetch_entered',
        durationBucket: durationBucketV1(input.durationMs),
        costBucket: 'not_observed',
      });
    }
    return failedResultV1(
      input.scenario,
      'automatic_compaction_not_observed',
      tracker,
      input.durationMs,
      transportDisposition,
    );
  }
  if (
    tracker.providerAttempts === 1 &&
    tracker.summaryDispatches === 1 &&
    tracker.primaryDispatches === 0 &&
    tracker.automaticCompactionRequests === 2 &&
    tracker.summaryTransportEntered &&
    tracker.harnessAbortAfterTransportEntry &&
    input.harnessAborted &&
    tracker.summaryAborted &&
    !tracker.compactionCompleted &&
    tracker.nextUserTurnRetryPreflight
  ) {
    return resultSchema.parse({
      scenario: 'cancel',
      status: 'passed',
      reasonCode: 'passed_client_abort_after_transport_entry',
      outcome: 'client_abort_after_transport_entry',
      providerAttempts: 1,
      summaryDispatches: 1,
      primaryDispatches: 0,
      automaticCompactionRequests: 2,
      nextUserTurnRetryPreflight: true,
      // A provider can abort before emitting usage. This narrow, harness-
      // proven path is charged at its reserved phase cap and never claimed as
      // observed Provider usage.
      usageDisposition: 'conservative_abort_charge',
      transportDisposition: 'provider_fetch_entered',
      durationBucket: durationBucketV1(input.durationMs),
      costBucket: 'not_observed',
    });
  }
  return failedResultV1(
    input.scenario,
    tracker.summaryTransportEntered && input.harnessAborted
      ? 'harness_abort_not_observed'
      : 'automatic_compaction_not_observed',
    tracker,
    input.durationMs,
    transportDisposition,
  );
}

function failedResultV1(
  scenario: GitHubActionsAutoCompactionScenarioV1,
  reasonCode:
    | 'automatic_compaction_not_observed'
    | 'effect_sequence_violation'
    | 'harness_abort_not_observed'
    | 'model_output_policy_violation'
    | 'runtime_terminal_failure',
  tracker: AutoCompactionTrackerV1,
  durationMs: number,
  transportDisposition: z.infer<typeof resultSchema>['transportDisposition'],
): z.infer<typeof resultSchema> {
  return resultSchema.parse({
    scenario,
    status: 'failed',
    reasonCode,
    outcome: 'not_observed',
    providerAttempts: clampAttemptsV1(tracker.providerAttempts),
    summaryDispatches: clampOneV1(tracker.summaryDispatches),
    primaryDispatches: clampOneV1(tracker.primaryDispatches),
    automaticCompactionRequests: clampTwoV1(tracker.automaticCompactionRequests),
    nextUserTurnRetryPreflight: tracker.nextUserTurnRetryPreflight,
    usageDisposition: 'not_observed',
    transportDisposition,
    durationBucket: durationBucketV1(durationMs),
    costBucket: 'not_observed',
  });
}

function blockedResultV1(
  scenario: GitHubActionsAutoCompactionScenarioV1,
  reasonCode: BlockedReasonCodeV1,
  providerAttempts: number,
  summaryDispatches: number,
  primaryDispatches: number,
  automaticCompactionRequests: number,
  nextUserTurnRetryPreflight: boolean,
  durationMs = 0,
  transportDisposition: z.infer<typeof resultSchema>['transportDisposition'] = 'not_observed',
): z.infer<typeof resultSchema> {
  return resultSchema.parse({
    scenario,
    status: 'blocked',
    reasonCode,
    outcome: 'not_observed',
    providerAttempts: clampAttemptsV1(providerAttempts),
    summaryDispatches: clampOneV1(summaryDispatches),
    primaryDispatches: clampOneV1(primaryDispatches),
    automaticCompactionRequests: clampTwoV1(automaticCompactionRequests),
    nextUserTurnRetryPreflight,
    usageDisposition: 'not_observed',
    transportDisposition,
    durationBucket: durationBucketV1(durationMs),
    costBucket: 'not_observed',
  });
}

function clampAttemptsV1(value: number): number {
  return Math.max(0, Math.min(MAX_PROVIDER_ATTEMPTS, Math.floor(value)));
}

function clampOneV1(value: number): number {
  return Math.max(0, Math.min(1, Math.floor(value)));
}

function clampTwoV1(value: number): number {
  return Math.max(0, Math.min(2, Math.floor(value)));
}

function transportDispositionV1(
  binding: GitHubActionsDiagnosticModelBindingV1,
): z.infer<typeof resultSchema>['transportDisposition'] {
  if (binding.transportProofKind === 'contract_only') return 'contract_only';
  return binding.transportEntries() > 0 ? 'provider_fetch_entered' : 'not_observed';
}

function durationBucketV1(durationMs: number): 'under_15s' | '15s_to_60s' | 'over_60s' {
  if (durationMs < 15_000) return 'under_15s';
  if (durationMs <= MAX_WALL_CLOCK_MS) return '15s_to_60s';
  return 'over_60s';
}

function buildReportV1(input: {
  readonly suite: GitHubActionsAutoCompactionSuiteV1;
  readonly candidate: z.infer<typeof candidateSchema> | null;
  readonly execution: GitHubActionsAutoCompactionWorkflowIdentityV1 | null;
  readonly result: z.infer<typeof resultSchema>;
}): GitHubActionsAutoCompactionDiagnosticReportV1 {
  const material = reportMaterialSchema.parse({
    schema: GITHUB_ACTIONS_AUTO_COMPACTION_DIAGNOSTIC_REPORT_SCHEMA_V1,
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    candidate: input.candidate,
    execution: input.execution,
    suite: input.suite,
    result: input.result,
  });
  return githubActionsAutoCompactionDiagnosticReportV1Schema.parse({
    ...material,
    reportDigest: computeGitHubActionsAutoCompactionDiagnosticReportDigestV1(material),
  });
}

function fallbackSuiteV1(): GitHubActionsAutoCompactionSuiteV1 {
  const digest = digestMaterial('fallback-suite.v1', { status: 'source_binding_invalid' });
  return suiteSchema.parse({
    suiteId: 'github-actions-auto-compaction-diagnostic-v1',
    caseId: 'gha-auto-compaction-synthetic-v1',
    routeAlias: ROUTE_ALIAS,
    model: MODEL,
    fixtureDigest: digest,
    corpusDigest: digest,
    oracleDigest: digest,
    evaluatorDigest: digest,
    verifierDigest: digest,
    runnerDigest: digest,
    workflowSourceDigest: digest,
    policyDigest: digest,
    suiteDigest: digest,
  });
}

function materializeSyntheticRootV1(): IsolatedSyntheticRootV1 {
  const root = mkdtempSync(join(tmpdir(), 'kite-gh-auto-compaction-'));
  const fixture = join(root, 'fixture');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const state = join(root, 'state');
  const cwd = join(root, 'cwd');
  try {
    for (const directory of [fixture, home, config, data, state, cwd]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    // There is no filesystem corpus to read. The empty source-owned fixture
    // root is deliberately immutable and all synthetic context stays memory-only.
    chmodSync(fixture, 0o500);
    return { root, fixture, home, config, data, state, cwd };
  } catch {
    rmSync(root, { recursive: true, force: true });
    throw new Error('synthetic_root_invalid');
  }
}

let processBoundaryTail: Promise<void> = Promise.resolve();

async function withEphemeralProcessBoundaryV1<Result>(
  root: IsolatedSyntheticRootV1,
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
    process.chdir(root.cwd);
    process.env.HOME = root.home;
    process.env.KITE_CODE_HOME = join(root.home, '.kite-code');
    process.env.PWD = root.cwd;
    process.env.USERPROFILE = root.home;
    process.env.XDG_CONFIG_HOME = root.config;
    process.env.XDG_DATA_HOME = root.data;
    process.env.XDG_STATE_HOME = root.state;
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

function cleanupSyntheticRootV1(root: IsolatedSyntheticRootV1): boolean {
  try {
    if (!basename(root.root).startsWith('kite-gh-auto-compaction-')) return false;
    for (const directory of [
      root.fixture,
      root.home,
      root.config,
      root.data,
      root.state,
      root.cwd,
      root.root,
    ]) {
      if (existsSync(directory)) chmodSync(directory, 0o700);
    }
    rmSync(root.root, { recursive: true, force: true });
    return !existsSync(root.root);
  } catch {
    return false;
  }
}

function digestMaterial(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(
    `kite.github-actions-auto-compaction-diagnostic.${domain}`,
    canonicalJsonBytes(value),
  );
}

function digestText(domain: string, value: string): `sha256:${string}` {
  return digestMaterial(domain, { value });
}
