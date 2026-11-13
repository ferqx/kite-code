import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import { expect } from '#kite-test';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { build as buildFixture } from '../../../scripts/tooling/build';
import { spawn as spawnFixtureProcess } from '../../../scripts/tooling/process';

export async function candidate(root: string) {
  const built = await buildTerminalBundle({ destination: join(root, 'original') });
  const moved = join(root, 'moved');
  renameSync(built.root, moved);
  const bundle = verifyTerminalRuntimeBundle(moved);
  expect(bundle.digest).toBe(built.digest);
  mkdirSync(join(root, 'probe'), { mode: 0o700 });
  const compiled = await buildFixture({
    entrypoints: [join(import.meta.dirname, 'probe.ts')],
    outdir: join(root, 'probe'),
    target: 'node',
    packages: 'external',
    naming: 'probe.js',
  });
  expect(compiled.success).toBe(true);
  return { bundle, probe: join(root, 'probe/probe.js') };
}
export async function probe(
  input: Awaited<ReturnType<typeof candidate>>,
  mode: string,
  home: string,
  identityPath?: string,
  gate = false,
) {
  const child = spawnFixtureProcess(
    [
      join(input.bundle.root, input.bundle.manifest.entries.runtime),
      input.probe,
      input.bundle.root,
      mode,
      ...(identityPath ? [identityPath] : []),
    ],
    {
      cwd: home,
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
        ...(gate && process.platform === 'linux'
          ? {
              DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
              XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
            }
          : {}),
        ...(gate ? { KITE_RUN_UNIFIED_KEYRING_SMOKE: '1', GITHUB_ACTIONS: 'true' } : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(deadline);
  }
}
