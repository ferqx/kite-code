import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { afterEach, expect, test } from '#kite-test';
import { build as buildBundle } from '../../../../../scripts/tooling/build';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import {
  expectPrivateMode,
  fixturePermissions,
  recordReparseEntry,
} from '../../../../../tests/fixtures/test-filesystem';
import { acquireProfileAccess } from '../../../src/platform/profile';
import { nodeRuntimeFlags } from '../../../src/platform/runtime-flags';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../src/platform/windows-path-security';
import { openSqliteStore, preflightSqliteStore } from '../../../src/sqlite';
import { defaultSqliteEngineAssets } from '../../../src/sqlite-engine';
import { fixtureNodeExecutable, fixtureRuntimeBuild } from '../../fixtures/node-runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-preflight-')));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const options = { dataRoot, profile: 'selected' };
  const access = acquireProfileAccess(options);
  access.lock.release();
  return {
    options,
    profilePath: access.profilePath,
    databasePath: access.databasePath,
    coordinationPath: access.coordinationPath,
  };
}
async function current() {
  const value = fixture();
  const store = await openSqliteStore(value.options);
  const metadata = await store.getMetadata();
  await store.close();
  return { ...value, storeId: metadata.storeId };
}
function bytes(path: string) {
  return readFileSync(path).toString('hex');
}
async function rejected(options: Parameters<typeof preflightSqliteStore>[0], code: string) {
  await expect(preflightSqliteStore(options)).rejects.toMatchObject({ code });
  // A real subsequent exclusive admission proves cleanup released shared profile use.
  const access = acquireProfileAccess(options, 'exclusive');
  access.lock.release();
}

test('absent and empty are explicit and never initialize profile or Core', async () => {
  const value = fixture();
  expect(await preflightSqliteStore(value.options)).toEqual({ status: 'absent' });
  expect(existsSync(value.profilePath)).toBe(false);
  privateDirectory(value.profilePath);
  if (process.platform === 'win32')
    defaultWindowsPathSecurity()!.writePrivateFile(value.databasePath, Buffer.alloc(0));
  else writeFileSync(value.databasePath, '', { mode: 0o600 });
  expect(await preflightSqliteStore(value.options)).toEqual({ status: 'uninitialized' });
  expect(bytes(value.databasePath)).toBe('');
  expect(existsSync(join(value.profilePath, 'profile.json'))).toBe(false);
  const db = new Database(value.databasePath, { readonly: true });
  expect(db.query("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
  db.close(true);
});

test('current Store identity and exact database/profile bytes survive readonly preflight', async () => {
  const value = await current();
  const before = bytes(value.databasePath);
  const profile = bytes(join(value.profilePath, 'profile.json'));
  expect(await preflightSqliteStore(value.options)).toEqual({
    status: 'compatible',
    storeId: value.storeId,
    formatMajor: 1,
  });
  expect(bytes(value.databasePath)).toBe(before);
  expect(bytes(join(value.profilePath, 'profile.json'))).toBe(profile);
  const access = acquireProfileAccess(value.options, 'exclusive');
  access.lock.release();
});

test('invalid profile manifests remain incompatible without changing the database or manifest', async () => {
  const value = await current();
  const database = bytes(value.databasePath);
  const manifest = join(value.profilePath, 'profile.json');
  for (const contents of ['{', 'null', '[]', '{}', '{"formatMajor":2}', ' '.repeat(1025)]) {
    writeFileSync(manifest, contents);
    await rejected(value.options, 'store_incompatible');
    expect(bytes(value.databasePath)).toBe(database);
    expect(readFileSync(manifest, 'utf8')).toBe(contents);
  }
});

test('a forged current profile fingerprint cannot admit a same-major legacy database schema', async () => {
  const value = await current();
  const header = bytes(join(value.profilePath, 'profile.json'));
  const db = new Database(value.databasePath);
  db.exec(
    "DROP TABLE schema_migration; CREATE TABLE legacy_marker(value TEXT NOT NULL); INSERT INTO legacy_marker VALUES('untouched')",
  );
  db.close(true);
  const database = bytes(value.databasePath);
  await rejected(value.options, 'store_incompatible');
  for (const mode of ['readonly', 'readwrite'] as const)
    await expect(openSqliteStore({ ...value.options, mode })).rejects.toMatchObject({
      code: 'store_incompatible',
    });
  expect(bytes(value.databasePath)).toBe(database);
  expect(bytes(join(value.profilePath, 'profile.json'))).toBe(header);
});

for (const missing of ['all', 'work', 'mail'] as const)
  test(`unfinished current-format Store without ${missing === 'work' ? 'the work authority index' : missing === 'mail' ? 'the mail recipient index' : 'the reviewed access indexes'} is rejected without rewriting its schema or bytes`, async () => {
    const value = await current();
    const indexes =
      missing === 'work'
        ? ['command_work_authority']
        : missing === 'mail'
          ? ['command_mail_recipient']
          : [
              'authorization_invalidation_check',
              'context_result_execution',
              'execution_origin_command',
              'execution_work_effect',
              'command_work_authority',
              'command_mail_recipient',
            ];
    const baseline = readFileSync(
      new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url),
      'utf8',
    );
    const priorBaseline = baseline
      .split('\n')
      .filter((line) => !indexes.some((name) => line.startsWith(`CREATE INDEX ${name} `)))
      .join('\n');
    const db = new Database(value.databasePath);
    for (const index of indexes) db.exec(`DROP INDEX ${index}`);
    db.query('UPDATE schema_migration SET checksum=? WHERE id=?').run(
      createHash('sha256').update(priorBaseline).digest('hex'),
      '0001-baseline',
    );
    expect(db.query('SELECT format_major FROM storage_meta').get()).toEqual({ format_major: 1 });
    db.close(true);
    const database = bytes(value.databasePath);
    const profile = bytes(join(value.profilePath, 'profile.json'));
    await rejected(value.options, 'store_incompatible');
    for (const mode of ['readonly', 'readwrite'] as const)
      await expect(openSqliteStore({ ...value.options, mode })).rejects.toMatchObject({
        code: 'store_incompatible',
      });
    expect(bytes(value.databasePath)).toBe(database);
    expect(bytes(join(value.profilePath, 'profile.json'))).toBe(profile);
  });

test('live WAL Store remains usable and Core/WAL bytes are unchanged', async () => {
  const value = fixture();
  const store = await openSqliteStore(value.options);
  try {
    const metadata = await store.getMetadata();
    await store.createWorkspace({
      expectedStoreId: metadata.storeId,
      id: 'original',
      rootUri: 'file:///owned-temporary',
      name: 'original',
    });
    const database = bytes(value.databasePath);
    const wal = bytes(`${value.databasePath}-wal`);
    expect(await preflightSqliteStore(value.options)).toEqual({
      status: 'compatible',
      storeId: metadata.storeId,
      formatMajor: 1,
    });
    expect(bytes(value.databasePath)).toBe(database);
    expect(bytes(`${value.databasePath}-wal`)).toBe(wal);
    expect((await store.listWorkspaces({})).map((item) => item.id)).toEqual(['original']);
  } finally {
    await store.close();
  }
});

test('future, unknown, broken schema and migration checksum reject without writes or retained resources', async () => {
  for (const mutation of [
    'UPDATE storage_meta SET format_major=99',
    'UPDATE storage_meta SET format_major=2',
    'DROP TABLE storage_meta',
    'CREATE TABLE unknown_extension(id TEXT)',
    "UPDATE schema_migration SET checksum='wrong'",
  ]) {
    const value = await current();
    const db = new Database(value.databasePath);
    db.exec(mutation);
    db.close(true);
    const before = bytes(value.databasePath);
    await rejected(value.options, 'store_incompatible');
    expect(bytes(value.databasePath)).toBe(before);
  }
  const unknown = fixture();
  privateDirectory(unknown.profilePath);
  const unknownDb = new Database(unknown.databasePath, { create: true });
  unknownDb.exec('CREATE VIEW unknown_view AS SELECT 1');
  unknownDb.close(true);
  fixturePermissions(unknown.databasePath, 0o600);
  const unknownBytes = bytes(unknown.databasePath);
  await rejected(unknown.options, 'store_incompatible');
  expect(bytes(unknown.databasePath)).toBe(unknownBytes);
  const corrupt = fixture();
  privateDirectory(corrupt.profilePath);
  writeFileSync(corrupt.databasePath, 'invalid SQLite bytes', { mode: 0o600 });
  await rejected(corrupt.options, 'store_incompatible');
  expect(bytes(corrupt.databasePath)).toBe(Buffer.from('invalid SQLite bytes').toString('hex'));
});

test('rollback journal, hard/soft links, private permissions and restore journal reject', async () => {
  const value = await current();
  const before = bytes(value.databasePath);
  writeFileSync(`${value.databasePath}-journal`, 'preserved journal', { mode: 0o600 });
  await rejected(value.options, 'store_journal_present');
  expect(bytes(value.databasePath)).toBe(before);
  expect(readFileSync(`${value.databasePath}-journal`, 'utf8')).toBe('preserved journal');
  rmSync(`${value.databasePath}-journal`);
  expectPrivateMode(value.databasePath, 0o600);
  fixturePermissions(value.databasePath, 0o644);
  expect(() => expectPrivateMode(value.databasePath, 0o600)).toThrow();
  await rejected(value.options, 'store_access_denied');
  expect(bytes(value.databasePath)).toBe(before);
  fixturePermissions(value.databasePath, 0o600);
  expectPrivateMode(value.databasePath, 0o600);
  expect((await preflightSqliteStore(value.options)).status).toBe('compatible');
  linkSync(value.databasePath, `${value.databasePath}.link`);
  await rejected(value.options, 'store_access_denied');
  rmSync(`${value.databasePath}.link`);
  const original = `${value.databasePath}.original`;
  copyFileSync(value.databasePath, original);
  rmSync(value.databasePath);
  recordReparseEntry(original, value.databasePath);
  await expect(preflightSqliteStore(value.options)).rejects.toMatchObject({
    code: 'store_access_denied',
  });
  rmSync(value.databasePath);
  copyFileSync(original, value.databasePath);
  fixturePermissions(value.databasePath, 0o600);
  writeFileSync(join(value.coordinationPath, 'restore-journal.json'), '{}', { mode: 0o600 });
  await expect(preflightSqliteStore(value.options)).rejects.toMatchObject({
    code: 'restore_reconciliation_required',
  });
  rmSync(join(value.coordinationPath, 'restore-journal.json'));
  const access = acquireProfileAccess(value.options, 'exclusive');
  access.lock.release();
});

test('real second process shared coexistence, exclusive maintenance busy and unrelated profile availability', async () => {
  const value = await current();
  const source = fileURLToPath(new URL('../../../src/platform/profile.ts', import.meta.url));
  for (const mode of ['shared', 'exclusive']) {
    const script = `import {acquireProfileAccess} from ${JSON.stringify(source)};const access=acquireProfileAccess(${JSON.stringify(value.options)},${JSON.stringify(mode)});console.log('ready');for await(const chunk of process.stdin)break;access.lock.release();`;
    const child = spawnProcess(
      [process.execPath, ...testRuntimeFlags, '--input-type=module-typescript', '--eval', script],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
      reader.releaseLock();
      if (mode === 'shared')
        expect((await preflightSqliteStore(value.options)).status).toBe('compatible');
      else
        await expect(preflightSqliteStore(value.options)).rejects.toMatchObject({
          code: 'owner_busy',
        });
      expect(await preflightSqliteStore({ ...value.options, profile: 'other' })).toEqual({
        status: 'absent',
      });
    } finally {
      child.stdin.write('release');
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }
  }
});

test('public bundled sqlite leaf outside source tree reads its packaged migration asset', async () => {
  const value = await current();
  const database = bytes(value.databasePath);
  const profile = bytes(join(value.profilePath, 'profile.json'));
  const packageRoot = mkdtempSync(join(tmpdir(), 'kite-preflight-package-'));
  roots.push(packageRoot);
  const entry = fileURLToPath(new URL('../../../src/sqlite.ts', import.meta.url));
  const output = join(packageRoot, 'dist');
  const result = await buildBundle({
    entrypoints: [entry],
    ...fixtureRuntimeBuild(output),
    packages: 'external',
    outdir: output,
  });
  expect(result.success).toBe(true);
  cpSync(defaultSqliteEngineAssets().root, join(output, 'storage/engine'), { recursive: true });
  const migration = join(packageRoot, 'dist/storage/migrations/0001-baseline.sql');
  mkdirSync(dirname(migration), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url)),
    migration,
  );
  const trajectoryMigration = join(
    packageRoot,
    'dist/storage/migrations/0002-trajectory-facts.sql',
  );
  copyFileSync(
    fileURLToPath(
      new URL('../../../src/storage/migrations/0002-trajectory-facts.sql', import.meta.url),
    ),
    trajectoryMigration,
  );
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@kite-ai/agent',
      type: 'module',
      exports: { './sqlite': './dist/sqlite.js' },
    }),
  );
  const script = join(packageRoot, 'consumer.mjs');
  writeFileSync(
    script,
    `import {preflightSqliteStore} from '@kite-ai/agent/sqlite';console.log(JSON.stringify(await preflightSqliteStore(${JSON.stringify(value.options)})));`,
  );
  const run = () =>
    spawnProcess([fixtureNodeExecutable(), ...nodeRuntimeFlags, script], {
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const child = run();
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
    status: 'compatible',
    storeId: value.storeId,
    formatMajor: 1,
  });
  rmSync(migration);
  const missing = run();
  expect(await missing.exited).not.toBe(0);
  expect(await new Response(missing.stderr).text()).toContain('store_preflight_failed');
  expect(bytes(value.databasePath)).toBe(database);
  expect(bytes(join(value.profilePath, 'profile.json'))).toBe(profile);
});

test('unsupported format 2 rejection preserves original database and profile before writer admission; readonly WAL discovery adds no frames', async () => {
  const value = await current();
  const db = new Database(value.databasePath);
  db.exec('UPDATE storage_meta SET format_major=2');
  db.close(true);
  const before = bytes(value.databasePath);
  const profile = bytes(join(value.profilePath, 'profile.json'));
  await expect(openSqliteStore(value.options)).rejects.toMatchObject({
    code: 'store_incompatible',
  });
  expect(bytes(value.databasePath)).toBe(before);
  expect(bytes(join(value.profilePath, 'profile.json'))).toBe(profile);
  // SQLite may create its empty WAL/shared-memory discovery sidecars even for a
  // readonly connection to an existing WAL-mode database. No writer was admitted.
  if (existsSync(`${value.databasePath}-wal`))
    expect(readFileSync(`${value.databasePath}-wal`)).toHaveLength(0);
  const access = acquireProfileAccess(value.options, 'exclusive');
  access.lock.release();
});
