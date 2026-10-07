import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertSqliteReleaseIdentity,
  parseSqliteReleaseIdentity,
} from '@kite-ai/service/sqlite-release-assets';
import { runNativeRelease } from '../../../scripts/release/native';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { runUnifiedRelease } from '../../../scripts/release/unified';

const repositoryRoot = resolve(import.meta.dir, '../../..');
test('reviewed Linux builtin source is exact; version ranges, near hashes and extra metadata cannot approve an engine', () => {
  const identity = {
    driver: 'bun:sqlite',
    linkage: 'builtin',
    version: '3.53.2',
    sourceId:
      '2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24',
  } as const;
  expect(parseSqliteReleaseIdentity(identity)).toEqual(identity);
  assertSqliteReleaseIdentity(identity, identity);
  for (const value of [
    { ...identity, sourceId: `${identity.sourceId.slice(0, -1)}0` },
    { ...identity, version: '3.53.1' },
    { ...identity, version: '3.53.3' },
    { ...identity, version: '999.0.0' },
    { ...identity, linkage: 'system' },
    { ...identity, driver: 'node:sqlite', linkage: 'dynamic' },
    { ...identity, reviewed: true },
  ])
    expect(() => parseSqliteReleaseIdentity(value)).toThrow('sqlite_release_identity_invalid');
  expect(() =>
    assertSqliteReleaseIdentity(identity, {
      version: identity.version,
      sourceId: `${identity.sourceId.slice(0, -1)}0`,
    }),
  ).toThrow('sqlite_release_identity_mismatch');
});
async function execute(entry: string, argv: string[], cwd: string, home: string) {
  const child = Bun.spawn(
    [process.execPath, join(repositoryRoot, 'scripts/release', entry), ...argv],
    {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
test('actual release argv help and rejected installation inputs leave absent assets and private profiles untouched', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-release-tools-pure-'))),
    home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  try {
    for (const entry of ['unified.ts', 'native.ts']) {
      for (const argv of [['--help'], ['build', '--help']]) {
        const value = await execute(entry, argv, root, home);
        expect(value.code).toBe(0);
        expect(value.stdout).toContain('candidate');
        expect(value.stderr).toBe('');
      }
      for (const argv of [
        ['install'],
        ['install', '--prefix', join(root, 'managed')],
        [
          'install',
          '--archive',
          join(root, 'secret-name'),
          '--sha256',
          'invalid',
          '--prefix',
          join(root, 'managed'),
        ],
        ['build', '--directory'],
        ['verify', '--directory', 'a', '--directory', 'b'],
        ['verify', '--directory', '/absent', '--clean-source', 'false'],
        ['verify', '--directory', '/absent', '--source-commit', 'not-a-commit'],
        ['uninstall'],
        ['smoke', '--unexpected', 'private-value'],
      ]) {
        const value = await execute(entry, argv, root, home);
        expect(value.code).toBe(1);
        expect(value.stdout).toBe('');
        expect(value.stderr).toBe('release_arguments_invalid\n');
      }
    }
    await expect(runUnifiedRelease(['build', '--product', 'invalid'], root)).rejects.toThrow(
      'release_arguments_invalid',
    );
    await expect(runUnifiedRelease(['build', '--electron', '/absent'], root)).rejects.toThrow(
      'release_arguments_invalid',
    );
    await expect(runNativeRelease(['pack'], root)).rejects.toThrow('release_arguments_invalid');
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(root)).toEqual(['home']);
    expect(existsSync(join(root, 'managed'))).toBe(false);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('current formal release smoke uses a fresh complete candidate for daemon identity and readonly Web, then confirms stop', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-release-tools-actual-')));
  try {
    const bundle = await buildTerminalBundle({
      destination: join(root, 'candidate'),
      repositoryRoot,
      bunExecutable: process.execPath,
    });
    const result = await runUnifiedRelease(['smoke', '--directory', bundle.root]);
    expect(result).toEqual({
      candidateId: bundle.candidateId,
      buildId: bundle.buildId,
      entry: true,
      daemon: true,
      web: true,
      cleanup: true,
      modelInvoked: false,
    });
    const verified = await runUnifiedRelease(['verify', '--directory', bundle.root]);
    expect(verified).toMatchObject({ root: bundle.root, candidateId: bundle.candidateId });
    const sourceVerified = await runUnifiedRelease([
      'verify',
      '--directory',
      bundle.root,
      '--source-commit',
      bundle.manifest.source.commit,
    ]);
    expect(sourceVerified).toMatchObject({ candidateId: bundle.candidateId });
    await expect(
      runUnifiedRelease(['verify', '--directory', bundle.root, '--source-commit', '0'.repeat(40)]),
    ).rejects.toThrow('release_source_mismatch');
    const cleanVerification = runUnifiedRelease([
      'verify',
      '--directory',
      bundle.root,
      '--clean-source',
      'true',
    ]);
    if (bundle.manifest.source.dirty)
      await expect(cleanVerification).rejects.toThrow('release_source_mismatch');
    else
      await expect(cleanVerification).resolves.toMatchObject({ candidateId: bundle.candidateId });
    console.log(
      JSON.stringify({
        qualification: 'release-tools',
        buildId: bundle.buildId,
        ...(result as object),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
