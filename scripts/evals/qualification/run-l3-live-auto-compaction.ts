import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { z } from 'zod';
import type { AgentConfig } from '../../../src/core/config';
import {
  ContextCompactionValidationError,
  createModelContextSummaryGenerator,
  createNarrativeContextCompactor,
  normalizeCompactionSummary,
} from '../../../src/core/model/compaction-summary';
import { buildContextProjection } from '../../../src/core/model/context-projection';
import type { SupportedChatModel } from '../../../src/core/model/factory';
import { invokeBoundModel } from '../../../src/core/model/invoke';
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
  buildDiagnosticModelCapabilityResolutionV1,
  buildLiveAutoCompactionSemanticReceiptV1,
  LIVE_AUTO_COMPACTION_CANCELLED_TRACE_V1,
  LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1,
  LIVE_AUTO_COMPACTION_SUCCESS_TRACE_V1,
  type LiveAutoCompactionDurationBucketV1,
  type LiveAutoCompactionPhaseStateV1,
  liveAutoCompactionDurationBucketForRunWallClockSecondsV1,
} from '../contracts/qualification/evidence/live-auto-compaction-schema-v1';
import {
  L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1,
  l3LiveAutoCompactionSourceRegistryIsClosedV1,
} from '../contracts/qualification/evidence/live-auto-compaction-source-registry-v1';
import {
  buildLiveAutoCompactionNotObservedReportV1,
  buildLiveAutoCompactionObservationVerifierContextV1,
  type LiveAutoCompactionObservationDiagnosticReportV1,
  verifyLiveAutoCompactionObservationV1,
} from '../contracts/qualification/evidence/live-auto-compaction-verifier-v1';
import {
  buildDiagnosticExecutionV1,
  buildLiveCompatibilityObservationV1,
  type DiagnosticRouteIdentityV1,
} from '../contracts/qualification/evidence/live-observation-schema-v1';
import {
  assertL3LiveAutoCompactionCorpusContentV1,
  assertL3LiveAutoCompactionFixtureContentV1,
  assertL3LiveAutoCompactionRunnerSourceDriftV1,
  L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1,
  L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1,
  L3_LIVE_AUTO_COMPACTION_POLICY_V1,
  L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
  L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1,
  l3LiveAutoCompactionPolicyIsClosedV1,
  materializeL3LiveAutoCompactionCorpusBytesV1,
  materializeL3LiveAutoCompactionFixtureBytesV1,
} from '../contracts/qualification/live-auto-compaction-policy-v1';
import {
  type L3LiveAutoCompactionRouteReadyV1,
  resolveL3LiveAutoCompactionRouteForModelBoundaryV1,
} from '../contracts/qualification/live-auto-compaction-route-binding-v1';
import {
  type LiveGovernanceQuotaCountersV1,
  reconcileLiveGovernanceQuotaV1,
  reserveLiveGovernanceQuotaV1,
} from './live-governance-ledger-v1';
import {
  type LiveIsolatedTransportPromptMessageV1,
  type LiveIsolatedTransportTestModeV1,
  liveIsolatedTransportPromptDigestV1,
} from './live-isolated-transport-protocol-v1';
import {
  type LiveIsolatedTransportFixtureV1,
  liveIsolatedTransportDeadlineV1,
} from './live-isolated-transport-v1';
import { runLiveIsolatedTransportV1 } from './live-model-transport-v1';
import {
  hasFreshLiveScratchSupervisorHealthV1,
  liveScratchSupervisorActivationIsImplementedV1,
} from './live-scratch-supervisor-health-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOCAL_PLATFORM_IDENTITY_V1 = 'local-host';
const SAFE_HISTORY_CHUNK_V1 =
  'stable synthetic historical qualification material with no secrets and no instructions. ';
const SAFE_CURRENT_TURN_V1 = 'go';
// This fixed replacement is intentionally below the 600-token phase cap.
// The source-owned projection declaration binds 597 tokens, leaving the
// exact 3-token tail margin required by the current product serializer.
const SAFE_SUMMARY_V1 = `${'safe summary '.repeat(298)}safe`;
const SAFE_PRIMARY_RESPONSE_V1 = 'safe primary diagnostic response';
const FULL_PROJECTION_MIN_TOKENS_V1 =
  L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.fullProjectionMinimumTokens;
const FULL_PROJECTION_MAX_TOKENS_V1 =
  L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.fullProjectionMaximumTokens;
const RUNNER_SOURCE_PATH_V1 = 'scripts/evals/qualification/run-l3-live-auto-compaction.ts';
const L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_URL_V1 = new URL(
  './run-l3-live-auto-compaction.ts',
  import.meta.url,
);

/**
 * This run report intentionally has no field that can retain a prompt,
 * response, reasoning, endpoint, credential, filesystem path, or workspace
 * content.  It is a diagnostic status projection, never release evidence.
 */
export const L3_LIVE_AUTO_COMPACTION_RUN_REASON_CODES_V1 = [
  ...L3_LIVE_AUTO_COMPACTION_POLICY_V1.blockedReasonCodes,
  'observed_cancelled',
  'observed_success',
] as const;

export type L3LiveAutoCompactionRunReasonCodeV1 =
  (typeof L3_LIVE_AUTO_COMPACTION_RUN_REASON_CODES_V1)[number];

/**
 * The product chain needs only a diagnostic route identity. A live lease is
 * optional here so the separate synthetic contract driver can never create or
 * receive a credential-bearing model boundary.
 */
type L3AutoCompactionExecutionResolutionV1 = Pick<L3LiveAutoCompactionRouteReadyV1, 'route'> &
  Partial<Pick<L3LiveAutoCompactionRouteReadyV1, 'modelBoundary'>>;

const liveAutoCompactionRunReportV1Schema = z
  .object({
    schema: z.literal('L3LiveAutoCompactionRunReportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    status: z.enum(['observed', 'blocked']),
    reasonCode: z.enum(L3_LIVE_AUTO_COMPACTION_RUN_REASON_CODES_V1),
    outcome: z.enum(['success', 'cancelled']).optional(),
    routeAlias: z
      .string()
      .regex(/^[a-z][a-z0-9._-]{0,63}$/)
      .optional(),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .optional(),
    policyDigest: z.string().regex(DIGEST).optional(),
    verifierReportDigest: z.string().regex(DIGEST),
    observationRecordDigest: z.string().regex(DIGEST).optional(),
    semanticReceiptRecordDigest: z.string().regex(DIGEST).optional(),
    /** Closed metadata bucket only; raw wall-clock counters remain ledger-only. */
    durationBucket: z.enum(LIVE_AUTO_COMPACTION_DURATION_BUCKETS_V1).optional(),
    summaryPhaseState: z.enum([
      'not_started',
      'known_zero',
      'dispatched_known',
      'dispatched_unknown',
    ]),
    primaryPhaseState: z.enum([
      'not_started',
      'known_zero',
      'dispatched_known',
      'dispatched_unknown',
    ]),
    providerDispatchCount: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal('unknown'),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const observed = value.status === 'observed';
    if (observed !== (value.outcome !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'only observed reports may have a terminal outcome',
      });
    }
    if (
      (value.outcome === 'success' && value.reasonCode !== 'observed_success') ||
      (value.outcome === 'cancelled' && value.reasonCode !== 'observed_cancelled')
    ) {
      context.addIssue({ code: 'custom', message: 'outcome must be projected by the verifier' });
    }
    if (
      observed &&
      (value.observationRecordDigest === undefined ||
        value.semanticReceiptRecordDigest === undefined ||
        value.durationBucket === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'observed result needs both independent record digests',
      });
    }
  });

export type L3LiveAutoCompactionRunReportV1 = z.infer<typeof liveAutoCompactionRunReportV1Schema>;

export interface RunL3LiveAutoCompactionInputV1 {
  /** Real transport remains impossible without this explicit caller opt-in. */
  readonly explicitOptIn: boolean;
  /** Only the route resolver can inspect these two reviewed environment values. */
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  /** Owner-provided local ledger root; no HOME/config fallback exists. */
  readonly ledgerRoot: string | undefined;
  /** A user cancellation is observable only after the summary boundary enters. */
  readonly signal?: AbortSignal;
}

interface RunL3LiveAutoCompactionDependenciesV1 {
  /** Test-only resolver clock. Ledger time always remains ledger-owned. */
  readonly now?: () => Date;
  /** Test-only fixed-byte drift fault; it never accepts a caller source path. */
  readonly forceRunnerSourceDriftForTest?: true;
}

/** Fixed-path accidental-drift check; this is not an anti-tamper root of trust. */
function liveAutoCompactionRunnerSourceIsBoundV1(forceDriftForTest: boolean): boolean {
  try {
    const source = new Uint8Array(
      readFileSync(fileURLToPath(L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_URL_V1)),
    );
    const sourceBytes = forceDriftForTest
      ? (() => {
          const mutated = new Uint8Array(source.byteLength + 1);
          mutated.set(source);
          mutated[mutated.byteLength - 1] = 0;
          return mutated;
        })()
      : source;
    assertL3LiveAutoCompactionRunnerSourceDriftV1({
      runnerId: L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
      sourceBytes,
    });
    return true;
  } catch {
    return false;
  }
}

function persistentSupervisorAvailableV1(ledgerRoot: string | undefined, nowMs: number): boolean {
  // The literal false activation gate is checked first, so no caller-owned
  // ledger path is read until a separately authorized service exists.
  if (!liveScratchSupervisorActivationIsImplementedV1()) return false;
  return hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs });
}

type DispatchPhaseV1 = 'summary' | 'primary';

interface PromptMeasurementV1 {
  readonly fingerprint: `sha256:${string}`;
  readonly inputTokens: number;
  readonly maxOutputTokens: number | undefined;
}

interface PreparedPromptV1 extends PromptMeasurementV1 {
  readonly phase: DispatchPhaseV1;
}

interface LiveRunTrackerV1 {
  summaryPhaseState: LiveAutoCompactionPhaseStateV1;
  primaryPhaseState: LiveAutoCompactionPhaseStateV1;
  summaryDispatchCount: number;
  primaryDispatchCount: number;
  summaryOutputTokens?: number;
  primaryOutputTokens?: number;
  fullProjectionInRange: boolean;
  requestObserved: boolean;
  autoRequestObserved: boolean;
  checkpointObserved: boolean;
  primaryCompleted: boolean;
  summaryCancelled: boolean;
  currentTurnStopped: boolean;
  nextTurnPreflight: boolean;
  unexpectedEffect: boolean;
  untrustedTerminal: boolean;
  timedOut: boolean;
  /** Sticky: no ledger reconciliation or new live child until reaping proves safe. */
  childExitUnconfirmed: boolean;
  requestTurnId?: string;
  nextTurnId?: string;
}

interface SealedRunResultV1 {
  readonly kind: 'success' | 'cancelled' | 'blocked';
  readonly reasonCode?: Extract<
    L3LiveAutoCompactionRunReasonCodeV1,
    'not_observed' | 'phase_budget_drift' | 'timeout' | 'tool_output_denied'
  >;
}

class PreDispatchDriftErrorV1 extends Error {
  constructor() {
    super('l3_live_auto_compaction_pre_dispatch_drift');
    this.name = 'PreDispatchDriftErrorV1';
  }
}

class DispatchPostconditionErrorV1 extends Error {
  constructor() {
    super('l3_live_auto_compaction_dispatch_postcondition_drift');
    this.name = 'DispatchPostconditionErrorV1';
  }
}

/** A provider result must never turn an AQ-9B model phase into a tool effect. */
class ModelToolCallDeniedErrorV1 extends DispatchPostconditionErrorV1 {
  constructor() {
    super();
    this.name = 'ModelToolCallDeniedErrorV1';
  }
}

class UnexpectedL3AutoCompactionEffectErrorV1 extends Error {
  constructor() {
    super('l3_live_auto_compaction_unexpected_effect');
    this.name = 'UnexpectedL3AutoCompactionEffectErrorV1';
  }
}

function fixedDigest(domain: string, material: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(material));
}

function isoNow(clock: (() => Date) | undefined): string | undefined {
  try {
    const value = clock?.() ?? new Date();
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function routeProjection(
  route: DiagnosticRouteIdentityV1 | undefined,
  policyDigest: string | undefined,
): Pick<L3LiveAutoCompactionRunReportV1, 'routeAlias' | 'model' | 'policyDigest'> {
  return {
    ...(route ? { routeAlias: route.routeAlias, model: route.model } : {}),
    ...(policyDigest ? { policyDigest } : {}),
  };
}

function providerDispatchCount(tracker: LiveRunTrackerV1): 0 | 1 | 2 | 'unknown' {
  if (tracker.untrustedTerminal) return 'unknown';
  const count = tracker.summaryDispatchCount + tracker.primaryDispatchCount;
  return count === 0 || count === 1 || count === 2 ? count : 'unknown';
}

function freshTracker(): LiveRunTrackerV1 {
  return {
    summaryPhaseState: 'not_started',
    primaryPhaseState: 'not_started',
    summaryDispatchCount: 0,
    primaryDispatchCount: 0,
    fullProjectionInRange: false,
    requestObserved: false,
    autoRequestObserved: false,
    checkpointObserved: false,
    primaryCompleted: false,
    summaryCancelled: false,
    currentTurnStopped: false,
    nextTurnPreflight: false,
    unexpectedEffect: false,
    untrustedTerminal: false,
    timedOut: false,
    childExitUnconfirmed: false,
  };
}

function blockedRunReport(
  reasonCode: Exclude<
    L3LiveAutoCompactionRunReasonCodeV1,
    'observed_cancelled' | 'observed_success'
  >,
  tracker: LiveRunTrackerV1,
  options: {
    route?: DiagnosticRouteIdentityV1;
    policyDigest?: string;
    verifierReport?: LiveAutoCompactionObservationDiagnosticReportV1;
  } = {},
): L3LiveAutoCompactionRunReportV1 {
  const verifierReport =
    options.verifierReport ??
    buildLiveAutoCompactionNotObservedReportV1(
      undefined,
      reasonCode === 'phase_budget_drift' ? 'phase_budget_drift' : 'not_observed',
    );
  return liveAutoCompactionRunReportV1Schema.parse({
    schema: 'L3LiveAutoCompactionRunReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    status: 'blocked',
    reasonCode,
    ...routeProjection(options.route, options.policyDigest),
    verifierReportDigest: verifierReport.reportDigest,
    summaryPhaseState: tracker.summaryPhaseState,
    primaryPhaseState: tracker.primaryPhaseState,
    providerDispatchCount: providerDispatchCount(tracker),
  });
}

function buildObservedRunReport(input: {
  outcome: 'success' | 'cancelled';
  route: DiagnosticRouteIdentityV1;
  verifierReport: LiveAutoCompactionObservationDiagnosticReportV1;
  observationRecordDigest: `sha256:${string}`;
  semanticReceiptRecordDigest: `sha256:${string}`;
  durationBucket: LiveAutoCompactionDurationBucketV1;
  tracker: LiveRunTrackerV1;
}): L3LiveAutoCompactionRunReportV1 {
  const reasonCode = input.outcome === 'success' ? 'observed_success' : 'observed_cancelled';
  return liveAutoCompactionRunReportV1Schema.parse({
    schema: 'L3LiveAutoCompactionRunReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    status: 'observed',
    reasonCode,
    outcome: input.outcome,
    ...routeProjection(input.route, L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest),
    verifierReportDigest: input.verifierReport.reportDigest,
    observationRecordDigest: input.observationRecordDigest,
    semanticReceiptRecordDigest: input.semanticReceiptRecordDigest,
    durationBucket: input.durationBucket,
    summaryPhaseState: input.tracker.summaryPhaseState,
    primaryPhaseState: input.tracker.primaryPhaseState,
    providerDispatchCount: providerDispatchCount(input.tracker),
  });
}

function normalizeProviderPromptV1(prompt: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(prompt)) throw new PreDispatchDriftErrorV1();
  return prompt.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new PreDispatchDriftErrorV1();
    }
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new PreDispatchDriftErrorV1();
    }
    if (role === 'system') {
      if (typeof record.content !== 'string') throw new PreDispatchDriftErrorV1();
      return { role, content: record.content };
    }
    if (!Array.isArray(record.content)) throw new PreDispatchDriftErrorV1();
    const texts = record.content.map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part))
        throw new PreDispatchDriftErrorV1();
      const value = part as Record<string, unknown>;
      if (value.type !== 'text' || typeof value.text !== 'string')
        throw new PreDispatchDriftErrorV1();
      return value.text;
    });
    return { role, content: texts.join('') };
  });
}

function measureProviderPromptV1(
  options: Pick<LanguageModelV4CallOptions, 'prompt' | 'maxOutputTokens' | 'tools'>,
): PromptMeasurementV1 {
  if (options.tools !== undefined && options.tools.length !== 0)
    throw new PreDispatchDriftErrorV1();
  const prompt = normalizeProviderPromptV1(options.prompt);
  const inputTokens = countTokens(
    prompt.map(({ role, content }) => `${role}\n${content}`).join('\n'),
  );
  return {
    fingerprint: fixedDigest('kite.qualification.live-auto-compaction.provider-prompt.v1', prompt),
    inputTokens,
    maxOutputTokens: options.maxOutputTokens,
  };
}

function samePromptMeasurementV1(left: PromptMeasurementV1, right: PromptMeasurementV1): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.inputTokens === right.inputTokens &&
    left.maxOutputTokens === right.maxOutputTokens
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function resultTextTokensV1(result: unknown): number {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new DispatchPostconditionErrorV1();
  }
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) throw new DispatchPostconditionErrorV1();
  let text = '';
  for (const part of record.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new DispatchPostconditionErrorV1();
    }
    const value = part as Record<string, unknown>;
    if (value.type === 'tool-call') throw new ModelToolCallDeniedErrorV1();
    if (value.type !== 'text' || typeof value.text !== 'string') {
      throw new DispatchPostconditionErrorV1();
    }
    text += value.text;
  }
  if (!text.trim()) throw new DispatchPostconditionErrorV1();
  return countTokens(text);
}

function resultUsageWithinPhaseCapV1(
  result: unknown,
  inputCap: number,
  outputCap: number,
): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const inputTokens = (usage as Record<string, unknown>).inputTokens;
  const outputTokens = (usage as Record<string, unknown>).outputTokens;
  if (!inputTokens || typeof inputTokens !== 'object' || Array.isArray(inputTokens)) return false;
  if (!outputTokens || typeof outputTokens !== 'object' || Array.isArray(outputTokens))
    return false;
  const inputTotal = (inputTokens as Record<string, unknown>).total;
  const outputTotal = (outputTokens as Record<string, unknown>).total;
  return (
    nonnegativeInteger(inputTotal) &&
    nonnegativeInteger(outputTotal) &&
    inputTotal <= inputCap &&
    outputTotal <= outputCap
  );
}

function l3AutoCompactionConfigV1(): AgentConfig {
  return {
    // Credential and endpoint are intentionally absent from product config.
    // The non-enumerable resolver lease owns the only transport handoff.
    apiKey: '',
    baseURL: '',
    modelName: 'qwen3.6-flash',
    providerName: 'qualification-qwen3.6-flash',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    features: {
      contextCompactionV2: true,
      contextCompactionAutoV1: true,
    },
    modelKwargs: {
      maxOutputTokens: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax,
      supportsToolCalls: false,
      streaming: false,
    },
    // Empty execution surface means ModelController projects no tool schema.
    // No shell executor, MCP manager, skill options/catalog, or subagent sink
    // is supplied to the product executor below.
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
      compactAfterEstimatedTokens:
        L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.compactionThresholdTokens,
      maxSummaryTokens: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax,
      maxNarrativeTokens: 800,
      maxSummaryInputTokens: 8_192,
    },
  };
}

function createSyntheticStateV1(): { state: RuntimeState; fullProjectionTokens: number } {
  const state = createInitialRuntimeState({
    threadId: 'qualification-l3-live-auto-compaction-thread-v1',
    userId: 'qualification',
    // This value is a non-filesystem synthetic identifier. It cannot resolve
    // to the workspace, project root, or a session overlay.
    workspace: 'qualification-sealed-synthetic-root-v1',
    interactionMode: 'accept_edits',
  });
  state.turn = {
    turnId: 'qualification-l3-live-auto-compaction-turn-v1',
    turnIndex: 2,
    status: 'active',
  };
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'qualification-l3-live-auto-compaction-history-v1',
      turnId: 'qualification-l3-live-auto-compaction-history-turn-v1',
      ordinal: 0,
      createdAt: '2026-08-06T00:00:00.000Z',
      content: SAFE_HISTORY_CHUNK_V1.repeat(
        L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.historyChunkRepeats,
      ),
    },
    {
      kind: 'user',
      messageId: 'qualification-l3-live-auto-compaction-current-v1',
      turnId: 'qualification-l3-live-auto-compaction-turn-v1',
      ordinal: 1,
      createdAt: '2026-08-06T00:00:01.000Z',
      content: SAFE_CURRENT_TURN_V1,
    },
  ];
  const fullProjectionTokens = buildContextProjection({ role: 'agent', state }).estimate
    .totalInputTokens;
  if (
    fullProjectionTokens < FULL_PROJECTION_MIN_TOKENS_V1 ||
    fullProjectionTokens > FULL_PROJECTION_MAX_TOKENS_V1
  ) {
    throw new PreDispatchDriftErrorV1();
  }
  return { state, fullProjectionTokens };
}

function generatedTextResultV1(text: string): LanguageModelV4GenerateResult {
  const tokens = countTokens(text);
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: tokens, text: tokens, reasoning: 0 },
    },
    warnings: [],
  };
}

function createRecordingModelV1(
  capture: (measurement: PromptMeasurementV1) => void,
  text: string,
): SupportedChatModel {
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'qualification-local-recording',
    modelId: 'qualification-local-recording',
    supportedUrls: {},
    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      capture(measureProviderPromptV1(options));
      return generatedTextResultV1(text);
    },
    async doStream(): Promise<never> {
      throw new PreDispatchDriftErrorV1();
    },
  };
  return {
    model,
    capabilityMetadata: { streaming: false, maxOutputTokens: 600 },
    supportsToolCalls: false,
    setRetryListener: () => {},
  };
}

async function buildInitialPreflightV1(state: RuntimeState): Promise<{
  readonly summary: PreparedPromptV1;
  readonly worstCasePrimary: PreparedPromptV1;
}> {
  let summaryMeasurement: PromptMeasurementV1 | undefined;
  const summaryModel = createRecordingModelV1((measurement) => {
    if (summaryMeasurement) throw new PreDispatchDriftErrorV1();
    summaryMeasurement = measurement;
  }, SAFE_SUMMARY_V1);
  const compactor = createNarrativeContextCompactor({
    generate: createModelContextSummaryGenerator({ model: summaryModel }),
    maxSummaryTokens: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax,
    maxNarrativeTokens: 800,
    maxSummaryInputTokens: 8_192,
  });
  const estimate = buildContextProjection({ role: 'agent', state }).estimate;
  let checkpoint: Awaited<ReturnType<typeof compactor>>;
  try {
    checkpoint = await compactor({
      state,
      pending: {
        compactionId: 'qualification-l3-live-auto-compaction-dry-run-v1',
        reason: 'auto',
        requestedAtRevision: state.revision,
        requestedAtTurnId: state.turn.turnId,
        force: false,
        estimate,
      },
      sourceRevision: state.revision,
    });
  } catch {
    throw new PreDispatchDriftErrorV1();
  }
  const syntheticProjection = L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1;
  if (
    !summaryMeasurement ||
    summaryMeasurement.inputTokens >
      L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryProviderInputMax ||
    L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryProviderInputMax - summaryMeasurement.inputTokens <
      syntheticProjection.minimumSummaryInputMargin ||
    summaryMeasurement.maxOutputTokens !== L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax ||
    countTokens(normalizeCompactionSummary(SAFE_SUMMARY_V1)) !==
      syntheticProjection.safeSummaryTokens ||
    checkpoint.inputTokensAfter > L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax ||
    L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax - checkpoint.inputTokensAfter <
      syntheticProjection.minimumTailInputMargin ||
    L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.totalMax -
      (summaryMeasurement.inputTokens +
        L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax +
        checkpoint.inputTokensAfter +
        L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax) <
      syntheticProjection.minimumReservationMargin
  ) {
    throw new PreDispatchDriftErrorV1();
  }

  let primaryMeasurement: PromptMeasurementV1 | undefined;
  const primaryModel = createRecordingModelV1((measurement) => {
    if (primaryMeasurement) throw new PreDispatchDriftErrorV1();
    primaryMeasurement = measurement;
  }, SAFE_PRIMARY_RESPONSE_V1);
  try {
    const primaryProjection = buildContextProjection({
      role: 'agent',
      state,
      candidateCheckpoint: checkpoint,
    });
    await invokeBoundModel({
      model: primaryModel,
      tools: {},
      messages: primaryProjection.providerMessages,
      maxOutputTokens: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax,
      streaming: false,
    });
  } catch {
    throw new PreDispatchDriftErrorV1();
  }
  if (
    !primaryMeasurement ||
    primaryMeasurement.inputTokens >
      L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax ||
    L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax -
      primaryMeasurement.inputTokens <
      syntheticProjection.minimumTailInputMargin ||
    primaryMeasurement.maxOutputTokens !== L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax
  ) {
    throw new PreDispatchDriftErrorV1();
  }
  return {
    summary: { ...summaryMeasurement, phase: 'summary' },
    worstCasePrimary: { ...primaryMeasurement, phase: 'primary' },
  };
}

/**
 * Re-runs the exact AI-SDK prompt conversion locally after the real summary
 * checkpoint is committed. This is the JIT tail proof: it has no transport
 * lease and no network path, but it catches a projection/tokenizer drift
 * before a primary model boundary can be entered.
 */
async function buildJitPrimaryPreflightV1(state: RuntimeState): Promise<PreparedPromptV1> {
  let measurement: PromptMeasurementV1 | undefined;
  const model = createRecordingModelV1((captured) => {
    if (measurement) throw new PreDispatchDriftErrorV1();
    measurement = captured;
  }, SAFE_PRIMARY_RESPONSE_V1);
  try {
    const projection = buildContextProjection({ role: 'agent', state });
    await invokeBoundModel({
      model,
      tools: {},
      messages: projection.providerMessages,
      maxOutputTokens: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax,
      streaming: false,
    });
  } catch {
    throw new PreDispatchDriftErrorV1();
  }
  if (
    !measurement ||
    measurement.inputTokens > L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax ||
    measurement.maxOutputTokens !== L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax
  ) {
    throw new PreDispatchDriftErrorV1();
  }
  return { ...measurement, phase: 'primary' };
}

class LiveDispatchGuardV1 {
  private summaryExpected: PreparedPromptV1 | undefined;
  private primaryExpected: PreparedPromptV1 | undefined;
  private activePhase: DispatchPhaseV1 | undefined;
  private readonly tracker: LiveRunTrackerV1;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly deadlineSignal: AbortSignal | undefined;

  constructor(
    tracker: LiveRunTrackerV1,
    externalSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal | undefined,
  ) {
    this.tracker = tracker;
    this.externalSignal = externalSignal;
    this.deadlineSignal = deadlineSignal;
  }

  armSummary(expected: PreparedPromptV1): void {
    if (expected.phase !== 'summary' || this.summaryExpected) throw new PreDispatchDriftErrorV1();
    this.summaryExpected = expected;
  }

  armPrimary(expected: PreparedPromptV1): void {
    if (expected.phase !== 'primary' || this.primaryExpected) throw new PreDispatchDriftErrorV1();
    this.primaryExpected = expected;
  }

  clear(): void {
    this.summaryExpected = undefined;
    this.primaryExpected = undefined;
    this.activePhase = undefined;
  }

  activate(phase: DispatchPhaseV1 | undefined): void {
    this.activePhase = phase;
  }

  activeDispatchPhase(): DispatchPhaseV1 {
    if (!this.activePhase) throw new PreDispatchDriftErrorV1();
    return this.activePhase;
  }

  private expectedFor(phase: DispatchPhaseV1): PreparedPromptV1 | undefined {
    return phase === 'summary' ? this.summaryExpected : this.primaryExpected;
  }

  private consumeExpected(phase: DispatchPhaseV1): void {
    if (phase === 'summary') this.summaryExpected = undefined;
    else this.primaryExpected = undefined;
  }

  private markKnownDispatch(phase: DispatchPhaseV1): void {
    if (phase === 'summary') {
      if (this.tracker.summaryDispatchCount !== 0) throw new PreDispatchDriftErrorV1();
      this.tracker.summaryDispatchCount = 1;
      this.tracker.summaryPhaseState = 'dispatched_known';
      return;
    }
    if (this.tracker.primaryDispatchCount !== 0) throw new PreDispatchDriftErrorV1();
    this.tracker.primaryDispatchCount = 1;
    this.tracker.primaryPhaseState = 'dispatched_known';
  }

  markUnknownAfterPossibleDispatch(phase: DispatchPhaseV1): void {
    this.tracker.untrustedTerminal = true;
    if (phase === 'summary' && this.tracker.summaryDispatchCount > 0) {
      this.tracker.summaryPhaseState = 'dispatched_unknown';
    }
    if (phase === 'primary' && this.tracker.primaryDispatchCount > 0) {
      this.tracker.primaryPhaseState = 'dispatched_unknown';
    }
  }

  private canonicalExternalCancellation(error: unknown): boolean {
    return (
      this.externalSignal?.aborted === true &&
      error instanceof DOMException &&
      error.name === 'AbortError' &&
      !this.tracker.timedOut
    );
  }

  async dispatch<T>(
    phase: DispatchPhaseV1,
    options: LanguageModelV4CallOptions,
    send: () => Promise<T>,
  ): Promise<T> {
    // This check is intentionally before prompt consumption / transport entry.
    // It closes the SIGINT/deadline race between a returned summary and the
    // primary-tail boundary; neither can be reclassified as a successful tail.
    if (this.tracker.timedOut || this.deadlineSignal?.aborted) {
      this.tracker.timedOut = true;
      markKnownZeroIfNotStartedV1(this.tracker);
      throw new PreDispatchDriftErrorV1();
    }
    if (this.externalSignal?.aborted) {
      markKnownZeroIfNotStartedV1(this.tracker);
      throw new PreDispatchDriftErrorV1();
    }
    const expected = this.expectedFor(phase);
    let actual: PromptMeasurementV1;
    try {
      actual = measureProviderPromptV1(options);
    } catch {
      throw new PreDispatchDriftErrorV1();
    }
    if (!expected || !samePromptMeasurementV1(expected, actual)) {
      throw new PreDispatchDriftErrorV1();
    }
    const inputCap =
      phase === 'summary'
        ? L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryProviderInputMax
        : L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax;
    const outputCap =
      phase === 'summary'
        ? L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax
        : L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax;
    if (actual.inputTokens > inputCap || actual.maxOutputTokens !== outputCap) {
      throw new PreDispatchDriftErrorV1();
    }

    // This is the controlled model-boundary cut point. From this line on a
    // failure is never reclassified as a known zero-dispatch result.
    this.consumeExpected(phase);
    this.markKnownDispatch(phase);
    let result: T;
    try {
      result = await send();
    } catch (error) {
      if (phase === 'summary' && this.canonicalExternalCancellation(error)) {
        this.tracker.summaryCancelled = true;
        throw error;
      }
      this.markUnknownAfterPossibleDispatch(phase);
      throw error;
    }
    try {
      const outputTokens = resultTextTokensV1(result);
      if (outputTokens > outputCap || !resultUsageWithinPhaseCapV1(result, inputCap, outputCap)) {
        throw new DispatchPostconditionErrorV1();
      }
      if (phase === 'summary') this.tracker.summaryOutputTokens = outputTokens;
      else this.tracker.primaryOutputTokens = outputTokens;
      return result;
    } catch (error) {
      if (error instanceof ModelToolCallDeniedErrorV1) this.tracker.unexpectedEffect = true;
      this.markUnknownAfterPossibleDispatch(phase);
      throw error;
    }
  }

  async dispatchActive<T>(options: LanguageModelV4CallOptions, send: () => Promise<T>): Promise<T> {
    return await this.dispatch(this.activeDispatchPhase(), options, send);
  }
}

interface IsolatedAq9bTransportContextV1 {
  readonly fixture: LiveIsolatedTransportFixtureV1;
  /** Future supervisor health root; closed test modes never consult it. */
  readonly supervisorLedgerRoot: string | undefined;
  readonly cutoffAtMs: number;
  readonly exitDeadlineAtMs: number;
  readonly operationSignal: AbortSignal | undefined;
  readonly nextTestMode: () => LiveIsolatedTransportTestModeV1 | undefined;
  readonly onTestDispatch: (() => void) | undefined;
}

function isolatedPromptMessagesV1(
  options: LanguageModelV4CallOptions,
): readonly LiveIsolatedTransportPromptMessageV1[] {
  if (!Array.isArray(options.prompt) || options.prompt.length === 0)
    throw new PreDispatchDriftErrorV1();
  const output: LiveIsolatedTransportPromptMessageV1[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') {
      if (typeof message.content !== 'string' || !message.content)
        throw new PreDispatchDriftErrorV1();
      output.push({ role: 'system', content: message.content });
      continue;
    }
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      !Array.isArray(message.content) ||
      message.content.length === 0 ||
      !message.content.every((part) => part.type === 'text' && typeof part.text === 'string')
    ) {
      throw new PreDispatchDriftErrorV1();
    }
    const content = message.content.map((part) => (part as { text: string }).text).join('');
    if (!content) throw new PreDispatchDriftErrorV1();
    output.push({ role: message.role, content });
  }
  return Object.freeze(output);
}

function toolMarkerResultV1(): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'qualification-l3-isolated-tool-marker-v1',
        toolName: 'isolated_tool_marker',
        input: '{}',
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 0, reasoning: 0 },
    },
    warnings: [],
  };
}

async function runAq9bChildTransportV1(input: {
  readonly resolution: L3AutoCompactionExecutionResolutionV1;
  readonly guard: LiveDispatchGuardV1;
  readonly context: IsolatedAq9bTransportContextV1;
  readonly options: LanguageModelV4CallOptions;
  readonly tracker: LiveRunTrackerV1;
}): Promise<LanguageModelV4GenerateResult> {
  const phase = input.guard.activeDispatchPhase();
  const messages = isolatedPromptMessagesV1(input.options);
  const testMode = input.context.nextTestMode();
  const operation = testMode ? ('test' as const) : ('aq9b' as const);
  const modelBoundary = input.resolution.modelBoundary;
  if (!testMode && !modelBoundary) throw new PreDispatchDriftErrorV1();
  const terminal = await runLiveIsolatedTransportV1(
    {
      fixture: input.context.fixture,
      // Closed fixed child modes may not receive a provider boundary or
      // credential lease. Production AQ-9B stays behind the disabled gate.
      ...(testMode ? {} : { modelBoundary: modelBoundary! }),
      request: {
        operation,
        routeAlias: 'qualification-qwen3.6-flash',
        model: 'qwen3.6-flash',
        phase,
        maxInputTokens:
          phase === 'summary'
            ? L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryProviderInputMax
            : L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpProviderInputMax,
        maxOutputTokens:
          phase === 'summary'
            ? L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax
            : L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax,
        promptDigest: liveIsolatedTransportPromptDigestV1({
          operation,
          phase,
          ...(operation === 'aq9b' ? { promptMessages: messages } : {}),
        }),
        ...(operation === 'aq9b' ? { promptMessages: messages } : { testMode: testMode! }),
      },
      cutoffAtMs: input.context.cutoffAtMs,
      exitDeadlineAtMs: input.context.exitDeadlineAtMs,
      operationSignal: input.context.operationSignal,
      supervisorLedgerRoot: input.context.supervisorLedgerRoot,
    },
    testMode
      ? {
          testMode,
          ...(input.context.onTestDispatch ? { onDispatched: input.context.onTestDispatch } : {}),
        }
      : {},
  );
  if (terminal.status === 'deadline_exceeded' || terminal.status === 'child_exit_unconfirmed') {
    input.tracker.timedOut = true;
    input.tracker.childExitUnconfirmed ||= terminal.status === 'child_exit_unconfirmed';
    input.tracker.untrustedTerminal = true;
    throw new PreDispatchDriftErrorV1();
  }
  if (terminal.status !== 'result' || !terminal.result) throw new PreDispatchDriftErrorV1();
  const result = terminal.result;
  if (result.outcome === 'cancelled')
    throw new DOMException('qualification_child_cancelled', 'AbortError');
  if (result.outcome !== 'success') {
    if (result.generation?.kind === 'tool_marker') return toolMarkerResultV1();
    throw new PreDispatchDriftErrorV1();
  }
  if (
    (phase === 'summary' && result.generation?.kind !== 'accepted_summary') ||
    (phase === 'primary' && result.generation?.kind !== 'accepted_primary')
  ) {
    throw new PreDispatchDriftErrorV1();
  }
  // No provider text crosses IPC. The existing literal product chain receives
  // only a fixed source-owned safe response after strict nonce/phase/digest/
  // cap validation in the shared boundary.
  return generatedTextResultV1(phase === 'summary' ? SAFE_SUMMARY_V1 : SAFE_PRIMARY_RESPONSE_V1);
}

function createLeaseBoundModelV1(input: {
  readonly resolution: L3AutoCompactionExecutionResolutionV1;
  readonly guard: LiveDispatchGuardV1;
  readonly transportContext: IsolatedAq9bTransportContextV1;
  readonly tracker: LiveRunTrackerV1;
  /** Private closed scenario model; no caller supplies this to the live runner. */
  readonly syntheticModel?: LanguageModelV4;
}): SupportedChatModel {
  const dispatch = async (options: LanguageModelV4CallOptions) =>
    input.guard.dispatchActive(options, async () => {
      if (input.syntheticModel) return await input.syntheticModel.doGenerate(options);
      return await runAq9bChildTransportV1({
        resolution: input.resolution,
        guard: input.guard,
        context: input.transportContext,
        options,
        tracker: input.tracker,
      });
    });

  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'qualification-l3-live-auto-compaction',
    modelId: 'qwen3.6-flash',
    supportedUrls: {},
    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      return (await dispatch(options)) as LanguageModelV4GenerateResult;
    },
    async doStream(): Promise<never> {
      throw new PreDispatchDriftErrorV1();
    },
  };

  return Object.freeze({
    model,
    capabilityMetadata: { streaming: false, maxOutputTokens: 600 },
    supportsToolCalls: false,
    setRetryListener: () => {},
  });
}

function createGuardedProductExecutorV1(input: {
  readonly config: AgentConfig;
  readonly model: SupportedChatModel;
  readonly guard: LiveDispatchGuardV1;
  readonly signal: AbortSignal | undefined;
  readonly tracker: LiveRunTrackerV1;
  readonly onPermittedProductEffect?: (effectType: 'call_model' | 'compact_context') => void;
}): RuntimeEffectExecutor {
  const summaryGenerator = createModelContextSummaryGenerator({
    model: input.model,
    signal: input.signal,
  });
  const realCompactor = createNarrativeContextCompactor({
    generate: async (request) => {
      const generated = await summaryGenerator(request);
      const value = typeof generated === 'string' ? generated : generated.summary;
      if (
        typeof value !== 'string' ||
        countTokens(normalizeCompactionSummary(value)) >
          L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax
      ) {
        // The response could already have crossed the summary transport
        // boundary, so a too-long result is unknown/full-charge and never
        // eligible to create a tail request.
        input.guard.markUnknownAfterPossibleDispatch('summary');
        throw new ContextCompactionValidationError(
          'truncated_summary',
          'AQ-9B summary exceeds its independent output cap.',
        );
      }
      return generated;
    },
    maxSummaryTokens: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax,
    maxNarrativeTokens: 800,
    maxSummaryInputTokens: 8_192,
  });
  // This is the actual production runtime executor. The wrapper below only
  // narrows its available effects; it does not emulate ModelController or the
  // context compactor.
  const productExecutor = createRuntimeEffectExecutor({
    config: input.config,
    model: input.model,
    signal: input.signal,
    contextCompactor: realCompactor,
  });

  return async (effect, state, emit, executionContext) => {
    if (effect.type === 'compact_context') {
      const pending = state.context.pendingCompaction;
      if (
        !pending ||
        pending.reason !== 'auto' ||
        input.tracker.summaryPhaseState !== 'not_started'
      ) {
        input.tracker.unexpectedEffect = true;
        throw new UnexpectedL3AutoCompactionEffectErrorV1();
      }
      input.guard.activate('summary');
      try {
        input.onPermittedProductEffect?.(effect.type);
        return await productExecutor(effect, state, emit, executionContext);
      } finally {
        input.guard.activate(undefined);
      }
    }
    if (effect.type === 'call_model') {
      if (state.context.activeCheckpoint) {
        let prepared: PreparedPromptV1;
        try {
          prepared = await buildJitPrimaryPreflightV1(state);
        } catch {
          // Summary may already have entered transport. A tail preflight
          // mismatch is known zero tail dispatch but an unknown terminal run.
          input.tracker.primaryPhaseState = 'known_zero';
          input.tracker.untrustedTerminal = true;
          throw new PreDispatchDriftErrorV1();
        }
        input.guard.armPrimary(prepared);
        input.guard.activate('primary');
      } else {
        // The initial ModelController call is expected to return only metrics
        // and `context.compaction_requested`. If it tries a normal primary
        // dispatch, the lease-bound model has no armed phase and stops it
        // before transport.
        input.guard.activate(undefined);
      }
      try {
        input.onPermittedProductEffect?.(effect.type);
        return await productExecutor(effect, state, emit, executionContext);
      } finally {
        input.guard.activate(undefined);
      }
    }
    if (effect.type !== 'stop') {
      input.tracker.unexpectedEffect = true;
      if (input.tracker.primaryPhaseState === 'not_started') {
        input.tracker.primaryPhaseState = 'known_zero';
      }
      if (input.tracker.summaryDispatchCount > 0 || input.tracker.primaryDispatchCount > 0) {
        input.tracker.untrustedTerminal = true;
      }
      throw new UnexpectedL3AutoCompactionEffectErrorV1();
    }
    return [];
  };
}

const noInteractionProviderV1: RuntimeActionProvider = {
  async requestAction() {
    throw new UnexpectedL3AutoCompactionEffectErrorV1();
  },
};

/**
 * The request event is the durable handoff between ModelController's source-
 * owned automatic-compaction decision and the diagnostic runner.  Keep this
 * check pure so its negative mutation is covered without manufacturing a
 * parallel Runtime event source in a test.
 */
export function isL3LiveAutoCompactionRequestBoundToTurnV1(
  event: Extract<RuntimeEvent, { type: 'context.compaction_requested' }>,
  expectedTurnId: string,
): boolean {
  return (
    expectedTurnId.length > 0 &&
    event.reason === 'auto' &&
    event.force === false &&
    event.customInstructions === undefined &&
    event.requestedAtTurnId === expectedTurnId
  );
}

function observeRuntimeEventV1(
  event: RuntimeEvent,
  tracker: LiveRunTrackerV1,
  currentTurnId: string,
): void {
  if (event.type === 'model.context_metrics') {
    if (
      event.totalInputTokens >= FULL_PROJECTION_MIN_TOKENS_V1 &&
      event.totalInputTokens <= FULL_PROJECTION_MAX_TOKENS_V1
    ) {
      tracker.fullProjectionInRange = true;
    }
    if (tracker.currentTurnStopped && event.totalInputTokens >= FULL_PROJECTION_MIN_TOKENS_V1) {
      tracker.nextTurnPreflight = true;
    }
    return;
  }
  if (event.type === 'context.compaction_requested') {
    if (!isL3LiveAutoCompactionRequestBoundToTurnV1(event, currentTurnId)) {
      tracker.untrustedTerminal = true;
      return;
    }
    if (
      tracker.requestTurnId !== undefined &&
      (!tracker.currentTurnStopped || event.requestedAtTurnId !== tracker.nextTurnId)
    ) {
      tracker.untrustedTerminal = true;
      return;
    }
    tracker.autoRequestObserved = true;
    tracker.requestTurnId ??= event.requestedAtTurnId;
    return;
  }
  if (event.type === 'context.compaction_completed') {
    tracker.checkpointObserved = true;
    return;
  }
  if (event.type === 'context.compaction_failed') {
    if (event.errorKind === 'summary_aborted' && tracker.summaryCancelled) {
      tracker.currentTurnStopped = true;
    } else {
      tracker.untrustedTerminal = true;
    }
    return;
  }
  if (event.type === 'model.requested') {
    tracker.requestObserved = true;
    return;
  }
  if (event.type === 'model.responded') {
    if ((event.toolCalls?.length ?? 0) > 0) tracker.unexpectedEffect = true;
    else tracker.primaryCompleted = true;
    return;
  }
  if (
    event.type === 'tool.queued' ||
    event.type === 'tool.failed' ||
    event.type === 'tool.finished'
  ) {
    tracker.unexpectedEffect = true;
  }
}

type ExecutableEffectTypeV1 = Exclude<RuntimeEffect['type'], 'stop'>;

function boundedProductSequenceV1(
  expectedEffects: readonly ExecutableEffectTypeV1[],
  terminalEffect: ExecutableEffectTypeV1,
  tracker: LiveRunTrackerV1,
): (effect: RuntimeEffect, state: Readonly<RuntimeState>) => RuntimeEffect {
  let index = 0;
  return (effect) => {
    if (effect.type === 'stop') return effect;
    const expected = expectedEffects[index];
    if (expected !== undefined && effect.type === expected) {
      index += 1;
      return effect;
    }
    // The product has now reached its normal next effect.  Returning `stop`
    // here prevents `runRuntimeLoop` from executing an `emit_final` or a
    // second compaction.  We still assert exactly which product effect was
    // scheduled, so this is not a permissive effect limiter.
    if (expected === undefined && effect.type === terminalEffect) return { type: 'stop' };
    tracker.unexpectedEffect = true;
    throw new UnexpectedL3AutoCompactionEffectErrorV1();
  };
}

async function consumeRuntimeLoopV1(
  kernel: AgentKernel,
  executor: RuntimeEffectExecutor,
  tracker: LiveRunTrackerV1,
  expectedEffects: readonly ExecutableEffectTypeV1[],
  terminalEffect: ExecutableEffectTypeV1,
  signal: AbortSignal | undefined,
): Promise<void> {
  for await (const event of runRuntimeLoop(
    kernel,
    executor,
    noInteractionProviderV1,
    expectedEffects.length + 1,
    boundedProductSequenceV1(expectedEffects, terminalEffect, tracker),
    signal,
  )) {
    observeRuntimeEventV1(event, tracker, kernel.getState().turn.turnId);
  }
}

function markKnownZeroIfNotStartedV1(tracker: LiveRunTrackerV1): void {
  if (tracker.summaryPhaseState === 'not_started') tracker.summaryPhaseState = 'known_zero';
  if (tracker.primaryPhaseState === 'not_started') tracker.primaryPhaseState = 'known_zero';
}

function markUnknownAfterRunFailureV1(tracker: LiveRunTrackerV1): void {
  if (tracker.summaryDispatchCount > 0) tracker.summaryPhaseState = 'dispatched_unknown';
  if (tracker.primaryDispatchCount > 0) tracker.primaryPhaseState = 'dispatched_unknown';
  // Once the only summary boundary has been entered and no checkpoint/tail
  // can be trusted, the primary is known not to have dispatched. Preserve
  // this causal zero rather than leaking an ambiguous not-started state.
  if (tracker.primaryDispatchCount === 0 && tracker.primaryPhaseState === 'not_started') {
    tracker.primaryPhaseState = 'known_zero';
  }
  if (tracker.summaryDispatchCount > 0 || tracker.primaryDispatchCount > 0) {
    tracker.untrustedTerminal = true;
  } else {
    markKnownZeroIfNotStartedV1(tracker);
  }
}

function turnDigestV1(turnId: string): `sha256:${string}` {
  return fixedDigest('kite.qualification.live-auto-compaction.turn.v1', { turnId });
}

function requestedQuotaV1(): LiveGovernanceQuotaCountersV1 {
  return {
    attempts: L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxAttemptsPerInvocation,
    tokens: L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxTotalTokens,
    runWallClockSeconds: L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxRunWallClockSeconds,
    costUsdMicros: L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxCostUsdMicros,
  };
}

function reconciledQuotaV1(
  outcome: SealedRunResultV1['kind'],
  tracker: LiveRunTrackerV1,
  startedAtMs: number,
  finishedAtMs: number,
): LiveGovernanceQuotaCountersV1 {
  if (tracker.untrustedTerminal || tracker.timedOut) return requestedQuotaV1();
  if (outcome === 'blocked') {
    return { attempts: 0, tokens: 0, runWallClockSeconds: 0, costUsdMicros: 0 };
  }
  return {
    // A cancellation has one known summary attempt; a success has its fixed
    // two phase attempts. Both retain the full token/cost reservation so a
    // short provider output cannot reduce diagnostic governance charge.
    attempts: outcome === 'success' ? 2 : 1,
    tokens: L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxTotalTokens,
    runWallClockSeconds: Math.max(1, Math.ceil((finishedAtMs - startedAtMs) / 1_000)),
    costUsdMicros: L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxCostUsdMicros,
  };
}

function evidenceEligibleRunV1(
  tracker: LiveRunTrackerV1,
  outcome: 'success' | 'cancelled',
): boolean {
  if (
    tracker.untrustedTerminal ||
    tracker.timedOut ||
    tracker.unexpectedEffect ||
    !tracker.fullProjectionInRange ||
    !tracker.autoRequestObserved ||
    tracker.summaryPhaseState !== 'dispatched_known' ||
    tracker.summaryDispatchCount !== 1
  ) {
    return false;
  }
  if (outcome === 'success') {
    return (
      tracker.checkpointObserved &&
      tracker.requestObserved &&
      tracker.primaryCompleted &&
      tracker.primaryPhaseState === 'dispatched_known' &&
      tracker.primaryDispatchCount === 1 &&
      tracker.summaryOutputTokens !== undefined &&
      tracker.summaryOutputTokens <= L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.summaryOutputMax &&
      tracker.primaryOutputTokens !== undefined &&
      tracker.primaryOutputTokens <= L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.followUpOutputMax
    );
  }
  return (
    tracker.summaryCancelled &&
    tracker.currentTurnStopped &&
    tracker.nextTurnPreflight &&
    tracker.primaryPhaseState === 'known_zero' &&
    tracker.primaryDispatchCount === 0
  );
}

async function runInMemoryAutoCompactionV1(input: {
  readonly resolution: L3AutoCompactionExecutionResolutionV1;
  /** Product runtime sees only this operation signal; parent env/cwd stay untouched. */
  readonly signal: AbortSignal | undefined;
  readonly externalSignal: AbortSignal | undefined;
  readonly deadlineSignal: AbortSignal | undefined;
  readonly transportContext: IsolatedAq9bTransportContextV1;
  readonly tracker: LiveRunTrackerV1;
  readonly syntheticModel?: LanguageModelV4;
  readonly onPermittedProductEffect?: (effectType: 'call_model' | 'compact_context') => void;
  readonly onCancellationNextTurnPreflight?: (turnId: string) => void;
}): Promise<SealedRunResultV1> {
  const { state, fullProjectionTokens } = createSyntheticStateV1();
  input.tracker.fullProjectionInRange =
    fullProjectionTokens >= FULL_PROJECTION_MIN_TOKENS_V1 &&
    fullProjectionTokens <= FULL_PROJECTION_MAX_TOKENS_V1;
  const initialPreflight = await buildInitialPreflightV1(state);
  // The primary worst-case dry run is intentionally used only as a bound. It
  // never supplies a real provider prompt; after a real summary the JIT proof
  // reconstructs a fresh exact prompt before the primary dispatch.
  if (initialPreflight.worstCasePrimary.inputTokens > 3_229) {
    throw new PreDispatchDriftErrorV1();
  }
  if (input.signal?.aborted) {
    markKnownZeroIfNotStartedV1(input.tracker);
    return { kind: 'blocked', reasonCode: 'not_observed' };
  }

  const guard = new LiveDispatchGuardV1(input.tracker, input.externalSignal, input.deadlineSignal);
  guard.armSummary(initialPreflight.summary);
  const model = createLeaseBoundModelV1({
    resolution: input.resolution,
    guard,
    transportContext: input.transportContext,
    tracker: input.tracker,
    syntheticModel: input.syntheticModel,
  });
  const config = l3AutoCompactionConfigV1();
  const kernel = new AgentKernel({
    store: createRuntimeStore(':memory:'),
    initialState: state,
    interactionMode: 'accept_edits',
  });
  const executor = createGuardedProductExecutorV1({
    config,
    model,
    guard,
    signal: input.signal,
    tracker: input.tracker,
    onPermittedProductEffect: input.onPermittedProductEffect,
  });
  try {
    try {
      // Exactly: ModelController preflight -> product compactor ->
      // ModelController primary. The loop limit prevents an `emit_final` or
      // any follow-on effect from being dispatched in this diagnostic runner.
      await consumeRuntimeLoopV1(
        kernel,
        executor,
        input.tracker,
        ['call_model', 'compact_context', 'call_model'],
        'emit_final',
        input.signal,
      );
    } catch {
      markUnknownAfterRunFailureV1(input.tracker);
      return {
        kind: 'blocked',
        reasonCode: input.tracker.unexpectedEffect ? 'tool_output_denied' : 'phase_budget_drift',
      };
    }
    if (input.tracker.timedOut) {
      markUnknownAfterRunFailureV1(input.tracker);
      return { kind: 'blocked', reasonCode: 'timeout' };
    }
    if (input.tracker.unexpectedEffect) {
      if (input.tracker.summaryDispatchCount > 0 || input.tracker.primaryDispatchCount > 0) {
        input.tracker.untrustedTerminal = true;
      }
      return { kind: 'blocked', reasonCode: 'tool_output_denied' };
    }
    if (evidenceEligibleRunV1(input.tracker, 'success')) return { kind: 'success' };

    // Only a user-originated AbortError that occurred inside the one known
    // summary dispatch qualifies for the cancellation branch. Timeouts and
    // transport-originated AbortErrors are unknown/blocked above.
    if (
      input.tracker.summaryCancelled &&
      input.tracker.summaryPhaseState === 'dispatched_known' &&
      input.tracker.primaryDispatchCount === 0 &&
      decideNextEffect(kernel.getState()).type === 'stop'
    ) {
      input.tracker.primaryPhaseState = 'known_zero';
      const nextTurnId = 'qualification-l3-live-auto-compaction-next-turn-v1';
      input.tracker.nextTurnId = nextTurnId;
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'qualification-l3-live-auto-compaction-next-user-v1',
        content: SAFE_CURRENT_TURN_V1,
      });
      kernel.processEvent({ type: 'turn.started', turnId: nextTurnId });
      if (decideNextEffect(kernel.getState()).type !== 'call_model') {
        markUnknownAfterRunFailureV1(input.tracker);
        return { kind: 'blocked', reasonCode: 'not_observed' };
      }
      try {
        input.onCancellationNextTurnPreflight?.(nextTurnId);
      } catch {
        markUnknownAfterRunFailureV1(input.tracker);
        return { kind: 'blocked', reasonCode: 'not_observed' };
      }
      try {
        // One ModelController preflight only. Its automatic request proves a
        // new user turn may retry; it cannot enter the summary model because
        // the runner stops after the first effect.
        await consumeRuntimeLoopV1(
          kernel,
          executor,
          input.tracker,
          ['call_model'],
          'compact_context',
          // The prior user cancellation must stop only the current turn. A
          // new user turn receives a fresh loop signal and may perform the
          // product preflight, but its unarmed model boundary cannot dispatch.
          undefined,
        );
      } catch {
        markUnknownAfterRunFailureV1(input.tracker);
        return { kind: 'blocked', reasonCode: 'not_observed' };
      }
      if (evidenceEligibleRunV1(input.tracker, 'cancelled')) return { kind: 'cancelled' };
    }
    markKnownZeroIfNotStartedV1(input.tracker);
    return { kind: 'blocked', reasonCode: 'not_observed' };
  } finally {
    guard.clear();
    kernel.close();
  }
}

/**
 * A test-only exported, zero-credential contract driver for deterministic
 * product Runtime tests. It is not an L3 runner: it accepts no environment, ledger,
 * resolver result, model lease, release input, or persistence destination.
 * Its return shape is intentionally not a compatibility observation, receipt,
 * report, or other diagnostic evidence.
 */
export interface SyntheticAutoCompactionContractInputV1 {
  readonly signal?: AbortSignal;
  /** Fixed local response sequence; no caller-provided model/function exists. */
  readonly scenario?: 'success';
  /** Closed no-credential child modes only; each produces operation='test'. */
  readonly isolatedTransportTestModes?: readonly LiveIsolatedTransportTestModeV1[];
  readonly isolatedTransportDeadlineMs?: number;
  readonly onIsolatedTransportDispatch?: () => void;
  readonly onPermittedProductEffect?: (effectType: 'call_model' | 'compact_context') => void;
  readonly onCancellationNextTurnPreflight?: (turnId: string) => void;
}

function closedSyntheticScenarioModelV1(): LanguageModelV4 {
  let calls = 0;
  return Object.freeze({
    specificationVersion: 'v4' as const,
    provider: 'qualification-closed-synthetic' as const,
    modelId: 'qualification-closed-synthetic' as const,
    supportedUrls: {},
    async doGenerate(): Promise<LanguageModelV4GenerateResult> {
      calls += 1;
      if (calls === 1) return generatedTextResultV1(SAFE_SUMMARY_V1);
      if (calls === 2) return generatedTextResultV1(SAFE_PRIMARY_RESPONSE_V1);
      throw new PreDispatchDriftErrorV1();
    },
    async doStream(): Promise<never> {
      throw new PreDispatchDriftErrorV1();
    },
  });
}

export interface SyntheticAutoCompactionContractResultV1 {
  readonly schema: 'SyntheticAutoCompactionContractResultV1';
  readonly version: 1;
  readonly testOnly: true;
  readonly persistence: 'forbidden';
  readonly status: 'success' | 'cancelled' | 'blocked';
  readonly reasonCode:
    | 'synthetic_success'
    | 'synthetic_cancelled'
    | 'synthetic_input_invalid'
    | 'policy_invalid'
    | 'not_observed'
    | 'phase_budget_drift'
    | 'timeout'
    | 'tool_output_denied';
  readonly summaryPhaseState: LiveAutoCompactionPhaseStateV1;
  readonly primaryPhaseState: LiveAutoCompactionPhaseStateV1;
  readonly providerDispatchCount: 0 | 1 | 2 | 'unknown';
  readonly nextTurnPreflight: boolean;
}

function syntheticContractResultV1(
  tracker: LiveRunTrackerV1,
  status: SyntheticAutoCompactionContractResultV1['status'],
  reasonCode: SyntheticAutoCompactionContractResultV1['reasonCode'],
): SyntheticAutoCompactionContractResultV1 {
  return Object.freeze({
    schema: 'SyntheticAutoCompactionContractResultV1' as const,
    version: 1 as const,
    testOnly: true as const,
    persistence: 'forbidden' as const,
    status,
    reasonCode,
    summaryPhaseState: tracker.summaryPhaseState,
    primaryPhaseState: tracker.primaryPhaseState,
    providerDispatchCount: providerDispatchCount(tracker),
    nextTurnPreflight: tracker.nextTurnPreflight,
  });
}

/**
 * Test-only product-chain driver. Its route/fixture are fixed source-owned
 * metadata, its child modes are `operation='test'`, and it deliberately has
 * no position for a credential-bearing `LiveRouteModelBoundaryLeaseV1`.
 */
export async function runSyntheticAutoCompactionContractV1(
  input: SyntheticAutoCompactionContractInputV1,
): Promise<SyntheticAutoCompactionContractResultV1> {
  const tracker = freshTracker();
  const hasScenario = input.scenario === 'success';
  const modes = input.isolatedTransportTestModes ?? [];
  if (
    (input.scenario !== undefined && input.scenario !== 'success') ||
    hasScenario === modes.length > 0
  ) {
    markKnownZeroIfNotStartedV1(tracker);
    return syntheticContractResultV1(tracker, 'blocked', 'synthetic_input_invalid');
  }
  if (!l3LiveAutoCompactionPolicyIsClosedV1() || !l3LiveAutoCompactionSourceRegistryIsClosedV1()) {
    markKnownZeroIfNotStartedV1(tracker);
    return syntheticContractResultV1(tracker, 'blocked', 'policy_invalid');
  }
  const deadline = liveIsolatedTransportDeadlineV1(input.isolatedTransportDeadlineMs ?? 1_000);
  if (!deadline) {
    markKnownZeroIfNotStartedV1(tracker);
    return syntheticContractResultV1(tracker, 'blocked', 'policy_invalid');
  }
  const route = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1.scope.route;
  if (!route) {
    markKnownZeroIfNotStartedV1(tracker);
    return syntheticContractResultV1(tracker, 'blocked', 'policy_invalid');
  }
  let testModeIndex = 0;
  const result = await runInMemoryAutoCompactionV1({
    // This is only the source-owned route identity. There is intentionally no
    // resolver result or model lease on this object.
    resolution: Object.freeze({ route }),
    signal: input.signal,
    externalSignal: input.signal,
    deadlineSignal: undefined,
    transportContext: {
      fixture: {
        fixtureId: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureId,
        fixtureDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureDigest,
        bytes: materializeL3LiveAutoCompactionFixtureBytesV1(),
      },
      supervisorLedgerRoot: undefined,
      cutoffAtMs: deadline.cutoffAtMs,
      exitDeadlineAtMs: deadline.exitDeadlineAtMs,
      operationSignal: input.signal,
      nextTestMode: () => modes[testModeIndex++],
      onTestDispatch: input.onIsolatedTransportDispatch,
    },
    tracker,
    syntheticModel: hasScenario ? closedSyntheticScenarioModelV1() : undefined,
    onPermittedProductEffect: input.onPermittedProductEffect,
    onCancellationNextTurnPreflight: input.onCancellationNextTurnPreflight,
  });
  if (result.kind === 'success') {
    return syntheticContractResultV1(tracker, 'success', 'synthetic_success');
  }
  if (result.kind === 'cancelled') {
    return syntheticContractResultV1(tracker, 'cancelled', 'synthetic_cancelled');
  }
  return syntheticContractResultV1(tracker, 'blocked', result.reasonCode ?? 'not_observed');
}

function buildObservedEvidenceV1(input: {
  readonly outcome: 'success' | 'cancelled';
  readonly route: DiagnosticRouteIdentityV1;
  readonly reservation: Extract<
    ReturnType<typeof reconcileLiveGovernanceQuotaV1>,
    { status: 'reconciled' }
  >['reservation'];
  readonly startedAt: string;
  readonly observedAt: string;
  readonly tracker: LiveRunTrackerV1;
}): L3LiveAutoCompactionRunReportV1 {
  const source = L3_LIVE_AUTO_COMPACTION_SOURCE_REGISTRY_V1;
  // The raw counter is ledger-only. Derive the one approved coarse value
  // before constructing any receipt, report, or other retained metadata.
  const durationBucket = liveAutoCompactionDurationBucketForRunWallClockSecondsV1(
    input.reservation.dayQuotaLedger.reconciled?.runWallClockSeconds,
  );
  if (!durationBucket) throw new PreDispatchDriftErrorV1();
  const execution = buildDiagnosticExecutionV1({
    executionId: `l3-live-auto-compaction-execution-${input.reservation.reservationId}`,
    platformIdentity: LOCAL_PLATFORM_IDENTITY_V1,
    identity: {
      source: 'local_synthetic',
      fixtureId: source.execution.fixtureId,
      runner: source.execution.runner,
      commit: source.execution.commit,
      startedAt: input.startedAt,
      endedAt: input.observedAt,
    },
  });
  const governance = {
    retentionClass: 'ephemeral_local' as const,
    profileId: input.reservation.profileId,
    profileDigest: input.reservation.profileDigest,
    quotaLedgerDigests: {
      day: input.reservation.dayQuotaLedger.recordDigest,
      month: input.reservation.monthQuotaLedger.recordDigest,
    },
    storageDeletionWitnessDigest: input.reservation.scratchDeletionWitness.recordDigest,
  };
  const observation = buildLiveCompatibilityObservationV1({
    schema: 'LiveCompatibilityObservationV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    observedAt: input.observedAt,
    candidate: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
    governance,
    execution,
    scope: source.scope,
    identity: source.identity,
    outcome: input.outcome,
  });
  const context = buildLiveAutoCompactionObservationVerifierContextV1({
    schema: 'LiveAutoCompactionObservationVerifierContextV1',
    version: 1,
    candidate: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
    governance,
    execution,
    scope: source.scope,
    identity: source.identity,
    governanceWitnesses: {
      dayQuotaLedger: input.reservation.dayQuotaLedger,
      monthQuotaLedger: input.reservation.monthQuotaLedger,
      retention: input.reservation.scratchDeletionWitness,
    },
  });
  const capabilityResolution = buildDiagnosticModelCapabilityResolutionV1({
    schema: 'DiagnosticModelCapabilityResolutionV1',
    version: 1,
    capabilityDeclarationDigest: source.policy.capabilityDeclarationDigest,
    contextWindowTokens: 'unknown',
    contextWindowSource: 'not_declared',
    maxOutputTokens: 600,
    maxOutputTokensSource: 'compatibility_config',
  });
  const requestTurnId = input.tracker.requestTurnId;
  if (!requestTurnId) throw new PreDispatchDriftErrorV1();
  const requestTurnDigest = turnDigestV1(requestTurnId);
  const receipt = buildLiveAutoCompactionSemanticReceiptV1({
    schema: 'LiveAutoCompactionSemanticReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l3-live-auto-compaction-receipt:l3-auto-compaction-${input.outcome}-v1`,
    caseId: `l3-auto-compaction-${input.outcome}-v1`,
    outcome: input.outcome,
    compactAfterEstimatedTokens: 8_192,
    fullProjectionTokenBucket: '9000_10000',
    durationBucket,
    durationBucketPolicyDigest: source.semantic.durationBucketPolicyDigest,
    phaseCaps: source.semantic.phaseCaps,
    phaseCapsDigest: source.semantic.phaseCapsDigest,
    capabilityResolution,
    semanticEvents:
      input.outcome === 'success'
        ? [...LIVE_AUTO_COMPACTION_SUCCESS_TRACE_V1]
        : [...LIVE_AUTO_COMPACTION_CANCELLED_TRACE_V1],
    phases:
      input.outcome === 'success'
        ? {
            summaryPhaseState: 'dispatched_known',
            primaryPhaseState: 'dispatched_known',
            summaryDispatchCount: 1,
            primaryDispatchCount: 1,
            summaryProviderInputBucket: '0_7800',
            summaryOutputBucket: '0_600',
            primaryProviderInputBucket: '0_3229',
            primaryOutputBucket: '0_600',
            invocationTokenBucket: '0_12229',
          }
        : {
            summaryPhaseState: 'dispatched_known',
            primaryPhaseState: 'known_zero',
            summaryDispatchCount: 1,
            primaryDispatchCount: 0,
            summaryProviderInputBucket: '0_7800',
            summaryOutputBucket: 'not_observed',
            primaryProviderInputBucket: 'not_dispatched',
            primaryOutputBucket: 'not_dispatched',
            invocationTokenBucket: '0_12229',
          },
    turns:
      input.outcome === 'success'
        ? {
            requestTurnDigest,
            checkpointTurnDigest: requestTurnDigest,
            primaryDispatchTurnDigest: requestTurnDigest,
          }
        : {
            requestTurnDigest,
            failedTurnDigest: requestTurnDigest,
            stoppedTurnDigest: requestTurnDigest,
            nextTurnDigest: turnDigestV1(input.tracker.nextTurnId ?? ''),
          },
    sourceBinding: {
      policyDigest: source.policy.policyDigest,
      durationBucketPolicyDigest: source.semantic.durationBucketPolicyDigest,
      phaseCapsDigest: source.semantic.phaseCapsDigest,
      syntheticProjectionDigest: source.semantic.syntheticProjection.syntheticProjectionDigest,
      routeIdentityDigest: source.policy.routeIdentityDigest,
      providerDataPolicyDigest: source.policy.providerDataPolicyDigest,
      capabilityDeclarationDigest: source.policy.capabilityDeclarationDigest,
      promptEnvironmentDigest: source.policy.promptEnvironmentDigest,
      routeToolCatalogDigest: source.policy.routeToolCatalogDigest,
      toolEnvironmentDigest: source.policy.toolEnvironmentDigest,
      sourceOwnedIdentityDigest: source.policy.sourceOwnedIdentityDigest,
      candidateClosureDigest: source.policy.candidateClosureDigest,
      matrixDigest: source.policy.matrixDigest,
      matrixSuiteDigest: source.policy.matrixSuiteDigest,
      suiteDigest: source.policy.suiteDigest,
      fixtureDigest: source.policy.fixtureDigest,
      corpusDigest: source.policy.corpusDigest,
      oracleDigest: source.policy.oracleDigest,
      evaluatorDigest: source.policy.evaluatorDigest,
      verifierDigest: source.policy.verifierDigest,
      runnerSourceDigest: source.policy.runnerSourceDigest,
      runnerDigest: source.policy.runnerDigest,
      transportBindingDigest: source.policy.transportBindingDigest,
      executionDigest: execution.executionDigest,
      governanceProfileDigest: source.governance.profileDigest,
      dayQuotaLedgerDigest: input.reservation.dayQuotaLedger.recordDigest,
      monthQuotaLedgerDigest: input.reservation.monthQuotaLedger.recordDigest,
      retentionWitnessDigest: input.reservation.scratchDeletionWitness.recordDigest,
      observationRecordDigest: observation.recordDigest,
      observationReportDigest: observation.reportDigest,
    },
  });
  const verifierReport = verifyLiveAutoCompactionObservationV1(observation, receipt, context);
  if (verifierReport.status !== 'observed' || verifierReport.outcome !== input.outcome) {
    return blockedRunReport('not_observed', input.tracker, {
      route: input.route,
      policyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
      verifierReport,
    });
  }
  return buildObservedRunReport({
    outcome: input.outcome,
    route: input.route,
    verifierReport,
    observationRecordDigest: observation.recordDigest as `sha256:${string}`,
    semanticReceiptRecordDigest: receipt.recordDigest as `sha256:${string}`,
    durationBucket,
    tracker: input.tracker,
  });
}

/**
 * Default AQ-9B entrypoint. It never makes a live request unless every
 * independent diagnostic precondition is met; callers receive only a bounded
 * report and never a provider transcript or release-admission conclusion.
 */
export async function runL3LiveAutoCompactionV1(
  input: RunL3LiveAutoCompactionInputV1,
): Promise<L3LiveAutoCompactionRunReportV1> {
  return await runL3LiveAutoCompactionWithDependenciesV1(input, {});
}

/** @internal Deterministic contract seam; no package wrapper reaches it. */
export async function runL3LiveAutoCompactionWithDependenciesV1(
  input: RunL3LiveAutoCompactionInputV1,
  dependencies: RunL3LiveAutoCompactionDependenciesV1,
): Promise<L3LiveAutoCompactionRunReportV1> {
  const tracker = freshTracker();
  const policyNow = isoNow(dependencies.now);
  if (!policyNow) return blockedRunReport('policy_invalid', tracker);
  if (
    !liveAutoCompactionRunnerSourceIsBoundV1(dependencies.forceRunnerSourceDriftForTest === true)
  ) {
    return blockedRunReport('policy_invalid', tracker);
  }
  if (!input.explicitOptIn) return blockedRunReport('explicit_opt_in_required', tracker);
  if (!persistentSupervisorAvailableV1(input.ledgerRoot, Date.parse(policyNow))) {
    return blockedRunReport('governance_reservation_unavailable', tracker);
  }
  if (!l3LiveAutoCompactionPolicyIsClosedV1() || !l3LiveAutoCompactionSourceRegistryIsClosedV1()) {
    return blockedRunReport('policy_invalid', tracker);
  }
  const resolution = resolveL3LiveAutoCompactionRouteForModelBoundaryV1({
    explicitOptIn: input.explicitOptIn,
    environment: input.parentEnvironment,
    now: policyNow,
  });
  if (resolution.status === 'blocked') {
    return blockedRunReport(resolution.reasonCode, tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
  try {
    assertL3LiveAutoCompactionFixtureContentV1(materializeL3LiveAutoCompactionFixtureBytesV1());
    assertL3LiveAutoCompactionCorpusContentV1(materializeL3LiveAutoCompactionCorpusBytesV1());
  } catch {
    return blockedRunReport('policy_invalid', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
  if (!input.ledgerRoot || input.signal?.aborted) {
    markKnownZeroIfNotStartedV1(tracker);
    return blockedRunReport(
      input.ledgerRoot ? 'not_observed' : 'governance_reservation_unavailable',
      tracker,
      {
        route: resolution.route,
        policyDigest: resolution.policyDigest,
      },
    );
  }

  // The cutoff/reap allowance is computed before a reservation exists.
  const fullTimeoutMs = L3_LIVE_AUTO_COMPACTION_POLICY_V1.budget.maxRunWallClockSeconds * 1_000;
  const deadline = liveIsolatedTransportDeadlineV1(fullTimeoutMs);
  if (!deadline) {
    return blockedRunReport('policy_invalid', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }

  // Exactly one reservation covers both permitted phases. It is intentionally
  // made before the in-memory product chain so a cleanup/abort after possible
  // dispatch can still be reconciled conservatively by this owner boundary.
  const reservation = reserveLiveGovernanceQuotaV1({
    ledgerRoot: input.ledgerRoot,
    routePolicyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
    requested: requestedQuotaV1(),
  });
  if (reservation.status !== 'reserved') {
    markKnownZeroIfNotStartedV1(tracker);
    return blockedRunReport('governance_reservation_unavailable', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadlineController = new AbortController();
  const operationController = new AbortController();
  const externalAbort = () => operationController.abort();
  input.signal?.addEventListener('abort', externalAbort, { once: true });
  const timeout = setTimeout(
    () => {
      tracker.timedOut = true;
      deadlineController.abort();
      operationController.abort();
    },
    Math.max(0, deadline.cutoffAtMs - Date.now()),
  );

  let inMemory: SealedRunResultV1 = { kind: 'blocked', reasonCode: 'not_observed' };
  try {
    const transportContext: IsolatedAq9bTransportContextV1 = {
      fixture: {
        fixtureId: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureId,
        fixtureDigest: L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureDigest,
        bytes: materializeL3LiveAutoCompactionFixtureBytesV1(),
      },
      supervisorLedgerRoot: input.ledgerRoot,
      cutoffAtMs: deadline.cutoffAtMs,
      exitDeadlineAtMs: deadline.exitDeadlineAtMs,
      operationSignal: operationController.signal,
      nextTestMode: () => undefined,
      onTestDispatch: undefined,
    };
    inMemory = await runInMemoryAutoCompactionV1({
      resolution,
      signal: operationController.signal,
      externalSignal: input.signal,
      deadlineSignal: deadlineController.signal,
      transportContext,
      tracker,
      syntheticModel: undefined,
      onPermittedProductEffect: undefined,
      onCancellationNextTurnPreflight: undefined,
    });
  } catch {
    // Any product-chain failure after a possible transport entry is unknown,
    // full charge, and never creates a tail/evidence record.
    markUnknownAfterRunFailureV1(tracker);
    inMemory = { kind: 'blocked', reasonCode: 'not_observed' };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', externalAbort);
  }

  const finishedAtMs = Date.now();
  if (tracker.childExitUnconfirmed) {
    // The transport's sticky singleton retains the scratch root until it can
    // prove group reaping. Do not reconcile/release this reservation; expiry
    // is the deliberate full-charge, no-new-live-run quarantine path.
    return blockedRunReport('timeout', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
  const reconciliation = reconcileLiveGovernanceQuotaV1({
    ledgerRoot: input.ledgerRoot,
    reservationId: reservation.reservation.reservationId,
    routePolicyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
    actual: reconciledQuotaV1(inMemory.kind, tracker, startedAtMs, finishedAtMs),
  });
  if (reconciliation.status !== 'reconciled') {
    return blockedRunReport('governance_reservation_unavailable', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
  if (tracker.timedOut) {
    markUnknownAfterRunFailureV1(tracker);
    return blockedRunReport('timeout', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      verifierReport: buildLiveAutoCompactionNotObservedReportV1(
        undefined,
        'phase_dispatch_unknown',
      ),
    });
  }
  if (inMemory.kind === 'blocked') {
    const reason = inMemory.reasonCode ?? 'not_observed';
    return blockedRunReport(reason, tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      verifierReport: buildLiveAutoCompactionNotObservedReportV1(
        undefined,
        tracker.untrustedTerminal ? 'phase_dispatch_unknown' : 'not_observed',
      ),
    });
  }
  if (!evidenceEligibleRunV1(tracker, inMemory.kind)) {
    markUnknownAfterRunFailureV1(tracker);
    return blockedRunReport('not_observed', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      verifierReport: buildLiveAutoCompactionNotObservedReportV1(
        undefined,
        'phase_dispatch_unknown',
      ),
    });
  }
  try {
    // The observed timestamp is taken after ledger reconciliation so its day
    // and month exactly bind the immutable terminal ledger records.
    const observedAt = new Date().toISOString();
    return buildObservedEvidenceV1({
      outcome: inMemory.kind,
      route: resolution.route,
      reservation: reconciliation.reservation,
      startedAt,
      observedAt,
      tracker,
    });
  } catch {
    markUnknownAfterRunFailureV1(tracker);
    return blockedRunReport('not_observed', tracker, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
}

/** Test-only source binding assertion; it reads no fixture, config, or credential. */
export const L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_PATH_V1 = RUNNER_SOURCE_PATH_V1;
