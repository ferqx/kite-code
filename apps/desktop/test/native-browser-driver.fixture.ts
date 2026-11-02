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
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  const rail = page.getByRole('complementary', { name: '标签页', exact: true });
  await rail.getByRole('tab').waitFor();
  await rail.locator('.session-browser-tool:visible').waitFor();
  assert.equal(await page.getByRole('button', { name: '文件变更', exact: true }).count(), 0);
  assert.equal(await rail.getByRole('tab').count(), 1);
  assert.equal(await rail.locator('.session-browser-tool:visible').count(), 1);
  const origin = await electron.evaluate(() => globalThis.browserTabsHostFixture.origin);
  const address = () => rail.getByRole('textbox', { name: '搜索或输入网址' });
  await address().fill(`${origin}/one`);
  await address().press('Enter');
  await rail.getByRole('tab', { name: 'Page One', exact: true }).waitFor();
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
      `document.querySelector('#retained').value='keep this exact form';scrollTo(0,420)`,
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
  assert.deepEqual(restoredScope.document, beforeScope.document);
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
  console.log(
    'browser_electron_pass: navigation, history, readers, resize, exact owner hide/restore, form/reading retention, isolation, foreign IPC, popup, download, explicit destruction',
  );
} finally {
  clearTimeout(timeout);
  await electron?.close();
}
