import { createHash } from 'node:crypto';

export const RUNTIME_FAULT_SOAK_REPORT_VERSION = 2 as const;
export const RUNTIME_FAULT_SOAK_RUNNER_REVISION = 'runtime-fault-soak-v2' as const;
export const MINIMUM_QUALIFICATION_ITERATIONS = 8;
export const MINIMUM_POST_WARMUP_LIFECYCLES = 8;
export const RUNTIME_FAULT_SOAK_GROWTH_LIMITS = Object.freeze({
  rssBytes: 32 * 1024 * 1024,
  activeResources: 2,
  fileDescriptors: 2,
  listeners: 2,
  handles: 2,
});

export const RUNTIME_FAULT_SOAK_CASE_IDS = [
  'long_runtime_replay',
  'subagent_cancel_recovery',
  'model_transient_stream',
  'mcp_churn',
  'runtime_sigkill_recovery',
  'storage_and_logger_faults',
  'tui_lifecycle_churn',
] as const;

export const RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS: Readonly<
  Record<RuntimeFaultSoakCaseId, readonly string[]>
> = Object.freeze({
  long_runtime_replay: [
    'fault-soak-long-runtime-lifecycle.test.ts',
    'fault-soak-runtime-budget.test.ts',
  ],
  subagent_cancel_recovery: ['cancel-resume.test.ts'],
  model_transient_stream: ['agent-deadline.test.ts'],
  mcp_churn: ['mcp-supervisor.test.ts'],
  runtime_sigkill_recovery: ['fault-injection.test.ts'],
  storage_and_logger_faults: ['fault-injection.test.ts'],
  tui_lifecycle_churn: ['tui-input-focus-lifecycle'],
});

export type RuntimeFaultSoakCaseId = (typeof RUNTIME_FAULT_SOAK_CASE_IDS)[number];
export type RuntimeFaultSoakProfile = 'ci' | 'qualification';
export type RuntimeFaultSoakStatus = 'passed' | 'failed' | 'inconclusive';

export type RuntimeFaultSoakSourceV2 =
  | {
      kind: 'local';
    }
  | {
      kind: 'github_actions';
      repository: string;
      headSha: string;
      ref: string;
      workflow: string;
      workflowRef: string;
      workflowSha: string;
      runId: string;
      runAttempt: number;
    };

export const RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS: Readonly<
  Record<RuntimeFaultSoakCaseId, readonly string[]>
> = Object.freeze({
  long_runtime_replay: ['completed'],
  subagent_cancel_recovery: ['cancelled', 'reconciliation_required'],
  model_transient_stream: ['model_retry_exhausted', 'deadline_exceeded'],
  mcp_churn: ['mcp_unavailable', 'reconciliation_required'],
  runtime_sigkill_recovery: ['reconciliation_required'],
  storage_and_logger_faults: ['persistence_unavailable', 'completed'],
  tui_lifecycle_churn: ['completed', 'cancelled'],
});

export interface SupportedMetric<T> {
  supported: true;
  value: T;
}

export interface UnsupportedMetric {
  supported: false;
  reason: string;
}

export type OptionalMetric<T> = SupportedMetric<T> | UnsupportedMetric;

export interface RuntimeFaultSoakLifecyclePointV2 {
  sequence: number;
  before: number;
  after: number;
  durationMs: number;
  deadlineMs: number;
  cleanupConfirmed: boolean;
}

export type RuntimeFaultSoakMetricEvidenceV2 =
  | {
      kind: 'fresh_process_diagnostic';
      before: number;
      after: number;
    }
  | {
      kind: 'same_process_lifecycle';
      series: ReadonlyArray<{
        process: {
          pid: number;
          startNonce: string;
          osProcessStartIdentity: string;
          lifecycleId: string;
          lifecycleGroupNonce: string;
        };
        warmup: RuntimeFaultSoakLifecyclePointV2;
        lifecycles: readonly RuntimeFaultSoakLifecyclePointV2[];
      }>;
    };

export type RuntimeFaultSoakMetricSummary =
  | {
      supported: true;
      samples: number;
      minBefore: number;
      maxAfter: number;
      maxGrowth: number;
      growthLimit: number;
      qualificationEligible: boolean;
      sustainedPositiveSlope: boolean;
    }
  | {
      supported: false;
      reasons: readonly string[];
    };

export interface RuntimeBudgetUsageEvidenceV2 {
  source: 'actual_runtime_ledger';
  provenance?: {
    caseId: RuntimeFaultSoakCaseId;
    iteration: number;
    lifecycleId: string;
    pid: number;
    sequence: number;
    processStartNonce: string;
    osProcessStartIdentity: string;
    lifecycleGroupNonce: string;
  };
  reconciled: {
    counters: Readonly<Record<string, number>>;
    gauges: Readonly<Record<string, number>>;
  };
  committed: {
    counters: Readonly<Record<string, number>>;
    gauges: Readonly<Record<string, number>>;
  };
  ceilings: Readonly<Record<string, number>>;
  reservationStates: Readonly<Record<string, number>>;
}

export type RuntimeBudgetUsageSummary =
  | {
      supported: true;
      samples: number;
      maxReconciledCounters: Readonly<Record<string, number>>;
      maxReconciledGauges: Readonly<Record<string, number>>;
      maxCommittedCounters: Readonly<Record<string, number>>;
      maxCommittedGauges: Readonly<Record<string, number>>;
      ceilings: Readonly<Record<string, number>>;
      reservationStates: Readonly<Record<string, number>>;
    }
  | UnsupportedMetric;

export interface RuntimeFaultSoakAttemptV2 {
  caseId: RuntimeFaultSoakCaseId;
  iteration: number;
  status: 'passed' | 'failed' | 'timed_out';
  durationMs: number;
  failureCode?: string;
  /** Passing probe assertions that explicitly checked a case state invariant. */
  stateInvariantAssertions: number;
  /** Passing probe invocations that asserted each terminal taxonomy outcome. */
  terminalTaxonomyAssertions: Readonly<Record<string, number>>;
  /** Actual reconciled/committed ResourceBudgetV1 ledger receipts, when this probe runs Runtime. */
  runtimeBudgetUsage: OptionalMetric<readonly RuntimeBudgetUsageEvidenceV2[]>;
  cleanup: {
    confirmed: boolean;
    orphanPids: OptionalMetric<readonly number[]>;
    orphanWorktrees: OptionalMetric<readonly string[]>;
    residualPaths: readonly string[];
  };
  resources: {
    rssBytes: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>;
    activeResources: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>;
    fileDescriptors: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>;
    listeners: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>;
    handles: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>;
  };
}

export interface RuntimeFaultSoakReportV2 {
  version: typeof RUNTIME_FAULT_SOAK_REPORT_VERSION;
  runnerRevision: string;
  seed: number;
  profile: RuntimeFaultSoakProfile;
  config: {
    iterations: number;
    perCaseTimeoutMs: number;
    maxProbeInvocations: number;
    maxWallTimeMs: number;
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    bunVersion: string;
  };
  source: RuntimeFaultSoakSourceV2;
  startedAt: string;
  finishedAt: string;
  status: RuntimeFaultSoakStatus;
  failureCodes: readonly string[];
  attempts: readonly RuntimeFaultSoakAttemptV2[];
  cases: ReadonlyArray<{
    id: RuntimeFaultSoakCaseId;
    attempts: number;
    passed: number;
    failed: number;
    latencyMs: {
      count: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
    };
    /** Coverage count, not observed production incident frequency. */
    terminalTaxonomyAssertions: Readonly<Record<string, number>>;
    stateInvariantAssertions: number;
    runtimeBudgetUsage: RuntimeBudgetUsageSummary;
    resources: {
      rssBytes: RuntimeFaultSoakMetricSummary;
      activeResources: RuntimeFaultSoakMetricSummary;
      fileDescriptors: RuntimeFaultSoakMetricSummary;
      listeners: RuntimeFaultSoakMetricSummary;
      handles: RuntimeFaultSoakMetricSummary;
    };
    cleanup: {
      confirmedAttempts: number;
      orphanPidCount: OptionalMetric<number>;
      orphanWorktreeCount: OptionalMetric<number>;
      residualPathCount: number;
    };
  }>;
  aggregate: {
    attempts: number;
    passed: number;
    failed: number;
    runnerBudgetUsage: {
      probeInvocations: number;
      maxProbeInvocations: number;
      wallTimeMs: number;
      maxWallTimeMs: number;
    };
    runtimeBudgetUsage: RuntimeBudgetUsageSummary;
    qualificationMetricsSupported: boolean;
  };
  reportDigest: string;
}

export interface BuildRuntimeFaultSoakReportInput {
  runnerRevision: string;
  seed: number;
  profile: RuntimeFaultSoakProfile;
  iterations: number;
  perCaseTimeoutMs: number;
  startedAt: string;
  finishedAt: string;
  environment: RuntimeFaultSoakReportV2['environment'];
  source?: RuntimeFaultSoakSourceV2;
  attempts: readonly RuntimeFaultSoakAttemptV2[];
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error(`Percentile must be in (0, 1], received ${percentile}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

export function canonicalRuntimeFaultSoakJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRuntimeFaultSoakJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalRuntimeFaultSoakJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeRuntimeFaultSoakReportDigest(
  report: Omit<RuntimeFaultSoakReportV2, 'reportDigest'>,
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalRuntimeFaultSoakJson(report))
    .digest('hex')}`;
}

function isValidGithubActionsSource(source: RuntimeFaultSoakSourceV2): boolean {
  return (
    source.kind === 'github_actions' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) &&
    /^[0-9a-f]{40}$/.test(source.headSha) &&
    source.ref.startsWith('refs/') &&
    source.workflow.length > 0 &&
    source.workflowRef.includes('/.github/workflows/') &&
    source.workflowRef.includes('@refs/') &&
    /^[0-9a-f]{40}$/.test(source.workflowSha) &&
    /^[1-9][0-9]*$/.test(source.runId) &&
    Number.isInteger(source.runAttempt) &&
    source.runAttempt > 0
  );
}

function isEligibleLifecycleMetric(
  metric: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>,
): boolean {
  if (!metric.supported || metric.value.kind !== 'same_process_lifecycle') return false;
  if (metric.value.series.length === 0) return false;
  return metric.value.series.every(
    ({ process, warmup, lifecycles }) =>
      Number.isInteger(process.pid) &&
      process.pid > 0 &&
      process.startNonce.length > 0 &&
      process.osProcessStartIdentity.length > 0 &&
      process.lifecycleId.length > 0 &&
      process.lifecycleGroupNonce.length > 0 &&
      lifecycles.length === MINIMUM_POST_WARMUP_LIFECYCLES &&
      warmup.sequence === 0 &&
      Number.isFinite(warmup.before) &&
      Number.isFinite(warmup.after) &&
      warmup.durationMs >= 0 &&
      warmup.deadlineMs > 0 &&
      warmup.durationMs <= warmup.deadlineMs &&
      warmup.cleanupConfirmed &&
      lifecycles.every(
        (point, index) =>
          point.sequence === index + 1 &&
          Number.isFinite(point.before) &&
          Number.isFinite(point.after) &&
          point.durationMs >= 0 &&
          point.deadlineMs > 0 &&
          point.durationMs <= point.deadlineMs &&
          point.cleanupConfirmed,
      ),
  );
}

function qualificationMetricsSupported(attempt: RuntimeFaultSoakAttemptV2): boolean {
  return (
    attempt.cleanup.orphanPids.supported &&
    attempt.cleanup.orphanWorktrees.supported &&
    (attempt.caseId !== 'long_runtime_replay' || hasCompleteRuntimeBudgetProvenance(attempt)) &&
    hasExpectedResourceProvenance(attempt)
  );
}

function resourceSeriesSignature(
  metric: OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>,
): string[] | undefined {
  if (!metric.supported || metric.value.kind !== 'same_process_lifecycle') return undefined;
  return metric.value.series
    .map(({ process }) =>
      JSON.stringify([
        process.lifecycleId,
        process.pid,
        process.startNonce,
        process.osProcessStartIdentity,
        process.lifecycleGroupNonce,
      ]),
    )
    .sort();
}

function hasExpectedResourceProvenance(attempt: RuntimeFaultSoakAttemptV2): boolean {
  const metrics = Object.values(attempt.resources);
  const signatures = metrics.map(resourceSeriesSignature);
  if (signatures.some((value) => value === undefined)) return false;
  const expectedLifecycleIds = [
    ...RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS[attempt.caseId],
  ].sort();
  const first = metrics[0];
  if (!first || !isEligibleLifecycleMetric(first) || !first.supported) return false;
  const lifecycleIds =
    first.value.kind === 'same_process_lifecycle'
      ? first.value.series.map(({ process }) => process.lifecycleId).sort()
      : [];
  if (
    lifecycleIds.length !== expectedLifecycleIds.length ||
    lifecycleIds.some((lifecycleId, index) => lifecycleId !== expectedLifecycleIds[index])
  ) {
    return false;
  }
  const reference = JSON.stringify(signatures[0]);
  return (
    signatures.every((signature) => JSON.stringify(signature) === reference) &&
    metrics.every(isEligibleLifecycleMetric)
  );
}

function isFiniteNumberRecord(value: Readonly<Record<string, number>>): boolean {
  return Object.values(value).every((amount) => Number.isFinite(amount) && amount >= 0);
}

function hasCompleteRuntimeBudgetProvenance(attempt: RuntimeFaultSoakAttemptV2): boolean {
  if (!attempt.runtimeBudgetUsage.supported || attempt.runtimeBudgetUsage.value.length !== 9) {
    return false;
  }
  const receipts = attempt.runtimeBudgetUsage.value;
  const provenances = receipts.map((receipt) => receipt.provenance);
  if (
    receipts.some(
      (receipt) =>
        receipt.source !== 'actual_runtime_ledger' ||
        receipt.provenance?.caseId !== 'long_runtime_replay' ||
        receipt.provenance.iteration !== attempt.iteration ||
        receipt.provenance.lifecycleId !== 'fault-soak-runtime-budget.test.ts' ||
        !Number.isInteger(receipt.provenance.pid) ||
        receipt.provenance.pid <= 0 ||
        !receipt.provenance.processStartNonce ||
        !receipt.provenance.osProcessStartIdentity ||
        !receipt.provenance.lifecycleGroupNonce ||
        !isFiniteNumberRecord(receipt.reconciled.counters) ||
        !isFiniteNumberRecord(receipt.reconciled.gauges) ||
        !isFiniteNumberRecord(receipt.committed.counters) ||
        !isFiniteNumberRecord(receipt.committed.gauges) ||
        !isFiniteNumberRecord(receipt.ceilings) ||
        !isFiniteNumberRecord(receipt.reservationStates) ||
        (receipt.reconciled.counters.modelRequests ?? 0) <= 0 ||
        (receipt.committed.counters.modelRequests ?? 0) <= 0 ||
        (receipt.ceilings.maxTurns ?? 0) <= 0 ||
        (receipt.ceilings.maxModelRequests ?? 0) <= 0 ||
        Object.keys(receipt.reservationStates).length === 0,
    )
  ) {
    return false;
  }
  const identities = new Set(
    provenances.map((provenance) =>
      JSON.stringify([
        provenance!.pid,
        provenance!.processStartNonce,
        provenance!.osProcessStartIdentity,
        provenance!.lifecycleGroupNonce,
      ]),
    ),
  );
  const sequences = provenances
    .map((provenance) => provenance!.sequence)
    .sort((left, right) => left - right);
  const rss = attempt.resources.rssBytes;
  const budgetSeries =
    rss.supported && rss.value.kind === 'same_process_lifecycle'
      ? rss.value.series.find(
          ({ process }) => process.lifecycleId === 'fault-soak-runtime-budget.test.ts',
        )
      : undefined;
  const boundToResource = provenances.every(
    (provenance) =>
      budgetSeries &&
      provenance!.pid === budgetSeries.process.pid &&
      provenance!.processStartNonce === budgetSeries.process.startNonce &&
      provenance!.osProcessStartIdentity === budgetSeries.process.osProcessStartIdentity &&
      provenance!.lifecycleGroupNonce === budgetSeries.process.lifecycleGroupNonce,
  );
  return (
    identities.size === 1 &&
    sequences.every((sequence, index) => sequence === index + 1) &&
    boundToResource
  );
}

function maxFields(
  values: readonly Readonly<Record<string, number>>[],
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values) {
    for (const [key, amount] of Object.entries(value)) {
      result[key] = Math.max(result[key] ?? 0, amount);
    }
  }
  return result;
}

function sumFields(
  values: readonly Readonly<Record<string, number>>[],
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values) {
    for (const [key, amount] of Object.entries(value)) {
      result[key] = (result[key] ?? 0) + amount;
    }
  }
  return result;
}

function summarizeRuntimeBudgetUsage(
  metrics: readonly OptionalMetric<readonly RuntimeBudgetUsageEvidenceV2[]>[],
): RuntimeBudgetUsageSummary {
  const samples = metrics.flatMap((metric) => (metric.supported ? metric.value : []));
  if (samples.length === 0) {
    const reasons = metrics.flatMap((metric) => (metric.supported ? [] : [metric.reason]));
    return {
      supported: false,
      reason: [...new Set(reasons)].join('; ') || 'no actual Runtime budget ledger receipt',
    };
  }
  return {
    supported: true,
    samples: samples.length,
    maxReconciledCounters: maxFields(samples.map((sample) => sample.reconciled.counters)),
    maxReconciledGauges: maxFields(samples.map((sample) => sample.reconciled.gauges)),
    maxCommittedCounters: maxFields(samples.map((sample) => sample.committed.counters)),
    maxCommittedGauges: maxFields(samples.map((sample) => sample.committed.gauges)),
    ceilings: maxFields(samples.map((sample) => sample.ceilings)),
    reservationStates: sumFields(samples.map((sample) => sample.reservationStates)),
  };
}

function summarizeMetric(
  attempts: readonly RuntimeFaultSoakAttemptV2[],
  select: (attempt: RuntimeFaultSoakAttemptV2) => OptionalMetric<RuntimeFaultSoakMetricEvidenceV2>,
  growthLimit: number,
): RuntimeFaultSoakMetricSummary {
  const metrics = attempts.map(select);
  const unsupportedReasons = metrics.flatMap((metric) => (metric.supported ? [] : [metric.reason]));
  if (unsupportedReasons.length > 0 || metrics.length === 0) {
    return {
      supported: false,
      reasons: [...new Set(unsupportedReasons.length > 0 ? unsupportedReasons : ['no samples'])],
    };
  }
  const values = metrics.flatMap((metric) => {
    if (!metric.supported) return [];
    return metric.value.kind === 'fresh_process_diagnostic'
      ? [{ before: metric.value.before, after: metric.value.after }]
      : metric.value.series.flatMap((series) =>
          series.lifecycles.map((point) => ({ before: point.before, after: point.after })),
        );
  });
  const qualificationEligible = metrics.every(isEligibleLifecycleMetric);
  return {
    supported: true,
    samples: values.length,
    minBefore: Math.min(...values.map((value) => value.before)),
    maxAfter: Math.max(...values.map((value) => value.after)),
    maxGrowth: Math.max(...values.map((value) => value.after - value.before)),
    growthLimit,
    qualificationEligible,
    sustainedPositiveSlope:
      qualificationEligible &&
      metrics.some(
        (metric) =>
          metric.supported &&
          metric.value.kind === 'same_process_lifecycle' &&
          metric.value.series.some((series) =>
            hasSustainedPositiveSlope(
              series.lifecycles.map((point) => point.after),
              growthLimit,
              MINIMUM_POST_WARMUP_LIFECYCLES,
            ),
          ),
      ),
  };
}

export function hasSustainedPositiveSlope(
  values: readonly number[],
  minimumGrowth: number,
  windowSize = MINIMUM_QUALIFICATION_ITERATIONS,
): boolean {
  if (values.length < windowSize) return false;
  const tail = values.slice(-windowSize);
  const positiveSteps = tail.slice(1).filter((value, index) => value > tail[index]!).length;
  return positiveSteps >= tail.length - 2 && tail.at(-1)! - tail[0]! > minimumGrowth;
}

export function buildRuntimeFaultSoakReport(
  input: BuildRuntimeFaultSoakReportInput,
): RuntimeFaultSoakReportV2 {
  if (!Number.isInteger(input.iterations) || input.iterations <= 0) {
    throw new Error('iterations must be a positive integer');
  }
  if (!Number.isInteger(input.perCaseTimeoutMs) || input.perCaseTimeoutMs <= 0) {
    throw new Error('perCaseTimeoutMs must be a positive integer');
  }

  const source = input.source ?? { kind: 'local' as const };
  const expectedAttempts = input.iterations * RUNTIME_FAULT_SOAK_CASE_IDS.length;
  const failureCodes = new Set<string>();
  const grouped = new Map<RuntimeFaultSoakCaseId, RuntimeFaultSoakAttemptV2[]>();
  for (const id of RUNTIME_FAULT_SOAK_CASE_IDS) grouped.set(id, []);
  for (const attempt of input.attempts) {
    grouped.get(attempt.caseId)?.push(attempt);
    if (attempt.status !== 'passed') failureCodes.add(attempt.failureCode ?? attempt.status);
    if (attempt.stateInvariantAssertions <= 0) {
      failureCodes.add(`${attempt.caseId}:state_invariant`);
    }
    if (!attempt.cleanup.confirmed) failureCodes.add(`${attempt.caseId}:cleanup_unconfirmed`);
    if (
      attempt.cleanup.orphanWorktrees.supported &&
      attempt.cleanup.orphanWorktrees.value.length > 0
    ) {
      failureCodes.add(`${attempt.caseId}:orphan_worktree`);
    }
    if (attempt.cleanup.residualPaths.length > 0) {
      failureCodes.add(`${attempt.caseId}:residual_path`);
    }
    for (const required of RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS[attempt.caseId]) {
      if ((attempt.terminalTaxonomyAssertions[required] ?? 0) <= 0) {
        failureCodes.add(`${attempt.caseId}:terminal_assertion_missing:${required}`);
      }
    }
  }
  if (input.attempts.length !== expectedAttempts) failureCodes.add('case_coverage_incomplete');
  for (const [id, attempts] of grouped) {
    if (attempts.length !== input.iterations) failureCodes.add(`${id}:attempt_count`);
    const iterations = new Set(attempts.map((attempt) => attempt.iteration));
    if (iterations.size !== attempts.length) failureCodes.add(`${id}:duplicate_iteration`);
    if (
      Array.from({ length: input.iterations }, (_, index) => index + 1).some(
        (iteration) => !iterations.has(iteration),
      ) ||
      [...iterations].some((iteration) => iteration < 1 || iteration > input.iterations)
    ) {
      failureCodes.add(`${id}:iteration_coverage`);
    }
  }

  const cases = RUNTIME_FAULT_SOAK_CASE_IDS.map((id) => {
    const attempts = grouped.get(id)!;
    const durations = attempts.map((attempt) => attempt.durationMs);
    const orphanPidCount: OptionalMetric<number> = attempts.every(
      (attempt) => attempt.cleanup.orphanPids.supported,
    )
      ? {
          supported: true,
          value: attempts.reduce(
            (total, attempt) =>
              total +
              (attempt.cleanup.orphanPids.supported ? attempt.cleanup.orphanPids.value.length : 0),
            0,
          ),
        }
      : {
          supported: false,
          reason: 'owned descendant PID tracking was unsupported for at least one attempt',
        };
    const orphanWorktreeCount: OptionalMetric<number> = attempts.every(
      (attempt) => attempt.cleanup.orphanWorktrees.supported,
    )
      ? {
          supported: true,
          value: attempts.reduce(
            (total, attempt) =>
              total +
              (attempt.cleanup.orphanWorktrees.supported
                ? attempt.cleanup.orphanWorktrees.value.length
                : 0),
            0,
          ),
        }
      : {
          supported: false,
          reason: 'Git worktree inspection was unsupported for at least one attempt',
        };
    const terminalTaxonomyAssertions: Record<string, number> = {};
    for (const attempt of attempts) {
      for (const [reason, count] of Object.entries(attempt.terminalTaxonomyAssertions)) {
        terminalTaxonomyAssertions[reason] = (terminalTaxonomyAssertions[reason] ?? 0) + count;
      }
    }
    return {
      id,
      attempts: attempts.length,
      passed: attempts.filter((attempt) => attempt.status === 'passed').length,
      failed: attempts.filter((attempt) => attempt.status !== 'passed').length,
      latencyMs: {
        count: durations.length,
        min: durations.length === 0 ? 0 : Math.min(...durations),
        max: durations.length === 0 ? 0 : Math.max(...durations),
        p50: nearestRankPercentile(durations, 0.5),
        p95: nearestRankPercentile(durations, 0.95),
        p99: nearestRankPercentile(durations, 0.99),
      },
      terminalTaxonomyAssertions,
      stateInvariantAssertions: attempts.reduce(
        (total, attempt) => total + attempt.stateInvariantAssertions,
        0,
      ),
      runtimeBudgetUsage: summarizeRuntimeBudgetUsage(
        attempts.map((attempt) => attempt.runtimeBudgetUsage),
      ),
      resources: {
        rssBytes: summarizeMetric(
          attempts,
          (attempt) => attempt.resources.rssBytes,
          RUNTIME_FAULT_SOAK_GROWTH_LIMITS.rssBytes,
        ),
        activeResources: summarizeMetric(
          attempts,
          (attempt) => attempt.resources.activeResources,
          RUNTIME_FAULT_SOAK_GROWTH_LIMITS.activeResources,
        ),
        fileDescriptors: summarizeMetric(
          attempts,
          (attempt) => attempt.resources.fileDescriptors,
          RUNTIME_FAULT_SOAK_GROWTH_LIMITS.fileDescriptors,
        ),
        listeners: summarizeMetric(
          attempts,
          (attempt) => attempt.resources.listeners,
          RUNTIME_FAULT_SOAK_GROWTH_LIMITS.listeners,
        ),
        handles: summarizeMetric(
          attempts,
          (attempt) => attempt.resources.handles,
          RUNTIME_FAULT_SOAK_GROWTH_LIMITS.handles,
        ),
      },
      cleanup: {
        confirmedAttempts: attempts.filter((attempt) => attempt.cleanup.confirmed).length,
        orphanPidCount,
        orphanWorktreeCount,
        residualPathCount: attempts.reduce(
          (total, attempt) => total + attempt.cleanup.residualPaths.length,
          0,
        ),
      },
    };
  });

  const wallTimeMs = Math.max(
    0,
    new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime(),
  );
  const maxProbeInvocations = expectedAttempts;
  const maxWallTimeMs = expectedAttempts * input.perCaseTimeoutMs;
  if (wallTimeMs > maxWallTimeMs) failureCodes.add('global_deadline_exceeded');

  const runtimeBudgetUsage = summarizeRuntimeBudgetUsage(
    input.attempts.map((attempt) => attempt.runtimeBudgetUsage),
  );
  const metricsSupported =
    input.attempts.every(qualificationMetricsSupported) && runtimeBudgetUsage.supported;
  if (input.profile === 'qualification' && !metricsSupported) {
    failureCodes.add('qualification_metrics_unsupported');
  }
  if (input.profile === 'qualification' && input.iterations < MINIMUM_QUALIFICATION_ITERATIONS) {
    failureCodes.add('qualification_iterations_insufficient');
  }
  if (input.profile === 'qualification' && !isValidGithubActionsSource(source)) {
    failureCodes.add('qualification_source_identity_missing');
  }
  if (input.profile === 'qualification') {
    for (const entry of cases) {
      for (const [metric, summary] of Object.entries(entry.resources)) {
        if (
          summary.supported &&
          summary.qualificationEligible &&
          summary.maxGrowth > summary.growthLimit
        ) {
          failureCodes.add(`${entry.id}:${metric}_attempt_growth`);
        }
        if (summary.supported && summary.qualificationEligible && summary.sustainedPositiveSlope) {
          failureCodes.add(`${entry.id}:${metric}_sustained_growth`);
        }
      }
    }
  }
  const hardFailure = [...failureCodes].some(
    (code) =>
      code !== 'qualification_metrics_unsupported' &&
      code !== 'qualification_iterations_insufficient' &&
      code !== 'qualification_source_identity_missing',
  );
  const status: RuntimeFaultSoakStatus = hardFailure
    ? 'failed'
    : input.profile === 'qualification' &&
        (!metricsSupported ||
          input.iterations < MINIMUM_QUALIFICATION_ITERATIONS ||
          !isValidGithubActionsSource(source))
      ? 'inconclusive'
      : 'passed';

  const withoutDigest: Omit<RuntimeFaultSoakReportV2, 'reportDigest'> = {
    version: RUNTIME_FAULT_SOAK_REPORT_VERSION,
    runnerRevision: input.runnerRevision,
    seed: input.seed,
    profile: input.profile,
    config: {
      iterations: input.iterations,
      perCaseTimeoutMs: input.perCaseTimeoutMs,
      maxProbeInvocations,
      maxWallTimeMs,
    },
    environment: input.environment,
    source,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status,
    failureCodes: [...failureCodes].sort(),
    attempts: input.attempts,
    cases,
    aggregate: {
      attempts: input.attempts.length,
      passed: input.attempts.filter((attempt) => attempt.status === 'passed').length,
      failed: input.attempts.filter((attempt) => attempt.status !== 'passed').length,
      runnerBudgetUsage: {
        probeInvocations: input.attempts.length,
        maxProbeInvocations,
        wallTimeMs,
        maxWallTimeMs,
      },
      runtimeBudgetUsage,
      qualificationMetricsSupported: metricsSupported,
    },
  };
  return {
    ...withoutDigest,
    reportDigest: computeRuntimeFaultSoakReportDigest(withoutDigest),
  };
}
