import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import { build } from 'vite';
import type {} from './render-performance-browser.fixture';

const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'streaming-render-'));
const output = path.join(artifact, 'dist');
const observe = process.argv.includes('--observe');
const electronMode = process.argv.includes('--electron');
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
        '<!doctype html><html><head><meta charset="utf-8"><title>Kite 流式渲染验收</title><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = path.resolve(output, `.${pathname}`);
    return file.startsWith(output + path.sep)
      ? new Response(Bun.file(file))
      : new Response(null, { status: 404 });
  },
});

type Audit = {
  animations: { text: string; time: number; delay: number }[];
  appends: { text: string; issued: number; visible?: number }[];
  frames: {
    time: number;
    top: number;
    bottom: number;
    text: string;
    status: string;
    opacity: number[];
    reading: boolean;
  }[];
  mutations: string[];
  body?: Element;
  stable: Element[];
};
declare global {
  interface Window {
    streamAudit: Audit;
  }
}

const browser = electronMode
  ? undefined
  : await chromium.launch({
      headless: !observe,
      chromiumSandbox: true,
      channel: 'chrome',
    });
let electron: ElectronApplication | undefined;
const report = { browser: browser?.version() ?? 'Electron', cases: [] as unknown[] };
let currentPage: import('playwright').Page | undefined;
const checkpoint = async (stage: string) => {
  console.log(JSON.stringify({ stage, artifact }));
  if (observe) await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
};
try {
  const variants = observe
    ? [{ width: 1280, dark: false, reduced: false }]
    : [
        { width: 1280, dark: false, reduced: false },
        { width: 800, dark: false, reduced: false },
        { width: 1280, dark: true, reduced: false },
        { width: 800, dark: true, reduced: true },
      ];
  for (const variant of variants) {
    const label = `${variant.width}-${variant.dark ? 'dark' : 'light'}-${variant.reduced ? 'reduced' : 'motion'}`;
    let page: Page;
    if (electronMode) {
      const main = path.join(artifact, 'main.cjs');
      // Isolated test artifact: current Native renderer + async bridge, no user Store.
      writeFileSync(
        main,
        `const {app,BrowserWindow}=require('electron');
        app.whenReady().then(()=>new BrowserWindow({show:true,autoHideMenuBar:true,
          webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));
        app.on('window-all-closed',()=>app.quit());`,
      );
      electron = await _electron.launch({
        executablePath: createRequire(import.meta.url)('electron') as string,
        args: [main, `--user-data-dir=${path.join(artifact, `electron-${label}`)}`],
      });
      await electron.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height);
        },
        { width: variant.width, height: 960 },
      );
      page = await electron.firstWindow();
      await page.emulateMedia({
        colorScheme: variant.dark ? 'dark' : 'light',
        reducedMotion: variant.reduced ? 'reduce' : 'no-preference',
      });
      report.browser = await page.evaluate(() => navigator.userAgent);
    } else
      page = await browser!.newPage({
        viewport: { width: variant.width, height: 960 },
        locale: 'zh-CN',
        colorScheme: variant.dark ? 'dark' : 'light',
        reducedMotion: variant.reduced ? 'reduce' : 'no-preference',
      });
    currentPage = page;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.streamAudit = { animations: [], appends: [], frames: [], mutations: [], stable: [] };
      const paintRange = (name: string, range: AbstractRange) => {
        const source = [...document.querySelectorAll('style')]
          .map((style) => style.textContent ?? '')
          .find((text) => text.includes(`::highlight(${name})`));
        const at = Number(
          source
            ?.slice(source.indexOf(`::highlight(${name})`))
            .match(/--kite-reveal-time\) - ([\d.]+)/)?.[1],
        );
        const origin = range.startContainer.parentElement!;
        return { at, origin };
      };
      const setHighlight = CSS.highlights.set.bind(CSS.highlights);
      CSS.highlights.set = (name, highlight) => {
        if (name.startsWith('kite-reveal-') && !CSS.highlights.has(name))
          for (const range of highlight) {
            const { at, origin } = paintRange(name, range);
            window.streamAudit.animations.push({
              text: range.toString(),
              time: performance.now(),
              delay: at - Number(origin.style.getPropertyValue('--kite-reveal-time')),
            });
          }
        return setHighlight(name, highlight);
      };
      const sample = () => {
        const viewport = document.querySelector<HTMLElement>('.conversation-viewport');
        const now = performance.now();
        const text = viewport?.textContent ?? '';
        for (const append of window.streamAudit.appends)
          if (append.visible === undefined && text.includes(append.text)) append.visible = now;
        if (viewport)
          window.streamAudit.frames.push({
            time: now,
            top: viewport.scrollTop,
            bottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            text: text.slice(-800),
            reading:
              document.querySelector('.conversation-cache-entry')?.getAttribute('aria-busy') ===
              'true',
            status: document.querySelector('.response-status')?.textContent ?? '',
            opacity: [...CSS.highlights.entries()]
              .filter(([name]) => name.startsWith('kite-reveal-'))
              .flatMap(([name, highlight]) =>
                [...highlight].map((range) => {
                  const origin = range.startContainer.parentElement!;
                  const color = getComputedStyle(origin, `::highlight(${name})`).color;
                  const alpha =
                    color.match(/\/\s*([\d.]+)\s*\)$/) ??
                    color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
                  return alpha ? Number(alpha[1]) : 1;
                }),
              ),
          });
        requestAnimationFrame(() => setTimeout(sample, 0));
      };
      requestAnimationFrame(sample);
    });
    await page.goto(`${server.url}?turns=8`);
    const select = (id: string) =>
      page.getByRole('button', { name: `Session ${id.toUpperCase()}`, exact: true }).click();
    const ready = (id: string, tail: string) =>
      page.waitForFunction(
        ({ id, tail }) =>
          document.querySelector('.breadcrumb strong')?.textContent ===
            `Session ${id.toUpperCase()}` &&
          document.querySelector('.conversation-viewport')?.textContent?.includes(tail) &&
          !document.querySelector<HTMLButtonElement>('[data-permission-trigger]')?.disabled,
        { id, tail },
      );
    await select('a');
    await ready('a', 'TAIL-A-0');
    await page.waitForTimeout(300);
    assert.equal(
      await page.getByRole('alert').count(),
      0,
      'isolated Session lacks its sealed model protocol',
    );
    assert.equal(await page.evaluate(() => window.streamAudit.animations.length), 0);
    await page.evaluate(() => {
      const audit = window.streamAudit;
      audit.body = [...document.querySelectorAll('.conversation-viewport .typeset-chat')].at(-1)!;
      audit.stable = [...audit.body.children].slice(0, -1);
      const observer = new MutationObserver((records) => {
        for (const record of records) audit.mutations.push(record.type);
      });
      for (const node of audit.stable)
        observer.observe(node, { childList: true, characterData: true, subtree: true });
      audit.frames = [];
    });
    await page.screenshot({ path: path.join(artifact, `${label}-initial.png`) });
    await checkpoint(`${label}:initial`);
    // Delayed incremental reads must retain the admitted reading and reveal only appended text.
    await page.evaluate(() => window.renderPerformanceFixture.delayHistory(45));
    const append = async (text: string) => {
      const needle = text.replaceAll('**', '').trim();
      await page.evaluate(
        ({ text, needle }) => {
          window.streamAudit.appends.push({ text: needle, issued: performance.now() });
          window.renderPerformanceFixture.append(text);
        },
        { text, needle },
      );
      await ready('a', needle);
    };
    let wrappingChecks = 0;
    for (const text of [
      '星？是想说些什么，还是不小心发出来的？我在呢。'.repeat(6),
      'AVATAR office affinity, final text rendering should preserve wrapping. '.repeat(5),
      '中文回复包含 English、数字 12345、标点（测试）与 emoji 👩🏽‍💻，文本完成时不应重新换行。'.repeat(
        4,
      ),
    ]) {
      await append(`\n\n${text.slice(0, 1)}`);
      await append(text.slice(1));
      const wrapping = await page.evaluate(() => {
        const paragraph = [...document.querySelectorAll<HTMLElement>('.typeset-chat > p')].at(-1)!;
        const reference = document.createElement('p');
        reference.textContent = paragraph.textContent;
        reference.style.cssText = 'position:fixed;visibility:hidden;top:0;left:0;margin:0';
        paragraph.after(reference);
        const originalWidth = paragraph.style.width,
          differences = [];
        const lines = (element: HTMLElement) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const box = element.getBoundingClientRect();
          return {
            height: box.height,
            lines: new Set(
              [...range.getClientRects()].map((rect) => Math.round(rect.top - box.top)),
            ).size,
          };
        };
        try {
          for (let width = 180; width <= 740; width += 2) {
            paragraph.style.width = reference.style.width = `${width}px`;
            const live = lines(paragraph),
              complete = lines(reference);
            if (Math.abs(live.height - complete.height) > 0.02 || live.lines !== complete.lines)
              differences.push({ width, live, complete });
          }
        } finally {
          paragraph.style.width = originalWidth;
          reference.remove();
        }
        return differences;
      });
      assert.deepEqual(wrapping, [], 'live reveal changed natural text wrapping');
      wrappingChecks += 281;
    }
    for (const [index, text] of [
      '，流式新增',
      '文字逐渐出现',
      '，保留已经显示的正文🙂',
      '，继续追加。',
    ].entries()) {
      await append(text);
      await page.waitForTimeout(30);
      await page.screenshot({ path: path.join(artifact, `${label}-fade-${index}.png`) });
      await page.waitForTimeout(150);
    }
    await append('\n\n新段落中有 **强调**，以及中文和 emoji 👩🏽‍💻。');
    await page.waitForTimeout(280);
    const animationCount = await page.evaluate(() => window.streamAudit.animations.length);
    assert.equal(
      variant.reduced ? animationCount === 0 : animationCount > 0,
      true,
      'expected live text reveal',
    );
    if (!variant.reduced) {
      const animations = await page.evaluate(() => window.streamAudit.animations);
      assert.ok(
        animations.every(
          (animation) =>
            [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(animation.text)]
              .length === 1,
        ),
        'a whole chunk animated together',
      );
      assert.ok(
        animations.some((animation) => animation.delay > 0),
        'characters were not staggered',
      );
      assert.ok(
        animations.every((animation) => animation.delay <= 180.000001),
        'reveal backlog exceeded its bound',
      );
    }
    assert.deepEqual(
      await page.evaluate(() => window.streamAudit.mutations),
      [],
      'stable blocks mutated',
    );
    assert.equal(
      await page.evaluate(() =>
        window.streamAudit.stable.every((node) => window.streamAudit.body!.contains(node)),
      ),
      true,
    );
    await checkpoint(`${label}:streaming`);
    const viewport = page.locator('.conversation-viewport');
    await viewport.evaluate((node) => {
      node.scrollTop = 400;
    });
    await page.waitForTimeout(100);
    const manual = await viewport.evaluate((node) => node.scrollTop);
    const manualStart = await page.evaluate(() => window.streamAudit.frames.length);
    for (let index = 0; index < 8; index++) {
      await append(`\n\n连续新增第${index + 1}段，向上阅读时保持原位置。`);
      await page.waitForTimeout(100);
    }
    const manualFrames = await page.evaluate(
      (start) => window.streamAudit.frames.slice(start),
      manualStart,
    );
    assert.ok(manualFrames.length > 10);
    assert.ok(
      manualFrames.every((frame) => !frame.reading),
      'incremental updates flashed history loading',
    );
    assert.ok(
      manualFrames.every((frame) => frame.top === manual),
      'stream moved manual reading',
    );
    await page.screenshot({ path: path.join(artifact, `${label}-manual.png`) });
    const streamingReads = await page.evaluate(() => window.renderPerformanceFixture.reads());
    assert.equal(streamingReads.filter((read) => read.kind === 'full').length, 1);
    assert.ok(streamingReads.filter((read) => read.kind === 'incremental').length >= 13);
    assert.ok(
      streamingReads
        .filter((read) => read.kind === 'incremental')
        .every((read) => read.count === 1),
    );
    await checkpoint(`${label}:manual`);
    await select('b');
    await ready('b', 'TAIL-B-0');
    const beforeReturn = await page.evaluate(() => window.streamAudit.animations.length);
    await select('a');
    await ready('a', '连续新增第8段');
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => window.streamAudit.animations.length),
      beforeReturn,
      'cached return replayed reveal',
    );
    assert.equal(await viewport.evaluate((node) => node.scrollTop), manual);
    await checkpoint(`${label}:cached-return`);
    const reconnectStart = await page.evaluate(() => window.streamAudit.frames.length);
    await page.evaluate(() => window.renderPerformanceFixture.reconnect());
    await page.waitForTimeout(15);
    await append('\n\n重连期间新增的消息仍然完整显示。');
    await page.waitForTimeout(300);
    const recovered = await page.evaluate(
      (start) => window.streamAudit.frames.slice(start),
      reconnectStart,
    );
    assert.ok(
      recovered.some((frame) => frame.reading),
      'reconnect did not re-establish a baseline',
    );
    assert.ok(
      recovered.every((frame) => frame.top === manual),
      'reconnect moved the reading position',
    );
    await page.screenshot({ path: path.join(artifact, `${label}-reconnected.png`) });
    await viewport.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForTimeout(100);
    const completionStart = await page.evaluate(() => window.streamAudit.frames.length);
    await page.evaluate(() => window.renderPerformanceFixture.settle());
    await page.waitForFunction(() => !document.querySelector('.response-status'));
    await page.waitForTimeout(300);
    const audit = await page.evaluate(() => ({
      animations: window.streamAudit.animations,
      appends: window.streamAudit.appends,
      frames: window.streamAudit.frames,
      mutations: window.streamAudit.mutations,
      overflow: document.documentElement.scrollWidth > innerWidth,
      bodyFits: [...document.querySelectorAll('.conversation-viewport .typeset-chat')].every(
        (body) => {
          const rect = body.getBoundingClientRect();
          const viewport = body.closest('.conversation-viewport')!.getBoundingClientRect();
          return rect.left >= viewport.left && rect.right <= viewport.right + 1;
        },
      ),
    }));
    assert.equal(audit.overflow, false);
    assert.equal(audit.bodyFits, true, 'message body clipped in the supported desktop window');
    assert.deepEqual(errors, []);
    assert.ok(
      audit.frames.some((frame) => frame.reading),
      'reopen/reconnect history reading was not observed',
    );
    assert.ok(
      audit.appends.every((append) => append.visible !== undefined),
      'an append never became visible',
    );
    assert.ok(
      audit.frames.slice(completionStart).every((frame) => Math.abs(frame.bottom) <= 1),
      'completion lost follow',
    );
    if (!variant.reduced)
      assert.ok(
        audit.frames.some(
          (frame) =>
            frame.opacity.some((opacity) => opacity > 0.25 && opacity < 1) &&
            frame.opacity.some((opacity) => opacity === 0),
        ),
        'no observed per-character progression',
      );
    await page.screenshot({ path: path.join(artifact, `${label}-complete.png`) });
    await page.evaluate(() => {
      window.streamAudit.animations = [];
      window.streamAudit.frames = [];
      window.renderPerformanceFixture.automaticBody('mount');
    });
    await page.waitForFunction(() => window.renderPerformanceFixture.automaticState().pending);
    assert.equal(await page.getByText('回复未完成', { exact: true }).count(), 0);
    await page.evaluate(() => window.renderPerformanceFixture.automaticBody('first'));
    await page.waitForFunction(
      () =>
        document.querySelector('.typeset-chat')?.textContent ===
        window.renderPerformanceFixture.automaticState().first,
    );
    assert.equal(
      await page.evaluate(() => window.streamAudit.animations.length),
      0,
      'initial automatic full body replayed history',
    );
    await page.evaluate(() => {
      window.streamAudit.frames = [];
      window.renderPerformanceFixture.automaticBody('pending');
    });
    await page.waitForFunction(() => window.renderPerformanceFixture.automaticState().pending);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => window.renderPerformanceFixture.automaticState().copied),
      undefined,
    );
    assert.ok(
      await page.evaluate(() =>
        window.streamAudit.frames.every((frame) =>
          frame.text.includes(window.renderPerformanceFixture.automaticState().first),
        ),
      ),
      'automatic body flashed back to a short preview',
    );
    await page.evaluate(() => window.renderPerformanceFixture.automaticBody('second'));
    await page.waitForFunction(
      () =>
        document.querySelector('.typeset-chat')?.textContent ===
        window.renderPerformanceFixture.automaticState().second,
    );
    await page.waitForTimeout(30);
    await page.screenshot({ path: path.join(artifact, `${label}-automatic-fade.png`) });
    await page.waitForTimeout(420);
    const automatic = await page.evaluate(() => ({
      animations: window.streamAudit.animations,
      frames: window.streamAudit.frames,
      state: window.renderPerformanceFixture.automaticState(),
    }));
    assert.equal(
      automatic.animations.map((animation) => animation.text).join(''),
      variant.reduced ? '' : '，逐字新增🙂',
    );
    assert.equal(automatic.state.copied, automatic.state.second);
    assert.ok(
      automatic.frames.every((frame) => !frame.text.includes('回复未完成')),
      'live automatic body briefly inserted an incomplete-output warning',
    );
    const firstBodyHandoff = await page.evaluate(async () => {
      const samples: { top: number; height: number; warning: boolean; text: string }[] = [];
      const sample = () => {
        const body = document.querySelector('.typeset-chat')!;
        const rect = body.getBoundingClientRect();
        samples.push({
          top: rect.top,
          height: rect.height,
          warning: document
            .querySelector('.model-output-message')!
            .textContent!.includes('回复未完成'),
          text: body.textContent!,
        });
      };
      sample();
      window.renderPerformanceFixture.automaticBody('seal');
      for (let frame = 0; frame < 35; frame++) {
        await new Promise(requestAnimationFrame);
        if (frame === 8) window.renderPerformanceFixture.automaticBody('sealed');
        sample();
      }
      return samples;
    });
    assert.ok(firstBodyHandoff.every((sample) => !sample.warning));
    assert.ok(firstBodyHandoff.every((sample) => sample.text === automatic.state.second));
    assert.ok(
      firstBodyHandoff.every(
        (sample) =>
          sample.top === firstBodyHandoff[0]!.top && sample.height === firstBodyHandoff[0]!.height,
      ),
      'body moved while a live prefix became sealed',
    );
    await page.screenshot({ path: path.join(artifact, `${label}-automatic-complete.png`) });
    await page.evaluate(() => window.renderPerformanceFixture.firstReply('thinking'));
    await page.waitForFunction(
      () => document.querySelector('.response-status')?.textContent === '正在思考…',
    );
    await page.waitForTimeout(150);
    const firstReply = await page.evaluate(async () => {
      window.renderPerformanceFixture.firstReply('body');
      const samples: {
        bodyTop: number;
        contentHeight: number;
        turnHeight: number;
        scrollTop: number;
      }[] = [];
      for (let frame = 0; frame < 40; frame++) {
        await new Promise(requestAnimationFrame);
        const body = document.querySelector<HTMLElement>('.agent-turn .typeset-chat');
        if (!body) continue;
        samples.push({
          bodyTop: body.getBoundingClientRect().top,
          contentHeight: document.querySelector('.agent-turn-content')!.getBoundingClientRect()
            .height,
          turnHeight: document.querySelector('.agent-turn')!.getBoundingClientRect().height,
          scrollTop: document.querySelector('.conversation-viewport')!.scrollTop,
        });
      }
      return samples;
    });
    assert.ok(firstReply.length >= 25);
    for (const sample of firstReply)
      assert.deepEqual(
        sample,
        firstReply[0],
        'first reply replayed process expansion after becoming visible',
      );
    await page.screenshot({ path: path.join(artifact, `${label}-first-reply.png`) });
    assert.deepEqual(errors, []);
    report.cases.push({
      label,
      wrappingChecks,
      animationCount,
      manual,
      errors,
      streamingReads,
      reads: await page.evaluate(() => window.renderPerformanceFixture.reads()),
      ...audit,
      automatic,
      firstBodyHandoff,
      firstReply,
    });
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    await checkpoint(`${label}:complete`);
    if (electron) await electron.close();
    else await page.close();
    electron = undefined;
  }
} catch (error) {
  await currentPage?.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
  report.cases.push({
    error: String(error),
    audit: await currentPage
      ?.evaluate(() => ({
        animations: window.streamAudit.animations,
        frames: window.streamAudit.frames,
        mutations: window.streamAudit.mutations,
      }))
      .catch(() => undefined),
  });
  await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  console.log(JSON.stringify({ artifact, cases: report.cases.length }));
  await electron?.close();
  await browser?.close();
  server.stop(true);
}
