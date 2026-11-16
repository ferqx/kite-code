import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron } from 'playwright';
import { build } from 'vite';
import type {} from './file-ui-electron.fixture';

const repository = resolve(import.meta.dir, '../../..');
const cache = join(repository, '.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, 'file-ui-electron-'));
await build({
  root: resolve(import.meta.dir, '..'),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  base: './',
  logLevel: 'error',
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: join(root, 'dist'),
    emptyOutDir: false,
    lib: {
      entry: join(import.meta.dir, 'file-ui-electron.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
  },
});
await Bun.write(
  join(root, 'dist/index.html'),
  '<html><head><meta charset="utf-8"><title>Isolated Electron synthetic file UI</title><link rel="stylesheet" href="./fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>',
);
await Bun.write(
  join(root, 'main.cjs'),
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({width:1200,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window.loadFile(${JSON.stringify(join(root, 'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`,
);
const require = createRequire(import.meta.url);
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS'])
  delete env[name];
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'electron-data')}`],
  env,
  cwd: repository,
});
const stages: unknown[] = [];
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.fileUiFixture);
  const checkpoint = async (stage: string) => {
    await page.waitForTimeout(300);
    const file = join(root, `${stage}.png`);
    await page.screenshot({ path: file });
    const state = await page.evaluate(() => {
      const { copied, ...fixture } = window.fileUiFixture.snapshot();
      return {
        fixture,
        copiedLength: copied.length,
        text: document.querySelector('[data-file-ui-fixture]')?.textContent?.slice(0, 300),
        buttons: [...document.querySelectorAll('[data-file-ui-fixture] button')].map((x) => ({
          text: x.textContent,
          label: x.getAttribute('aria-label'),
          expanded: x.getAttribute('aria-expanded'),
        })),
        readers: [...document.querySelectorAll('.file-diff')].map((x) => ({
          rect: x.getBoundingClientRect().toJSON(),
          rows: x.querySelectorAll('.diff-output > *').length,
        })),
      };
    });
    stages.push({ stage, file, state });
    console.log(JSON.stringify({ stage, file, state }));
  };
  const select = async (next: Parameters<typeof window.fileUiFixture.select>[0]) => {
    await page.evaluate((next) => window.fileUiFixture.select(next), next);
    await page.waitForTimeout(100);
  };
  const fixture = page.locator('[data-file-ui-fixture]');
  if (process.argv.includes('--visual-only')) {
    await select('short-edit');
    await fixture.locator('.tool-diff-toggle').click();
    await page.waitForFunction(() => window.fileUiFixture.snapshot().pending === 1);
    await page.evaluate(() => window.fileUiFixture.release());
    await fixture.locator('.diff-output').waitFor();
    await checkpoint('short-reference');
    assert.deepEqual(errors, []);
    writeFileSync(
      join(root, 'report.json'),
      JSON.stringify({ passed: true, root, stages, errors }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, root }));
    await app.close();
    process.exit(0);
  }
  for (const kind of ['edit', 'write'] as const) {
    await select(`running-${kind}`);
    await checkpoint(`running-${kind}`);
    assert.equal(await fixture.locator('.file-diff').count(), 0);
    await select(`completed-${kind}`);
    await checkpoint(`completed-${kind}-collapsed`);
    assert.equal(await fixture.locator('.file-diff').count(), 0);
    await fixture.locator('.tool-diff-toggle').click();
    await page.waitForFunction(() => window.fileUiFixture.snapshot().pending === 1);
    await checkpoint(`completed-${kind}-loading`);
    const frames = await page.evaluate(async () => {
      window.fileUiFixture.release();
      const result: number[] = [];
      const end = performance.now() + 500;
      while (performance.now() < end) {
        await new Promise(requestAnimationFrame);
        const el = document.querySelector('.tool-activity-content');
        if (el?.querySelector('.file-diff')) result.push(el.getBoundingClientRect().height);
      }
      return result;
    });
    await fixture.locator('.file-diff').waitFor();
    await checkpoint(`completed-${kind}-expanded`);
    assert.ok(frames.length > 1, JSON.stringify(frames));
    await fixture
      .getByRole('button', { name: 'desktop-reasoning-turns.test.tsx', exact: true })
      .click();
    assert.ok(
      (await page.evaluate(() => window.fileUiFixture.snapshot())).events.includes(
        'editor:src/desktop-reasoning-turns.test.tsx',
      ),
    );
    await fixture.getByRole('button', { name: '复制差异', exact: true }).click();
    assert.ok(
      (await page.evaluate(() => window.fileUiFixture.snapshot().copied)).includes('renderWait'),
    );
    await checkpoint(`completed-${kind}-copied`);
    const region = fixture.getByRole('region', { name: '文件差异', exact: true });
    await region.focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(100);
    assert.ok(await region.evaluate((e) => e.scrollTop > 0));
    await checkpoint(`completed-${kind}-vertical-scroll`);
    const horizontal = await region.evaluate((e) => {
      e.scrollLeft = e.scrollWidth;
      return { left: e.scrollLeft, width: e.scrollWidth, client: e.clientWidth };
    });
    assert.ok(horizontal.left > 0, JSON.stringify(horizontal));
    await checkpoint(`completed-${kind}-horizontal-scroll`);
    await fixture.locator('.tool-diff-toggle').click();
    await fixture.locator('.file-diff').waitFor({ state: 'detached' });
    await checkpoint(`completed-${kind}-closed`);
    const before = (await page.evaluate(() => window.fileUiFixture.snapshot())).events.filter(
      (e) => e === 'fileChanges.detail:diff',
    ).length;
    await fixture.locator('.tool-diff-toggle').click();
    await fixture.locator('.file-diff').waitFor();
    assert.equal(
      (await page.evaluate(() => window.fileUiFixture.snapshot())).events.filter(
        (e) => e === 'fileChanges.detail:diff',
      ).length,
      before,
    );
    await checkpoint(`completed-${kind}-reopened`);
    await select(`failed-${kind}`);
    await checkpoint(`failed-${kind}-collapsed`);
    const button = fixture.locator('button').first();
    await button.click();
    await fixture.getByText('synthetic operation failed', { exact: true }).waitFor();
    await checkpoint(`failed-${kind}-expanded`);
  }
  const openCount = () =>
    page.evaluate(
      () =>
        window.fileUiFixture
          .snapshot()
          .events.filter((e) => e === 'editor:src/desktop-reasoning-turns.test.tsx').length,
    );
  await select('unavailable-edit');
  await fixture.locator('.tool-diff-toggle').click();
  await fixture
    .getByText('历史记录未保存可读差异，不会从当前文件内容重建。', { exact: true })
    .waitFor();
  let count = await openCount();
  await fixture
    .getByRole('button', { name: 'desktop-reasoning-turns.test.tsx', exact: true })
    .click();
  assert.equal(await openCount(), count + 1);
  await checkpoint('preview-unavailable');
  await select('completed-edit');
  await fixture.locator('.tool-diff-toggle').click();
  await page.waitForFunction(() => window.fileUiFixture.snapshot().pending === 1);
  await page.evaluate(() => window.fileUiFixture.release(true));
  await fixture.getByRole('alert').waitFor();
  count = await openCount();
  await fixture
    .getByRole('button', { name: 'desktop-reasoning-turns.test.tsx', exact: true })
    .click();
  assert.equal(await openCount(), count + 1);
  await checkpoint('detail-read-failed');
  await fixture.getByRole('button', { name: '重新读取历史内容', exact: true }).click();
  await page.waitForFunction(() => window.fileUiFixture.snapshot().pending === 1);
  await page.evaluate(() => window.fileUiFixture.release());
  await fixture.locator('.diff-output').waitFor();
  await checkpoint('detail-read-recovered');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 750));
  await checkpoint('narrow-edit');
  assert.deepEqual(errors, []);
  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        root,
        kind: 'real Electron BrowserWindow; synthetic provider and bridge; production components and CSS',
        stages,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, root }));
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: join(root, 'failed.png') });
  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify({ passed: false, error: String(error), root, stages, errors }, null, 2),
  );
  throw error;
} finally {
  await app.close();
}
