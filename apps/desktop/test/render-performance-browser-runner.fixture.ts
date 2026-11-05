import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import type {} from './render-performance-browser.fixture';

type Frame = {
  time: number;
  blank: boolean;
  top: number;
  height: number;
  bottom: number;
  text: string;
  animations: number;
  viewportHeight: number;
};
type Capture = {
  frames: Frame[];
  longTasks: { start: number; duration: number }[];
  start: number;
  observing: boolean;
  confirmation?: number;
};
declare global {
  interface Window {
    performanceCapture: Capture;
    originalMessage: Element | null;
    performanceStartup?: number;
  }
}

const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'render-performance-'));
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
      entry: path.join(directory, 'render-performance-browser.fixture.tsx'),
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
    if (!file.startsWith(output + path.sep)) return new Response(null, { status: 404 });
    return new Response(Bun.file(file));
  },
});
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });
const report = { browser: browser.version(), cases: [] as unknown[] };
try {
  for (const variant of [
    { count: 10, theme: 'light', width: 1440, reducedMotion: 'no-preference' },
    { count: 60, theme: 'light', width: 1440, reducedMotion: 'no-preference' },
    { count: 180, theme: 'light', width: 1440, reducedMotion: 'no-preference' },
    { count: 60, theme: 'dark', width: 1440, reducedMotion: 'no-preference' },
    { count: 60, theme: 'light', width: 960, reducedMotion: 'no-preference' },
    { count: 60, theme: 'light', width: 1440, reducedMotion: 'reduce' },
  ] as const) {
    const { count } = variant;
    const label = `${count}-${variant.theme}-${variant.width}-${variant.reducedMotion}`;
    const page = await browser.newPage({
      viewport: { width: variant.width, height: 1000 },
      locale: 'zh-CN',
      colorScheme: variant.theme,
      reducedMotion: variant.reducedMotion,
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.kite-client.shell')) return;
        observer.disconnect();
        requestAnimationFrame(() =>
          setTimeout(() => {
            window.performanceStartup = performance.now();
          }, 0),
        );
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${server.url}?turns=${count}`);
    await page.getByRole('button', { name: 'Session A', exact: true }).waitFor();
    await page.waitForFunction(() => window.performanceStartup !== undefined);
    const startup = await page.evaluate(() => ({
      shellPaintMs: window.performanceStartup,
      firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
    }));
    await page.evaluate(() => {
      const data: Capture = { frames: [], longTasks: [], start: 0, observing: false };
      Object.assign(window, { performanceCapture: data });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          data.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      const snapshot = () => {
        if (data.observing) {
          const viewport = document.querySelector<HTMLDivElement>('.conversation-viewport');
          const messages = viewport?.querySelectorAll<HTMLElement>('.message');
          data.frames.push({
            time: performance.now() - data.start,
            blank: !messages?.length,
            top: viewport?.scrollTop ?? 0,
            height: viewport?.scrollHeight ?? 0,
            viewportHeight: viewport?.clientHeight ?? 0,
            animations: document
              .getAnimations()
              .filter(
                (animation) =>
                  (animation as CSSAnimation).animationName === 'collapsible-motion-expand' ||
                  (animation as CSSTransition).transitionProperty === 'grid-template-rows',
              ).length,
            bottom: viewport
              ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
              : 0,
            text: messages?.[messages.length - 1]?.textContent?.slice(-90) ?? '',
          });
        }
      };
      // RAF runs before ResizeObserver. Sample in its following task so scroll
      // writes performed before paint are not mistaken for visible drift.
      const frame = () => {
        setTimeout(snapshot, 0);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const start = () =>
      page.evaluate(() => {
        const data = window.performanceCapture;
        data.frames = [];
        data.longTasks = [];
        data.start = performance.now();
        data.observing = true;
        data.confirmation = undefined;
      });
    const finish = async () => {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let remaining = 5;
            const frame = () => {
              if (--remaining > 0) requestAnimationFrame(frame);
              else resolve();
            };
            requestAnimationFrame(frame);
          }),
      );
      return page.evaluate(() => {
        const data = window.performanceCapture;
        data.observing = false;
        return {
          frames: data.frames,
          confirmation: data.confirmation,
          longTasks: data.longTasks.filter((entry) => entry.start >= data.start),
          duration: performance.now() - data.start,
          nodes: document.querySelectorAll('.conversation-cache-container *').length,
        };
      });
    };
    const ready = (id: string, tail: string) =>
      page.waitForFunction(
        ({ id, tail }) =>
          document.querySelector('.breadcrumb strong')?.textContent ===
            `Session ${id.toUpperCase()}` &&
          document.querySelector('.conversation-viewport')?.textContent?.includes(tail) &&
          !document.querySelector<HTMLButtonElement>('[data-permission-trigger]')?.disabled,
        { id, tail },
      );
    const select = (id: string) =>
      page
        .getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true })
        .evaluate((node) => (node as HTMLButtonElement).click());
    await start();
    await select('a');
    await ready('a', 'TAIL-A-0');
    await page.waitForFunction(
      () => document.querySelector('.composer-cache-rate')?.textContent === '缓存 70%',
    );
    await page.waitForTimeout(350);
    const initial = await finish();
    const response = await page.locator('.response-status').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      let top = 0,
        bottom = innerHeight;
      const clips: { className: string; top: number; bottom: number }[] = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY))
          continue;
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
        clips.push({ className: parent.className, top: bounds.top, bottom: bounds.bottom });
      }
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        visibleTop: top,
        visibleBottom: bottom,
        clips,
      };
    });
    await page.screenshot({ path: path.join(artifact, `initial-${label}.png`) });
    const streams = [];
    for (let chunk = 0; chunk < 8; chunk++) {
      await start();
      const tail = await page.evaluate(() => window.renderPerformanceFixture.stream());
      await ready('a', tail);
      streams.push(await finish());
    }
    // Manual reading must survive updates and an A -> B -> A round trip.
    const manualTop = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLDivElement>('.conversation-viewport')!;
      window.originalMessage = viewport.querySelector('.message');
      viewport.scrollTop = Math.min(1500, viewport.scrollHeight / 3);
      return viewport.scrollTop;
    });
    await page.waitForTimeout(100);
    await start();
    const tail = await page.evaluate(() => window.renderPerformanceFixture.stream());
    await ready('a', tail);
    const manualStream = await finish();
    await start();
    await select('b');
    await ready('b', 'TAIL-B-0');
    await page.waitForTimeout(350);
    const coldSwitch = await finish();
    await page.evaluate(() => window.renderPerformanceFixture.hold());
    await start();
    await select('a');
    await page.waitForFunction(() => window.renderPerformanceFixture.pending('selection') > 0);
    await page.waitForTimeout(60);
    await page.evaluate(() => {
      window.performanceCapture.confirmation = performance.now() - window.performanceCapture.start;
      window.renderPerformanceFixture.release('selection');
    });
    await page.waitForTimeout(120);
    const cachedPending = await finish();
    await page.evaluate(() => window.renderPerformanceFixture.resume());
    await ready('a', tail);
    const restoredTop = await page
      .locator('.conversation-viewport')
      .evaluate((node) => node.scrollTop);
    const retained = await page.evaluate(
      () => window.originalMessage === document.querySelector('.conversation-viewport .message'),
    );
    assert.ok(
      Math.abs(restoredTop - manualTop) < 1,
      `reading moved: ${manualTop} -> ${restoredTop}`,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(artifact, `restored-${label}.png`) });
    await start();
    const continuousTail = await page.evaluate(async () => {
      let tail = '';
      for (let index = 0; index < 32; index++) {
        tail = window.renderPerformanceFixture.stream();
        await new Promise((resolve) => setTimeout(resolve, 32));
      }
      return tail;
    });
    await ready('a', continuousTail);
    const continuous = await finish();
    const settlingMessages = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.conversation-viewport .message.assistant')].map((node) => ({
        node,
        id: node.getAttribute('data-message-id'),
        wasFinal: node.getAttribute('data-final-reply') === 'true',
        text: node.querySelector('.typeset')?.textContent ?? '',
      })),
    );
    const settlingMessageIDs = await settlingMessages.evaluate((entries) =>
      entries.map((entry) => entry.id),
    );
    assert.ok(settlingMessageIDs.length > 0, 'no original replies mounted before settlement');
    assert.equal(settlingMessageIDs.at(-1), `m-a-${count - 1}`);
    await start();
    await page.evaluate(() => window.renderPerformanceFixture.settle());
    await page.waitForFunction((entries) => {
      const current = [...document.querySelectorAll('.conversation-viewport .message.assistant')];
      return (
        current.length === entries.length &&
        entries.every((entry, index) => {
          const node = current[index]!;
          return (
            node.getAttribute('data-message-id') === entry.id &&
            node.getAttribute('data-final-reply') === 'true' &&
            (node.querySelector('.typeset')?.textContent ?? '') === entry.text &&
            (!entry.wasFinal || node === entry.node)
          );
        })
      );
    }, settlingMessages);
    const settlement = await finish();
    const settlementIdentities = await settlingMessages.evaluate((entries) => {
      const current = [...document.querySelectorAll('.conversation-viewport .message.assistant')];
      return entries.map((entry, index) => ({
        id: current[index]!.getAttribute('data-message-id'),
        wasFinal: entry.wasFinal,
        originalRetained: current[index] === entry.node,
        originalConnected: entry.node.isConnected,
      }));
    });
    assert.deepEqual(
      settlementIdentities.map((entry) => entry.id),
      settlingMessageIDs,
      'settlement changed original reply identities or order',
    );
    assert.ok(
      settlementIdentities
        .filter((entry) => entry.wasFinal)
        .every((entry) => entry.originalRetained),
      'settlement replaced an unchanged completed reply',
    );
    await settlingMessages.dispose();
    const first = (capture: typeof initial, target: string) =>
      capture.frames.find((frame) => frame.text.includes(target))?.time;
    const initialFrames = initial.frames.filter((frame) => !frame.blank);
    const finalHeight = initialFrames.at(-1)!.height;
    const frameGaps = continuous.frames
      .slice(1)
      .map((frame, index) => frame.time - continuous.frames[index]!.time);
    const summary = {
      label,
      initialMs: first(initial, 'TAIL-A-0'),
      stableMs: initialFrames.find((frame) => frame.height === finalHeight)?.time,
      openingAnimationFrames: initial.frames.filter((frame) => frame.animations > 0).length,
      streamMs: streams.map((capture, index) => first(capture, `TAIL-A-${index + 1}`)),
      coldSwitchMs: first(coldSwitch, 'TAIL-B-0'),
      retained,
      cachedPreviewMs: (first(cachedPending, 'TAIL-A-9') ?? NaN) - cachedPending.confirmation!,
      cachedBlankFrames: cachedPending.frames.filter((frame) => frame.blank).length,
      continuousMaxGapMs: Math.max(...frameGaps),
      continuousLongTasks: continuous.longTasks.length,
      responseClipped:
        response.top < response.visibleTop - 1 || response.bottom > response.visibleBottom + 1,
    };
    report.cases.push({
      ...variant,
      startup,
      summary,
      initial,
      response,
      streams,
      manualStream,
      manualTop,
      restoredTop,
      coldSwitch,
      cachedPending,
      continuous,
      settlement,
      errors,
    });
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(summary));
    assert.ok(
      initialFrames.every((frame) => frame.animations === 0),
      'cold history replayed expansion',
    );
    assert.equal(
      summary.responseClipped,
      false,
      'reply status was clipped despite reaching scroll bottom',
    );
    assert.ok(
      initialFrames.every((frame) => frame.height === finalHeight),
      'cold history changed height after first paint',
    );
    assert.ok(
      streams.every((capture) =>
        capture.frames.every((frame) => !frame.blank && Math.abs(frame.bottom) <= 1),
      ),
      'streaming lost bottom follow or blanked the transcript',
    );
    assert.ok(
      manualStream.frames.every((frame) => frame.top === manualTop),
      'a stream moved manual reading',
    );
    assert.ok(
      continuous.frames.every((frame) => frame.top === manualTop && !frame.blank),
      'continuous streams moved manual reading',
    );
    assert.ok(
      cachedPending.frames.every((frame) => !frame.blank),
      'session handoff blanked the transcript',
    );
    if (count < 180) assert.ok(retained, 'a budget-sized conversation lost its cached DOM');
    // Performance samples keep their original mounted window. Read the complete
    // history afterward through the existing UI instead of requiring it all at once.
    const originalHistory = await page.evaluate(async () => {
      const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
      if (!state || !('generation' in state) || !state.selection)
        throw Error('fixture_original_history_scope_unavailable');
      const selection = state.selection;
      const messages: import('@kite-ai/client').Message[] = [];
      let afterSeq: string | undefined;
      for (;;) {
        const page = await window.kiteNative!.request({
          method: 'messages',
          generation: state.generation,
          expectedStoreId: selection.storeId,
          sessionId: selection.session.id,
          upperSeq: selection.session.nextSeq,
          afterSeq,
          limit: 32,
        });
        if (!page || !('messages' in page)) throw Error('fixture_original_history_unavailable');
        messages.push(...page.messages);
        if (!page.nextAfterSeq) return messages;
        afterSeq = page.nextAfterSeq;
      }
    });
    const expectedIDs = Array.from({ length: count }, (_, index) => [
      `u-a-${index}`,
      `m-a-${index}`,
    ]).flat();
    assert.deepEqual(
      originalHistory.map((message) => message.id),
      expectedIDs,
    );
    for (;;) {
      const before = await page.locator('.conversation-viewport .message').count();
      if (before === expectedIDs.length) break;
      assert.ok(before < expectedIDs.length, 'full history duplicated messages');
      await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
      await page.waitForFunction(
        (before) => document.querySelectorAll('.conversation-viewport .message').length > before,
        before,
      );
    }
    const completeHistory = await page.evaluate(() =>
      [...document.querySelectorAll('.conversation-viewport .message')].map((node) => ({
        id: node.getAttribute('data-message-id'),
        final: node.getAttribute('data-final-reply'),
        text: node.querySelector('.typeset, .user-message-body')?.textContent ?? '',
      })),
    );
    assert.deepEqual(
      completeHistory.map((message) => message.id),
      expectedIDs,
    );
    const plain = (text: string) => text.replace(/\s+/gu, '');
    for (const [index, original] of originalHistory.entries()) {
      // Only formatting from this fixture's fixed Markdown is omitted. Every
      // original character, repeated paragraph, table cell and code line remains.
      const expected = original.content
        .replace(/^```(\w*)$/gm, '$1')
        .replace(/^\|[ :|-]+\|$/gm, '')
        .replace(/^#{1,6} /gm, '')
        .replace(/^[-*] /gm, '')
        .replace(/[*`|]/g, '');
      assert.equal(
        plain(completeHistory[index]!.text),
        plain(expected),
        `complete history changed original body ${original.id}`,
      );
      if (original.role === 'assistant') assert.equal(completeHistory[index]!.final, 'true');
    }
    for (let chunk = 1; chunk <= 41; chunk++)
      assert.ok(
        completeHistory.at(-1)!.text.includes(`新增流式片段 ${chunk}。TAIL-A-${chunk}`),
        `full history lost original stream chunk ${chunk}`,
      );
    Object.assign(report.cases.at(-1) as object, {
      settlingMessageIDs,
      settlementIdentities,
      completeHistory,
    });
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: path.join(artifact, `full-history-${label}.png`) });
    await page.close();
  }
  await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
} finally {
  console.log(JSON.stringify({ artifact }));
  await browser.close();
  server.stop(true);
}
