import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeState } from '../src/native-bridge';

const [fixturePath, packagePath] = process.argv.slice(2) as [string, string];
const require = createRequire(packagePath),
  { _electron } = require('playwright') as typeof import('playwright');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  directory: string;
  outdir: string;
  storeId: string;
  control: string;
};
const app = await _electron.launch({
  executablePath: require('electron') as string,
  args: [fixture.outdir, `--user-data-dir=${join(fixture.directory, 'electron-data')}`],
  cwd: fixture.outdir,
  env: {
    HOME: join(fixture.directory, 'home'),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
  },
  timeout: 20000,
});
const originalElectronProcess = app.process();
const errors: string[] = [],
  stages: unknown[] = [];
app
  .process()
  .stderr?.on('data', (value) =>
    writeFileSync(join(fixture.directory, 'electron-stderr.log'), String(value), { flag: 'a' }),
  );
let page: import('playwright').Page | undefined;
const status = async () =>
  (await (await fetch(`${fixture.control}/status`)).json()) as {
    calls: number;
    prefixSaved: boolean;
  };
async function capture(name: string) {
  assert(page);
  const dom = await page.evaluate(() => ({
    title: document.querySelector('.session-header')?.textContent,
    panel: document.querySelector('.trajectory-panel')?.textContent,
    cursor: document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value,
    events: [...document.querySelectorAll('[data-trajectory-event]')].map((element) =>
      element.getAttribute('data-trajectory-event'),
    ),
    text: document.body.innerText.slice(-20000),
  }));
  const control = await status();
  assert.equal(new Set(dom.events).size, dom.events.length, 'same event rendered twice');
  stages.push({ name, at: Date.now(), dom, control });
  writeFileSync(join(fixture.directory, `${name}.json`), JSON.stringify({ dom, control }, null, 2));
  await page.screenshot({ path: join(fixture.directory, `${name}.png`) });
  console.log(
    JSON.stringify({
      stage: name,
      calls: control.calls,
      cursor: dom.cursor,
      events: dom.events.length,
    }),
  );
}
async function ready() {
  assert(page);
  await page.waitForFunction(
    () =>
      /\/\s*\d+/.test(document.querySelector('.trajectory-position')?.textContent ?? '') &&
      !document.querySelector('.trajectory-panel')?.textContent?.includes('正在读取已保存轨迹'),
  );
}
async function browserViews() {
  return app.evaluate(({ BaseWindow, WebContentsView }) =>
    BaseWindow.getAllWindows().flatMap((owner) =>
      owner.contentView.children
        .filter(
          (view): view is InstanceType<typeof WebContentsView> => view instanceof WebContentsView,
        )
        .map((view) => ({
          id: view.webContents.id,
          url: view.webContents.getURL(),
          visible: view.getVisible(),
          focused: view.webContents.isFocused(),
          bounds: view.getBounds(),
        })),
    ),
  );
}
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    page = app.windows().find((candidate) => candidate.url().endsWith('/index.html'));
    if (page) break;
    if (Date.now() > deadline) throw Error('native renderer missing');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => {
    const samples: unknown[] = [];
    (window as unknown as { trajectorySamples: unknown[] }).trajectorySamples = samples;
    const sample = () => {
      const panel = document.querySelector<HTMLElement>('.trajectory-panel'),
        bounds = panel?.getBoundingClientRect();
      samples.push({
        at: performance.now(),
        title: document.querySelector('.session-header')?.textContent,
        panel: panel?.textContent?.slice(0, 250),
        cursor: document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')?.value,
        count: document.querySelectorAll('[data-trajectory-event]').length,
        messageIds: [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.dataset.messageId),
        focus:
          document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
        trajectoryScrollTop: document.querySelector('.trajectory-scroll')?.scrollTop,
        bounds: bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          : null,
      });
      if (samples.length < 10000) requestAnimationFrame(sample);
    };
    sample();
  });
  await app.evaluate(() => {
    const target = globalThis as unknown as {
        trajectoryPhysical: unknown[];
        trajectoryHold: { armed: boolean; held: boolean; aborted: boolean };
      },
      original = globalThis.fetch;
    target.trajectoryPhysical = [];
    target.trajectoryHold = { armed: false, held: false, aborted: false };
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const path = new URL(String(args[0])).pathname,
        method = args[1]?.method ?? 'GET';
      const response = await original(...args);
      if (path.includes('/trajectory'))
        target.trajectoryPhysical.push({ at: Date.now(), method, path, status: response.status });
      if (path.endsWith('/trajectory/evidence/read') && target.trajectoryHold.armed) {
        target.trajectoryHold.armed = false;
        target.trajectoryHold.held = true;
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            target.trajectoryHold.aborted = true;
            void response.body?.cancel();
            reject(new DOMException('Isolated held response aborted', 'AbortError'));
          };
          const signal = args[1]?.signal;
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return response;
    }, original);
  });
  await page.getByRole('button', { name: 'Trajectory A', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Trajectory A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Trajectory A', { exact: true }).waitFor();
  await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
  await page.getByRole('region', { name: '执行轨迹', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回最新', exact: true }).waitFor({ state: 'visible' });
  await ready();
  const originalCursor = await page
    .getByRole('textbox', { name: '轨迹位置', exact: true })
    .inputValue();
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await page.getByRole('region', { name: '执行轨迹' }).getByText('重放', { exact: true }).waitFor();
  await capture('01-initial');
  await page.evaluate(async (storeId) => {
    const state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'submit',
      generation: state.generation,
      sessionId: 's',
      intent: {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'stream',
        content: 'Record one harmless local streaming reply',
      },
    });
  }, fixture.storeId);
  const until = Date.now() + 15000;
  while (!(await status()).prefixSaved) {
    if (Date.now() > until) throw Error('original prefix never committed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await page.getByText('有新的执行记录，当前阅读位置保持不变。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '轨迹位置' }).inputValue(), originalCursor);
  await capture('02-prefix-new-record-hint');
  await page.getByRole('button', { name: '返回最新', exact: true }).click();
  await page.getByRole('tab', { name: '全部事件', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-trajectory-event]')].some((element) =>
      element.textContent?.includes('模型'),
    ),
  );
  const models = page.locator('[data-trajectory-event]').filter({ hasText: '模型' });
  await models.last().locator('button.trajectory-event-heading').click();
  await models
    .last()
    .getByRole('button', { name: /模型输出/ })
    .click();
  await page
    .getByRole('region', { name: '轨迹证据', exact: true })
    .getByText('STREAM_PREFIX_ONE', { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: '轨迹证据' })
      .getByText('STREAM_FINAL_TAIL', { exact: false })
      .count(),
    0,
  );
  assert.equal(await page.getByText('NEVER_PUBLIC_CONTINUATION', { exact: false }).count(), 0);
  await capture('03-sealed-prefix-evidence');
  const prefixCursor = await page.getByRole('textbox', { name: '轨迹位置' }).inputValue();
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await page.getByRole('region', { name: '执行轨迹' }).getByText('重放', { exact: true }).waitFor();
  await fetch(`${fixture.control}/release`, { method: 'POST' });
  await page.getByText('有新的执行记录，当前阅读位置保持不变。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '轨迹位置' }).inputValue(), prefixCursor);
  await capture('04-finished-old-prefix-kept');
  await page.getByRole('button', { name: '关闭证据', exact: true }).click();
  await page.getByRole('textbox', { name: '轨迹位置' }).fill(originalCursor);
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await capture('05-seek-original');
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  const address = page.getByRole('textbox', { name: '搜索或输入网址', exact: true });
  await address.fill(`${fixture.control}/browser-page`);
  await address.press('Enter');
  const browserDeadline = Date.now() + 15000;
  let browser = (await browserViews()).find((view) => view.url.endsWith('/browser-page'));
  while (!browser?.visible) {
    if (Date.now() > browserDeadline) throw Error('real Browser WebContentsView not visible');
    await new Promise((resolve) => setTimeout(resolve, 20));
    browser = (await browserViews()).find((view) => view.url.endsWith('/browser-page'));
  }
  const documentDeadline = Date.now() + 10000;
  while (
    !(await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((view) => view.getURL().endsWith('/browser-page'))!
        .executeJavaScript('Boolean(document.querySelector("input"))'),
    ))
  ) {
    if (Date.now() > documentDeadline) throw Error('actual Browser document not ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await app.evaluate(({ BaseWindow, app }) => {
    app.focus({ steal: true });
    for (const window of BaseWindow.getAllWindows()) if (window.isVisible()) window.focus();
  });
  const targetPages = app.context().pages();
  writeFileSync(
    join(fixture.directory, 'browser-targets.json'),
    JSON.stringify(
      targetPages.map((target) => target.url()),
      null,
      2,
    ),
  );
  const browserPage = targetPages.find((target) => target.url().endsWith('/browser-page'));
  if (browserPage) {
    await browserPage.bringToFront();
    await browserPage.getByRole('textbox', { name: 'Owned browser input' }).click();
  }
  await app.evaluate(({ webContents }) => {
    const view = webContents
      .getAllWebContents()
      .find((view) => view.getURL().endsWith('/browser-page'))!;
    view.focus();
    view.sendInputEvent({ type: 'mouseDown', x: 25, y: 155, button: 'left', clickCount: 1 });
    view.sendInputEvent({ type: 'mouseUp', x: 25, y: 155, button: 'left', clickCount: 1 });
    return view.executeJavaScript('document.querySelector("input").focus()');
  });
  const browserImage = await app.evaluate(async ({ webContents }) =>
    (
      await webContents
        .getAllWebContents()
        .find((view) => view.getURL().endsWith('/browser-page'))!
        .capturePage()
    )
      .toPNG()
      .toString('base64'),
  );
  writeFileSync(
    join(fixture.directory, '06a-browser-page.png'),
    Buffer.from(browserImage, 'base64'),
  );
  const focusDeadline = Date.now() + 3000;
  while (!(await browserViews()).find((view) => view.id === browser!.id)!.focused) {
    if (Date.now() > focusDeadline)
      throw Error('visible Browser did not take native focus after actual target input');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await capture('06a-real-browser-view');
  writeFileSync(
    join(fixture.directory, 'browser-visible.json'),
    JSON.stringify(await browserViews(), null, 2),
  );
  await page.getByRole('tab', { name: '执行轨迹', exact: true }).click();
  await ready();
  const hiddenBrowser = (await browserViews()).find((view) => view.id === browser!.id)!;
  assert.equal(hiddenBrowser.visible, false);
  assert.equal(hiddenBrowser.focused, false);
  writeFileSync(
    join(fixture.directory, 'browser-hidden.json'),
    JSON.stringify(await browserViews(), null, 2),
  );
  assert.equal(await page.getByRole('textbox', { name: '轨迹位置' }).inputValue(), originalCursor);
  await capture('06-tab-return');
  await page.getByRole('button', { name: '返回最新', exact: true }).click();
  await ready();
  await page.getByRole('tab', { name: '全部事件', exact: true }).click();
  const finishedModels = page.locator('[data-trajectory-event]').filter({ hasText: '模型' });
  await finishedModels.last().locator('button.trajectory-event-heading').click();
  await app.evaluate(() => {
    (globalThis as unknown as { trajectoryHold: { armed: boolean } }).trajectoryHold.armed = true;
  });
  await finishedModels
    .last()
    .getByRole('button', { name: /模型输出/ })
    .click();
  const closeCount = await app.evaluate(
    () =>
      (
        globalThis as unknown as { trajectoryPhysical: { path: string }[] }
      ).trajectoryPhysical.filter((value) => value.path.endsWith('/trajectory/evidence/close'))
        .length,
  );
  const heldDeadline = Date.now() + 10000;
  while (
    !(await app.evaluate(
      () => (globalThis as unknown as { trajectoryHold: { held: boolean } }).trajectoryHold.held,
    ))
  ) {
    if (Date.now() > heldDeadline) throw Error('actual Evidence chunk not held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await capture('06b-evidence-in-flight');
  await page.getByRole('button', { name: '关闭标签页：执行轨迹', exact: true }).click();
  const cancelledDeadline = Date.now() + 10000;
  while (
    !(await app.evaluate(
      () =>
        (globalThis as unknown as { trajectoryHold: { aborted: boolean } }).trajectoryHold.aborted,
    ))
  ) {
    if (Date.now() > cancelledDeadline)
      throw Error('closing tab failed to abort original Main Evidence read');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await page.getByRole('region', { name: '轨迹证据' }).count(), 0);
  const closeDeadline = Date.now() + 10000;
  while (
    (await app.evaluate(
      () =>
        (
          globalThis as unknown as { trajectoryPhysical: { path: string }[] }
        ).trajectoryPhysical.filter((value) => value.path.endsWith('/trajectory/evidence/close'))
          .length,
    )) <= closeCount
  ) {
    if (Date.now() > closeDeadline)
      throw Error('original Evidence lease close not confirmed over HTTP');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(
    join(fixture.directory, 'evidence-cancelled.json'),
    JSON.stringify(
      await app.evaluate(
        () => (globalThis as unknown as { trajectoryHold: unknown }).trajectoryHold,
      ),
      null,
      2,
    ),
  );
  await capture('06c-tab-closed-read-cancelled');
  await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: 'Trajectory B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Trajectory B', { exact: true }).waitFor();
  await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
  await page.getByRole('region', { name: '执行轨迹', exact: true }).waitFor();
  await ready();
  assert.equal(await page.getByText('STREAM_PREFIX_ONE', { exact: false }).count(), 0);
  await capture('07-other-session');
  assert.equal((await status()).calls, 1);
  assert.deepEqual(errors, []);
} catch (error) {
  writeFileSync(
    join(fixture.directory, 'failure-error.json'),
    JSON.stringify(
      {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        views: await browserViews().catch(() => []),
      },
      null,
      2,
    ),
  );
  if (page) await capture('failure').catch(() => {});
  throw error;
} finally {
  if (page) {
    const samples = await page
      .evaluate(
        () => (window as unknown as { trajectorySamples?: unknown[] }).trajectorySamples ?? [],
      )
      .catch(() => []);
    writeFileSync(join(fixture.directory, 'frame-samples.json'), JSON.stringify(samples));
  }
  const physical = await app
    .evaluate(
      () => (globalThis as unknown as { trajectoryPhysical?: unknown[] }).trajectoryPhysical ?? [],
    )
    .catch(() => []);
  writeFileSync(
    join(fixture.directory, 'physical-trajectory-http.json'),
    JSON.stringify(physical, null, 2),
  );
  writeFileSync(
    join(fixture.directory, 'stages.json'),
    JSON.stringify({ errors, stages }, null, 2),
  );
  await app.close();
  writeFileSync(
    join(fixture.directory, 'cleanup.json'),
    JSON.stringify(
      {
        originalElectronPid: originalElectronProcess.pid,
        exitCode: originalElectronProcess.exitCode,
        signalCode: originalElectronProcess.signalCode,
        closed: true,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    result: 'online_native_trajectory_verified',
    directory: fixture.directory,
    stages: stages.length,
  }),
);
