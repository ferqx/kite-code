import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { artifactPath } from '../../../src/artifacts-files';
import { createProfileBackup, inspectProfileBackup } from '../../../src/maintenance';
import { acquireProfileAccess, selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());

async function failure(work: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  if (code) expect((error as { code?: string }).code ?? (error as Error).message).toBe(code);
}
async function fixture(large = false) {
  const directory = mkdtempSync('/private/tmp/kite-backup-');
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: 'file:///fixture',
    name: 'w',
  });
  await store.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'original',
  });
  await store.close();
  const selected = selectProfile(profile);
  const db = new Database(selected.databasePath);
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA wal_autocheckpoint=0');
  const bytes = Buffer.from(
    large ? `original-${'a'.repeat(17 * 1024 * 1024)}-tail` : 'original-media',
  );
  const hash = createHash('sha256').update(bytes).digest('hex');
  const mediaPath = artifactPath(selected.profilePath, hash);
  mkdirSync(join(selected.profilePath, 'blobs', hash.slice(0, 2)), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(mediaPath, bytes, { mode: 0o400 });
  db.query('INSERT INTO blob VALUES(?,?,?)').run(hash, bytes.length, 'fixture');
  db.query('INSERT INTO blob_ref VALUES(?,?,?,?,?,?,?,?)').run(
    'ref',
    hash,
    's',
    'fixture',
    'media',
    'owner',
    'original-store-origin',
    'application/octet-stream',
  );
  // Deliberately unknown JSON and >2^53 business revision survive without interpretation.
  db.query('INSERT INTO extension_record VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    null,
    'future',
    'session',
    's',
    'raw',
    9007199254740993n,
    'future.record',
    91,
    'old-origin',
    '  {"unknown":true}  ',
  );
  db.run("UPDATE session SET title='wal-only-title',next_seq=9007199254740993 WHERE id='s'");
  db.run('UPDATE storage_meta SET last_change_cursor=9007199254740993');
  writeFileSync(join(selected.profilePath, 'credentials'), 'excluded credential fixture', {
    mode: 0o600,
  });
  return {
    directory,
    profile,
    storeId,
    selected,
    db,
    hash,
    bytes,
    mediaPath,
    destinationRoot: join(directory, 'backups'),
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('offline backup captures WAL and complete 17MiB media with original business identity and raw data', async () => {
  const f = await fixture(true);
  try {
    const before = readFileSync(f.selected.databasePath);
    const wal = readFileSync(`${f.selected.databasePath}-wal`);
    const result = await createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
    });
    expect(result.manifest.source.storeId).toBe(f.storeId);
    expect(result.manifest.source.snapshotCursor).toBe('9007199254740993');
    expect(result.manifest.media.blobCount).toBe('1');
    expect(result.manifest.media.referenceCount).toBe('1');
    expect(result.manifest.engine.version).toBeTruthy();
    expect(result.manifest.engine.sourceId).toBeTruthy();
    expect(readFileSync(f.selected.databasePath)).toEqual(before);
    expect(readFileSync(`${f.selected.databasePath}-wal`)).toEqual(wal);
    expect(readFileSync(artifactPath(result.directory, f.hash))).toEqual(f.bytes);
    expect(readdirSync(result.directory).sort()).toEqual([
      'blobs',
      'core.db',
      'media.jsonl',
      'ready.json',
    ]);
    const inspected = await inspectProfileBackup({ directory: result.directory });
    expect(inspected.manifest).toEqual(result.manifest);
    const copy = new Database(join(result.directory, 'core.db'), { readonly: true });
    try {
      expect(copy.query('SELECT title,CAST(next_seq AS TEXT) AS seq FROM session').get()).toEqual({
        title: 'wal-only-title',
        seq: '9007199254740993',
      });
      expect(
        copy
          .query(
            'SELECT origin_store_id,json,CAST(revision AS TEXT) AS revision FROM extension_record',
          )
          .get(),
      ).toEqual({
        origin_store_id: 'old-origin',
        json: '  {"unknown":true}  ',
        revision: '9007199254740993',
      });
      expect(copy.query('SELECT origin_store_id FROM blob_ref').get()).toEqual({
        origin_store_id: 'original-store-origin',
      });
    } finally {
      copy.close();
    }
  } finally {
    f.close();
  }
}, 30000);

test('stable shared owner, restore journal and source SQL journal refuse backup without a ready candidate', async () => {
  const f = await fixture();
  try {
    const access = acquireProfileAccess(f.profile);
    try {
      await failure(
        createProfileBackup({ profile: f.profile, destinationRoot: f.destinationRoot }),
        'owner_busy',
      );
    } finally {
      access.lock.release();
    }
    expect(existsSync(f.destinationRoot)).toBe(false);
    const journal = join(f.selected.coordinationPath, 'restore-journal.json');
    writeFileSync(journal, '{}', { mode: 0o600 });
    await failure(
      createProfileBackup({ profile: f.profile, destinationRoot: f.destinationRoot }),
      'restore_reconciliation_required',
    );
    rmSync(journal);
    writeFileSync(`${f.selected.databasePath}-journal`, 'unresolved journal', { mode: 0o600 });
    await failure(
      createProfileBackup({ profile: f.profile, destinationRoot: f.destinationRoot }),
      'backup_source_journal_present',
    );
    expect(existsSync(f.destinationRoot)).toBe(false);
  } finally {
    f.close();
  }
});

test('backup and inspect of a cleanly closed WAL profile leave DB bytes and absent sidecars unchanged', async () => {
  const f = await fixture();
  try {
    f.db.close(true);
    const before = readFileSync(f.selected.databasePath);
    const unchanged = () => {
      expect(readFileSync(f.selected.databasePath)).toEqual(before);
      expect(existsSync(`${f.selected.databasePath}-wal`)).toBe(false);
      expect(existsSync(`${f.selected.databasePath}-shm`)).toBe(false);
    };
    unchanged();
    const result = await createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
    });
    unchanged();
    expect(result.manifest.source.storeId).toBe(f.storeId);
    expect(result.manifest.source.snapshotCursor).toBe('9007199254740993');
    expect(result.manifest.media.blobCount).toBe('1');
    expect(result.manifest.media.referenceCount).toBe('1');
    expect(readFileSync(artifactPath(result.directory, f.hash))).toEqual(f.bytes);
    expect(
      (await inspectProfileBackup({ directory: result.directory })).manifest.source.storeId,
    ).toBe(f.storeId);
    unchanged();
    const copy = new Database(join(result.directory, 'core.db'), { readonly: true });
    try {
      expect(copy.query('SELECT title,CAST(next_seq AS TEXT) AS seq FROM session').get()).toEqual({
        title: 'wal-only-title',
        seq: '9007199254740993',
      });
      expect(
        copy
          .query(
            'SELECT origin_store_id,json,CAST(revision AS TEXT) AS revision FROM extension_record',
          )
          .get(),
      ).toEqual({
        origin_store_id: 'old-origin',
        json: '  {"unknown":true}  ',
        revision: '9007199254740993',
      });
    } finally {
      copy.close(true);
    }
    unchanged();
    expect(readdirSync(result.directory).sort()).toEqual([
      'blobs',
      'core.db',
      'media.jsonl',
      'ready.json',
    ]);
    expect(existsSync(join(result.directory, 'core.db-wal'))).toBe(false);
    expect(existsSync(join(result.directory, 'core.db-shm'))).toBe(false);
    expect(readdirSync(f.destinationRoot)).toEqual([result.directory.split('/').at(-1)!]);
  } finally {
    f.close();
  }
});

test('Store close releases statements and SQLite before maintenance after many distinct export queries', async () => {
  const f = await fixture();
  try {
    f.db.close();
    const store = await openSqliteStore(f.profile);
    const identity = { expectedStoreId: f.storeId, sessionId: 's', subjectId: 'owner' };
    const manifest = await store.beginSessionExport(identity);
    for (const { section } of manifest.sections)
      await store.readSessionExportPage({ ...identity, manifest, section });
    await store.verifySessionExport({ ...identity, manifest });
    await store.close();
    const before = readFileSync(f.selected.databasePath);
    const wal = existsSync(`${f.selected.databasePath}-wal`)
      ? readFileSync(`${f.selected.databasePath}-wal`)
      : null;
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
    });
    expect(readFileSync(f.selected.databasePath)).toEqual(before);
    expect(
      existsSync(`${f.selected.databasePath}-wal`)
        ? readFileSync(`${f.selected.databasePath}-wal`)
        : null,
    ).toEqual(wal);
    expect(
      (await inspectProfileBackup({ directory: backup.directory })).manifest.source.storeId,
    ).toBe(f.storeId);
  } finally {
    f.close();
  }
});

test('failed Store preflight releases database resources before restoring supported bytes and backing up', async () => {
  const f = await fixture();
  try {
    f.db.close();
    const original = readFileSync(f.selected.databasePath),
      corrupt = new Database(f.selected.databasePath);
    corrupt.run('UPDATE storage_meta SET format_major=99');
    corrupt.close(true);
    await failure(openSqliteStore(f.profile), 'store_incompatible');
    writeFileSync(f.selected.databasePath, original);
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
    });
    expect(readFileSync(f.selected.databasePath)).toEqual(original);
    expect(
      (await inspectProfileBackup({ directory: backup.directory })).manifest.source.storeId,
    ).toBe(f.storeId);
  } finally {
    f.close();
  }
});

test('missing or linked media and cancellation remove only this operation staging and never publish ready', async () => {
  const f = await fixture(true);
  try {
    rmSync(f.mediaPath);
    await failure(createProfileBackup({ profile: f.profile, destinationRoot: f.destinationRoot }));
    expect(readdirSync(f.destinationRoot)).toEqual([]);
    writeFileSync(f.mediaPath, f.bytes, { mode: 0o400 });
    const alias = join(f.directory, 'alias');
    linkSync(f.mediaPath, alias);
    await failure(
      createProfileBackup({ profile: f.profile, destinationRoot: f.destinationRoot }),
      'backup_access_denied',
    );
    rmSync(alias);
    const abort = new AbortController();
    const pending = createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(new Error('fixture cancellation')), 0);
    await failure(pending, 'fixture cancellation');
    expect(readdirSync(f.destinationRoot)).toEqual([]);
    expect(readFileSync(f.mediaPath)).toEqual(f.bytes);
    await failure(
      createProfileBackup({ profile: f.profile, destinationRoot: f.selected.profilePath }),
      'backup_destination_invalid',
    );
    await failure(
      createProfileBackup({ profile: f.profile, destinationRoot: f.selected.coordinationPath }),
      'backup_destination_invalid',
    );
    const linked = join(f.directory, 'linked');
    symlinkSync(f.selected.profilePath, linked);
    await failure(createProfileBackup({ profile: f.profile, destinationRoot: linked }));
  } finally {
    f.close();
  }
}, 30000);

test('inspection requires full database, inventory and media validation rather than trusting ready marker', async () => {
  const f = await fixture();
  try {
    const result = await createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
    });
    const media = artifactPath(result.directory, f.hash);
    chmodSync(media, 0o600);
    writeFileSync(media, Buffer.alloc(f.bytes.length, 120));
    chmodSync(media, 0o400);
    await failure(inspectProfileBackup({ directory: result.directory }));
    chmodSync(media, 0o600);
    writeFileSync(media, f.bytes, { mode: 0o400 });
    chmodSync(media, 0o400);
    const inventory = join(result.directory, 'media.jsonl');
    const originalInventory = readFileSync(inventory);
    writeFileSync(inventory, 'invalid\n');
    await failure(
      inspectProfileBackup({ directory: result.directory }),
      'backup_inventory_mismatch',
    );
    writeFileSync(inventory, originalInventory);
    writeFileSync(join(result.directory, 'unexpected'), 'private extra', { mode: 0o600 });
    await failure(inspectProfileBackup({ directory: result.directory }), 'backup_unexpected_asset');
    rmSync(join(result.directory, 'unexpected'));
    writeFileSync(join(result.directory, 'core.db'), 'damaged');
    await failure(
      inspectProfileBackup({ directory: result.directory }),
      'backup_database_mismatch',
    );
    rmSync(join(result.directory, 'ready.json'));
    await failure(inspectProfileBackup({ directory: result.directory }), 'backup_not_ready');
  } finally {
    f.close();
  }
});

test('a real second process holds the same profile-use lock without blocking another profile', async () => {
  const f = await fixture();
  const module = new URL('../../../src/platform/profile.ts', import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { acquireProfileAccess } from ${JSON.stringify(module)}; const held = acquireProfileAccess(JSON.parse(process.env.KITE_BACKUP_TEST_PROFILE)); console.log('held'); for await (const _ of Bun.stdin.stream()) break; held.lock.release();`,
    ],
    {
      env: { ...process.env, KITE_BACKUP_TEST_PROFILE: JSON.stringify(f.profile) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('held');
    reader.releaseLock();
    await failure(
      createProfileBackup({ profile: f.profile, destinationRoot: f.destinationRoot }),
      'owner_busy',
    );
    const other = acquireProfileAccess(
      { dataRoot: f.profile.dataRoot, profile: 'other' },
      'exclusive',
    );
    other.lock.release();
    expect(existsSync(f.destinationRoot)).toBe(false);
    child.stdin.write('release');
    child.stdin.end();
    expect(await child.exited).toBe(0);
    const result = await createProfileBackup({
      profile: f.profile,
      destinationRoot: f.destinationRoot,
    });
    expect(
      (await inspectProfileBackup({ directory: result.directory })).manifest.source.storeId,
    ).toBe(f.storeId);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    f.close();
  }
}, 30000);

test('built maintenance leaf creates and inspects a backup from a consumer outside the source tree', async () => {
  const f = await fixture();
  try {
    const packaged = join(f.directory, 'package');
    const build = await Bun.build({
      entrypoints: [new URL('../../../src/maintenance/index.ts', import.meta.url).pathname],
      root: new URL('../../../src', import.meta.url).pathname,
      outdir: packaged,
      target: 'bun',
      packages: 'external',
    });
    if (!build.success) throw new AggregateError(build.logs, 'maintenance build failed');
    mkdirSync(join(packaged, 'storage', 'migrations'), { recursive: true });
    copyFileSync(
      new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url),
      join(packaged, 'storage', 'migrations', '0001-baseline.sql'),
    );
    writeFileSync(
      join(packaged, 'package.json'),
      JSON.stringify({
        name: '@kite-ai/agent',
        type: 'module',
        exports: { './maintenance': './maintenance/index.js' },
      }),
    );
    const consumer = join(f.directory, 'consumer');
    mkdirSync(join(consumer, 'node_modules', '@kite-ai'), { recursive: true });
    symlinkSync(packaged, join(consumer, 'node_modules', '@kite-ai', 'agent'));
    const script = join(consumer, 'main.ts');
    writeFileSync(
      script,
      `import { createProfileBackup, inspectProfileBackup } from '@kite-ai/agent/maintenance'; const created = await createProfileBackup(${JSON.stringify({ profile: f.profile, destinationRoot: f.destinationRoot })}); const inspected = await inspectProfileBackup({directory:created.directory}); console.log(JSON.stringify({ storeId: inspected.manifest.source.storeId, cursor: inspected.manifest.source.snapshotCursor, blobs: inspected.manifest.media.blobCount }));`,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: consumer,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(errors).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({
      storeId: f.storeId,
      cursor: '9007199254740993',
      blobs: '1',
    });
  } finally {
    f.close();
  }
}, 30000);
