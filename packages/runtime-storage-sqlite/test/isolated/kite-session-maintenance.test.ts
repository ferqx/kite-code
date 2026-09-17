import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireKiteSessionStoreMaintenance } from '../../src/kite-session-maintenance';

const fixture = join(import.meta.dir, '..', 'fixtures', 'kite-session-maintenance-child.ts');

describe('Kite Session Store maintenance lock', () => {
  test.skipIf(process.platform === 'win32')(
    'stable inode and idempotent release',
    () => {
      const root = temporaryRoot();
      const databasePath = join(root, 'kite-session.sqlite');
      try {
        const first = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive');
        const inode = lstatSync(first.path);
        expect(inode.mode & 0o077).toBe(0);
        first.release();
        first.release();
        const second = acquireKiteSessionStoreMaintenance(databasePath, 'shared');
        const reopened = lstatSync(second.path);
        expect([reopened.dev, reopened.ino]).toEqual([inode.dev, inode.ino]);
        second.release();
        expect(existsSync(first.path)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform === 'win32')(
    'shared and exclusive conflict across processes',
    async () => {
      const root = temporaryRoot();
      const databasePath = join(root, 'kite-session.sqlite');
      try {
        const shared = acquireKiteSessionStoreMaintenance(databasePath, 'shared');
        expect(await childAttempt(databasePath, 'shared')).toBe(0);
        expect(await childAttempt(databasePath, 'exclusive')).toBe(2);
        shared.release();

        const exclusive = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive');
        expect(await childAttempt(databasePath, 'shared')).toBe(2);
        expect(await childAttempt(databasePath, 'exclusive')).toBe(2);
        exclusive.release();
        expect(await childAttempt(databasePath, 'exclusive')).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform === 'win32')(
    'OS releases a crashed holder without unlinking',
    async () => {
      const root = temporaryRoot();
      const databasePath = join(root, 'kite-session.sqlite');
      const ready = join(root, 'ready');
      const child = Bun.spawn(
        [process.execPath, fixture, databasePath, 'exclusive', 'hold', ready],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );
      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
        expect(existsSync(ready)).toBe(true);
        const lockPath = `${databasePath}.maintenance.lock`;
        const inode = lstatSync(lockPath);
        expect(() => acquireKiteSessionStoreMaintenance(databasePath, 'shared')).toThrow(
          expect.objectContaining({ code: 'store_busy' }),
        );
        expect(await childAttempt(databasePath, 'shared')).toBe(2);
        child.kill();
        await child.exited;
        const recovered = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive');
        expect([lstatSync(lockPath).dev, lstatSync(lockPath).ino]).toEqual([inode.dev, inode.ino]);
        recovered.release();
      } finally {
        child.kill();
        await child.exited;
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform === 'win32')(
    'rejects symlink, hardlink, and loose permissions',
    () => {
      for (const kind of ['symlink', 'hardlink', 'loose'] as const) {
        const root = temporaryRoot();
        const databasePath = join(root, 'kite-session.sqlite');
        const lockPath = `${databasePath}.maintenance.lock`;
        const other = join(root, 'other');
        try {
          writeFileSync(other, '', { mode: 0o600 });
          if (kind === 'symlink') symlinkSync(other, lockPath);
          if (kind === 'hardlink') linkSync(other, lockPath);
          if (kind === 'loose') {
            writeFileSync(lockPath, '', { mode: 0o600 });
            chmodSync(lockPath, 0o644);
          }
          expect(() => acquireKiteSessionStoreMaintenance(databasePath, 'exclusive')).toThrow();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a loose parent or symlinked Store path',
    () => {
      const root = temporaryRoot();
      const databasePath = join(root, 'kite-session.sqlite');
      try {
        chmodSync(root, 0o755);
        expect(() => acquireKiteSessionStoreMaintenance(databasePath, 'shared')).toThrow();
        chmodSync(root, 0o700);
        writeFileSync(join(root, 'other'), '', { mode: 0o600 });
        symlinkSync(join(root, 'other'), databasePath);
        expect(() => acquireKiteSessionStoreMaintenance(databasePath, 'shared')).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test.skipIf(process.platform !== 'win32')('requires a Windows path security authority', () => {
  const root = temporaryRoot();
  try {
    expect(() =>
      acquireKiteSessionStoreMaintenance(join(root, 'kite-session.sqlite'), 'shared'),
    ).toThrow('requires path security');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-session-maintenance-'));
  chmodSync(root, 0o700);
  return realpathSync.native(root);
}

async function childAttempt(databasePath: string, mode: 'shared' | 'exclusive'): Promise<number> {
  return Bun.spawn([process.execPath, fixture, databasePath, mode, 'attempt'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exited;
}
