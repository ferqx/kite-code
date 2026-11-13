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
async function checkFileReference(page: import('playwright').Page, width: number) {
  const text = 'packages/agent/test/isolated/business/task/collaboration-observation.test.ts:94';
  const region = page.getByRole('region', { name: '文件引用预览' });
  const link = region.getByRole('link', {
    name: 'collaboration-observation.test.ts（第 94 行）',
    exact: true,
  });
  const plainPath = 'packages/agent/src/extensions/host.ts';
  const plainLink = region.getByRole('link', { name: 'host.ts', exact: true });
  const namedLink = region.getByRole('link', { name: '审批继承（第 802 行）', exact: true });
  const noteTitle = page.locator('.markdown-alert[data-alert="note"] .markdown-alert-title');
  const tooltip = page.getByRole('tooltip');
  const calls = page.getByLabel('文件打开记录');
  const iconOffset = (reference: typeof link) =>
    reference.evaluate((node) => {
      const icon = node.querySelector('.file-reference-icon')!.getBoundingClientRect();
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:1cap;vertical-align:baseline';
      node.prepend(marker);
      const { top, height } = marker.getBoundingClientRect();
      marker.remove();
      return icon.top + icon.height / 2 - (top + height / 2);
    });
  const tooltipLayout = () =>
    tooltip.evaluate((node) => {
      const { fontFamily, fontSize } = getComputedStyle(node);
      const { left, right } = node.getBoundingClientRect();
      return {
        fontFamily,
        fontSize,
        fits: left >= 0 && right <= innerWidth && node.scrollWidth <= node.clientWidth,
      };
    });
  const expectedTooltipLayout = {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    fontSize: '13px',
    fits: true,
  };
  const checkUnderline = () =>
    link.evaluate((node) => {
      const {
        textDecorationLine,
        textDecorationStyle,
        textDecorationThickness,
        textDecorationColor,
      } = getComputedStyle(node);
      return {
        line: textDecorationLine,
        style: textDecorationStyle,
        thickness: textDecorationThickness,
        softened: textDecorationColor !== getComputedStyle(node).color,
      };
    });
  const underline = { line: 'underline', style: 'dashed', thickness: '0.65px', softened: true };
  const visibility = async () =>
    link.evaluate((node) => {
      const { color, textDecorationLine, textDecorationStyle } = getComputedStyle(node);
      const paragraph = node.closest('p')!;
      const bounds = paragraph.getBoundingClientRect();
      const fits = [...node.getClientRects()].every((rect) => rect.right <= bounds.right + 1);
      const colors = document.createElement('canvas').getContext('2d')!;
      const luminance = (value: string) => {
        colors.fillStyle = value;
        const hex = colors.fillStyle.slice(1);
        return [0.2126, 0.7152, 0.0722].reduce((total, weight, index) => {
          const channel = parseInt(hex.slice(index * 2, index * 2 + 2), 16) / 255;
          const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return total + weight * linear;
        }, 0);
      };
      const surfaces = ['--background', '--composer-background'].map((property) =>
        luminance(getComputedStyle(node).getPropertyValue(property).trim()),
      );
      const foreground = luminance(color);
      const readable = surfaces.every(
        (surface) =>
          (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05) >= 4.5,
      );
      return {
        color,
        textDecorationLine,
        textDecorationStyle,
        fits,
        readable,
        paragraphAlign: getComputedStyle(paragraph).textAlign,
      };
    });
  assert.equal(await link.count(), 0);
  assert.equal(await region.textContent(), `同一文件（\`${text}`);
  await page.getByRole('button', { name: '闭合文件引用', exact: true }).click();
  await link.waitFor();
  await region.getByText('waitMs: 0', { exact: true }).waitFor();
  const original = await link.elementHandle();
  assert.match((await region.textContent()) ?? '', /^同一文件（.*）与 .*waitMs: 0。$/);
  assert.deepEqual(await visibility(), {
    color: 'rgb(36, 79, 138)',
    textDecorationLine: 'none',
    textDecorationStyle: 'dashed',
    fits: true,
    readable: true,
    paragraphAlign: 'start',
  });
  assert.equal(
    await noteTitle.evaluate((node) => getComputedStyle(node).color),
    'rgb(36, 79, 138)',
  );
  for (const reference of [link, namedLink]) {
    const offset = await iconOffset(reference);
    assert.ok(Math.abs(offset) <= 1, `file icon offset ${offset}px`);
  }
  assert.equal(await calls.textContent(), '[]');
  await link.hover();
  await tooltip.waitFor();
  assert.deepEqual(await tooltipLayout(), expectedTooltipLayout);
  assert.equal(
    await tooltip.textContent(),
    `D:\\Local Projects\\kite-code\\${text.split(':')[0]!.replaceAll('/', '\\')}（第 94 行）`,
  );
  assert.deepEqual(await checkUnderline(), underline);
  await page.screenshot({ path: path.join(artifact, `file-reference-tooltip-${width}.png`) });
  await page.mouse.move(0, 0);
  await tooltip.waitFor({ state: 'hidden' });
  assert.equal((await visibility()).textDecorationLine, 'none');
  await page.keyboard.press('Shift');
  await link.focus();
  await tooltip.waitFor();
  assert.deepEqual(await checkUnderline(), underline);
  await link.press('Escape');
  await tooltip.waitFor({ state: 'hidden' });
  await link.press('Enter');
  assert.equal(await calls.textContent(), JSON.stringify([text]));
  await page.getByRole('button', { name: '暂停读取', exact: true }).click();
  await tooltip.waitFor({ state: 'hidden' });
  assert.equal(await link.getAttribute('aria-disabled'), 'true');
  await link.click({ force: true });
  assert.equal(await calls.textContent(), JSON.stringify([text]));
  await page.getByRole('button', { name: '暂停读取', exact: true }).click();
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  assert.equal(await link.count(), 0);
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  assert.equal(await link.count(), 1);
  assert.equal(await original?.evaluate((node) => node.isConnected), true);
  await link.click();
  assert.equal(await calls.textContent(), JSON.stringify([text, text]));
  await plainLink.click();
  assert.equal(await calls.textContent(), JSON.stringify([text, text, plainPath]));
  await namedLink.click();
  assert.equal(
    await calls.textContent(),
    JSON.stringify([text, text, plainPath, `${plainPath}:802`]),
  );
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  assert.deepEqual(await visibility(), {
    color: 'rgb(101, 153, 227)',
    textDecorationLine: 'none',
    textDecorationStyle: 'dashed',
    fits: true,
    readable: true,
    paragraphAlign: 'start',
  });
  assert.equal(
    await noteTitle.evaluate((node) => getComputedStyle(node).color),
    'rgb(101, 153, 227)',
  );
  await region.screenshot({ path: path.join(artifact, `file-reference-dark-${width}.png`) });
  await link.hover();
  await tooltip.waitFor();
  assert.deepEqual(await tooltipLayout(), expectedTooltipLayout);
  assert.deepEqual(await checkUnderline(), underline);
  await page.screenshot({ path: path.join(artifact, `file-reference-hover-dark-${width}.png`) });
  await tooltip.screenshot({
    path: path.join(artifact, `file-reference-tooltip-dark-${width}.png`),
  });
  await page.mouse.move(0, 0);
  await tooltip.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await region.screenshot({ path: path.join(artifact, `file-reference-light-${width}.png`) });
}

async function checkTypography(page: import('playwright').Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const fontsFor = async (selector: string) => {
      const { nodeId } = await session.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
      });
      return (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    };
    const italic = await fontsFor('.typeset-chat em');
    const italicCode = await fontsFor('.typeset-chat em code');
    const shell = await fontsFor('[data-typography-shell]');
    const heading = await fontsFor('[data-typography-heading]');
    const prose = '.typeset-chat > p, [data-typography-body], [data-typography-heading]';
    const mono = '.typeset-chat em code, [data-typography-shell]';
    const fontFamilies = (selector: string) =>
      page
        .locator(selector)
        .evaluateAll((nodes) => [
          ...new Set(nodes.map((node) => getComputedStyle(node).fontFamily)),
        ]);
    const uiStack = await page
      .locator('body')
      .evaluate((node) => getComputedStyle(node).fontFamily);
    assert.deepEqual(await fontFamilies(prose), [uiStack]);
    const monoStack = await fontFamilies(mono);
    assert.equal(monoStack.length, 1);
    assert.match(monoStack[0]!, /^ui-monospace,/);
    if (process.platform === 'win32') {
      assert.ok(
        italic.some((font) => font.familyName === 'Segoe UI'),
        JSON.stringify(italic),
      );
      assert.ok(italicCode.some((font) => font.familyName === 'Consolas'));
      assert.ok(shell.some((font) => font.familyName === 'Consolas'));
    }
    assert.equal(
      await page
        .locator('[data-typography-heading]')
        .evaluate((node) => getComputedStyle(node).fontWeight),
      '500',
    );
    assert.equal(
      await page
        .locator('[data-typography-body]')
        .evaluate((node) => getComputedStyle(node).fontWeight),
      '400',
    );
    const chinese = page.locator('.typeset-chat em').filter({ hasText: '中文斜体' }).first();
    const italicImage = await chinese.screenshot();
    await chinese.evaluate((node) => {
      (node as HTMLElement).style.fontStyle = 'normal';
    });
    const normalImage = await chinese.screenshot();
    await chinese.evaluate((node) => {
      (node as HTMLElement).style.removeProperty('font-style');
    });
    assert.ok(
      !italicImage.equals(normalImage),
      'Chinese emphasis visibly differs from upright text',
    );
    return { italic, italicCode, shell, heading };
  } finally {
    await session.detach();
  }
}

async function checkTextIconAlignment(page: import('playwright').Page) {
  const tasks = page.locator('.task-list-item input[type="checkbox"]');
  await tasks.first().waitFor();
  const checkboxes = await tasks.evaluateAll((inputs) =>
    inputs.map((input) => {
      const checkbox = (input as HTMLInputElement).getBoundingClientRect();
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:1cap;vertical-align:baseline';
      input.before(marker);
      const { top, height } = marker.getBoundingClientRect();
      marker.remove();
      return {
        disabled: (input as HTMLInputElement).disabled,
        offset: checkbox.top + checkbox.height / 2 - top - height / 2,
      };
    }),
  );
  assert.equal(checkboxes.length, 2);
  assert.ok(
    checkboxes.every(({ disabled, offset }) => disabled && Math.abs(offset) <= 1),
    JSON.stringify(checkboxes),
  );

  const alert = page.getByRole('alert', { name: '本轮异常结束' });
  const alertOffset = await alert.evaluate((node) => {
    const { top, height } = node.querySelector('svg')!.getBoundingClientRect();
    const text = node.querySelector('[data-slot="alert-description"]')!;
    const firstLineCenter =
      text.getBoundingClientRect().top + parseFloat(getComputedStyle(text).lineHeight) / 2;
    return top + height / 2 - firstLineCenter;
  });
  assert.ok(Math.abs(alertOffset) <= 1, `alert icon offset ${alertOffset}px`);
  return { checkboxes, alertOffset };
}
async function checkDiagramSurface(page: import('playwright').Page) {
  const surface = await page.evaluate(() => {
    const root = document.querySelector('.typeset-chat')!;
    const diagram = root.querySelector('.markdown-code-block:has(.markdown-diagram)')!;
    const code = root.querySelector('.markdown-code-block:not(:has(.markdown-diagram))')!;
    return {
      rendered: Boolean(diagram.querySelector('.markdown-diagram-scroll')),
      background: getComputedStyle(diagram).backgroundColor,
      codeBackground: getComputedStyle(code).backgroundColor,
    };
  });
  assert.equal(
    surface.background,
    surface.rendered ? 'rgba(0, 0, 0, 0)' : surface.codeBackground,
    'only the rendered diagram is transparent; source and fallback retain the code surface',
  );
  return surface;
}
async function checkMessageStyles(page: import('playwright').Page) {
  const styles = await page.evaluate(() => {
    const root = document.querySelector('.typeset-chat')!;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const background = getComputedStyle(document.querySelector('.kite-client')!).backgroundColor;
    const luminance = (color: string, surface = 'transparent') => {
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = surface;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const read = (selector: string, within: ParentNode = root) => {
      const element = within.querySelector(selector)!;
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderBottomWidth,
        leftBorder: style.borderLeftWidth,
        radius: style.borderTopLeftRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        padding: style.padding,
      };
    };
    const quote = read('blockquote:not(.markdown-alert)');
    const quoteLuminance = luminance(quote.color);
    const backgroundLuminance = luminance(background);
    return {
      inline: read(':not(pre) > code'),
      code: read('.markdown-code-block:not(:has(.markdown-diagram))'),
      pre: read('.markdown-code-block:not(:has(.markdown-diagram)) pre'),
      header: read('[data-slot="code-block-header"]'),
      quote,
      quoteContrast:
        (Math.max(quoteLuminance, backgroundLuminance) + 0.05) /
        (Math.min(quoteLuminance, backgroundLuminance) + 0.05),
      alerts: [...root.querySelectorAll('.markdown-alert')].map((element) => {
        const title = element.querySelector('.markdown-alert-title')!;
        const surface = getComputedStyle(element).backgroundColor;
        const surfaceLuminance = luminance(surface);
        const titleLuminance = luminance(getComputedStyle(title).color, surface);
        return {
          kind: element.getAttribute('data-alert'),
          title: title.textContent,
          background: surface,
          iconHidden: element.querySelector('svg')?.getAttribute('aria-hidden'),
          titleContrast:
            (Math.max(titleLuminance, surfaceLuminance) + 0.05) /
            (Math.min(titleLuminance, surfaceLuminance) + 0.05),
        };
      }),
      table: read('table'),
      tableRegion: read('.markdown-table-scroll'),
      tableHead: read('th'),
      tableCell: read('td'),
      tableGrid: read('th + th'),
      foreground: getComputedStyle(root).color,
    };
  });
  const transparent = 'rgba(0, 0, 0, 0)';
  assert.equal(styles.inline.border, '0px');
  assert.ok(parseFloat(styles.inline.radius) > 0 && parseFloat(styles.inline.radius) <= 6);
  assert.notEqual(styles.inline.background, transparent);
  assert.notEqual(styles.code.background, transparent);
  assert.equal(styles.code.border, '0px');
  assert.equal(styles.pre.border, '0px');
  assert.equal(styles.header.border, '0px');
  const diagram = await checkDiagramSurface(page);
  assert.equal(styles.quote.leftBorder, '2px');
  assert.equal(styles.quote.background, transparent);
  assert.ok(styles.quoteContrast >= 4.5, 'quoted text remains readable against the page');
  assert.deepEqual(
    styles.alerts.map(({ kind, title, iconHidden }) => ({ kind, title, iconHidden })),
    [
      { kind: 'note', title: '说明', iconHidden: 'true' },
      { kind: 'tip', title: '提示', iconHidden: 'true' },
      { kind: 'important', title: '重要', iconHidden: 'true' },
      { kind: 'warning', title: '警告', iconHidden: 'true' },
      { kind: 'caution', title: '注意', iconHidden: 'true' },
    ],
  );
  for (const alert of styles.alerts) {
    assert.notEqual(alert.background, transparent);
    assert.ok(
      alert.titleContrast >= 4.5,
      `${alert.kind} title remains readable against its composited surface`,
    );
  }
  assert.equal(styles.table.fontSize, '12.6px');
  assert.equal(styles.table.lineHeight, '20.79px');
  assert.equal(styles.tableRegion.border, '1px');
  assert.equal(styles.tableHead.border, '1px');
  assert.equal(styles.tableHead.background, transparent);
  assert.equal(styles.tableCell.padding, '10px 14px');
  assert.equal(styles.tableGrid.leftBorder, '1px');
  assert.equal(await page.locator('textarea.prompt-editor').count(), 1);
  assert.equal(
    await page.locator('textarea.prompt-editor table, textarea.prompt-editor code').count(),
    0,
  );
  const link = page.getByRole('link', { name: '外部文档', exact: true }).first();
  await page.mouse.move(0, 0);
  assert.equal(await link.evaluate((node) => getComputedStyle(node).textDecorationLine), 'none');
  assert.notEqual(await link.evaluate((node) => getComputedStyle(node).color), styles.foreground);
  await link.hover();
  assert.equal(
    await link.evaluate((node) => getComputedStyle(node).textDecorationLine),
    'underline',
  );
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await link.focus();
  assert.equal(
    await link.evaluate((node) => getComputedStyle(node).textDecorationLine),
    'underline',
  );
  await link.blur();
  return { ...styles, diagram };
}
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
      const alignment = await checkTextIconAlignment(page);
      if (process.argv.includes('--file-references-only')) {
        const typography = await checkTypography(page);
        await checkFileReference(page, width);
        assert.deepEqual(external, []);
        assert.deepEqual(errors, []);
        cases.push({ width, errors, external, typography, alignment });
        await page.close();
        continue;
      }
      await page.getByText('图表生成中，当前显示源码').waitFor();
      assert.equal(await page.locator('.markdown-diagram img').count(), 0);
      assert.equal(await page.locator('.katex').count(), 2);
      const lightStyles = await checkMessageStyles(page);
      const typography = await checkTypography(page);
      await page
        .locator('.markdown-code-block')
        .first()
        .getByRole('button', { name: '复制代码', exact: true })
        .click();
      assert.equal(
        await page.getByLabel('复制结果').textContent(),
        'const greeting = "你好，世界";\nconsole.log(greeting);\n',
      );
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
      await checkDiagramSurface(page);
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
      const darkStyles = await checkMessageStyles(page);
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
      await checkDiagramSurface(page);
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
      await checkDiagramSurface(page);
      await page.getByRole('button', { name: '图表', exact: true }).click();
      await diagram.waitFor();
      await checkDiagramSurface(page);
      await page.getByRole('button', { name: '错误源码', exact: true }).click();
      await page.getByText('图表暂时无法解析，请查看源码').waitFor();
      assert.equal(await page.locator('.markdown-diagram pre').textContent(), 'graph TD\nA[\n');
      await checkDiagramSurface(page);
      await page.getByRole('button', { name: '流程图', exact: true }).click();
      await diagram.waitFor();
      await page.getByRole('button', { name: '外部资源', exact: true }).click();
      await page.getByText('图表含自定义样式或交互内容，请查看源码').waitFor();
      assert.equal(await diagram.count(), 0);
      await checkDiagramSurface(page);
      const editor = page.getByRole('textbox', { name: 'Markdown 样式输入', exact: true });
      await editor.press('ControlOrMeta+End');
      await editor.press('End');
      await editor.press('Shift+Enter');
      await editor.pressSequentially('末尾追加');
      assert.ok((await editor.textContent())?.includes('编辑原文'));
      assert.ok((await editor.textContent())?.includes('末尾追加'));
      await page.getByRole('button', { name: '开始流式预览', exact: true }).click();
      const stream = page.getByRole('region', { name: '流式样式预览', exact: true });
      await stream.getByText('已经显示的文字与', { exact: false }).waitFor();
      const stableInline = await stream.locator('code').elementHandle();
      await page.screenshot({
        path: path.join(artifact, `stream-start-${width}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: '追加流式预览', exact: true }).click();
      await stream.getByText('新追加的提示保留自己的底色和图标。', { exact: true }).waitFor();
      assert.equal(await stableInline?.evaluate((node) => node.isConnected), true);
      await page.screenshot({
        path: path.join(artifact, `stream-append-${width}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: '完成流式预览', exact: true }).click();
      await stream.getByText('生成完成，旧文字与代码表面保持。', { exact: true }).waitFor();
      assert.equal(await stableInline?.evaluate((node) => node.isConnected), true);
      await stream.getByRole('button', { name: '复制代码', exact: true }).click();
      assert.equal(
        await page.getByLabel('复制结果').textContent(),
        'const streamed = "追加中";\nconsole.log(streamed);\n',
      );
      await page.screenshot({
        path: path.join(artifact, `stream-complete-${width}.png`),
        fullPage: true,
      });
      await checkFileReference(page, width);
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      cases.push({
        width,
        errors,
        external,
        lightInk,
        darkInk,
        lightStyles,
        darkStyles,
        typography,
      });
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
