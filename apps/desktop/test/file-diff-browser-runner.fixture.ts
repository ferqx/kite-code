import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import { copyDesktopFileIconAssets } from '../../../packages/ui/scripts/desktop-file-icon-assets';
import type {} from './file-diff-browser.fixture';

const cache = resolve(import.meta.dir, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(join(cache, 'file-diff-')),
  output = join(artifact, 'dist');
await build({
  root: resolve(import.meta.dir, '..'),
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
      entry: join(import.meta.dir, 'file-diff-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
    target: 'esnext',
  },
});
await copyDesktopFileIconAssets(output);
// Build-only validates the real component/CSS artifact where Chromium is unavailable.
if (process.argv.includes('--build-only')) {
  const css = await Bun.file(join(output, 'fixture.css')).text();
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
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const name = new URL(request.url).pathname;
    if (name === '/')
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { 'content-type': 'text/html' } },
      );
    if (name === '/favicon.ico') return new Response(null, { status: 204 });
    const path = resolve(output, `.${name}`);
    return path.startsWith(output + sep)
      ? new Response(Bun.file(path))
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
  const recheckOnFocus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const openChanges = async () => {
    await page.getByRole('button', { name: '标签页', exact: true }).click();
    await page.locator('.session-browser-tool').click();
    await pending('workspaceChanges.list');
  };
  await checkpoint('initial-lazy');
  assert.deepEqual((await page.evaluate(() => window.fileDiffFixture.snapshot())).events, []);
  const edited = operation.locator('.tool-edit-heading');
  assert.equal(await edited.locator('.tool-label').textContent(), '已编辑的文件');
  assert.equal(await edited.locator('.file-diff-counts').count(), 0);
  assert.equal(await operation.locator('.tool-diff-toggle').getAttribute('aria-expanded'), 'false');

  await operation.locator('.tool-diff-toggle').click();
  await pending('fileChanges.detail');
  const waiting = await checkpoint('operation-waiting-empty');
  assert.ok(!waiting.status.some((text) => text?.includes('正在读取本次差异')));
  await operation.locator('.tool-diff-toggle').click();
  await page.waitForFunction(() =>
    window.fileDiffFixture.snapshot().events.includes('fileChanges.close'),
  );
  await release('fileChanges.detail');
  await operation.locator('.file-diff').waitFor({ state: 'detached' });
  assert.equal(await operation.locator('.file-diff').count(), 0);
  await operation.locator('.tool-diff-toggle').click();
  await pending('fileChanges.detail');
  const motion = await operation.evaluate(async (node) => {
    window.fileDiffFixture.release('fileChanges.detail');
    const frames: number[] = [];
    const until = performance.now() + 500;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      const content = node.querySelector('.tool-activity-content');
      if (content?.querySelector('.file-diff')) frames.push(content.getBoundingClientRect().height);
    }
    return frames;
  });
  assert.ok(motion.length > 1 && motion[0]! < motion.at(-1)! * 0.45, JSON.stringify(motion));
  const card = operation.locator('.file-diff[data-layout="unified"][data-inline]');
  await card.waitFor();
  assert.ok((await operation.locator('.diff-output > *').count()) <= 400);
  assert.ok((await operation.locator('.diff-output > *').count()) > 350);
  assert.ok(
    await operation
      .locator('.file-diff-code')
      .evaluateAll((es) => es.every((e) => (e.textContent?.length ?? 0) <= 2048)),
  );
  assert.equal(await card.locator('.file-diff-path').textContent(), 'example.ts');
  assert.match((await card.locator('.file-diff-counts').textContent()) ?? '', /^\+396\s*-1$/);
  await card.getByRole('button', { name: 'example.ts', exact: true }).click();
  assert.ok(
    (await page.evaluate(() => window.fileDiffFixture.snapshot())).events.includes(
      'editor:src/example.ts',
    ),
  );
  assert.equal(await card.getByRole('group', { name: '差异布局' }).count(), 0);
  assert.equal(await card.locator('.diff-removed .file-diff-number').textContent(), '1263');
  assert.equal(await card.locator('.diff-added .file-diff-number').first().textContent(), '1263');
  await checkpoint('bounded-inline-diff');
  await card.getByRole('button', { name: '复制差异', exact: true }).click();
  await card.getByRole('button', { name: '已复制差异', exact: true }).waitFor();
  const copied = await page.evaluate(() => window.fileDiffFixture.copiedText());
  assert.ok(copied.startsWith('Line diff (bounded alignment; unchanged gaps omitted)\n1262'));
  assert.ok(
    copied.includes('1263 -const status = "old operation";\n1263 +const status = "new operation";'),
  );
  const operationRegion = operation.getByRole('region', { name: '文件差异', exact: true });
  await operationRegion.focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);
  assert.ok(await operationRegion.evaluate((e) => e.scrollTop > 0));
  await checkpoint('operation-end-scroll');
  await page.keyboard.press('Home');
  await page.waitForTimeout(100);
  assert.equal(await operationRegion.evaluate((e) => e.scrollTop), 0);
  await page.getByText('查看本次交付的文件', { exact: true }).click();
  await release('fileChanges.detail');
  await page.getByText('ORIGINAL HISTORICAL SNAPSHOT', { exact: true }).waitFor();
  assert.equal(await operation.locator('.file-diff').count(), 1);
  await checkpoint('snapshot-separate');
  const readsBeforeReopen = (
    await page.evaluate(() => window.fileDiffFixture.snapshot())
  ).events.filter((event) => event === 'fileChanges.detail:diff').length;
  for (let i = 0; i < 3; i++) {
    await operation.locator('.tool-diff-toggle').click();
    await operation.locator('.file-diff').waitFor({ state: 'detached' });
    await operation.locator('.tool-diff-toggle').click();
    await operation.locator('.file-diff').waitFor();
  }
  const reopened = await checkpoint('repeated-operation-toggles');
  assert.equal(
    reopened.events.filter((event) => event === 'fileChanges.detail:diff').length,
    readsBeforeReopen,
  );
  await operation.locator('.tool-diff-toggle').click();

  await page.evaluate(() => window.fileDiffFixture.nextOperation());
  await operation.locator('.tool-diff-toggle').click();
  await release('fileChanges.detail', true);
  await operation.getByRole('alert').waitFor();
  const failed = await checkpoint('operation-failed');
  assert.ok(!failed.status.some((text) => text?.includes('正在读取本次差异')));
  await operation.getByText('重新读取历史内容', { exact: true }).click();
  await release('fileChanges.detail');
  await operation.locator('.file-diff').waitFor();
  await operation.locator('.tool-diff-toggle').click();
  await operation.locator('.file-diff').waitFor({ state: 'detached' });

  await openChanges();
  await release('workspaceChanges.list');
  await source.waitFor();
  assert.equal(await workspace.getByRole('button', { name: '刷新变更', exact: true }).count(), 0);
  assert.equal(await workspace.getByText('范围说明', { exact: true }).count(), 0);
  assert.equal(await workspace.getByText(/不代表 Agent 的贡献/).count(), 0);
  const firstOpen = await checkpoint('changes-first-open');
  assert.ok(Math.abs(firstOpen.detailsWidth! / firstOpen.contentWidth! - 0.62) < 0.02);
  assert.equal(await detail.locator('.file-diff').count(), 0);
  const folder = workspace.getByRole('treeitem', { name: 'src/', exact: true });
  const tree = workspace.getByRole('tree');
  const lastFile = tree.getByRole('treeitem', { name: /^unknown\.kite-fixture，/ });
  assert.equal(await tree.locator('[data-change-id]').count(), 77);
  assert.equal(await workspace.getByRole('navigation', { name: '文件树分页' }).count(), 0);
  await folder.focus();
  await page.keyboard.press('End');
  assert.equal(await lastFile.evaluate((row) => row === document.activeElement), true);
  assert.ok((await tree.evaluate((element) => element.scrollTop)) > 0);
  await workspace.screenshot({ path: join(artifact, 'workspace-all-files-bottom.png') });
  await page.keyboard.press('Home');
  assert.equal(
    await tree
      .getByRole('treeitem')
      .first()
      .evaluate((row) => row === document.activeElement),
    true,
  );
  assert.ok(
    await tree.evaluate(
      (element) => element.scrollTop <= Number.parseFloat(getComputedStyle(element).paddingTop),
    ),
  );
  assert.equal((await page.evaluate(() => window.fileDiffFixture.snapshot())).pending.length, 0);
  const expectIcon = async (row: typeof folder, file: string) => {
    const icon = row.locator('[data-slot="file-tree-icon"]');
    assert.equal(await icon.getAttribute('aria-hidden'), 'true');
    await icon.evaluate(async (node, expected) => {
      const source = getComputedStyle(node).backgroundImage;
      const url = /^url\("(.*)"\)$/.exec(source)?.[1];
      if (!url || new URL(url).pathname !== `/file-tree-icons/${expected}`)
        throw new Error(`Expected ${expected}, received ${source}`);
      const image = new Image();
      image.src = url;
      await image.decode();
    }, file);
  };
  assert.equal(await workspace.getByRole('tree').getAttribute('data-slot'), 'file-tree');
  await expectIcon(folder, 'folder-src-open.svg');
  await expectIcon(
    workspace.getByRole('treeitem', { name: '.github/workflows/', exact: true }),
    'folder-gh-workflows-open.svg',
  );
  await folder.focus();
  await folder.press('Enter');
  assert.equal(await folder.getAttribute('aria-expanded'), 'false');
  await expectIcon(folder, 'folder-src.svg');
  assert.equal(await source.count(), 0);
  await folder.press('Space');
  assert.equal(await folder.getAttribute('aria-expanded'), 'true');
  assert.equal(
    await folder.evaluate((trigger) => {
      const group = document.getElementById(trigger.getAttribute('aria-owns') ?? '');
      return group?.getAttribute('role') === 'group' && !!group.querySelector('[data-change-id]');
    }),
    true,
  );
  assert.equal(await source.getAttribute('data-slot'), 'button');
  for (const [rowName, file, status] of [
    [/^src\/example\.ts，/, 'typescript.svg', 'M, M'],
    [/^src\/components\/WorkspaceFileList\.tsx，/, 'react_ts.svg', 'A, M'],
    [/^src\/styles\/workspace\.css，/, 'css.svg', 'M'],
    [/^docs\/notes\/workspace-diff-behavior\.md，/, 'markdown.svg', 'M'],
    [/^new\.txt，未跟踪$/, 'document.svg', 'U'],
    [/^Dockerfile，/, 'docker.svg', 'M'],
    [/^bun\.lock，/, 'bun.svg', 'M'],
    [/^\.gitignore，/, 'git.svg', 'M'],
    [/^\.config\/graphqlrc\.json，/, 'graphql.svg', 'M'],
    [/^notes\/roadmap\.pdf，/, 'pdf.svg', 'M'],
    [/^src\/types\.d\.ts，/, 'typescript-def.svg', 'M'],
    [/^scripts\/release\.go，/, 'go.svg', 'M'],
    [/^src\/backend\.rs，/, 'rust.svg', 'M'],
    [/^photo\.png，/, 'image.svg', 'M'],
    [/^archive\.zip，/, 'zip.svg', 'M'],
    [/^unknown\.kite-fixture，/, 'file.svg', 'M'],
  ] as const) {
    const row = workspace.getByRole('treeitem', { name: rowName });
    await expectIcon(row, file);
    assert.equal(await row.locator('.workspace-change-tree-status').textContent(), status);
  }
  await source.click();
  await pending('workspaceChanges.detail');
  await checkpoint('workspace-detail-loading');
  await newFile.click();
  await pending('workspaceChanges.detail', 2);
  await release('workspaceChanges.detail');
  assert.equal(await detail.locator('.file-diff').count(), 0);
  await release('workspaceChanges.detail');
  await detail.getByText('NEW FILE CONTENT', { exact: true }).waitFor();
  assert.equal(
    await detail.locator('.workspace-change-file-meta span').last().textContent(),
    '未跟踪',
  );
  assert.equal(await detail.locator('.file-diff').count(), 1);
  assert.equal(await detail.getByText(/CURRENT WORKSPACE ONLY/).count(), 0);
  await checkpoint('single-reader-stale-file');
  await detail.getByRole('button', { name: '统一', exact: true }).click();
  await source.click();
  await release('workspaceChanges.detail');
  await detail.locator('.file-diff[data-layout="unified"]').waitFor();
  assert.equal(
    await detail.locator('.workspace-change-file-meta span').last().textContent(),
    '已暂存修改 · 未暂存修改',
  );
  assert.equal(await detail.locator('.file-diff-sides').count(), 0);
  assert.equal(await detail.locator('.file-diff-old-number').count(), 0);
  const unifiedChange = detail.locator('.file-diff-unified-row:has(.diff-removed)').first();
  assert.equal(await unifiedChange.locator('.file-diff-number').textContent(), '16');
  assert.equal(await source.getAttribute('aria-selected'), 'true');
  assert.equal(await source.evaluate((node) => getComputedStyle(node).boxShadow), 'none');
  await workspace.getByRole('searchbox').focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await source.evaluate(
      (node) => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle === 'solid',
    ),
    true,
  );
  assert.equal(await detail.locator('.file-diff-meta').count(), 0);
  assert.equal(await detail.locator('.file-diff-hunk-separator').count(), 1);
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
  assert.equal(await detail.locator('.file-diff-meta').count(), 0);
  assert.equal(
    await detail.locator('.workspace-change-file-heading strong').textContent(),
    'example.ts',
  );
  const splitGeometry = await detail
    .locator('.file-diff-split-row')
    .last()
    .evaluate((row) => {
      const viewport = row.closest('.tool-diff-viewport')!;
      const rightHeading = row
        .closest('.file-diff')!
        .querySelector('.file-diff-sides span + span')!;
      return {
        viewWidth: viewport.clientWidth,
        contentWidth: viewport.scrollWidth,
        cellHeight: row.lastElementChild!.getBoundingClientRect().height,
        dividerGap: Math.abs(
          rightHeading.getBoundingClientRect().left -
            row.lastElementChild!.getBoundingClientRect().left,
        ),
      };
    });
  assert.ok(
    splitGeometry.contentWidth <= splitGeometry.viewWidth + 1,
    JSON.stringify(splitGeometry),
  );
  assert.ok(splitGeometry.cellHeight > 44, JSON.stringify(splitGeometry));
  assert.ok(splitGeometry.dividerGap < 1, JSON.stringify(splitGeometry));
  const search = workspace.getByRole('searchbox');
  assert.equal(await search.getAttribute('data-slot'), 'input');
  assert.equal(
    await search.evaluate((input) => getComputedStyle(input.parentElement!).borderTopWidth),
    '0px',
  );
  assert.equal(
    await detail.getByRole('group', { name: '差异布局' }).getAttribute('data-slot'),
    'button-group',
  );
  await checkpoint('workspace-split-context');
  await workspace.screenshot({ path: join(artifact, 'workspace-changes-preview.png') });

  const separator = await page.locator('#details-resize').boundingBox();
  assert.ok(separator);
  await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(separator.x + 150, separator.y + separator.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const resized = await width();
  assert.ok(Math.abs(resized - firstOpen.detailsWidth!) > 80);
  await recheckOnFocus();
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
  await page.waitForFunction(
    (previousWidth) =>
      Math.abs(
        (document.querySelector('#details')?.getBoundingClientRect().width ?? 0) - previousWidth,
      ) < 2,
    resized,
  );
  assert.ok(Math.abs((await width()) - resized) < 2);
  await checkpoint('reopen-keeps-user-width');

  await recheckOnFocus();
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
  await recheckOnFocus();
  await release('workspaceChanges.list', true);
  await workspace.getByRole('alert').waitFor();
  await checkpoint('workspace-failed');
  await page.getByRole('tab', { name: '新标签页', exact: true }).click();
  await workspace.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: '变更', exact: true }).click();
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
  await source.click();
  await release('workspaceChanges.detail');
  await detail.locator('.file-diff').waitFor();
  await page.evaluate(() => {
    document.querySelector('.kite-client')?.classList.remove('dark');
    document.querySelector('.kite-client')?.setAttribute('data-theme', 'light');
  });
  await expectIcon(workspace.getByRole('treeitem', { name: /^bun\.lock，/ }), 'bun_light.svg');
  await checkpoint('light-workspace');
  assert.equal(await page.locator('textarea.prompt-editor').inputValue(), 'Unsent original draft');
  writeFileSync(
    join(artifact, 'report.json'),
    JSON.stringify({ browser: browser.version(), passed: true, stages, motion, errors }, null, 2),
  );
} finally {
  await browser.close();
  server.stop(true);
}
