import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { expect, test } from '#kite-test';
import { initializeDesktopBuildEnvironment } from '../../../../scripts/development/windows-desktop-environment';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import { writeFixtureFile } from '../../../../scripts/tooling/files';
import {
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { buildWindowsAccess } from '../../scripts/build-windows-access';

test('actual Node private drafts are consumed with receipts, survive cold reads correctly, and repair legacy saved input', async () => {
  const root = resolve(
    import.meta.dirname,
    '../../../../.cache',
    `prompt-draft-store-${randomUUID()}`,
  );
  privateDirectory(root);
  const profile = { dataRoot: join(root, 'data'), profile: 'prompt-drafts' };
  const initial = acquireProfileAccess(profile);
  privateDirectory(initial.profilePath);
  initial.lock.release();
  initializeDesktopBuildEnvironment();
  const asset = process.platform === 'win32' ? await buildWindowsAccess(root) : undefined;
  const helper = await buildFixture({
    entrypoints: [resolve(import.meta.dirname, '../../electron/profile-access-helper.ts')],
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    outdir: root,
    naming: 'access.js',
  });
  expect(helper.success).toBe(true);
  const fixture = await buildFixture({
    entrypoints: [resolve(import.meta.dirname, '../native-prompt-draft-store.fixture.ts')],
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    outdir: root,
    naming: 'check.js',
  });
  expect(fixture.success).toBe(true);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const bunExecutable = realpathSync(process.execPath),
    helperPath = join(root, 'access.js');
  const child = spawnFixtureProcess(
    [
      realpathSync(findFixtureExecutable('node')!),
      join(root, 'check.js'),
      JSON.stringify({
        profile,
        runtimeExecutable: bunExecutable,
        runtimeSha256: hash(bunExecutable),
        helperPath,
        helperSha256: hash(helperPath),
        ...(asset
          ? { windowsAsset: { path: join(root, asset.relativePath), sha256: asset.sha256 } }
          : {}),
      }),
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 20000);
  try {
    const exit = await child.exited;
    const output = await stdout,
      error = await stderr;
    if (exit !== 0) console.error(error);
    expect(exit).toBe(0);
    expect(JSON.parse(output).checked).toHaveLength(12);
    await writeFixtureFile(join(root, 'result.json'), output);
  } finally {
    clearTimeout(timeout);
  }
}, 45000);
