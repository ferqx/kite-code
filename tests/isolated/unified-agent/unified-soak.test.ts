import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseUnifiedSoakArgs,
  prepareUnifiedSoakReportPath,
  runUnifiedSoak,
} from '../../../scripts/runtime/unified-soak';
import {
  REQUIRED_CASE_ASSERTIONS,
  UNIFIED_SOAK_CASES,
} from '../../../scripts/runtime/unified-soak-cases';
import {
  FORMAL_DURATION_MS,
  GLOBAL_DEADLINE_MS,
  QUALIFICATION_MISSING,
  qualificationMissing,
  seal,
  type UnifiedSoakReport,
  verifyUnifiedSoakReport,
} from '../../../scripts/runtime/unified-soak-report';

function packet(): UnifiedSoakReport {
  const point = (sequence: number) => ({
    sequence,
    before: {
      rssBytes: 100,
      activeResources: 1,
      fileDescriptors: null,
      listeners: null,
      handles: null,
    },
    after: {
      rssBytes: 100,
      activeResources: 1,
      fileDescriptors: null,
      listeners: null,
      handles: null,
    },
    durationMs: 10,
    assertions: ['completed', 'cancel_settled', 'reconnected_original_receipt', 'sessions_deleted'],
  });
  return seal({
    version: 1,
    runnerRevision: 'unified-soak-v1',
    profile: 'ci',
    status: 'passed',
    seed: 1729,
    source: null,
    environment: { platform: 'darwin', arch: 'arm64', bunVersion: '1.4.2' },
    durationMs: 1000,
    failures: [],
    unsupported: ['handles'],
    artifact: {
      candidateId: 'a'.repeat(64),
      probeSha256: 'b'.repeat(64),
      source: { commit: 'c'.repeat(40), dirty: true },
    },
    checkout: { commit: 'c'.repeat(40), dirty: true },
    attempts: [
      {
        iteration: 1,
        lifecycle: {
          mode: 'lifecycle',
          pid: 1,
          nonce: 'original',
          assertions: ['same_process_lifecycle'],
          calls: 4,
          points: [point(0), point(1)],
        },
        recovery: {
          mode: 'recover',
          pid: 2,
          nonce: 'recovery',
          assertions: ['zero_model_replay', 'original_execution_ids'],
          calls: 0,
          effectLedgerLines: 1,
          points: [],
        },
        crashExit: 137,
        durationMs: 1000,
        cleanupConfirmed: true,
      },
    ],
  });
}
function reseal(value: UnifiedSoakReport) {
  const { digest: _digest, ...body } = value;
  return seal(body);
}
test('macOS default workload qualification preserves the whole resource gate and cannot qualify other platforms', () => {
  expect(qualificationMissing('darwin')).toEqual([
    'process_active_resources_not_proven_on_bun',
    'process_handles',
    'owned_descendant_start_identity',
  ]);
  for (const platform of ['linux', 'win32', 'unknown']) {
    expect(qualificationMissing(platform)).toContain('qualified_background_shell');
    expect(qualificationMissing(platform)).toContain(
      'formal_continuous_workload_not_qualified_on_required_platform',
    );
  }
});
test('CI packet is diagnostic; formal qualification rejects short/local/missing telemetry', () => {
  const report = packet();
  expect(verifyUnifiedSoakReport(report, null, false)).toEqual([]);
  const errors = verifyUnifiedSoakReport(report, null, true);
  expect(errors).toContain('formal_source_invalid');
  expect(errors).toContain('formal_duration_invalid');
  expect(errors).toContain('formal_evidence_unsupported');
  expect(errors).toContain('legacy_report_not_formal');
});
test.each([
  'digest',
  'missing',
  'cleanup',
  'replay',
  'metric',
  'artifact',
  'source',
  'process',
])(`sealed packet rejects %s evidence`, (mode) => {
  let report = packet();
  if (mode === 'digest') report.durationMs++;
  if (mode === 'missing') report.attempts = [];
  if (mode === 'cleanup') report.attempts[0]!.cleanupConfirmed = false;
  if (mode === 'replay') report.attempts[0]!.recovery.calls = 1;
  if (mode === 'metric') report.attempts[0]!.lifecycle.points[0]!.before.rssBytes = -1;
  if (mode === 'artifact') report.artifact.probeSha256 = 'wrong';
  if (mode === 'process') report.attempts[0]!.recovery.pid = 1;
  if (mode === 'source')
    report.source = {
      repository: 'other/repo',
      headSha: 'a'.repeat(40),
      ref: 'refs/heads/x',
      workflow: 'runtime-resilience-qualification.yml',
      workflowRef: 'other/repo/.github/workflows/runtime-resilience-qualification.yml@x',
      workflowSha: 'b'.repeat(40),
      runId: '1',
      runAttempt: 1,
    };
  if (mode !== 'digest') report = reseal(report);
  expect(verifyUnifiedSoakReport(report, null, false).length).toBeGreaterThan(0);
});
test('malformed packet fails closed and argv has no arbitrary probe, seed or iteration override', () => {
  expect(verifyUnifiedSoakReport({} as UnifiedSoakReport, null, true)).toEqual([
    'report_structure_invalid',
  ]);
  for (const args of [
    [],
    ['--profile=ci'],
    ['--profile=ci', '--output=/tmp/x', '--iterations=1'],
    ['--profile=ci', '--profile=qualification', '--output=/tmp/x'],
  ])
    expect(() => parseUnifiedSoakArgs(args)).toThrow();
  expect(parseUnifiedSoakArgs(['--profile=ci', '--output=/tmp/x']).profile).toBe('ci');
});

test('formal retained growth and sustained slope are rejected even when packet is resealed', () => {
  const report = packet();
  const prototype = report.attempts[0]!;
  prototype.lifecycle.points = Array.from({ length: 9 }, (_, sequence) => ({
    ...prototype.lifecycle.points[0]!,
    sequence,
    before: {
      rssBytes: 100 + sequence * 40 * 1024 * 1024,
      activeResources: 1,
      fileDescriptors: 5,
      listeners: 1,
      handles: 1,
    },
    after: {
      rssBytes: 100 + sequence * 40 * 1024 * 1024,
      activeResources: 1,
      fileDescriptors: 5,
      listeners: 1,
      handles: 1,
    },
  }));
  prototype.lifecycle.workloadDurationMs = 450_000;
  report.attempts = Array.from({ length: 8 }, (_, index) => ({
    ...prototype,
    iteration: index + 1,
  }));
  report.durationMs = 3_600_000;
  const baseline = verifyUnifiedSoakReport(reseal(report), null, true);
  expect(baseline).toContain('retained_resource_growth');
  expect(baseline).not.toContain('formal_duration_invalid');
  expect(baseline).not.toContain('attempts_missing');
  report.durationMs = FORMAL_DURATION_MS - 1;
  expect(verifyUnifiedSoakReport(reseal(report), null, true)).toContain('formal_duration_invalid');
  report.durationMs = GLOBAL_DEADLINE_MS + 1;
  expect(verifyUnifiedSoakReport(reseal(report), null, true)).toContain('formal_duration_invalid');
  report.durationMs = FORMAL_DURATION_MS;
  report.attempts.pop();
  expect(verifyUnifiedSoakReport(reseal(report), null, true)).toContain('attempts_missing');
});

test.skipIf(process.platform === 'win32')(
  'source-free candidate runs actual Service/Client completion cancellation reconnect and SIGKILL original recovery',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-unified-soak-evidence-'));
    try {
      const output = join(root, 'report.json');
      const report = await runUnifiedSoak(['--profile=ci', `--output=${output}`]);
      if (report.status !== 'passed')
        console.error(JSON.stringify({ diagnostic: 'ci_failed_report', report }));
      expect(report.status).toBe('passed');
      expect(verifyUnifiedSoakReport(report, report.source, false)).toEqual([]);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(report.attempts[0]?.lifecycle.completedCycles).toBe(2);
      expect(report.attempts[0]?.lifecycle.calls).toBe(4);
      expect(report.attempts[0]?.recovery.calls).toBe(0);
      expect(report.attempts[0]?.recovery.effectLedgerLines).toBe(1);
      expect(verifyUnifiedSoakReport(report, report.source, true)).toContain(
        'formal_duration_invalid',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);

test('report fields are closed; unrelated payload is not accepted as versioned evidence', () => {
  const report = packet();
  const extended = reseal(Object.assign(report, { rawPrompt: 'never public evidence' }));
  expect(verifyUnifiedSoakReport(extended, null, false)).toEqual(['report_structure_invalid']);
});

test('formal rejects candidate and checkout dirty or foreign commit independently of report seal', () => {
  const report = packet();
  report.source = {
    repository: 'owned/repo',
    headSha: 'c'.repeat(40),
    ref: 'refs/heads/main',
    workflow: 'runtime-resilience-qualification.yml',
    workflowRef:
      'owned/repo/.github/workflows/runtime-resilience-qualification.yml@refs/heads/main',
    workflowSha: 'd'.repeat(40),
    runId: '1',
    runAttempt: 1,
  };
  expect(verifyUnifiedSoakReport(reseal(report), report.source, true)).toContain(
    'formal_candidate_checkout_source_invalid',
  );
  report.artifact.source.dirty = false;
  report.checkout.dirty = false;
  report.checkout.commit = 'e'.repeat(40);
  expect(verifyUnifiedSoakReport(reseal(report), report.source, true)).toContain(
    'formal_candidate_checkout_source_invalid',
  );
  report.checkout.commit = 'c'.repeat(40);
  expect(verifyUnifiedSoakReport(reseal(report), report.source, true)).not.toContain(
    'formal_candidate_checkout_source_invalid',
  );
});

test('blocked preflight is closed and cannot lower the formal iterations or duration contract', () => {
  expect(FORMAL_DURATION_MS).toBe(3_600_000);
  expect(GLOBAL_DEADLINE_MS).toBe(10_080_000);
  const report = packet();
  report.profile = 'qualification';
  report.status = 'inconclusive';
  report.qualificationPreflight = {
    status: 'blocked',
    requiredIterations: 8,
    minimumDurationMs: FORMAL_DURATION_MS,
    maximumDurationMs: GLOBAL_DEADLINE_MS,
    diagnosticIterations: 1,
    reasons: qualificationMissing(report.environment.platform),
  };
  expect(verifyUnifiedSoakReport(reseal(report), null, true)).toContain(
    'qualification_preflight_blocked',
  );
  expect(verifyUnifiedSoakReport(reseal(report), null, true)).toContain('attempts_missing');
  expect(verifyUnifiedSoakReport(reseal(report), null, true)).toContain('formal_duration_invalid');
  for (const change of [
    { requiredIterations: 1 },
    { minimumDurationMs: 1 },
    { maximumDurationMs: 1 },
    { diagnosticIterations: 8 },
    { reasons: [] },
    { raw: 'future' },
  ]) {
    const invalid = reseal({
      ...report,
      qualificationPreflight: { ...report.qualificationPreflight, ...change },
    } as UnifiedSoakReport);
    expect(verifyUnifiedSoakReport(invalid, null, true)).toEqual([
      'qualification_preflight_invalid',
    ]);
  }
});

test.skipIf(process.platform === 'win32')(
  'report parent creates only owned private descendants and rejects unsafe existing directories',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-soak-report-parent-')));
    try {
      const requested = join(root, 'dist', 'unified-evidence', 'report.json');
      expect(prepareUnifiedSoakReportPath(requested)).toBe(requested);
      expect(statSync(join(root, 'dist', 'unified-evidence')).mode & 0o777).toBe(0o700);
      const unsafe = join(root, 'unsafe');
      mkdirSync(unsafe, { mode: 0o700 });
      chmodSync(unsafe, 0o777);
      expect(() => prepareUnifiedSoakReportPath(join(unsafe, 'missing', 'report.json'))).toThrow(
        'report_parent_identity_invalid',
      );
      expect(existsSync(join(unsafe, 'missing'))).toBe(false);
      expect(statSync(unsafe).mode & 0o777).toBe(0o777);
      symlinkSync(join(root, 'dist'), join(root, 'alias'), 'dir');
      expect(() => prepareUnifiedSoakReportPath(join(root, 'alias', 'report.json'))).toThrow(
        'report_parent_identity_invalid',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('actual invalid qualification argv performs no report-directory or Profile I/O', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-soak-invalid-')));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '../../../scripts/runtime/unified-soak.ts'),
        '--profile=qualification',
        `--output=${join(root, 'dist/unified-evidence/report.json')}`,
        '--iterations=1',
      ],
      {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = new Response(child.stdout).text(),
      error = new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(await output).toBe('');
    expect(await error).toContain('invalid_unified_soak_argument');
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'qualification emits blocked evidence after actual bounded warmup and SIGKILL recovery instead of consuming the full formal budget',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-soak-preflight-')));
    try {
      const output = join(root, 'dist/unified-evidence/qualification.json');
      const report = await runUnifiedSoak(['--profile=qualification', `--output=${output}`]);
      if (report.status !== 'inconclusive')
        console.error(JSON.stringify({ diagnostic: 'qualification_failed_report', report }));
      expect(report.status).toBe('inconclusive');
      expect(report.failures).toEqual([]);
      expect(report.attempts.length).toBe(1);
      expect(report.attempts[0]?.lifecycle.completedCycles).toBe(2);
      expect(report.attempts[0]?.lifecycle.calls).toBe(4);
      expect(report.attempts[0]?.recovery.calls).toBe(0);
      expect(report.attempts[0]?.recovery.effectLedgerLines).toBe(1);
      expect(report.durationMs).toBeLessThan(180_000);
      expect(report.qualificationPreflight).toEqual({
        status: 'blocked',
        requiredIterations: 8,
        minimumDurationMs: FORMAL_DURATION_MS,
        maximumDurationMs: GLOBAL_DEADLINE_MS,
        diagnosticIterations: 1,
        reasons: qualificationMissing(process.platform),
      });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(verifyUnifiedSoakReport(report, report.source, true)).toContain(
        'qualification_preflight_blocked',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);

function matrixPacket() {
  const report = packet();
  report.version = 2;
  report.artifact.samplerSha256 = 'd'.repeat(64);
  report.runnerRevision = 'unified-soak-v2';
  const prototype = report.attempts[0]!;
  prototype.cases = UNIFIED_SOAK_CASES.map((caseId) => {
    const assertions = REQUIRED_CASE_ASSERTIONS[caseId].map((id) => ({
      id,
      actual: true,
      expected: true,
      passed: true,
    }));
    return {
      caseId,
      status: 'passed' as const,
      pid: 3,
      nonce: caseId,
      durationMs: 20,
      workloadDurationMs: 20,
      cleanupConfirmed: true,
      assertions,
      unavailable: [],
      ...(caseId === 'runtime_sigkill_recovery'
        ? {}
        : {
            points: [0, 1].map((sequence) => ({
              sequence,
              before: prototype.lifecycle.points[0]!.before,
              after: prototype.lifecycle.points[0]!.after,
              durationMs: 10,
              assertions,
            })),
          }),
    };
  });
  return reseal(report);
}
test('v2 matrix has fixed nested seven cases; legacy diagnostic never upgrades to formal', () => {
  expect(verifyUnifiedSoakReport(matrixPacket(), null, false)).toEqual([]);
  expect(verifyUnifiedSoakReport(packet(), null, true)).toContain('legacy_report_not_formal');
  expect(QUALIFICATION_MISSING.some((reason) => reason.includes('budget'))).toBe(false);
});
for (const mode of [
  'missing',
  'duplicate',
  'receipt',
  'future',
  'sequence',
  'deadline',
  'metric',
  'point_duration',
  'nonce',
  'unavailable',
  'duplicate_receipt',
  'sigkill_point',
  'point_deadline',
  'sampler_missing',
  'sampler_invalid',
] as const)
  test(`v2 matrix rejects ${mode} evidence`, () => {
    const report = matrixPacket(),
      cases = report.attempts[0]!.cases!;
    if (mode === 'missing') cases.pop();
    if (mode === 'duplicate') cases[1] = structuredClone(cases[0]!);
    if (mode === 'receipt') cases[0]!.assertions[0]!.actual = false;
    if (mode === 'future') Object.assign(cases[0]!, { grant: true });
    if (mode === 'sequence') cases[0]!.points![1]!.sequence = 3;
    if (mode === 'deadline') cases[0]!.durationMs = 360001;
    if (mode === 'metric') cases[0]!.points![0]!.before.rssBytes = -1;
    if (mode === 'point_duration') cases[0]!.points![0]!.durationMs = Number.NaN;
    if (mode === 'nonce') Object.assign(cases[0]!, { nonce: true });
    if (mode === 'unavailable') Object.assign(cases[0]!, { unavailable: null });
    if (mode === 'duplicate_receipt') cases[0]!.assertions.push(cases[0]!.assertions[0]!);
    if (mode === 'sigkill_point')
      Object.assign(cases[4]!, { points: [{ sequence: 0, before: null }] });
    if (mode === 'point_deadline') cases[0]!.points![0]!.durationMs = 180001;
    if (mode === 'sampler_missing') delete report.artifact.samplerSha256;
    if (mode === 'sampler_invalid') report.artifact.samplerSha256 = 'unverified';
    expect(verifyUnifiedSoakReport(reseal(report), null, false).length).toBeGreaterThan(0);
  });

test('v2 aggregate is distinct from the unchanged individual operation deadline', () => {
  const report = matrixPacket();
  const item = report.attempts[0]!.cases![0]!;
  item.durationMs = 181000;
  item.workloadDurationMs = 181000;
  for (const point of item.points!) point.durationMs = 90500;
  expect(verifyUnifiedSoakReport(reseal(report), null, false)).toEqual([]);
  item.points![1]!.durationMs = 180001;
  expect(verifyUnifiedSoakReport(reseal(report), null, false)).toContain('case_lifecycle_invalid');
});

function nativeMatrixPacket() {
  const report = matrixPacket();
  const item = report.attempts[0]!.cases![0]!;
  for (const point of item.points!) {
    const metrics = {
      rssBytes: 100,
      activeResources: null,
      fileDescriptors: 4,
      listeners: 2,
      handles: null,
    };
    const sample = {
      metrics,
      native: {
        collector: 'darwin-libproc' as const,
        pid: item.pid,
        parentPid: 1,
        startIdentity: { kind: 'darwin-start-time' as const, value: '1:2' },
        fileDescriptors: 4,
        unavailable: [],
      },
      listeners: { listeners: 2, unavailable: [] },
    };
    point.before = { ...metrics };
    point.after = { ...metrics };
    point.observations = { before: structuredClone(sample), after: structuredClone(sample) };
  }
  return report;
}
for (const mode of [
  'foreign_pid',
  'reused_pid',
  'fd_mismatch',
  'listener_mismatch',
  'future_native',
  'non_reaped',
] as const)
  test(`v2 native receipts reject ${mode}`, () => {
    const report = nativeMatrixPacket();
    expect(verifyUnifiedSoakReport(reseal(report), null, false)).toEqual([]);
    const item = report.attempts[0]!.cases![0]!,
      observation = item.points![1]!.observations!;
    if (mode === 'foreign_pid') observation.after.native.pid++;
    if (mode === 'reused_pid') {
      observation.before.native.startIdentity!.value = '3:4';
      observation.after.native.startIdentity!.value = '3:4';
    }
    if (mode === 'fd_mismatch')
      observation.after.native.fileDescriptors = observation.after.native.fileDescriptors! + 1;
    if (mode === 'listener_mismatch')
      observation.after.listeners.listeners = observation.after.listeners.listeners! + 1;
    if (mode === 'future_native') Object.assign(observation.before.native, { inferredHandles: 0 });
    if (mode === 'non_reaped') {
      const killed = report.attempts[0]!.cases![4]!;
      killed.points = item.points!.map((point) => ({
        ...structuredClone(point),
        assertions: [...killed.assertions],
        descendants: [
          {
            role: 'crash',
            native: {
              ...structuredClone(observation.before.native),
              pid: 10,
              parentPid: killed.pid,
            },
            exitCode: 137,
            reaped: true,
          },
          {
            role: 'recovery',
            native: {
              ...structuredClone(observation.before.native),
              pid: 11,
              parentPid: killed.pid,
            },
            exitCode: 0,
            reaped: true,
          },
        ],
      }));
      expect(verifyUnifiedSoakReport(reseal(report), null, false)).toEqual([]);
      Object.assign(killed.points[0]!.descendants![0]!, { reaped: false });
    }
    expect(verifyUnifiedSoakReport(reseal(report), null, false).length).toBeGreaterThan(0);
  });
