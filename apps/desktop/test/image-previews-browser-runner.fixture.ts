import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
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
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  channel: 'chrome',
  ignoreDefaultArgs: ['--hide-scrollbars'],
});
const report = { browser: browser.version(), cases: [] as unknown[] };
const observation = process.argv.includes('--observe')
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
try {
  if (process.argv.includes('--attachments')) {
    console.log(JSON.stringify({ artifact }));
    for (const theme of ['dark', 'light'])
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, locale: 'zh-CN' });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(server.url.toString());
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          document.body.classList.toggle('dark', theme === 'dark');
          document.querySelector('.kite-client')!.setAttribute('data-theme', theme);
        }, theme);
        await page.waitForFunction(() => !!window.imagePreviewFixture);
        await page.evaluate(() => window.imagePreviewFixture.generate());
        const stages: unknown[] = [];
        const checkpoint = async (name: string) => {
          const measurements = await page.evaluate(() => {
            const user = document.querySelector<HTMLElement>('.message.user')!;
            const body = user.querySelector<HTMLElement>('.user-message-body')!;
            const attachments = user.querySelector<HTMLElement>('.message-attachments')!;
            const rail = attachments.querySelector<HTMLElement>('.message-attachments-list')!;
            const rect = (element: HTMLElement) => {
              const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
              return { x, y, width, height, right, bottom };
            };
            return {
              users: document.querySelectorAll('.message.user').length,
              attachmentInsideBody: !!body.querySelector('.message-attachments'),
              user: rect(user),
              body: rect(body),
              attachments: rect(attachments),
              bodyDisplay: getComputedStyle(body).display,
              rail: { ...rect(rail), scroll: rail.scrollLeft, scrollWidth: rail.scrollWidth },
              cards: [...rail.querySelectorAll<HTMLElement>('.composer-attachment')].map(rect),
              pageOverflow: document.documentElement.scrollWidth > innerWidth,
              readingTop: document.querySelector('.conversation-viewport')!.scrollTop,
              timeCount: user.querySelectorAll('.message-meta').length,
            };
          });
          assert.equal(measurements.users, 1);
          assert.equal(measurements.timeCount, 1);
          assert.equal(measurements.attachmentInsideBody, false);
          assert.equal(measurements.pageOverflow, false);
          assert.ok(measurements.cards.every((card) => Math.abs(card.width - 148) < 1));
          assert.ok(
            measurements.cards.every((card) => Math.abs(card.y - measurements.cards[0]!.y) < 1),
          );
          if (measurements.bodyDisplay !== 'none') {
            assert.ok(Math.abs(measurements.body.y - measurements.attachments.bottom - 8) < 1);
            assert.ok(Math.abs(measurements.body.right - measurements.attachments.right) < 1);
          }
          const file = path.join(artifact, `${theme}-${width}-${name}.png`);
          await page.screenshot({ path: file });
          stages.push({ name, ...measurements, file });
          console.log(JSON.stringify({ theme, width, stage: name, file }));
          if (observation) await observation.question('观察此阶段后按 Enter 继续：');
          return measurements;
        };
        await page.evaluate(() =>
          window.imagePreviewFixture.layout({
            files: 1,
            images: 1,
            text: '参考文档和截图，调整这个圆角。',
            phase: 'sending',
          }),
        );
        const pending = await checkpoint('pending');
        await page.evaluate(() =>
          window.imagePreviewFixture.layout({
            files: 1,
            images: 1,
            text: '参考文档和截图，调整这个圆角。',
            phase: 'saved',
            reply: '正在检查附件中的布局。',
          }),
        );
        await page.waitForSelector('.native-user-image img');
        const saved = await checkpoint('saved');
        assert.equal(pending.attachments.height, saved.attachments.height);
        assert.equal(pending.body.y, saved.body.y);
        await page.locator('.message.user').hover();
        await page.getByRole('button', { name: '复制本轮用户消息' }).click();
        assert.equal(
          await page.evaluate(() => window.imagePreviewFixture.snapshot().lastCopied),
          '参考文档和截图，调整这个圆角。',
        );
        await page.evaluate(() =>
          window.imagePreviewFixture.layout({
            files: 1,
            images: 5,
            text: '这些文件和图片一起作为参考。',
            phase: 'saved',
            reply: '收到，正在逐项查看。',
          }),
        );
        await page.waitForSelector('.message-attachments-navigation');
        const initial = await checkpoint('overflow-start');
        assert.ok(initial.rail.scrollWidth > initial.rail.width);
        assert.equal(await page.getByRole('button', { name: '向左查看附件' }).isDisabled(), true);
        for (
          let n = 0;
          n < 10 && (await page.getByRole('button', { name: '向右查看附件' }).isEnabled());
          n++
        ) {
          await page.getByRole('button', { name: '向右查看附件' }).click();
          await page.waitForTimeout(400);
        }
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.native-user-image')].at(-1)?.querySelector('img'),
        );
        const end = await checkpoint('overflow-end');
        assert.ok(end.rail.scroll > 0);
        assert.equal(end.body.x, initial.body.x);
        assert.equal(end.body.y, initial.body.y);
        assert.equal(await page.getByRole('button', { name: '向右查看附件' }).isDisabled(), true);
        await page.getByRole('button', { name: '向左查看附件' }).focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const back = await checkpoint('keyboard-back');
        assert.ok(back.rail.scroll < end.rail.scroll);
        await page.evaluate(() => window.imagePreviewFixture.refresh());
        const refreshed = await checkpoint('refresh');
        assert.equal(refreshed.rail.scroll, back.rail.scroll);
        await page.evaluate(() => window.imagePreviewFixture.select('b'));
        await page.waitForSelector('.message.user');
        await page.evaluate(() => window.imagePreviewFixture.select('a'));
        const returned = await checkpoint('cache-return');
        assert.equal(returned.rail.scroll, back.rail.scroll);
        await page.evaluate(() =>
          window.imagePreviewFixture.layout({
            files: 1,
            images: 1,
            text: '这些文件和图片一起作为参考。',
            phase: 'failed',
          }),
        );
        await page.waitForSelector('.delivery-status');
        await checkpoint('failed');
        await page.evaluate(() =>
          window.imagePreviewFixture.layout({ files: 1, images: 1, text: '', phase: 'saved' }),
        );
        const only = await checkpoint('attachments-only');
        assert.equal(only.bodyDisplay, 'none');
        assert.equal(await page.locator('.message.user .message-copy').count(), 0);
        await page.evaluate(() => window.imagePreviewFixture.reopen());
        const reopened = await checkpoint('reopened');
        assert.equal(reopened.bodyDisplay, 'none');
        await page.waitForSelector('.native-user-image img');
        const ready = await checkpoint('reopened-ready');
        assert.equal(ready.bodyDisplay, 'none');
        assert.equal(ready.attachments.height, reopened.attachments.height);
        assert.deepEqual(errors, []);
        report.cases.push({ theme, width, stages, errors });
        await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
        await page.close();
      }
  } else {
    for (const throttle of [1, 4]) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
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
  }
} finally {
  observation?.close();
  console.log(JSON.stringify({ artifact }));
  await browser.close();
  server.stop(true);
}
