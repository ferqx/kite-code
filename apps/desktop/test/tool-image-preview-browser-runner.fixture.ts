import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import { openFixtureFile } from '../../../scripts/tooling/files';
import { serve as serveFixture } from '../../../scripts/tooling/http';
import type {} from './tool-image-preview-browser.fixture';

const cache = resolve(import.meta.dirname, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(join(cache, 'tool-image-preview-')),
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
      entry: join(import.meta.dirname, 'tool-image-preview-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
    target: 'esnext',
  },
});
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
const browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true });
const observe = process.argv.includes('--observe')
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: 'zh-CN' });
const errors: string[] = [],
  stages: unknown[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(server.url.toString());
  await page.waitForFunction(() => !!window.toolImageFixture);
  const checkpoint = async (stage: string) => {
    // Let the latest React/Presence change reach layout before querying CSS animations or pixels.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // Scroll-fade timelines intentionally stay running; only wait for timed disclosure motion.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.tool-activity-content')]
          .flatMap((element) => element.getAnimations({ subtree: true }))
          .filter((animation) => animation.timeline instanceof DocumentTimeline)
          .every(
            (animation) =>
              !Number.isFinite(Number(animation.effect?.getTiming().iterations)) ||
              animation.playState !== 'running',
          ),
      undefined,
      { timeout: 5000 },
    );
    const snapshot = await page.evaluate(() => ({
      ...window.toolImageFixture.snapshot(),
      images: document.querySelectorAll('img').length,
      busy: document.querySelectorAll('[aria-busy="true"]').length,
      retry: document.querySelectorAll('.native-user-image button').length,
      top: document.querySelector('.conversation-viewport')!.scrollTop,
      media: [...document.querySelectorAll('.composer-attachment-preview')].map((media) => {
        const box = media.getBoundingClientRect(),
          content = media.closest('.tool-activity-content')!.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          fullyVisible: box.bottom <= content.bottom + 1,
        };
      }),
    }));
    assert.ok(snapshot.images <= (snapshot.stage === 'batch' ? 10 : 1));
    assert.deepEqual(errors, []);
    for (const media of snapshot.media) {
      assert.equal(media.width, 120);
      assert.equal(media.height, 120);
      assert.ok(media.fullyVisible);
    }
    const file = join(artifact, `${stage}.png`);
    await page.screenshot({ path: file });
    stages.push({ stage, snapshot, file });
    console.log(JSON.stringify({ ...snapshot, checkpoint: stage, file }));
    if (observe) await observe.question('观察此阶段后按 Enter 继续：');
    return snapshot;
  };
  assert.equal((await checkpoint('running')).images, 0);
  await page.evaluate(() => window.toolImageFixture.show());
  await page.waitForFunction(() => window.toolImageFixture.snapshot().pending === 1);
  const loading = await checkpoint('loading');
  assert.equal(loading.images, 0);
  assert.ok(loading.busy > 0);
  await page.locator('.tool-image-activity > .tool-activity-summary').click();
  await page.waitForFunction(() => window.toolImageFixture.snapshot().leases === 0);
  await page.evaluate(() => window.toolImageFixture.release());
  await page.waitForFunction(() => !document.querySelector('.native-user-image img'));
  assert.equal((await checkpoint('cancelled-preview')).images, 0);
  await page.locator('.tool-image-activity > .tool-activity-summary').click();
  await page.waitForFunction(() => window.toolImageFixture.snapshot().pending === 1);
  await page.evaluate(() => window.toolImageFixture.release());
  await page.waitForSelector('.native-user-image img');
  const ready = await checkpoint('ready');
  assert.equal(ready.images, 1);
  assert.equal(ready.top, loading.top);
  await page
    .locator('.tool-image-activity')
    .screenshot({ path: join(artifact, 'image-tool-message.png') });
  await page.locator('.tool-image-activity > .tool-activity-summary').click();
  await page.waitForFunction(() => !document.querySelector('.native-user-image img'));
  assert.equal((await checkpoint('collapsed')).images, 0);
  await page.evaluate(() => window.toolImageFixture.show('other-session'));
  assert.equal((await checkpoint('switched')).images, 0);
  await page.evaluate(() => {
    window.toolImageFixture.corrupt(true);
    window.toolImageFixture.show();
  });
  await page.waitForFunction(() => window.toolImageFixture.snapshot().pending === 1);
  await page.evaluate(() => window.toolImageFixture.release());
  await page.getByRole('button', { name: '重试读取图片：scan.png' }).waitFor();
  assert.equal((await checkpoint('failed')).images, 0);
  await page.evaluate(() => window.toolImageFixture.corrupt(false));
  await page.getByRole('button', { name: '重试读取图片：scan.png' }).click();
  await page.waitForFunction(() => window.toolImageFixture.snapshot().pending === 1);
  await page.evaluate(() => window.toolImageFixture.release());
  await page.waitForSelector('.native-user-image img');
  assert.equal((await checkpoint('recovered')).images, 1);
  await page.evaluate(() => window.toolImageFixture.show('batch'));
  await page.waitForFunction(() => window.toolImageFixture.snapshot().pending === 1);
  const batchLoading = await checkpoint('batch-loading');
  assert.equal(batchLoading.media.length, 10);
  for (let index = 0; index < 10; index++) {
    await page.waitForFunction(() => window.toolImageFixture.snapshot().pending === 1);
    await page.evaluate(() => window.toolImageFixture.release());
    await page.waitForFunction(
      (count) => document.querySelectorAll('.native-user-image img').length >= count,
      index + 1,
    );
  }
  const batch = await checkpoint('batch-ready');
  assert.equal(batch.images, 10);
  assert.equal(batch.top, batchLoading.top);
  assert.equal(batch.leases, 0);
  assert.deepEqual(
    await page
      .locator('.native-user-image img')
      .evaluateAll((images) => images.map((image) => image.getAttribute('alt'))),
    Array.from({ length: 10 }, (_, i) => `scan-${i + 1}.png`),
  );
  assert.ok(
    (await page.locator('.tool-activity-title').textContent())?.includes('已查看 10 张图像'),
  );
  await page.locator('.tool-image-activity > .tool-activity-summary').click();
  assert.equal((await checkpoint('batch-collapsed')).images, 0);
  await page.evaluate(() => window.toolImageFixture.show('failed'));
  assert.equal((await checkpoint('tool-failed')).images, 0);
  assert.equal((await page.evaluate(() => window.toolImageFixture.snapshot())).leases, 0);
  writeFileSync(
    join(artifact, 'report.json'),
    JSON.stringify({ browser: browser.version(), stages, errors, passed: true }, null, 2),
  );
} finally {
  observe?.close();
  await browser.close();
  server.stop(true);
}
