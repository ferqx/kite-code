import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { initializeDesktopBuildEnvironment } from '../../../../scripts/development/windows-desktop-environment';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { buildWindowsAccess } from '../../scripts/build-windows-access';

test('read receipts migrate the private SQLite file and survive separate Node processes without changing drafts', async () => {
  const root = resolve(import.meta.dir, '../../../../.cache', `turn-read-store-${randomUUID()}`);
  privateDirectory(root);
  const profile = { dataRoot: join(root, 'data'), profile: 'read-receipts' };
  const initialized = acquireProfileAccess(profile);
  privateDirectory(initialized.profilePath);
  initialized.lock.release();
  initializeDesktopBuildEnvironment();
  const asset = process.platform === 'win32' ? await buildWindowsAccess(root) : undefined;
  for (const [source, target, naming] of [
    ['../../electron/profile-access-helper.ts', 'bun', 'access.js'],
    ['../native-turn-read-store.fixture.ts', 'node', 'check.js'],
  ] as const) {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, source)],
      target,
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming,
    });
    expect(built.success).toBe(true);
  }
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const bunExecutable = realpathSync(process.execPath),
    helperPath = join(root, 'access.js');
  for (const phase of ['write', 'read']) {
    const child = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'check.js'),
        JSON.stringify({
          phase,
          profile,
          bunExecutable,
          bunSha256: sha(bunExecutable),
          helperPath,
          helperSha256: sha(helperPath),
          ...(asset
            ? { windowsAsset: { path: join(root, asset.relativePath), sha256: asset.sha256 } }
            : {}),
        }),
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const code = await child.exited;
      const output = await stdout,
        error = await stderr;
      if (code !== 0) console.error(error);
      expect(code).toBe(0);
      expect(JSON.parse(output).phase).toBe(phase);
      await Bun.write(join(root, `${phase}.json`), output);
    } finally {
      clearTimeout(timer);
    }
  }
}, 60000);
