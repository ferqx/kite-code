import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeKiteHomeStoreSchema } from '../../src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../../src/kite-session-maintenance';
import { createKiteSessionRecoveryBackup } from '../../src/kite-session-recovery-backup';
import { openKiteSessionStoreDatabase } from '../../src/kite-session-runtime-file';
import { KITE_SESSION_STORE11_DDL } from '../../src/kite-session-store11-conversion';

describe('known-format recovery backup', () => {
  test('borrows only a live matching exclusive lock and leaves ownership with the caller', () => {
    const root = privateRoot();
    const sourcePath = join(root, 'kite-session.sqlite');
    const recoveryParent = join(root, 'recovery');
    mkdirSync(recoveryParent, { mode: 0o700 });
    openKiteSessionStoreDatabase(sourcePath).close(false);
    const maintenance = acquireKiteSessionStoreMaintenance(sourcePath, 'exclusive');
    try {
      const backup = createKiteSessionRecoveryBackup(sourcePath, recoveryParent, { maintenance });
      expect(existsSync(backup.manifestPath)).toBe(true);
      expect(() => acquireKiteSessionStoreMaintenance(sourcePath, 'shared')).toThrow();
      const fabricated = { path: maintenance.path, mode: 'exclusive' as const, release() {} };
      expect(() =>
        createKiteSessionRecoveryBackup(sourcePath, recoveryParent, { maintenance: fabricated }),
      ).toThrow('not active');
      maintenance.release();
      expect(() =>
        createKiteSessionRecoveryBackup(sourcePath, recoveryParent, { maintenance }),
      ).toThrow('not active');
      const shared = acquireKiteSessionStoreMaintenance(sourcePath, 'shared');
      try {
        expect(() =>
          createKiteSessionRecoveryBackup(sourcePath, recoveryParent, { maintenance: shared }),
        ).toThrow('exclusive');
      } finally {
        shared.release();
      }
    } finally {
      maintenance.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const version of [9, 11] as const) {
    test(`backs up exact historical Store ${version} without changing its identity`, () => {
      const root = privateRoot();
      const sourcePath = join(root, version === 9 ? 'kite.sqlite' : 'kite-session.sqlite');
      const recoveryParent = join(root, 'recovery');
      mkdirSync(recoveryParent, { mode: 0o700 });
      const source = new Database(sourcePath);
      chmodSync(sourcePath, 0o600);
      try {
        if (version === 9) initializeKiteHomeStoreSchema(source);
        else {
          for (const sql of KITE_SESSION_STORE11_DDL) source.run(sql);
          source
            .query('INSERT INTO kite_meta(key, value) VALUES (?, ?)')
            .run('schema_version', '11');
          source
            .query('INSERT INTO kite_meta(key, value) VALUES (?, ?)')
            .run('format_epoch', 'kite-session-accepted-runs-2026-09-15');
          source.run('PRAGMA user_version = 11');
        }
      } finally {
        source.close();
      }
      const before = readFileSync(sourcePath);
      try {
        const backup = createKiteSessionRecoveryBackup(sourcePath, recoveryParent);
        expect(backup.manifest.capture.schemaVersion).toBe(version);
        expect(backup.manifest.capture.tables.kite_meta?.rows).toBe(2);
        using copy = new Database(backup.databasePath, { readonly: true });
        expect(
          copy
            .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key='schema_version'")
            .get()?.value,
        ).toBe(String(version));
        expect(readFileSync(sourcePath)).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('backs up a clean WAL Store without creating source sidecars', () => {
    const root = privateRoot();
    const sourcePath = join(root, 'kite-session.sqlite');
    const recoveryParent = join(root, 'recovery');
    mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
    const source = openKiteSessionStoreDatabase(sourcePath);
    source.close(false);
    expect(existsSync(`${sourcePath}-wal`)).toBe(false);
    expect(existsSync(`${sourcePath}-shm`)).toBe(false);
    const before = readFileSync(sourcePath);
    try {
      const backup = createKiteSessionRecoveryBackup(sourcePath, recoveryParent);
      expect(existsSync(backup.manifestPath)).toBe(true);
      expect(readFileSync(sourcePath)).toEqual(before);
      expect(existsSync(`${sourcePath}-wal`)).toBe(false);
      expect(existsSync(`${sourcePath}-shm`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('captures latest committed WAL data as a standalone readonly snapshot without changing source bytes', () => {
    const root = privateRoot();
    const sourcePath = join(root, 'kite-session.sqlite');
    const recoveryParent = join(root, 'recovery');
    mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
    const source = openKiteSessionStoreDatabase(sourcePath);
    try {
      source.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run('fixture', 'latest');
      const mainBefore = readFileSync(sourcePath);
      const walBefore = readFileSync(`${sourcePath}-wal`);
      expect(walBefore.length).toBeGreaterThan(0);

      const result = createKiteSessionRecoveryBackup(sourcePath, recoveryParent);
      expect(existsSync(result.manifestPath)).toBe(true);
      expect(result.manifest.capture.schemaVersion).toBe(10);
      expect(result.manifest.source.mainSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(lstatSync(result.directory).mode & 0o077).toBe(0);
      expect(lstatSync(result.databasePath).mode & 0o077).toBe(0);
      expect(readdirSync(result.directory).sort()).toEqual(['kite-session.sqlite', 'ready.json']);
      expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toEqual(result.manifest);
      expect(result.manifest.backupSha256).toBe(
        createHash('sha256').update(readFileSync(result.databasePath)).digest('hex'),
      );

      const copy = new Database(
        result.databasePath,
        sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
      );
      try {
        expect(
          copy
            .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key = 'fixture'")
            .get()?.value,
        ).toBe('latest');
        expect(
          copy.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode,
        ).toBe('delete');
      } finally {
        copy.close(false);
      }
      expect(readFileSync(sourcePath)).toEqual(mainBefore);
      expect(readFileSync(`${sourcePath}-wal`)).toEqual(walBefore);
    } finally {
      source.close(false);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('a busy maintenance owner does not create a recovery asset', () => {
    const root = privateRoot();
    const sourcePath = join(root, 'kite-session.sqlite');
    const recoveryParent = join(root, 'recovery');
    mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
    const source = openKiteSessionStoreDatabase(sourcePath);
    source.close(false);
    const admission = acquireKiteSessionStoreMaintenance(sourcePath, 'shared');
    try {
      expect(() => createKiteSessionRecoveryBackup(sourcePath, recoveryParent)).toThrow(
        expect.objectContaining({ code: 'store_busy' }),
      );
      expect(readdirSync(recoveryParent)).toEqual([]);
    } finally {
      admission.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unsupported schema fails closed without a ready manifest or source mutation', () => {
    const root = privateRoot();
    const sourcePath = join(root, 'kite-session.sqlite');
    const recoveryParent = join(root, 'recovery');
    mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
    const source = openKiteSessionStoreDatabase(sourcePath);
    source.query("UPDATE kite_meta SET value = '99' WHERE key = 'schema_version'").run();
    source.run('PRAGMA user_version = 99');
    source.close(false);
    const before = readFileSync(sourcePath);
    try {
      expect(() => createKiteSessionRecoveryBackup(sourcePath, recoveryParent)).toThrow(
        'supports only verified Store formats',
      );
      expect(readdirSync(recoveryParent)).toEqual([]);
      expect(readFileSync(sourcePath)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failure after VACUUM or while writing ready removes only the new asset', () => {
    for (const fault of ['fsync', 'ready', 'postready'] as const) {
      const root = privateRoot();
      const sourcePath = join(root, 'kite-session.sqlite');
      const recoveryParent = join(root, 'recovery');
      mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
      const source = openKiteSessionStoreDatabase(sourcePath);
      source.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run('fixture', 'latest');
      const before = readFileSync(sourcePath);
      const originalWrite = fs.writeFileSync;
      const originalFsync = fs.fsyncSync;
      let syncCalls = 0;
      const spy =
        fault !== 'ready'
          ? spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
              syncCalls++;
              if (fault === 'fsync' || syncCalls === 4) {
                throw new Error(`injected ${fault} fsync failure`);
              }
              return originalFsync(descriptor);
            })
          : spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
              if (String(path).endsWith('ready.json.tmp')) {
                throw new Error('injected ready write failure');
              }
              return originalWrite(path, data, options);
            });
      try {
        expect(() => createKiteSessionRecoveryBackup(sourcePath, recoveryParent)).toThrow(
          fault === 'ready' ? 'injected ready write failure' : `injected ${fault} fsync failure`,
        );
        expect(spy).toHaveBeenCalled();
        expect(readdirSync(recoveryParent)).toEqual([]);
        expect(readFileSync(sourcePath)).toEqual(before);
      } finally {
        spy.mockRestore();
        source.close(false);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('mkdir collision never deletes a preexisting recovery directory', () => {
    const root = privateRoot();
    const sourcePath = join(root, 'kite-session.sqlite');
    const recoveryParent = join(root, 'recovery');
    mkdirSync(recoveryParent, { recursive: true, mode: 0o700 });
    const source = openKiteSessionStoreDatabase(sourcePath);
    source.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)').run('fixture', 'latest');
    const before = readFileSync(sourcePath);
    const originalMkdir = fs.mkdirSync;
    let collisionPath: string | undefined;
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation((path, options) => {
      if (String(path).startsWith(`${recoveryParent}/backup-`)) {
        collisionPath = String(path);
        originalMkdir(path, options);
        fs.writeFileSync(join(String(path), 'preexisting'), 'keep', { mode: 0o600 });
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
      }
      return originalMkdir(path, options);
    });
    try {
      expect(() => createKiteSessionRecoveryBackup(sourcePath, recoveryParent)).toThrow(
        'already exists',
      );
      expect(collisionPath).toBeDefined();
      expect(readFileSync(join(collisionPath!, 'preexisting'), 'utf8')).toBe('keep');
      expect(readdirSync(collisionPath!)).toEqual(['preexisting']);
      expect(readFileSync(sourcePath)).toEqual(before);
    } finally {
      mkdirSpy.mockRestore();
      source.close(false);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-schema10-backup-'));
  chmodSync(root, 0o700);
  return realpathSync.native(root);
}
