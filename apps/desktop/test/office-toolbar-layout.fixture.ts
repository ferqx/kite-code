/** Explicit Chromium layout regression. No real files, Service, model or user configuration. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron } from 'playwright';
import { build } from 'vite';

const root = await mkdtemp(join(tmpdir(), 'kite-toolbar-layout-'));
await build({
  root: dirname(import.meta.dir),
  configFile: false,
  envFile: false,
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  esbuild: { jsxDev: false },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: root,
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dir, 'office-toolbar-layout-renderer.fixture.tsx'),
      formats: ['es'],
      fileName: () => 'renderer.js',
      cssFileName: 'renderer',
    },
  },
});
await writeFile(
  join(root, 'index.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>',
);
await writeFile(
  join(root, 'main.cjs'),
  `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(()=>{const w=new BrowserWindow({width:640,height:560,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.webContents.session.setPermissionRequestHandler((a,b,c)=>c(false));w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.loadFile(path.join(__dirname,'index.html'));});`,
);
const executablePath = process.env.KITE_ELECTRON_EXECUTABLE;
const app = await _electron.launch({
  args: [join(root, 'main.cjs')],
  ...(executablePath ? { executablePath } : {}),
});
const page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(String(error)));
const checks: unknown[] = [];
const disclosureChecks: unknown[] = [];
async function checkNarrowDisclosure() {
  const button = page.locator('.native-excel-expand');
  const value = page.getByLabel('单元格公式（只读）', { exact: true });
  const style = () =>
    button.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      circular:
        Number.parseFloat(getComputedStyle(el).borderRadius) >=
        el.getBoundingClientRect().width / 2,
      shadow: getComputedStyle(el).boxShadow,
      focus: el.matches(':focus-visible'),
      rotation: getComputedStyle(el.querySelector('svg')!).transform,
    }));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.mouse.move(10, 160);
    const collapsed = await style();
    assert.equal(collapsed.circular, true);
    assert.equal(collapsed.background, 'rgba(0, 0, 0, 0)');
    assert.equal(collapsed.rotation, 'none');
    await button.hover();
    await page.waitForFunction(
      (background) =>
        getComputedStyle(document.querySelector('.native-excel-expand')!).backgroundColor !==
        background,
      collapsed.background,
    );
    const hover = await style();
    assert.notEqual(hover.background, collapsed.background);
    await button.click();
    await page.mouse.move(10, 160);
    await page.waitForFunction(
      (background) =>
        getComputedStyle(document.querySelector('.native-excel-expand')!).backgroundColor ===
        background,
      collapsed.background,
    );
    const opened = await style();
    assert.equal(
      opened.background,
      collapsed.background,
      'open alone must not paint the disclosure',
    );
    assert.notEqual(opened.rotation, collapsed.rotation);
    await page.screenshot({ path: join(root, `xlsx-320-${theme}-expanded.png`) });
    await value.focus();
    await page.keyboard.press('Tab');
    const focused = await style();
    assert.equal(focused.focus, true);
    assert.equal(focused.circular, true);
    assert.notEqual(focused.shadow, opened.shadow);
    await page.screenshot({ path: join(root, `xlsx-320-${theme}-keyboard.png`) });
    await page.keyboard.press('Enter');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.native-excel-details').count(), 0);
    await value.focus();
    disclosureChecks.push({ theme, collapsed, hover, opened, focused });
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
}

try {
  for (const kind of ['docx', 'xlsx', 'pptx', 'pdf']) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`file://${join(root, 'index.html')}?kind=${kind}`);
    await page.getByRole('button', { name: '另存为', exact: true }).waitFor();
    assert.equal(await page.getByLabel('修改 Skill', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '请求修改', exact: true }).count(), 0);
    for (const width of kind === 'xlsx' ? [320, 420, 550, 640] : [240, 280, 320, 480, 640]) {
      await app.evaluate(
        ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.setContentSize(value, 560),
        width,
      );
      await page.waitForFunction((value) => innerWidth === value, width);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const geometry = await page.evaluate(() => {
        const toolbar = document.querySelector('.native-office-toolbar')!;
        const rect = toolbar.getBoundingClientRect();
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            '.native-office-toolbar button, .native-office-toolbar select, .native-excel-readonly textarea, .native-excel-readonly button',
          ),
        ]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              border: style.borderTopWidth,
              slot: el.dataset.slot,
              label: el.getAttribute('aria-label') || el.textContent,
              left: r.left,
              right: r.right,
              width: r.width,
              top: r.top,
              bottom: r.bottom,
            };
          });
        const strip = document.querySelector('.native-excel-readonly')?.getBoundingClientRect();
        return {
          strip: strip
            ? {
                left: strip.left,
                width: strip.width,
                top: strip.top,
                bottom: strip.bottom,
                height: strip.height,
              }
            : null,
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          toolbarHeight: rect.height,
          toolbarWidth: rect.width,
          toolbarBottom: rect.bottom,
          contentTop: document.querySelector('[data-fixture-document]')!.getBoundingClientRect()
            .top,
          controls,
        };
      });
      assert.ok(
        geometry.contentTop >= geometry.toolbarBottom,
        'toolbar must reserve content space',
      );
      if (width >= 320 && kind !== 'xlsx')
        assert.ok(geometry.toolbarWidth < width - 40, 'floating controls do not span the pane');
      assert.equal(geometry.toolbarHeight, 32, 'one row; the document keeps all remaining height');
      if (kind === 'xlsx') {
        const strip = geometry.strip!;
        assert.ok(
          strip.top >= geometry.toolbarBottom,
          'selection belongs below the stable command row',
        );
        assert.equal(strip.left, 0);
        assert.equal(strip.width, width);
        assert.equal(strip.height, 32);
        assert.equal(strip.bottom, geometry.contentTop, 'the formula strip meets the grid');
        const toggle = geometry.controls.find(({ label }) => label === '展开单元格内容')!;
        assert.deepEqual([toggle.width, toggle.bottom - toggle.top], [28, 28]);
        if (width === 320) {
          const formula = geometry.controls.find(({ label }) => label === '单元格公式（只读）')!;
          assert.ok(
            formula.width >= width * 0.6,
            `the value takes most of the full-width strip even in the narrow pane: ${formula.width}px of ${width}px`,
          );
          await checkNarrowDisclosure();
          const locate = page.getByRole('button', { name: '定位当前选区' });
          assert.equal(
            await locate.innerText(),
            'AA10000',
            'a narrow range names the actual anchor',
          );
          assert.ok(await locate.evaluate((button) => button.scrollWidth <= button.clientWidth));
          assert.match((await locate.getAttribute('title')) ?? '', /AA10000:AZ10099/);
        }
      }
      const save = geometry.controls.find(({ label }) => label === '另存为')!;
      const zoom = geometry.controls.find(({ label }) => label === '预览缩放')!;
      assert.deepEqual([save.width, save.bottom - save.top], [32, 32]);
      assert.equal(save.slot, 'button');
      assert.equal(zoom.slot, 'select-trigger');
      assert.ok(zoom.right < save.left, 'reading controls precede file actions');
      assert.ok(geometry.scrollWidth <= width, JSON.stringify({ kind, geometry }));
      for (const control of geometry.controls) {
        assert.ok(
          control.left >= 0 && control.right <= width && control.width >= 20,
          JSON.stringify({ kind, control, width }),
        );
      }
      for (let i = 0; i < geometry.controls.length; i++)
        for (let j = i + 1; j < geometry.controls.length; j++) {
          const a = geometry.controls[i]!,
            b = geometry.controls[j]!;
          assert.ok(
            Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 0.5 ||
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 0.5,
            JSON.stringify({ overlap: [a, b], kind, width }),
          );
        }
      if (width === 240 && kind === 'pptx') {
        await page.getByRole('button', { name: '放映', exact: true }).click();
        const stop = page.getByRole('button', { name: '退出放映', exact: true });
        await stop.waitFor();
        assert.equal(await stop.getAttribute('aria-pressed'), 'true');
        await stop.click();
      }
      checks.push({ kind, ...geometry });
      if (width === 240 || width === 320 || width === 640)
        await page.screenshot({ path: join(root, `${kind}-${width}.png`) });
    }
    const beforeZoom = await page.locator('.native-office-toolbar').boundingBox();
    const zoom = page.getByRole('combobox', { name: '预览缩放' });
    const documentFrame = page.locator('[data-fixture-document]');
    const beforeOpen = await documentFrame.boundingBox();
    await zoom.click();
    const double = page.getByRole('option', { name: '200%', exact: true });
    await double.waitFor();
    assert.deepEqual(await documentFrame.boundingBox(), beforeOpen);
    await double.click();
    assert.deepEqual(await documentFrame.boundingBox(), beforeOpen);
    assert.equal(await zoom.getAttribute('aria-expanded'), 'false');
    assert.equal(await zoom.textContent(), '200%');
    assert.deepEqual(
      await page.locator('.native-office-toolbar').boundingBox(),
      beforeZoom,
      'document zoom does not scale toolbar',
    );
    await page.getByRole('button', { name: '另存为', exact: true }).focus();
    await page.keyboard.press('Enter');
    if (kind === 'pptx') {
      await page.getByRole('button', { name: '放映', exact: true }).click();
      await page.getByRole('button', { name: '退出放映', exact: true }).click();
    }
    if (kind === 'xlsx') {
      await page.getByRole('button', { name: '展开单元格内容' }).click();
      assert.equal(await page.locator('.native-excel-details textarea').getAttribute('rows'), '5');
      await page.getByRole('button', { name: '收起单元格内容' }).click();
      await page.getByRole('button', { name: '定位当前选区' }).click();
    }
    const events = JSON.parse((await page.locator('#events').textContent()) ?? '[]') as string[];
    assert.deepEqual(events, [
      ...(kind === 'pptx' ? ['presentation', 'presentation'] : []),
      'zoom:2',
      'save',
      ...(kind === 'pptx' ? ['presentation', 'presentation'] : []),
      ...(kind === 'xlsx' ? ['locate'] : []),
    ]);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({ passed: true, checks, disclosureChecks, errors }, null, 2),
  );
  console.log(root, `${checks.length} layout cases passed`);
} finally {
  await app.close();
}
