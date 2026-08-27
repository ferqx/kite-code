import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedLocalServiceClientComposition } from '../../scripts/release/local-service-client';

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
