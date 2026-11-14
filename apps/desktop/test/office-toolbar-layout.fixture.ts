/** Explicit Chromium layout regression. No real files, Service, model or user configuration. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';

const root = await mkdtemp(join(tmpdir(), 'kite-toolbar-layout-'));
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'office-toolbar-layout-renderer.fixture.tsx')],
  outdir: root,
  naming: 'renderer.[ext]',
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (!build.success) throw new AggregateError(build.logs, 'build_failed');
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
try {
  for (const kind of ['docx', 'xlsx', 'pptx', 'pdf']) {
    await page.goto(`file://${join(root, 'index.html')}?kind=${kind}`);
    await page.getByRole('button', { name: '请求修改', exact: true }).waitFor();
    for (const width of [240, 280, 320, 480, 640]) {
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
            '.native-office-toolbar button, .native-office-toolbar select, .native-excel-readonly button, .native-excel-readonly textarea, .native-office-notes summary',
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: el.getAttribute('aria-label') || el.textContent,
            left: r.left,
            right: r.right,
            width: r.width,
            top: r.top,
            bottom: r.bottom,
          };
        });
        return {
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
      if (width >= 320)
        assert.ok(geometry.toolbarWidth < width - 40, 'floating controls do not span the pane');
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
      checks.push({ kind, ...geometry });
      if (width === 240 || width === 640)
        await page.screenshot({ path: join(root, `${kind}-${width}.png`) });
    }
    const beforeZoom = await page.locator('.native-office-toolbar').boundingBox();
    await page.getByRole('button', { name: '请求修改', exact: true }).hover();
    await page.getByRole('button', { name: '请求修改', exact: true }).click();
    await page.getByLabel('预览缩放').selectOption('2');
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
      assert.equal(await page.locator('textarea').getAttribute('rows'), '5');
      await page.getByRole('button', { name: '收起单元格内容' }).click();
      await page.getByRole('button', { name: '定位当前选区' }).click();
    }
    const events = JSON.parse((await page.locator('#events').textContent()) ?? '[]') as string[];
    assert.deepEqual(events.slice(0, 3), ['edit', 'zoom:2', 'save']);
    if (kind === 'pptx') assert.deepEqual(events.slice(3), ['presentation', 'presentation']);
    if (kind === 'xlsx') assert.deepEqual(events.slice(3), ['locate']);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(root, '20 layout cases passed');
} finally {
  await app.close();
}
