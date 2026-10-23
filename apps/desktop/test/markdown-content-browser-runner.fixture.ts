import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import { desktopContentSecurityPolicy } from '../electron/development';

const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'markdown-content-browser-'));
const output = path.join(artifact, 'dist');
// Check decoded pixels, not just theme variables present in an SVG stylesheet.
async function diagramInk(page: import('playwright').Page) {
  const pixels = await page.locator('.markdown-diagram img').evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0,
      teal = 0,
      transparent = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
      if (a === 0) transparent++;
      if (a < 150) continue;
      if (b > r + 35 && b > g + 25) blue++;
      if (g > r + 25 && b > r + 20 && Math.abs(g - b) < 15) teal++;
    }
    return { blue, teal, transparentFraction: transparent / (canvas.width * canvas.height) };
  });
  assert.ok(pixels.blue > 50, 'diagram must visibly use the theme accent');
  assert.ok(pixels.transparentFraction > 0.7, 'diagram surfaces remain transparent');
  return pixels;
}
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
    assetsInlineLimit: 0,
    rollupOptions: { input: path.join(directory, 'markdown-content-browser.fixture.html') },
    target: 'esnext',
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: process.argv.includes('--serve') ? 4319 : 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (pathname === '/')
      return new Response(
        Bun.file(path.join(output, 'test/markdown-content-browser.fixture.html')),
        {
          headers: {
            'content-type': 'text/html',
            'Content-Security-Policy': desktopContentSecurityPolicy(null),
          },
        },
      );
    const file = path.resolve(output, `.${pathname}`);
    if (!file.startsWith(output + path.sep)) return new Response(null, { status: 404 });
    return new Response(Bun.file(file));
  },
});
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ url: server.url.toString(), artifact }));
} else {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    channel: 'chrome',
  });
  const cases: unknown[] = [];
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors: string[] = [],
        external: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(server.url.origin))
          external.push(request.url());
      });
      await page.goto(server.url.toString());
      await page.getByText('图表生成中，当前显示源码').waitFor();
      assert.equal(await page.locator('.markdown-diagram img').count(), 0);
      assert.equal(await page.locator('.katex').count(), 2);
      await page.getByRole('link', { name: '跳到公式' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '公式');
      await page.locator('[data-footnote-ref]').click();
      assert.ok(
        (await page.evaluate(() => document.activeElement?.textContent))?.includes(
          '脚注与返回链接',
        ),
      );
      await page.locator('[data-footnote-backref]').click();
      assert.equal(
        await page.evaluate(() => document.activeElement?.hasAttribute('data-footnote-ref')),
        true,
      );
      await page.getByRole('button', { name: '完成生成', exact: true }).click();
      const diagram = page.locator('.markdown-diagram img');
      await diagram.waitFor();
      await diagram.evaluate(async (image) => (image as HTMLImageElement).decode());
      assert.ok(await diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth > 0));
      await page.getByRole('button', { name: '暂停读取', exact: true }).click();
      assert.equal(
        await page.locator('.markdown-source-toggle').getAttribute('aria-disabled'),
        'true',
      );
      await page.locator('.markdown-source-toggle').click({ force: true });
      assert.equal(await diagram.count(), 1);
      await page.getByRole('button', { name: '暂停读取', exact: true }).click();
      const lightSource = await diagram.getAttribute('src');
      const lightInk = await diagramInk(page);
      const region = page.locator('.markdown-diagram-scroll');
      if (width === 390) {
        await Promise.all([
          region.evaluate(
            (node) =>
              new Promise<void>((resolve) =>
                node.addEventListener('scrollend', () => resolve(), { once: true }),
              ),
          ),
          region.press('ArrowRight'),
        ]);
        assert.ok(await region.evaluate((node) => node.scrollLeft > 0));
      }
      const horizontalPosition = await region.evaluate((node) => node.scrollLeft);
      await page.screenshot({ path: path.join(artifact, `light-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
      assert.equal(
        await page
          .locator('.katex')
          .first()
          .evaluate((node) => getComputedStyle(node).color),
        'rgb(237, 237, 237)',
      );
      await page.waitForFunction(
        (previous) =>
          document.querySelector('.markdown-diagram img')?.getAttribute('src') !== previous,
        lightSource,
      );
      await diagram.evaluate(async (image) => (image as HTMLImageElement).decode());
      const darkInk = await diagramInk(page);
      assert.equal(await region.evaluate((node) => node.scrollLeft), horizontalPosition);
      await page.screenshot({ path: path.join(artifact, `dark-${width}.png`), fullPage: true });
      for (const name of ['时序图', '类图', '状态图', 'ER 图', '流程图']) {
        await page.getByRole('button', { name, exact: true }).click();
        await diagram.waitFor();
        await diagram.evaluate(async (image) => (image as HTMLImageElement).decode());
        if (name === '时序图') {
          const darkSequence = await diagramInk(page);
          assert.ok(darkSequence.teal > 50, 'lifelines use the secondary theme color');
          await page.screenshot({
            path: path.join(artifact, `sequence-dark-${width}.png`),
            fullPage: true,
          });
          const before = await diagram.getAttribute('src');
          await page.getByRole('button', { name: '切换主题', exact: true }).click();
          await page.waitForFunction(
            (previous) =>
              document.querySelector('.markdown-diagram img')?.getAttribute('src') !== previous,
            before,
          );
          const lightSequence = await diagramInk(page);
          assert.ok(lightSequence.teal > 50);
          await page.screenshot({
            path: path.join(artifact, `sequence-light-${width}.png`),
            fullPage: true,
          });
          const light = await diagram.getAttribute('src');
          await page.getByRole('button', { name: '切换主题', exact: true }).click();
          await page.waitForFunction(
            (previous) =>
              document.querySelector('.markdown-diagram img')?.getAttribute('src') !== previous,
            light,
          );
        }
      }
      await page.getByRole('button', { name: '源码', exact: true }).click();
      const source = await page.locator('.markdown-diagram pre').textContent();
      await page
        .locator('.markdown-code-block')
        .last()
        .getByRole('button', { name: '复制代码', exact: true })
        .click();
      assert.equal(await page.getByLabel('复制结果').textContent(), source);
      await page.getByRole('button', { name: '切换会话', exact: true }).click();
      await page.getByRole('heading', { name: '另一会话', exact: true }).waitFor();
      await page.getByRole('button', { name: '切换会话', exact: true }).click();
      assert.equal(await page.locator('.markdown-diagram pre').textContent(), source);
      await page.getByRole('button', { name: '图表', exact: true }).click();
      await diagram.waitFor();
      await page.getByRole('button', { name: '错误源码', exact: true }).click();
      await page.getByText('图表暂时无法解析，请查看源码').waitFor();
      assert.equal(await page.locator('.markdown-diagram pre').textContent(), 'graph TD\nA[\n');
      await page.getByRole('button', { name: '流程图', exact: true }).click();
      await diagram.waitFor();
      await page.getByRole('button', { name: '外部资源', exact: true }).click();
      await page.getByText('图表含自定义样式或交互内容，请查看源码').waitFor();
      assert.equal(await diagram.count(), 0);
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      cases.push({ width, errors, external, lightInk, darkInk });
      await page.close();
    }
    const report = { browser: browser.version(), artifact, cases };
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    server.stop(true);
  }
}
