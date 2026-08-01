import { describe, expect, test } from 'bun:test';
import {
  buildRuntimeFaultSoakReport,
  hasSustainedPositiveSlope,
  nearestRankPercentile,
  RUNTIME_FAULT_SOAK_CASE_IDS,
  RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS,
  type RuntimeFaultSoakAttemptV1,
} from '../../scripts/runtime/fault-soak-report';

function unsupported(reason: string) {
  return { supported: false as const, reason };
}

function attempts(iterations = 1): RuntimeFaultSoakAttemptV1[] {
  return RUNTIME_FAULT_SOAK_CASE_IDS.flatMap((caseId) =>
    Array.from({ length: iterations }, (_, index) => ({
      caseId,
      iteration: index + 1,
      status: 'passed' as const,
      durationMs: 10 + index,
      invariantsPassed: true,
      terminalTaxonomyAssertions: Object.fromEntries(
        RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS[caseId].map((reason) => [reason, 1]),
      ),
      cleanup: {
        confirmed: true,
        orphanPids: unsupported('not collected by the CI profile'),
        orphanWorktrees: [],
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
    expect(report.cases.map((entry) => entry.id)).toEqual([...RUNTIME_FAULT_SOAK_CASE_IDS]);
    expect(report.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('fails qualification closed when child metrics or orphan detection are unsupported', () => {
    const report = build('qualification');
    expect(report.status).toBe('inconclusive');
    expect(report.failureCodes).toEqual(
      expect.arrayContaining([
        'qualification_iterations_insufficient',
        'qualification_metrics_unsupported',
      ]),
    );
  });

  test('fails on missing cases, invariant damage, or cleanup residue', () => {
    const values = attempts();
    values.shift();
    values[0] = {
      ...values[0]!,
      invariantsPassed: false,
      cleanup: {
        ...values[0]!.cleanup,
        orphanWorktrees: ['/tmp/registered-worktree'],
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
      cleanup: {
        ...attempt.cleanup,
        orphanPids: { supported: true as const, value: [] },
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          {
            supported: true as const,
            qualificationEligible: true,
            value: {
              before: attempt.iteration * 10,
              after:
                metric === 'rssBytes'
                  ? attempt.iteration * 64 * 1024 * 1024
                  : attempt.iteration * 10,
            },
          },
        ]),
      ) as RuntimeFaultSoakAttemptV1['resources'],
    }));

    const report = build('qualification', values, 8);
    expect(report.status).toBe('failed');
    expect(report.aggregate.qualificationMetricsSupported).toBe(true);
    expect(report.failureCodes).toContain('long_runtime_replay:rssBytes_sustained_growth');
  });

  test('fails qualification on a large within-attempt increase even without a cross-run slope', () => {
    const values = attempts(8).map((attempt) => ({
      ...attempt,
      terminalTaxonomyAssertions: Object.fromEntries(
        Object.keys(attempt.terminalTaxonomyAssertions).map((reason) => [reason, 1]),
      ),
      cleanup: {
        ...attempt.cleanup,
        orphanPids: { supported: true as const, value: [] },
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          {
            supported: true as const,
            qualificationEligible: true,
            value: { before: 1, after: metric === 'rssBytes' ? 1_000_000_000 : 1 },
          },
        ]),
      ) as RuntimeFaultSoakAttemptV1['resources'],
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
      },
      resources: Object.fromEntries(
        Object.keys(attempt.resources).map((metric) => [
          metric,
          {
            supported: true as const,
            qualificationEligible: false,
            value: { before: 1, after: 1_000_000_000 },
          },
        ]),
      ) as RuntimeFaultSoakAttemptV1['resources'],
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
