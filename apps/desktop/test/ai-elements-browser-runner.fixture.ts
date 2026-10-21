import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';

// Explicit standalone fixture; it never loads Service, user data or the production diagnostics.
const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'ai-elements-browser-'));
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
      entry: path.join(directory, 'ai-elements-browser.fixture.tsx'),
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
const report: { browser: string; cases: unknown[] } = { browser: browser.version(), cases: [] };
try {
  for (const theme of ['light', 'dark'])
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 1600 },
        reducedMotion: 'reduce',
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(server.url.toString());
      await page.locator('.kite-client').waitFor();
      assert.equal(await page.getByRole('button', { name: '复制代码', exact: true }).count(), 3);
      await page.evaluate((theme) => {
        document.documentElement.className = theme;
        document.documentElement.dataset.theme = theme;
        document.body.dataset.theme = theme;
        document.body.className = theme;
        document.querySelector('.kite-client')!.setAttribute('data-theme', theme);
      }, theme);
      const response = page.locator('.response-status');
      assert.equal(await response.count(), 1);
      assert.equal(await response.isVisible(), true);
      const responseNode = await response.elementHandle();
      const process = page.locator('.agent-turn[data-turn-status="running"] .agent-turn-summary');
      assert.equal(await process.textContent(), '处理过程');
      await process.click();
      assert.equal(await response.isVisible(), true);
      assert.equal(await page.locator('.shell-activity').count(), 0);
      await process.click();
      await page.locator('.tool-activity:not(.shell-activity) .tool-activity-summary').click();
      await page.locator('.file-link').click();
      await page.locator('.shell-activity .tool-activity-summary').click();
      const output = page.locator('[aria-label="Shell 执行输出"]');
      const initial = await output.evaluate((node) => {
        const pre = node as HTMLElement;
        pre.scrollTop = 60;
        pre.dispatchEvent(new Event('scroll'));
        return {
          top: pre.scrollTop,
          maxHeight: getComputedStyle(pre).maxHeight,
          height: pre.clientHeight,
          scrollHeight: pre.scrollHeight,
        };
      });
      assert.equal(initial.maxHeight, '256px');
      assert.ok(initial.scrollHeight > initial.height);
      await page.evaluate(() => window.appendFixture());
      assert.equal(await output.evaluate((node) => node.scrollTop), initial.top);
      assert.equal(
        await page
          .locator('.tool-activity:not(.shell-activity) .tool-activity-summary')
          .getAttribute('aria-expanded'),
        'true',
      );
      await page.getByRole('button', { name: '回到最新输出' }).click();
      const latest = await output.evaluate((node) => ({
        top: node.scrollTop,
        end: node.scrollHeight - node.clientHeight,
      }));
      assert.ok(Math.abs(latest.top - latest.end) < 2);
      await page.evaluate(() => window.cancelFixture());
      assert.equal(await response.count(), 1);
      assert.equal(await response.isVisible(), true);
      assert.equal(
        await page.locator('.shell-activity .tool-activity-summary').getAttribute('aria-expanded'),
        'true',
      );
      assert.ok((await output.textContent())?.includes('APPENDED_FIXTURE_LINE'));
      assert.ok((await page.locator('.shell-result').textContent())?.includes('已停止'));
      assert.equal(await page.locator('.shell-activity [data-status="error"]').count(), 0);
      await page.evaluate(() => window.thinkFixture());
      assert.equal(await response.textContent(), '正在思考…');
      assert.equal(
        await responseNode!.evaluate((node) => node === document.querySelector('.response-status')),
        true,
      );
      assert.equal(await process.textContent(), '处理过程');
      assert.equal(
        (await page.locator('body').textContent())?.includes('PRIVATE_REASONING'),
        false,
      );
      await process.click();
      assert.equal(await response.isVisible(), true);
      await page.screenshot({
        path: path.join(artifact, `${theme}-${width}-thinking.png`),
        fullPage: true,
      });
      await process.click();
      await page.evaluate(() => window.replyFixture());
      assert.equal(await response.textContent(), '正在回复…');
      assert.equal(
        await responseNode!.evaluate((node) => node === document.querySelector('.response-status')),
        true,
      );
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        nestedButtons: document.querySelectorAll('button button').length,
        opens: window.fixtureFileOpens,
        readingWidth: document.querySelector('.reading-column')?.getBoundingClientRect().width,
        blocks: [...document.querySelectorAll<HTMLElement>('.markdown-code-block pre')].map(
          (node) => {
            node.scrollLeft = 70;
            return {
              width: node.clientWidth,
              scrollWidth: node.scrollWidth,
              scrollLeft: node.scrollLeft,
              text: node.textContent,
            };
          },
        ),
      }));
      assert.ok(layout.documentWidth <= layout.viewport);
      assert.equal(layout.nestedButtons, 0);
      assert.deepEqual(layout.opens, ['src/main.ts']);
      assert.equal(layout.blocks.length, 3);
      assert.ok(layout.blocks[2]!.scrollWidth > layout.blocks[2]!.width);
      assert.ok(layout.blocks[2]!.scrollLeft > 0);
      assert.deepEqual(errors, []);
      const screenshot = path.join(artifact, `${theme}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await page.evaluate(() => window.finishTurnFixture());
      assert.equal(await response.count(), 0);
      report.cases.push({ theme, width, initial, latest, layout, errors, screenshot });
      await page.close();
    }
  await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifact }, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
