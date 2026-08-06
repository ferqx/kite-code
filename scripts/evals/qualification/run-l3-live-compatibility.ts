import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  buildDiagnosticExecutionV1,
  buildLiveCompatibilityObservationV1,
  type DiagnosticRouteIdentityV1,
  type LiveCompatibilityObservationV1,
  type QualificationAttemptIdentityV1,
  type QualificationAttemptScopeV1,
} from '../contracts/qualification/evidence/live-observation-schema-v1';
import {
  buildLiveCompatibilityNotObservedReportV1,
  buildLiveCompatibilityObservationVerifierContextV1,
  type LiveCompatibilityObservationDiagnosticReportV1,
  verifyLiveCompatibilityObservationV1,
} from '../contracts/qualification/evidence/live-observation-verifier-v1';
import {
  assertLiveSuiteCorpusContentV1,
  assertLiveSuiteFixtureContentV1,
  assertLiveSuiteFixtureMatchesPolicyV1,
  assertLiveSuiteRunnerBindingV1,
  assertLiveSuiteRunnerSourceDriftV1,
  L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
  L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
  L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
  L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1,
  L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
  materializeL3LiveCompatibilityCorpusBytesV1,
  materializeL3LiveCompatibilityFixtureBytesV1,
  resolveLiveRouteForModelBoundaryV1,
} from '../contracts/qualification/live-route-resolver-v1';
import {
  LIVE_SUITE_BLOCKED_REASON_CODES_V1,
  type LiveSuiteBlockedReasonCodeV1,
} from '../contracts/qualification/live-suite-policy-v1';
import {
  type LiveGovernanceQuotaCountersV1,
  reconcileLiveGovernanceQuotaV1,
  reserveLiveGovernanceQuotaV1,
} from './live-governance-ledger-v1';
import { liveIsolatedTransportDeadlineV1 } from './live-isolated-transport-v1';
import {
  invokeSealedLiveModelWithDependenciesV1,
  type LiveModelTransportOutcomeV1,
} from './live-model-transport-v1';
import {
  hasFreshLiveScratchSupervisorHealthV1,
  liveScratchSupervisorActivationIsImplementedV1,
} from './live-scratch-supervisor-health-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOCAL_PLATFORM_IDENTITY_V1 = 'local-host';
const L3_RUNNER_ID_V1 = 'qualification-l3-live-compatibility-runner-v1';
const L3_LIVE_COMPATIBILITY_RUNNER_SOURCE_URL_V1 = new URL(
  './run-l3-live-compatibility.ts',
  import.meta.url,
);

export const L3_LIVE_COMPATIBILITY_RUN_REASON_CODES_V1 = [
  ...LIVE_SUITE_BLOCKED_REASON_CODES_V1,
  'not_observed',
  'observed_cancelled',
  'observed_success',
] as const;

export type L3LiveCompatibilityRunReasonCodeV1 =
  | LiveSuiteBlockedReasonCodeV1
  | 'not_observed'
  | 'observed_cancelled'
  | 'observed_success';

const liveCompatibilityRunReportV1Schema = z
  .object({
    schema: z.literal('L3LiveCompatibilityRunReportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    status: z.enum(['observed', 'blocked']),
    reasonCode: z.enum(L3_LIVE_COMPATIBILITY_RUN_REASON_CODES_V1),
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
    providerDispatchCount: z.union([z.literal(0), z.literal(1), z.literal('unknown')]),
  })
  .strict()
  .superRefine((value, context) => {
    const observed = value.status === 'observed';
    if (observed !== (value.outcome !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'only observed L3 reports may carry a terminal outcome',
      });
    }
    if (
      (value.outcome === 'success' && value.reasonCode !== 'observed_success') ||
      (value.outcome === 'cancelled' && value.reasonCode !== 'observed_cancelled')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'observed outcome must be projected from the verifier below',
      });
    }
    if (value.status === 'blocked' && value.outcome !== undefined) {
      context.addIssue({ code: 'custom', message: 'blocked report cannot carry an outcome' });
    }
  });

/**
 * This public shape is deliberately smaller than an observation record. It is
 * safe to print from the `*.live.ts` wrapper: no credential, endpoint,
 * prompt, response, reasoning, workspace, fixture bytes, filesystem path, or
 * raw error has an output position.
 */
export type L3LiveCompatibilityRunReportV1 = z.infer<typeof liveCompatibilityRunReportV1Schema>;

export interface RunL3LiveCompatibilityInputV1 {
  readonly explicitOptIn: boolean;
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  /** Explicit owner-only ledger root; no HOME/config fallback exists. */
  readonly ledgerRoot: string | undefined;
  /** AQ-9B may use this to exercise a controlled cancellation. */
  readonly signal?: AbortSignal;
}

type L3ProviderDispatchCountV1 = 0 | 1 | 'unknown';
type LiveTransportTerminalTrustV1 = 'known' | 'unknown';
interface RunL3LiveCompatibilityDependenciesV1 {
  /** Test-only timestamp seam; it is not reachable from the public runner input. */
  readonly now?: () => Date;
  /** Test-only fixed-byte drift fault; it never accepts a caller source path. */
  readonly forceRunnerSourceDriftForTest?: true;
}

/** Fixed-path accidental-drift check; this is not an anti-tamper root of trust. */
function liveCompatibilityRunnerSourceIsBoundV1(forceDriftForTest: boolean): boolean {
  try {
    const source = new Uint8Array(
      readFileSync(fileURLToPath(L3_LIVE_COMPATIBILITY_RUNNER_SOURCE_URL_V1)),
    );
    const sourceBytes = forceDriftForTest
      ? (() => {
          const mutated = new Uint8Array(source.byteLength + 1);
          mutated.set(source);
          mutated[mutated.byteLength - 1] = 0;
          return mutated;
        })()
      : source;
    assertLiveSuiteRunnerSourceDriftV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      runnerId: L3_RUNNER_ID_V1,
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

function asIsoNow(clock: (() => Date) | undefined): string | undefined {
  try {
    const now = clock?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) return undefined;
    return now.toISOString();
  } catch {
    return undefined;
  }
}

function routeProjection(
  route: DiagnosticRouteIdentityV1 | undefined,
  policyDigest: string | undefined,
): Pick<L3LiveCompatibilityRunReportV1, 'routeAlias' | 'model' | 'policyDigest'> {
  return {
    ...(route ? { routeAlias: route.routeAlias, model: route.model } : {}),
    ...(policyDigest ? { policyDigest } : {}),
  };
}

function blockedRunReport(
  reasonCode: L3LiveCompatibilityRunReasonCodeV1,
  options: {
    route?: DiagnosticRouteIdentityV1;
    policyDigest?: string;
    verifierReport?: LiveCompatibilityObservationDiagnosticReportV1;
    providerDispatchCount?: L3ProviderDispatchCountV1;
  } = {},
): L3LiveCompatibilityRunReportV1 {
  const verifierReport = options.verifierReport ?? buildLiveCompatibilityNotObservedReportV1();
  return liveCompatibilityRunReportV1Schema.parse({
    schema: 'L3LiveCompatibilityRunReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    status: 'blocked',
    reasonCode,
    ...routeProjection(options.route, options.policyDigest),
    verifierReportDigest: verifierReport.reportDigest,
    providerDispatchCount: options.providerDispatchCount ?? 0,
  });
}

function identityForLiveObservation(): QualificationAttemptIdentityV1 {
  return {
    matrixDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.matrixDigest,
    suiteDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.suiteDigest,
    oracleDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.oracleDigest,
    corpusDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.corpusDigest,
    evaluatorDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.evaluatorDigest,
    verifierDigest: L3_LIVE_COMPATIBILITY_SOURCE_OWNED_IDENTITY_V1.verifierDigest,
    runnerDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest,
  };
}

function scopeForLiveObservation(route: DiagnosticRouteIdentityV1): QualificationAttemptScopeV1 {
  return {
    platformIdentity: LOCAL_PLATFORM_IDENTITY_V1,
    releaseProfileDigest: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
    entrypoint: 'runtime',
    testPolicyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
    routePolicyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
    route,
  };
}

function requestedQuota(): LiveGovernanceQuotaCountersV1 {
  return {
    attempts: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxAttemptsPerInvocation,
    tokens: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxTotalTokens,
    runWallClockSeconds: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxRunWallClockSeconds,
    costUsdMicros: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxCostUsdMicros,
  };
}

function conservativeActualQuota(
  transport: LiveModelTransportOutcomeV1,
  terminalTrust: LiveTransportTerminalTrustV1,
  startedAtMs: number,
  finishedAtMs: number,
): LiveGovernanceQuotaCountersV1 {
  if (terminalTrust === 'unknown') return requestedQuota();
  if (transport.providerDispatchCount === 0) {
    return { attempts: 0, tokens: 0, runWallClockSeconds: 0, costUsdMicros: 0 };
  }
  if (transport.outcome === 'not_observed') return requestedQuota();
  const elapsedSeconds = Math.max(1, Math.ceil((finishedAtMs - startedAtMs) / 1_000));
  return {
    attempts: 1,
    tokens: transport.usage.totalTokens ?? requestedQuota().tokens,
    runWallClockSeconds: elapsedSeconds,
    // No provider bill is trusted as a local runtime input. A dispatch is
    // charged at the pre-reserved maximum instead of inventing a lower cost.
    costUsdMicros: requestedQuota().costUsdMicros,
  };
}

function unknownTransportOutcome(): LiveModelTransportOutcomeV1 {
  return {
    outcome: 'not_observed',
    // This internal placeholder never means a known zero-dispatch outcome.
    // The external report projects it as `unknown` instead of a false zero.
    providerDispatchCount: 1,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  };
}

function reportDispatchCount(
  terminalTrust: LiveTransportTerminalTrustV1,
  transport: LiveModelTransportOutcomeV1,
): L3ProviderDispatchCountV1 {
  return terminalTrust === 'unknown' ? 'unknown' : transport.providerDispatchCount;
}

function reportFromVerifiedObservation(
  observation: LiveCompatibilityObservationV1,
  verifierReport: LiveCompatibilityObservationDiagnosticReportV1,
  route: DiagnosticRouteIdentityV1,
  providerDispatchCount: 0 | 1,
): L3LiveCompatibilityRunReportV1 {
  if (verifierReport.status !== 'observed' || verifierReport.outcome !== observation.outcome) {
    return blockedRunReport('not_observed', {
      route,
      policyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
      verifierReport,
      providerDispatchCount,
    });
  }
  return liveCompatibilityRunReportV1Schema.parse({
    schema: 'L3LiveCompatibilityRunReportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    status: 'observed',
    // The compact external run report intentionally has no release status.
    reasonCode: observation.outcome === 'success' ? 'observed_success' : 'observed_cancelled',
    outcome: observation.outcome,
    ...routeProjection(route, L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest),
    verifierReportDigest: verifierReport.reportDigest,
    observationRecordDigest: observation.recordDigest,
    providerDispatchCount,
  });
}

/**
 * Run exactly one AQ-8 diagnostic compatibility observation.
 *
 * No default path invokes the network: route opt-in, metadata-only policy,
 * sealed input integrity, an explicit owner-only governance reservation, and
 * zero-child environment must all succeed first. Any failure returns a
 * canonical blocked report and never reveals the underlying exception.
 */
export async function runL3LiveCompatibilityV1(
  input: RunL3LiveCompatibilityInputV1,
): Promise<L3LiveCompatibilityRunReportV1> {
  return runL3LiveCompatibilityWithDependenciesV1(input, {});
}

/** @internal Deterministic seam for contract tests; not called by live CLI. */
export async function runL3LiveCompatibilityWithDependenciesV1(
  input: RunL3LiveCompatibilityInputV1,
  dependencies: RunL3LiveCompatibilityDependenciesV1,
): Promise<L3LiveCompatibilityRunReportV1> {
  const now = asIsoNow(dependencies.now);
  if (!now) return blockedRunReport('policy_invalid');
  if (
    !liveCompatibilityRunnerSourceIsBoundV1(dependencies.forceRunnerSourceDriftForTest === true)
  ) {
    return blockedRunReport('policy_invalid');
  }
  if (!input.explicitOptIn) return blockedRunReport('explicit_opt_in_required');
  if (!persistentSupervisorAvailableV1(input.ledgerRoot, Date.parse(now))) {
    return blockedRunReport('governance_reservation_unavailable');
  }

  const resolution = resolveLiveRouteForModelBoundaryV1({
    explicitOptIn: input.explicitOptIn,
    routeId: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.routeId,
    policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
    environment: input.parentEnvironment,
    now,
  });
  if (resolution.status === 'blocked') {
    return blockedRunReport(resolution.reasonCode, {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }

  try {
    const fixtureBytes = materializeL3LiveCompatibilityFixtureBytesV1();
    const corpusBytes = materializeL3LiveCompatibilityCorpusBytesV1();
    assertLiveSuiteFixtureMatchesPolicyV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
    });
    assertLiveSuiteFixtureContentV1({
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      content: fixtureBytes,
    });
    assertLiveSuiteCorpusContentV1({
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      content: corpusBytes,
    });
    assertLiveSuiteRunnerBindingV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      runnerId: L3_RUNNER_ID_V1,
      runnerDigest: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerDigest as `sha256:${string}`,
    });
  } catch {
    return blockedRunReport('policy_invalid', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }

  if (!input.ledgerRoot) {
    return blockedRunReport('governance_reservation_unavailable', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
  const reservation = reserveLiveGovernanceQuotaV1({
    ledgerRoot: input.ledgerRoot,
    routePolicyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
    requested: requestedQuota(),
  });
  if (reservation.status !== 'reserved') {
    return blockedRunReport('governance_reservation_unavailable', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }

  const startedAtMs = Date.now();
  const fullTimeoutMs = L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxRunWallClockSeconds * 1_000;
  const deadline = liveIsolatedTransportDeadlineV1(fullTimeoutMs, startedAtMs);
  if (!deadline) {
    return blockedRunReport('policy_invalid', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
    });
  }
  let timedOut = false;
  let exitUnconfirmed = false;
  let transport = unknownTransportOutcome();
  let terminalTrust: LiveTransportTerminalTrustV1 = 'unknown';
  try {
    const corpus = new TextDecoder().decode(materializeL3LiveCompatibilityCorpusBytesV1());
    const detailed = await invokeSealedLiveModelWithDependenciesV1({
      modelBoundary: resolution.modelBoundary,
      prompt: corpus,
      maxInputTokens: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxInputTokens,
      maxOutputTokens: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.budget.maxOutputTokens,
      timeoutMs: fullTimeoutMs,
      signal: input.signal,
      fixture: {
        fixtureId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureId,
        fixtureDigest:
          L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureDigest as `sha256:${string}`,
        bytes: materializeL3LiveCompatibilityFixtureBytesV1(),
      },
      cutoffAtMs: deadline.cutoffAtMs,
      exitDeadlineAtMs: deadline.exitDeadlineAtMs,
      supervisorLedgerRoot: input.ledgerRoot,
    });
    transport = {
      outcome: detailed.outcome,
      providerDispatchCount: detailed.providerDispatchCount,
      usage: detailed.usage,
    };
    timedOut =
      detailed.terminal.status === 'deadline_exceeded' ||
      detailed.terminal.status === 'child_exit_unconfirmed';
    exitUnconfirmed = detailed.terminal.status === 'child_exit_unconfirmed';
    terminalTrust =
      detailed.terminal.status === 'result' ||
      detailed.terminal.status === 'cancelled_before_dispatch'
        ? 'known'
        : 'unknown';
  } catch {
    // Every post-reservation exception is an unknown dispatch state. Never
    // convert it into zero usage or a terminal compatibility observation.
  }

  const finishedAtMs = Date.now();
  // The diagnostic timestamp seam never reaches ledger reservation timing;
  // ledger buckets, lease deadlines, and wall-clock charging stay ledger-owned.
  const endedAt = asIsoNow(dependencies.now) ?? now;
  if (exitUnconfirmed) {
    // Keep the reservation active: it is both a full-charge expiry record and
    // a concurrency quarantine until the child process is actually reaped.
    return blockedRunReport('timeout', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      providerDispatchCount: 'unknown',
    });
  }
  const reconciliation = reconcileLiveGovernanceQuotaV1({
    ledgerRoot: input.ledgerRoot,
    reservationId: reservation.reservation.reservationId,
    routePolicyDigest: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1.policyDigest,
    actual: conservativeActualQuota(transport, terminalTrust, startedAtMs, finishedAtMs),
  });
  if (reconciliation.status !== 'reconciled') {
    return blockedRunReport('governance_reservation_unavailable', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      providerDispatchCount: reportDispatchCount(terminalTrust, transport),
    });
  }
  if (timedOut) {
    return blockedRunReport('timeout', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      providerDispatchCount: reportDispatchCount(terminalTrust, transport),
    });
  }
  if (
    terminalTrust !== 'known' ||
    transport.providerDispatchCount !== 1 ||
    transport.outcome === 'not_observed'
  ) {
    return blockedRunReport('not_observed', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      providerDispatchCount: reportDispatchCount(terminalTrust, transport),
    });
  }

  try {
    const scope = scopeForLiveObservation(resolution.route);
    const governance = {
      retentionClass: 'ephemeral_local' as const,
      profileId: reconciliation.reservation.profileId,
      profileDigest: reconciliation.reservation.profileDigest,
      quotaLedgerDigests: {
        day: reconciliation.reservation.dayQuotaLedger.recordDigest,
        month: reconciliation.reservation.monthQuotaLedger.recordDigest,
      },
      storageDeletionWitnessDigest: reconciliation.reservation.scratchDeletionWitness.recordDigest,
    };
    const execution = buildDiagnosticExecutionV1({
      executionId: `l3-live-execution-${reservation.reservation.reservationId}`,
      platformIdentity: LOCAL_PLATFORM_IDENTITY_V1,
      identity: {
        source: 'local_synthetic',
        fixtureId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.fixtureId,
        runner: L3_RUNNER_ID_V1,
        commit: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.artifacts[0]!.artifact.commit,
        startedAt: now,
        endedAt,
      },
    });
    const observation = buildLiveCompatibilityObservationV1({
      schema: 'LiveCompatibilityObservationV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      observedAt: endedAt,
      candidate: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
      governance,
      execution,
      scope,
      identity: identityForLiveObservation(),
      outcome: transport.outcome,
    });
    const context = buildLiveCompatibilityObservationVerifierContextV1({
      schema: 'LiveCompatibilityObservationVerifierContextV1',
      version: 1,
      candidate: L3_LIVE_COMPATIBILITY_DIAGNOSTIC_CANDIDATE_CLOSURE_V1,
      governance,
      execution,
      scope,
      identity: identityForLiveObservation(),
      governanceWitnesses: {
        dayQuotaLedger: reconciliation.reservation.dayQuotaLedger,
        monthQuotaLedger: reconciliation.reservation.monthQuotaLedger,
        retention: reconciliation.reservation.scratchDeletionWitness,
      },
    });
    const verifierReport = verifyLiveCompatibilityObservationV1(
      observation,
      context,
      new Date(endedAt),
    );
    return reportFromVerifiedObservation(
      observation,
      verifierReport,
      resolution.route,
      transport.providerDispatchCount,
    );
  } catch {
    return blockedRunReport('not_observed', {
      route: resolution.route,
      policyDigest: resolution.policyDigest,
      providerDispatchCount: transport.providerDispatchCount,
    });
  }
}
