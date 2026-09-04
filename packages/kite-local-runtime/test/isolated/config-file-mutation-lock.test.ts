import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import {
  acquireConfigFileMutationLock,
  ConfigFileMutationLockError,
  replaceConfigFileAtomically,
} from '../../src/config';

const identity = () => 'test-process-start';
const nonce = () => new Uint8Array(24).fill(7);

describe('config file mutation lock', () => {
  test('serializes one exact target and releases only its own file identity', () => {
    const root = temporaryRoot();
    const target = join(root, 'kite-code.jsonc');
    try {
      const first = acquireConfigFileMutationLock(target, {
        currentProcessIdentity: identity,
        randomBytes: nonce,
        processState: () => 'alive',
        retryCount: 1,
      });
      expect(() =>
        acquireConfigFileMutationLock(target, {
          currentProcessIdentity: identity,
          randomBytes: () => new Uint8Array(24).fill(8),
          processState: () => 'alive',
          retryCount: 1,
        }),
      ).toThrow(ConfigFileMutationLockError);
      first.release();
      const second = acquireConfigFileMutationLock(target, {
        currentProcessIdentity: identity,
        randomBytes: nonce,
        retryCount: 1,
      });
      second.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reclaims only an exact positively dead owner and fences the old handle', () => {
    const root = temporaryRoot();
    const target = join(root, 'kite-code.jsonc');
    try {
      const stale = acquireConfigFileMutationLock(target, {
        currentProcessIdentity: () => 'old-process',
        randomBytes: nonce,
        retryCount: 1,
      });
      const current = acquireConfigFileMutationLock(target, {
        currentProcessIdentity: () => 'new-process',
        randomBytes: () => new Uint8Array(24).fill(8),
        processState: () => 'dead',
        retryCount: 2,
      });
      expect(() => stale.release()).toThrow(ConfigFileMutationLockError);
      current.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed for malformed or permissive lock evidence', () => {
    const root = temporaryRoot();
    const target = join(root, 'kite-code.jsonc');
    const lockPath = `${target}.kite-lock`;
    try {
      writeFileSync(lockPath, '{}\n', { mode: 0o600 });
      expect(() =>
        acquireConfigFileMutationLock(target, {
          currentProcessIdentity: identity,
          randomBytes: nonce,
          retryCount: 1,
        }),
      ).toThrow(ConfigFileMutationLockError);
      if (process.platform !== 'win32') {
        chmodSync(lockPath, 0o644);
        expect(() =>
          acquireConfigFileMutationLock(target, {
            currentProcessIdentity: identity,
            randomBytes: nonce,
            retryCount: 1,
          }),
        ).toThrow(ConfigFileMutationLockError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not create a global lock across independent config files', () => {
    const root = temporaryRoot();
    try {
      const first = acquireConfigFileMutationLock(join(root, 'first.jsonc'), {
        currentProcessIdentity: identity,
        randomBytes: nonce,
        retryCount: 1,
      });
      const second = acquireConfigFileMutationLock(join(root, 'second.jsonc'), {
        currentProcessIdentity: identity,
        randomBytes: () => new Uint8Array(24).fill(8),
        retryCount: 1,
      });
      first.release();
      second.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes the same config target across real processes', async () => {
    const root = temporaryRoot();
    const target = join(root, 'kite-code.jsonc');
    const childPath = join(import.meta.dir, '..', 'fixtures', 'config-lock-child.ts');
    try {
      const startAt = Date.now() + 250;
      const children = [
        Bun.spawn([process.execPath, childPath, target, String(startAt), '120'], {
          stdout: 'pipe',
          stderr: 'pipe',
        }),
        Bun.spawn([process.execPath, childPath, target, String(startAt), '120'], {
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      ];
      const records = await Promise.all(children.map(readChild));
      const acquired = records
        .map((record) => record.acquiredAt)
        .sort((left, right) => left - right);
      expect(acquired[1]! - acquired[0]!).toBeGreaterThanOrEqual(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('replaces config bytes atomically with the requested private mode', () => {
    const root = temporaryRoot();
    const target = join(root, 'kite-code.jsonc');
    try {
      replaceConfigFileAtomically(target, '{"value":1}\n');
      replaceConfigFileAtomically(target, '{"value":2}\n');
      expect(readFileSync(target, 'utf8')).toBe('{"value":2}\n');
      expect(readdirSync(root)).toEqual(['kite-code.jsonc']);
      if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(() => replaceConfigFileAtomically(target, '{}', 0o777)).toThrow(TypeError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function temporaryRoot(): string {
  return realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-config-mutation-lock-')),
  );
}

async function readChild(
  child: Subprocess<'ignore', 'pipe', 'pipe'>,
): Promise<{ readonly acquiredAt: number }> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout) as { readonly acquiredAt: number };
}
