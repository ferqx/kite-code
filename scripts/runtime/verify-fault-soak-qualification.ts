import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildRuntimeFaultSoakReport,
  canonicalRuntimeFaultSoakJson,
  computeRuntimeFaultSoakReportDigest,
  MINIMUM_POST_WARMUP_LIFECYCLES,
  RUNTIME_FAULT_SOAK_CASE_IDS,
  RUNTIME_FAULT_SOAK_GROWTH_LIMITS,
  RUNTIME_FAULT_SOAK_REPORT_VERSION,
  RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS,
  RUNTIME_FAULT_SOAK_RUNNER_REVISION,
  type RuntimeFaultSoakReportV2,
} from './fault-soak-report';

const FORMAL_QUALIFICATION_SEED = 1729;
const FORMAL_QUALIFICATION_ITERATIONS = 8;
const FORMAL_PER_CASE_TIMEOUT_MS = 180_000;
const FORMAL_WORKFLOW = 'runtime-resilience-qualification.yml';

export interface RuntimeFaultSoakQualificationExpectation {
  repository: string;
  headSha: string;
  ref: string;
  runId: string;
  runAttempt: number;
  workflowRef: string;
  workflowSha: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function supportedNumber(value: unknown, expected: number): boolean {
  const metric = record(value);
  return metric?.supported === true && metric.value === expected;
}

function addMismatch(errors: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    errors.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

export function verifyRuntimeFaultSoakQualification(
  value: unknown,
  expected: RuntimeFaultSoakQualificationExpectation,
): string[] {
  const errors: string[] = [];
  const report = record(value);
  if (!report) return ['report must be a JSON object'];

  addMismatch(errors, 'version', report.version, RUNTIME_FAULT_SOAK_REPORT_VERSION);
  addMismatch(errors, 'runnerRevision', report.runnerRevision, RUNTIME_FAULT_SOAK_RUNNER_REVISION);
  addMismatch(errors, 'profile', report.profile, 'qualification');
  addMismatch(errors, 'seed', report.seed, FORMAL_QUALIFICATION_SEED);
  addMismatch(errors, 'status', report.status, 'passed');
  if (!Array.isArray(report.failureCodes) || report.failureCodes.length !== 0) {
    errors.push('failureCodes must be an empty array');
  }

  const config = record(report.config);
  addMismatch(errors, 'config.iterations', config?.iterations, FORMAL_QUALIFICATION_ITERATIONS);
  addMismatch(
    errors,
    'config.perCaseTimeoutMs',
    config?.perCaseTimeoutMs,
    FORMAL_PER_CASE_TIMEOUT_MS,
  );
  const expectedAttempts = FORMAL_QUALIFICATION_ITERATIONS * RUNTIME_FAULT_SOAK_CASE_IDS.length;
  addMismatch(errors, 'config.maxProbeInvocations', config?.maxProbeInvocations, expectedAttempts);
  addMismatch(
    errors,
    'config.maxWallTimeMs',
    config?.maxWallTimeMs,
    expectedAttempts * FORMAL_PER_CASE_TIMEOUT_MS,
  );

  const environment = record(report.environment);
  addMismatch(errors, 'environment.platform', environment?.platform, 'linux');
  addMismatch(errors, 'environment.arch', environment?.arch, 'x64');
  addMismatch(errors, 'environment.bunVersion', environment?.bunVersion, '1.3.14');

  const source = record(report.source);
  addMismatch(errors, 'source.kind', source?.kind, 'github_actions');
  addMismatch(errors, 'source.repository', source?.repository, expected.repository);
  addMismatch(errors, 'source.headSha', source?.headSha, expected.headSha);
  addMismatch(errors, 'source.ref', source?.ref, expected.ref);
  addMismatch(errors, 'source.workflow', source?.workflow, FORMAL_WORKFLOW);
  addMismatch(errors, 'source.workflowRef', source?.workflowRef, expected.workflowRef);
  addMismatch(errors, 'source.workflowSha', source?.workflowSha, expected.workflowSha);
  const expectedWorkflowPrefix = `${expected.repository}/.github/workflows/${FORMAL_WORKFLOW}@`;
  if (!expected.workflowRef.startsWith(expectedWorkflowPrefix)) {
    errors.push(`expected workflow_ref must start with ${expectedWorkflowPrefix}`);
  }
  if (!/^[0-9a-f]{40}$/.test(expected.workflowSha)) {
    errors.push('expected workflow_sha must be a 40-character lowercase Git SHA');
  }
  addMismatch(errors, 'source.runId', source?.runId, expected.runId);
  addMismatch(errors, 'source.runAttempt', source?.runAttempt, expected.runAttempt);

  if (!Array.isArray(report.cases)) {
    errors.push('cases must be an array');
  } else {
    addMismatch(errors, 'cases.length', report.cases.length, RUNTIME_FAULT_SOAK_CASE_IDS.length);
    for (const [index, caseId] of RUNTIME_FAULT_SOAK_CASE_IDS.entries()) {
      const entry = record(report.cases[index]);
      addMismatch(errors, `cases[${index}].id`, entry?.id, caseId);
      addMismatch(errors, `${caseId}.attempts`, entry?.attempts, FORMAL_QUALIFICATION_ITERATIONS);
      addMismatch(errors, `${caseId}.passed`, entry?.passed, FORMAL_QUALIFICATION_ITERATIONS);
      addMismatch(errors, `${caseId}.failed`, entry?.failed, 0);
      const latency = record(entry?.latencyMs);
      addMismatch(
        errors,
        `${caseId}.latencyMs.count`,
        latency?.count,
        FORMAL_QUALIFICATION_ITERATIONS,
      );
      for (const field of ['min', 'max', 'p50', 'p95', 'p99'] as const) {
        if (typeof latency?.[field] !== 'number' || latency[field] < 0) {
          errors.push(`${caseId}.latencyMs.${field} must be a non-negative number`);
        }
      }
      addMismatch(
        errors,
        `${caseId}.stateInvariantAssertions`,
        entry?.stateInvariantAssertions,
        FORMAL_QUALIFICATION_ITERATIONS,
      );

      const terminalAssertions = record(entry?.terminalTaxonomyAssertions);
      for (const terminal of RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS[caseId]) {
        addMismatch(
          errors,
          `${caseId}.terminalTaxonomyAssertions.${terminal}`,
          terminalAssertions?.[terminal],
          FORMAL_QUALIFICATION_ITERATIONS,
        );
      }

      const cleanup = record(entry?.cleanup);
      addMismatch(
        errors,
        `${caseId}.cleanup.confirmedAttempts`,
        cleanup?.confirmedAttempts,
        FORMAL_QUALIFICATION_ITERATIONS,
      );
      if (!supportedNumber(cleanup?.orphanPidCount, 0)) {
        errors.push(`${caseId}.cleanup.orphanPidCount must be supported with value 0`);
      }
      if (!supportedNumber(cleanup?.orphanWorktreeCount, 0)) {
        errors.push(`${caseId}.cleanup.orphanWorktreeCount must be supported with value 0`);
      }
      addMismatch(errors, `${caseId}.cleanup.residualPathCount`, cleanup?.residualPathCount, 0);

      const resources = record(entry?.resources);
      const expectedResourceSamples =
        FORMAL_QUALIFICATION_ITERATIONS *
        MINIMUM_POST_WARMUP_LIFECYCLES *
        (caseId === 'long_runtime_replay' ? 2 : 1);
      for (const [metricName, growthLimit] of Object.entries(RUNTIME_FAULT_SOAK_GROWTH_LIMITS)) {
        const metric = record(resources?.[metricName]);
        if (metric?.supported !== true || metric.qualificationEligible !== true) {
          errors.push(`${caseId}.resources.${metricName} must be qualification eligible`);
          continue;
        }
        addMismatch(
          errors,
          `${caseId}.resources.${metricName}.samples`,
          metric.samples,
          expectedResourceSamples,
        );
        if (metric.growthLimit !== growthLimit) {
          errors.push(`${caseId}.resources.${metricName}.growthLimit changed`);
        }
        if (typeof metric.maxGrowth !== 'number' || metric.maxGrowth > growthLimit) {
          errors.push(`${caseId}.resources.${metricName}.maxGrowth exceeds its limit`);
        }
        if (metric.sustainedPositiveSlope !== false) {
          errors.push(`${caseId}.resources.${metricName} has sustained positive slope`);
        }
      }

      const budget = record(entry?.runtimeBudgetUsage);
      if (caseId === 'long_runtime_replay') {
        const expectedSamples =
          FORMAL_QUALIFICATION_ITERATIONS * (MINIMUM_POST_WARMUP_LIFECYCLES + 1);
        if (budget?.supported !== true || budget.samples !== expectedSamples) {
          errors.push(
            `long_runtime_replay.runtimeBudgetUsage must contain ${expectedSamples} receipts`,
          );
        }
      }
    }
  }

  const aggregate = record(report.aggregate);
  addMismatch(errors, 'aggregate.attempts', aggregate?.attempts, expectedAttempts);
  addMismatch(errors, 'aggregate.passed', aggregate?.passed, expectedAttempts);
  addMismatch(errors, 'aggregate.failed', aggregate?.failed, 0);
  addMismatch(
    errors,
    'aggregate.qualificationMetricsSupported',
    aggregate?.qualificationMetricsSupported,
    true,
  );
  const runnerBudget = record(aggregate?.runnerBudgetUsage);
  addMismatch(
    errors,
    'aggregate.runnerBudgetUsage.probeInvocations',
    runnerBudget?.probeInvocations,
    expectedAttempts,
  );
  addMismatch(
    errors,
    'aggregate.runnerBudgetUsage.maxProbeInvocations',
    runnerBudget?.maxProbeInvocations,
    expectedAttempts,
  );
  addMismatch(
    errors,
    'aggregate.runnerBudgetUsage.maxWallTimeMs',
    runnerBudget?.maxWallTimeMs,
    expectedAttempts * FORMAL_PER_CASE_TIMEOUT_MS,
  );
  if (
    typeof runnerBudget?.wallTimeMs !== 'number' ||
    !Number.isFinite(runnerBudget.wallTimeMs) ||
    runnerBudget.wallTimeMs < 0 ||
    runnerBudget.wallTimeMs > expectedAttempts * FORMAL_PER_CASE_TIMEOUT_MS
  ) {
    errors.push('aggregate.runnerBudgetUsage exceeds its wall-time budget');
  }
  const aggregateBudget = record(aggregate?.runtimeBudgetUsage);
  const expectedRuntimeBudgetSamples =
    FORMAL_QUALIFICATION_ITERATIONS * (MINIMUM_POST_WARMUP_LIFECYCLES + 1);
  if (
    aggregateBudget?.supported !== true ||
    aggregateBudget.samples !== expectedRuntimeBudgetSamples
  ) {
    errors.push(
      `aggregate.runtimeBudgetUsage must contain ${expectedRuntimeBudgetSamples} receipts`,
    );
  }
  for (const field of [
    'maxReconciledCounters',
    'maxReconciledGauges',
    'maxCommittedCounters',
    'maxCommittedGauges',
    'ceilings',
    'reservationStates',
  ] as const) {
    if (!record(aggregateBudget?.[field])) {
      errors.push(`aggregate.runtimeBudgetUsage.${field} must be an object`);
    }
  }

  const startedAt = Date.parse(String(report.startedAt));
  const finishedAt = Date.parse(String(report.finishedAt));
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    errors.push('startedAt/finishedAt must be an ordered ISO timestamp pair');
  } else {
    addMismatch(
      errors,
      'aggregate.runnerBudgetUsage.wallTimeMs',
      runnerBudget?.wallTimeMs,
      finishedAt - startedAt,
    );
  }

  if (!Array.isArray(report.attempts)) {
    errors.push('attempts must be an array');
  } else {
    try {
      const rebuilt = buildRuntimeFaultSoakReport({
        runnerRevision: String(report.runnerRevision),
        seed: Number(report.seed),
        profile: report.profile as 'qualification',
        iterations: Number(config?.iterations),
        perCaseTimeoutMs: Number(config?.perCaseTimeoutMs),
        startedAt: String(report.startedAt),
        finishedAt: String(report.finishedAt),
        environment: report.environment as RuntimeFaultSoakReportV2['environment'],
        source: report.source as RuntimeFaultSoakReportV2['source'],
        attempts: report.attempts as RuntimeFaultSoakReportV2['attempts'],
      });
      if (canonicalRuntimeFaultSoakJson(rebuilt) !== canonicalRuntimeFaultSoakJson(report)) {
        errors.push('report summaries do not rebuild from the retained attempt evidence');
      }
    } catch (error) {
      errors.push(
        `retained attempt evidence could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const { reportDigest, ...withoutDigest } = report;
  if (typeof reportDigest !== 'string') {
    errors.push('reportDigest must be a string');
  } else {
    const computed = computeRuntimeFaultSoakReportDigest(
      withoutDigest as Omit<RuntimeFaultSoakReportV2, 'reportDigest'>,
    );
    addMismatch(errors, 'reportDigest', reportDigest, computed);
  }
  return errors;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = readOption(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reportPath = resolve(requiredOption(args, '--report'));
  const runAttempt = Number(requiredOption(args, '--expected-run-attempt'));
  if (!Number.isInteger(runAttempt) || runAttempt <= 0) {
    throw new Error('--expected-run-attempt must be a positive integer');
  }
  const value: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  const errors = verifyRuntimeFaultSoakQualification(value, {
    repository: requiredOption(args, '--expected-repository'),
    headSha: requiredOption(args, '--expected-head-sha'),
    ref: requiredOption(args, '--expected-ref'),
    workflowRef: requiredOption(args, '--expected-workflow-ref'),
    workflowSha: requiredOption(args, '--expected-workflow-sha'),
    runId: requiredOption(args, '--expected-run-id'),
    runAttempt,
  });
  if (errors.length > 0) {
    throw new Error(`Qualification evidence verification failed:\n- ${errors.join('\n- ')}`);
  }
  console.log(
    `[fault-soak] qualification evidence verified: ${String(record(value)?.reportDigest)}`,
  );
}
