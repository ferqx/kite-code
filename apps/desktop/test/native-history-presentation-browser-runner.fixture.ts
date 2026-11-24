import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Locator } from 'playwright';
import { build } from 'vite';
import type {
  HistoryPresentationFixture,
  PresentationEvent,
  PresentationPhase,
} from './native-history-presentation-browser.fixture';

type MessageFrame = {
  node: number;
  text: string;
  height: number;
  top: number;
  final: string | null;
};
type Frame = {
  time: number;
  phase: string;
  title: string | null;
  loading: boolean;
  welcome: boolean;
  scrollTop: number | null;
  scrollHeight: number | null;
  padding: string | null;
  width: number | null;
  height: number | null;
  left: number | null;
  footer: number[] | null;
  messages: MessageFrame[];
  turns: {
    node: number;
    height: number;
    expanded: string | null;
    summaryTag: string | null;
    staticSummary: boolean;
    processToggles: number;
  }[];
  animations: string[];
};
type Variant = {
  mode: 'initial' | 'switch';
  turns: number;
  width: number;
  order: readonly PresentationPhase[];
  viewAll?: boolean;
  theme?: 'light' | 'dark';
  reducedMotion?: 'no-preference' | 'reduce';
};
type CaseReport = Variant & {
  label: string;
  errors: string[];
  finalTurns: number;
  finalReplies: number;
  screenshotFrames: number;
  frames: Frame[];
  events: PresentationEvent[];
  pending: ReturnType<HistoryPresentationFixture['pending']>;
  cachedOriginal?: number[];
  cachedReturned?: number[];
};
type OutputFrame = {
  phase: 'cold' | 'slow' | 'warm' | 'live';
  time: number;
  node: number;
  pending: boolean;
  visible: boolean;
  files: string[];
  bottom: number;
};
type HistoricalOutputFrame = {
  sameCard: boolean;
  top: number;
  height: number;
  scrollTop: number;
};

async function assertOutputSpacing(reply: Locator, lastBlockSelector: string) {
  const spacing = await reply.evaluate((article, selector) => {
    const markdown = article.querySelector('.typeset-chat')!;
    const lastBlock = markdown.lastElementChild;
    if (!lastBlock?.matches(selector)) throw Error(`Expected ${selector} before the attachments`);
    const files = article
      .querySelector(':scope > .turn-output-files > ul')!
      .getBoundingClientRect();
    const footer = article.querySelector(':scope > .message-meta')!.getBoundingClientRect();
    const textStyle = getComputedStyle(markdown);
    return {
      above: files.top - lastBlock.getBoundingClientRect().bottom,
      below: footer.top - files.bottom,
      fontSize: parseFloat(textStyle.fontSize),
      trim: textStyle.getPropertyValue('text-box-trim'),
    };
  }, lastBlockSelector);
  assert.equal(spacing.trim, 'trim-end');
  assert.ok(Math.abs(spacing.above - spacing.fontSize * 1.6) < 0.1, JSON.stringify(spacing));
  assert.ok(Math.abs(spacing.below - spacing.fontSize * 0.8) < 0.1, JSON.stringify(spacing));
  return spacing.above;
}

function messageFooterOpacity(message: Locator) {
  return message.locator(':scope > .message-meta').evaluate(async (footer) => {
    await Promise.all(footer.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(footer).opacity;
  });
}

declare global {
  interface Window {
    historyPresentationFrames: Frame[];
    historyPresentationPhase: string;
    outputFrames: OutputFrame[];
    outputPhase: OutputFrame['phase'];
    stopHistoricalOutputFrames: () => HistoricalOutputFrame[];
  }
}

const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'native-history-presentation-'));
const output = path.join(artifact, 'dist');
const frameDirectory = path.join(artifact, 'frames');
mkdirSync(frameDirectory);
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
    target: 'esnext',
    lib: {
      entry: path.join(directory, 'native-history-presentation-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
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
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });
const report = {
  browser: browser.version(),
  cases: [] as CaseReport[],
  outputPresentation: [] as {
    theme: string;
    frames: OutputFrame[];
    events: PresentationEvent[];
    historicalFrames: HistoricalOutputFrame[];
    failedReadFrames: OutputFrame[];
  }[],
};
const outputsOnly = process.argv.includes('--turn-outputs');
const navigationOnly = process.argv.includes('--message-navigation');
const variants: Variant[] = [
  { mode: 'initial', turns: 4, width: 1320, order: ['runs', 'tools'] },
  { mode: 'initial', turns: 4, width: 1440, order: ['tools', 'runs'], theme: 'dark' },
  { mode: 'switch', turns: 4, width: 1280, order: ['runs', 'tools'] },
  { mode: 'switch', turns: 4, width: 1320, order: ['tools', 'runs'], theme: 'dark' },
  { mode: 'switch', turns: 4, width: 1440, order: ['runs', 'tools'], viewAll: true },
  { mode: 'switch', turns: 40, width: 1440, order: ['tools', 'runs'], reducedMotion: 'reduce' },
];
try {
  if (navigationOnly) {
    const page = await browser.newPage({
      viewport: { width: 1360, height: 1600 },
      colorScheme: 'dark',
    });
    const navigation = page.getByRole('navigation', { name: '会话消息导航' });
    const viewport = page.locator('.conversation-viewport');
    const overflow = () => viewport.evaluate((node) => node.scrollHeight > node.clientHeight);
    await page.goto(new URL('?mode=switch&turns=2&viewAll=true', server.url).href);
    await page.getByText('SESSION-A 第 2 轮：检查会话渲染', { exact: true }).waitFor();
    assert.equal(await overflow(), false);
    assert.equal(await navigation.count(), 0);
    await page.setViewportSize({ width: 1360, height: 420 });
    await navigation.waitFor();
    assert.equal(await overflow(), true);
    await page.setViewportSize({ width: 1360, height: 1600 });
    await navigation.waitFor({ state: 'detached' });
    assert.equal(await overflow(), false);

    await page.setViewportSize({ width: 1360, height: 700 });
    await page.goto(new URL('?mode=switch&turns=40&viewAll=true', server.url).href);
    const last = navigation.getByRole('button', { name: /^第 40 条已加载的用户消息/ });
    await last.waitFor({ state: 'attached' });
    assert.equal(await navigation.getByRole('button').count(), 40);
    const list = navigation.locator('.conversation-marker-list');
    const sizes = await list.evaluate((node) => {
      const rail = node.closest('nav')!;
      const style = getComputedStyle(rail);
      const limits = parseFloat(style.top) + parseFloat(style.bottom);
      const available = rail.parentElement!.clientHeight - limits;
      return {
        height: rail.getBoundingClientRect().height,
        available,
        mask: getComputedStyle(node).maskImage,
        scrollbar: getComputedStyle(node).scrollbarWidth,
        overflow: node.scrollHeight - node.clientHeight,
      };
    });
    assert.ok(Math.abs(sizes.height - sizes.available / 2) < 1, JSON.stringify(sizes));
    assert.notEqual(sizes.mask, 'none');
    assert.equal(sizes.scrollbar, 'none');
    assert.ok(sizes.overflow > 0);
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.getByRole('button', { name: '回到最新消息' }).waitFor();
    const first = navigation.getByRole('button', { name: /^第 1 条已加载的用户消息/ });
    const initialScroll = await viewport.evaluate((node) => node.scrollTop);
    await first.press('End');
    assert.ok(await list.evaluate((node) => node.scrollTop > 0));
    await last.press('Home');
    assert.equal(await list.evaluate((node) => node.scrollTop), 0);
    await list.hover();
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(
      () => (document.querySelector('.conversation-marker-list')?.scrollTop ?? 0) > 0,
    );
    assert.equal(await viewport.evaluate((node) => node.scrollTop), initialScroll);
    await page.screenshot({ path: path.join(artifact, 'message-navigation.png') });
    await page.close();
  }
  if (outputsOnly) {
    for (const theme of ['dark', 'light'] as const) {
      const page = await browser.newPage({
        viewport: { width: 1360, height: 900 },
        colorScheme: theme,
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.outputFrames = [];
        window.outputPhase = 'cold';
        const nodes = new WeakMap<Element, number>();
        let next = 1;
        function sample() {
          const phase = window.outputPhase;
          const marker = {
            cold: 'REPLY-a-1',
            slow: 'REPLY-b-1',
            warm: 'REPLY-a-1',
            live: 'LIVE-REPLY-a',
          }[phase];
          const replies = [...document.querySelectorAll('.agent-turn-final .message.assistant')];
          const reply = replies.find(
            (candidate) =>
              candidate.textContent?.includes(marker) && candidate.getClientRects().length > 0,
          );
          const viewport = reply?.closest('.conversation-viewport');
          if (reply && viewport) {
            if (!nodes.has(reply)) nodes.set(reply, next++);
            window.outputFrames.push({
              phase,
              time: performance.now(),
              node: nodes.get(reply)!,
              pending: !!reply.querySelector('[data-turn-outputs-pending]'),
              visible: getComputedStyle(reply).visibility === 'visible',
              files: [...reply.querySelectorAll('.output-file-name')].map(
                (node) => node.textContent ?? '',
              ),
              bottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
            });
          }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      await page.goto(new URL('?mode=switch&turns=2&viewAll=true&turnOutputs=1', server.url).href);
      const first = page
        .locator('.agent-turn-final .message.assistant')
        .filter({ hasText: 'REPLY-a-1' });
      const firstFile = first.locator('.output-file-card');
      await firstFile.waitFor();
      assert.equal(await messageFooterOpacity(first), '1');
      const afterList = await assertOutputSpacing(first, 'ul');
      const blockGaps = await first.evaluate((reply) => {
        const turn = reply.closest('.conversation-trace-turn')!;
        const summary = turn.querySelector(':scope > .agent-turn-summary-row > button')!;
        const firstBody = turn.querySelector(':scope > .agent-turn-body .typeset-chat')!;
        const markdown = reply.querySelector('.typeset-chat')!;
        const [paragraph, nextParagraph, bullets] = markdown.children;
        const gap = (before: Element, after: Element) =>
          after.getBoundingClientRect().top - before.getBoundingClientRect().bottom;
        return {
          expected: parseFloat(getComputedStyle(markdown).fontSize) * 0.8,
          measured: {
            summaryToText: gap(summary, firstBody),
            betweenParagraphs: gap(paragraph!, nextParagraph!),
            paragraphToBullets: gap(nextParagraph!, bullets!),
          },
        };
      });
      for (const [section, gap] of Object.entries(blockGaps.measured)) {
        assert.ok(
          Math.abs(gap - blockGaps.expected) < 0.1,
          `${theme} ${section}: expected ${blockGaps.expected}px, got ${gap}px`,
        );
      }
      const rowPaint = () =>
        firstFile.evaluate((row) => {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.fillStyle = getComputedStyle(row.parentElement!).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(row).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        });
      await page.mouse.move(0, 0);
      const restingPaint = await rowPaint();
      const actions = firstFile.getByRole('group', { name: 'Output-a.pptx' });
      const menuTrigger = actions.getByRole('button', { name: /更多操作/ });
      const open = actions.getByRole('button', { name: /^打开 / });
      const fileLabel = firstFile.getByRole('button', { name: /^预览 / });
      const nameBounds = await fileLabel.locator('.output-file-name').boundingBox();
      const typeBounds = await fileLabel.getByText('PPT 演示文稿', { exact: true }).boundingBox();
      const iconBounds = await fileLabel.locator('.output-file-icon').boundingBox();
      assert.ok(nameBounds && typeBounds && iconBounds);
      assert.equal(nameBounds.x, typeBounds.x);
      assert.ok(typeBounds.y - nameBounds.y - nameBounds.height >= 3);
      assert.ok(nameBounds.x - iconBounds.x - iconBounds.width >= 9);
      assert.deepEqual([iconBounds.width, iconBounds.height], [24, 24]);
      await firstFile.screenshot({ path: path.join(artifact, `outputs-${theme}-row.png`) });
      const actionPaint = () =>
        actions.evaluate((element) => getComputedStyle(element).backgroundColor);
      const buttonPaints = () =>
        actions.evaluate((group) =>
          [...group.querySelectorAll('button')].map(
            (button) => getComputedStyle(button).backgroundColor,
          ),
        );
      const restingActions = await actionPaint();
      const restingButtons = await buttonPaints();
      const openBounds = await open.boundingBox();
      const menuBounds = await menuTrigger.boundingBox();
      assert.ok(openBounds && menuBounds);
      assert.ok(Math.abs(openBounds.x + openBounds.width - menuBounds.x) < 1);
      assert.equal(openBounds.y, menuBounds.y);
      assert.equal(openBounds.height, menuBounds.height);
      assert.equal(menuBounds.width, menuBounds.height);
      assert.equal(await open.getAttribute('data-variant'), 'outline');
      assert.equal(await menuTrigger.getAttribute('data-variant'), 'outline');
      assert.equal(
        await open.evaluate((element) => getComputedStyle(element).borderInlineEndWidth),
        '1px',
      );
      assert.equal(
        await menuTrigger.evaluate((element) => getComputedStyle(element).borderInlineStartWidth),
        '0px',
      );
      await actions.screenshot({ path: path.join(artifact, `outputs-${theme}-actions.png`) });
      await fileLabel.hover();
      const hoveredPaint = await rowPaint();
      assert.notDeepEqual(hoveredPaint, restingPaint, `${theme} output row hover must be visible`);
      assert.deepEqual(await buttonPaints(), restingButtons);
      assert.equal(await actionPaint(), restingActions);
      await open.hover({ position: { x: 2, y: openBounds.height / 2 } });
      assert.deepEqual(await rowPaint(), restingPaint);
      const openHover = await buttonPaints();
      assert.notEqual(openHover[0], restingButtons[0]);
      assert.equal(openHover[1], restingButtons[1]);
      assert.equal(await actionPaint(), restingActions);
      await actions.screenshot({ path: path.join(artifact, `outputs-${theme}-open-hover.png`) });
      await menuTrigger.hover();
      assert.deepEqual(await rowPaint(), restingPaint);
      const menuHover = await buttonPaints();
      assert.equal(menuHover[0], restingButtons[0]);
      assert.notEqual(menuHover[1], restingButtons[1]);
      assert.equal(await actionPaint(), restingActions);
      await actions.screenshot({ path: path.join(artifact, `outputs-${theme}-menu-hover.png`) });
      await menuTrigger.click();
      const menu = page.getByRole('menu', { name: /更多操作/ });
      await menu.getByRole('group').getByRole('menuitem', { name: '另存为' }).waitFor();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      await fileLabel.hover();
      assert.deepEqual(await rowPaint(), hoveredPaint);
      await open.hover();
      assert.deepEqual(await rowPaint(), restingPaint);
      await page.mouse.down();
      try {
        const pressed = await open.evaluate(async (button) => {
          await Promise.all(button.getAnimations().map((animation) => animation.finished));
          return {
            active: button.matches(':active'),
            background: getComputedStyle(button).backgroundColor,
          };
        });
        assert.deepEqual(pressed, { active: true, background: openHover[0] });
        assert.equal(await actionPaint(), restingActions);
        assert.deepEqual(await rowPaint(), restingPaint);
      } finally {
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
      assert.deepEqual(await rowPaint(), restingPaint);
      assert.equal(await actionPaint(), restingActions);
      assert.deepEqual(await buttonPaints(), restingButtons);
      await fileLabel.locator('.output-file-name').hover();
      assert.deepEqual(await rowPaint(), hoveredPaint);
      assert.deepEqual(await buttonPaints(), restingButtons);
      await open.click();
      await actions.locator('.output-file-open[aria-busy="true"]').waitFor();
      const opened = await page.evaluate(() => window.historyPresentationFixture.openInAppTargets);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.sessionId, 'a');
      assert.equal(opened[0]?.fileId, 'presentation');
      assert.deepEqual(opened[0]?.locator, {
        kind: 'delivery',
        key: 'delivery/1/job/presentation',
      });
      await page.evaluate(() => window.historyPresentationFixture.finishOpenInApp());
      await actions.locator('.output-file-open[aria-busy="true"]').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.native-toast-card').count(), 0);
      await open.press('Enter');
      await actions.locator('.output-file-open[aria-busy="true"]').waitFor();
      await page.evaluate(() =>
        window.historyPresentationFixture.finishOpenInApp('output_open_in_app_failed'),
      );
      const toast = page.getByText('桌面应用未能打开文件，请检查系统默认应用', { exact: true });
      await toast.waitFor();
      await actions.locator('.output-file-open[aria-busy="true"]').waitFor({ state: 'hidden' });
      await page.locator('.native-toast-close').click();
      await toast.waitFor({ state: 'hidden' });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-cold.png`) });
      await page.evaluate(() => {
        for (const phase of ['selection', 'history', 'runs', 'tools'] as const)
          window.historyPresentationFixture.release(phase);
        window.outputPhase = 'slow';
      });
      await page.getByRole('button', { name: 'Session B', exact: true }).click();
      const second = page
        .locator('.agent-turn-final .message.assistant')
        .filter({ hasText: 'REPLY-b-1' });
      await page.waitForFunction(() => window.historyPresentationFixture.pending().outputs === 1);
      await page.waitForFunction(() => {
        const pending = window.outputFrames.find(
          (frame) => frame.phase === 'slow' && frame.pending,
        );
        return pending && performance.now() - pending.time >= 220;
      });
      assert.equal(await second.isVisible(), false);
      assert.equal(await second.locator('.output-file-card').count(), 0);
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-slow.png`) });
      await page.evaluate(() => window.historyPresentationFixture.release('outputs'));
      await second.locator('.output-file-card').waitFor();
      const afterTable = await assertOutputSpacing(second, '.markdown-table-scroll');
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-resolved.png`) });
      await page.evaluate(() => {
        window.outputPhase = 'warm';
      });
      await page.getByRole('button', { name: 'Session A', exact: true }).click();
      await first.locator('.output-file-card').waitFor();
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-warm.png`) });
      await firstFile.evaluate(async (card) => {
        const reply = card.closest('.message.assistant')!;
        const viewport = card.closest('.conversation-viewport')!;
        viewport.scrollTop -= 64;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const frames: HistoricalOutputFrame[] = [];
        function sample() {
          const rect = card.getBoundingClientRect();
          frames.push({
            sameCard: reply.querySelector('.output-file-card') === card,
            top: rect.top,
            height: rect.height,
            scrollTop: viewport.scrollTop,
          });
          animation = requestAnimationFrame(sample);
        }
        let animation = 0;
        sample();
        window.stopHistoricalOutputFrames = () => {
          cancelAnimationFrame(animation);
          return frames;
        };
      });
      await page.evaluate(() => window.historyPresentationFixture.startLiveTurn());
      await page.getByText('LIVE-STREAM-a', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.historyPresentationFixture.appendLiveReply(' 正在继续输出。');
        window.historyPresentationFixture.publishLiveOutput();
      });
      await page.getByText('LIVE-STREAM-a 正在继续输出。', { exact: true }).waitFor();
      await page.waitForFunction(
        () => window.historyPresentationFixture.pending().historicalOutputs === 1,
      );
      await page.screenshot({
        path: path.join(artifact, `outputs-${theme}-historical-refresh.png`),
      });
      await page.evaluate(() => {
        window.outputPhase = 'live';
        window.historyPresentationFixture.finishLiveTurn();
      });
      const latest = page
        .locator('.agent-turn-final .message.assistant')
        .filter({ hasText: 'LIVE-REPLY-a' });
      await page.waitForFunction(
        () => window.historyPresentationFixture.pending().liveOutputs === 1,
      );
      await latest.waitFor({ state: 'visible' });
      assert.equal(await latest.locator('.output-file-card').count(), 0);
      assert.equal(await messageFooterOpacity(latest), '1');
      assert.equal(await messageFooterOpacity(first), '0');
      await page.mouse.move(0, 0);
      assert.equal(
        await messageFooterOpacity(
          page
            .locator('.message.user')
            .filter({ hasText: 'Create an output in the current conversation' }),
        ),
        '0',
      );
      const textToFooter = await latest.evaluate((reply) => {
        const body = reply.querySelector('.typeset-chat')!;
        const footer = reply.querySelector(':scope > .message-meta')!;
        return {
          distance: footer.getBoundingClientRect().top - body.getBoundingClientRect().bottom,
          expected: parseFloat(getComputedStyle(body).fontSize) * 0.8,
        };
      });
      assert.ok(Math.abs(textToFooter.distance - textToFooter.expected) < 0.1);
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-live.png`) });
      await page.evaluate(() => {
        window.historyPresentationFixture.release('historicalOutputs');
        window.historyPresentationFixture.release('liveOutputs');
      });
      await latest.locator('.output-file-card').waitFor();
      const historicalFrames = await page.evaluate(() => window.stopHistoricalOutputFrames());
      const initialHistoricalFrame = historicalFrames[0]!;
      assert.ok(historicalFrames.length >= 8);
      assert.ok(initialHistoricalFrame.height > 0);
      assert.ok(
        historicalFrames.every(
          (frame) =>
            frame.sameCard &&
            Math.abs(frame.height - initialHistoricalFrame.height) < 1 &&
            Math.abs(frame.top - initialHistoricalFrame.top) < 1 &&
            Math.abs(frame.scrollTop - initialHistoricalFrame.scrollTop) < 1,
        ),
        JSON.stringify(historicalFrames),
      );
      assert.equal(await messageFooterOpacity(latest), '1');
      const afterParagraph = await assertOutputSpacing(latest, 'p');
      await latest.locator('.output-file-card').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-live-resolved.png`) });
      const { frames, events } = await page.evaluate(() => ({
        frames: window.outputFrames,
        events: window.historyPresentationFixture.events,
      }));
      const cold = frames.filter((frame) => frame.phase === 'cold');
      const slow = frames.filter((frame) => frame.phase === 'slow');
      const warm = frames.filter((frame) => frame.phase === 'warm');
      const live = frames.filter((frame) => frame.phase === 'live');
      assert.ok(cold.some((frame) => frame.pending && !frame.visible));
      assert.deepEqual(cold.find((frame) => frame.visible)?.files, ['Output-a.pptx']);
      assert.deepEqual(warm[0]?.files, ['Output-a.pptx']);
      assert.ok(warm[0]?.visible);
      const firstSlowReply = slow.findIndex((frame) => frame.visible);
      assert.ok(firstSlowReply > 0);
      assert.ok(slow.slice(firstSlowReply).every((frame) => frame.visible));
      assert.deepEqual(slow[firstSlowReply]?.files, ['Output-b.pptx']);
      assert.deepEqual(slow.at(-1)?.files, ['Output-b.pptx']);
      assert.ok(Math.abs(slow.at(-1)!.bottom) <= 1);
      assert.equal(new Set(slow.map((frame) => frame.node)).size, 1);
      assert.ok(live[0]?.visible);
      assert.deepEqual(live[0].files, []);
      assert.ok(live.every((frame) => frame.visible && !frame.pending));
      assert.deepEqual(live.at(-1)?.files, ['Output-live.pptx']);
      assert.equal(new Set(live.map((frame) => frame.node)).size, 1);
      assert.equal(
        events.filter((event) => event.phase === 'outputs' && event.sessionId === 'a').length,
        1,
      );
      assert.equal(
        events.filter((event) => event.kind === 'request' && event.phase === 'historicalOutputs')
          .length,
        1,
      );
      assert.equal(await page.locator('.native-toast-card').count(), 0);
      assert.deepEqual(errors, []);
      await page.goto(
        new URL('?mode=switch&turns=2&viewAll=true&turnOutputs=1&failOutputs=1', server.url).href,
      );
      await first.waitFor({ state: 'visible' });
      await first.locator('.output-file-card').waitFor();
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-recovered.png`) });
      const failedReadFrames = await page.evaluate(() => window.outputFrames);
      const firstRecoveredReply = failedReadFrames.findIndex((frame) => frame.visible);
      assert.ok(firstRecoveredReply >= 0);
      assert.deepEqual(failedReadFrames[firstRecoveredReply]?.files, []);
      assert.ok(failedReadFrames.slice(firstRecoveredReply).every((frame) => frame.visible));
      assert.deepEqual(failedReadFrames.at(-1)?.files, ['Output-a.pptx']);
      assert.deepEqual(errors, []);
      report.outputPresentation.push({ theme, frames, events, historicalFrames, failedReadFrames });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          theme,
          cold: cold.length,
          slow: slow.length,
          warm: warm.length,
          live: live.length,
          blockGaps,
          attachmentSpacing: { afterList, afterTable, afterParagraph },
        }),
      );
      await page.close();
    }
  }
  for (const variant of outputsOnly || navigationOnly ? [] : variants) {
    const label = `${variant.mode}-${variant.turns}-${variant.width}-${variant.order.join('-')}-${variant.viewAll ? 'view-all' : 'partial-view'}-${variant.theme ?? 'light'}-${variant.reducedMotion ?? 'no-preference'}`;
    const page = await browser.newPage({
      viewport: { width: variant.width, height: 1000 },
      colorScheme: variant.theme ?? 'light',
      reducedMotion: variant.reducedMotion ?? 'no-preference',
      locale: 'zh-CN',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    let screenshotFrames = 0;
    cdp.on('Page.screencastFrame', (event) => {
      writeFileSync(
        path.join(frameDirectory, `${label}-${String(screenshotFrames++).padStart(3, '0')}.jpg`),
        Buffer.from(event.data, 'base64'),
      );
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
    await page.addInitScript(() => {
      const nodes = new WeakMap<Element, number>();
      let next = 1;
      const nodeId = (element: Element) => {
        let id = nodes.get(element);
        if (id === undefined) {
          id = next++;
          nodes.set(element, id);
        }
        return id;
      };
      window.historyPresentationFrames = [];
      window.historyPresentationPhase = 'boot';
      const sample = () => {
        const viewport = document.querySelector<HTMLElement>('.conversation-viewport');
        const reading = viewport?.querySelector<HTMLElement>('.reading-column');
        const rect = reading?.getBoundingClientRect();
        const footer = document.querySelector('.conversation-footer')?.getBoundingClientRect();
        window.historyPresentationFrames.push({
          time: performance.now(),
          phase: window.historyPresentationPhase,
          title: document.querySelector('.breadcrumb strong')?.textContent ?? null,
          loading: !!document.querySelector('.conversation-loading'),
          welcome: !!document.querySelector('.welcome'),
          scrollTop: viewport?.scrollTop ?? null,
          scrollHeight: viewport?.scrollHeight ?? null,
          padding: viewport ? getComputedStyle(viewport).paddingRight : null,
          width: rect?.width ?? null,
          height: rect?.height ?? null,
          left: rect?.left ?? null,
          footer: footer ? [footer.x, footer.y, footer.width, footer.height] : null,
          messages: [
            ...(viewport?.querySelectorAll('.message, .conversation-trace-trigger') ?? []),
          ].map((element) => {
            const box = element.getBoundingClientRect();
            return {
              node: nodeId(element),
              text: element.textContent?.slice(0, 96) ?? '',
              height: box.height,
              top: box.top,
              final: element.getAttribute('data-final-reply'),
            };
          }),
          turns: [...(viewport?.querySelectorAll('.agent-turn') ?? [])].map((element) => {
            const summary = element.querySelector('.agent-turn-summary');
            return {
              node: nodeId(element),
              height: element.getBoundingClientRect().height,
              expanded: summary?.getAttribute('aria-expanded') ?? null,
              summaryTag: summary?.tagName ?? null,
              staticSummary: summary?.classList.contains('agent-turn-summary-static') ?? false,
              processToggles: element.querySelectorAll('button.agent-turn-summary').length,
            };
          }),
          animations: document
            .getAnimations()
            .map(
              (animation) =>
                (animation as CSSAnimation).animationName ??
                (animation as CSSTransition).transitionProperty,
            ),
        });
      };
      // RAF precedes ResizeObserver. Its following task sees the scroll writes
      // applied before paint, rather than falsely reporting a one-frame drift.
      const tick = () => {
        setTimeout(sample, 0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(
      `${server.url}?mode=${variant.mode}&turns=${variant.turns}&viewAll=${!!variant.viewAll}`,
    );
    const select = (id: string) =>
      page.getByRole('button', { name: `Session ${id}`, exact: true }).click();
    const ready = () =>
      page.waitForFunction(
        (turns) =>
          document.querySelectorAll('.agent-turn').length === turns &&
          document.querySelectorAll('.message.assistant[data-final-reply="true"]').length ===
            turns - 1,
        variant.turns,
      );
    await page.getByRole('button', { name: 'Session A', exact: true }).waitFor();
    let cachedOriginal: number[] | undefined;
    if (variant.mode === 'switch') {
      await select('A');
      await ready();
      await page.waitForTimeout(250);
      cachedOriginal = await page.evaluate(() =>
        window.historyPresentationFrames.at(-1)!.messages.map((message) => message.node),
      );
    }
    const target = variant.mode === 'initial' ? 'A' : 'B';
    await page.evaluate(() => {
      window.historyPresentationPhase = 'select-pending';
    });
    await select(target);
    await page.waitForTimeout(180);
    for (const phase of ['selection', 'history', ...variant.order] as PresentationPhase[]) {
      await page.evaluate((phase) => {
        window.historyPresentationPhase = `after-${phase}`;
        window.historyPresentationFixture.release(phase);
      }, phase);
      await page.waitForTimeout(240);
      await page.screenshot({ path: path.join(artifact, `${label}-${phase}.png`) });
    }
    await ready();
    await page.waitForTimeout(180);
    const finalTurns = await page.locator('.agent-turn').count();
    const finalReplies = await page.locator('.message.assistant[data-final-reply="true"]').count();
    let cachedReturned: number[] | undefined;
    if (variant.mode === 'switch') {
      await page.evaluate(() => {
        window.historyPresentationPhase = 'cached-return';
      });
      await select('A');
      await ready();
      await page.waitForTimeout(250);
      cachedReturned = await page.evaluate(() =>
        window.historyPresentationFrames.at(-1)!.messages.map((message) => message.node),
      );
      await page.screenshot({ path: path.join(artifact, `${label}-cached-return.png`) });
    }
    const data = await page.evaluate(() => ({
      frames: window.historyPresentationFrames,
      events: window.historyPresentationFixture.events,
      pending: window.historyPresentationFixture.pending(),
    }));
    await cdp.send('Page.stopScreencast');
    const result: CaseReport = {
      ...variant,
      label,
      errors,
      finalTurns,
      finalReplies,
      screenshotFrames,
      cachedOriginal,
      cachedReturned,
      ...data,
    };
    report.cases.push(result);
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(errors, [], `${label}: page errors`);
    assert.equal(finalTurns, variant.turns, `${label}: incomplete turn grouping`);
    assert.equal(finalReplies, variant.turns - 1, `${label}: incomplete final replies`);
    const stages = new Set(['after-selection', 'after-history', 'after-runs', 'after-tools']);
    const targetFrames = data.frames.filter((frame) => stages.has(frame.phase));
    const marker = `SESSION-${target}`;
    const first = targetFrames.findIndex((frame) =>
      frame.messages.some((message) => message.text.includes(marker)),
    );
    assert.ok(first >= 0, `${label}: target never became visible`);
    const presented = targetFrames.slice(first);
    const initial = presented[0]!;
    assert.equal(
      initial.turns.filter(
        (turn) =>
          turn.summaryTag === 'BUTTON' &&
          turn.expanded === 'false' &&
          !turn.staticSummary &&
          turn.processToggles === 1,
      ).length,
      variant.turns - 1,
      `${label}: completed processes were not initially folded`,
    );
    assert.equal(
      initial.turns.filter(
        (turn) =>
          turn.summaryTag === 'BUTTON' &&
          turn.expanded === 'true' &&
          !turn.staticSummary &&
          turn.processToggles === 1,
      ).length,
      1,
      `${label}: active process did not initialize expanded with a disclosure`,
    );
    assert.equal(
      initial.messages.filter((message) => message.text.includes(marker)).length,
      variant.turns,
      `${label}: incomplete human history`,
    );
    assert.ok(
      initial.messages.some((message) => message.text === '读取了文件'),
      `${label}: file reads were not aggregated`,
    );
    for (let index = 0; index < variant.turns; index++)
      assert.ok(
        initial.messages.some((message) =>
          message.text.startsWith(`REPLY-${target.toLowerCase()}-${index}\n`),
        ),
        `${label}: missing reply ${index}`,
      );

    assert.ok(presented.length >= 5, `${label}: insufficient visible frame coverage`);
    for (const frame of presented) {
      assert.equal(frame.title, `Session ${target}`, `${label}: mismatched target title`);
      assert.equal(frame.loading, false, `${label}: loading returned after presentation`);
      assert.equal(frame.welcome, false, `${label}: welcome flashed after presentation`);
      for (const key of [
        'height',
        'width',
        'left',
        'padding',
        'scrollTop',
        'scrollHeight',
      ] as const)
        assert.equal(frame[key], initial[key], `${label}: ${key} changed after first presentation`);
      assert.deepEqual(frame.footer, initial.footer, `${label}: composer moved`);
      assert.deepEqual(
        frame.messages,
        initial.messages,
        `${label}: message DOM or geometry changed`,
      );
      assert.deepEqual(frame.turns, initial.turns, `${label}: turn grouping changed`);
      assert.ok(
        !frame.animations.some((name) =>
          ['collapsible-motion-expand', 'grid-template-rows'].includes(name),
        ),
        `${label}: cold process replayed expansion`,
      );
    }
    // Loading is allowed after selection is confirmed. The previous identity's
    // transcript and an unconfirmed empty welcome are never its replacement.
    for (const frame of targetFrames) {
      assert.equal(frame.welcome, false, `${label}: welcome flashed during handoff`);
      if (frame.title === `Session ${target}`)
        assert.ok(
          !frame.messages.some((message) =>
            message.text.includes(`SESSION-${target === 'A' ? 'B' : 'A'}`),
          ),
          `${label}: target title paired with previous history`,
        );
    }
    assert.deepEqual(data.pending, {}, `${label}: an unresolved fixture read remained`);
    if (cachedOriginal)
      assert.deepEqual(
        cachedReturned,
        cachedOriginal,
        `${label}: cached history lost its message nodes`,
      );
    if (variant.turns === 40) {
      const metadata = data.events.filter(
        (event) => event.sessionId === 'b' && (event.phase === 'runs' || event.phase === 'tools'),
      );
      assert.ok(
        metadata.some((event) => event.messageIds?.length === 32),
        `${label}: did not exercise 32-entry metadata pages`,
      );
      assert.ok(
        metadata.filter((event) => event.phase === 'tools').length >= 3,
        `${label}: incomplete tool pagination coverage`,
      );
      assert.ok(
        data.events.filter((event) => event.sessionId === 'b' && event.phase === 'history')
          .length >= 2,
        `${label}: history was not paginated`,
      );
    }
    console.log(
      JSON.stringify({
        label,
        finalTurns,
        finalReplies,
        visibleFrames: presented.length,
        screenshotFrames,
        cachedNodesRetained: cachedOriginal ? true : undefined,
      }),
    );
    await page.close();
  }
} finally {
  console.log(JSON.stringify({ artifact }));
  await browser.close();
  server.stop(true);
}
