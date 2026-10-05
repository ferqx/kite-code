import { expect } from 'bun:test';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

export async function candidate(root: string) {
  const built = await buildTerminalBundle({ destination: join(root, 'original') });
  const moved = join(root, 'moved');
  renameSync(built.root, moved);
  const bundle = verifyTerminalRuntimeBundle(moved);
  expect(bundle.digest).toBe(built.digest);
  mkdirSync(join(root, 'probe'), { mode: 0o700 });
  const compiled = await Bun.build({
    entrypoints: [join(import.meta.dir, 'probe.ts')],
    outdir: join(root, 'probe'),
    target: 'bun',
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
  const process = Bun.spawn(
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
        ...(gate ? { KITE_RUN_UNIFIED_KEYRING_SMOKE: '1', GITHUB_ACTIONS: 'true' } : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const deadline = setTimeout(() => process.kill('SIGKILL'), 10000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(deadline);
  }
}
