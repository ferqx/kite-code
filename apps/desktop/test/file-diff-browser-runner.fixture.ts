import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import { openFixtureFile } from '../../../scripts/tooling/files';
import { serve as serveFixture } from '../../../scripts/tooling/http';
import type {} from './file-diff-browser.fixture';

const cache = resolve(import.meta.dirname, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(join(cache, 'file-diff-')),
  output = join(artifact, 'dist');
await build({
  root: resolve(import.meta.dirname, '..'),
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
      entry: join(import.meta.dirname, 'file-diff-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
    target: 'esnext',
  },
});
// Build-only validates the real component/CSS artifact where Chromium is unavailable.
if (process.argv.includes('--build-only')) {
  const css = await (await openFixtureFile(join(output, 'fixture.css'))).text();
  assert.ok(css.includes('.file-diff-split-row'));
  assert.ok(css.includes('.workspace-change-tree'));
  assert.ok(css.includes('@container'));
  writeFileSync(
    join(artifact, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        stage: 'production-build-only',
        browserExecuted: false,
        output,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ stage: 'production-build-only', output }));
  process.exit(0);
}
const server = await serveFixture({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const name = new URL(request.url).pathname;
    if (name === '/')
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { 'content-type': 'text/html' } },
      );
    if (name === '/favicon.ico') return new Response(null, { status: 204 });
    const path = resolve(output, `.${name}`);
    return path.startsWith(output + sep)
      ? new Response(await openFixtureFile(path))
      : new Response(null, { status: 404 });
  },
});
const browser = await chromium
  .launch({
    headless: true,
    ...(existsSync(chromium.executablePath())
      ? {}
      : process.platform === 'linux' && existsSync('/usr/bin/chromium')
        ? { executablePath: '/usr/bin/chromium' }
        : { channel: 'chrome' }),
    chromiumSandbox: true,
  })
  .catch((error: unknown) => {
    writeFileSync(
      join(artifact, 'report.json'),
      JSON.stringify({ passed: false, stage: 'browser-launch', error: String(error) }, null, 2),
    );
    server.stop(true);
    throw error;
  });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, locale: 'zh-CN' });
const errors: string[] = [],
  stages: unknown[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(server.url.toString());
  await page.waitForFunction(() => !!window.fileDiffFixture);
  const pending = async (method: string, count = 1) =>
    page.waitForFunction(
      ({ method, count }) =>
        window.fileDiffFixture.snapshot().pending.filter((item) => item === method).length >= count,
      { method, count },
    );
  const release = async (method: string, fail = false) => {
    await pending(method);
    await page.evaluate(({ method, fail }) => window.fileDiffFixture.release(method, fail), {
      method,
      fail,
    });
  };
  const checkpoint = async (stage: string) => {
    await page.waitForTimeout(250);
    const snapshot = await page.evaluate(() => ({
      ...window.fileDiffFixture.snapshot(),
      readers: [...document.querySelectorAll('.file-diff')].map((reader) => ({
        scope: reader.getAttribute('data-scope'),
        layout: reader.getAttribute('data-layout'),
        rows: reader.querySelectorAll('.diff-output > *').length,
        folds: reader.querySelectorAll('.file-diff-fold').length,
      })),
      status: [...document.querySelectorAll('[role="status"],[role="alert"]')].map(
        (e) => e.textContent,
      ),
      detailsWidth: document.querySelector('#details')?.getBoundingClientRect().width,
      contentWidth: document.querySelector('#content-layout')?.getBoundingClientRect().width,
      draft: document.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')?.value,
    }));
    assert.deepEqual(errors, []);
    const file = join(artifact, `${stage}.png`);
    await page.screenshot({ path: file });
    stages.push({ stage, snapshot, file });
    console.log(JSON.stringify({ stage, snapshot, file }));
    return snapshot;
  };
  const operation = page.locator('[data-operation-fixture]');
  const workspace = page.locator('.workspace-changes');
  const detail = workspace.locator('.workspace-change-editor');
  const source = workspace.getByRole('treeitem', { name: /^src\/example\.ts，/ });
  const newFile = workspace.getByRole('treeitem', { name: /^new\.txt，/ });
  const width = () =>
    page.locator('#details').evaluate((node) => node.getBoundingClientRect().width);
  const openChanges = async () => {
    await page.getByRole('button', { name: '标签页', exact: true }).click();
    await page.locator('.session-browser-tool').click();
    await pending('workspaceChanges.list');
  };
  await checkpoint('initial-lazy');
  assert.deepEqual((await page.evaluate(() => window.fileDiffFixture.snapshot())).events, []);

  await operation.locator('.tool-diff-toggle').click();
  await pending('fileChanges.detail');
  await checkpoint('operation-loading');
  await release('fileChanges.detail');
  await operation.locator('.file-diff[data-layout="split"]').waitFor();
  assert.ok((await operation.locator('.diff-output > *').count()) <= 400);
  assert.ok((await operation.locator('.diff-output > *').count()) > 350);
  assert.ok(
    await operation
      .locator('.file-diff-code')
      .evaluateAll((es) => es.every((e) => (e.textContent?.length ?? 0) <= 2048)),
  );
  await checkpoint('bounded-split-diff');
  const operationRegion = operation.getByRole('region', { name: '文件差异', exact: true });
  await operationRegion.focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  assert.ok(await operationRegion.evaluate((e) => e.scrollTop > 0));
  await checkpoint('operation-end-scroll');
  await page.keyboard.press('Home');
  await page.waitForTimeout(100);
  assert.equal(await operationRegion.evaluate((e) => e.scrollTop), 0);
  await operation.getByRole('button', { name: '统一', exact: true }).click();
  assert.equal(await operation.locator('.diff-output > *').count(), 400);
  await checkpoint('bounded-unified-diff');
  await page.getByText('查看本次交付的文件', { exact: true }).click();
  await release('fileChanges.detail');
  await page.getByText('ORIGINAL HISTORICAL SNAPSHOT', { exact: true }).waitFor();
  assert.equal(await operation.locator('.file-diff').count(), 1);
  await checkpoint('snapshot-separate');
  for (let i = 0; i < 3; i++) {
    await operation.locator('.tool-diff-toggle').click();
    await operation.locator('.file-diff').waitFor({ state: 'detached' });
    await operation.locator('.tool-diff-toggle').click();
    await release('fileChanges.detail');
    await operation.locator('.file-diff').waitFor();
  }
  await checkpoint('repeated-operation-toggles');
  await operation.locator('.tool-diff-toggle').click();
  await operation.locator('.tool-diff-toggle').click();
  await release('fileChanges.detail', true);
  await operation.getByRole('alert').waitFor();
  await checkpoint('operation-failed');
  await operation.getByText('重新读取历史内容', { exact: true }).click();
  await release('fileChanges.detail');
  await operation.locator('.file-diff').waitFor();
  await operation.locator('.tool-diff-toggle').click();

  await openChanges();
  await release('workspaceChanges.list');
  await source.waitFor();
  const firstOpen = await checkpoint('changes-first-open');
  assert.ok(Math.abs(firstOpen.detailsWidth! / firstOpen.contentWidth! - 0.62) < 0.02);
  assert.equal(await detail.locator('.file-diff').count(), 0);
  await workspace.getByRole('treeitem', { name: 'src/', exact: true }).click();
  assert.equal(await source.count(), 0);
  await workspace.getByRole('treeitem', { name: 'src/', exact: true }).click();
  await source.click();
  await pending('workspaceChanges.detail');
  await checkpoint('workspace-detail-loading');
  await newFile.click();
  await pending('workspaceChanges.detail', 2);
  await release('workspaceChanges.detail');
  assert.equal(await detail.locator('.file-diff').count(), 0);
  await release('workspaceChanges.detail');
  await detail.getByText('NEW FILE CONTENT', { exact: true }).waitFor();
  assert.equal(await detail.locator('.file-diff').count(), 1);
  assert.equal(await detail.getByText(/CURRENT WORKSPACE ONLY/).count(), 0);
  await checkpoint('single-reader-stale-file');
  await detail.getByRole('button', { name: '统一', exact: true }).click();
  await source.click();
  await release('workspaceChanges.detail');
  await detail.locator('.file-diff[data-layout="unified"]').waitFor();
  const foldedRows = await detail.locator('.diff-output > *').count();
  assert.ok((await detail.locator('.file-diff-fold').count()) > 0);
  const beforeFold = (await page.evaluate(() => window.fileDiffFixture.snapshot())).events.length;
  await detail.locator('.file-diff-fold').first().click();
  assert.ok((await detail.locator('.diff-output > *').count()) > foldedRows);
  assert.equal(
    (await page.evaluate(() => window.fileDiffFixture.snapshot())).events.length,
    beforeFold,
  );
  await checkpoint('retained-context-expanded');
  await detail.getByRole('button', { name: '折叠未变更行', exact: true }).click();
  assert.equal(await detail.locator('.diff-output > *').count(), foldedRows);
  await detail.getByRole('button', { name: '双栏', exact: true }).click();
  await checkpoint('workspace-split-context');

  const separator = await page.locator('#details-resize').boundingBox();
  assert.ok(separator);
  await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(separator.x + 150, separator.y + separator.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const resized = await width();
  assert.ok(Math.abs(resized - firstOpen.detailsWidth!) > 80);
  await workspace.getByRole('button', { name: '刷新变更', exact: true }).click();
  await release('workspaceChanges.list');
  await release('workspaceChanges.detail');
  await detail.locator('.file-diff[data-layout="split"]').waitFor();
  assert.ok(Math.abs((await width()) - resized) < 2);
  await checkpoint('refresh-keeps-user-width');
  await workspace.getByRole('searchbox', { name: '筛选文件', exact: true }).fill('new.txt');
  assert.equal(await detail.locator('.file-diff').count(), 0);
  assert.equal(await source.count(), 0);
  await workspace.getByRole('searchbox', { name: '筛选文件', exact: true }).fill('');
  await source.click();
  await pending('workspaceChanges.detail');
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await release('workspaceChanges.detail');
  await workspace.waitFor({ state: 'detached' });
  await checkpoint('close-late-response');
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await release('workspaceChanges.list');
  await source.waitFor();
  assert.ok(Math.abs((await width()) - resized) < 2);
  await checkpoint('reopen-keeps-user-width');

  await workspace.getByRole('button', { name: '刷新变更', exact: true }).click();
  await pending('workspaceChanges.list');
  await page.evaluate(() => window.fileDiffFixture.switchSession());
  await openChanges();
  await pending('workspaceChanges.list', 2);
  await release('workspaceChanges.list');
  assert.equal(await workspace.getByRole('treeitem').count(), 0);
  await checkpoint('session-switch-old-response');
  await release('workspaceChanges.list');
  await source.click();
  await release('workspaceChanges.detail');
  await detail.locator('.file-diff').waitFor();
  await checkpoint('workspace-current');
  await workspace.getByRole('button', { name: '刷新变更', exact: true }).click();
  await release('workspaceChanges.list', true);
  await workspace.getByRole('alert').waitFor();
  await checkpoint('workspace-failed');
  await workspace.getByRole('button', { name: '刷新变更', exact: true }).click();
  await release('workspaceChanges.list');
  await source.waitFor();
  if (
    (await page.evaluate(() => window.fileDiffFixture.snapshot())).pending.includes(
      'workspaceChanges.detail',
    )
  )
    await release('workspaceChanges.detail');
  await checkpoint('workspace-recovered');
  await page.setViewportSize({ width: 1100, height: 800 });
  await checkpoint('narrow-workspace');
  await workspace.getByRole('searchbox', { name: '筛选文件', exact: true }).fill('missing');
  await workspace.getByText('没有匹配的变更文件', { exact: true }).waitFor();
  await workspace.getByRole('searchbox', { name: '筛选文件', exact: true }).fill('');
  await page.evaluate(() => {
    document.querySelector('.kite-client')?.classList.remove('dark');
    document.querySelector('.kite-client')?.setAttribute('data-theme', 'light');
  });
  await checkpoint('light-workspace');
  assert.equal(await page.locator('textarea.prompt-editor').inputValue(), 'Unsent original draft');
  writeFileSync(
    join(artifact, 'report.json'),
    JSON.stringify({ browser: browser.version(), passed: true, stages, errors }, null, 2),
  );
} finally {
  await browser.close();
  server.stop(true);
}
