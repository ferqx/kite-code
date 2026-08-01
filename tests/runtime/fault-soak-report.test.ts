import { describe, expect, test } from 'bun:test';
import {
  buildRuntimeFaultSoakReport,
  hasSustainedPositiveSlope,
  nearestRankPercentile,
  RUNTIME_FAULT_SOAK_CASE_IDS,
  RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS,
  RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS,
  type RuntimeFaultSoakAttemptV2,
  type RuntimeFaultSoakMetricEvidenceV2,
} from '../../scripts/runtime/fault-soak-report';

function unsupported(reason: string) {
  return { supported: false as const, reason };
}

function attempts(iterations = 1): RuntimeFaultSoakAttemptV2[] {
  return RUNTIME_FAULT_SOAK_CASE_IDS.flatMap((caseId) =>
    Array.from({ length: iterations }, (_, index) => ({
      caseId,
      iteration: index + 1,
      status: 'passed' as const,
      durationMs: 10 + index,
      stateInvariantAssertions: 1,
      terminalTaxonomyAssertions: Object.fromEntries(
        RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS[caseId].map((reason) => [reason, 1]),
      ),
      runtimeBudgetUsage: {
        supported: true as const,
        value: [
          {
            source: 'actual_runtime_ledger' as const,
            reconciled: {
              counters: { turns: 1, modelRequests: 1, toolInvocations: 1 },
              gauges: { elapsedRunMs: 10, activeToolInvocations: 0 },
            },
            committed: {
              counters: { turns: 1, modelRequests: 1, toolInvocations: 1 },
              gauges: { elapsedRunMs: 10, activeToolInvocations: 0 },
            },
            ceilings: { maxTurns: 30, maxModelRequests: 60, maxToolInvocations: 250 },
            reservationStates: { reconciled: 1 },
          },
        ],
      },
      cleanup: {
        confirmed: true,
        orphanPids: unsupported('not collected by the CI profile'),
        orphanWorktrees: unsupported('not collected by the CI profile'),
        residualPaths: [],
      },
      resources: {
        rssBytes: unsupported('not collected by the CI profile'),
        activeResources: unsupported('not collected by the CI profile'),
        fileDescriptors: unsupported('not collected by the CI profile'),
        listeners: unsupported('not collected by the CI profile'),
        handles: unsupported('not collected by the CI profile'),
      },
    })),
  );
}

function lifecycleMetric(
  values: ReadonlyArray<{ before: number; after: number }>,
  attempt: RuntimeFaultSoakAttemptV2,
): { supported: true; value: RuntimeFaultSoakMetricEvidenceV2 } {
  const point = (sequence: number, value: { before: number; after: number }) => ({
    sequence,
    ...value,
    durationMs: 10,
    deadlineMs: 1000,
    cleanupConfirmed: true,
  });
  return {
    supported: true,
    value: {
      kind: 'same_process_lifecycle',
      series: RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS[attempt.caseId].map(
        (lifecycleId, groupIndex) => ({
          process: {
            pid: 1000 + attempt.iteration * 10 + groupIndex,
            startNonce: `${attempt.caseId}-${attempt.iteration}-${groupIndex}`,
            osProcessStartIdentity: `linux:boot:${attempt.iteration}:${groupIndex}`,
            lifecycleId,
            lifecycleGroupNonce: `group-${attempt.iteration}-${groupIndex}`,
          },
          warmup: point(0, { before: 1, after: 1 }),
          lifecycles: values.map((value, index) => point(index + 1, value)),
        }),
      ),
    },
  };
}

function qualificationBudget(
  attempt: RuntimeFaultSoakAttemptV2,
): RuntimeFaultSoakAttemptV2['runtimeBudgetUsage'] {
  if (attempt.caseId !== 'long_runtime_replay' || !attempt.runtimeBudgetUsage.supported) {
    return attempt.runtimeBudgetUsage;
  }
  const receipt = attempt.runtimeBudgetUsage.value[0]!;
  return {
    supported: true,
    value: Array.from({ length: 9 }, (_, index) => ({
      ...receipt,
      provenance: {
        caseId: attempt.caseId,
        iteration: attempt.iteration,
        lifecycleId: 'fault-soak-runtime-budget.test.ts',
        pid: 1000 + attempt.iteration * 10 + 1,
        sequence: index + 1,
        processStartNonce: `${attempt.caseId}-${attempt.iteration}-1`,
        osProcessStartIdentity: `linux:boot:${attempt.iteration}:1`,
        lifecycleGroupNonce: `group-${attempt.iteration}-1`,
      },
    })),
  };
}

function build(profile: 'ci' | 'qualification', values = attempts(), iterations = 1) {
  return buildRuntimeFaultSoakReport({
    runnerRevision: 'test-v1',
    seed: 17,
    profile,
    iterations,
    perCaseTimeoutMs: 1000,
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:00:01.000Z',
    environment: { platform: 'linux', arch: 'x64', bunVersion: '1.3.14' },
    attempts: values,
  });
}

describe('runtime fault soak report', () => {
  test('uses nearest-rank latency percentiles', () => {
    expect(nearestRankPercentile([1, 2, 3, 100], 0.5)).toBe(2);
    expect(nearestRankPercentile([1, 2, 3, 100], 0.95)).toBe(100);
    expect(() => nearestRankPercentile([1], 0)).toThrow('Percentile');
    expect(hasSustainedPositiveSlope([1, 2, 3, 4, 5, 6, 7, 20], 8)).toBe(true);
    expect(hasSustainedPositiveSlope([1, 3, 2, 4, 3, 5, 4, 6], 2)).toBe(false);
  });

  test('passes the CI profile while preserving unsupported qualification metrics', () => {
    const report = build('ci');
    expect(report.status).toBe('passed');
    expect(report.aggregate.qualificationMetricsSupported).toBe(false);
    expect(report.version).toBe(2);
    expect(report.cases.map((entry) => entry.id)).toEqual([...RUNTIME_FAULT_SOAK_CASE_IDS]);
    expect(report.aggregate.runnerBudgetUsage.probeInvocations).toBe(7);
    expect(report.aggregate.runtimeBudgetUsage).toMatchObject({
      supported: true,
      samples: 7,
      maxReconciledCounters: { modelRequests: 1, toolInvocations: 1, turns: 1 },
    });
    expect(report.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('fails qualification closed when child metrics or orphan detection are unsupported', () => {
    const report = build('qualification');
    expect(report.status).toBe('inconclusive');
    expect(report.failureCodes).toEqual(
      expect.arrayContaining([
        'qualification_iterations_insufficient',
        'qualification_metrics_unsupported',
        'qualification_source_identity_missing',
      ]),
    );
  });

  test('fails qualification closed when a long-runtime attempt lacks its actual budget receipt', () => {
    const values = attempts(8).map((attempt) => ({
      ...attempt,
      runtimeBudgetUsage:
        attempt.caseId === 'long_runtime_replay'
          ? unsupported('missing bound Runtime workload receipt')
          : attempt.runtimeBudgetUsage,
      cleanup: {
        ...attempt.cleanup,
        orphanPids: { supported: true as const, value: [] },
        orphanWorktrees: { supported: true as const, value: [] },
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          lifecycleMetric(
            Array.from({ length: 8 }, () => ({ before: 1, after: 1 })),
            attempt,
          ),
        ]),
      ) as RuntimeFaultSoakAttemptV2['resources'],
    }));

    const report = build('qualification', values, 8);
    expect(report.status).toBe('inconclusive');
    expect(report.failureCodes).toContain('qualification_metrics_unsupported');
  });

  test('fails on missing cases, invariant damage, or cleanup residue', () => {
    const values = attempts();
    values.shift();
    values[0] = {
      ...values[0]!,
      stateInvariantAssertions: 0,
      cleanup: {
        ...values[0]!.cleanup,
        orphanWorktrees: { supported: true, value: ['/tmp/registered-worktree'] },
        residualPaths: ['retained.sqlite'],
      },
    };
    const report = build('ci', values);
    expect(report.status).toBe('failed');
    expect(report.failureCodes).toEqual(
      expect.arrayContaining([
        'case_coverage_incomplete',
        'long_runtime_replay:attempt_count',
        'subagent_cancel_recovery:state_invariant',
        'subagent_cancel_recovery:orphan_worktree',
        'subagent_cancel_recovery:residual_path',
      ]),
    );
  });

  test('fails qualification on a sustained supported resource increase', () => {
    const values = attempts(8).map((attempt) => ({
      ...attempt,
      runtimeBudgetUsage: qualificationBudget(attempt),
      cleanup: {
        ...attempt.cleanup,
        orphanPids: { supported: true as const, value: [] },
        orphanWorktrees: { supported: true as const, value: [] },
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          lifecycleMetric(
            Array.from({ length: 8 }, (_, index) => {
              const after = metric === 'rssBytes' ? (index + 1) * 8 * 1024 * 1024 : 10;
              return { before: after, after };
            }),
            attempt,
          ),
        ]),
      ) as RuntimeFaultSoakAttemptV2['resources'],
    }));

    const report = build('qualification', values, 8);
    expect(report.status).toBe('failed');
    expect(report.aggregate.qualificationMetricsSupported).toBe(true);
    expect(report.failureCodes).toContain('long_runtime_replay:rssBytes_sustained_growth');
  });

  test('fails qualification on a large within-attempt increase even without a cross-run slope', () => {
    const values = attempts(8).map((attempt) => ({
      ...attempt,
      runtimeBudgetUsage: qualificationBudget(attempt),
      terminalTaxonomyAssertions: Object.fromEntries(
        Object.keys(attempt.terminalTaxonomyAssertions).map((reason) => [reason, 1]),
      ),
      cleanup: {
        ...attempt.cleanup,
        orphanPids: { supported: true as const, value: [] },
        orphanWorktrees: { supported: true as const, value: [] },
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          lifecycleMetric(
            Array.from({ length: 8 }, (_, index) => ({
              before: 1,
              after: metric === 'rssBytes' && index === 4 ? 1_000_000_000 : 1,
            })),
            attempt,
          ),
        ]),
      ) as RuntimeFaultSoakAttemptV2['resources'],
    }));

    const report = build('qualification', values, 8);
    expect(report.status).toBe('failed');
    expect(report.failureCodes).toContain('long_runtime_replay:rssBytes_attempt_growth');
  });

  test('keeps fresh-process cold-start growth diagnostic and qualification inconclusive', () => {
    const values = attempts(8).map((attempt) => ({
      ...attempt,
      cleanup: {
        ...attempt.cleanup,
        orphanPids: { supported: true as const, value: [] },
        orphanWorktrees: { supported: true as const, value: [] },
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          {
            supported: true as const,
            value: {
              kind: 'fresh_process_diagnostic' as const,
              before: 1,
              after: 1_000_000_000,
            },
          },
        ]),
      ) as RuntimeFaultSoakAttemptV2['resources'],
    }));

    const report = build('qualification', values, 8);
    expect(report.status).toBe('inconclusive');
    expect(report.failureCodes).toContain('qualification_metrics_unsupported');
    expect(report.failureCodes).not.toContain('long_runtime_replay:rssBytes_attempt_growth');
    expect(report.cases[0]?.resources.rssBytes).toMatchObject({
      supported: true,
      qualificationEligible: false,
      maxGrowth: 999_999_999,
    });
  });

  test('fails when a probe does not provide its required terminal assertion evidence', () => {
    const values = attempts().map((attempt) => ({
      ...attempt,
      terminalTaxonomyAssertions: {},
    }));

    const report = build('ci', values);
    expect(report.status).toBe('failed');
    expect(report.failureCodes).toContain(
      'runtime_sigkill_recovery:terminal_assertion_missing:reconciliation_required',
    );
  });
});
