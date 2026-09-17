// Real source CLI -> qualified transient stdio Service -> explicit daemon, isolated HOME only.
// bun run tests/qualification/session-store-daemon-source-cli.ts
import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initializeKiteHomeStoreSchema } from '../../packages/runtime-storage-sqlite/src/kite-home-store';
import { KITE_SESSION_STORE11_DDL } from '../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';

if (process.platform !== 'darwin')
  throw new Error('Source CLI migration qualification requires macOS.');
const repository = resolve(import.meta.dir, '../..');
const cli = join(repository, 'scripts/release/entrypoints/cli.ts');

async function command(home: string, workspace: string, action: 'start' | 'stop' | 'status') {
  const child = Bun.spawn(
    [process.execPath, cli, '--kite-home', home, 'server', action, '--workspace', workspace],
    {
      cwd: repository,
      env: { ...process.env, HOME: dirname(home), USERPROFILE: dirname(home) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function scenario(version: 9 | 11 | 'unknown') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `kite-daemon-source-${version}-`)));
  const home = join(root, '.kite-code');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  const sourcePath =
    version === 9
      ? join(home, 'kite.sqlite')
      : join(home, 'source-profiles', '1'.repeat(32), 'kite-session.sqlite');
  mkdirSync(dirname(sourcePath), { recursive: true, mode: 0o700 });
  if (version !== 9) chmodSync(join(home, 'source-profiles'), 0o700);
  const source = new Database(sourcePath, { strict: true });
  chmodSync(sourcePath, 0o600);
  try {
    if (version === 9) initializeKiteHomeStoreSchema(source);
    else {
      for (const ddl of KITE_SESSION_STORE11_DDL) source.run(ddl);
      source
        .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
        .run('schema_version', version === 11 ? '11' : '12');
      source
        .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
        .run('format_epoch', 'kite-session-accepted-runs-2026-09-15');
      source.run(`PRAGMA user_version=${version === 11 ? 11 : 12}`);
    }
  } finally {
    source.close(false);
  }
  const before = readFileSync(sourcePath);
  try {
    const started = await command(home, workspace, 'start');
    if (version === 'unknown') {
      assert.notEqual(started.exitCode, 0);
      assert.match(started.stderr, /STORE_HISTORY_RECONCILIATION_REQUIRED|STORE_INCOMPATIBLE/u);
      assert.deepEqual(readFileSync(sourcePath), before);
      const status = await command(home, workspace, 'status');
      assert.equal(status.exitCode, 0);
      assert.match(status.stdout, /App Server: absent/u);
      console.log(JSON.stringify({ version, status: 'rejected_without_daemon_or_source_change' }));
      return;
    }
    assert.equal(started.exitCode, 0, started.stderr);
    assert.match(started.stdout, /App Server: ready/u);
    const canonical = join(home, 'kite-session.sqlite');
    const database = new Database(canonical, { readonly: true });
    try {
      assert.equal(
        database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
        10,
      );
      for (const table of ['runtime_sessions', 'runtime_runs'])
        assert.equal(
          database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count,
          0,
        );
    } finally {
      database.close();
    }
    console.log(
      JSON.stringify({ version, status: 'prepared_and_daemon_ready_without_session_or_run' }),
    );
  } finally {
    const stopped = await command(home, workspace, 'stop');
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const version of [9, 11, 'unknown'] as const) await scenario(version);
