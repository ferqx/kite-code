import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeState } from '../../../apps/desktop/src/native-bridge';
import { selectNativeFixtureModel } from '../../../apps/desktop/test/native-model-selection.fixture';

type Page = Parameters<typeof selectNativeFixtureModel>[0];
interface ElectronApplication {
  close(): Promise<void>;
  process(): ChildProcess;
  windows(): Page[];
  evaluate<T>(
    callback: (
      electron: {
        app: { commandLine: { hasSwitch(name: string): boolean } };
        BaseWindow: { getAllWindows(): { isVisible(): boolean }[] };
        webContents: {
          getAllWebContents(): {
            getURL(): string;
            getLastWebPreferences(): {
              sandbox?: boolean;
              contextIsolation?: boolean;
              nodeIntegration?: boolean;
            };
          }[];
        };
      },
      rendererUrl: string,
    ) => T,
    rendererUrl: string,
  ): Promise<T>;
}

const [configuration] = process.argv.slice(2);
assert(configuration);
const input: {
  desktopPackage: string;
  phase: 'previous' | 'current' | 'fresh';
  executable: string;
  mainExecutable: string;
  runtime: string;
  rendererUrl: string;
  home: string;
  storeId: string;
  sessionId: string;
  sessionTitle: string;
  modelId: string;
  message: string;
  answer: string;
  screenshot: string;
} = JSON.parse(configuration);
const { _electron } = createRequire(input.desktopPackage)('playwright') as {
  _electron: {
    launch(input: {
      executablePath: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      chromiumSandbox: boolean;
      timeout: number;
    }): Promise<ElectronApplication>;
  };
};

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const application = await _electron.launch({
  executablePath: input.executable,
  args: [`--user-data-dir=${join(input.home, 'electron-data')}`],
  cwd: input.home,
  env: { HOME: input.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  chromiumSandbox: true,
  timeout: 15000,
});
const main = application.process();
const exited = new Promise((resolve) =>
  main.once('exit', (code, signal) => resolve({ code, signal })),
);
let service: number | undefined;
try {
  // Native's hidden dialog is a distinct renderer and can be the first Playwright page.
  const page = await waitFor(
    () => application.windows().find((candidate) => candidate.url() === input.rendererUrl),
    'macos_dmg_primary_renderer_missing',
  );
  page.setDefaultTimeout(10000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.getByRole('navigation', { name: '主要导航', exact: true }).waitFor();
  const security = await application.evaluate(({ app, BaseWindow, webContents }, rendererUrl) => {
    const renderer = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === rendererUrl);
    const preferences = renderer?.getLastWebPreferences();
    return {
      pid: process.pid,
      visibleWindows: BaseWindow.getAllWindows().filter((window) => window.isVisible()).length,
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      sandbox: preferences?.sandbox,
      contextIsolation: preferences?.contextIsolation,
      nodeIntegration: preferences?.nodeIntegration,
    };
  }, input.rendererUrl);
  assert.deepEqual(security, {
    pid: main.pid,
    visibleWindows: 1,
    noSandbox: false,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/));
  const mainRow = processes.find((row) => Number(row[0]) === security.pid);
  assert.equal(mainRow?.slice(2).join(' '), input.mainExecutable);
  const children = processes.filter(
    (row) => Number(row[1]) === security.pid && row.slice(2).join(' ') === input.runtime,
  );
  assert.equal(children.length, 1);
  service = Number(children[0]![0]);
  console.log(
    JSON.stringify({ phase: input.phase, step: 'main_and_service_ready', ...security, service }),
  );

  await page
    .getByRole('navigation', { name: '当前项目会话', exact: true })
    .getByRole('button', { name: input.sessionTitle, exact: true })
    .click();
  const selection = async () => {
    const state = (await page.evaluate(() =>
      window.kiteNative!.request({ method: 'state', generation: 1 }),
    )) as NativeState;
    const selected = state.selection;
    return selected &&
      selected.storeId === input.storeId &&
      selected.session.id === input.sessionId &&
      !selected.viewLoading
      ? selected
      : undefined;
  };
  await waitFor(selection, 'macos_dmg_original_session_missing');
  const composer = page.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
  const userArticle = page.getByRole('article', { name: '用户消息', exact: true });
  const assistantArticle = page.getByRole('article', { name: '助手消息', exact: true });
  const userMessage = userArticle.getByText(input.message, { exact: true });
  const assistantMessage = assistantArticle.getByText(input.answer, { exact: true });
  if (input.phase === 'previous') {
    await selectNativeFixtureModel(page, input.modelId);
    await composer.fill(input.message);
    await page.getByRole('button', { name: '发送明确的新轮次' }).click();
    console.log(JSON.stringify({ phase: input.phase, step: 'sent_through_composer' }));
    await userMessage.waitFor();
    console.log(JSON.stringify({ phase: input.phase, step: 'user_message_visible_after_send' }));
  }
  await assistantMessage.waitFor();
  const run = await waitFor(async () => {
    const current = await selection();
    const completed = current?.runs[0];
    return current?.runs.length === 1 && completed?.status === 'completed' ? completed : undefined;
  }, 'macos_dmg_original_run_not_completed');
  await waitFor(
    async () => (await composer.inputValue()) === '' || undefined,
    'macos_dmg_composer_not_cleared',
  );
  assert.equal(await userArticle.count(), 1);
  assert.equal(await assistantArticle.count(), 1);
  assert.equal(await userMessage.count(), 1);
  assert.equal(await assistantMessage.count(), 1);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: input.screenshot });
  console.log(
    JSON.stringify({
      phase: input.phase,
      step: 'original_turn_visible_once',
      storeId: input.storeId,
      sessionId: input.sessionId,
      runId: run.id,
    }),
  );
} finally {
  await application.close();
  assert.deepEqual(await exited, { code: 0, signal: null });
  if (main.pid !== undefined) assert.throws(() => process.kill(main.pid!, 0), { code: 'ESRCH' });
  if (service !== undefined) assert.throws(() => process.kill(service!, 0), { code: 'ESRCH' });
  console.log(JSON.stringify({ phase: input.phase, step: 'normal_exit', main: main.pid, service }));
}
