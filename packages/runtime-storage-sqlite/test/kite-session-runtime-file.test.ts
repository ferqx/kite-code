import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeKiteHomeStoreSchema,
  KITE_SESSION_STORE_FORMAT_EPOCH,
  KITE_SESSION_STORE_SCHEMA_VERSION,
  KITE_SESSION_STORE_TABLE_COLUMNS,
  KiteSessionStoreOpenError,
  openKiteSessionStoreDatabase,
} from '../src';

describe('Kite Session Store physical file', () => {
  test('initializes an absent or empty target file and reopens only the exact epoch', () => {
    for (const precreate of [false, true]) {
      const root = temporaryRoot('kite-session-store-open-');
      const path = join(root, 'kite-session.sqlite');
      try {
        if (precreate) writeFileSync(path, '', { mode: 0o600 });
        const first = openKiteSessionStoreDatabase(path);
        expect(metadata(first, 'schema_version')).toBe(String(KITE_SESSION_STORE_SCHEMA_VERSION));
        expect(metadata(first, 'format_epoch')).toBe(KITE_SESSION_STORE_FORMAT_EPOCH);
        expect(
          first
            .query<{ name: string }, []>('PRAGMA table_info(runtime_effect_leases)')
            .all()
            .map((row) => row.name),
        ).toEqual([...KITE_SESSION_STORE_TABLE_COLUMNS.runtime_effect_leases]);
        first.close(false);

        const reopened = openKiteSessionStoreDatabase(path);
        expect(metadata(reopened, 'format_epoch')).toBe(KITE_SESSION_STORE_FORMAT_EPOCH);
        reopened.close(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('serializes concurrent first-open initialization across real processes', async () => {
    const root = temporaryRoot('kite-session-store-concurrent-');
    const path = join(root, 'kite-session.sqlite');
    const fixture = join(import.meta.dir, 'fixtures', 'open-kite-session-store-child.ts');
    try {
      const startAt = Date.now() + 250;
      const children = [
        Bun.spawn([process.execPath, fixture, path, String(startAt)], { stderr: 'pipe' }),
        Bun.spawn([process.execPath, fixture, path, String(startAt)], { stderr: 'pipe' }),
      ];
      const exitCodes = await Promise.all(children.map((child) => child.exited));
      const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
      expect({ exitCodes, errors }).toEqual({ exitCodes: [0, 0], errors: ['', ''] });

      const database = openKiteSessionStoreDatabase(path);
      expect(metadata(database, 'format_epoch')).toBe(KITE_SESSION_STORE_FORMAT_EPOCH);
      database.close(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects the old store epoch without probing or changing kite.sqlite', () => {
    const root = temporaryRoot('kite-session-store-old-');
    const oldPath = join(root, 'kite.sqlite');
    const targetPath = join(root, 'kite-session.sqlite');
    try {
      const old = new Database(oldPath, { create: true });
      initializeKiteHomeStoreSchema(old);
      old.close(false);
      const before = readFileSync(oldPath);

      const incompatible = new Database(targetPath, { create: true });
      initializeKiteHomeStoreSchema(incompatible);
      incompatible.close(false);
      if (process.platform !== 'win32') chmodSync(targetPath, 0o600);
      expectStoreUpgradeRequired(() => openKiteSessionStoreDatabase(targetPath));
      expect(readFileSync(oldPath)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('maps partial and corrupt target files to store_upgrade_required', () => {
    for (const contents of ['CREATE TABLE partial(value TEXT)', 'not a sqlite database']) {
      const root = temporaryRoot('kite-session-store-invalid-');
      const path = join(root, 'kite-session.sqlite');
      try {
        if (contents.startsWith('CREATE')) {
          const database = new Database(path, { create: true });
          database.run(contents);
          database.close(false);
          if (process.platform !== 'win32') chmodSync(path, 0o600);
        } else {
          writeFileSync(path, contents, { mode: 0o600 });
        }
        expectStoreUpgradeRequired(() => openKiteSessionStoreDatabase(path));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('rejects alternate basenames and permissive target files', () => {
    const root = temporaryRoot('kite-session-store-path-');
    try {
      expect(() => openKiteSessionStoreDatabase(join(root, 'kite.sqlite'))).toThrow(
        'kite-session.sqlite',
      );
      const path = join(root, 'kite-session.sqlite');
      writeFileSync(path, '', { mode: 0o644 });
      chmodSync(path, 0o644);
      if (process.platform !== 'win32') {
        expect(() => openKiteSessionStoreDatabase(path)).toThrow('owner-only');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function temporaryRoot(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), prefix)));
}

function metadata(database: Database, key: string): string | undefined {
  return database
    .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key = ?')
    .get(key)?.value;
}

function expectStoreUpgradeRequired(operation: () => unknown): void {
  try {
    operation();
    throw new Error('Expected store_upgrade_required.');
  } catch (error) {
    expect(error).toBeInstanceOf(KiteSessionStoreOpenError);
    expect((error as KiteSessionStoreOpenError).code).toBe('store_upgrade_required');
  }
}
