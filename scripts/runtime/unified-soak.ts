import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildTerminalBundle, verifyTerminalBundle } from '../release/terminal-bundle';
import { type CaseEvidence, sampleSoakResources, UNIFIED_SOAK_CASES } from './unified-soak-cases';
import type { ContinuousEvidence } from './unified-soak-continuous';
import { observeNativeProcess, sameNativeProcess } from './unified-soak-native';
import {
  FORMAL_DURATION_MS,
  GLOBAL_DEADLINE_MS,
  type ProbeEvidence,
  QUALIFICATION_MISSING,
  type SourceIdentity,
  seal,
  UNIFIED_SOAK_REVISION,
  type UnifiedSoakReport,
  verifyUnifiedSoakReport,
} from './unified-soak-report';

export function parseUnifiedSoakArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(profile|output|candidate)=(.+)$/.exec(arg);
    if (!match || values.has(match[1]!)) throw Error('invalid_unified_soak_argument');
    values.set(match[1]!, match[2]!);
  }
  const profile = values.get('profile');
  if (profile !== 'ci' && profile !== 'qualification') throw Error('unified_soak_profile_required');
  const output = values.get('output');
  if (!output || output.length > 4096 || output.includes('\0'))
    throw Error('unified_soak_output_required');
  if (
    values.get('candidate') &&
    (values.get('candidate')!.length > 4096 || values.get('candidate')!.includes('\0'))
  )
    throw Error('invalid_unified_soak_argument');
  return { profile, output: resolve(output), candidate: values.get('candidate') } as const;
}
/** Only create missing report descendants of an observed owned, non-writable parent. */
export function prepareUnifiedSoakReportPath(output: string) {
  let current = dirname(output);
  const native =
    process.platform === 'win32'
      ? (
          require('@kite-ai/agent/windows-path-security') as typeof import('@kite-ai/agent/windows-path-security')
        ).defaultWindowsPathSecurity()
      : undefined;
  const missing: string[] = [];
  while (!existsSync(current)) {
    if (missing.length >= 64 || dirname(current) === current) throw Error('report_parent_invalid');
    missing.unshift(basename(current));
    current = dirname(current);
  }
  const verify = (path: string) => {
    const fact = lstatSync(path);
    if (!fact.isDirectory() || fact.isSymbolicLink()) throw Error('report_parent_identity_invalid');
    if (native) native.verifyDirectory(path);
    else if (fact.mode & 0o022 || (process.getuid && fact.uid !== process.getuid()))
      throw Error('report_parent_identity_invalid');
  };
  verify(current);
  current = realpathSync(current);
  verify(current);
  for (const component of missing) {
    current = join(current, component);
    if (native) native.createDirectory(current);
    else mkdirSync(current, { mode: 0o700 });
    verify(current);
  }
  return join(current, basename(output));
}
function source(): SourceIdentity | null {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;
  return {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    headSha: process.env.GITHUB_SHA ?? '',
    ref: process.env.GITHUB_REF ?? '',
    workflow: 'runtime-resilience-qualification.yml',
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? '',
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
}
async function timeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('unified_soak_deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runStableCrashSeries(
  root: string,
  cycles: 2 | 9,
  spawn: (directory: string, mode: 'crash' | 'recover') => Bun.Subprocess,
) {
  const started = performance.now();
  const points: NonNullable<CaseEvidence['points']> = [],
    identities: NonNullable<CaseEvidence['identities']> = [];
  let crashExit = 0,
    recovery!: ProbeEvidence;
  for (let sequence = 0; sequence < cycles; sequence++) {
    const cycleRoot = join(root, String(sequence));
    mkdirSync(cycleRoot, { mode: 0o700 });
    Bun.gc(true);
    await Bun.sleep(0);
    const before = sampleSoakResources(),
      pointStarted = performance.now();
    const doomed = spawn(cycleRoot, 'crash'),
      childNative = observeNativeProcess(doomed.pid);
    try {
      await timeout(
        (async () => {
          while (!existsSync(join(cycleRoot, 'crash-entered'))) {
            if (doomed.exitCode !== null) throw Error('crash_probe_early_exit');
            await Bun.sleep(10);
          }
        })(),
        180_000,
      );
      if (
        !sameNativeProcess(childNative, observeNativeProcess(doomed.pid)) ||
        childNative.parentPid !== process.pid
      )
        throw Error('crash_descendant_identity_invalid');
      doomed.kill('SIGKILL');
      crashExit = await timeout(doomed.exited, 5000);
    } finally {
      if (doomed.exitCode === null) {
        doomed.kill('SIGKILL');
        await timeout(doomed.exited, 5000);
      }
    }
    const cold = spawn(cycleRoot, 'recover'),
      coldNative = observeNativeProcess(cold.pid);
    const stderr = cold.stderr
      ? new Response(cold.stderr as ReadableStream<Uint8Array>).text()
      : Promise.resolve('');
    try {
      if ((await timeout(cold.exited, 180_000)) !== 0) {
        console.error((await stderr).slice(0, 2048));
        throw Error('recovery_probe_failed');
      }
      await stderr;
      recovery = JSON.parse(readFileSync(join(cycleRoot, 'recover.json'), 'utf8')) as ProbeEvidence;
    } finally {
      if (cold.exitCode === null) {
        cold.kill('SIGKILL');
        await timeout(cold.exited, 5000);
      }
    }
    if (
      crashExit !== 137 ||
      recovery.calls !== 0 ||
      recovery.effectLedgerLines !== 1 ||
      coldNative.parentPid !== process.pid
    )
      throw Error('crash_recovery_receipt_invalid');
    if (
      !recovery.identities?.length ||
      recovery.identities.some(
        (identity) =>
          !identity.storeId ||
          !identity.sessionId ||
          !identity.runId ||
          !identity.executionId ||
          !identity.commandId,
      )
    )
      throw Error('crash_original_identity_invalid');
    identities.push(...(recovery.identities ?? []));
    rmSync(cycleRoot, { recursive: true });
    Bun.gc(true);
    await Bun.sleep(0);
    const after = sampleSoakResources();
    const assertions = [
      ...['unknown_retained', 'original_execution_ids'].map((id) => ({
        id,
        actual: recovery.assertions.includes(id),
        expected: true,
        passed: recovery.assertions.includes(id),
      })),
      {
        id: 'zero_model_replay',
        actual: recovery.calls,
        expected: 0,
        passed: recovery.calls === 0,
      },
      {
        id: 'effect_ledger_exact',
        actual: recovery.effectLedgerLines!,
        expected: 1,
        passed: recovery.effectLedgerLines === 1,
      },
    ];
    const durationMs = performance.now() - pointStarted;
    if (durationMs > 180_000) throw Error('operation_deadline');
    points.push({
      sequence,
      before: before.metrics,
      after: after.metrics,
      observations: { before, after },
      identities: recovery.identities,
      durationMs,
      assertions,
      descendants: [
        { role: 'crash', native: childNative, exitCode: crashExit, reaped: true },
        { role: 'recovery', native: coldNative, exitCode: 0, reaped: true },
      ],
    });
  }
  return { points, identities, crashExit, recovery, durationMs: performance.now() - started };
}
export async function runUnifiedSoak(args: readonly string[]): Promise<UnifiedSoakReport> {
  const options = parseUnifiedSoakArgs(args),
    repositoryRoot = resolve(import.meta.dir, '../..');
  const output = prepareUnifiedSoakReportPath(options.output);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unified-soak-')));
  const started = performance.now();
  const failures: string[] = [],
    attempts: UnifiedSoakReport['attempts'] = [];
  const unsupported = [...QUALIFICATION_MISSING];
  const qualificationBlocked = options.profile === 'qualification' && unsupported.length > 0;
  const formalWorkload = options.profile === 'qualification' && !qualificationBlocked;
  let candidateId = '',
    probeSha256 = '',
    samplerSha256 = '';
  let candidateSource = { commit: '', dirty: true };
  const checkout = () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 1000,
    });
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 1000,
    });
    return {
      commit: head.status === 0 ? head.stdout.trim() : '',
      dirty: status.status !== 0 || !!status.stdout.trim(),
    };
  };
  const maximumMs = formalWorkload ? GLOBAL_DEADLINE_MS : 180_000;
  try {
    const candidate = options.candidate
      ? verifyTerminalBundle(resolve(options.candidate))
      : await buildTerminalBundle({ destination: join(root, 'candidate'), repositoryRoot });
    candidateId = candidate.candidateId;
    candidateSource = candidate.manifest.source;
    symlinkSync(
      join(candidate.root, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const built = await Bun.build({
      entrypoints: [
        join(repositoryRoot, 'scripts/runtime/unified-soak-probe.ts'),
        join(repositoryRoot, 'scripts/runtime/unified-soak-cases.ts'),
      ],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    if (!built.success) throw Error('unified_soak_probe_build_failed');
    const probe = join(root, 'unified-soak-probe.js');
    probeSha256 = createHash('sha256').update(readFileSync(probe)).digest('hex');
    samplerSha256 = createHash('sha256')
      .update(readFileSync(join(root, 'unified-soak-cases.js')))
      .digest('hex');
    const spawn = (
      directory: string,
      mode: string,
      cycles: number,
      minimumMs: number | string = 0,
    ) =>
      Bun.spawn(
        [
          join(candidate.root, 'runtime/bun'),
          probe,
          directory,
          mode,
          String(cycles),
          String(minimumMs),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? '',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            HOME: join(root, 'home'),
            KITE_CODE_HOME: join(root, 'home/.kite-code'),
            TMPDIR: root,
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );
    mkdirSync(join(root, 'home'), { mode: 0o700 });
    const iterations = formalWorkload ? 8 : 1;
    for (let iteration = 1; iteration <= iterations; iteration++) {
      const attemptStarted = performance.now();
      const directory = join(root, `attempt-${iteration}`),
        live = join(directory, 'live'),
        crash = join(directory, 'crash');
      mkdirSync(live, { recursive: true, mode: 0o700 });
      mkdirSync(crash, { mode: 0o700 });
      const run = async <T = ProbeEvidence>(
        dir: string,
        mode: string,
        cycles: number,
        minimumMs: number | string = 0,
      ) => {
        if (maximumMs - (performance.now() - started) <= 30_000)
          throw Error('unified_soak_deadline');
        const child = spawn(dir, mode, cycles, minimumMs);
        try {
          const code = await timeout(
            child.exited,
            Math.max(1, maximumMs - (performance.now() - started) - 30_000),
          );
          const stderr = await timeout(new Response(child.stderr).text(), 2000);
          if (code !== 0) {
            console.error(stderr.slice(0, 2048));
            throw Error('unified_soak_probe_failed');
          }
          return JSON.parse(readFileSync(join(dir, `${mode}.json`), 'utf8')) as T;
        } finally {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
            await timeout(child.exited, 5000);
          }
        }
      };
      const lifecycle = await run(
        live,
        'lifecycle',
        formalWorkload ? 9 : 2,
        formalWorkload ? FORMAL_DURATION_MS / 8 : 0,
      );
      if (maximumMs - (performance.now() - started) <= 30_000) throw Error('unified_soak_deadline');
      const crashed = await runStableCrashSeries(crash, formalWorkload ? 9 : 2, (directory, mode) =>
        spawn(directory, mode, mode === 'crash' ? 1 : 0),
      );
      const {
        recovery,
        crashExit,
        points: crashPoints,
        identities: crashIdentities,
        durationMs: crashDuration,
      } = crashed;
      const artifactFile = join(root, 'selected-artifact.json');
      writeFileSync(artifactFile, JSON.stringify(candidate.artifact), { mode: 0o600 });
      const matrix = (await run(
        live,
        'cases',
        formalWorkload ? 9 : 2,
        artifactFile,
      )) as unknown as CaseEvidence[];
      const crashCase: CaseEvidence = {
        caseId: 'runtime_sigkill_recovery',
        identities: crashIdentities,
        status: 'passed',
        pid: process.pid,
        nonce: randomUUID(),
        points: crashPoints,
        durationMs: crashDuration,
        workloadDurationMs: crashDuration,
        cleanupConfirmed: true,
        unavailable: [],
        assertions: [
          {
            id: 'unknown_retained',
            actual: recovery.assertions.includes('unknown_retained'),
            expected: true,
            passed: recovery.assertions.includes('unknown_retained'),
          },
          {
            id: 'original_execution_ids',
            actual: recovery.assertions.includes('original_execution_ids'),
            expected: true,
            passed: recovery.assertions.includes('original_execution_ids'),
          },
          {
            id: 'zero_model_replay',
            actual: recovery.calls,
            expected: 0,
            passed: recovery.calls === 0,
          },
          {
            id: 'effect_ledger_exact',
            actual: recovery.effectLedgerLines ?? 0,
            expected: 1,
            passed: recovery.effectLedgerLines === 1,
          },
        ],
      };
      const cases = UNIFIED_SOAK_CASES.map((id) =>
        id === 'runtime_sigkill_recovery' ? crashCase : matrix.find((item) => item.caseId === id)!,
      );

      const continuousRoot = join(directory, 'continuous');
      mkdirSync(continuousRoot, { mode: 0o700 });
      const continuous = await run<ContinuousEvidence>(
        continuousRoot,
        'continuous',
        0,
        formalWorkload ? 'formal' : 'diagnostic',
      );
      if (crashExit !== 137) throw Error('sigkill_exit_unconfirmed');
      rmSync(directory, { recursive: true });
      attempts.push({
        cases,
        continuous,
        iteration,
        lifecycle,
        recovery,
        crashExit,
        durationMs: performance.now() - attemptStarted,
        cleanupConfirmed: !existsSync(directory),
      });
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    failures.push(/^[a-z_]+$/.test(code) ? code : 'unified_soak_operation_failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const body = {
    version: 2 as const,
    runnerRevision: UNIFIED_SOAK_REVISION,
    profile: options.profile,
    status: (failures.length
      ? 'failed'
      : options.profile === 'qualification'
        ? 'inconclusive'
        : 'passed') as UnifiedSoakReport['status'],
    seed: 1729 as const,
    source: source(),
    environment: { platform: process.platform, arch: process.arch, bunVersion: Bun.version },
    durationMs: performance.now() - started,
    failures,
    unsupported,
    artifact: { candidateId, probeSha256, samplerSha256, source: candidateSource },
    checkout: checkout(),
    attempts,
    ...(qualificationBlocked
      ? {
          qualificationPreflight: {
            status: 'blocked' as const,
            requiredIterations: 8 as const,
            minimumDurationMs: FORMAL_DURATION_MS,
            maximumDurationMs: GLOBAL_DEADLINE_MS,
            diagnosticIterations: 1 as const,
            reasons: unsupported,
          },
        }
      : {}),
  };
  let report = seal(body);
  if ((options.profile === 'ci' || qualificationBlocked) && !failures.length) {
    const { qualificationPreflight: _preflight, ...diagnostic } = body;
    const errors = verifyUnifiedSoakReport(
      seal({ ...diagnostic, profile: 'ci', status: 'passed' }),
      report.source,
      false,
    );
    if (errors.length) report = seal({ ...body, status: 'failed', failures: errors });
  }
  if (formalWorkload && !failures.length) {
    const errors = verifyUnifiedSoakReport(report, report.source, true);
    const hard = errors.filter((code) =>
      [
        'retained_resource_growth',
        'lifecycle_evidence_invalid',
        'recovery_evidence_invalid',
        'continuous_workload_missing',
        'attempt_identity_or_cleanup_invalid',
      ].includes(code),
    );
    if (hard.length) report = seal({ ...body, status: 'failed', failures: hard });
  }
  if (process.platform === 'win32') {
    const native = (
      require('@kite-ai/agent/windows-path-security') as typeof import('@kite-ai/agent/windows-path-security')
    ).defaultWindowsPathSecurity()!;
    native.writePrivateFile(output, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    return report;
  }
  const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const fact = fstatSync(fd);
    if (
      !fact.isFile() ||
      fact.nlink !== 1 ||
      (fact.mode & 0o777) !== 0o600 ||
      (process.getuid && fact.uid !== process.getuid())
    )
      throw Error('report_file_identity_invalid');
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return report;
}
if (import.meta.main) {
  try {
    const report = await runUnifiedSoak(process.argv.slice(2));
    console.log(
      JSON.stringify({
        status: report.status,
        profile: report.profile,
        digest: report.digest,
        attempts: report.attempts.length,
      }),
    );
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'unified_soak_failed');
    process.exitCode = 2;
  }
}
