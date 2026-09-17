import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initializeKiteHomeStoreSchema } from '../../packages/runtime-storage-sqlite/src/kite-home-store';
import { KITE_SESSION_STORE11_DDL } from '../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import { installOssCandidate } from '../../scripts/release/install-oss-candidate';

const archive = process.env.KITE_INSTALLED_STORE_QUALIFICATION_ARCHIVE;
const qualified = process.platform === 'darwin' && !!archive;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!qualified)(
  'installed CLI and TUI prepare Store 9 through their real pinned Service',
  async () => {
    const { root, cli, tui } = await installFixture();
    const cliHome = fixtureStore(root, 'cli9', 9);
    const cliResult = command(cli, [
      'run',
      '--task',
      'qualification-only',
      '--execution-status',
      '--trust-workspace',
      '--workspace',
      root,
      '--kite-home',
      cliHome,
    ]);
    assertSuccess(cliResult, 'installed CLI');
    expect(new TextDecoder().decode(cliResult.stdout)).toContain(
      'kite.app.execution-status.response.v1',
    );
    expectStore10(cliHome, true);

    const tuiHome = fixtureStore(root, 'tui9', 9);
    let transcript = '';
    const child = Bun.spawn({
      cmd: [tui, '--kite-home', tuiHome],
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' },
      terminal: {
        cols: 120,
        rows: 40,
        data(_terminal, bytes) {
          transcript += new TextDecoder().decode(bytes);
        },
      },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !transcript.includes('是否打开此工作区')) {
        if (child.exitCode !== null) break;
        await Bun.sleep(50);
      }
      expect(transcript).toContain('Kite Code');
      expect(transcript).toContain('是否打开此工作区');
      child.terminal?.write('\r'); // Exit the trust prompt without creating a Session.
      expect(await child.exited).toBe(0);
      expectStore10(tuiHome, true);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await child.exited.catch(() => undefined);
    }
  },
  45_000,
);

test.skipIf(!qualified)(
  'installed explicit daemon prepares known Store 9 and 11 before ready',
  async () => {
    const { root, cli } = await installFixture();
    for (const schema of [9, 11] as const) {
      const home = fixtureStore(root, `daemon${schema}`, schema);
      const args = ['--workspace', root, '--kite-home', home];
      try {
        const started = command(cli, ['server', 'start', ...args]);
        assertSuccess(started, `installed daemon ${schema} start`);
        expect(new TextDecoder().decode(started.stdout)).toContain('ready');
        expectStore10(home, schema === 9);
        const status = command(cli, ['server', 'status', '--json', ...args]);
        assertSuccess(status, `installed daemon ${schema} status`);
        expect(new TextDecoder().decode(status.stdout)).toContain('ready');
      } finally {
        const stopped = command(cli, ['server', 'stop', ...args]);
        assertSuccess(stopped, `installed daemon ${schema} stop`);
        expect(new TextDecoder().decode(stopped.stdout)).toContain('absent');
      }
      expectStore10(home, schema === 9);
    }
  },
  75_000,
);

async function installFixture() {
  if (!archive) throw new Error('The qualification archive is required.');
  const root = realpathSync.native(mkdtempSync('/private/tmp/kite-installed-store-qualification-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const prefix = join(root, 'managed');
  await installOssCandidate({ archivePath: archive, prefix });
  return { root, cli: join(prefix, 'bin/kite'), tui: join(prefix, 'bin/kite-tui') };
}

function fixtureStore(root: string, name: string, schema: 9 | 11): string {
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  const path = join(home, schema === 9 ? 'kite.sqlite' : 'kite-session.sqlite');
  const db = new Database(path, { create: true, strict: true });
  try {
    if (schema === 9) initializeKiteHomeStoreSchema(db);
    else {
      for (const sql of KITE_SESSION_STORE11_DDL) db.run(sql);
      db.query('INSERT INTO kite_meta (key,value) VALUES (?,?)').run('schema_version', '11');
      db.query('INSERT INTO kite_meta (key,value) VALUES (?,?)').run(
        'format_epoch',
        'kite-session-accepted-runs-2026-09-15',
      );
      db.run('PRAGMA user_version = 11');
    }
  } finally {
    db.close(false);
  }
  chmodSync(path, 0o600);
  return home;
}

function expectStore10(home: string, oldNameGone: boolean): void {
  const db = new Database(join(home, 'kite-session.sqlite'), { readonly: true, strict: true });
  try {
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      10,
    );
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runtime_sessions').get()?.n).toBe(
      0,
    );
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runtime_runs').get()?.n).toBe(0);
  } finally {
    db.close(false);
  }
  if (oldNameGone) expect(existsSync(join(home, 'kite.sqlite'))).toBe(false);
  expect(existsSync(join(home, 'kite-session-publication.json'))).toBe(false);
}

function command(executable: string, args: readonly string[]) {
  return Bun.spawnSync([executable, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
}

function assertSuccess(result: ReturnType<typeof command>, label: string): void {
  if (result.exitCode === 0) return;
  const stderr = new TextDecoder().decode(result.stderr).slice(0, 2_000);
  const stdout = new TextDecoder().decode(result.stdout).slice(0, 2_000);
  throw new Error(`${label} exited ${result.exitCode}: ${stderr || stdout}`);
}
