import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Locator, type Page } from 'playwright';
import { build } from 'vite';
import { promptText } from './prompt-editor-text.fixture';
import type {} from './prompt-send-browser.fixture';

const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'prompt-send-browser-'));
const existing = process.argv
  .find((value) => value.startsWith('--built='))
  ?.slice('--built='.length);
const output = existing ? path.resolve(existing) : path.join(artifact, 'dist');
if (!existing)
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
        entry: path.join(directory, 'prompt-send-browser.fixture.tsx'),
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
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = path.resolve(output, `.${pathname}`);
    return file.startsWith(output + path.sep)
      ? new Response(Bun.file(file))
      : new Response(null, { status: 404 });
  },
});
console.log(JSON.stringify({ url: server.url.toString(), artifact }));
if (process.argv.includes('--serve')) await new Promise(() => {});
const browser = await chromium.launch({
  headless: !process.argv.includes('--observe'),
  channel: 'chrome',
  chromiumSandbox: true,
});
if (process.argv.includes('--observe')) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(server.url.toString());
  await page.evaluate(() => {
    document.title = '提示词 Markdown 发送核验';
  });
  console.log(JSON.stringify({ observing: true }));
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  await browser.close();
  server.stop(true);
  process.exit(0);
}
const cases: unknown[] = [];
async function captureMarkdown(locator: Locator) {
  return locator.evaluate((element) => {
    const clone = element.cloneNode(true) as Element;
    for (const caret of clone.querySelectorAll('[data-md-caret]')) caret.remove();
    for (const node of [clone, ...clone.querySelectorAll('*')])
      for (const attribute of [...node.attributes])
        if (
          attribute.name.startsWith('data-md-') ||
          [
            'id',
            'href',
            'aria-describedby',
            'aria-disabled',
            'disabled',
            'data-disabled',
            'contenteditable',
            'tabindex',
            'title',
          ].includes(attribute.name) ||
          (attribute.name === 'style' && !attribute.value)
        )
          node.removeAttribute(attribute.name);
    // Horizontal auto margins resolve against the available editor/message width.
    const properties = [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'lineHeight',
      'marginTop',
      'marginBottom',
      'padding',
      'whiteSpace',
      'letterSpacing',
      'textAlign',
    ] as const;
    return {
      html: clone.innerHTML,
      styles: [...element.querySelectorAll('*')]
        .filter((node) => !node.closest('[data-md-caret]'))
        .map((node) =>
          Object.fromEntries(properties.map((key) => [key, getComputedStyle(node)[key]])),
        ),
    };
  });
}
async function verifyMarkdownFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const fonts = async (selector: string) => {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      return fonts.filter(({ glyphCount }) => glyphCount > 0).map(({ familyName }) => familyName);
    };
    const paragraph = '.message.assistant .typeset-chat > p';
    const code = `${paragraph} code, .message.assistant .typeset-chat li code`;
    const proseFonts = await fonts(paragraph);
    const codeFonts = await fonts(code);
    assert.ok(
      proseFonts.some((family) => family === 'Segoe UI'),
      JSON.stringify(proseFonts),
    );
    assert.ok(
      proseFonts.some((family) => /YaHei|SimSun/i.test(family)),
      JSON.stringify(proseFonts),
    );
    assert.ok(
      codeFonts.some((family) => family === 'Consolas'),
      JSON.stringify(codeFonts),
    );
    return { proseFonts, codeFonts };
  } finally {
    await session.detach();
  }
}

async function verifyMarkdownEdges(theme: 'light' | 'dark', width: number) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
  await page.addInitScript((theme) => localStorage.setItem('kite.desktop.theme', theme), theme);
  const results = [];
  try {
    for (const source of [
      '# 你好',
      '## 你好',
      '### 你好',
      '###### 你好',
      '前文\n\n# 末尾标题',
      '> ## 引用标题',
      '- ## 列表标题',
      '# 标题\n\n后续正文',
      '## 标题\n\n后续正文',
      '正文\n\n---',
    ]) {
      await page.goto(server.url.toString());
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      const input = page.locator('textarea.prompt-editor');
      await input.waitFor();
      await input.fill(source);
      await input.press('Enter');
      const markdown = page.locator('.message.user .typeset-chat');
      await markdown.waitFor();
      const edges = await markdown.evaluate((element) => {
        const first = element.firstElementChild!,
          last = element.lastElementChild!,
          heading = element.querySelector('h1, h2, h3, h4, h5, h6'),
          body = element.closest('.user-message-body')!;
        return {
          firstMargin: getComputedStyle(first).marginTop,
          lastMargin: getComputedStyle(last).marginBottom,
          bottomGap: body.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
          heading: heading && {
            marginTop: getComputedStyle(heading).marginTop,
            marginBottom: getComputedStyle(heading).marginBottom,
            paddingBottom: getComputedStyle(heading).paddingBottom,
            borderBottom: getComputedStyle(heading).borderBottomWidth,
          },
        };
      });
      assert.equal(edges.firstMargin, '0px', source);
      assert.equal(edges.lastMargin, '0px', source);
      assert.equal(edges.bottomGap, 8, source);
      if (edges.heading) {
        const followed = source.endsWith('后续正文');
        assert.equal(edges.heading.marginBottom, followed ? '9px' : '0px', source);
        assert.equal(edges.heading.borderBottom, followed ? '1px' : '0px', source);
        assert.equal(Number.parseFloat(edges.heading.paddingBottom) > 0, followed, source);
        assert.equal(edges.heading.marginTop, source.startsWith('前文') ? '18px' : '0px', source);
      }
      if (source === '# 你好') {
        const sent = await captureMarkdown(markdown);
        for (const name of ['确认受理', '保存用户消息', '完成回复'])
          await page.getByRole('button', { name, exact: true }).click();
        await page.locator('.message.assistant h1').waitFor();
        assert.deepEqual(
          await captureMarkdown(page.locator('.message.assistant .typeset-chat')),
          sent,
        );
        await page.screenshot({ path: path.join(artifact, `${theme}-${width}-heading-only.png`) });
      }
      if (source === '# 标题\n\n后续正文')
        await page.screenshot({
          path: path.join(artifact, `${theme}-${width}-heading-followed.png`),
        });
      results.push({ source, ...edges });
    }
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    const compactSource = [
      '# 等待 Agent 事件',
      '核查 Agent 输出（源码：[等待循环](packages/agent/src/extensions/host.ts:1157) 与 `packages/agent/src/extensions/task/index.ts`）',
      '**默认等待时长**',
      '- 传入 `work_refs` 且未传 `wait_ms` 时，默认最多等待 30 秒。\n- 未传 `work_refs` 且未传 `wait_ms` 时，立即返回快照。\n- 显式 `wait_ms: 0` 始终返回快照。',
      '**实际阻塞上限**',
      '1. `observationEnd = now + wait_ms`\n2. `deadline = min(observationEnd, run.deadlineAt)`，取本次观察结束时间与 Run 截止时间中的较早值。',
      '**会提前返回的情况**',
      '- 邮箱里有匹配事件 → `reason: events`。\n- 目标都已进入 `succeeded/failed/cancelled/outcome_unknown` → `reason: completed`。\n- 到 `deadline` → `reason: timeout`。',
      '| 条件 | 返回原因 |\n| --- | --- |\n| 匹配事件 | `events` |\n| 到达截止时间 | `timeout` |',
      '> 引用保持常规字重。',
      '```text\nreason: events\n```',
    ].join('\n\n');
    const input = page.locator('textarea.prompt-editor');
    await input.fill(compactSource);
    await input.press('Enter');
    for (const name of ['确认受理', '保存用户消息', '完成回复'])
      await page.getByRole('button', { name, exact: true }).click();
    const reply = page.locator('.message.assistant .typeset-chat');
    await reply.getByText('会提前返回的情况', { exact: true }).waitFor();
    const fontStyles = await reply.evaluate((element) => ({
      prose: getComputedStyle(element.querySelector('p')!).fontFamily,
      heading: getComputedStyle(element.querySelector('h1')!).fontFamily,
      code: getComputedStyle(element.querySelector('code')!).fontFamily,
    }));
    const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    assert.equal(fontStyles.prose, sans);
    assert.equal(fontStyles.heading, sans);
    assert.match(fontStyles.code, /^ui-monospace,.*Consolas/i);
    const surfaceFonts = await page.evaluate(() => {
      const selectors = ['body', '.kite-client', '.sidebar', 'textarea.prompt-editor'];
      return selectors.map(
        (selector) => getComputedStyle(document.querySelector(selector)!).fontFamily,
      );
    });
    assert.deepEqual(surfaceFonts, [sans, sans, sans, sans]);
    const fontGlyphs = process.platform === 'win32' ? await verifyMarkdownFonts(page) : undefined;
    results.push({ fontStyles, fontGlyphs });
    await reply.screenshot({ path: path.join(artifact, `${theme}-${width}-compact-markdown.png`) });
    const spacing = await reply.evaluate((element) => {
      const list = element.querySelector('ul')!;
      const [first, second] = list.querySelectorAll('li');
      const typography = (selector: string) => {
        const { fontSize, fontWeight, lineHeight } = getComputedStyle(
          element.querySelector(selector)!,
        );
        return [fontSize, fontWeight, Math.round(parseFloat(lineHeight) * 100) / 100];
      };
      return {
        prose: typography('p'),
        heading: typography('h1'),
        label: typography('strong'),
        inlineCode: typography('code')[0],
        codeBlock: typography('pre'),
        quote: typography('blockquote p'),
        table: typography('td'),
        block:
          list.getBoundingClientRect().top -
          list.previousElementSibling!.getBoundingClientRect().bottom,
        item: second!.getBoundingClientRect().top - first!.getBoundingClientRect().bottom,
        fits: element.scrollWidth <= element.clientWidth,
      };
    });
    assert.deepEqual(spacing, {
      prose: ['14px', '430', 22.75],
      heading: ['21px', '600', 28],
      label: ['14px', '600', 22.75],
      inlineCode: '12.88px',
      codeBlock: ['12px', '400', 20],
      quote: ['14px', '400', 22.75],
      table: ['14px', '430', 22.75],
      block: 12,
      item: 2,
      fits: true,
    });
    const table = reply.getByRole('region', { name: '表格' });
    const tableStyle = await table.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        frame: [style.borderTop, style.borderRight, style.borderBottom, style.borderLeft],
        radius: parseFloat(style.borderTopLeftRadius),
        column: getComputedStyle(element.querySelector('th + th')!).borderInlineStartWidth,
        headerRule: getComputedStyle(element.querySelector('thead th')!).borderBlockEnd,
        rowRule: getComputedStyle(element.querySelector('tbody tr + tr td')!).borderBlockStart,
        overflow: style.overflowX,
      };
    });
    assert.ok(tableStyle.frame.every((edge) => edge.startsWith('1px solid ')));
    assert.ok(tableStyle.radius > 0);
    assert.equal(tableStyle.column, '0px');
    assert.ok(tableStyle.headerRule.startsWith('1px solid '));
    assert.equal(tableStyle.headerRule, tableStyle.rowRule);
    assert.equal(tableStyle.overflow, 'auto');

    const sidebarRows = page.locator('.primary-navigation .button, .space-row');
    const sidebarAlignment = await sidebarRows.evaluateAll((rows) =>
      rows.map((row) => {
        const label = row.querySelector('.nav-copy strong') ?? row.querySelector(':scope > span')!;
        const icon = row.querySelector(':scope > svg')!;
        const center = ({ top, height }: DOMRect) => top + height / 2;
        return {
          label: label.textContent,
          offset: center(label.getBoundingClientRect()) - center(icon.getBoundingClientRect()),
        };
      }),
    );
    assert.deepEqual(sidebarAlignment, [
      { label: '新对话', offset: 0 },
      { label: '定时任务', offset: 0 },
      { label: 'Workspace', offset: 0 },
    ]);
    const space = page.locator('.space-row');
    await space.click();
    assert.equal(await space.getAttribute('aria-expanded'), 'false');
    await space.click();
    assert.equal(await space.getAttribute('aria-expanded'), 'true');
    await page.getByRole('button', { name: '新对话', exact: true }).hover();
    await page.locator('.client-sidebar-panel').screenshot({
      path: path.join(artifact, `${theme}-${width}-sidebar-alignment.png`),
    });

    await page.getByRole('button', { name: '用户菜单', exact: true }).click();
    const settings = page.getByRole('menuitem', { name: '设置', exact: true });
    assert.equal(await settings.evaluate((node) => getComputedStyle(node).fontFamily), sans);
    await settings.click();
    const settingsHeading = page.locator('.desktop-settings-dialog .settings-page-heading').first();
    await settingsHeading.waitFor();
    assert.equal(await settingsHeading.evaluate((node) => getComputedStyle(node).fontFamily), sans);
    const settingsNavigation = page.getByRole('navigation', { name: '设置分类', exact: true });
    const alignment = await settingsNavigation.getByRole('button').evaluateAll((buttons) => {
      const center = ({ y, height }: DOMRect) => y + height / 2;
      return buttons.map((button) => ({
        label: button.textContent?.trim(),
        offset:
          center(button.querySelector(':scope > svg')!.getBoundingClientRect()) -
          center(button.querySelector(':scope > span')!.getBoundingClientRect()),
      }));
    });
    assert.ok(alignment.length > 0);
    assert.ok(
      alignment.every(({ offset }) => Math.abs(offset) <= 1),
      JSON.stringify(alignment),
    );
    results.push({ alignment });
    await page.screenshot({
      path: path.join(artifact, `${theme}-${width}-system-font-settings.png`),
    });
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await reply.getByText('会提前返回的情况', { exact: true }).waitFor();

    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    const headers = Array.from({ length: 12 }, (_, index) => `FIELD_${index + 1}`);
    const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const wideSource = [row(headers), row(headers.map(() => '---')), row(headers)].join('\n');
    await input.fill(wideSource);
    await input.press('Enter');
    for (const name of ['确认受理', '保存用户消息', '完成回复'])
      await page.getByRole('button', { name, exact: true }).click();
    await reply.getByRole('table').waitFor();
    await table.focus();
    const wideLayout = await table.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
      focused: document.activeElement === element,
      readable: [...element.querySelectorAll('th')].every((cell) => {
        const style = getComputedStyle(cell);
        return cell.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 15;
      }),
    }));
    assert.ok(
      wideLayout.scroll > wideLayout.client && wideLayout.focused && wideLayout.readable,
      JSON.stringify(wideLayout),
    );
    await table.press('ArrowRight');
    await page.waitForFunction(() => {
      const table = document.querySelector('.message.assistant .markdown-table-scroll');
      return !!table && table === document.activeElement && table.scrollLeft > 0;
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await table.screenshot({ path: path.join(artifact, `${theme}-${width}-wide-table.png`) });

    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    const source = `# 长消息\n\n${'需要完整保留的正文。\n\n'.repeat(25)}`;
    await page.locator('textarea.prompt-editor').fill(source);
    await page.locator('textarea.prompt-editor').press('Enter');
    await page.getByRole('button', { name: '展开用户消息', exact: true }).waitFor();
    await page.getByRole('button', { name: '结果未知', exact: true }).click();
    const alert = page.locator('.message.user .delivery-status');
    await alert.waitFor();
    assert.match(await alert.innerText(), /发送结果尚未确认/);
    assert.equal(await promptText(page.locator('.prompt-editor')), source);
    const statusBounds = await alert.boundingBox();
    const cropBounds = await page.locator('.message.user .prompt-markdown').boundingBox();
    assert.ok(statusBounds!.y >= cropBounds!.y + cropBounds!.height);
    await page.setViewportSize({ width, height: 560 });
    await page.waitForFunction(() => {
      const crop = document.querySelector('.message.user .prompt-markdown-viewport');
      return crop?.getBoundingClientRect().height === 264;
    });
    await page.screenshot({ path: path.join(artifact, `${theme}-${width}-collapsed-unknown.png`) });
  } finally {
    await page.close();
  }
  return results;
}
async function verifySendingInput(theme: 'light' | 'dark', width: number) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
  await page.addInitScript((theme) => localStorage.setItem('kite.desktop.theme', theme), theme);
  const observations = [];
  try {
    await page.goto(server.url.toString());
    for (const first of [false, true]) {
      if (first) {
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.locator('[data-model-trigger]').click();
        await page
          .getByRole('button', { name: /^选择模型，当前 / })
          .first()
          .click();
        await page.locator('[aria-label="选择模型 model-a"]').click();
        await page.locator('[aria-label="模型与思考程度"]').press('Escape');
        const picker = page.locator('[aria-label="模型与思考程度"]');
        if (await picker.isVisible()) await picker.press('Escape');
        await picker.waitFor({ state: 'detached' });
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      }
      const input = page.locator('textarea.prompt-editor');
      const source = first ? '新会话首条消息' : '已有会话的新消息';
      const next = first ? '首条发送等待时继续输入 雪🙂' : '下一条草稿 雪🙂';
      await input.fill(source);
      await page.locator('.composer-action:not([disabled])').waitFor();
      await input.press('End');
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const original = document.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
        const state = { observing: true, frames: [] as unknown[] };
        Object.assign(window, { inputSendingObservation: state });
        const frame = () => {
          const input = document.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
          const form = input.closest('form')!,
            style = getComputedStyle(input),
            formStyle = getComputedStyle(form);
          state.frames.push({
            same: input === original,
            value: input.value,
            disabled: input.disabled,
            readOnly: input.readOnly,
            focused: document.activeElement === input,
            opacity: style.opacity,
            border: formStyle.borderColor,
            shadow: formStyle.boxShadow,
            height: input.getBoundingClientRect().height,
            display: formStyle.display,
            visibility: formStyle.visibility,
          });
          if (state.observing) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      const beforePosts = await page.evaluate(() => window.promptSendFixture.posts.length);
      await input.press('Enter');
      await page.locator('.composer-action[aria-busy="true"]').waitFor();
      assert.equal(await input.isEnabled(), true);
      assert.equal(await input.getAttribute('readonly'), null);
      await input.press('Control+a');
      await page.keyboard.insertText(next);
      await input.press('Enter');
      await page.evaluate(() =>
        document.querySelector<HTMLFormElement>('form.composer')!.requestSubmit(),
      );
      assert.equal(
        await page.evaluate(() => window.promptSendFixture.posts.length),
        beforePosts + 1,
      );
      assert.equal(await promptText(input), next);
      await page.screenshot({
        path: path.join(
          artifact,
          `${theme}-${width}-${first ? 'first' : 'existing'}-input-sending.png`,
        ),
      });
      await page.evaluate(() => window.promptSendFixture.accept());
      await page.locator('textarea[aria-label="当前会话私有草稿"]').waitFor();
      await page.locator('.composer-action:not([aria-busy])').waitFor();
      assert.equal(await promptText(input), next);
      await page.evaluate(() => window.promptSendFixture.save());
      await page.evaluate(() => window.promptSendFixture.reply());
      await page.locator('.message.assistant').last().waitFor();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const frames = await page.evaluate(() => {
        const state = (
          window as unknown as {
            inputSendingObservation: {
              observing: boolean;
              frames: {
                same: boolean;
                value: string;
                disabled: boolean;
                readOnly: boolean;
                focused: boolean;
                opacity: string;
                border: string;
                shadow: string;
                height: number;
                display: string;
                visibility: string;
              }[];
            };
          }
        ).inputSendingObservation;
        state.observing = false;
        return state.frames;
      });
      await Bun.write(
        path.join(artifact, `${theme}-${width}-${first ? 'first' : 'existing'}-input-frames.json`),
        JSON.stringify(frames, null, 2),
      );
      assert.ok(frames.length > 1);
      assert.ok(
        frames.every(
          (frame) =>
            frame.same &&
            !frame.disabled &&
            frame.opacity === '1' &&
            frame.display === 'flex' &&
            frame.visibility === 'visible',
        ),
        'sending preserves the native control and its appearance',
      );
      assert.ok(
        frames.every((frame) => frame.focused),
        'keyboard sending retains input focus through acknowledgement and history',
      );
      assert.equal(new Set(frames.map((frame) => frame.border)).size, 1, 'no focus-border flash');
      assert.equal(new Set(frames.map((frame) => frame.shadow)).size, 1, 'no focus-ring flash');
      await page.screenshot({
        path: path.join(
          artifact,
          `${theme}-${width}-${first ? 'first' : 'existing'}-input-accepted.png`,
        ),
      });
      await page.locator('.composer-action:not([disabled])').waitFor();
      await input.press('Enter');
      await page.locator('.composer-action[aria-busy="true"]').waitFor();
      assert.equal(await input.isEnabled(), true);
      assert.equal(await input.getAttribute('readonly'), null);
      assert.equal(
        await page.evaluate(() => window.promptSendFixture.posts.length),
        beforePosts + 2,
      );
      assert.equal(
        await page.evaluate(() => {
          const sent = window.promptSendFixture.posts.at(-1);
          return sent && 'intent' in sent && 'content' in sent.intent
            ? sent.intent.content
            : undefined;
        }),
        next,
      );
      await page.evaluate(() => window.promptSendFixture.accept());
      await page.waitForFunction(
        () => document.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')?.value === '',
      );
      await page.evaluate(() => window.promptSendFixture.save());
      await page.evaluate(() => window.promptSendFixture.reply());
      await page.locator('.composer-action:not([aria-busy])').waitFor();
      assert.equal(
        await page.evaluate(() => window.promptSendFixture.posts.length),
        beforePosts + 2,
      );
      observations.push({ first, frames });
    }
  } finally {
    await page.close();
  }
  return observations;
}
try {
  for (const theme of ['light', 'dark'] as const)
    for (const width of [1280, 800]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((theme) => {
        localStorage.setItem('kite.desktop.theme', theme);
        const observation = {
          frames: [] as { width: number; height: number; top: number; image: boolean }[],
          start: performance.now(),
        };
        Object.assign(window, { coldPromptObservation: observation });
        const frame = () => {
          const body = document.querySelector('.message.user .prompt-markdown'),
            bounds = body?.getBoundingClientRect();
          if (bounds)
            observation.frames.push({
              width: bounds.width,
              height: bounds.height,
              top: bounds.top,
              image: !!body?.querySelector('.markdown-diagram img'),
            });
          if (performance.now() - observation.start < 5000) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, theme);
      await page.goto(server.url.toString());
      const input = page.locator('textarea.prompt-editor');
      await input.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const original = await page.evaluate(() => window.promptSendFixture.sample);
      assert.equal(await promptText(input), original);
      assert.equal(await input.locator('h1, table, img, pre').count(), 0);
      assert.equal(await page.locator('.milkdown, .ProseMirror, [contenteditable]').count(), 0);
      // The shared native control must retire another Session's undo, even for equal text.
      await page.getByRole('button', { name: 'Session B', exact: true }).click();
      await input.fill('相同草稿');
      await page.getByRole('button', { name: 'Session A', exact: true }).click();
      await input.fill('之前的私有草稿');
      await input.press('Control+a');
      await page.keyboard.insertText('相同草稿');
      await page.getByRole('button', { name: 'Session B', exact: true }).click();
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea.prompt-editor');
        return input?.value === '相同草稿' && !input.readOnly;
      });
      await input.press('Control+z');
      assert.equal(await promptText(input), '相同草稿');
      await page.getByRole('button', { name: 'Session A', exact: true }).click();
      await input.fill(original);
      await input.press('Control+a');
      await page.keyboard.insertText('临时替换样本');
      await input.press('Control+z');
      assert.equal(await promptText(input), original);
      await input.press('Control+y');
      assert.equal(await promptText(input), '临时替换样本');
      const edited = original.replace('| 12 |', '| 36 |');
      await input.fill(edited);
      await input.press('Control+End');
      await input.press('Shift+Enter');
      assert.equal(await promptText(input), `${edited}\n`);
      const ime = await page.context().newCDPSession(page);
      await ime.send('Input.imeSetComposition', { text: 'ni', selectionStart: 0, selectionEnd: 2 });
      assert.equal(await page.evaluate(() => window.promptSendFixture.posts.length), 0);
      await page.screenshot({ path: path.join(artifact, `${theme}-${width}-composing.png`) });
      await ime.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
      await ime.send('Input.insertText', { text: '你好' });
      const composed = await promptText(input);
      assert.equal(composed, `${edited}\n你好`);
      await ime.send('Input.imeSetComposition', {
        text: '取消',
        selectionStart: 0,
        selectionEnd: 2,
      });
      await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      assert.equal(await promptText(input), composed);
      await ime.detach();
      const source = await promptText(input);
      assert.equal(await input.locator('table, h1').count(), 0, 'draft remains plain text');

      const label = `${theme}-${width}`;
      await page.screenshot({ path: path.join(artifact, `${label}-draft.png`) });
      await page.evaluate(() => {
        const state = {
          observing: true,
          frames: [] as { width: number; height: number; image: boolean }[],
        };
        Object.assign(window, { promptInitialCapture: state });
        const frame = () => {
          const body = document.querySelector('.message.user .prompt-markdown');
          if (body) {
            const bounds = body.getBoundingClientRect();
            state.frames.push({
              width: bounds.width,
              height: bounds.height,
              image: !!body.querySelector('.markdown-diagram img'),
            });
          }
          if (state.observing) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      if (width === 1280) await input.press('Enter');
      else await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
      await page.locator('.message.user .prompt-markdown h1').waitFor();
      await page.screenshot({ path: path.join(artifact, `${label}-initial-render.png`) });
      await page.locator('.message.user .markdown-diagram img').waitFor();
      const initial = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const state = (
          window as unknown as {
            promptInitialCapture: {
              observing: boolean;
              frames: { width: number; height: number; image: boolean }[];
            };
          }
        ).promptInitialCapture;
        state.observing = false;
        return state.frames;
      });
      assert.ok(initial.length > 0);
      assert.equal(
        new Set(initial.map((frame) => `${frame.width},${frame.height}`)).size,
        1,
        'first message render and graph preparation retain dimensions',
      );
      assert.equal(
        await page.evaluate(() => {
          const last = window.promptSendFixture.posts.at(-1);
          return last?.method === 'submit' ? last.intent.content : undefined;
        }),
        source.trimEnd(),
      );
      const userBody = page.locator('.message.user .user-message-body');
      assert.equal((await userBody.boundingBox())?.height, 360);
      const expand = page.getByRole('button', { name: '展开用户消息', exact: true });
      await expand.waitFor();
      assert.equal(await expand.getAttribute('aria-expanded'), 'false');
      assert.notEqual(
        await page
          .locator('.message.user .prompt-markdown-controls')
          .evaluate((e) => getComputedStyle(e).boxShadow),
        'none',
      );
      await page.screenshot({ path: path.join(artifact, `${label}-collapsed.png`) });
      await expand.click();
      assert.ok((await userBody.boundingBox())!.height > 360);
      await page.screenshot({ path: path.join(artifact, `${label}-expanded.png`) });
      await page.evaluate(() => {
        const body = document.querySelector('.message.user .prompt-markdown')!;
        const article = body.closest('.message.user')!;
        const frames: unknown[] = [];
        const mutation = { count: 0 };
        const observer = new MutationObserver((records) => {
          mutation.count += records.length;
        });
        observer.observe(body, { childList: true, subtree: true, characterData: true });
        const state = { observing: true, body, article, frames, mutation, observer };
        Object.assign(window, { promptCapture: state });
        const frame = () => {
          if (!state.observing) return;
          const current = document.querySelector('.message.user .prompt-markdown');
          const bounds = current?.getBoundingClientRect();
          frames.push({
            height: bounds?.height,
            width: bounds?.width,
            left: bounds?.left,
            sameBody: current === body,
            sameArticle: current?.closest('.message.user') === article,
            count: document.querySelectorAll('.message.user').length,
            opacity: getComputedStyle(article).opacity,
            text: current?.textContent,
          });
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      const sent = await captureMarkdown(page.locator('.message.user .typeset-chat'));
      assert.equal(await page.locator('.message.user td').nth(1).innerText(), '36');
      await page.screenshot({ path: path.join(artifact, `${label}-sending.png`) });
      await page.evaluate(() => window.promptSendFixture.accept());
      await page.waitForFunction(
        () => document.querySelector('.message.user')?.classList.contains('sending') === false,
      );
      await page.screenshot({ path: path.join(artifact, `${label}-accepted.png`) });
      await page.evaluate(() => window.promptSendFixture.save());
      await page.locator('[data-message-id^="saved-"]').waitFor();
      await page.screenshot({ path: path.join(artifact, `${label}-saved.png`) });
      await page.evaluate(() => window.promptSendFixture.refresh());
      await page.evaluate(() => window.promptSendFixture.reply());
      await page.locator('.message.assistant table').waitFor();
      await page.locator('.message.assistant .markdown-diagram img').waitFor();
      assert.deepEqual(
        await captureMarkdown(page.locator('.message.assistant .typeset-chat')),
        sent,
        'Agent replies use the same grammar and typography',
      );
      assert.equal(
        await page
          .getByText('无法确认此会话首次运行的模型协议，暂时无法发送。', { exact: true })
          .count(),
        0,
      );
      const capture = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const state = (
          window as unknown as {
            promptCapture: {
              observing: boolean;
              observer: MutationObserver;
              frames: {
                height: number;
                width: number;
                left: number;
                sameBody: boolean;
                sameArticle: boolean;
                count: number;
                opacity: string;
                text: string;
              }[];
              mutation: { count: number };
            };
          }
        ).promptCapture;
        state.observing = false;
        state.observer.disconnect();
        return { frames: state.frames, mutations: state.mutation.count };
      });
      assert.ok(capture.frames.length > 3);
      assert.ok(
        capture.frames.every(
          (frame) =>
            frame.sameBody && frame.sameArticle && frame.count === 1 && frame.opacity === '1',
        ),
      );
      assert.equal(
        new Set(capture.frames.map((frame) => `${frame.height},${frame.width},${frame.left}`)).size,
        1,
        'no reflow while the receipt and saved history take over',
      );
      assert.equal(new Set(capture.frames.map((frame) => frame.text)).size, 1);
      assert.equal(capture.mutations, 0);
      await page.getByRole('button', { name: 'Session B', exact: true }).click();
      await page.locator('textarea.prompt-editor:not([readonly])').waitFor();
      await page.getByRole('button', { name: 'Session A', exact: true }).click();
      await page.locator('[data-message-id^="saved-"] .prompt-markdown').waitFor();
      assert.equal(
        await page.locator('.message.user .prompt-markdown').getAttribute('data-expanded'),
        'true',
      );
      assert.equal(
        (await captureMarkdown(page.locator('.message.user .typeset-chat'))).html,
        sent.html,
      );
      assert.equal(await page.evaluate(() => window.promptSendFixture.posts.length), 1);
      await page.screenshot({ path: path.join(artifact, `${label}-returned.png`) });
      await page.reload();
      await page.locator('.message.user .markdown-diagram img').waitFor();
      await page.locator('.message.assistant .markdown-diagram img').waitFor();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const cold = await page.evaluate(
        () =>
          (
            window as unknown as {
              coldPromptObservation: {
                frames: { width: number; height: number; top: number; image: boolean }[];
              };
            }
          ).coldPromptObservation.frames,
      );
      assert.ok(cold.length > 1);
      assert.equal(
        new Set(cold.map((frame) => `${frame.width},${frame.height},${frame.top}`)).size,
        1,
        'cold source-to-image rendering preserves body dimensions and reading position',
      );
      assert.equal(await page.locator('.message.user').count(), 1);
      assert.equal(await page.evaluate(() => window.promptSendFixture.posts.length), 1);
      assert.equal(await promptText(page.locator('.prompt-editor')), '');
      assert.equal(
        await page
          .getByRole('button', { name: '展开用户消息', exact: true })
          .getAttribute('aria-expanded'),
        'false',
      );
      assert.equal(
        (await page.locator('.message.user .user-message-body').boundingBox())?.height,
        360,
      );
      assert.equal(
        (await captureMarkdown(page.locator('.message.user .typeset-chat'))).html,
        sent.html,
      );
      await page.screenshot({ path: path.join(artifact, `${label}-reopened.png`) });
      await page.getByRole('button', { name: '展开用户消息', exact: true }).press('Enter');
      await page.getByRole('button', { name: '收起用户消息', exact: true }).click();
      assert.equal(
        (await page.locator('.message.user .user-message-body').boundingBox())?.height,
        360,
      );
      assert.equal(
        await page
          .getByRole('button', { name: '展开用户消息', exact: true })
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.locator('.message.user .file-link').focus();
      await page.waitForFunction(
        () =>
          document
            .querySelector('.message.user .prompt-markdown')
            ?.getAttribute('data-expanded') === 'true',
      );
      const focused = await page.locator('.message.user .file-link').boundingBox();
      assert.ok(focused!.y >= 0 && focused!.y + focused!.height <= 1000);
      assert.deepEqual(errors, []);
      await page.close();
      const edges = await verifyMarkdownEdges(theme, width);
      const inputSending = await verifySendingInput(theme, width);
      cases.push({ theme, width, initial, capture, cold, edges, inputSending });
    }
  await Bun.write(
    path.join(artifact, 'report.json'),
    JSON.stringify({ browser: browser.version(), cases }, null, 2),
  );
  console.log(JSON.stringify({ passed: cases.length, artifact }));
} finally {
  await browser.close();
  server.stop(true);
}
