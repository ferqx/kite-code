import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
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
declare global {
  interface Window {
    historyPresentationFrames: Frame[];
    historyPresentationPhase: string;
    outputFrames: OutputFrame[];
    outputPhase: OutputFrame['phase'];
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
    failedReadFrames: OutputFrame[];
  }[],
};
const outputsOnly = process.argv.includes('--turn-outputs');
const variants: Variant[] = [
  { mode: 'initial', turns: 4, width: 1320, order: ['runs', 'tools'] },
  { mode: 'initial', turns: 4, width: 1440, order: ['tools', 'runs'], theme: 'dark' },
  { mode: 'switch', turns: 4, width: 1280, order: ['runs', 'tools'] },
  { mode: 'switch', turns: 4, width: 1320, order: ['tools', 'runs'], theme: 'dark' },
  { mode: 'switch', turns: 4, width: 1440, order: ['runs', 'tools'], viewAll: true },
  { mode: 'switch', turns: 40, width: 1440, order: ['tools', 'runs'], reducedMotion: 'reduce' },
];
try {
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
      await first.locator('.output-file-card').waitFor();
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
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-resolved.png`) });
      await page.evaluate(() => {
        window.outputPhase = 'warm';
      });
      await page.getByRole('button', { name: 'Session A', exact: true }).click();
      await first.locator('.output-file-card').waitFor();
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-warm.png`) });
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
      await page.screenshot({ path: path.join(artifact, `outputs-${theme}-live.png`) });
      await page.evaluate(() => window.historyPresentationFixture.release('liveOutputs'));
      await latest.locator('.output-file-card').waitFor();
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
      report.outputPresentation.push({ theme, frames, events, failedReadFrames });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          theme,
          cold: cold.length,
          slow: slow.length,
          warm: warm.length,
          live: live.length,
        }),
      );
      await page.close();
    }
  }
  for (const variant of outputsOnly ? [] : variants) {
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
