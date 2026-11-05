import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import type { ElectronApplication } from 'playwright';

const require = createRequire(process.argv[2]!);
const { _electron } = require('playwright') as typeof import('playwright');
const directory = process.argv[3]!;
const executable = process.argv[4];
assert.ok(executable && isAbsolute(executable), 'browser_fixture_exact_executable_required');
const runtime = process.argv[5];
assert.ok(runtime === 'macos-resize' || runtime === 'stock', 'browser_fixture_runtime_required');
let electron: ElectronApplication | undefined;
const timeout = setTimeout(() => {
  console.error('browser_fixture_timeout');
  process.exit(1);
}, 60000);
try {
  electron = await _electron.launch({
    executablePath: executable,
    args: [join(directory, 'main.cjs'), directory],
    timeout: 20000,
  });
  assert.equal(
    realpathSync(await electron.evaluate(() => process.execPath)),
    realpathSync(executable),
    'browser_fixture_executable_changed',
  );
  if (runtime === 'macos-resize')
    assert.equal(
      await electron.evaluate(({ app }) =>
        app.commandLine.getSwitchValue('enable-features').split(',').includes('CATransactionV2'),
      ),
      true,
      'browser_fixture_resize_policy_missing',
    );
  electron.process().stderr?.on('data', (chunk) => console.error(String(chunk)));
  const page = await electron.firstWindow();
  page.setDefaultTimeout(6000);
  page.on('pageerror', (error) => console.error('renderer_error', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Loading the font'))
      console.error('console', message.text().slice(0, 400));
  });
  page.on('requestfailed', (request) =>
    console.error('request_failed', request.url(), request.failure()),
  );
  await page.waitForLoadState('load');
  assert.equal(
    await electron.evaluate(() => {
      const window = globalThis.browserTabsHostFixture.window;
      window.show();
      // Windows can consume the first show according to the launcher's hidden
      // STARTUPINFO. Admit the actual visible test window before checking pixels.
      if (process.platform === 'win32' && !window.isVisible()) window.show();
      return window.isVisible() && !window.isMinimized();
    }),
    true,
  );
  await page.reload();
  await page
    .getByRole('button', { name: '标签页', exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error(await page.content());
      console.error(await electron!.evaluate(() => globalThis.browserTabsHostFixture.hits));
      throw error;
    });
  const rendererUrl = page.url();
  await page.getByRole('link', { name: 'Excalidraw', exact: true }).click();
  await page.getByRole('link', { name: 'Stirling-PDF', exact: true }).focus();
  await page.keyboard.press('Enter');
  const externalDeadline = Date.now() + 6000;
  let externalUrls = await electron.evaluate(() => globalThis.browserTabsHostFixture.externalUrls);
  while (externalUrls.length < 2 && Date.now() < externalDeadline) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    externalUrls = await electron.evaluate(() => globalThis.browserTabsHostFixture.externalUrls);
  }
  assert.deepEqual(externalUrls, [
    'https://github.com/excalidraw/excalidraw',
    'https://github.com/Stirling-Tools/Stirling-PDF',
  ]);
  await page.getByRole('link', { name: '跳转', exact: true }).click();
  assert.equal(
    await page
      .getByRole('heading', { name: '目标', exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(page.url(), rendererUrl);
  assert.equal(electron.windows().length, 1);
  assert.equal(await page.getByText('链接后保留的回复。', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  const rail = page.getByRole('complementary', { name: '标签页', exact: true });
  await rail.getByRole('tab').waitFor();
  await rail.locator('.session-browser-tool:visible').waitFor();
  assert.equal(await page.getByRole('button', { name: '文件变更', exact: true }).count(), 0);
  assert.equal(await rail.getByRole('tab').count(), 1);
  assert.equal(await rail.locator('.session-browser-tool:visible').count(), 1);
  // The ordinary rail opens at its 300px minimum, where history buttons are
  // intentionally hidden. After opening, widen it using its keyboard handle.
  await page.waitForFunction(
    () => document.getElementById('content-layout')?.dataset.animateWidth !== 'true',
  );
  let railWidth = await rail.evaluate((node) => node.getBoundingClientRect().width);
  for (let presses = 0; railWidth < 380 && presses < 4; presses++) {
    await page.locator('#details-resize').press('ArrowLeft');
    await page.waitForFunction(
      (previous) => document.getElementById('details')!.getBoundingClientRect().width > previous,
      railWidth,
    );
    railWidth = await rail.evaluate((node) => node.getBoundingClientRect().width);
  }
  assert.ok(
    railWidth >= 380 && railWidth <= 640,
    `browser_fixture_history_rail_width:${railWidth}`,
  );
  await rail.getByRole('button', { name: '后退', exact: true }).waitFor();
  const origin = await electron.evaluate(() => globalThis.browserTabsHostFixture.origin);
  const address = () => rail.getByRole('textbox', { name: '搜索或输入网址' });
  await address().fill(`${origin}/one`);
  await address().press('Enter');
  await rail.getByRole('tab', { name: 'Page One', exact: true }).waitFor();
  const firstTabId = await rail
    .getByRole('tab', { name: 'Page One', exact: true })
    .getAttribute('id');
  assert.ok(firstTabId, 'original_browser_tab_identity_missing');
  const firstTab = rail.locator(`[id=${JSON.stringify(firstTabId)}]`);
  const inspect = () =>
    electron!.evaluate(({ WebContentsView }) => {
      const { window: owner, rootView } = globalThis.browserTabsHostFixture;
      if (rootView.webContents !== owner.webContents) throw Error('fixture_root_owner_changed');
      return owner.contentView.children
        .filter(
          (view): view is InstanceType<typeof WebContentsView> =>
            view instanceof WebContentsView && view !== rootView,
        )
        .map((view) => ({
          id: view.webContents.id,
          url: view.webContents.getURL(),
          bounds: view.getBounds(),
          visible: view.getVisible(),
        }));
    });
  const geometryDeadline = Date.now() + 6000;
  let first = (await inspect())[0]!;
  while (
    (!first ||
      first.url !== `${origin}/one` ||
      !first.visible ||
      first.bounds.width <= 100 ||
      first.bounds.height <= 100) &&
    Date.now() < geometryDeadline
  ) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    first = (await inspect())[0]!;
  }
  assert.equal(first.visible, true);
  assert.equal(first.url, `${origin}/one`);
  assert.equal((await inspect()).length, 1);
  assert.ok(first.bounds.width > 100 && first.bounds.height > 100);
  if (process.platform === 'win32') {
    await page.locator('.native-browser-viewport[data-native-browser-frame="true"]').waitFor();
    const decorations = await electron.evaluate(() =>
      globalThis.browserTabsHostFixture.window.contentView.children
        .filter((view) => !('webContents' in view))
        .map((view) => ({ visible: view.getVisible(), bounds: view.getBounds() })),
    );
    assert.equal(decorations.length, 2);
    assert.equal(decorations[0]!.visible, true);
    assert.equal(decorations[1]!.visible, false);
    assert.ok(decorations[0]!.bounds.x >= first.bounds.x - 4);
    assert.ok(decorations[0]!.bounds.x < first.bounds.x);
  }
  const isolation = await electron.evaluate(async ({ webContents }, id) => {
    const owner = globalThis.browserTabsHostFixture.window;
    const contents = webContents.fromId(id);
    if (!contents || contents === owner.webContents) throw Error('fixture_exact_page_missing');
    const view = owner.contentView.children.find(
      (view) => 'webContents' in view && view.webContents === contents,
    ) as typeof globalThis.browserTabsHostFixture.rootView | undefined;
    if (!view) throw Error('fixture_exact_page_view_missing');
    await owner.webContents.session.cookies.set({
      url: globalThis.browserTabsHostFixture.origin,
      name: 'app_only',
      value: 'private',
    });
    const preferences = (
      view.webContents as typeof view.webContents & {
        getLastWebPreferences(): Electron.WebPreferences;
      }
    ).getLastWebPreferences();
    view.webContents.openDevTools();
    return {
      preferences,
      devToolsOpened: view.webContents.isDevToolsOpened(),
      sameSession: view.webContents.session === owner.webContents.session,
      persistent: view.webContents.session.isPersistent(),
      globals: await view.webContents.executeJavaScript(
        '[typeof window.kiteNative, typeof require, typeof process]',
      ),
      cookies: await view.webContents.executeJavaScript('document.cookie'),
    };
  }, first.id);
  assert.equal(isolation.preferences.sandbox, true);
  assert.equal(isolation.preferences.contextIsolation, true);
  assert.equal(isolation.preferences.nodeIntegration, false);
  assert.equal(isolation.preferences.webviewTag, false);
  assert.equal(isolation.devToolsOpened, false);
  assert.ok(!isolation.preferences.preload);
  assert.equal(isolation.sameSession, false);
  assert.equal(isolation.persistent, false);
  assert.deepEqual(isolation.globals, ['undefined', 'undefined', 'undefined']);
  assert.ok(!isolation.cookies.includes('app_only'));

  // A genuinely pending engine document must outlive the former application
  // deadline and display its exact page when the server finally completes it.
  await rail.getByRole('button', { name: '新建标签页', exact: true }).click();
  await address().fill(`${origin}/slow-document`);
  await address().press('Enter');
  await rail.getByRole('tab', { name: 'Slow document', exact: true }).waitFor();
  const slowTabId = await rail
    .getByRole('tab', { name: 'Slow document', exact: true })
    .getAttribute('id');
  assert.ok(slowTabId, 'slow_browser_tab_identity_missing');
  const slowTab = rail.locator(`[id=${JSON.stringify(slowTabId)}]`);
  await electron.evaluate(async () => {
    while (!globalThis.browserTabsHostFixture.hits['/pending-script'])
      await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const slow = (await inspect()).find((v) => v.id !== first.id)!;
  await new Promise((resolve) => setTimeout(resolve, 12100));
  assert.equal(await rail.getByRole('status', { name: '网页加载中', exact: true }).count(), 1);
  assert.equal(await rail.getByRole('alert').count(), 0);
  assert.equal(await rail.getByText('网页显示尚未确认，请刷新或重新输入地址。').count(), 0);
  assert.equal((await inspect()).find((v) => v.id === slow.id)!.visible, false);
  // A delayed application layout must retire the paint, not fail the engine's
  // healthy document. Only the real Root bounds notification resumes display.
  const rootBounds = await electron.evaluate(() => {
    const root = globalThis.browserTabsHostFixture.rootView;
    const bounds = root.getBounds();
    root.setBounds({ ...bounds, width: bounds.width - 1 });
    return bounds;
  });
  await electron.evaluate(() => globalThis.browserTabsHostFixture.releaseSlowDocuments());
  await electron.evaluate(
    async ({ webContents }, id) =>
      webContents
        .fromId(id)!
        .executeJavaScript(
          'new Promise(resolve => document.readyState === "complete" ? resolve(true) : addEventListener("load", () => resolve(true), {once:true}))',
        ),
    slow.id,
  );
  assert.equal(await rail.getByRole('status', { name: '网页加载中', exact: true }).count(), 1);
  assert.equal(await rail.getByRole('alert').count(), 0);
  await electron.evaluate((_, bounds) => {
    globalThis.browserTabsHostFixture.rootView.setBounds(bounds);
  }, rootBounds);
  await page.waitForFunction(() => !document.querySelector('.native-browser-start'));
  assert.equal((await inspect()).find((v) => v.id === slow.id)!.visible, true);
  assert.equal(
    await electron.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('document.body.innerText'),
      slow.id,
    ),
    'Slow document',
  );
  // Explicitly stopping a second blocked document must not synthesize a
  // display failure; its committed DOM may finish without another dom-ready.
  await address().fill(`${origin}/slow-document`);
  await address().press('Enter');
  await electron.evaluate(async () => {
    while ((globalThis.browserTabsHostFixture.hits['/pending-script'] ?? 0) < 2)
      await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await rail.getByRole('button', { name: '停止加载', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.native-browser-start'));
  assert.equal(await rail.getByRole('alert').count(), 0);
  assert.equal((await inspect()).find((v) => v.id === slow.id)!.visible, true);
  assert.equal(
    await electron.evaluate(() => globalThis.browserTabsHostFixture.hits['/slow-document']),
    2,
  );
  await address().fill(`${origin}/slow-response`);
  await address().press('Enter');
  await electron.evaluate(async () => {
    while (!globalThis.browserTabsHostFixture.hits['/slow-response'])
      await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await rail.getByRole('button', { name: '停止加载', exact: true }).click();
  await rail.getByRole('status').filter({ hasText: '已停止加载' }).waitFor();
  assert.equal(await rail.getByRole('alert').count(), 0);
  await address().fill(`${origin}/one`);
  await address().press('Enter');
  await slowTab.filter({ hasText: 'Page One' }).waitFor();
  assert.equal(await rail.getByRole('tab', { name: 'Page One', exact: true }).count(), 2);
  assert.equal(await slowTab.getAttribute('aria-selected'), 'true');
  assert.equal(await firstTab.getAttribute('aria-selected'), 'false');
  await page.waitForFunction(() => !document.querySelector('.native-browser-start'));
  await slowTab
    .locator('..')
    .getByRole('button', { name: '关闭标签页：Page One', exact: true })
    .click();
  await slowTab.waitFor({ state: 'detached' });
  await firstTab.waitFor();
  assert.equal(
    (await inspect()).some((view) => view.id === slow.id),
    false,
  );
  assert.equal((await inspect()).find((view) => view.id === first.id)?.visible, true);

  // The browser error page keeps the native failed document and history;
  // website-supplied HTTP errors remain ordinary website content.
  await rail.getByRole('button', { name: '\u65B0\u5EFA\u6807\u7B7E\u9875', exact: true }).click();
  await address().fill(`${origin}/one`);
  await address().press('Enter');
  await page.waitForFunction(
    () => document.querySelector('[role="tab"][data-state="active"]')?.textContent === 'Page One',
  );
  await address().fill(`${origin}/engine-failure`);
  await address().press('Enter');
  await rail
    .getByRole('heading', { name: '\u65E0\u6CD5\u8BBF\u95EE\u6B64\u7AD9\u70B9', exact: true })
    .waitFor();
  const failedPage = (await inspect()).find(
    (v) => v.id !== first.id && v.url === `${origin}/engine-failure`,
  );
  assert.ok(failedPage, 'native_failed_document_missing');
  assert.equal(failedPage.visible, false);
  const engineError = await electron.evaluate(
    async ({ webContents }, id) =>
      webContents
        .fromId(id)!
        .executeJavaScript('({href:location.href,text:document.body.innerText})'),
    failedPage.id,
  );
  assert.equal(engineError.href, 'chrome-error://chromewebdata/');
  assert.equal(engineError.text, '');
  assert.equal(await rail.getByRole('alert').count(), 1);
  assert.equal(await rail.getByText('ERR_EMPTY_RESPONSE', { exact: true }).count(), 1);
  assert.equal(await address().inputValue(), `${origin}/engine-failure`);
  await rail.getByRole('button', { name: '\u540E\u9000', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[role="tab"][data-state="active"]')?.textContent === 'Page One',
  );
  await address().fill(`${origin}/site-404`);
  await address().press('Enter');
  await rail.getByRole('tab', { name: 'Site supplied 404', exact: true }).waitFor();
  assert.equal(await rail.getByRole('alert').count(), 0);
  assert.equal(
    await electron.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('document.body.innerText'),
      failedPage.id,
    ),
    'Site supplied 404',
  );
  await address().fill(`${origin}/engine-failure`);
  await address().press('Enter');
  await rail
    .getByRole('heading', { name: '\u65E0\u6CD5\u8BBF\u95EE\u6B64\u7AD9\u70B9', exact: true })
    .waitFor();
  await electron.evaluate(() => {
    globalThis.browserTabsHostFixture.recoverEnginePage = true;
  });
  await rail.getByRole('button', { name: '\u91CD\u65B0\u52A0\u8F7D', exact: true }).click();
  await rail.getByRole('tab', { name: 'Recovered engine page', exact: true }).waitFor();
  assert.equal(
    (await inspect()).find((v) => v.id === failedPage.id)?.url,
    `${origin}/engine-failure`,
  );
  await rail
    .getByRole('button', {
      name: '\u5173\u95ED\u6807\u7B7E\u9875\uFF1ARecovered engine page',
      exact: true,
    })
    .click();
  await rail.getByRole('tab', { name: 'Page One', exact: true }).waitFor();
  assert.equal((await inspect()).find((v) => v.id === first.id)?.visible, true);
  const clickGuest = (selector: string) =>
    electron!.evaluate(
      async ({ webContents }, input) => {
        await webContents
          .fromId(input.id)!
          .executeJavaScript(
            `document.querySelector(${JSON.stringify(input.selector)}).click()`,
            true,
          );
      },
      { id: first.id, selector },
    );
  await clickGuest('#next');
  await rail.getByRole('tab', { name: 'Page Two', exact: true }).waitFor();
  await rail.getByRole('button', { name: '后退', exact: true }).click();
  await rail.getByRole('tab', { name: 'Page One', exact: true }).waitFor();
  await rail.getByRole('button', { name: '前进', exact: true }).click();
  await rail.getByRole('tab', { name: 'Page Two', exact: true }).waitFor();
  const beforeReload = await electron.evaluate(
    () => globalThis.browserTabsHostFixture.hits['/two']!,
  );
  await rail.getByRole('button', { name: '刷新网页', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[role="tab"][data-state="active"]')?.textContent === 'Page Two',
  );
  await electron.evaluate(async () => {
    for (let i = 0; i < 100 && globalThis.browserTabsHostFixture.hits['/two']! < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
  });
  assert.ok(
    (await electron.evaluate(() => globalThis.browserTabsHostFixture.hits['/two']!)) > beforeReload,
  );
  await rail.getByRole('button', { name: '新建标签页', exact: true }).click();
  await rail.locator('.session-browser-tool:visible').click();
  await rail.getByRole('region', { name: '变更内容' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.browserTabsFixture.readers()), {
    mounted: 1,
    closed: 0,
  });
  await rail.getByRole('button', { name: '收起标签栏' }).click();
  await page.waitForFunction(() => window.browserTabsFixture.readers().closed === 1);
  assert.deepEqual(await page.evaluate(() => window.browserTabsFixture.readers()), {
    mounted: 1,
    closed: 1,
  });
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await rail.getByRole('tab', { name: 'Page Two', exact: true }).click();
  assert.equal((await inspect())[0]!.id, first.id);
  await page.waitForFunction(() => {
    const readers = window.browserTabsFixture.readers();
    return readers.mounted === readers.closed;
  });
  const inactiveReaders = await page.evaluate(() => window.browserTabsFixture.readers());
  const retainedRail = page.getByRole('complementary', {
    name: '标签页',
    exact: true,
    includeHidden: true,
  });
  const retainedTabs = await retainedRail
    .getByRole('tab', { includeHidden: true })
    .allTextContents();
  assert.deepEqual(retainedTabs, ['Page Two', '新标签页', '变更']);
  for (const width of [520, 1280]) {
    await electron.evaluate(
      (_api, width) => globalThis.browserTabsHostFixture.window.setContentSize(width, 800),
      width,
    );
    if (width === 520) {
      await page.waitForFunction(
        () => document.getElementById('details')?.getBoundingClientRect().width === 0,
      );
      await rail.getByRole('tab', { name: 'Page Two', exact: true }).waitFor({ state: 'hidden' });
    } else {
      await rail.getByRole('tab', { name: 'Page Two', exact: true }).waitFor();
    }
    const deadline = Date.now() + 6000;
    let view = (await inspect())[0]!;
    while (
      (width === 520
        ? view.visible
        : !view.visible || view.bounds.width <= 100 || view.bounds.height <= 100) &&
      Date.now() < deadline
    ) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      view = (await inspect())[0]!;
    }
    assert.equal(view.id, first.id);
    assert.equal(view.url, `${origin}/two`);
    assert.equal(view.visible, width !== 520);
    if (width !== 520) assert.ok(view.bounds.width > 100 && view.bounds.height > 100);
    assert.equal(
      await page.getByRole('button', { name: '标签页', exact: true }).getAttribute('aria-expanded'),
      'true',
    );
    assert.deepEqual(
      await retainedRail.getByRole('tab', { includeHidden: true }).allTextContents(),
      retainedTabs,
    );
    assert.deepEqual(
      await page.evaluate(() => window.browserTabsFixture.readers()),
      inactiveReaders,
    );
  }
  // Preserve the exact native document when the UI changes its Root-local
  // owner. The returning inventory supplies its original tab ID, not a URL guess.
  await page.waitForFunction(() => {
    const details = document.getElementById('details');
    return (
      !!details &&
      !details
        .parentElement!.getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation instanceof CSSTransition &&
            ['width', 'flex-grow', 'flex-basis'].includes(animation.transitionProperty) &&
            animation.playState === 'running',
        )
    );
  });
  await page.waitForFunction(() => !document.querySelector('.native-browser-start'));
  const retainedInventory = await page.evaluate(async () => {
    const draft = window.browserTabsFixture.draft();
    return window.kiteNative!.restoreBrowserDraft!(draft);
  });
  assert.equal(retainedInventory.pages.length, 1);
  const retainedPage = retainedInventory.pages[0]!;
  assert.ok(retainedPage.pageToken);
  const readRetainedDocument = () =>
    electron!.evaluate(async ({ webContents }) => {
      const retained = globalThis.browserTabsHostFixture.retained!;
      const contents = retained.contents;
      return {
        id: contents.id,
        exactContents: webContents.fromId(contents.id) === contents,
        exactFrame: contents.mainFrame === retained.frame,
        visible: retained.view.getVisible(),
        bounds: retained.view.getBounds(),
        viewport: await contents.executeJavaScript(
          `({width:innerWidth,height:innerHeight,documentHeight:document.documentElement.scrollHeight,readingOffset:document.querySelector('#reading').offsetTop})`,
        ),
        document: await contents.executeJavaScript(
          `({timeOrigin:performance.timeOrigin,value:document.querySelector('#retained').value,scrollY,readingTop:document.querySelector('#reading').getBoundingClientRect().top})`,
        ),
      };
    });
  await electron.evaluate(async ({ webContents }, id) => {
    const fixture = globalThis.browserTabsHostFixture;
    const contents = webContents.fromId(id)!;
    const view = fixture.window.contentView.children.find(
      (view) => 'webContents' in view && view.webContents === contents,
    ) as NonNullable<typeof fixture.retained>['view'];
    if (!view) throw Error('fixture_exact_retained_view_missing');
    fixture.retained = { contents, view, frame: contents.mainFrame };
    await contents.executeJavaScript(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
        document.querySelector('#retained').value='keep this exact form';scrollTo(0,420);
        requestAnimationFrame(resolve);
      })))`,
    );
  }, first.id);
  const beforeScope = await readRetainedDocument();
  assert.equal(beforeScope.exactContents, true);
  assert.equal(beforeScope.exactFrame, true);
  assert.equal(beforeScope.document.value, 'keep this exact form');
  assert.equal(beforeScope.document.scrollY, 420);
  const beforeScopeHits = await electron.evaluate(
    () => globalThis.browserTabsHostFixture.hits['/two'],
  );
  await page.evaluate(() => window.browserTabsFixture.setScope('session-b'));
  await electron.evaluate(async () => {
    const retained = globalThis.browserTabsHostFixture.retained!;
    for (let i = 0; i < 100 && retained.view.getVisible(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const hiddenScope = await readRetainedDocument();
  assert.equal(hiddenScope.id, first.id);
  assert.equal(hiddenScope.exactContents, true);
  assert.equal(hiddenScope.exactFrame, true);
  assert.equal(hiddenScope.visible, false);
  assert.deepEqual(hiddenScope.document, beforeScope.document);
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await rail.getByRole('tab', { name: '新标签页', exact: true }).waitFor();
  assert.equal(await rail.getByRole('tab').count(), 1);
  assert.equal((await inspect()).length, 1);
  const otherOwnerDenied = await page.evaluate(async (id) => {
    try {
      await window.kiteNative!.browserRequest!({
        action: 'state',
        id,
        draft: window.browserTabsFixture.draft(),
      });
      return false;
    } catch {
      return true;
    }
  }, retainedPage.id);
  assert.equal(otherOwnerDenied, true);
  await page.evaluate(() => window.browserTabsFixture.setScope('session-a'));
  await rail.getByRole('tab', { name: 'Page Two', exact: true }).waitFor();
  await electron.evaluate(async () => {
    const retained = globalThis.browserTabsHostFixture.retained!;
    for (let i = 0; i < 100 && !retained.view.getVisible(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const restoredScope = await readRetainedDocument();
  assert.equal(restoredScope.id, first.id);
  assert.equal(restoredScope.exactContents, true);
  assert.equal(restoredScope.exactFrame, true);
  assert.equal(restoredScope.visible, true);
  const {
    scrollY: originalScrollY,
    readingTop: originalTop,
    ...originalReading
  } = beforeScope.document;
  const {
    scrollY: restoredScrollY,
    readingTop: restoredTop,
    ...restoredReading
  } = restoredScope.document;
  assert.deepEqual(restoredReading, originalReading);
  assert.ok(Math.abs(restoredTop - originalTop) <= 1, 'visible reading anchor moved');
  const sameViewport =
    restoredScope.viewport.width === beforeScope.viewport.width &&
    restoredScope.viewport.height === beforeScope.viewport.height;
  if (sameViewport) assert.equal(restoredScrollY, originalScrollY);
  else {
    // A different native viewport reflows this document. Preserve the exact
    // visible reading anchor and verify the browser's compensating scroll.
    assert.notDeepEqual(
      [restoredScope.bounds.width, restoredScope.bounds.height],
      [beforeScope.bounds.width, beforeScope.bounds.height],
    );
    assert.ok(Number.isFinite(restoredScrollY) && restoredScrollY >= 0);
    assert.ok(
      restoredScrollY <= restoredScope.viewport.documentHeight - restoredScope.viewport.height,
    );
    const reflow = restoredScope.viewport.readingOffset - beforeScope.viewport.readingOffset;
    assert.ok(Math.abs(restoredScrollY - originalScrollY - reflow) <= 1);
  }
  console.log(
    'browser_reading_restore',
    JSON.stringify({
      before: { bounds: beforeScope.bounds, ...beforeScope.document },
      restored: { bounds: restoredScope.bounds, ...restoredScope.document },
    }),
  );
  const restoredInventory = await page.evaluate(() =>
    window.kiteNative!.restoreBrowserDraft!(window.browserTabsFixture.draft()),
  );
  assert.deepEqual(
    restoredInventory.pages.map(({ id }) => id),
    [retainedPage.id],
  );
  assert.equal(restoredInventory.pages[0]!.pageToken, retainedPage.pageToken);
  assert.equal(
    await electron.evaluate(() => globalThis.browserTabsHostFixture.hits['/two']),
    beforeScopeHits,
  );
  await clickGuest('#popup');
  assert.equal(await electron.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length), 1);
  const rejected = await page.evaluate(async () => {
    try {
      await window.kiteNative!.browserRequest!({
        action: 'navigate',
        id: 'invalid-protocol',
        input: 'file:///C:/private.txt',
        draft: window.browserTabsFixture.draft(),
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true);
  assert.equal((await inspect()).length, 1);
  const foreign = await electron.evaluate(
    async ({ BrowserWindow }, preload) => {
      const fixture = globalThis.browserTabsHostFixture;
      const window = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await window.loadURL(`${fixture.origin}/foreign`);
        return await window.webContents.executeJavaScript(
          `window.kiteNative.browserRequest({action:'navigate',id:'foreign',input:'https://example.com'}).then(()=> 'allowed', error=>error.message)`,
        );
      } finally {
        window.destroy();
      }
    },
    join(directory, 'preload.cjs'),
  );
  assert.equal(foreign, 'native_sender_denied');
  await clickGuest('#download');
  await rail.getByRole('alert').filter({ hasText: '暂不支持下载' }).waitFor();
  await rail.getByRole('button', { name: '关闭标签页：Page Two', exact: true }).click();
  await electron.evaluate(async ({ webContents }, id) => {
    for (let i = 0; i < 100 && webContents.fromId(id); i++)
      await new Promise((r) => setTimeout(r, 20));
  }, first.id);
  assert.equal(
    await electron.evaluate(({ webContents }, id) => !!webContents.fromId(id), first.id),
    false,
  );
  // Only the explicit tab X destroyed it. A later owner change creates no
  // replacement document and is not another destruction mechanism.
  await page.evaluate(() => window.browserTabsFixture.setScope('session-b'));
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await rail.getByRole('tab', { name: '新标签页', exact: true }).waitFor();
  assert.equal(await rail.getByRole('tab').count(), 1);
  assert.equal((await inspect()).length, 0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.screenshot({ path: join(directory, `sidebar-${theme}.png`) });
  }
  if (process.platform === 'darwin') {
    await page.evaluate(() => {
      document.documentElement.dataset.platform = 'macos';
      document.documentElement.dataset.windowMaterial = 'vibrancy';
    });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('.session-header')!.getBoundingClientRect().x < 1 &&
          document.querySelector('.client-panels')!.getAttribute('data-animate-width') !== 'true',
      );
      const region = await page.evaluate(() => {
        const header = document.querySelector('.session-header')!;
        const placeholder = document.querySelector('.session-sidebar-toggle')!;
        const button = document.querySelector('.desktop-sidebar-toggle button')!;
        const bounds = button.getBoundingClientRect();
        const space = placeholder.getBoundingClientRect();
        return {
          header: getComputedStyle(header).getPropertyValue('-webkit-app-region'),
          placeholder: getComputedStyle(placeholder).getPropertyValue('-webkit-app-region'),
          containsButton:
            space.left <= bounds.left &&
            space.right >= bounds.right &&
            space.top <= bounds.top &&
            space.bottom >= bounds.bottom,
        };
      });
      assert.equal(region.header, 'drag');
      assert.equal(region.placeholder, 'no-drag');
      assert.equal(region.containsButton, true);
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
      await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelector('.session-header')!.getBoundingClientRect().x >= 199,
      );
    }
  }
  console.log(`browser_electron_artifacts:${directory}`);
  console.log(
    'browser_electron_pass: external reply links, keyboard, fragments, navigation, history, readers, resize, exact owner hide/restore, form/reading retention, isolation, foreign IPC, popup, download, explicit destruction',
  );
} finally {
  clearTimeout(timeout);
  await electron?.close();
}
