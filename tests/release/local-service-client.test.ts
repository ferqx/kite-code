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
  createManagedLocalServiceClientComposition,
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

test('source Service build identity changes with tracked and bounded untracked inputs', () => {
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
    writeFileSync(tracked, 'export const value = 2;\n');
    const trackedDirty = sourceServiceBuildIdentity(root);
    writeFileSync(tracked, 'export const value = 3;\n');
    const trackedChangedAgain = sourceServiceBuildIdentity(root);
    const untracked = join(root, 'packages', 'fixture', 'new.ts');
    writeFileSync(untracked, 'export const added = true;\n');
    const withUntracked = sourceServiceBuildIdentity(root);

    expect(clean).toMatch(/^dev:[0-9a-f]{40}$/u);
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
    const managed = createManagedLocalServiceClientComposition({
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
    expect(managed.executableMode).toBe('source');
    expect(existsSync(join(systemHome, '.kite-code'))).toBe(true);
    expect(existsSync(ambientHome)).toBe(false);
    expect(existsSync(join(root, 'ambient-kite-home'))).toBe(false);
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
    createManagedLocalServiceClientComposition({
      argv: ['bun', 'kite', '--kite-home', explicitHome],
      systemHome,
      environment: { PATH: process.env.PATH },
    });
    expect(existsSync(explicitHome)).toBe(true);
    expect(existsSync(join(explicitHome, '.kite-code'))).toBe(false);
    if (process.platform !== 'win32') expect(lstatSync(explicitHome).mode & 0o777).toBe(0o700);

    expect(() =>
      createManagedLocalServiceClientComposition({
        argv: ['bun', 'kite', '--kite-home', 'relative-home'],
        systemHome,
      }),
    ).toThrow('absolute path');
    expect(() =>
      createManagedLocalServiceClientComposition({
        argv: ['bun', 'kite', '--kite-home', explicitHome, '--kite-home', explicitHome],
        systemHome,
      }),
    ).toThrow('only once');

    const target = join(root, 'symlink-target');
    const link = join(root, 'symlink-home');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');
    expect(() =>
      createManagedLocalServiceClientComposition({
        argv: ['bun', 'kite', '--kite-home', link],
        systemHome,
      }),
    ).toThrow('symbolic link');
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
