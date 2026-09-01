import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveInstalledReleaseExecutable,
  selectKiteServiceEnvironmentSource,
  sourceServiceBuildIdentity,
} from '../../scripts/release/local-service-client';
import { createManagedLocalSingleServiceComposition } from '../../scripts/release/single-service-native-client';

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

test('source release build identity includes the single-Service bundle inputs', () => {
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

test('managed client derives default KiteHome only from the canonical OS identity', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-managed-home-'));
  const systemHome = join(root, 'os-home');
  const ambientHome = join(root, 'workspace-dotenv-home');
  mkdirSync(systemHome);
  try {
    createManagedLocalSingleServiceComposition({
      argv: ['bun', 'kite'],
      systemHome,
      environment: {
        HOME: ambientHome,
        USERPROFILE: ambientHome,
        KITE_CODE_HOME: join(root, 'ambient-kite-home'),
        KITE_STANDALONE_EXECUTABLE: '1',
        PATH: process.env.PATH,
      },
    });
    expect(existsSync(join(systemHome, '.kite-code'))).toBe(true);
    expect(existsSync(ambientHome)).toBe(false);
    expect(existsSync(join(root, 'ambient-kite-home'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source standalone endpoints are invocation-scoped while explicit shared remains canonical', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-source-topology-'));
  const systemHome = join(root, 'os-home');
  mkdirSync(systemHome);
  try {
    const first = createManagedLocalSingleServiceComposition({
      argv: ['bun', 'kite'],
      systemHome,
      executableMode: 'source',
      serviceTopology: 'standalone',
    });
    const second = createManagedLocalSingleServiceComposition({
      argv: ['bun', 'kite'],
      systemHome,
      executableMode: 'source',
      serviceTopology: 'standalone',
    });
    const shared = createManagedLocalSingleServiceComposition({
      argv: ['bun', 'kite'],
      systemHome,
      executableMode: 'source',
      serviceTopology: 'shared',
    });

    try {
      expect(first.endpoint.homeDigest).not.toBe(second.endpoint.homeDigest);
      expect(first.endpoint.homeDigest).not.toBe(shared.endpoint.homeDigest);
      expect(second.endpoint.homeDigest).not.toBe(shared.endpoint.homeDigest);
      expect(existsSync(join(systemHome, '.kite-code', '.kite-source-standalone'))).toBe(false);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed client accepts one explicit absolute non-symlink KiteHome and rejects ambiguous input', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-explicit-home-'));
  const systemHome = join(root, 'os-home');
  const explicitHome = join(root, 'explicit-kite-home');
  mkdirSync(systemHome);
  mkdirSync(explicitHome, { mode: 0o755 });
  try {
    createManagedLocalSingleServiceComposition({
      argv: ['bun', 'kite', '--kite-home', explicitHome],
      systemHome,
      environment: { PATH: process.env.PATH },
    });
    expect(existsSync(explicitHome)).toBe(true);
    expect(existsSync(join(explicitHome, '.kite-code'))).toBe(false);
    if (process.platform !== 'win32') expect(lstatSync(explicitHome).mode & 0o777).toBe(0o700);

    expect(() =>
      createManagedLocalSingleServiceComposition({
        argv: ['bun', 'kite', '--kite-home', 'relative-home'],
        systemHome,
      }),
    ).toThrow('absolute path');
    expect(() =>
      createManagedLocalSingleServiceComposition({
        argv: ['bun', 'kite', '--kite-home', explicitHome, '--kite-home', explicitHome],
        systemHome,
      }),
    ).toThrow('only once');

    const target = join(root, 'symlink-target');
    const link = join(root, 'symlink-home');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');
    expect(() =>
      createManagedLocalSingleServiceComposition({
        argv: ['bun', 'kite', '--kite-home', link],
        systemHome,
      }),
    ).toThrow('symbolic link');
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
