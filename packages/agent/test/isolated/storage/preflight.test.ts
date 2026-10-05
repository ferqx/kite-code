import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProfileAccess } from '../../../src/platform/profile';
import { openSqliteStore, preflightSqliteStore } from '../../../src/sqlite';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'kite-preflight-'));
  chmodSync(dataRoot, 0o700);
  roots.push(dataRoot);
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
  mkdirSync(value.profilePath, { mode: 0o700 });
  writeFileSync(value.databasePath, '', { mode: 0o600 });
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
  mkdirSync(unknown.profilePath, { mode: 0o700 });
  const unknownDb = new Database(unknown.databasePath, { create: true });
  unknownDb.exec('CREATE VIEW unknown_view AS SELECT 1');
  unknownDb.close(true);
  chmodSync(unknown.databasePath, 0o600);
  const unknownBytes = bytes(unknown.databasePath);
  await rejected(unknown.options, 'store_incompatible');
  expect(bytes(unknown.databasePath)).toBe(unknownBytes);
  const corrupt = fixture();
  mkdirSync(corrupt.profilePath, { mode: 0o700 });
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
  chmodSync(value.databasePath, 0o644);
  await rejected(value.options, 'store_access_denied');
  chmodSync(value.databasePath, 0o600);
  linkSync(value.databasePath, `${value.databasePath}.link`);
  await rejected(value.options, 'store_access_denied');
  rmSync(`${value.databasePath}.link`);
  const original = `${value.databasePath}.original`;
  copyFileSync(value.databasePath, original);
  rmSync(value.databasePath);
  symlinkSync(original, value.databasePath);
  await expect(preflightSqliteStore(value.options)).rejects.toMatchObject({
    code: 'store_access_denied',
  });
  rmSync(value.databasePath);
  copyFileSync(original, value.databasePath);
  chmodSync(value.databasePath, 0o600);
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
    const script = `import {acquireProfileAccess} from ${JSON.stringify(source)};const access=acquireProfileAccess(${JSON.stringify(value.options)},${JSON.stringify(mode)});console.log('ready');for await(const chunk of Bun.stdin.stream())break;access.lock.release();`;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
  const packageRoot = mkdtempSync(join(tmpdir(), 'kite-preflight-package-'));
  roots.push(packageRoot);
  const entry = fileURLToPath(new URL('../../../src/sqlite.ts', import.meta.url));
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    packages: 'external',
    outdir: join(packageRoot, 'dist'),
  });
  expect(result.success).toBe(true);
  const migration = join(packageRoot, 'dist/storage/migrations/0001-baseline.sql');
  mkdirSync(dirname(migration), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url)),
    migration,
  );
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@kite-ai/agent',
      type: 'module',
      exports: { './sqlite': './dist/sqlite.js' },
    }),
  );
  const script = join(packageRoot, 'consumer.ts');
  writeFileSync(
    script,
    `import {preflightSqliteStore} from '@kite-ai/agent/sqlite';console.log(JSON.stringify(await preflightSqliteStore(${JSON.stringify(value.options)})));`,
  );
  const run = () =>
    Bun.spawn([process.execPath, script], { cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' });
  const child = run();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
    status: 'compatible',
    storeId: value.storeId,
    formatMajor: 1,
  });
  rmSync(migration);
  const missing = run();
  expect(await missing.exited).not.toBe(0);
  expect(await new Response(missing.stderr).text()).toContain('store_incompatible');
});
