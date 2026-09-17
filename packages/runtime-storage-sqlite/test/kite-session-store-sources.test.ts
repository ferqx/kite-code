import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKiteSessionStoreSourcesReconciled,
  inspectKiteSessionStoreSources,
} from '../src/kite-session-store-sources';

function fixture(run: (root: string, target: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-store-sources-')));
  try {
    run(root, join(root, 'kite-session.sqlite'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('canonical Session Store historical source discovery', () => {
  test('fresh startup discovery is read-only and does not initialize a target', () =>
    fixture((root, target) => {
      expect(inspectKiteSessionStoreSources(target)).toEqual([]);
      assertKiteSessionStoreSourcesReconciled(target);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(root, 'source-profiles'))).toBe(false);
    }));

  test('all known historical locations block an empty replacement without altering either source', () =>
    fixture((root, target) => {
      const directory = join(root, 'source-profiles', 'a'.repeat(32));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const legacy = join(root, 'kite.sqlite');
      const profile = join(directory, 'kite-session.sqlite');
      writeFileSync(legacy, 'legacy history', { mode: 0o600 });
      writeFileSync(profile, 'profile history', { mode: 0o600 });
      expect(inspectKiteSessionStoreSources(target)).toEqual([legacy, profile].sort());
      expect(() => assertKiteSessionStoreSourcesReconciled(target)).toThrow(
        'Historical session data',
      );
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(legacy, 'utf8')).toBe('legacy history');
      expect(readFileSync(profile, 'utf8')).toBe('profile history');
      writeFileSync(target, 'canonical history', { mode: 0o600 });
      expect(() => assertKiteSessionStoreSourcesReconciled(target)).toThrow(
        'Historical session data',
      );
      expect(readFileSync(target, 'utf8')).toBe('canonical history');
    }));

  test('a zero-byte never-initialized source is not treated as persisted history', () =>
    fixture((root, target) => {
      writeFileSync(join(root, 'kite.sqlite'), '', { mode: 0o600 });
      expect(inspectKiteSessionStoreSources(target)).toEqual([]);
    }));

  test('does not mistake an empty main file with a WAL for an empty history', () =>
    fixture((root, target) => {
      const source = join(root, 'kite.sqlite');
      writeFileSync(source, '', { mode: 0o600 });
      writeFileSync(`${source}-wal`, 'committed data', { mode: 0o600 });
      expect(inspectKiteSessionStoreSources(target)).toEqual([source]);
      expect(() => assertKiteSessionStoreSourcesReconciled(target)).toThrow(
        'Historical session data',
      );
      expect(existsSync(target)).toBe(false);
    }));

  test.skipIf(process.platform === 'win32')('never follows a historical directory symlink', () =>
    fixture((root, target) => {
      const external = join(root, 'external');
      mkdirSync(external);
      writeFileSync(join(external, 'kite-session.sqlite'), 'private', { mode: 0o600 });
      symlinkSync(external, join(root, 'source-profiles'));
      expect(() => inspectKiteSessionStoreSources(target)).toThrow('cannot be safely inspected');
      expect(existsSync(target)).toBe(false);
    }),
  );
});
