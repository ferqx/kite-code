import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import type {} from './session-shell-browser.fixture';

// Explicit standalone fixture; it never loads Service, user data or the production diagnostics.
const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'session-shell-browser-'));
const output = path.join(artifact, 'dist');
await build({
  root: path.dirname(directory),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  base: './',
  logLevel: 'error',
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: path.join(directory, 'session-shell-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
    target: 'esnext',
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (pathname === '/')
      return new Response(
        '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = path.resolve(output, `.${pathname}`);
    if (!file.startsWith(output + path.sep)) return new Response(null, { status: 404 });
    return new Response(Bun.file(file));
  },
});
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });

type Control =
  | 'title'
  | 'editor'
  | 'permission'
  | 'model'
  | 'rate'
  | 'action'
  | 'attach'
  | 'environment'
  | 'environmentStop'
  | 'sidebar';
type Item = {
  present: boolean;
  text: string;
  label: string;
  opacity: string;
  color: string;
  background: string;
  disabled: boolean;
  readOnly: boolean;
  rect: number[];
  same: boolean;
};
type Snapshot = Record<Control, Item>;
declare global {
  interface Window {
    captureShell: () => Snapshot;
    resetShellIdentity: () => void;
  }
}
const report = { browser: browser.version(), cases: [] as unknown[] };
const writes = new Set([
  'caller.prepare',
  'caller.submit',
  'permission.mode',
  'permission.trust',
  'submit',
  'conversation.create',
  'permission.prepare',
  'permission.submit',
  'input.prepare',
  'input.submit',
  'background.stop',
  'draft.write',
]);
try {
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: theme,
      reducedMotion: 'no-preference',
      locale: 'zh-CN',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url.toString());
    const ready = async (id: string) =>
      page.waitForFunction(
        (id) =>
          document.querySelector('.breadcrumb strong')?.textContent ===
            `Session ${id.toUpperCase()}` &&
          document
            .querySelector('[data-model-trigger]')
            ?.textContent?.includes(`Model ${id.toUpperCase()}`) &&
          !document.querySelector<HTMLButtonElement>('[data-permission-trigger]')?.disabled &&
          !document.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled,
        id,
      );
    const click = async (id: string) =>
      page.getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true }).click();
    const select = async (id: string) =>
      page
        .getByRole('button', {
          name: `Session ${id.toUpperCase()}`,
          exact: true,
          includeHidden: true,
        })
        .evaluate((node) => (node as HTMLButtonElement).click());
    await click('a');
    await ready('a');
    await page.evaluate(() => {
      const selectors: Record<Control, string> = {
        title: '.breadcrumb strong',
        editor: '.composer [role="textbox"]',
        permission: '[data-permission-trigger]',
        model: '[data-model-trigger]',
        rate: '.composer-cache-rate',
        action: '.composer-actions button',
        attach: '.composer-attach',
        environment: '.environment-information',
        environmentStop: '.background-execution-stop',
        sidebar: '.desktop-sidebar-toggle button',
      };
      const originals = new Map<Control, Element | null>();
      for (const [name, selector] of Object.entries(selectors))
        originals.set(name as Control, document.querySelector(selector));
      window.resetShellIdentity = () => {
        for (const [name, selector] of Object.entries(selectors))
          originals.set(name as Control, document.querySelector(selector));
      };
      window.captureShell = () =>
        Object.fromEntries(
          Object.entries(selectors).map(([name, selector]) => {
            const node = document.querySelector<HTMLElement>(selector),
              style = node && getComputedStyle(node),
              rect = node?.getBoundingClientRect();
            return [
              name,
              {
                present: !!node,
                text: node?.textContent ?? '',
                label: node?.getAttribute('aria-label') ?? '',
                opacity: style?.opacity ?? '',
                color: style?.color ?? '',
                background: style?.backgroundColor ?? '',
                disabled: node?.matches(':disabled') ?? false,
                readOnly: node?.getAttribute('contenteditable') === 'false',
                rect: rect ? [rect.x, rect.y, rect.width, rect.height] : [],
                same: node === originals.get(name as Control),
              },
            ];
          }),
        ) as Snapshot;
    });
    const take = () => page.evaluate(() => window.captureShell());
    const settle = () => page.waitForTimeout(180);
    const capture = () =>
      page.evaluate(async () => {
        const frames: Snapshot[] = [];
        for (let i = 0; i < 12; i++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          frames.push(window.captureShell());
        }
        return frames;
      });
    const stable = (frames: Snapshot[], expected: Snapshot, names: Control[]) => {
      for (const frame of frames)
        for (const name of names) {
          assert.equal(frame[name].present, expected[name].present, `${theme}: ${name} presence`);
          assert.equal(frame[name].same, true, `${theme}: ${name} DOM identity`);
          assert.equal(frame[name].opacity, expected[name].opacity, `${theme}: ${name} opacity`);
          assert.equal(frame[name].text, expected[name].text, `${theme}: ${name} contents`);
          assert.deepEqual(frame[name].rect, expected[name].rect, `${theme}: ${name} geometry`);
        }
    };
    // B has never been displayed: hold its catalogue after Main confirms selection.
    await settle();
    const coldA = await take();
    await page.evaluate(() => {
      const button = document.querySelector('[data-model-trigger]')!;
      const edits: string[] = [];
      const observer = new MutationObserver(() => edits.push(button.textContent ?? ''));
      observer.observe(button, { childList: true, characterData: true, subtree: true });
      Object.assign(window, { coldModelEdits: edits, coldModelObserver: observer });
      window.sessionShellFixture.hold();
    });
    await select('b');
    await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
    await page.evaluate(() => window.sessionShellFixture.release('selection'));
    await page.waitForFunction(() => window.sessionShellFixture.pending('models') > 0);
    await page.evaluate(() => window.sessionShellFixture.publish());
    const coldWaiting = await capture();
    stable(coldWaiting, coldA, [
      'title',
      'editor',
      'model',
      'permission',
      'action',
      'attach',
      'environment',
      'environmentStop',
      'sidebar',
    ]);
    assert.equal(
      await page.evaluate(() =>
        window.sessionShellFixture.requests.some(
          (request) => request.method === 'messages' && request.sessionId === 'b',
        ),
      ),
      false,
    );
    const coldFramesPromise = capture();
    await page.evaluate(() => window.sessionShellFixture.release('models'));
    const coldFrames = await coldFramesPromise;
    const coldB = await take();
    assert.equal(coldB.title.text, 'Session B');
    assert.equal(coldB.model.text, 'Model B Extended Reasoning Route中');
    for (const frame of coldFrames) {
      assert.equal(frame.model.same, true);
      assert.equal(frame.model.opacity, '1');
      assert.equal(
        frame.model.text,
        frame.title.text === 'Session A' ? coldA.model.text : coldB.model.text,
      );
      assert.equal(
        frame.model.rect[2],
        frame.title.text === 'Session A' ? coldA.model.rect[2] : coldB.model.rect[2],
      );
      assert.equal(
        frame.permission.rect[0],
        frame.title.text === 'Session A' ? coldA.permission.rect[0] : coldB.permission.rect[0],
      );
    }
    const coldEdits = await page.evaluate(() => {
      const state = window as unknown as {
        coldModelEdits: string[];
        coldModelObserver: MutationObserver;
      };
      state.coldModelObserver.disconnect();
      return state.coldModelEdits;
    });
    assert.equal(
      coldEdits.some((text) => text.includes('选择模型')),
      false,
    );
    await page.evaluate(() => window.sessionShellFixture.resume());
    await ready('b');
    await select('a');
    await ready('a');
    // Cold history legitimately creates its first usage badge; warm restoration has its own identity baseline.
    await page.evaluate(() => window.resetShellIdentity());
    // Keep the cursor over the approval selector while navigation comes from another UI event.
    const hoverSelectors = {
      permission: '[data-permission-trigger]',
      model: '[data-model-trigger]',
      attach: '.composer-attach',
      action: '.composer-actions button',
      environmentStop: '.background-execution-stop',
    } as const;
    const hovered = new Map<keyof typeof hoverSelectors, Item>();
    for (const [name, selector] of Object.entries(hoverSelectors)) {
      await page.locator(selector).hover();
      await settle();
      hovered.set(name as keyof typeof hoverSelectors, (await take())[name as Control]);
    }
    await page.locator('[data-permission-trigger]').hover();
    await settle();
    const a = await take();
    await select('b');
    await ready('b');
    await settle();
    const b = await take();
    await select('a');
    await ready('a');
    await settle();
    await page.evaluate(() => window.sessionShellFixture.hold());
    await select('b');
    await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
    const selection = await capture();
    for (const [name, selector] of Object.entries(hoverSelectors)) {
      await page.locator(selector).hover();
      await settle();
      const current = (await take())[name as Control],
        expected = hovered.get(name as keyof typeof hoverSelectors)!;
      assert.equal(
        current.background,
        expected.background,
        `${theme}: ${name} paused hover background`,
      );
      assert.equal(current.color, expected.color, `${theme}: ${name} paused hover color`);
      assert.equal(current.opacity, expected.opacity);
    }
    await page.locator(hoverSelectors.permission).hover();
    await settle();
    stable(selection, a, [
      'title',
      'editor',
      'permission',
      'model',
      'rate',
      'action',
      'attach',
      'environment',
      'environmentStop',
      'sidebar',
    ]);
    for (const frame of selection) {
      assert.equal(frame.editor.readOnly, true);
      for (const name of ['permission', 'model', 'action', 'attach', 'environmentStop'] as const)
        assert.equal(frame[name].disabled, true);
      assert.equal(frame.permission.background, a.permission.background);
      assert.equal(frame.permission.color, a.permission.color);
    }
    await page.evaluate(() => {
      for (const selector of [
        '[data-permission-trigger]',
        '[data-model-trigger]',
        '.composer-actions button',
        '.composer-attach',
        '.background-execution-stop',
      ])
        document.querySelector<HTMLButtonElement>(selector)?.click();
    });
    // Exercise actual pointerdown as well: Radix wraps the disabled native triggers.
    for (const selector of Object.values(hoverSelectors)) {
      const point = await page.locator(selector).evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
    }
    assert.equal(await page.locator('[role="menu"],[role="dialog"]').count(), 0);
    await page.evaluate(() => window.sessionShellFixture.release('selection'));
    await page.waitForFunction(
      () =>
        window.sessionShellFixture.pending('history') > 0 &&
        window.sessionShellFixture.pending('models') > 0,
    );
    const history = await capture();
    stable(history, b, [
      'title',
      'editor',
      'permission',
      'model',
      'rate',
      'action',
      'attach',
      'environment',
      'environmentStop',
      'sidebar',
    ]);
    for (const frame of history) {
      assert.equal(frame.permission.disabled, true);
      assert.equal(frame.model.disabled, true);
      assert.equal(frame.action.disabled, true);
    }
    await page.evaluate(() => window.sessionShellFixture.release('history'));
    const models = await capture();
    stable(models, b, [
      'title',
      'editor',
      'permission',
      'model',
      'rate',
      'action',
      'attach',
      'environment',
      'environmentStop',
      'sidebar',
    ]);
    for (const frame of models) assert.equal(frame.model.disabled, true);
    await page.evaluate(() => window.sessionShellFixture.resume());
    await ready('b');
    // Missing approval observations during routine recalibration retain only their display label.
    await settle();
    const readyB = await take();
    await page.evaluate(() => window.sessionShellFixture.refresh(true));
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('[data-permission-trigger]')?.disabled,
    );
    const refresh = await capture();
    stable(refresh, readyB, [
      'title',
      'editor',
      'permission',
      'model',
      'rate',
      'action',
      'attach',
      'environment',
      'environmentStop',
      'sidebar',
    ]);
    await page.evaluate(() => window.sessionShellFixture.refresh(false));
    await ready('b');
    // Scope changes also close open menus and the full-permission confirmation.
    await select('a');
    await ready('a');
    await page.locator('[data-permission-trigger]').click();
    await page.getByRole('menuitemradio', { name: /完全访问/ }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 1);
    await page.evaluate(() => window.sessionShellFixture.hold());
    await select('b');
    await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.sessionShellFixture.resume());
    await ready('b');
    await page.locator('[data-permission-trigger]').click();
    assert.equal(await page.getByRole('menu').count(), 1);
    await page.evaluate(() => window.sessionShellFixture.refresh(true));
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    await page.evaluate(() => window.sessionShellFixture.refresh(false));
    await ready('b');
    for (let i = 0; i < 100; i++) {
      const id = i % 2 ? 'b' : 'a';
      await select(id);
      await ready(id);
      const frame = await take();
      for (const name of [
        'permission',
        'model',
        'action',
        'attach',
        'editor',
        'environmentStop',
      ] as const)
        assert.equal(frame[name].opacity, '1');
      assert.equal(frame.permission.text, id === 'a' ? '自动审核' : '完全访问');
      assert.equal(frame.editor.text, `Draft ${id.toUpperCase()}`);
    }
    // A running empty draft keeps Stop; a normally disabled empty Send stays dim.
    for (const id of ['a', 'b']) {
      await select(id);
      await ready(id);
      await page.locator('.composer [role="textbox"]').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await page.waitForFunction(
        () =>
          document.querySelector('.composer-actions button')?.getAttribute('aria-label') ===
          '停止任务',
      );
    }
    await select('a');
    await ready('a');
    await settle();
    const emptyStop = await take();
    assert.equal(emptyStop.action.label, '停止任务');
    await page.evaluate(() => window.sessionShellFixture.hold());
    await select('b');
    await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
    const stopFrames = await capture();
    stable(stopFrames, emptyStop, ['editor', 'action']);
    await page.evaluate(() => window.sessionShellFixture.resume());
    await ready('b');
    await page.evaluate(() => window.sessionShellFixture.setActive(false));
    await page.waitForFunction(
      () =>
        document.querySelector('.composer-actions button')?.getAttribute('aria-label') ===
        '发送明确的新轮次',
    );
    await select('a');
    await ready('a');
    await settle();
    const emptySend = await take();
    assert.equal(emptySend.action.opacity, '0.45');
    await page.evaluate(() => window.sessionShellFixture.hold());
    await select('b');
    await page.waitForFunction(() => window.sessionShellFixture.pending('selection') > 0);
    const sendFrames = await capture();
    stable(sendFrames, emptySend, ['editor', 'action']);
    await page.evaluate(() => window.sessionShellFixture.resume());
    await ready('b');
    await page.evaluate(() => window.sessionShellFixture.fail(true));
    await page.waitForFunction(() => !document.querySelector('[data-permission-trigger]'));
    assert.equal(
      await page
        .locator('.environment-information')
        .innerText()
        .then((text) => text.includes('上次状态')),
      true,
    );
    assert.equal(await page.locator('.background-execution-stop').count(), 0);
    assert.equal(await page.locator('.composer').getAttribute('data-session-loading'), null);
    const requests = await page.evaluate(() =>
      window.sessionShellFixture.requests.map((request) => request.method),
    );
    assert.deepEqual(
      requests.filter((method) => writes.has(method)),
      [],
    );
    assert.deepEqual(errors, []);
    report.cases.push({
      theme,
      cold: { waiting: coldWaiting, frames: coldFrames, edits: coldEdits },
      a,
      b,
      selection,
      history,
      models,
      refresh,
      stopFrames,
      sendFrames,
      switches: 100,
      errors,
    });
    await page.close();
  }
  await Bun.write(
    process.argv[2] ?? path.join(artifact, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      browser: report.browser,
      themes: 2,
      switches: 200,
      heldFrames: 192,
      artifact,
    }),
  );
} finally {
  await browser.close();
  server.stop(true);
}
