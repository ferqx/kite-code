import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import type { CacheSnapshot } from './conversation-cache-browser.fixture';

// Explicit standalone fixture; it never loads Service, user data or the production diagnostics.
const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'conversation-cache-browser-'));
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
      entry: path.join(directory, 'conversation-cache-browser.fixture.tsx'),
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
const report: {
  browser: string;
  cases: { theme: string; idle: CacheSnapshot; [field: string]: unknown }[];
} = { browser: browser.version(), cases: [] };
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'no-preference',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url.toString());
    await page.locator('.kite-client').waitFor();
    await page.evaluate((theme) => {
      document.documentElement.className = theme;
      document.body.className = theme;
      document.querySelector('.kite-client')!.setAttribute('data-theme', theme);
    }, theme);
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.native-user-image img');
      return (
        img?.complete &&
        img.naturalWidth > 0 &&
        !!document.querySelector('.message.assistant .message-copy')
      );
    });
    await page.evaluate(() => window.remember());
    // Keep the pointer outside the reading area, as when switching in the sidebar.
    await page.locator('#a').hover();
    const idle = await page.evaluate(() => window.snapshot());
    const frames = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      window.switchSession('b');
      await frame();
      await frame();
      window.switchSession('a', true);
      const values = [];
      for (let i = 0; i < 12; i++) {
        await frame();
        values.push(window.snapshot());
      }
      document.querySelector<HTMLButtonElement>('.message.user .message-copy')!.click();
      document.querySelector<HTMLButtonElement>('.message.assistant .message-copy')!.click();
      document.querySelector<HTMLButtonElement>('.file-link')!.click();
      window.switchSession('a', false);
      for (let i = 0; i < 12; i++) {
        await frame();
        values.push(window.snapshot());
      }
      return values;
    });
    await page.locator('.message.user').hover();
    await page.waitForTimeout(180);
    await page.locator('.message.user .message-copy').click();
    const feedback = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      await frame();
      const before = window.snapshot();
      window.switchSession('b');
      await frame();
      await frame();
      window.switchSession('a', true);
      await frame();
      const preview = window.snapshot();
      window.switchSession('a', false);
      await frame();
      return { before, preview, ready: window.snapshot() };
    });
    await page.locator('.agent-turn-summary').hover();
    await page.waitForTimeout(180);
    const highlight = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const before = window.snapshot();
      window.switchSession('b');
      await frame();
      await frame();
      window.switchSession('a', true);
      const values = [];
      for (let i = 0; i < 6; i++) {
        await frame();
        values.push(window.snapshot());
      }
      window.switchSession('a');
      for (let i = 0; i < 6; i++) {
        await frame();
        values.push(window.snapshot());
      }
      return { before, values };
    });
    await page.locator('.file-link').click();
    await page.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        window.switchSession(i % 2 ? 'a' : 'b');
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const final = await page.evaluate(() => window.snapshot());
    assert.ok(
      frames.every(
        (value) =>
          value.imgSame &&
          value.copySame &&
          value.replyCopySame &&
          value.fileSame &&
          value.summarySame &&
          value.decoded,
      ),
    );
    assert.ok(
      frames.every(
        (value) =>
          value.copyOpacity === idle.copyOpacity &&
          value.summaryOpacity === '1' &&
          !value.copyDisabled &&
          value.copies === 0 &&
          value.fileOpens === 0,
      ),
    );
    assert.equal(feedback.before.copyState, 'copied');
    assert.equal(feedback.preview.copyState, 'copied');
    assert.equal(feedback.ready.copyState, 'copied');
    assert.ok(
      highlight.values.every((value) => value.summaryColor === highlight.before.summaryColor),
    );
    assert.equal(final.fileOpens, 1);
    assert.equal(final.opens, 1);
    assert.equal(final.urls, 1);
    assert.equal(final.revoked, 0);
    assert.ok(
      final.imgSame &&
        final.copySame &&
        final.replyCopySame &&
        final.fileSame &&
        final.summarySame &&
        final.decoded,
    );
    assert.equal(final.viewports, 1);
    assert.notEqual(final.transitions, '0s');
    assert.deepEqual(errors, []);
    report.cases.push({
      theme,
      idle,
      frameCount: frames.length,
      stableImageFrames: frames.filter((v) => v.imgSame && v.decoded).length,
      copyOpacities: [...new Set(frames.map((v) => v.copyOpacity))],
      summaryOpacities: [...new Set(frames.map((v) => v.summaryOpacity))],
      feedback,
      highlight: {
        before: highlight.before.summaryColor,
        colors: [...new Set(highlight.values.map((v) => v.summaryColor))],
      },
      final,
      errors,
    });
    await page.close();
  }
  assert.notEqual(report.cases[0]!.idle.summaryColor, report.cases[1]!.idle.summaryColor);
  console.log(JSON.stringify(report, null, 2));
  await Bun.write(
    process.argv[2] ?? path.join(artifact, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ artifact }));
} finally {
  await browser.close();
  server.stop(true);
}
