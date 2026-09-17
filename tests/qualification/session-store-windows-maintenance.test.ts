import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  secureWindowsStatePath,
  verifyWindowsStatePath,
} from '@kite-ai/kite-local-runtime/service';
import { acquireKiteSessionStoreMaintenance } from '../../packages/runtime-storage-sqlite/src/kite-session-maintenance';
import { openKiteSessionRuntimeStorage } from '../../packages/runtime-storage-sqlite/src/kite-session-runtime-storage';
import { inspectKiteSessionPublication } from '../../packages/runtime-storage-sqlite/src/kite-session-store-publication';

const childFixture = join(import.meta.dir, 'fixtures/session-store-windows-maintenance-child.ts');
if (process.env.KITE_REQUIRE_WINDOWS_MAINTENANCE === '1' && process.platform !== 'win32') {
  throw new Error('Windows maintenance qualification requires a native Windows runner.');
}
const windowsPathSecurity = {
  verifyDirectory: (path: string) => verifyWindowsStatePath(path, 'directory'),
  secureFile: (path: string) => secureWindowsStatePath(path, 'file'),
  verifyFile: (path: string) => verifyWindowsStatePath(path, 'file'),
};

function privateRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-windows-maintenance-')));
  secureWindowsStatePath(root, 'directory');
  verifyWindowsStatePath(root, 'directory');
  return root;
}

async function childAttempt(databasePath: string, mode: 'shared' | 'exclusive'): Promise<number> {
  const child = Bun.spawn([process.execPath, childFixture, databasePath, mode, 'attempt'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    return await Promise.race([
      child.exited,
      Bun.sleep(20_000).then(() => {
        throw new Error('Windows maintenance fixture did not exit.');
      }),
    ]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
}

describe.skipIf(process.platform !== 'win32')('native Windows Store maintenance LockFileEx', () => {
  test('ordinary Store opening is admitted, while pending publication remains closed', () => {
    const root = privateRoot();
    const databasePath = join(root, 'kite-session.sqlite');
    const intentPath = join(root, 'kite-session-publication.json');
    try {
      expect(inspectKiteSessionPublication(databasePath).status).toBe('none');
      const owner = openKiteSessionRuntimeStorage({
        databasePath,
        windowsPathSecurity,
        codec: {} as never,
        stateSchemaVersion: 1,
        formatEpoch: 'test',
      });
      owner.close();
      expect(existsSync(databasePath)).toBe(true);
      writeFileSync(intentPath, 'pending fixture', { mode: 0o600 });
      const before = readFileSync(databasePath);
      expect(() => inspectKiteSessionPublication(databasePath)).toThrow('unsupported on Windows');
      expect(() =>
        openKiteSessionRuntimeStorage({
          databasePath,
          windowsPathSecurity,
          codec: {} as never,
          stateSchemaVersion: 1,
          formatEpoch: 'test',
        }),
      ).toThrow('unsupported on Windows');
      expect(readFileSync(databasePath)).toEqual(before);
      expect(readFileSync(intentPath, 'utf8')).toBe('pending fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stable lock file supports shared holders and rejects conflicting exclusive holders', async () => {
    const root = privateRoot();
    const databasePath = join(root, 'kite-session.sqlite');
    try {
      const first = acquireKiteSessionStoreMaintenance(databasePath, 'shared', {
        windowsPathSecurity,
      });
      const identity = lstatSync(first.path);
      try {
        expect(existsSync(first.path)).toBe(true);
        expect(await childAttempt(databasePath, 'shared')).toBe(0);
        expect(await childAttempt(databasePath, 'exclusive')).toBe(2);
      } finally {
        first.release();
      }
      first.release();

      const exclusive = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive', {
        windowsPathSecurity,
      });
      try {
        expect(await childAttempt(databasePath, 'shared')).toBe(2);
        expect(await childAttempt(databasePath, 'exclusive')).toBe(2);
      } finally {
        exclusive.release();
      }
      const reopened = acquireKiteSessionStoreMaintenance(databasePath, 'shared', {
        windowsPathSecurity,
      });
      try {
        const current = lstatSync(reopened.path);
        expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
        expect(await childAttempt(databasePath, 'exclusive')).toBe(2);
      } finally {
        reopened.release();
      }
      expect(await childAttempt(databasePath, 'exclusive')).toBe(0);
      expect(existsSync(`${databasePath}.maintenance.lock`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a crashed holder releases its OS lock without replacing the lock file', async () => {
    const root = privateRoot();
    const databasePath = join(root, 'kite-session.sqlite');
    const ready = join(root, 'ready');
    const child = Bun.spawn(
      [process.execPath, childFixture, databasePath, 'exclusive', 'hold', ready],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline)
        await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      const lockPath = `${databasePath}.maintenance.lock`;
      const identity = lstatSync(lockPath);
      expect(() =>
        acquireKiteSessionStoreMaintenance(databasePath, 'shared', { windowsPathSecurity }),
      ).toThrow(expect.objectContaining({ code: 'store_busy' }));
      expect(await childAttempt(databasePath, 'shared')).toBe(2);
      child.kill('SIGKILL');
      await child.exited;
      const recovered = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive', {
        windowsPathSecurity,
      });
      try {
        const current = lstatSync(lockPath);
        expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
      } finally {
        recovered.release();
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
