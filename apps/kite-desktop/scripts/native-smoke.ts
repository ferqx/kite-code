import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium } from 'playwright';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';

if (process.platform !== 'darwin')
  throw new Error('This native window smoke currently targets macOS.');
const root = resolve(import.meta.dir, '..');
const packagedExecutable = resolve(
  process.argv[2] ?? join(root, `out/kite-darwin-${process.arch}/kite.app/Contents/MacOS/kite`),
);
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-electron-window-')));
const appData = join(home, 'app-data');
const application = join(home, 'kite.app');
cpSync(resolve(dirname(packagedExecutable), '../..'), application, {
  recursive: true,
  verbatimSymlinks: true,
});
const executable = join(application, 'Contents/MacOS/kite');
const workspace = join(home, 'workspace');
for (const directory of [appData, workspace, join(home, '.kite-code')])
  mkdirSync(directory, { mode: 0o700 });
const model = createMockModelServer();
model.setResponses([
  {
    message: { content_chunks: ['Electron streaming', ' survives reload', ' complete.'] },
    chunk_delay: 800,
  },
  { message: { content: 'Second Electron session complete.' } },
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
// Pause the packaged entry before it can read user paths. This isolation lives only in
// the test debugger; the shipped application has no test flags or environment overrides.
const child = spawn(executable, ['--inspect-brk=0', '--remote-debugging-port=0'], {
  cwd: home,
  stdio: ['ignore', 'ignore', 'pipe'],
});
const exited = new Promise<number | null>((done) => child.once('exit', done));
let logs = '';
child.stderr.on('data', (chunk: Buffer) => {
  logs = (logs + chunk.toString()).slice(-65_536);
});
const endpoint = async (expression: RegExp): Promise<string> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = logs.match(expression);
    if (match?.[1]) return match[1];
    if (child.exitCode !== null)
      throw new Error(`Electron exited before debugger connection: ${logs}`);
    await Bun.sleep(25);
  }
  throw new Error(`Electron debugger did not start: ${logs}`);
};
let browser: Browser | undefined;
let inspector: WebSocket | undefined;
let main: ((expression: string) => Promise<unknown>) | undefined;
try {
  inspector = new WebSocket(await endpoint(/Debugger listening on (ws:\/\/[^\s]+)/u));
  await new Promise<void>((done, fail) => {
    inspector!.addEventListener('open', () => done(), { once: true });
    inspector!.addEventListener(
      'error',
      () => fail(new Error('Cannot connect to Electron inspector.')),
      { once: true },
    );
  });
  let nextId = 0;
  type InspectorResult = { result?: { value?: unknown }; exceptionDetails?: unknown };
  const pending = new Map<
    number,
    { done: (value: InspectorResult) => void; fail: (error: Error) => void }
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
        fail(new Error(`Electron inspector timed out: ${method}`));
      }, 30_000);
      pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
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
    expression: `globalThis.__kiteNativeSmoke = require('electron');
const register = __kiteNativeSmoke.ipcMain.handle.bind(__kiteNativeSmoke.ipcMain);
__kiteNativeSmoke.ipcMain.handle = (channel, listener) => register(channel, async (...args) => {
  if (channel === 'kite:desktop:runtime-send' && globalThis.__kiteDelayFirstSend) {
    globalThis.__kiteDelayFirstSend = false;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const result = await listener(...args);
  if (channel === 'kite:desktop:runtime-receive' && globalThis.__kiteDelayHistory &&
      result.ok && typeof result.value === 'string' && JSON.parse(result.value).result?.type === 'history_session_page') {
    globalThis.__kiteDelayHistory = false;
    globalThis.__kiteHistoryHeld = true;
    await new Promise(resolve => setTimeout(resolve, 2000));
    globalThis.__kiteHistoryHeld = false;
  }
  return result;
});
__kiteNativeSmoke.app.setPath('home', ${JSON.stringify(home)});
__kiteNativeSmoke.app.setPath('appData', ${JSON.stringify(appData)});
__kiteNativeSmoke.app.setPath('userData', ${JSON.stringify(join(appData, 'dev.kite-code.desktop'))});
__kiteNativeSmoke.app.getPath('home')`,
    returnByValue: true,
  });
  assert.equal(isolated.result?.value, home, 'isolate paths before resuming the real entry');
  main = async (expression: string) => {
    const result = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await command('Debugger.resume');
  browser = await chromium.connectOverCDP(await endpoint(/DevTools listening on (ws:\/\/[^\s]+)/u));
  assert.deepEqual(
    await main(
      `({home: __kiteNativeSmoke.app.getPath('home'), appData: __kiteNativeSmoke.app.getPath('appData'), packaged: __kiteNativeSmoke.app.isPackaged})`,
    ),
    { home, appData, packaged: true },
  );
  await main(`__kiteNativeSmoke.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(workspace)}] });
__kiteNativeSmoke.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });`);
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Renderer:', message.text());
  });
  await page.getByRole('button', { name: '新对话', exact: true }).waitFor({ timeout: 30_000 });
  const security = await page.evaluate(() => ({
    bridge: !!window.kiteDesktop,
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
  }));
  assert.deepEqual(security, { bridge: true, require: 'undefined', process: 'undefined' });
  assert.deepEqual(
    await main(
      `(() => { const p = __kiteNativeSmoke.BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return {sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration}; })()`,
    ),
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  const primaryNewConversation = page.getByRole('button', { name: '新对话', exact: true });
  const newConversationOpacity = await primaryNewConversation.evaluate(
    (button: HTMLButtonElement) => {
      const enabled = getComputedStyle(button).opacity;
      button.disabled = true;
      const disabled = getComputedStyle(button).opacity;
      button.disabled = false;
      return { enabled, disabled };
    },
  );
  assert.deepEqual(
    newConversationOpacity,
    { enabled: '1', disabled: '1' },
    'temporary project activation must not flash the primary new-conversation action',
  );
  await primaryNewConversation.click();
  // Exercise the real UI/preload/IPC flow, stubbing only the native picker response.
  await page.getByRole('button', { name: '项目空间', exact: true }).click();
  await page.getByRole('menuitem', { name: '添加项目…', exact: true }).click();
  await page
    .getByRole('textbox', { name: '任务输入' })
    .fill('Verify the Electron packaged client.');
  const composerBeforeFirstSend = await page.locator('.composer').boundingBox();
  await main('globalThis.__kiteDelayFirstSend = true');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('正在发送…', { exact: true }).waitFor();
  const pendingGeometry = await page.evaluate(() => {
    const bubble = document.querySelector('.message.user')!.getBoundingClientRect();
    const status = document.querySelector('.delivery-status')!.getBoundingClientRect();
    return {
      bubbleBottom: bubble.bottom,
      statusTop: status.top,
      statusBottom: status.bottom,
    };
  });
  assert.ok(
    pendingGeometry.statusTop >= pendingGeometry.bubbleBottom,
    'delivery status must render below the user bubble',
  );
  assert.ok(
    pendingGeometry.statusBottom > pendingGeometry.bubbleBottom,
    'delivery status must render outside the user bubble box',
  );
  assert.equal(await page.getByRole('textbox', { name: '任务输入' }).inputValue(), '');
  assert.deepEqual(
    await page.locator('.composer').boundingBox(),
    composerBeforeFirstSend,
    'optimistic first send must not move or resize the composer',
  );
  mkdirSync(join(root, 'out'), { recursive: true });
  await page.screenshot({ path: join(root, 'out/electron-first-send-pending.png') });
  await page.getByText('Electron streaming', { exact: false }).waitFor({ timeout: 30_000 });
  await page.getByText('正在回复…', { exact: true }).waitFor();
  const respondingGeometry = await page.evaluate(() => {
    const message = document
      .querySelector('.message.assistant.responding')!
      .getBoundingClientRect();
    const status = document.querySelector('.response-status')!.getBoundingClientRect();
    return {
      messageBottom: message.bottom,
      statusTop: status.top,
      statusBottom: status.bottom,
    };
  });
  assert.ok(
    respondingGeometry.statusTop >= respondingGeometry.messageBottom,
    'reply status must render below the assistant message',
  );
  assert.ok(
    respondingGeometry.statusBottom > respondingGeometry.messageBottom,
    'reply status must render outside the assistant message box',
  );
  await page.screenshot({ path: join(root, 'out/electron-agent-responding.png') });
  const beforeReload = await page.evaluate(() => window.kiteDesktop!.runtimeStatus());
  await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].close()');
  assert.equal(await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].isVisible()'), false);
  await main("__kiteNativeSmoke.app.emit('activate')");
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  assert.equal(await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].isVisible()'), true);
  assert.deepEqual(await page.evaluate(() => window.kiteDesktop!.runtimeStatus()), beforeReload);
  await page.reload();
  await page
    .getByText('Electron streaming survives reload complete.', { exact: false })
    .waitFor({ timeout: 30_000 });
  assert.equal(await page.getByText('正在回复…', { exact: true }).count(), 0);
  assert.equal(await page.locator('.message-copy').count(), 2);
  assert.deepEqual(
    await page.locator('.message-copy').evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          paddingBlock: `${style.paddingTop} ${style.paddingBottom}`,
          paddingInline: `${style.paddingLeft} ${style.paddingRight}`,
          borderRadius: style.borderRadius,
        };
      }),
    ),
    [
      {
        width: 24,
        height: 24,
        paddingBlock: '0px 0px',
        paddingInline: '0px 0px',
        borderRadius: '6px',
      },
      {
        width: 24,
        height: 24,
        paddingBlock: '0px 0px',
        paddingInline: '0px 0px',
        borderRadius: '6px',
      },
    ],
  );
  assert.deepEqual(
    await page
      .locator('.message-copy')
      .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).opacity)),
    ['0', '0'],
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          const state = globalThis as typeof globalThis & { __kiteCopiedTexts?: string[] };
          state.__kiteCopiedTexts ??= [];
          state.__kiteCopiedTexts.push(text);
        },
      },
    });
  });
  for (const selector of ['.message.assistant', '.message.user']) {
    const messageBox = await page.locator(selector).boundingBox();
    const copyBox = await page.locator(`${selector} .message-copy`).boundingBox();
    assert.ok(messageBox && copyBox);
    await page.mouse.move(
      messageBox.x + messageBox.width / 2,
      messageBox.y + messageBox.height / 2,
    );
    await page.mouse.move(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2, {
      steps: 12,
    });
    await page.waitForTimeout(150);
    assert.equal(
      await page
        .locator(`${selector} .message-copy`)
        .evaluate((element) => getComputedStyle(element).opacity),
      '1',
      `${selector} copy action must remain visible along a real pointer path`,
    );
    await page.mouse.down();
    await page.mouse.up();
  }
  assert.deepEqual(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __kiteCopiedTexts?: string[] }).__kiteCopiedTexts,
    ),
    ['Electron streaming survives reload complete.', 'Verify the Electron packaged client.'],
  );
  assert.equal(await page.getByRole('button', { name: '已复制消息', exact: true }).count(), 2);
  const copyGeometry = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.message.user, .message.assistant')].map(
      (message) => {
        const copy = message.querySelector<HTMLElement>('.message-copy')!;
        const messageBox = message.getBoundingClientRect();
        const copyBox = copy.getBoundingClientRect();
        return { messageBottom: messageBox.bottom, copyTop: copyBox.top };
      },
    ),
  );
  assert.ok(
    copyGeometry.every(({ messageBottom, copyTop }) => copyTop >= messageBottom),
    'copy actions must render below their completed message boxes',
  );
  await page.screenshot({ path: join(root, 'out/electron-message-copy-actions.png') });
  const afterReload = await page.evaluate(() => window.kiteDesktop!.runtimeStatus());
  assert.equal(afterReload.workspace, beforeReload.workspace);
  assert.ok(afterReload.connectionId! > beforeReload.connectionId!);
  // Keep the real packaged renderer, preload and Service; delay one history response only.
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('Cached draft stays editable.');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await input.fill('Create a second Electron session.');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('Second Electron session complete.', { exact: false }).waitFor();
  await main('globalThis.__kiteDelayHistory = true');
  const cached = await page.evaluate(async () => {
    const row = [...document.querySelectorAll<HTMLButtonElement>('.session-row')].find((element) =>
      element.textContent?.includes('Verify the Electron packaged client.'),
    );
    if (!row) throw new Error('First session row is missing');
    const started = performance.now();
    row.click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return {
      elapsed: performance.now() - started,
      text: document.querySelector('.conversation')?.textContent,
    };
  });
  assert.ok(cached.text?.includes('Electron streaming survives reload complete.'));
  assert.ok(!cached.text?.includes('正在加载会话历史'));
  assert.ok(cached.elapsed < 2000, 'cached text must precede the delayed history response');
  const historyDeadline = Date.now() + 5000;
  while (!(await main('globalThis.__kiteHistoryHeld')) && Date.now() < historyDeadline)
    await Bun.sleep(10);
  assert.equal(await main('globalThis.__kiteHistoryHeld'), true);
  assert.equal(await input.inputValue(), 'Cached draft stays editable.');
  assert.deepEqual(
    await page.locator('.composer-action').evaluate((element: HTMLButtonElement) => ({
      disabled: element.disabled,
      label: element.getAttribute('aria-label'),
    })),
    { disabled: true, label: '发送消息：正在校准会话，暂时无法发送' },
  );
  await input.fill('Still editable during calibration.');
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.disabled,
  );
  assert.equal(await input.inputValue(), 'Still editable during calibration.');
  assert.ok(
    (await page.locator('.conversation').innerText()).includes(
      'Electron streaming survives reload complete.',
    ),
  );
  console.log(
    'Electron cached switch with 2s history delay:',
    JSON.stringify({ firstFrameMs: cached.elapsed, messages: 2 }),
  );
  const conversationGeometry = await page.evaluate(() => {
    const reading = document.querySelector('.reading-column')!.getBoundingClientRect();
    const composer = document.querySelector('.composer')!.getBoundingClientRect();
    return {
      reading: { x: reading.x, width: reading.width },
      composer: { x: composer.x, width: composer.width },
    };
  });
  await page.getByRole('button', { name: '文件变更', exact: true }).click();
  await page.getByRole('complementary', { name: '文件变更' }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => {
      const reading = document.querySelector('.reading-column')!.getBoundingClientRect();
      const composer = document.querySelector('.composer')!.getBoundingClientRect();
      return {
        reading: { x: reading.x, width: reading.width },
        composer: { x: composer.x, width: composer.width },
      };
    }),
    conversationGeometry,
    'opening file changes must not move or resize the reading column or composer',
  );
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const header = await page.locator('.app-header').boundingBox();
  const brand = await page.locator('.sidebar-header .brand').boundingBox();
  assert.equal(header?.height, 52);
  assert.ok(brand && brand.x >= 80, 'brand must clear native traffic lights');
  assert.deepEqual(
    await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].getWindowButtonPosition()'),
    { x: 13, y: 19 },
  );
  await page.evaluate(() => window.kiteDesktop!.toggleWindowMaximize());
  assert.equal(
    await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].isMaximized()'),
    true,
  );
  await page.evaluate(() => window.kiteDesktop!.toggleWindowMaximize());
  assert.equal(
    await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].isMaximized()'),
    false,
  );
  await page.screenshot({ path: join(root, 'out/electron-native-smoke.png') });
  const windowId = String(
    await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].getMediaSourceId()'),
  ).split(':')[1]!;
  const capture = spawnSync(
    '/usr/sbin/screencapture',
    ['-x', '-l', windowId, join(root, 'out/electron-native-window.png')],
    { encoding: 'utf8' },
  );
  console.log('Native window capture:', capture.status === 0 ? 'saved' : capture.stderr.trim());
  assert.deepEqual(errors, []);
  await main(
    `__kiteNativeSmoke.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); __kiteNativeSmoke.app.quit();`,
  );
  assert.equal(
    await main('__kiteNativeSmoke.BrowserWindow.getAllWindows()[0].isDestroyed()'),
    false,
  );
  assert.deepEqual(await page.evaluate(() => window.kiteDesktop!.runtimeStatus()), afterReload);
  await main(
    `__kiteNativeSmoke.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });`,
  );
  model.assertComplete();
  await main('__kiteNativeSmoke.app.quit()');
  inspector.close();
  await browser.close();
  browser = undefined;
  assert.equal(await exited, 0);
  console.log(
    'Packaged Electron: isolated paths, sandboxed preload, real IPC/service execution, streaming reload, cached switching with delayed calibration, hide/reopen and confirmed exit passed. Native dialog responses were stubbed; no external Provider was used.',
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error(
      'Native window failure:',
      await page
        .locator('body')
        .innerText()
        .catch(() => 'unavailable'),
    );
    mkdirSync(join(root, 'out'), { recursive: true });
    await page
      .screenshot({ path: join(root, 'out/electron-native-failure.png') })
      .catch(() => undefined);
  }
  console.error(logs);
  throw error;
} finally {
  if (child.exitCode === null) {
    await main?.(
      `__kiteNativeSmoke.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); __kiteNativeSmoke.app.quit();`,
    ).catch(() => undefined);
    inspector?.close();
    await browser?.close().catch(() => undefined);
    await Promise.race([
      exited,
      Bun.sleep(20_000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }),
    ]);
  }
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
