import { type ChildProcess, spawn } from 'node:child_process';
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
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { build as bundle } from '../tooling/build';

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
async function collect(stream: Readable, limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (bytes < limit) chunks.push(chunk.subarray(0, limit - bytes));
    bytes += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), exceeded: bytes > limit };
}
export async function runUnifiedPlatformProbe(
  candidatePath: string,
): Promise<Record<string, unknown>> {
  const { acquireArtifactAccess } = await import('@kite-ai/agent/artifact-access');
  const { terminalEmptyAssetDirectories, verifyTerminalRuntimeBundle } = await import(
    '@kite-ai/service/runtime-assets'
  );
  const sourceScriptSha256 = sha(readFileSync(import.meta.filename));
  const helperPath = resolve(
    import.meta.dirname,
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
    missing:
      process.platform === 'darwin'
        ? ['cross_platform_confinement_not_qualified', 'native_resource_limits_not_qualified']
        : [
            'default_shell_not_delivered',
            'cross_platform_confinement_not_qualified',
            'native_fork_network_resource_limits_not_qualified',
          ],
  };
  let root: string | undefined,
    inputLease: ReturnType<AcquireArtifactAccess> | undefined,
    parentLease: ReturnType<AcquireArtifactAccess> | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
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
    for (const path of terminalEmptyAssetDirectories(candidate.manifest))
      mkdirSync(join(relocated, path), { recursive: true, mode: 0o700 });
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
    const node = moved.manifest.nodeVersion !== undefined;
    const helper = join(app, 'probe.mjs');
    const compiled = await bundle({
      entrypoints: [helperPath],
      target: 'node',
      packages: 'external',
      outdir: app,
      naming: 'probe.mjs',
    });
    if (!compiled.success)
      throw Error(`platform_helper_build_failed:${compiled.logs.join('\n').slice(0, 512)}`);
    const helperSha256 = sha(readFileSync(helper));
    const executable = join(relocated, moved.manifest.entries.runtime);
    const runtimeSha256 = sha(readFileSync(executable));
    const spawned = spawn(
      executable,
      [...(node ? ['--no-global-search-paths'] : []), helper, workspace, relocated, barrier],
      {
        cwd: workspace,
        env: { HOME: join(workspace, 'home'), PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = spawned;
    exited = new Promise((resolve, reject) => {
      spawned.once('error', reject);
      spawned.once('close', resolve);
    });
    cleanup = 'unconfirmed';
    const observed = Promise.all([
      exited,
      collect(spawned.stdout, 256 * 1024),
      collect(spawned.stderr, 16 * 1024),
    ]);
    void observed.catch(() => {});
    timer = setTimeout(() => spawned.kill('SIGKILL'), 60000);
    const deadline = Date.now() + 20000;
    while (!existsSync(join(barrier, 'ready'))) {
      if (spawned.exitCode !== null || spawned.signalCode !== null || !spawned.pid) {
        const [, , stderr] = await observed;
        throw Error(`platform_probe_ready_failed:${stderr.text.slice(0, 512)}`);
      }
      if (Date.now() > deadline) throw Error('platform_probe_ready_timeout');
      await sleep(5);
    }
    busy(relocated, acquireArtifactAccess);
    parentLease.release();
    parentLease = undefined;
    busy(relocated, acquireArtifactAccess);
    writeFileSync(join(barrier, 'continue'), 'continue', { mode: 0o600, flag: 'wx' });
    const [code, stdout, stderr] = await observed;
    if (stdout.exceeded || stderr.exceeded) throw Error('platform_probe_output_limit');
    if (spawned.signalCode) throw Error(`platform_probe_child_signaled:${spawned.signalCode}`);
    const evidence = JSON.parse(stdout.text) as Record<string, unknown>;
    if (evidence.cleanup === 'confirmed' && evidence.pid === spawned.pid) cleanup = 'confirmed';
    if (
      code !== 0 ||
      evidence.status !== 'passed' ||
      cleanup !== 'confirmed' ||
      evidence.runtimeVersion !== (moved.manifest.nodeVersion ?? moved.manifest.bunVersion) ||
      stderr.text.length
    )
      throw Error(
        `platform_probe_child_failed:${code}:${String(evidence.reason ?? stderr.text).slice(0, 512)}`,
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
    if (child && exited && cleanup === 'unconfirmed') {
      cleanup = 'unconfirmed';
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
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
