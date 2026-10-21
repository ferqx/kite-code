import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import type {} from './image-previews-browser.fixture';

const cache = path.resolve(import.meta.dir, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'image-previews-browser-'));
const output = path.join(artifact, 'dist');
await build({
  root: path.resolve(import.meta.dir, '..'),
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
      entry: path.join(import.meta.dir, 'image-previews-browser.fixture.tsx'),
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
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = path.resolve(output, `.${pathname}`);
    if (!file.startsWith(output + path.sep)) return new Response(null, { status: 404 });
    return new Response(Bun.file(file));
  },
});
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });
const report = { browser: browser.version(), cases: [] as unknown[] };
try {
  for (const throttle of [1, 4]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => !!window.imagePreviewFixture);
    const bytes = await page.evaluate(() => window.imagePreviewFixture.generate());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.evaluate(() => {
      void window.imagePreviewFixture.add();
    });
    await page.waitForFunction(() => window.imagePreviewFixture.snapshot().conversions > 0);
    await page.getByRole('textbox', { name: '任务输入' }).fill('转换期间仍然能输入');
    const inputDuringConversion = await page.evaluate(
      () => window.imagePreviewFixture.snapshot().measuring,
    );
    await page.waitForFunction(() => {
      const snapshot = window.imagePreviewFixture.snapshot();
      return (
        !snapshot.measuring &&
        snapshot.previews.length === 10 &&
        snapshot.previews.every((image) => image.decoded && image.width > 0)
      );
    });
    const cold = await page.evaluate(() => window.imagePreviewFixture.snapshot());
    assert.equal(cold.conversions, 10);
    assert.equal(
      inputDuringConversion,
      true,
      'input did not finish until all conversions were already done',
    );
    assert.equal(cold.peakConversions, 1);
    assert.equal(cold.originalMatches, 10);
    assert.equal(cold.originalBytes, bytes);
    assert.ok(cold.previews.every((image) => image.width === 512 && image.height === 384));
    assert.deepEqual(cold.errors, []);
    assert.equal(
      await page.getByRole('textbox', { name: '任务输入' }).textContent(),
      '转换期间仍然能输入',
    );
    await page.evaluate(() => window.imagePreviewFixture.select('a'));
    await page.waitForSelector('.native-user-image img');
    const bar = page.locator('.native-user-images');
    // Exercise both ends of a horizontally clipped attachment row.
    for (let index = 0; index < 4; index++) {
      await bar.evaluate((element, index) => {
        element.scrollLeft = index % 2 ? 0 : element.scrollWidth;
      }, index);
      await page.waitForTimeout(120);
    }
    for (let index = 0; index < 30; index++) {
      await page.evaluate(() => {
        window.imagePreviewFixture.select('b');
      });
      await page.evaluate(() => {
        window.imagePreviewFixture.select('a');
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    for (let index = 0; index < 30; index++)
      await page.evaluate(() => window.imagePreviewFixture.refresh());
    await page.waitForTimeout(100);
    const history = await page.evaluate(() => window.imagePreviewFixture.snapshot());
    assert.equal(history.conversions, 10, 'history or navigation recomputed a cached original');
    await page.screenshot({ path: path.join(artifact, `history-${throttle}.png`) });
    await page.evaluate(() => {
      window.imagePreviewFixture.select('draft');
      window.imagePreviewFixture.clearDraft();
    });
    await page.waitForFunction(() => !document.querySelector('[aria-label="待发送附件"]'));
    await page.evaluate(() => window.imagePreviewFixture.add());
    await page.waitForFunction(() =>
      window.imagePreviewFixture
        .snapshot()
        .previews.every((image) => image.decoded && image.width > 0),
    );
    const warm = await page.evaluate(() => window.imagePreviewFixture.snapshot());
    assert.equal(warm.conversions, 10, 'reselecting original files recomputed cached thumbnails');
    assert.equal(warm.originalMatches, 20);
    assert.equal(warm.originalBytes, bytes * 2);
    const formats = await page.evaluate(() => window.imagePreviewFixture.formats());
    assert.deepEqual(
      formats.map(({ type, width, height }) => ({ type, width, height })),
      [
        { type: 'image/png', width: 8, height: 4 },
        { type: 'image/webp', width: 8, height: 4 },
        { type: 'image/gif', width: 1, height: 1 },
        { type: 'image/jpeg', width: 4, height: 8 },
      ],
    );
    assert.equal(formats[0]!.alpha, 128);
    assert.equal(formats[1]!.alpha, 128);
    assert.deepEqual(errors, []);
    report.cases.push({
      throttle,
      bytes,
      inputDuringConversion,
      cold,
      history,
      warm,
      formats,
      errors,
    });
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        throttle,
        coldMs: cold.elapsedMs,
        warmMs: warm.elapsedMs,
        coldLongTaskMs: cold.longestTaskMs,
        coldMaxFrameGapMs: cold.maxFrameGapMs,
        conversions: warm.conversions,
        peakConversions: warm.peakConversions,
      }),
    );
    await page.close();
  }
} finally {
  console.log(JSON.stringify({ artifact }));
  await browser.close();
  server.stop(true);
}
