import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import {
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';

test('actual Node DB7 validates all leg digests, original PK/UTF8, monotone CAS, capacity and cold unknown without reissuing', async () => {
  const root = realpathSync(temporaryDirectory('kite-native-files-private-'));
  try {
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
    const initialized = acquireProfileAccess(profile);
    privateDirectory(profile.profilePath);
    initialized.lock.release();
    const helper = await buildFixture({
      entrypoints: [resolve(import.meta.dirname, '../../electron/profile-access-helper.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'helper.js',
    });
    const driver = await buildFixture({
      entrypoints: [resolve(import.meta.dirname, '../file-recovery-private-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'driver.js',
    });
    expect(helper.success).toBe(true);
    expect(driver.success).toBe(true);
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'),
      bun = realpathSync(process.execPath),
      helperPath = join(root, 'helper.js');
    const child = spawnFixtureProcess(
        [
          realpathSync(findFixtureExecutable('node')!),
          join(root, 'driver.js'),
          JSON.stringify({ dataRoot: profile.dataRoot, profile: profile.profile }),
          bun,
          sha(bun),
          helperPath,
          sha(helperPath),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      ),
      out = new Response(child.stdout).text(),
      err = new Response(child.stderr).text(),
      timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const code = await child.exited,
        stderr = await err;
      if (code) console.error(stderr);
      expect(code).toBe(0);
      expect(await out).toContain('file-recovery-private-node-qualified');
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
