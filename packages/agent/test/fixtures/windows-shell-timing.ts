/** Explicit isolated measurement; no timing threshold or production diagnostic entry. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import type { ToolResult } from '../../src/extensions';
import { captureWindowsGitBashRuntime } from '../../src/jobs/windows-git-bash';
import { createWindowsShellJob } from '../../src/jobs/windows-shell';
import { windowsShellFixture } from './windows-shell-runtime';

if (process.platform !== 'win32') throw Error('windows_shell_measurement_requires_windows');
const root = temporaryDirectory('kite-shell-timing-');
const cwd = join(root, 'workspace'),
  control = join(root, 'control'),
  stateRoot = join(root, 'state');
for (const path of [cwd, control, stateRoot]) mkdirSync(path);
const runtime = await windowsShellFixture();
const env = { SystemRoot: process.env.SystemRoot!, Path: '' };
const factoryAt = performance.now();
const job = await createWindowsShellJob({
  cwd,
  controlBase: control,
  stateRoot,
  env,
  supervisorPath: runtime.runner,
  shellExecutable: runtime.shell,
  fullShellExecutable: runtime.fullShell,
  coreutilsPath: runtime.coreutils,
  executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
});
const factoryMs = performance.now() - factoryAt;
const samples: { synchronousMs: number; admittedMs: number; totalMs: number }[] = [];
const direct: number[] = [],
  verification: number[] = [];
let previous = performance.now(),
  maxHeartbeatMs = 0,
  confirmed = true;
const timer = setInterval(() => {
  const now = performance.now();
  maxHeartbeatMs = Math.max(maxHeartbeatMs, now - previous);
  previous = now;
}, 10);
try {
  for (let index = 0; index < 8; index++) {
    const at = performance.now();
    confirmed = false;
    const starting = job.start(
      { command: 'printf measurement-marker' },
      {
        signal: new AbortController().signal,
        executionId: crypto.randomUUID(),
        sessionId: 'measurement',
      },
    );
    const synchronousMs = performance.now() - at;
    const handle = await starting,
      admittedMs = performance.now() - at;
    let output = '',
      result: ToolResult | undefined;
    for await (const event of job.observe(handle)) {
      if (event.type === 'output') output += event.content;
      if (event.type === 'terminal') result = event.result;
    }
    await job.dispose?.(handle);
    confirmed = true;
    if (result?.outcome !== 'succeeded' || output !== 'measurement-marker')
      throw Error('windows_shell_measurement_failed');
    samples.push({ synchronousMs, admittedMs, totalMs: performance.now() - at });
  }
  clearInterval(timer);
  // This deliberately omits product authorization, identity/hash verification,
  // restricted-token ACL/Job supervision and cleanup. It is only a lower bound.
  for (let index = 0; index < 8; index++) {
    const at = performance.now();
    const child = Bun.spawn(
      [runtime.fullShell, '--noprofile', '--norc', '-c', 'printf measurement-marker'],
      {
        cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        timeout: 5000,
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0 || output !== 'measurement-marker' || error)
      throw Error('direct_bash_measurement_failed');
    direct.push(performance.now() - at);
  }
  const verify = await captureWindowsGitBashRuntime(runtime.shell, runtime.fullShell);
  for (let index = 0; index < 3; index++) {
    const at = performance.now();
    await verify(false);
    verification.push(performance.now() - at);
  }
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const result = {
    environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
    scope: 'isolated local measurement; direct Bash is a lower bound without product enforcement',
    factoryMs,
    maxHeartbeatMs,
    samples,
    direct,
    verification,
    median: {
      synchronousMs: median(samples.slice(1).map((sample) => sample.synchronousMs)),
      admittedMs: median(samples.slice(1).map((sample) => sample.admittedMs)),
      totalMs: median(samples.slice(1).map((sample) => sample.totalMs)),
      directBashMs: median(direct),
      closureVerificationMs: median(verification),
    },
  };
  const artifact = resolve(
    import.meta.dir,
    '../../../../.cache',
    `shell-timing-${crypto.randomUUID()}`,
  );
  privateDirectory(artifact);
  writeFileSync(join(artifact, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ artifact, ...result }, null, 2));
} finally {
  clearInterval(timer);
  if (confirmed) removeTemporaryDirectory(root);
  else console.error(`Unconfirmed measurement resources retained at ${root}`);
}
