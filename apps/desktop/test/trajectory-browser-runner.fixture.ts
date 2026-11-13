import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Page } from 'playwright';
import { build } from 'vite';
import { openFixtureFile, writeFixtureFile } from '../../../scripts/tooling/files';
import { serve as serveFixture } from '../../../scripts/tooling/http';
import { verifyTrajectoryDetailLayout } from './trajectory-detail-layout-browser.fixture';
import { verifyTrajectoryInputContext } from './trajectory-input-context-browser.fixture';
import { verifyTrajectoryOutputState } from './trajectory-output-state-browser.fixture';
import { verifySemanticTrajectory } from './trajectory-semantic-browser.fixture';
import { verifyTrajectoryToolCatalog } from './trajectory-tool-catalog-browser.fixture';

const directory = import.meta.dirname;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'trajectory-browser-'));
const output = path.join(artifact, 'dist');
const reuseArgument = process.argv.find((value) => value.startsWith('--reuse-url='));
const reusedUrl = reuseArgument ? new URL(reuseArgument.slice('--reuse-url='.length)) : null;
if (reusedUrl && (reusedUrl.hostname !== '127.0.0.1' || reusedUrl.protocol !== 'http:'))
  throw Error('fixture_reuse_requires_local_preview');
if (!reusedUrl)
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
        entry: path.join(
          directory,
          process.argv.includes('--settings')
            ? 'trace-settings-browser.fixture.tsx'
            : process.argv.includes('--offline')
              ? 'trajectory-offline-browser.fixture.tsx'
              : 'trajectory-browser.fixture.tsx',
        ),
        formats: ['es'],
        fileName: 'fixture',
        cssFileName: 'fixture',
      },
      target: 'esnext',
    },
  });
const server = reusedUrl
  ? { url: reusedUrl, stop(_force?: boolean) {} }
  : await serveFixture({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
        if (pathname === '/')
          return new Response(
            '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><script type="module" src="/fixture.js"></script></body></html>',
            { headers: { 'content-type': 'text/html' } },
          );
        const file = path.resolve(output, `.${pathname}`);
        if (!file.startsWith(output + path.sep)) return new Response(null, { status: 404 });
        return new Response(await openFixtureFile(file));
      },
    });
console.log(JSON.stringify({ url: server.url.href, artifact, reusedAssets: reusedUrl !== null }));
const verification: Record<string, unknown> = {};
async function openTrajectory(page: Page, suffix = '?workbench=1') {
  await page.goto(new URL(suffix, server.url).href);
  await page.getByRole('button', { name: '标签页', exact: true }).click();
  await page
    .getByRole('region', { name: '工具', exact: true })
    .getByRole('button', { name: '执行轨迹', exact: true })
    .click();
  await page.locator('.trajectory-panel [role="treegrid"]').waitFor();
}
async function bounds(page: Page, label: string) {
  const value = await page.evaluate(() => ({
    height: innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    regions: [
      '.trajectory-panel',
      '.trajectory-workspace',
      '[aria-label="轨迹事件树"]',
      '.trajectory-detail',
    ].flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element?.getClientRects().length) return [];
      const rect = element.getBoundingClientRect();
      return [{ selector, top: rect.top, bottom: rect.bottom, height: rect.height }];
    }),
  }));
  assert.ok(
    value.scrollHeight <= value.height + 1,
    `${label}: document height ${value.scrollHeight} exceeds ${value.height}`,
  );
  for (const region of value.regions) {
    assert.ok(region.height > 0, `${label}: ${region.selector} has no height`);
    assert.ok(region.bottom <= value.height + 1, `${label}: ${region.selector} overflows viewport`);
  }
  verification[label] = value;
}
async function settledGeometry(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return page.evaluate(() => {
    const read = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector)!;
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      };
    };
    return {
      panel: read('.trajectory-panel'),
      header: read('.trajectory-toolbar'),
      timeline: read('.trajectory-timeline'),
      viewport: read('[aria-label="轨迹事件树"]'),
    };
  });
}
async function transparentRowButton(page: Page, selector: string, name: string) {
  const button = page.locator(selector);
  await button.hover();
  await page.waitForTimeout(180);
  for (const active of [false, true]) {
    if (active) {
      await page.mouse.down();
      await page.waitForTimeout(60);
    }
    const style = await button.evaluate((element) => {
      const color = getComputedStyle(element).backgroundColor,
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return { color, alpha: context.getImageData(0, 0, 1, 1).data[3] };
    });
    if (active) {
      await page.mouse.move(400, 90);
      await page.mouse.up();
    }
    assert.equal(style.alpha, 0, `${name} ${active ? 'active' : 'hover'} adds a second background`);
  }
}
async function verifyWorkbench(page: Page) {
  const node = (id: string) =>
    page.locator(`[data-trajectory-row="${id}"] .trajectory-node-select`);
  const detail = page.getByRole('region', { name: '选中节点详情', exact: true });
  await openTrajectory(page);
  assert.equal(await detail.count(), 0);
  assert.equal(await page.locator('.trajectory-lifecycle').count(), 0);
  assert.equal(await page.getByRole('tab', { name: '生命周期', exact: true }).count(), 0);
  assert.equal(
    await page
      .locator('[data-trajectory-row="execution:structure-tool"]')
      .getAttribute('data-trajectory-parent'),
    'run:run-a',
  );
  assert.equal(
    await page
      .locator('[data-trajectory-row="interaction:structure-approval"]')
      .getAttribute('data-trajectory-parent'),
    'run:run-a',
  );
  await page.getByRole('button', { name: '筛选轨迹', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('.trajectory-panel').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('menu').count(), 0);
  await bounds(page, 'initial');
  const initialFacts = await page.evaluate(() =>
    JSON.stringify(
      (window as unknown as { trajectoryFixture: { facts: unknown[] } }).trajectoryFixture.facts,
    ),
  );
  const initialBodyOpens = await page.evaluate(() =>
    (
      window as unknown as {
        trajectoryFixture: { requests: { method: string; request: { evidenceId?: string } }[] };
      }
    ).trajectoryFixture.requests
      .filter((request) => request.method === 'trajectory.evidence.open')
      .map((request) => request.request.evidenceId),
  );
  assert.ok(
    initialBodyOpens.length <= 8,
    'only four visible Agent loops may request their own public input/output',
  );
  assert.ok(
    initialBodyOpens.every((id) => id === 'structure-input' || id === 'structure-model-output'),
    'opening the tree must not pre-read tool, message or approval bodies',
  );
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.getByLabel('轨迹事件树', { exact: true }).evaluate((element) => {
    element.scrollTop = Math.min(38, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await transparentRowButton(
    page,
    '[data-trajectory-row="execution:structure-tool"] .trajectory-node-select',
    'row',
  );
  await transparentRowButton(
    page,
    '[data-trajectory-row="run:run-a"] .trajectory-node-collapse',
    'collapse',
  );
  await page.getByLabel('轨迹事件树', { exact: true }).evaluate((element) => {
    element.scrollTop = 38;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const narrowBefore = await settledGeometry(page);
  assert.ok(
    narrowBefore.viewport.scrollTop > 0,
    'narrow regression must have an internal scrollbar',
  );
  await node('execution:structure-tool').click();
  await detail.waitFor();
  const narrowOpened = await settledGeometry(page);
  for (const key of ['panel', 'header', 'timeline'] as const) {
    assert.ok(
      Math.abs(narrowOpened[key].x - narrowBefore[key].x) <= 1,
      `${key} moves when the drawer opens`,
    );
    assert.ok(
      Math.abs(narrowOpened[key].width - narrowBefore[key].width) <= 1,
      `${key} changes width when the drawer opens`,
    );
  }
  assert.equal(narrowOpened.panel.scrollLeft, narrowBefore.panel.scrollLeft);
  assert.equal(narrowOpened.viewport.scrollTop, narrowBefore.viewport.scrollTop);
  verification.narrowDrawerGeometry = { before: narrowBefore, opened: narrowOpened };

  assert.deepEqual(await detail.getByRole('tab').allTextContents(), ['概述', '参数', '结果']);
  await page.getByRole('dialog').waitFor();
  const borderCases = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    const border = await page.getByRole('dialog').evaluate((element) => {
      const style = getComputedStyle(element),
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const normalize = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      return {
        leftWidth: style.borderLeftWidth,
        leftColor: normalize(style.borderLeftColor),
        themedColor: normalize(style.getPropertyValue('--border')),
        otherWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth],
        outline: style.outlineStyle,
        shadow: style.boxShadow,
      };
    });
    assert.equal(border.leftWidth, '1px');
    assert.deepEqual(border.leftColor, border.themedColor);
    assert.deepEqual(border.otherWidths, ['0px', '0px', '0px']);
    borderCases.push({ theme, ...border });
  }
  verification.drawerBorders = borderCases;
  const drawer = await page.getByRole('dialog').boundingBox(),
    panel = await page.locator('.trajectory-panel').boundingBox();
  assert.ok(
    drawer &&
      panel &&
      Math.abs(drawer.y - panel.y) <= 1 &&
      Math.abs(drawer.height - panel.height) <= 1,
    'narrow drawer must cover the full trajectory tab content',
  );
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await detail.getByLabel('原公开 JSON', { exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="原公开 JSON"]')?.textContent?.includes('README.md'),
  );
  const parameters = JSON.parse(
    await detail.getByLabel('原公开 JSON', { exact: true }).innerText(),
  );
  assert.deepEqual(parameters, { path: 'README.md', offset: 0, limit: 200 });
  await page.waitForFunction(() => {
    const active = document.querySelector('.trajectory-detail [role="tab"][data-state="active"]');
    if (!active) return false;
    const style = getComputedStyle(active);
    return style.color === style.borderBottomColor && style.borderBottomWidth === '2px';
  });
  const tabStyles = await detail.evaluate((element) => {
    const active = getComputedStyle(element.querySelector('[role="tab"][data-state="active"]')!);
    const inactive = getComputedStyle(
      element.querySelector('[role="tab"][data-state="inactive"]')!,
    );
    return {
      active: active.color,
      inactive: inactive.color,
      underline: active.borderBottomWidth,
      underlineColor: active.borderBottomColor,
    };
  });
  assert.notEqual(tabStyles.active, tabStyles.inactive);
  assert.equal(tabStyles.underline, '2px');
  assert.notEqual(tabStyles.underlineColor, 'rgba(0, 0, 0, 0)');
  verification.tabStyles = tabStyles;
  await bounds(page, 'drawer-parameters');
  await page.screenshot({ path: path.join(artifact, 'drawer-parameters.png') });
  await detail.getByRole('tab', { name: '结果', exact: true }).click();
  await detail.getByText('测试结果：12 项通过。', { exact: false }).waitFor();
  assert.ok((await detail.innerText()).includes('README.md'));
  assert.equal(await detail.getByRole('tab', { name: '原始内容', exact: true }).count(), 0);
  const savedToolEvidence = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trajectoryFixture: {
          facts: {
            executionId?: string;
            evidenceRefs: { kind: string; evidenceId: string; contentVersion: string }[];
          }[];
          requests: { method: string; request: { evidenceId?: string; contentVersion?: string } }[];
        };
      }
    ).trajectoryFixture;
    const references = fixture.facts
      .filter((event) => event.executionId === 'structure-tool')
      .flatMap((event) => event.evidenceRefs);
    return {
      input: references.some(
        (ref) => ref.kind === 'tool_input' && ref.evidenceId === 'structure-tool-input',
      ),
      result: references.some(
        (ref) => ref.kind === 'tool_result' && ref.evidenceId === 'structure-tool-result',
      ),
      openedOriginalResult: fixture.requests.some(
        (value) =>
          value.method === 'trajectory.evidence.open' &&
          value.request.evidenceId === 'structure-tool-result' &&
          value.request.contentVersion === 'structure-tool-result-v1',
      ),
    };
  });
  assert.deepEqual(savedToolEvidence, { input: true, result: true, openedOriginalResult: true });
  assert.equal(await detail.locator('[aria-label="材料版本"]').count(), 0);
  await page.screenshot({ path: path.join(artifact, 'drawer-result.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const active = document.activeElement as HTMLElement | null;
    return (
      active?.dataset.nodeId === 'execution:structure-tool' &&
      !active.closest('[aria-hidden="true"]')
    );
  });
  await page.locator('.trajectory-panel').waitFor({ state: 'visible' });
  const narrowClosed = await settledGeometry(page);
  assert.equal(narrowClosed.panel.scrollLeft, narrowBefore.panel.scrollLeft);
  assert.equal(narrowClosed.viewport.scrollTop, narrowBefore.viewport.scrollTop);
  await transparentRowButton(
    page,
    '[data-trajectory-row="execution:structure-tool"] .trajectory-node-select',
    'selected row',
  );
  verification.escapeClosedDrawer = {
    returnedTo: 'execution:structure-tool',
    sidebarRetained: true,
    hiddenAncestor: false,
  };

  await node('run:run-a').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    () =>
      (document.activeElement as HTMLElement | null)?.dataset.nodeId ===
      'execution:structure-model:part:system',
  );
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    () =>
      (document.activeElement as HTMLElement | null)?.dataset.nodeId ===
      'execution:structure-model:part:thinking',
  );
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    () =>
      (document.activeElement as HTMLElement | null)?.dataset.nodeId === 'execution:structure-tool',
  );
  await page.locator('[data-trajectory-row="run:run-a"] button[aria-label^="折叠"]').click();
  assert.equal(await node('execution:structure-tool').count(), 0);
  await page.locator('[data-trajectory-row="run:run-a"] button[aria-label^="展开"]').click();
  const outer = page.locator('#details-resize[role="separator"]');
  const outerRect = await outer.boundingBox();
  assert.ok(outerRect);
  await page.mouse.move(
    outerRect.x + outerRect.width / 2,
    outerRect.y + Math.min(150, outerRect.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(260, outerRect.y + Math.min(150, outerRect.height / 2), { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector('.trajectory-workspace')?.getAttribute('data-detail-layout') ===
      'docked',
  );
  await node('execution:structure-tool').click();
  await detail.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  const paneRect = await page.locator('.trajectory-workspace').boundingBox(),
    detailRect = await detail.boundingBox();
  assert.ok(paneRect && detailRect);
  assert.ok(
    detailRect.width / paneRect.width > 0.35 && detailRect.width / paneRect.width < 0.45,
    'initial docked detail width is 40%',
  );
  const separator = page.getByRole('separator', { name: '调整轨迹详情宽度', exact: true }),
    separatorRect = await separator.boundingBox();
  assert.ok(separatorRect);
  await page.mouse.move(separatorRect.x + separatorRect.width / 2, separatorRect.y + 100);
  await page.mouse.down();
  await page.mouse.move(separatorRect.x - 60, separatorRect.y + 100, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const rect = document.querySelector('.trajectory-detail')?.getBoundingClientRect();
    return rect && rect.width > previous + 30;
  }, detailRect.width);
  const resized = await detail.boundingBox();
  verification.innerResize = { before: detailRect.width, after: resized?.width };
  await bounds(page, 'docked');
  await page.screenshot({ path: path.join(artifact, 'docked.png') });
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.getByRole('button', { name: '筛选轨迹', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '全部轮次', exact: true }).click();
  await page.getByText('没有匹配记录。调整筛选或清除条件后查看。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '筛选轨迹', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '仅子调用', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '移除执行轮次筛选', exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole('button', { name: '移除子调用筛选', exact: true }).count(), 1);
  await page.getByRole('button', { name: '移除执行轮次筛选', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '移除子调用筛选', exact: true }).count(), 1);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await node('execution:workbench-compress').click();
  await detail.getByRole('tab', { name: '概述', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.trajectory-detail')?.textContent?.includes('12200 Token'),
  );
  assert.ok((await detail.innerText()).includes('2600 Token'));
  assert.ok((await detail.innerText()).includes('压缩已采用'));
  await detail.getByRole('tab', { name: '预览', exact: true }).click();
  await detail.getByRole('heading', { name: '已采用的压缩摘要', exact: true }).waitFor();
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await node('message:workbench-reply').click();
  await detail.getByRole('tab', { name: '内容', exact: true }).click();
  await detail.getByText('文件已读取，测试结果通过。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-trajectory-row="message:workbench-reply"]').count(), 1);
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.getByRole('button', { name: '更多轨迹操作', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '显示回放控制', exact: true }).click();
  const cursor = page.getByRole('textbox', { name: '轨迹位置', exact: true });
  const beforeAppend = await cursor.inputValue();
  await page.getByRole('button', { name: 'Fixture: 流式追加', exact: true }).click();
  await page.getByText('有新的执行记录，当前阅读位置保持不变。', { exact: true }).waitFor();
  assert.equal(await cursor.inputValue(), beforeAppend);
  assert.equal(
    await page.evaluate(
      (length) =>
        JSON.stringify(
          (
            window as unknown as { trajectoryFixture: { facts: unknown[] } }
          ).trajectoryFixture.facts.slice(0, length),
        ),
      JSON.parse(initialFacts).length,
    ),
    initialFacts,
  );
  assert.equal(await node('message:workbench-reply').getAttribute('aria-pressed'), 'true');
  await page
    .locator('.trajectory-new-records')
    .getByRole('button', { name: '返回最新', exact: true })
    .click();
  await page.locator('.trajectory-new-records').waitFor({ state: 'hidden' });
  await page.waitForFunction((prior) => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]');
    return input && BigInt(input.value) > BigInt(prior);
  }, beforeAppend);
  await page.setViewportSize({ width: 900, height: 700 });
  await node('execution:structure-tool').click();
  await page.getByRole('dialog').waitFor();
  await bounds(page, 'compact');
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.waitForFunction(
    () =>
      (document.activeElement as HTMLElement | null)?.dataset.nodeId === 'execution:structure-tool',
  );
  await page.setViewportSize({ width: 1440, height: 700 });
  await outer.focus();
  for (let attempt = 0; attempt < 20; attempt++) {
    const width = (await page.locator('.trajectory-panel').boundingBox())!.width;
    if (width <= 330) break;
    await outer.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(40);
  }
  const narrowWidth = (await page.locator('.trajectory-panel').boundingBox())!.width;
  assert.ok(narrowWidth >= 299 && narrowWidth <= 330, `narrow sidebar width ${narrowWidth}`);
  verification.narrowPaneWidth = narrowWidth;
  await node('execution:structure-tool').click();
  await page.getByRole('dialog').waitFor();
  await detail.getByRole('tab', { name: '参数', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="原公开 JSON"]')?.textContent?.includes('README.md'),
  );
  await bounds(page, 'pane-320');
  await page.screenshot({ path: path.join(artifact, 'pane-320.png') });
  await page
    .locator('.trajectory-panel')
    .screenshot({ path: path.join(artifact, 'prototype-drawer.png'), animations: 'disabled' });
  verification.narrowScope =
    '300–330px right sidebar in a 1440px desktop viewport; actual width is recorded separately. The desktop shell collapses its sidebar at a 320px whole-window viewport';
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.waitForFunction(
    () =>
      (document.activeElement as HTMLElement | null)?.dataset.nodeId === 'execution:structure-tool',
  );
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.waitForTimeout(120);
  for (let attempt = 0; attempt < 3; attempt++) {
    const width = (await page.locator('.trajectory-panel').boundingBox())!.width;
    if (Math.abs(width - 1024) < 3) break;
    const handle = (await outer.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - (1024 - width), handle.y + 100, {
      steps: 15,
    });
    await page.mouse.up();
    await page.waitForTimeout(100);
  }
  const visualWidth = (await page.locator('.trajectory-panel').boundingBox())!.width;
  assert.ok(
    visualWidth >= 990 && visualWidth <= 1040,
    `prototype comparison panel width ${visualWidth}`,
  );
  await page.getByRole('button', { name: '更多轨迹操作', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '显示回放控制', exact: true }).click();
  await node('execution:structure-model:part:thinking').click();
  await detail.getByRole('tab', { name: '思考', exact: true }).click();
  const capturePanel = (await page.locator('.trajectory-workspace').boundingBox())!,
    captureDetail = (await detail.boundingBox())!,
    captureHandle = (await separator.boundingBox())!;
  const targetDetailWidth = capturePanel.width * 0.4;
  await page.mouse.move(captureHandle.x + captureHandle.width / 2, captureHandle.y + 100);
  await page.mouse.down();
  await page.mouse.move(
    captureHandle.x + captureHandle.width / 2 + (captureDetail.width - targetDetailWidth),
    captureHandle.y + 100,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForFunction(() => {
    const pane = document.querySelector('.trajectory-workspace')!.getBoundingClientRect(),
      detail = document.querySelector('.trajectory-detail')!.getBoundingClientRect();
    return Math.abs(detail.width / pane.width - 0.4) < 0.01;
  });
  verification.prototypeComparison = {
    width: visualWidth,
    viewport: { width: 1800, height: 1000 },
    croppedToPanel: true,
  };
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.locator('.trajectory-panel').screenshot({
      path: path.join(artifact, `prototype-${theme}-wide.png`),
      animations: 'disabled',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openTrajectory(page, '');
  assert.equal(
    await page.evaluate(
      () =>
        (
          window as unknown as { trajectoryFixture: { facts: { executionId?: string }[] } }
        ).trajectoryFixture.facts.filter(
          (event) => event.executionId?.startsWith('model-') && event.executionId !== 'model-b',
        ).length,
    ),
    425,
  );
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        trajectoryFixture: { append(session: string, phase: string, execution: string): void };
      }
    ).trajectoryFixture;
    for (let index = 0; index < 200; index++)
      fixture.append('a', 'completed', `virtual-extra-${index}`);
  });
  await page.getByText('有新的执行记录，当前阅读位置保持不变。', { exact: true }).waitFor();
  await page
    .locator('.trajectory-new-records')
    .getByRole('button', { name: '返回最新', exact: true })
    .click();
  await page.locator('.trajectory-new-records').waitFor({ state: 'hidden' });
  const viewport = page.getByLabel('轨迹事件树', { exact: true });
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction(() =>
    document.querySelector('[data-trajectory-row="execution:virtual-extra-199:part:thinking"]'),
  );
  assert.ok(
    (await page.locator('[data-trajectory-row]').count()) < 80,
    'more than 300 distinct business rows remain virtualized',
  );
  assert.ok(Number(await page.getByRole('treegrid').getAttribute('aria-rowcount')) > 300);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.waitForTimeout(150);
  const longBefore = (await page.locator('.trajectory-panel').boundingBox())!.width,
    longHandle = (await outer.boundingBox())!;
  await page.mouse.move(longHandle.x + longHandle.width / 2, longHandle.y + 100);
  await page.mouse.down();
  await page.mouse.move(
    longHandle.x + longHandle.width / 2 - (1000 - longBefore),
    longHandle.y + 100,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector('.trajectory-workspace')?.getAttribute('data-detail-layout') ===
      'docked',
  );
  await viewport.evaluate((element) => {
    element.scrollTop = 5000;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!,
      bounds = viewport.getBoundingClientRect();
    return [...viewport.querySelectorAll<HTMLElement>('[data-trajectory-row]')].some((element) => {
      const row = element.getBoundingClientRect();
      return row.top >= bounds.top && row.bottom <= bounds.bottom;
    });
  });
  const anchor = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!,
      rect = viewport.getBoundingClientRect();
    const visible = [...viewport.querySelectorAll<HTMLElement>('[data-trajectory-row]')].filter(
      (el) => {
        const row = el.getBoundingClientRect();
        return row.top >= rect.top && row.bottom <= rect.bottom;
      },
    );
    return {
      id: visible[Math.floor(visible.length / 2)]!.dataset.trajectoryRow!,
      top: viewport.scrollTop,
    };
  });
  await node(anchor.id).click();
  await detail.waitFor();
  assert.equal(
    (await settledGeometry(page)).viewport.scrollTop,
    anchor.top,
    'opening docked details loses the long-list reading position',
  );
  await detail.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.waitForFunction(
    (id) => (document.activeElement as HTMLElement | null)?.dataset.nodeId === id,
    anchor.id,
  );
  assert.equal(
    (await settledGeometry(page)).viewport.scrollTop,
    anchor.top,
    'closing docked details loses the long-list reading position',
  );
  verification.longHistoryAnchor = anchor;
  await bounds(page, 'long-history');
  verification.originalWorkbenchFacts = JSON.parse(initialFacts).length;
  await writeFixtureFile(
    path.join(artifact, 'verification.json'),
    JSON.stringify(verification, null, 2),
  );
}
if (process.argv.includes('--verify')) {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  const browserWarnings: { source: string; level: string; text: string }[] = [];
  verification.browserWarnings = browserWarnings;
  const recordWarning = (source: string, level: string, text: string) => {
    browserWarnings.push({ source, level, text });
    if (/Blocked aria-hidden|aria-hidden.*focus/i.test(text)) errors.push(text);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  const diagnostics = await page.context().newCDPSession(page);
  diagnostics.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'warning' || entry.level === 'error')
      recordWarning(`browser:${entry.source}`, entry.level, entry.text);
  });
  await diagnostics.send('Log.enable');
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error')
      recordWarning('console', message.type(), message.text());
  });
  try {
    if (process.argv.includes('--detail-layout')) {
      await verifyTrajectoryDetailLayout({ page, artifact, verification, openTrajectory });
    } else if (process.argv.includes('--output-state')) {
      await verifyTrajectoryOutputState({ page, artifact, verification, baseUrl: server.url.href });
    } else if (process.argv.includes('--input-context')) {
      await verifyTrajectoryInputContext({
        page,
        artifact,
        verification,
        baseUrl: server.url.href,
      });
    } else if (process.argv.includes('--tool-catalog')) {
      await verifyTrajectoryToolCatalog({ page, artifact, verification, openTrajectory });
    } else if (process.argv.includes('--semantic')) {
      await verifySemanticTrajectory({
        page,
        artifact,
        verification,
        openTrajectory,
        bounds,
        settledGeometry,
        transparentRowButton,
      });
    } else if (!process.argv.includes('--settings') && !process.argv.includes('--offline')) {
      await verifyWorkbench(page);
    } else {
      await page.goto(server.url.href);
      await page.getByRole('button', { name: '执行轨迹', exact: true }).click();
      await page.locator('[data-trajectory-node="session"]').waitFor();
      const panel = page.locator('.trajectory-panel');
      assert.equal(await panel.getByRole('tab').count(), 0);
      assert.equal(await panel.getByRole('region', { name: '选中节点详情' }).count(), 0);
      assert.equal(
        await panel
          .locator('.trajectory-detail, .trajectory-lifecycle, .trajectory-evidence')
          .count(),
        0,
      );
      assert.equal(await page.getByRole('textbox', { name: '轨迹位置' }).count(), 0);
      await page.screenshot({ path: path.join(artifact, 'initial.png') });
    }
    console.log(
      JSON.stringify({
        browser: browser.version(),
        errors,
        nodes: await page.locator('[data-trajectory-node]').count(),
        text: (await page.locator('.trajectory-panel').allInnerTexts()).join('\n').slice(0, 12000),
      }),
    );
    if (errors.length) throw Error('trajectory_browser_errors');
  } catch (cause) {
    await writeFixtureFile(
      path.join(artifact, 'failure.json'),
      JSON.stringify(
        { failure: cause instanceof Error ? cause.message : String(cause), errors, verification },
        null,
        2,
      ),
    );
    await page.screenshot({ path: path.join(artifact, 'failure.png') });
    console.error(
      JSON.stringify({
        failure: cause instanceof Error ? cause.message : String(cause),
        errors,
        text: (await page.locator('.trajectory-panel').allInnerTexts()).join('\n').slice(0, 12000),
        requests: await page.evaluate(() =>
          (
            window as unknown as { trajectoryFixture?: { requests: unknown[] } }
          ).trajectoryFixture?.requests.slice(-12),
        ),
      }),
    );
    if (process.argv.includes('--serve')) process.exitCode = 1;
    else throw cause;
  } finally {
    await browser.close();
  }
}
if (!process.argv.includes('--serve')) server.stop(true);
