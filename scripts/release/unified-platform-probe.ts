import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
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
import { dirname, isAbsolute, join, resolve } from 'node:path';

type AcquireArtifactAccess = typeof import('@kite-ai/agent/artifact-access').acquireArtifactAccess;
type VerifyTerminalRuntimeBundle =
  typeof import('@kite-ai/service/runtime-assets').verifyTerminalRuntimeBundle;

export function parseUnifiedPlatformArgs(args: readonly string[]) {
  const result: { candidate?: string; output?: string } = {};
  for (const arg of args) {
    const found = /^--(candidate|output)=(.+)$/.exec(arg);
    if (
      !found ||
      !isAbsolute(found[2]!) ||
      found[2]!.length > 4096 ||
      result[found[1] as keyof typeof result]
    )
      throw Error('unified_platform_arguments_invalid');
    result[found[1] as keyof typeof result] = found[2];
  }
  if (args.length !== 2 || !result.candidate || !result.output)
    throw Error('unified_platform_arguments_invalid');
  return { candidate: result.candidate, output: result.output };
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function sealUnifiedPlatform<T extends Record<string, unknown>>(body: T) {
  return { ...body, digest: sha(JSON.stringify(body)) };
}
function busy(root: string, acquireArtifactAccess: AcquireArtifactAccess) {
  try {
    const lock = acquireArtifactAccess({ root, mode: 'exclusive' });
    lock.release();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'owner_busy')
      return;
    throw error;
  }
  throw Error('shared_candidate_exclusive_not_busy');
}
export async function runUnifiedPlatformProbe(
  candidatePath: string,
): Promise<Record<string, unknown>> {
  const { acquireArtifactAccess } = await import('@kite-ai/agent/artifact-access');
  const { verifyTerminalRuntimeBundle } = await import('@kite-ai/service/runtime-assets');
  const sourceScriptSha256 = sha(readFileSync(import.meta.path));
  const helperPath = resolve(
    import.meta.dir,
    '../../tests/fixtures/unified-agent/unified-platform-probe.ts',
  );
  const github = {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    commit: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  };
  const base = {
    version: 1,
    effectfulQualified: false,
    productionQualified: false,
    platform: process.platform,
    arch: process.arch,
    sourceScriptSha256,
    helperSourceSha256: sha(readFileSync(helperPath)),
    github,
    missing: [
      'default_shell_not_delivered',
      'cross_platform_confinement_not_qualified',
      'native_fork_network_resource_limits_not_qualified',
    ],
  };
  let root: string | undefined,
    inputLease: ReturnType<AcquireArtifactAccess> | undefined,
    parentLease: ReturnType<AcquireArtifactAccess> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let cleanup = 'confirmed';
  let candidate: ReturnType<VerifyTerminalRuntimeBundle> | undefined;
  let result: Record<string, unknown>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    inputLease = acquireArtifactAccess({ root: candidatePath, mode: 'shared' });
    candidate = verifyTerminalRuntimeBundle(candidatePath);
    if (
      candidate.manifest.target.platform !== process.platform ||
      candidate.manifest.target.arch !== process.arch
    )
      throw Error('platform_candidate_target_mismatch');
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unified-platform-')));
    chmodSync(root, 0o700);
    const workspace = join(root, 'workspace'),
      relocated = join(workspace, 'candidate'),
      app = join(root, 'probe'),
      barrier = join(root, 'barrier');
    for (const path of [workspace, relocated, app, barrier])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const file of candidate.manifest.files) {
      const destination = join(relocated, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(join(candidate.root, file.path), destination);
      chmodSync(destination, file.mode);
    }
    for (const link of candidate.manifest.links) {
      const destination = join(relocated, link.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      symlinkSync(link.target, destination);
    }
    copyFileSync(
      join(candidate.root, 'terminal-manifest.json'),
      join(relocated, 'terminal-manifest.json'),
    );
    const moved = verifyTerminalRuntimeBundle(relocated);
    if (moved.digest !== candidate.digest) throw Error('relocated_candidate_digest_mismatch');
    parentLease = acquireArtifactAccess({ root: relocated, mode: 'shared' });
    symlinkSync(join(relocated, 'node_modules'), join(app, 'node_modules'));
    const compiled = await Bun.build({
      entrypoints: [helperPath],
      target: 'bun',
      packages: 'external',
      outdir: app,
      naming: 'probe.js',
    });
    if (!compiled.success)
      throw Error(`platform_helper_build_failed:${compiled.logs.join('\n').slice(0, 512)}`);
    const helperSha256 = sha(readFileSync(join(app, 'probe.js')));
    const runtimeSha256 = sha(readFileSync(join(relocated, moved.manifest.entries.runtime)));
    const spawned = Bun.spawn(
      [
        join(relocated, moved.manifest.entries.runtime),
        join(app, 'probe.js'),
        workspace,
        relocated,
        barrier,
      ],
      {
        cwd: workspace,
        env: { HOME: join(workspace, 'home'), PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    child = spawned;
    cleanup = 'unconfirmed';
    const output = new Response(spawned.stdout).text(),
      error = new Response(spawned.stderr).text();
    timer = setTimeout(() => {
      cleanup = 'unconfirmed';
      child?.kill('SIGKILL');
    }, 60000);
    const deadline = Date.now() + 20000;
    while (!existsSync(join(barrier, 'ready'))) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw Error(`platform_probe_ready_failed:${await error}`);
      await Bun.sleep(5);
    }
    busy(relocated, acquireArtifactAccess);
    parentLease.release();
    parentLease = undefined;
    busy(relocated, acquireArtifactAccess);
    writeFileSync(join(barrier, 'continue'), 'continue', { mode: 0o600, flag: 'wx' });
    const code = await child.exited;
    const stdout = await output,
      stderr = await error;
    if (stdout.length > 256 * 1024) throw Error('platform_probe_output_limit');
    const evidence = JSON.parse(stdout) as Record<string, unknown>;
    if (evidence.cleanup === 'confirmed') cleanup = 'confirmed';
    if (
      code !== 0 ||
      evidence.status !== 'passed' ||
      evidence.cleanup !== 'confirmed' ||
      stderr.length
    )
      throw Error(
        `platform_probe_child_failed:${code}:${String(evidence.reason ?? stderr).slice(0, 512)}`,
      );
    verifyTerminalRuntimeBundle(relocated);
    const exclusive = acquireArtifactAccess({ root: relocated, mode: 'exclusive' });
    exclusive.release();
    result = {
      ...base,
      status: 'passed',
      candidate: {
        digest: candidate.digest,
        source: candidate.manifest.source,
        sqlite: candidate.manifest.sqlite,
        runtimeSha256,
        relocated: true,
      },
      helperSha256,
      evidence,
      leases: {
        status: 'passed',
        twoIndependentShared: true,
        exclusiveAfterParentClose: 'busy',
        exclusiveAfterAllClose: 'acquired',
      },
    };
  } catch (error) {
    result = {
      ...base,
      status: 'failed',
      candidate: candidate ? { digest: candidate.digest, source: candidate.manifest.source } : null,
      reason: error instanceof Error ? error.message.slice(0, 512) : 'platform_probe_failed',
    };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      cleanup = 'unconfirmed';
      try {
        child.kill('SIGKILL');
        await child.exited;
      } catch {
        cleanup = 'unconfirmed';
      }
    }
    for (const release of [() => parentLease?.release(), () => inputLease?.release()]) {
      try {
        release();
      } catch {
        cleanup = 'unconfirmed';
      }
    }
    if (root && cleanup === 'confirmed') {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        cleanup = 'unconfirmed';
      }
    }
  }
  return sealUnifiedPlatform({
    ...result,
    cleanup,
    ...(cleanup === 'unconfirmed' ? { status: 'failed' } : {}),
  });
}
function writeReport(path: string, report: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
  if (bytes.length > 512 * 1024) throw Error('platform_report_limit');
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
if (import.meta.main) {
  const args = parseUnifiedPlatformArgs(process.argv.slice(2));
  const report = await runUnifiedPlatformProbe(args.candidate);
  writeReport(args.output, report);
  console.log(JSON.stringify(report));
  if (report.status !== 'passed') process.exitCode = 1;
}
