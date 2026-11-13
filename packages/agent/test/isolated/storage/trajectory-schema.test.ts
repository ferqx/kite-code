import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { Database } from '../../../src/runtime-sqlite';
import { openSqliteStore, preflightSqliteStore, sqliteStorageAssets } from '../../../src/sqlite';
import { matchingSchema, supportedSchemas } from '../../../src/storage/sqlite/migrations';

function legacyFixture(cursor = '9007199254740993') {
  const directory = temporaryDirectory('kite-trajectory-migration-');
  const profile = { dataRoot: directory, profile: 'legacy' };
  const path = join(directory, 'legacy');
  mkdirSync(path, { mode: 0o700 });
  const databasePath = join(path, 'core.db');
  writeFileSync(databasePath, '', { mode: 0o600 });
  const db = new Database(databasePath);
  const baseline = readFileSync(
    new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url),
    'utf8',
  );
  const checksum = createHash('sha256').update(baseline).digest('hex');
  db.exec(baseline);
  db.run('INSERT INTO schema_migration VALUES(?,?,?)', ['0001-baseline', checksum, 'original']);
  db.run(
    'INSERT INTO storage_meta(singleton,store_id,format_major,replay_floor,last_change_cursor) VALUES(1,?,1,?,?)',
    ['legacy-origin', BigInt(cursor) < 0n ? -1n : 0n, BigInt(cursor)],
  );
  db.run(
    'INSERT INTO change_event(cursor,scope_session_id,object_id,revision,type,payload_json) VALUES(1,NULL,?,0,?,?)',
    ['original', 'workspace.created', '  {"original":true}  '],
  );
  db.close(true);
  writeFileSync(
    join(path, 'profile.json'),
    JSON.stringify({ formatMajor: 1, schemaChecksum: checksum }),
    {
      mode: 0o600,
    },
  );
  return {
    profile,
    path,
    databasePath,
    checksum,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('readonly old schema stays byte-identical; writer upgrades once at the exact Decimal64 cursor', async () => {
  const f = legacyFixture();
  try {
    const databaseBytes = readFileSync(f.databasePath),
      markerBytes = readFileSync(join(f.path, 'profile.json'));
    expect(await preflightSqliteStore(f.profile)).toEqual({
      status: 'compatible',
      storeId: 'legacy-origin',
      formatMajor: 1,
    });
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    expect((await readonly.getMetadata()).lastChangeCursor).toBe('9007199254740993');
    await readonly.close();
    expect(readFileSync(f.databasePath)).toEqual(databaseBytes);
    expect(readFileSync(join(f.path, 'profile.json'))).toEqual(markerBytes);
    const writer = await openSqliteStore(f.profile);
    expect((await writer.getMetadata()).lastChangeCursor).toBe('9007199254740993');
    await writer.close();
    const db = new Database(f.databasePath);
    expect(matchingSchema(db)?.migrations.map((item) => item.id)).toEqual([
      '0001-baseline',
      '0002-trajectory-facts',
    ]);
    expect(
      db
        .query('SELECT CAST(trajectory_enabled_after_cursor AS TEXT) AS cursor FROM storage_meta')
        .get(),
    ).toEqual({ cursor: '9007199254740993' });
    expect(db.query('SELECT payload_json,trajectory_fact_json FROM change_event').get()).toEqual({
      payload_json: '  {"original":true}  ',
      trajectory_fact_json: null,
    });
    db.run('UPDATE storage_meta SET last_change_cursor=last_change_cursor+1');
    db.close(true);
    const reopened = await openSqliteStore(f.profile);
    await reopened.close();
    const cold = new Database(f.databasePath, { readonly: true });
    expect(
      cold
        .query('SELECT CAST(trajectory_enabled_after_cursor AS TEXT) AS cursor FROM storage_meta')
        .get(),
    ).toEqual({ cursor: '9007199254740993' });
    cold.close(true);
    expect(JSON.parse(readFileSync(join(f.path, 'profile.json'), 'utf8'))).toEqual({
      formatMajor: 1,
      schemaChecksum: supportedSchemas().at(-1)!.checksum,
    });
    expect(supportedSchemas()[0]!.checksum).toBe(f.checksum);
  } finally {
    f.close();
  }
});

test('failed marker migration rolls back columns and migration identity without rewriting the profile hint', async () => {
  const f = legacyFixture('-1');
  try {
    const marker = readFileSync(join(f.path, 'profile.json'));
    await expect(openSqliteStore(f.profile)).rejects.toBeDefined();
    const db = new Database(f.databasePath, { readonly: true });
    expect(matchingSchema(db)?.migrations.map((item) => item.id)).toEqual(['0001-baseline']);
    expect(
      db
        .query('PRAGMA table_info(change_event)')
        .all()
        .some((row) => (row as { name: string }).name === 'trajectory_fact_json'),
    ).toBe(false);
    expect(db.query('SELECT payload_json FROM change_event').get()).toEqual({
      payload_json: '  {"original":true}  ',
    });
    db.close(true);
    expect(readFileSync(join(f.path, 'profile.json'))).toEqual(marker);
  } finally {
    f.close();
  }
});

test('new Store starts with zero history boundary and exact checked-in migration assets', async () => {
  const directory = temporaryDirectory('kite-trajectory-new-store-');
  try {
    const store = await openSqliteStore({ dataRoot: directory, profile: 'fresh' });
    await store.close();
    const db = new Database(join(directory, 'fresh', 'core.db'), { readonly: true });
    expect(db.query('SELECT trajectory_enabled_after_cursor FROM storage_meta').get()).toEqual({
      trajectory_enabled_after_cursor: 0,
    });
    expect(matchingSchema(db)?.checksum).toBe(supportedSchemas().at(-1)!.checksum);
    db.close(true);
    expect(sqliteStorageAssets().migrations.map((url) => url.pathname.split('/').at(-1))).toEqual([
      '0001-baseline.sql',
      '0002-trajectory-facts.sql',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
