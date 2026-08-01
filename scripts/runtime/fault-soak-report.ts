import { createHash } from 'node:crypto';

export const RUNTIME_FAULT_SOAK_REPORT_VERSION = 1 as const;
export const MINIMUM_QUALIFICATION_ITERATIONS = 8;
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

export type RuntimeFaultSoakCaseId = (typeof RUNTIME_FAULT_SOAK_CASE_IDS)[number];
export type RuntimeFaultSoakProfile = 'ci' | 'qualification';
export type RuntimeFaultSoakStatus = 'passed' | 'failed' | 'inconclusive';

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
  /** True only for a post-warmup, same-process lifecycle sample. */
  qualificationEligible?: boolean;
}

export interface UnsupportedMetric {
  supported: false;
  reason: string;
}

export type OptionalMetric<T> = SupportedMetric<T> | UnsupportedMetric;

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

export interface RuntimeFaultSoakAttemptV1 {
  caseId: RuntimeFaultSoakCaseId;
  iteration: number;
  status: 'passed' | 'failed' | 'timed_out';
  durationMs: number;
  failureCode?: string;
  invariantsPassed: boolean;
  /** Passing probe invocations that asserted each terminal taxonomy outcome. */
  terminalTaxonomyAssertions: Readonly<Record<string, number>>;
  cleanup: {
    confirmed: boolean;
    orphanPids: OptionalMetric<readonly number[]>;
    orphanWorktrees: readonly string[];
    residualPaths: readonly string[];
  };
  resources: {
    rssBytes: OptionalMetric<{ before: number; after: number }>;
    activeResources: OptionalMetric<{ before: number; after: number }>;
    fileDescriptors: OptionalMetric<{ before: number; after: number }>;
    listeners: OptionalMetric<{ before: number; after: number }>;
    handles: OptionalMetric<{ before: number; after: number }>;
  };
}

export interface RuntimeFaultSoakReportV1 {
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
  startedAt: string;
  finishedAt: string;
  status: RuntimeFaultSoakStatus;
  failureCodes: readonly string[];
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
      orphanWorktreeCount: number;
      residualPathCount: number;
    };
  }>;
  aggregate: {
    attempts: number;
    passed: number;
    failed: number;
    budgetUsage: {
      probeInvocations: number;
      maxProbeInvocations: number;
      wallTimeMs: number;
      maxWallTimeMs: number;
    };
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
  environment: RuntimeFaultSoakReportV1['environment'];
  attempts: readonly RuntimeFaultSoakAttemptV1[];
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function qualificationMetricsSupported(attempt: RuntimeFaultSoakAttemptV1): boolean {
  return (
    attempt.cleanup.orphanPids.supported &&
    attempt.resources.rssBytes.supported &&
    attempt.resources.rssBytes.qualificationEligible === true &&
    attempt.resources.activeResources.supported &&
    attempt.resources.activeResources.qualificationEligible === true &&
    attempt.resources.fileDescriptors.supported &&
    attempt.resources.fileDescriptors.qualificationEligible === true &&
    attempt.resources.listeners.supported &&
    attempt.resources.listeners.qualificationEligible === true &&
    attempt.resources.handles.supported &&
    attempt.resources.handles.qualificationEligible === true
  );
}

function summarizeMetric(
  attempts: readonly RuntimeFaultSoakAttemptV1[],
  select: (attempt: RuntimeFaultSoakAttemptV1) => OptionalMetric<{ before: number; after: number }>,
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
  const values = metrics.flatMap((metric) => (metric.supported ? [metric.value] : []));
  return {
    supported: true,
    samples: values.length,
    minBefore: Math.min(...values.map((value) => value.before)),
    maxAfter: Math.max(...values.map((value) => value.after)),
    maxGrowth: Math.max(...values.map((value) => value.after - value.before)),
    growthLimit,
    qualificationEligible: metrics.every(
      (metric) => metric.supported && metric.qualificationEligible === true,
    ),
    sustainedPositiveSlope: hasSustainedPositiveSlope(
      values.map((value) => value.after),
      growthLimit,
      MINIMUM_QUALIFICATION_ITERATIONS,
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
): RuntimeFaultSoakReportV1 {
  if (!Number.isInteger(input.iterations) || input.iterations <= 0) {
    throw new Error('iterations must be a positive integer');
  }
  if (!Number.isInteger(input.perCaseTimeoutMs) || input.perCaseTimeoutMs <= 0) {
    throw new Error('perCaseTimeoutMs must be a positive integer');
  }

  const expectedAttempts = input.iterations * RUNTIME_FAULT_SOAK_CASE_IDS.length;
  const failureCodes = new Set<string>();
  const grouped = new Map<RuntimeFaultSoakCaseId, RuntimeFaultSoakAttemptV1[]>();
  for (const id of RUNTIME_FAULT_SOAK_CASE_IDS) grouped.set(id, []);
  for (const attempt of input.attempts) {
    grouped.get(attempt.caseId)?.push(attempt);
    if (attempt.status !== 'passed') failureCodes.add(attempt.failureCode ?? attempt.status);
    if (!attempt.invariantsPassed) failureCodes.add(`${attempt.caseId}:state_invariant`);
    if (!attempt.cleanup.confirmed) failureCodes.add(`${attempt.caseId}:cleanup_unconfirmed`);
    if (attempt.cleanup.orphanWorktrees.length > 0) {
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
        orphanWorktreeCount: attempts.reduce(
          (total, attempt) => total + attempt.cleanup.orphanWorktrees.length,
          0,
        ),
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

  const metricsSupported = input.attempts.every(qualificationMetricsSupported);
  if (input.profile === 'qualification' && !metricsSupported) {
    failureCodes.add('qualification_metrics_unsupported');
  }
  if (input.profile === 'qualification' && input.iterations < MINIMUM_QUALIFICATION_ITERATIONS) {
    failureCodes.add('qualification_iterations_insufficient');
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
      code !== 'qualification_iterations_insufficient',
  );
  const status: RuntimeFaultSoakStatus = hardFailure
    ? 'failed'
    : input.profile === 'qualification' &&
        (!metricsSupported || input.iterations < MINIMUM_QUALIFICATION_ITERATIONS)
      ? 'inconclusive'
      : 'passed';

  const withoutDigest: Omit<RuntimeFaultSoakReportV1, 'reportDigest'> = {
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
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status,
    failureCodes: [...failureCodes].sort(),
    cases,
    aggregate: {
      attempts: input.attempts.length,
      passed: input.attempts.filter((attempt) => attempt.status === 'passed').length,
      failed: input.attempts.filter((attempt) => attempt.status !== 'passed').length,
      budgetUsage: {
        probeInvocations: input.attempts.length,
        maxProbeInvocations,
        wallTimeMs,
        maxWallTimeMs,
      },
      qualificationMetricsSupported: metricsSupported,
    },
  };
  return {
    ...withoutDigest,
    reportDigest: `sha256:${createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex')}`,
  };
}
