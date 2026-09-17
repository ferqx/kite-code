import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveInstalledReleaseExecutable,
  selectKiteServiceEnvironmentSource,
  sourceServiceBuildIdentity,
} from '../../scripts/release/local-service-client';

test('managed client forwards only explicit built-in provider environment keys', () => {
  expect(
    selectKiteServiceEnvironmentSource({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENAI_API_KEY: 'openai-secret',
      OPENAI_BASE_URL: 'https://openai.example/v1',
      UNLISTED_API_KEY: 'must-not-cross',
      KITE_CODE_HOME: '/ambient',
    }),
  ).toEqual(
    expect.objectContaining({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENAI_API_KEY: 'openai-secret',
      OPENAI_BASE_URL: 'https://openai.example/v1',
    }),
  );
  const selected = selectKiteServiceEnvironmentSource({
    UNLISTED_API_KEY: 'must-not-cross',
    KITE_CODE_HOME: '/ambient',
  });
  expect(selected.UNLISTED_API_KEY).toBeUndefined();
  expect(selected.KITE_CODE_HOME).toBeUndefined();
});

test('source release build identity includes paired App Server bundle inputs', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-source-build-id-'));
  try {
    mkdirSync(join(root, 'apps', 'kite-service'), { recursive: true });
    mkdirSync(join(root, 'packages', 'fixture'), { recursive: true });
    const tracked = join(root, 'apps', 'kite-service', 'entry.ts');
    writeFileSync(tracked, 'export const value = 1;\n');
    runGit(root, ['init']);
    runGit(root, ['config', 'user.email', 'tests@kite.local']);
    runGit(root, ['config', 'user.name', 'Kite Tests']);
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);

    const clean = sourceServiceBuildIdentity(root);
    const unrelated = join(root, 'apps', 'kite-cli', 'presentation.ts');
    mkdirSync(join(root, 'apps', 'kite-cli'), { recursive: true });
    writeFileSync(unrelated, 'export const presentationOnly = true;\n');
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'unrelated cli change']);
    const committedClientChange = sourceServiceBuildIdentity(root);
    expect(committedClientChange).not.toBe(clean);

    writeFileSync(tracked, 'export const value = 2;\n');
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'service change']);
    const committedServiceChange = sourceServiceBuildIdentity(root);
    writeFileSync(tracked, 'export const value = 3;\n');
    const trackedDirty = sourceServiceBuildIdentity(root);
    writeFileSync(tracked, 'export const value = 4;\n');
    const trackedChangedAgain = sourceServiceBuildIdentity(root);
    const untracked = join(root, 'packages', 'fixture', 'new.ts');
    writeFileSync(untracked, 'export const added = true;\n');
    const withUntracked = sourceServiceBuildIdentity(root);

    expect(clean).toMatch(/^dev:[0-9a-f]{40}$/u);
    expect(committedClientChange).toMatch(/^dev:[0-9a-f]{40}$/u);
    expect(committedServiceChange).toMatch(/^dev:[0-9a-f]{40}$/u);
    expect(committedServiceChange).not.toBe(clean);
    expect(trackedDirty).toMatch(/^dev:[0-9a-f]{40}:dirty:[0-9a-f]{64}$/u);
    expect(trackedChangedAgain).not.toBe(trackedDirty);
    expect(withUntracked).not.toBe(trackedChangedAgain);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed companion resolution pins the launcher-provided immutable candidate root', () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'kite-installed-bin-')));
  try {
    const candidateRoot = join(root, 'releases', 'a'.repeat(24));
    const stableExecutable = join(root, 'bin', 'kite');
    expect(
      resolveInstalledReleaseExecutable('kite-service', {
        candidateRoot,
        executable: stableExecutable,
        platform: 'win32',
      }),
    ).toBe(join(candidateRoot, 'bin', 'kite-service.exe'));
    expect(() =>
      resolveInstalledReleaseExecutable('kite-service', {
        candidateRoot: 'relative-candidate',
        executable: stableExecutable,
      }),
    ).toThrow('not absolute');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runGit(root: string, args: readonly string[]): void {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  if (result.exitCode !== 0) {
    throw new Error(`Git fixture failed: ${result.stderr.toString()}`);
  }
}
