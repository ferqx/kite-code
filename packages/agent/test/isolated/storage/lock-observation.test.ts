import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireExistingSharedFileLock,
  acquireFileLock,
  LockBusyError,
} from '../../../src/platform/locks';

const posix = process.platform === 'darwin' || process.platform === 'linux';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-lock-observation-')));
  return { root, path: join(root, 'owner.lock') };
}

test.skipIf(!posix)(
  'existing shared probe observes real exclusive contention and releases its original descriptor',
  () => {
    const { root, path } = fixture();
    try {
      writeFileSync(path, 'immutable owner coordination', { mode: 0o600 });
      const shared = acquireExistingSharedFileLock(path);
      try {
        const peer = acquireExistingSharedFileLock(path);
        peer.release();
        expect(() => acquireFileLock(path, 'exclusive')).toThrow(LockBusyError);
        expect(readFileSync(path, 'utf8')).toBe('immutable owner coordination');
      } finally {
        shared.release();
      }
      const exclusive = acquireFileLock(path, 'exclusive');
      try {
        expect(() => acquireExistingSharedFileLock(path)).toThrow(LockBusyError);
      } finally {
        exclusive.release();
      }
      const unheld = acquireExistingSharedFileLock(path);
      unheld.release();
      const finalOwner = acquireFileLock(path, 'exclusive');
      finalOwner.release();
      expect(readFileSync(path, 'utf8')).toBe('immutable owner coordination');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  'observation creates no missing file and rejects public or unstable coordination files',
  () => {
    const { root, path } = fixture();
    try {
      expect(() => acquireExistingSharedFileLock(path)).toThrow();
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, '', { mode: 0o644 });
      expect(() => acquireExistingSharedFileLock(path)).toThrow();
      const directory = join(root, 'directory');
      mkdirSync(directory, { mode: 0o700 });
      expect(() => acquireExistingSharedFileLock(directory)).toThrow();
      const privatePath = join(root, 'private.lock');
      writeFileSync(privatePath, '', { mode: 0o600 });
      const symbolic = join(root, 'symbolic.lock');
      symlinkSync(privatePath, symbolic);
      expect(() => acquireExistingSharedFileLock(symbolic)).toThrow();
      const linked = join(root, 'hardlink.lock');
      linkSync(privatePath, linked);
      expect(() => acquireExistingSharedFileLock(linked)).toThrow();
      expect(() => acquireExistingSharedFileLock(privatePath)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  'POSIX observation distinguishes non-contention errno while original owner acquisition keeps its contract',
  async () => {
    const { root, path } = fixture();
    try {
      writeFileSync(path, '', { mode: 0o600 });
      const original = fileURLToPath(new URL('../../../src/platform/locks.ts', import.meta.url));
      const source = readFileSync(original, 'utf8').replace(
        /from (['"])(\.[^'"]+)\1/g,
        (_match, quote, specifier) =>
          `from ${quote}${resolve(dirname(original), specifier)}${quote}`,
      );
      const modulePath = join(root, 'locks-errno-fixture.ts');
      // Keep the production classification and descriptor cleanup; inject only the native result.
      writeFileSync(
        modulePath,
        `${source}\nexport const fixtureFault = { errno: 5 };\nflock = () => -1;\nflockError = () => fixtureFault.errno;\n`,
      );
      const selected = (await import(pathToFileURL(modulePath).href)) as {
        acquireExistingSharedFileLock: typeof acquireExistingSharedFileLock;
        acquireFileLock: typeof acquireFileLock;
        LockBusyError: typeof LockBusyError;
        fixtureFault: { errno: number };
      };
      const failure = (() => {
        try {
          selected.acquireExistingSharedFileLock(path);
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(selected.LockBusyError);
      expect((failure as Error).message).toBe('Lock observation unavailable.');
      expect(() => selected.acquireFileLock(path, 'exclusive')).toThrow(selected.LockBusyError);
      selected.fixtureFault.errno = process.platform === 'darwin' ? 35 : 11;
      expect(() => selected.acquireExistingSharedFileLock(path)).toThrow(selected.LockBusyError);
      // Neither rejected probe keeps the real file locked.
      const realOwner = acquireFileLock(path, 'exclusive');
      realOwner.release();
      expect(readFileSync(path, 'utf8')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
