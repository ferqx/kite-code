import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
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
  close(): Promise<void>;
};

function progress(message: string): void {
  console.log(`[store-startup] ${message}`);
}

/** Isolate Electron's paths at its first debugger pause, before the packaged entry runs. */
async function launchNativeApp(): Promise<NativeApp> {
  const child = spawn(
    join(application, 'Contents/MacOS/kite'),
    ['--inspect-brk=0', '--remote-debugging-port=0'],
    { cwd: home, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  let logs = '';
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
      close: async () => {
        progress('requesting packaged app quit');
        await evaluateMain('__kiteStartupSmoke.app.quit()').catch(() => undefined);
        inspector?.close();
        await browser?.close();
        const code = await Promise.race([exited, Bun.sleep(20_000).then(() => null)]);
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

const model = createMockModelServer();
model.setResponses([{ message: { content: 'Current Store history remains readable.' } }]);
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

  const current = new Database(storePath, { readonly: true });
  try {
    assert.equal(
      current.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
      10,
    );
    assert.ok(
      current
        .query<{ session_id: string }, []>('SELECT session_id FROM runtime_sessions LIMIT 1')
        .get(),
    );
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
    progress('incompatible error visible with schema 11 and expected 10');
  });
  assert.equal(
    createHash('sha256').update(readFileSync(storePath)).digest('hex'),
    before,
    'incompatible Store must remain byte-for-byte unchanged',
  );
  console.log(
    'Packaged Desktop Store startup: fresh, current-history restart, and schema 11 incompatible read-only rejection passed.',
  );
} finally {
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
