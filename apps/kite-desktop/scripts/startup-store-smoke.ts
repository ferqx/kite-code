import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { KITE_SESSION_STORE_TABLE_COLUMNS } from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import {
  assertKiteSessionStore11Schema,
  KITE_SESSION_STORE11_DDL,
} from '../../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';

if (process.platform !== 'darwin') throw new Error('Native Desktop startup smoke requires macOS.');

const root = resolve(import.meta.dir, '..');
const packagedExecutable = resolve(
  process.argv[2] ?? join(root, `out/kite-darwin-${process.arch}/kite.app/Contents/MacOS/kite`),
);
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-store-startup-')));
const appData = join(home, 'app-data');
const application = join(home, 'kite.app');
const workspace = join(home, 'workspace');
const storePath = join(home, '.kite-code/kite-session.sqlite');
cpSync(resolve(dirname(packagedExecutable), '../..'), application, {
  recursive: true,
  verbatimSymlinks: true,
});
for (const path of [appData, workspace, join(home, '.kite-code')]) mkdirSync(path, { mode: 0o700 });

type InspectorResult = { result?: { value?: unknown }; exceptionDetails?: unknown };
type NativeApp = {
  page: Page;
  evaluateMain(expression: string): Promise<unknown>;
  startRenderer(): Promise<void>;
  sawQuitConfirmation(): boolean;
  close(): Promise<void>;
};

function progress(message: string): void {
  console.log(`[store-startup] ${message}`);
}

/** Isolate Electron's paths at its first debugger pause, before the packaged entry runs. */
async function launchNativeApp(
  options: { pauseRenderer?: boolean; quitTimeoutMs?: number } = {},
): Promise<NativeApp> {
  const child = spawn(
    join(application, 'Contents/MacOS/kite'),
    ['--inspect-brk=0', '--remote-debugging-port=0'],
    { cwd: home, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  let logs = '';
  child.stdout.on('data', (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-65_536);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-65_536);
  });
  const endpoint = async (pattern: RegExp): Promise<string> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const match = logs.match(pattern);
      if (match?.[1]) return match[1];
      if (child.exitCode !== null) throw new Error(`Packaged Electron exited: ${logs}`);
      await Bun.sleep(25);
    }
    throw new Error(`Packaged Electron debugger did not start: ${logs}`);
  };
  let inspector: WebSocket | undefined;
  let browser: Browser | undefined;
  try {
    inspector = new WebSocket(await endpoint(/Debugger listening on (ws:\/\/[^\s]+)/u));
    await new Promise<void>((done, fail) => {
      inspector!.addEventListener('open', () => done(), { once: true });
      inspector!.addEventListener('error', () => fail(new Error('Electron inspector failed.')), {
        once: true,
      });
    });
    let nextId = 0;
    const pending = new Map<
      number,
      { done: (result: InspectorResult) => void; fail: (error: Error) => void }
    >();
    let onPause: (callFrameId: string) => void = () => {};
    inspector.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Debugger.paused') onPause(message.params.callFrames[0].callFrameId);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
        else waiter.done(message.result);
      }
    });
    const command = (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<InspectorResult> => {
      const id = ++nextId;
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`Inspector timed out: ${method}`));
        }, 30_000);
        pending.set(id, {
          done: (result) => {
            clearTimeout(timer);
            done(result);
          },
          fail: (error) => {
            clearTimeout(timer);
            fail(error);
          },
        });
        inspector!.send(JSON.stringify({ id, method, params }));
      });
    };
    await command('Runtime.enable');
    await command('Debugger.enable');
    const paused = new Promise<string>((done) => {
      onPause = done;
    });
    await command('Runtime.runIfWaitingForDebugger');
    const callFrameId = await paused;
    const isolated = await command('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression: `globalThis.__kiteStartupSmoke = require('electron');
__kiteStartupSmoke.app.setPath('home', ${JSON.stringify(home)});
__kiteStartupSmoke.app.setPath('appData', ${JSON.stringify(appData)});
__kiteStartupSmoke.app.setPath('userData', ${JSON.stringify(join(appData, 'dev.kite-code.desktop'))});
${
  options.pauseRenderer
    ? `__kiteStartupSmoke.originalLoadFile = __kiteStartupSmoke.BrowserWindow.prototype.loadFile;
__kiteStartupSmoke.BrowserWindow.prototype.loadFile = function(...args) {
  __kiteStartupSmoke.resumeRenderer = () => __kiteStartupSmoke.originalLoadFile.apply(this, args);
  return this.loadURL('about:blank');
};`
    : ''
}
__kiteStartupSmoke.app.getPath('home')`,
      returnByValue: true,
    });
    assert.equal(isolated.result?.value, home, 'Electron paths must be isolated before entry');
    const evaluateMain = async (expression: string): Promise<unknown> => {
      const result = await command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    await command('Debugger.resume');
    browser = await chromium.connectOverCDP(
      await endpoint(/DevTools listening on (ws:\/\/[^\s]+)/u),
    );
    const page =
      browser.contexts()[0]!.pages()[0] ?? (await browser.contexts()[0]!.waitForEvent('page'));
    await evaluateMain(`__kiteStartupSmoke.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(workspace)}] });
__kiteStartupSmoke.dialog.showMessageBox = async (...args) => { const options = args.at(-1); console.log('[store-startup dialog]', options?.title, options?.message); return { response: 0, checkboxChecked: false }; };`);
    assert.equal(await evaluateMain('__kiteStartupSmoke.app.isPackaged'), true);
    return {
      page,
      evaluateMain,
      startRenderer: async () => {
        if (options.pauseRenderer) await evaluateMain('__kiteStartupSmoke.resumeRenderer()');
      },
      sawQuitConfirmation: () => logs.includes('[store-startup dialog] 退出 kite？'),
      close: async () => {
        progress('requesting packaged app quit');
        await evaluateMain('__kiteStartupSmoke.app.quit()').catch(() => undefined);
        inspector?.close();
        await browser?.close();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<null>((done) => {
          timeout = setTimeout(() => done(null), options.quitTimeoutMs ?? 20_000);
        });
        const code = await Promise.race([exited, deadline]);
        clearTimeout(timeout);
        if (code === null && child.exitCode === null) child.kill('SIGKILL');
        assert.equal(code, 0, `Packaged Electron did not exit cleanly: ${logs}`);
        progress('packaged app exited cleanly');
      },
    };
  } catch (error) {
    inspector?.close();
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null) child.kill('SIGKILL');
    throw new Error(`Native startup failed: ${String(error)}\n${logs}`);
  }
}

async function selectWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('button', { name: '项目空间', exact: true }).click();
  await page.getByRole('menuitem', { name: '添加项目…', exact: true }).click();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
}

async function runAndClose(app: NativeApp, stage: string, run: () => Promise<void>): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  try {
    await app.close();
  } catch (closeError) {
    if (!failure) throw closeError;
    progress(`${stage} teardown also failed: ${String(closeError)}`);
  }
  if (failure) throw failure;
}

/** Materialize the exact observed Store 11 layout from production-written session rows. */
function materializeStore11(): void {
  const targetPath = join(
    home,
    '.kite-code/source-profiles',
    '1'.repeat(32),
    'kite-session.sqlite',
  );
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  chmodSync(join(home, '.kite-code/source-profiles'), 0o700);
  chmodSync(dirname(targetPath), 0o700);
  const source = new Database(storePath, { readonly: true });
  const target = new Database(targetPath, { strict: true });
  chmodSync(targetPath, 0o600);
  try {
    for (const ddl of KITE_SESSION_STORE11_DDL) target.run(ddl);
    target.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '11');
    target
      .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
      .run('format_epoch', 'kite-session-accepted-runs-2026-09-15');
    target.run('PRAGMA user_version=11');
    const tableOrder = [
      'workspaces',
      'runtime_sessions',
      'runtime_events',
      'runtime_snapshots',
      'runtime_named_snapshots',
      'runtime_file_preimages',
      'runtime_command_receipts',
      'runtime_runs',
      'runtime_session_tombstones',
      'model_artifacts',
      'plan_artifacts',
      'capability_artifacts',
      'filesystem_preimage_artifacts',
      'sandbox_preparation_artifacts',
      'subagent_task_artifacts',
      'subagent_lifecycle_artifacts',
      'subagent_continuation_artifacts',
      'runtime_effect_leases',
    ] as const;
    for (const table of tableOrder) {
      const columns = KITE_SESSION_STORE_TABLE_COLUMNS[table];
      const select = source.query<Record<string, string | number | Uint8Array | null>, []>(
        `SELECT ${columns.join(',')} FROM ${table}`,
      );
      const insert = target.query(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (const row of select.iterate()) insert.run(...columns.map((column) => row[column]!));
    }
    for (const row of source
      .query<{ key: string; value: string }, []>(
        "SELECT key,value FROM kite_meta WHERE key NOT IN ('schema_version','format_epoch')",
      )
      .iterate())
      target.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(row.key, row.value);
  } finally {
    source.close();
    target.close(false);
  }
  const legacy = new Database(targetPath, { readonly: true });
  try {
    assert.equal(
      legacy.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      11,
    );
    assert.equal(
      legacy.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions').get()
        ?.count,
      1,
    );
  } finally {
    legacy.close();
  }
  for (const path of [storePath, `${storePath}-wal`, `${storePath}-shm`])
    rmSync(path, { force: true });
}

/** Add valid SQLite freelist pages without adding or changing a business record. */
function enlargeStore11ForObservablePreparation(): string {
  const path = join(home, '.kite-code/source-profiles', '1'.repeat(32), 'kite-session.sqlite');
  const db = new Database(path, { strict: true });
  try {
    db.run('PRAGMA journal_mode=DELETE');
    db.run('CREATE TABLE native_smoke_padding(bytes BLOB NOT NULL)');
    const insert = db.query('INSERT INTO native_smoke_padding(bytes) VALUES (zeroblob(?))');
    for (let index = 0; index < 8; index++) insert.run(64 * 1024 * 1024);
    db.run('DROP TABLE native_smoke_padding');
    assertKiteSessionStore11Schema(db);
    assert.equal(
      db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
  } finally {
    db.close(false);
  }
  assert.ok(statSync(path).size >= 512 * 1024 * 1024);
  return path;
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const model = createMockModelServer();
model.setResponses([
  { message: { content: 'Current Store history remains readable.' } },
  { message: { content: 'Converted Store continuation is saved.' } },
]);
writeFileSync(
  join(home, '.kite-code/kite-code.jsonc'),
  JSON.stringify({
    provider: {
      test: {
        type: 'openai-compatible',
        apiKey: 'local-fixture',
        baseURL: model.baseURL,
        model: 'mock-model',
        models: ['mock-model'],
      },
    },
    model: { default: { provider: 'test', name: 'mock-model' } },
    interactionMode: 'auto',
    sandbox: { enabled: false },
    features: {},
    mcpServers: {},
  }),
  { mode: 0o600 },
);

try {
  progress('fresh launch');
  const fresh = await launchNativeApp();
  await runAndClose(fresh, 'fresh', async () => {
    await selectWorkspace(fresh.page);
    await fresh.page
      .getByRole('textbox', { name: '任务输入' })
      .fill('Current Store history fixture');
    await fresh.page.getByRole('button', { name: '发送消息', exact: true }).click();
    await fresh.page
      .getByText('Current Store history remains readable.', { exact: false })
      .waitFor({ timeout: 30_000 });
    await fresh.page.getByText('正在回复…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(model.getRequestCount(), 1);
    progress('fresh answer completed');
  });

  let originalSessionId: string;
  const current = new Database(storePath, { readonly: true });
  try {
    assert.equal(
      current.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      10,
    );
    const original = current
      .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions LIMIT 1')
      .get();
    assert.ok(original);
    originalSessionId = original.session_id;
  } finally {
    current.close();
  }

  progress('existing Store restart');
  const existing = await launchNativeApp();
  await runAndClose(existing, 'existing', async () => {
    await existing.page
      .getByText('Current Store history fixture', { exact: false })
      .waitFor({ timeout: 30_000 });
    await existing.page
      .locator('.session-row')
      .filter({ hasText: 'Current Store history fixture' })
      .click();
    await existing.page
      .getByText('Current Store history remains readable.', { exact: false })
      .waitFor({ timeout: 30_000 });
    assert.equal(model.getRequestCount(), 1, 'history read must not replay the model');
    progress('existing history read without model replay');
  });

  materializeStore11();
  progress('exact Store 11 historical launch');
  const converted = await launchNativeApp();
  await runAndClose(converted, 'converted', async () => {
    await converted.page
      .getByText('Current Store history fixture', { exact: false })
      .waitFor({ timeout: 30_000 });
    await converted.page
      .locator('.session-row')
      .filter({ hasText: 'Current Store history fixture' })
      .click();
    await converted.page
      .getByText('Current Store history remains readable.', { exact: false })
      .waitFor({ timeout: 30_000 });
    assert.equal(model.getRequestCount(), 1, 'opening converted history must not replay the model');
    await converted.page
      .getByRole('textbox', { name: '任务输入' })
      .fill('Follow up after Store conversion');
    await converted.page.getByRole('button', { name: '发送消息', exact: true }).click();
    await converted.page
      .getByText('Converted Store continuation is saved.', { exact: false })
      .waitFor({ timeout: 30_000 });
    await converted.page.getByText('正在回复…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(model.getRequestCount(), 2);
    progress('converted history opened and continued in original Session');
  });
  const convertedStore = new Database(storePath, { readonly: true });
  try {
    assert.equal(
      convertedStore.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      10,
    );
    assert.deepEqual(
      convertedStore
        .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
        .all(),
      [{ session_id: originalSessionId }],
      'conversion must retain the exact original Session ID',
    );
  } finally {
    convertedStore.close();
  }

  progress('converted Store restart');
  const convertedRestart = await launchNativeApp();
  await runAndClose(convertedRestart, 'converted restart', async () => {
    await convertedRestart.page
      .locator('.session-row')
      .filter({ hasText: 'Current Store history fixture' })
      .click();
    await convertedRestart.page
      .getByText('Current Store history remains readable.', { exact: false })
      .waitFor({ timeout: 30_000 });
    await convertedRestart.page
      .getByText('Converted Store continuation is saved.', { exact: false })
      .waitFor({ timeout: 30_000 });
    assert.equal(model.getRequestCount(), 2, 'restart must not replay either model response');
    progress('converted Session and continuation survived restart');
  });

  materializeStore11();
  const interruptedSource = enlargeStore11ForObservablePreparation();
  const sourceBeforeQuit = fileDigest(interruptedSource);
  progress('observable Store 11 preparation and packaged app quit');
  const interrupted = await launchNativeApp({ pauseRenderer: true, quitTimeoutMs: 120_000 });
  await runAndClose(interrupted, 'preparation quit', async () => {
    const visiblePhase = interrupted.page
      .getByRole('status')
      .filter({ hasText: /正在备份、整理并核对会话数据|正在提交并复核会话数据/u });
    const observed = visiblePhase.waitFor({ timeout: 60_000 });
    await interrupted.startRenderer();
    await observed;
    const observedPhase = (await visiblePhase.innerText()).includes('正在备份')
      ? 'preparing'
      : 'publishing';
    progress(`packaged renderer observed ${observedPhase} before quit`);
  });
  assert.ok(interrupted.sawQuitConfirmation(), 'native quit must show the existing confirmation');
  assert.equal(
    existsSync(join(home, '.kite-code/kite-session-publication.json')),
    false,
    'quit must leave no pending publication intent',
  );
  if (existsSync(interruptedSource)) {
    assert.equal(
      fileDigest(interruptedSource),
      sourceBeforeQuit,
      'unpublished source bytes must remain unchanged',
    );
    assert.equal(
      existsSync(storePath),
      false,
      'unpublished source must not create a canonical Store',
    );
    progress('quit settled before publication; original Store 11 bytes remain');
  } else {
    const published = new Database(storePath, { readonly: true });
    try {
      assert.equal(
        published.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
        10,
      );
      assert.deepEqual(
        published
          .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
          .all(),
        [{ session_id: originalSessionId }],
      );
    } finally {
      published.close();
    }
    progress('publication settled before quit; original Session ID remains');
  }

  progress('restart after preparation quit');
  const afterQuit = await launchNativeApp();
  await runAndClose(afterQuit, 'after preparation quit', async () => {
    await afterQuit.page
      .locator('.session-row')
      .filter({ hasText: 'Current Store history fixture' })
      .click();
    await afterQuit.page
      .getByText('Current Store history remains readable.', { exact: false })
      .waitFor({ timeout: 60_000 });
    await afterQuit.page
      .getByText('Converted Store continuation is saved.', { exact: false })
      .waitFor({ timeout: 60_000 });
    assert.equal(model.getRequestCount(), 2, 'reopening after quit must not replay the model');
  });
  const afterQuitStore = new Database(storePath, { readonly: true });
  try {
    assert.equal(
      afterQuitStore.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      10,
    );
    assert.deepEqual(
      afterQuitStore
        .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions')
        .all(),
      [{ session_id: originalSessionId }],
    );
  } finally {
    afterQuitStore.close();
  }

  const incompatible = new Database(storePath);
  try {
    incompatible.run("UPDATE kite_meta SET value = '11' WHERE key = 'schema_version'");
    incompatible.run('PRAGMA user_version = 11');
    incompatible.run('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    incompatible.close();
  }
  const before = createHash('sha256').update(readFileSync(storePath)).digest('hex');
  progress('incompatible Store launch');
  const rejected = await launchNativeApp();
  await runAndClose(rejected, 'incompatible', async () => {
    const error = rejected.page.getByText(/STORE_INCOMPATIBLE/u).first();
    await error.waitFor({ timeout: 30_000 });
    const visible = await rejected.page.locator('body').innerText();
    assert.match(visible, /STORE_INCOMPATIBLE/u);
    assert.match(visible, /11/u);
    assert.match(visible, /10/u);
    assert.doesNotMatch(visible, /Runtime connection closed/iu);
    await rejected.page
      .getByRole('button', { name: '保存诊断', exact: true })
      .waitFor({ timeout: 10_000 });
    progress('incompatible error and diagnostic export visible with schema 11 and expected 10');
  });
  assert.equal(
    createHash('sha256').update(readFileSync(storePath)).digest('hex'),
    before,
    'incompatible Store must remain byte-for-byte unchanged',
  );
  console.log(
    'Packaged Desktop Store startup: fresh, current-history restart, exact Store 11 conversion and continuation, preparation quit and restart with original history, and incompatible read-only rejection passed.',
  );
} finally {
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
