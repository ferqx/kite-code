import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRuntimeFaultSoakReport,
  computeRuntimeFaultSoakReportDigest,
  RUNTIME_FAULT_SOAK_CASE_IDS,
  RUNTIME_FAULT_SOAK_QUALIFICATION_LIFECYCLE_IDS,
  RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS,
  RUNTIME_FAULT_SOAK_RUNNER_REVISION,
  type RuntimeBudgetUsageEvidence,
  type RuntimeFaultSoakAttempt,
  type RuntimeFaultSoakMetricEvidence,
} from '../../../scripts/runtime/fault-soak-report';
import { verifyRuntimeFaultSoakQualification } from '../../../scripts/runtime/verify-fault-soak-qualification';

const source = {
  kind: 'github_actions' as const,
  repository: 'ferqx/kite-code',
  headSha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  workflow: 'runtime-resilience-qualification.yml',
  workflowRef:
    'ferqx/kite-code/.github/workflows/runtime-resilience-qualification.yml@refs/heads/main',
  workflowSha: 'a'.repeat(40),
  runId: '30700000000',
  runAttempt: 1,
};

const expectation = {
  repository: source.repository,
  headSha: source.headSha,
  ref: source.ref,
  runId: source.runId,
  runAttempt: source.runAttempt,
  workflowRef: source.workflowRef,
  workflowSha: source.workflowSha,
};

function lifecycleMetric(attempt: RuntimeFaultSoakAttempt): {
  supported: true;
  value: RuntimeFaultSoakMetricEvidence;
} {
  const point = (sequence: number) => ({
    sequence,
    before: 10,
    after: 10,
    durationMs: 10,
    deadlineMs: 180_000,
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
            startNonce: `${attempt.caseId}-nonce-${groupIndex}`,
            osProcessStartIdentity: `linux:boot:${attempt.iteration}:${groupIndex}`,
            lifecycleId,
            lifecycleGroupNonce: `group-${attempt.iteration}-${groupIndex}`,
          },
          warmup: point(0),
          lifecycles: Array.from({ length: 8 }, (_, index) => point(index + 1)),
        }),
      ),
    },
  };
}

function budgetReceipt(
  attempt: Pick<RuntimeFaultSoakAttempt, 'caseId' | 'iteration'>,
  sequence: number,
): RuntimeBudgetUsageEvidence {
  return {
    source: 'actual_runtime_ledger',
    provenance: {
      caseId: attempt.caseId,
      iteration: attempt.iteration,
      lifecycleId: 'fault-soak-runtime-budget.test.ts',
      pid: 1000 + attempt.iteration * 10 + 1,
      sequence,
      processStartNonce: `${attempt.caseId}-nonce-1`,
      osProcessStartIdentity: `linux:boot:${attempt.iteration}:1`,
      lifecycleGroupNonce: `group-${attempt.iteration}-1`,
    },
    reconciled: {
      counters: { turns: 1, modelRequests: 1 },
      gauges: { activeToolInvocations: 0 },
    },
    committed: {
      counters: { turns: 1, modelRequests: 1 },
      gauges: { activeToolInvocations: 0 },
    },
    ceilings: { maxTurns: 30, maxModelRequests: 60 },
    reservationStates: { reconciled: 1 },
  };
}

function validReport() {
  const attempts = RUNTIME_FAULT_SOAK_CASE_IDS.flatMap((caseId) =>
    Array.from({ length: 8 }, (_, index) => {
      const attempt: RuntimeFaultSoakAttempt = {
        caseId,
        iteration: index + 1,
        status: 'passed',
        durationMs: 100,
        stateInvariantAssertions: 1,
        terminalTaxonomyAssertions: Object.fromEntries(
          RUNTIME_FAULT_SOAK_REQUIRED_TERMINAL_ASSERTIONS[caseId].map((terminal) => [terminal, 1]),
        ),
        runtimeBudgetUsage: { supported: false, reason: 'case has no Runtime budget workload' },
        cleanup: {
          confirmed: true,
          orphanPids: { supported: true, value: [] },
          orphanWorktrees: { supported: true, value: [] },
          residualPaths: [],
        },
        resources: undefined as never,
      };
      const metric = lifecycleMetric(attempt);
      if (caseId === 'long_runtime_replay') {
        attempt.runtimeBudgetUsage = {
          supported: true,
          value: Array.from({ length: 9 }, (_, receiptIndex) =>
            budgetReceipt(attempt, receiptIndex + 1),
          ),
        };
      }
      attempt.resources = {
        rssBytes: metric,
        activeResources: metric,
        fileDescriptors: metric,
        listeners: metric,
        handles: metric,
      };
      return attempt;
    }),
  );
  return buildRuntimeFaultSoakReport({
    runnerRevision: RUNTIME_FAULT_SOAK_RUNNER_REVISION,
    seed: 1729,
    profile: 'qualification',
    iterations: 8,
    perCaseTimeoutMs: 180_000,
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:00:01.000Z',
    environment: { platform: 'linux', arch: 'x64', bunVersion: '1.4.0' },
    source,
    attempts,
  });
}

describe('runtime fault soak qualification verifier', () => {
  test('accepts only the complete fixed formal qualification envelope', () => {
    const report = validReport();
    expect(report.status).toBe('passed');
    const artifact: unknown = JSON.parse(JSON.stringify(report));
    expect(verifyRuntimeFaultSoakQualification(artifact, expectation)).toEqual([]);
  });

  test('rejects source mismatch and post-digest report tampering', () => {
    const report = validReport();
    const sourceErrors = verifyRuntimeFaultSoakQualification(report, {
      ...expectation,
      headSha: 'b'.repeat(40),
    });
    expect(sourceErrors).toEqual(
      expect.arrayContaining([expect.stringContaining('source.headSha')]),
    );

    const tampered = structuredClone(report);
    tampered.aggregate.passed = 55;
    tampered.aggregate.runnerBudgetUsage.wallTimeMs = 10_080_001;
    tampered.aggregate.runnerBudgetUsage.maxWallTimeMs = 99_000_000;
    for (const entry of tampered.cases) {
      for (const metric of Object.values(entry.resources)) {
        if (metric.supported) metric.samples = 0;
      }
    }
    const { reportDigest: _reportDigest, ...withoutDigest } = tampered;
    tampered.reportDigest = computeRuntimeFaultSoakReportDigest(withoutDigest);
    const tamperErrors = verifyRuntimeFaultSoakQualification(tampered, expectation);
    expect(tamperErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('aggregate.passed'),
        expect.stringContaining('aggregate.runnerBudgetUsage.maxWallTimeMs'),
        expect.stringContaining('resources.rssBytes.samples'),
        expect.stringContaining('do not rebuild'),
      ]),
    );
  });

  test('rejects reports from a non-baseline Bun runtime', () => {
    const report = structuredClone(validReport());
    report.environment.bunVersion = '1.3.14';
    expect(verifyRuntimeFaultSoakQualification(report, expectation)).toEqual(
      expect.arrayContaining([expect.stringContaining('environment.bunVersion')]),
    );
  });

  test('rejects re-digested receipt/resource provenance mismatches', () => {
    const tampered = structuredClone(validReport());
    const longAttempt = tampered.attempts.find(
      (attempt) => attempt.caseId === 'long_runtime_replay',
    );
    if (!longAttempt?.runtimeBudgetUsage.supported) {
      throw new Error('Expected long-runtime receipt evidence');
    }
    const receipt = longAttempt.runtimeBudgetUsage.value[0]!;
    receipt.provenance!.pid += 10_000;
    (receipt as { source: string }).source = 'synthetic';
    const tuiAttempt = tampered.attempts.find(
      (attempt) => attempt.caseId === 'tui_lifecycle_churn',
    );
    const tuiMetric = tuiAttempt?.resources.rssBytes;
    if (!tuiMetric?.supported || tuiMetric.value.kind !== 'same_process_lifecycle') {
      throw new Error('Expected retained TUI lifecycle evidence');
    }
    tuiMetric.value.series[0]!.process.lifecycleId = 'unrelated-pty-parent';
    const { reportDigest: _reportDigest, ...withoutDigest } = tampered;
    tampered.reportDigest = computeRuntimeFaultSoakReportDigest(withoutDigest);

    expect(verifyRuntimeFaultSoakQualification(tampered, expectation)).toEqual(
      expect.arrayContaining([expect.stringContaining('do not rebuild')]),
    );
  });

  test('rejects re-digested provenance delimiter collisions', () => {
    const tampered = JSON.parse(JSON.stringify(validReport())) as ReturnType<typeof validReport>;
    const attempt = tampered.attempts.find(
      (entry) => entry.caseId === 'subagent_cancel_recovery' && entry.iteration === 1,
    );
    const metric = attempt?.resources.activeResources;
    if (!metric?.supported || metric.value.kind !== 'same_process_lifecycle') {
      throw new Error('Expected retained active-resource lifecycle evidence');
    }
    const process = metric.value.series[0]!.process;
    process.startNonce = `${process.startNonce}:linux`;
    process.osProcessStartIdentity = process.osProcessStartIdentity.replace(/^linux:/, '');
    const { reportDigest: _reportDigest, ...withoutDigest } = tampered;
    tampered.reportDigest = computeRuntimeFaultSoakReportDigest(withoutDigest);

    expect(verifyRuntimeFaultSoakQualification(tampered, expectation)).toEqual(
      expect.arrayContaining([expect.stringContaining('do not rebuild')]),
    );
  });

  test('rejects invalid warm-up evidence and non-exact iteration coverage', () => {
    const invalidWarmup = structuredClone(validReport());
    const warmupAttempt = invalidWarmup.attempts.find(
      (entry) => entry.caseId === 'mcp_churn' && entry.iteration === 1,
    );
    const warmupMetric = warmupAttempt?.resources.listeners;
    if (!warmupMetric?.supported || warmupMetric.value.kind !== 'same_process_lifecycle') {
      throw new Error('Expected retained listener lifecycle evidence');
    }
    warmupMetric.value.series[0]!.warmup.sequence = 1;
    warmupMetric.value.series[0]!.warmup.durationMs = -1;
    const { reportDigest: _warmupDigest, ...warmupWithoutDigest } = invalidWarmup;
    invalidWarmup.reportDigest = computeRuntimeFaultSoakReportDigest(warmupWithoutDigest);
    expect(verifyRuntimeFaultSoakQualification(invalidWarmup, expectation)).toEqual(
      expect.arrayContaining([expect.stringContaining('do not rebuild')]),
    );

    const invalidIterations = structuredClone(validReport());
    const iterationAttempt = invalidIterations.attempts.find(
      (entry) => entry.caseId === 'subagent_cancel_recovery' && entry.iteration === 1,
    );
    if (!iterationAttempt) throw new Error('Expected retained subagent attempt evidence');
    iterationAttempt.iteration = 9;
    const { reportDigest: _iterationDigest, ...iterationWithoutDigest } = invalidIterations;
    invalidIterations.reportDigest = computeRuntimeFaultSoakReportDigest(iterationWithoutDigest);
    expect(verifyRuntimeFaultSoakQualification(invalidIterations, expectation)).toEqual(
      expect.arrayContaining([expect.stringContaining('do not rebuild')]),
    );
  });

  test('keeps the workflow inputs fixed and passes them through quoted environment variables', () => {
    const workflow = readFileSync(
      join(import.meta.dir, '../../../.github/workflows/runtime-resilience-qualification.yml'),
      'utf8',
    );
    expect(workflow).toContain('timeout-minutes: 190');
    expect(workflow).toContain('type: choice');
    expect(workflow).toContain('--seed="$QUALIFICATION_SEED"');
    expect(workflow).toContain(`QUALIFICATION_WORKFLOW_REF: \${{ github.workflow_ref }}`);
    expect(workflow).toContain(`QUALIFICATION_WORKFLOW_SHA: \${{ github.workflow_sha }}`);
    expect(workflow).toContain('verify-fault-soak-qualification.ts');
    expect(workflow).not.toContain('--seed=${{');
    expect(workflow).not.toContain('--iterations=${{');
  });
});
