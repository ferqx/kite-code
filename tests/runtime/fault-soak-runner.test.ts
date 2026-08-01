import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readOsProcessStartIdentity } from '../../scripts/runtime/process-start-identity';
import {
  boundedFaultSoakProbeTimeoutMs,
  buildFaultSoakProbeArgs,
  captureBounded,
  parseRuntimeFaultSoakOptions,
  qualificationTelemetryMetric,
  type RuntimeBudgetTelemetryRecord,
  runtimeBudgetUsage,
  type TelemetryRecord,
  TUI_FAULT_SOAK_PROBE_ARGS,
  terminateFaultSoakProcessTree,
} from '../../scripts/runtime/run-fault-soak';

function telemetryRecord(
  sequence: number,
  rssBytes: number,
  overrides: Partial<Pick<TelemetryRecord, 'pid' | 'caseId' | 'lifecycleId'>> = {},
): TelemetryRecord {
  const sample = {
    rssBytes,
    activeResources: 1,
    fileDescriptors: 5,
    listeners: 0,
    handles: 0,
  };
  return {
    version: 2,
    kind: 'process_resource',
    pid: overrides.pid ?? 42,
    parentPid: 1,
    sequence,
    caseId: overrides.caseId ?? 'long_runtime_replay',
    lifecycleId: overrides.lifecycleId ?? 'bun-test-probe',
    processStartNonce: `attempt-nonce:${overrides.pid ?? 42}`,
    osProcessStartIdentity: `os-start-${overrides.pid ?? 42}`,
    lifecycleGroupNonce: 'lifecycle-group-nonce',
    durationMs: 10,
    deadlineMs: 1000,
    cleanup: {
      confirmed: true,
      descendantInspectionSupported: true,
      descendantPidsAfter: [],
    },
    before: sample,
    after: sample,
  };
}

describe('runtime fault soak runner', () => {
  let processInspectionAvailable = false;
  if (process.platform !== 'win32') {
    try {
      processInspectionAvailable =
        Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], {
          stdout: 'ignore',
          stderr: 'ignore',
        }).exitCode === 0;
    } catch {
      processInspectionAvailable = false;
    }
  }
  const posixInspectionTest = processInspectionAvailable ? test : test.skip;

  test('uses bounded profile defaults and accepts explicit overrides', () => {
    expect(parseRuntimeFaultSoakOptions([])).toMatchObject({
      profile: 'ci',
      iterations: 1,
      seed: 1729,
      perCaseTimeoutMs: 120_000,
      source: { kind: 'local' },
    });
    expect(
      parseRuntimeFaultSoakOptions([
        '--profile=qualification',
        '--iterations',
        '9',
        '--seed=23',
        '--timeout-ms',
        '4567',
      ]),
    ).toMatchObject({
      profile: 'qualification',
      iterations: 9,
      seed: 23,
      perCaseTimeoutMs: 4567,
    });
  });

  test('requires the complete GitHub Actions source identity as one unit', () => {
    expect(() => parseRuntimeFaultSoakOptions(['--source-repository=ferqx/kite-code'])).toThrow(
      'must be supplied together',
    );
    expect(
      parseRuntimeFaultSoakOptions([
        '--source-repository=ferqx/kite-code',
        `--source-head-sha=${'a'.repeat(40)}`,
        '--source-ref=refs/heads/main',
        '--source-workflow=runtime-resilience-qualification.yml',
        '--source-workflow-ref=ferqx/kite-code/.github/workflows/runtime-resilience-qualification.yml@refs/heads/main',
        `--source-workflow-sha=${'a'.repeat(40)}`,
        '--source-run-id=30700000000',
        '--source-run-attempt=2',
      ]),
    ).toMatchObject({
      source: {
        kind: 'github_actions',
        repository: 'ferqx/kite-code',
        runId: '30700000000',
        runAttempt: 2,
      },
    });
  });

  test('reserves a bounded settle window inside the runner-wide hard deadline', () => {
    expect(boundedFaultSoakProbeTimeoutMs(180_000, 500_000)).toBe(180_000);
    expect(boundedFaultSoakProbeTimeoutMs(180_000, 60_000)).toBe(30_000);
    expect(boundedFaultSoakProbeTimeoutMs(180_000, 30_000)).toBeUndefined();
  });

  test('keeps the seed at the case scheduler and only reruns qualification test probes', () => {
    const ci = buildFaultSoakProbeArgs(['test', 'tests/runtime/stability.test.ts'], 'ci');
    const qualification = buildFaultSoakProbeArgs(
      ['test', 'tests/runtime/stability.test.ts'],
      'qualification',
    );
    const tui = buildFaultSoakProbeArgs(
      ['run', 'scripts/run-tui-system-tests.ts'],
      'qualification',
    );

    expect(ci).not.toContain('--seed');
    expect(qualification).not.toContain('--seed');
    expect(qualification).toContain('--repeat-count');
    expect(qualification).toContain('9');
    expect(qualification[0]).toBe('run');
    expect(tui).toEqual(['run', 'scripts/run-tui-system-tests.ts']);
  });

  test('binds TUI churn evidence to the explicit lifecycle harness and isolated scenarios', () => {
    expect(TUI_FAULT_SOAK_PROBE_ARGS).toEqual([
      'run',
      'scripts/run-tui-system-tests.ts',
      '--with-lifecycle-harness',
      'session-switch',
      'tool-lifecycle',
      'model-stream-reconnect',
    ]);
  });

  posixInspectionTest(
    'reaps nested detached process groups when the outer soak probe times out',
    async () => {
      const fixture = join(import.meta.dir, '..', 'fixtures', 'fault-soak-nested-process-tree.ts');
      const proc = Bun.spawn([process.execPath, fixture], {
        detached: true,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const identities = new Map<number, string>();
      try {
        const reader = proc.stdout.getReader();
        let output = '';
        while (output.trim().split(/\s+/).length < 2) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        const nestedPids = output.trim().split(/\s+/).map(Number);
        expect(nestedPids).toHaveLength(2);
        expect(nestedPids.every(Number.isInteger)).toBe(true);
        for (const pid of nestedPids) {
          const identity = readOsProcessStartIdentity(pid);
          if (identity) identities.set(pid, identity);
        }

        terminateFaultSoakProcessTree(proc, identities);
        await proc.exited;
        for (const pid of nestedPids) {
          let gone = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
              if (gone) break;
            }
            await Bun.sleep(25);
          }
          expect(gone).toBe(true);
        }
      } finally {
        terminateFaultSoakProcessTree(proc, identities);
        if (proc.exitCode === null) {
          await proc.exited.catch(() => {});
        }
      }
    },
  );

  test('derives qualification metrics only after a same-process warm-up rerun', () => {
    const records = [100, 110, 120, 130, 140, 150, 160, 170, 180].map((rssBytes, index) =>
      telemetryRecord(index + 1, rssBytes),
    );

    const metric = qualificationTelemetryMetric(records, 'rssBytes', {
      caseId: 'long_runtime_replay',
      repeatCount: 9,
      expectedLifecycleIds: new Set(['bun-test-probe']),
      attemptNonce: 'attempt-nonce',
    });
    expect(metric).toMatchObject({ supported: true });
    if (!metric.supported || metric.value.kind !== 'same_process_lifecycle') {
      throw new Error('Expected same-process lifecycle telemetry');
    }
    expect(metric.value.series).toHaveLength(1);
    expect(metric.value.series[0]).toMatchObject({
      process: { pid: 42, startNonce: 'attempt-nonce:42' },
      warmup: { sequence: 0, before: 100, after: 100 },
    });
    expect(metric.value.series[0]?.lifecycles).toHaveLength(8);
    expect(metric.value.series[0]?.lifecycles[0]).toMatchObject({
      sequence: 1,
      before: 110,
      after: 110,
    });
    expect(metric.value.series[0]?.lifecycles[7]).toMatchObject({
      sequence: 8,
      before: 180,
      after: 180,
    });
  });

  test('rejects incomplete or cross-process qualification telemetry', () => {
    const incomplete = Array.from({ length: 8 }, (_, index) =>
      telemetryRecord(index + 1, 100 + index),
    );
    expect(
      qualificationTelemetryMetric(incomplete, 'rssBytes', {
        caseId: 'long_runtime_replay',
        repeatCount: 9,
        expectedLifecycleIds: new Set(['bun-test-probe']),
        attemptNonce: 'attempt-nonce',
      }),
    ).toMatchObject({ supported: false });
    expect(
      qualificationTelemetryMetric(
        Array.from({ length: 9 }, (_, index) =>
          telemetryRecord(index + 1, 100 + index, { pid: index === 4 ? 43 : 42 }),
        ),
        'rssBytes',
        {
          caseId: 'long_runtime_replay',
          repeatCount: 9,
          expectedLifecycleIds: new Set(['bun-test-probe']),
          attemptNonce: 'attempt-nonce',
        },
      ),
    ).toMatchObject({ supported: false });
  });

  test('rejects telemetry when any declared qualification lifecycle is omitted', () => {
    const records = Array.from({ length: 9 }, (_, index) =>
      telemetryRecord(index + 1, 100 + index, { lifecycleId: 'stability.test.ts' }),
    );

    expect(
      qualificationTelemetryMetric(records, 'rssBytes', {
        caseId: 'long_runtime_replay',
        repeatCount: 9,
        expectedLifecycleIds: new Set(['stability.test.ts', 'fault-soak-runtime-budget.test.ts']),
        attemptNonce: 'attempt-nonce',
      }),
    ).toMatchObject({
      supported: false,
      reason: expect.stringContaining('fault-soak-runtime-budget.test.ts'),
    });
  });

  test('retains both declared long-runtime lifecycle groups for 16 samples per attempt', () => {
    const records = [
      ...Array.from({ length: 9 }, (_, index) =>
        telemetryRecord(index + 1, 100 + index, {
          pid: 42,
          lifecycleId: 'stability.test.ts',
        }),
      ),
      ...Array.from({ length: 9 }, (_, index) =>
        telemetryRecord(index + 1, 200 + index, {
          pid: 43,
          lifecycleId: 'fault-soak-runtime-budget.test.ts',
        }),
      ),
    ];
    const metric = qualificationTelemetryMetric(records, 'rssBytes', {
      caseId: 'long_runtime_replay',
      repeatCount: 9,
      expectedLifecycleIds: new Set(['stability.test.ts', 'fault-soak-runtime-budget.test.ts']),
      attemptNonce: 'attempt-nonce',
    });
    expect(metric).toMatchObject({ supported: true });
    if (!metric.supported || metric.value.kind !== 'same_process_lifecycle') {
      throw new Error('Expected two long-runtime lifecycle groups');
    }
    expect(metric.value.series).toHaveLength(2);
    expect(metric.value.series.flatMap((series) => series.lifecycles)).toHaveLength(16);
  });

  test('rejects a budget group contaminated by a wrong-attempt receipt', () => {
    const receipt = (processStartNonce: string): RuntimeBudgetTelemetryRecord => ({
      version: 2,
      kind: 'runtime_budget_usage',
      pid: 42,
      sequence: 1,
      iteration: 1,
      caseId: 'long_runtime_replay',
      lifecycleId: 'fault-soak-runtime-budget.test.ts',
      processStartNonce,
      osProcessStartIdentity: 'os-start-42',
      lifecycleGroupNonce: 'budget-group',
      source: 'actual_runtime_ledger',
      reconciled: { counters: { modelRequests: 1 }, gauges: {} },
      committed: { counters: { modelRequests: 1 }, gauges: {} },
      ceilings: { maxModelRequests: 60 },
      reservationStates: { reconciled: 1 },
    });

    expect(
      runtimeBudgetUsage(
        [receipt('attempt-nonce:42'), receipt('different-attempt:42')],
        [
          telemetryRecord(1, 100, {
            caseId: 'long_runtime_replay',
            lifecycleId: 'fault-soak-runtime-budget.test.ts',
          }),
        ],
        'long_runtime_replay',
        'attempt-nonce',
        1,
        1,
      ),
    ).toMatchObject({
      supported: false,
      reason: expect.stringContaining('wrong-attempt'),
    });
  });

  test('rejects a budget receipt whose OS identity does not match its resource lifecycle', () => {
    const receipt: RuntimeBudgetTelemetryRecord = {
      version: 2,
      kind: 'runtime_budget_usage',
      pid: 42,
      sequence: 1,
      iteration: 1,
      caseId: 'long_runtime_replay',
      lifecycleId: 'fault-soak-runtime-budget.test.ts',
      processStartNonce: 'attempt-nonce:42',
      osProcessStartIdentity: 'polluted-os-start',
      lifecycleGroupNonce: 'lifecycle-group-nonce',
      source: 'actual_runtime_ledger',
      reconciled: { counters: { modelRequests: 1 }, gauges: {} },
      committed: { counters: { modelRequests: 1 }, gauges: {} },
      ceilings: { maxModelRequests: 60 },
      reservationStates: { reconciled: 1 },
    };
    const resource = telemetryRecord(1, 100, {
      caseId: 'long_runtime_replay',
      lifecycleId: 'fault-soak-runtime-budget.test.ts',
    });

    expect(
      runtimeBudgetUsage([receipt], [resource], 'long_runtime_replay', 'attempt-nonce', 1, 1),
    ).toMatchObject({
      supported: false,
      reason: expect.stringContaining('did not match'),
    });
  });

  test('selects the dedicated TUI mount lifecycle instead of unrelated PTY parents', () => {
    const records = [
      ...Array.from({ length: 9 }, (_, index) =>
        telemetryRecord(index + 1, 1 + index, {
          pid: 70,
          caseId: 'tui_lifecycle_churn',
          lifecycleId: 'session-switch.test.ts',
        }),
      ),
      ...Array.from({ length: 9 }, (_, index) =>
        telemetryRecord(index + 1, 10 + index, {
          pid: 71,
          caseId: 'tui_lifecycle_churn',
          lifecycleId: 'tui-input-focus-lifecycle',
        }),
      ),
    ];

    const metric = qualificationTelemetryMetric(records, 'rssBytes', {
      caseId: 'tui_lifecycle_churn',
      repeatCount: 9,
      expectedLifecycleIds: new Set(['tui-input-focus-lifecycle']),
      attemptNonce: 'attempt-nonce',
    });
    expect(metric).toMatchObject({ supported: true });
    if (!metric.supported || metric.value.kind !== 'same_process_lifecycle') {
      throw new Error('Expected TUI same-process lifecycle telemetry');
    }
    expect(metric.value.series).toHaveLength(1);
    expect(metric.value.series[0]?.process.pid).toBe(71);
    expect(metric.value.series[0]?.lifecycles).toHaveLength(8);
  });

  test('ends output capture when an inherited pipe never reaches EOF', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial output'));
      },
    });
    const abort = new AbortController();
    const startedAt = performance.now();
    setTimeout(() => abort.abort(), 10);

    const output = await captureBounded(stream, abort.signal);

    expect(output).toContain('partial output');
    expect(output).toContain('bounded drain deadline');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
