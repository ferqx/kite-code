import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import ts from 'typescript';
import { build, createServer, type ViteDevServer } from 'vite';
import type {} from './initial-render-performance-browser.fixture';

const developmentMode = process.argv.includes('--dev');
const electronMode = process.argv.includes('--electron');
const profileMode = process.argv.includes('--profile');
const churnMode = process.argv.includes('--churn');
const windowChecks = process.argv.includes('--window-checks');
const lateNavigation = process.argv.includes('--late-navigation');
const toolsPerTurn = process.argv.includes('--toolchain') ? 20 : 0;
const shape = process.argv.includes('--long') ? 'long' : 'history';
const counts = (
  process.argv.find((arg) => arg.startsWith('--turns='))?.slice(8) ??
  (shape === 'long' ? '1' : '180,600')
)
  .split(',')
  .map(Number);
const blocks = Number(
  process.argv.find((arg) => arg.startsWith('--blocks='))?.slice(9) ?? (shape === 'long' ? 600 : 1),
);
assert.ok(counts.every((count) => Number.isInteger(count) && count > 0 && count <= 2000));
const directory = import.meta.dir;
const entry = path.join(directory, 'initial-render-performance-browser.fixture.tsx');
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(
  path.join(cache, `initial-render-${developmentMode ? 'dev' : 'prod'}-`),
);
const output = path.join(artifact, 'dist');
const html = (script: string, style = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${style}</head><body style="margin:0"><div id="root"></div><script type="module" src="${script}"></script></body></html>`;
const define = {
  __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false',
  'process.env.NODE_ENV': JSON.stringify(developmentMode ? 'development' : 'production'),
};
const structuralTiming = {
  name: 'isolated-structural-ready-timing',
  enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.endsWith('/packages/ui/src/desktop/Conversation.tsx')) {
      const anchor = 'const messages = preparing ? [] : incomingMessages;';
      assert.equal(source.split(anchor).length, 2);
      return source.replace(
        anchor,
        `${anchor}\nuseLayoutEffect(() => window.initialRenderFixture.observeCommittedMessages(messages), [messages]);`,
      );
    }
    if (!id.endsWith('/apps/desktop/src/native.tsx')) return;
    const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: { at: number; text: string }[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(file) === 'initialPresentationPending' &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        edits.push({
          at: node.initializer.expression.getStart(file),
          text: 'window.initialRenderFixture.structuralReady(selection?.session.id, historyState.phase, (',
        });
        edits.push({ at: node.initializer.expression.getEnd(), text: '))' });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.equal(
      edits.length,
      2,
      'the test-only structural fact gate must identify one original prop',
    );
    for (const edit of edits.sort((a, b) => b.at - a.at))
      source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
    return source;
  },
};
let dev: ViteDevServer | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let url: string;
if (developmentMode) {
  dev = await createServer({
    root: path.dirname(directory),
    configFile: false,
    envFile: false,
    plugins: [
      structuralTiming,
      react(),
      tailwindcss(),
      {
        name: 'isolated-initial-render-entry',
        configureServer(instance) {
          instance.middlewares.use(async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/') return next();
            response.setHeader('content-type', 'text/html');
            response.end(await instance.transformIndexHtml('/', html(`/@fs/${entry}`)));
          });
        },
      },
    ],
    define,
    optimizeDeps: {
      entries: [
        entry,
        path.join(directory, '../src/native-markdown-worker.ts'),
        path.join(directory, '../src/native-image-preview-worker.ts'),
      ],
    },
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    logLevel: 'error',
  });
  await dev.listen();
  const address = dev.httpServer!.address();
  assert.ok(address && typeof address === 'object');
  url = `http://127.0.0.1:${address.port}`;
  const client = dev.environments.client!;
  await Promise.all(
    [
      entry,
      path.join(directory, '../src/native-markdown-worker.ts'),
      path.join(directory, '../src/native-image-preview-worker.ts'),
    ].map((file) => client.warmupRequest(`/@fs/${file}`)),
  );
  await client.waitForRequestsIdle();
  await client.depsOptimizer?.scanProcessing;
  for (;;) {
    const pending = Object.values(client.depsOptimizer?.metadata.discovered ?? {})
      .map((dependency) => dependency.processing)
      .filter((promise): promise is Promise<void> => !!promise);
    if (!pending.length) break;
    await Promise.all(pending);
  }
} else {
  await build({
    root: path.dirname(directory),
    configFile: false,
    envFile: false,
    plugins: [structuralTiming, react(), tailwindcss()],
    define,
    base: './',
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: false,
      minify: profileMode ? false : 'esbuild',
      sourcemap: profileMode,
      lib: { entry, formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' },
      target: 'esnext',
    },
  });
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
      if (pathname === '/')
        return new Response(html('/fixture.js', '<link rel="stylesheet" href="/fixture.css">'), {
          headers: { 'content-type': 'text/html' },
        });
      const file = path.resolve(output, `.${pathname}`);
      if (!file.startsWith(output + path.sep)) return new Response(null, { status: 404 });
      return new Response(Bun.file(file));
    },
  });
  url = server.url.toString();
}
const imageApi = createRequire(new URL('../../../packages/agent/package.json', import.meta.url))(
  '@napi-rs/canvas',
) as {
  loadImage(data: Buffer): Promise<{ width: number; height: number }>;
  createCanvas(
    width: number,
    height: number,
  ): {
    getContext(kind: '2d'): {
      drawImage(image: { width: number; height: number }, x: number, y: number): void;
      getImageData(
        x: number,
        y: number,
        width: number,
        height: number,
      ): { data: Uint8ClampedArray };
    };
  };
};
const browser = electronMode
  ? undefined
  : await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });
let electron: ElectronApplication | undefined;
if (electronMode) {
  const main = path.join(artifact, 'main.cjs');
  writeFileSync(
    main,
    "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({show:true,width:1440,height:800,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));app.on('window-all-closed',()=>app.quit());",
  );
  electron = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron') as string,
    args: [main, `--user-data-dir=${path.join(artifact, 'electron-profile')}`],
  });
}
type Paint = { at: number; stage: number; image: string; metadata: Record<string, unknown> };
const report = {
  mode: developmentMode ? 'development' : 'production',
  browser: browser?.version() ?? 'Electron',
  cpu: cpus()[0]?.model,
  profileMode,
  reactProfilerSupported: developmentMode,
  sourceHashes: Object.fromEntries(
    [
      '../src/native.tsx',
      '../../../packages/ui/src/desktop/Conversation.tsx',
      '../../../packages/ui/src/desktop/MessageContent.tsx',
      './initial-render-performance-browser.fixture.tsx',
      './initial-render-performance-browser-runner.fixture.ts',
    ].map((relative) => [
      relative,
      createHash('sha256')
        .update(readFileSync(path.resolve(directory, relative)))
        .digest('hex'),
    ]),
  ),
  shape,
  blocks,
  windowChecks,
  lateNavigation,
  toolsPerTurn,
  artifact,
  method:
    'Trusted click to first CDP PNG frame whose marker verifies the committed target tail visible; stable marker requires the initial entry window (all entries through 100, otherwise latest 40), unchanged entry keys and height across two RAF samples. History EOF still reads the whole source independently of mounted DOM. Loader/inert/aria-hidden/opacity block readability, and hidden frames do not sample geometry or computed style. DOM times and history EOF are separate. Visible geometry/count sampling is fixture overhead. Message bodies are already present in history, without real Service/body FIFO. React Profiler reports only development commits. Churn compares visible tail text against layout-committed input props and remains active through compositor paint.',
  cases: [] as unknown[],
  pageDiagnostics: [] as {
    turns: number;
    cancel: boolean;
    errors: string[];
    navigationEvents: { at: number; url: string }[];
    viteMessages: { at: number; text: string }[];
    viteEvents: { at: number; payload: unknown }[];
  }[],
};
async function frames(page: Page, count = 4) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let remaining = count;
        const next = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
}

async function checkLoadedSelection(page: Page) {
  const snapshot = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
  const sourceIds = await page.evaluate(() => window.initialRenderFixture.sourceMessages());
  await page.locator('.conversation-viewport').focus();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`);
  const text = await page.evaluate(() => document.getSelection()?.toString() ?? '');
  assert.ok(text.length, 'loaded conversation selection is empty');
  const loaded = new Set(snapshot.messageIds);
  for (const id of sourceIds) {
    const match = /^([um])-large-([0-9]+)$/.exec(id);
    if (!match) continue;
    const marker =
      match[1] === 'u' ? `Question large ${Number(match[2]) + 1}` : `END-large-${match[2]}`;
    assert.equal(
      new RegExp(`${marker}(?![0-9])`).test(text),
      loaded.has(id),
      `selection scope differs for ${id}`,
    );
  }
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  return {
    loadedIds: snapshot.messageIds,
    selectedCharacters: text.length,
    sourceMessages: sourceIds.length,
  };
}

async function waitTail(page: Page, id: string, version: number) {
  await page.waitForFunction(
    ({ id, version }) => {
      const fixture = window.initialRenderFixture;
      const snapshot = fixture.windowSnapshot();
      const message = document.querySelector(`[data-message-id="${id}"]`);
      return (
        snapshot.tailId === id &&
        snapshot.domVersion === version &&
        snapshot.committedVersion === version &&
        !!message?.textContent?.includes(`FIXTURE-VERSION-${version}`)
      );
    },
    { id, version },
    { timeout: 30_000 },
  );
  await frames(page);
}

function checkAnchor(
  observation: Awaited<ReturnType<Window['initialRenderFixture']['endEarlierWatch']>>,
) {
  assert.ok(observation.frames.length >= 2, 'anchor lacks intermediate observations');
  assert.ok(
    observation.frames.every((frame) => frame.connected && frame.sameNode),
    'existing entry was remounted',
  );
  const maxShift = Math.max(
    ...observation.frames.map((frame) => Math.abs(frame.top - observation.baseline)),
  );
  assert.ok(maxShift <= 0.5, `reading anchor shifted by ${maxShift}px`);
  return { ...observation, maxShift };
}

async function windowJourney(page: Page, folder: string) {
  const steps: unknown[] = [];
  const initial = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
  const source = (await page.evaluate(() => window.initialRenderFixture.sourceMessages())).filter(
    (id) => /^[um]-large-[0-9]+$/.test(id),
  );
  steps.push({ phase: 'initial', snapshot: initial, selection: await checkLoadedSelection(page) });
  await page.screenshot({ path: path.join(folder, 'window-initial.png') });
  if (source.length > 100) {
    for (let index = 0; index < 2; index++) {
      const before = await page.evaluate(() => window.initialRenderFixture.beginEarlierWatch());
      const expected = Math.min(source.length, before.entries + 20);
      await page.waitForFunction(
        (expected) => window.initialRenderFixture.windowSnapshot().entryKeys.length === expected,
        expected,
      );
      await frames(page, 6);
      const anchor = checkAnchor(
        await page.evaluate(() => window.initialRenderFixture.endEarlierWatch()),
      );
      const snapshot = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
      assert.deepEqual(
        snapshot.messageIds,
        source.slice(-expected),
        'upper scrolling did not mount the next earlier complete entries',
      );
      steps.push({
        phase: 'earlier',
        snapshot,
        anchor,
        selection: await checkLoadedSelection(page),
      });
      await page.screenshot({ path: path.join(folder, `window-earlier-${index + 1}.png`) });
    }
  }
  if (toolsPerTurn) return steps;
  const jump = page.getByRole('button', { name: '回到最新消息', exact: true });
  if (await jump.count()) await jump.click();
  await page.waitForFunction(() => {
    const snapshot = window.initialRenderFixture.windowSnapshot();
    return snapshot.height - snapshot.clientHeight - snapshot.top <= 1;
  });
  const retained = await page.evaluate(() => window.initialRenderFixture.rememberWindow());
  for (let index = 0; index < 3; index++) {
    const update = await page.evaluate(() => window.initialRenderFixture.appendTurn());
    await waitTail(page, update.tailId, update.version);
    const snapshot = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
    assert.ok(
      snapshot.height - snapshot.clientHeight - snapshot.top <= 1,
      'tail append stopped following',
    );
    const nodes = await page.evaluate(() => window.initialRenderFixture.retainedWindow());
    assert.ok(
      nodes.every((node) => node.connected && node.sameNode),
      'append discarded an already loaded entry',
    );
    assert.ok(retained.every((key) => snapshot.entryKeys.includes(key)));
    steps.push({ phase: 'append-at-bottom', snapshot });
  }
  const stream = await page.evaluate(() => window.initialRenderFixture.beginStream());
  await waitTail(page, stream.tailId, stream.version);
  for (let step = 1; step <= 3; step++) {
    const version = await page.evaluate(
      (step) => window.initialRenderFixture.stream(step, step === 3),
      step,
    );
    await waitTail(page, stream.tailId, version);
    const snapshot = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
    assert.ok(
      snapshot.height - snapshot.clientHeight - snapshot.top <= 1,
      'stream append stopped following',
    );
    assert.equal(
      snapshot.messageIds.filter((id) => id === stream.tailId).length,
      1,
      'stream duplicated its message',
    );
    steps.push({ phase: step === 3 ? 'stream-complete' : 'stream', snapshot });
  }
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.conversation-viewport')!;
    viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
  });
  await frames(page);
  const manual = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
  await page.evaluate(() => window.initialRenderFixture.beginManualWatch());
  const update = await page.evaluate(() => window.initialRenderFixture.appendTurn());
  await page.waitForFunction(
    (version) => window.initialRenderFixture.windowSnapshot().committedVersion === version,
    update.version,
  );
  await frames(page, 8);
  const anchor = checkAnchor(
    await page.evaluate(() => window.initialRenderFixture.endEarlierWatch()),
  );
  const after = await page.evaluate(() => window.initialRenderFixture.windowSnapshot());
  assert.deepEqual(
    after.entryKeys,
    manual.entryKeys,
    'manual reading mounted or trimmed an unrelated new tail',
  );
  assert.ok(
    !after.messageIds.includes(update.tailId),
    'manual window eagerly mounted the unrelated tail',
  );
  steps.push({
    phase: 'manual-append',
    snapshot: after,
    anchor,
    selection: await checkLoadedSelection(page),
  });
  await page.screenshot({ path: path.join(folder, 'window-manual-append.png') });
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await waitTail(page, update.tailId, update.version);
  steps.push({
    phase: 'return-to-latest',
    snapshot: await page.evaluate(() => window.initialRenderFixture.windowSnapshot()),
  });
  await page.screenshot({ path: path.join(folder, 'window-latest.png') });
  return steps;
}

async function lateNavigationJourney(page: Page) {
  await page.evaluate(() => window.initialRenderFixture.rememberWindow());
  const released = await page.evaluate(() => window.initialRenderFixture.releaseHistory());
  assert.ok(released > 0, 'no old response was actually released');
  await frames(page, 12);
  const result = await page.evaluate(() => ({
    snapshot: window.initialRenderFixture.windowSnapshot(),
    nodes: window.initialRenderFixture.retainedWindow(),
    title: document.querySelector('.breadcrumb strong')?.getAttribute('title'),
    draft: document.querySelector('[role="textbox"]')?.textContent,
    released: window.initialRenderFixture.events.filter(
      (event) => event.kind === 'history:released',
    ).length,
  }));
  assert.equal(result.title, 'Small target');
  assert.deepEqual(result.snapshot.messageIds, ['u-small-0', 'm-small-0']);
  assert.ok(result.nodes.every((node) => node.connected && node.sameNode));
  assert.equal(result.draft, 'Draft small');
  assert.ok(result.released > 0);
  return result;
}

let currentPage: Page | undefined;
try {
  for (const turns of counts) {
    for (const cancel of lateNavigation
      ? [true]
      : profileMode || churnMode || windowChecks
        ? [false]
        : [false, true]) {
      const page: Page = electron
        ? await electron.firstWindow()
        : await browser!.newPage({
            viewport: { width: 1440, height: 800 },
            colorScheme: 'light',
            reducedMotion: 'no-preference',
            locale: 'zh-CN',
          });
      currentPage = page;
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
      const errors: string[] = [];
      const navigations: string[] = [];
      const diagnostic = {
        turns,
        cancel,
        errors,
        navigationEvents: [] as { at: number; url: string }[],
        viteMessages: [] as { at: number; text: string }[],
        viteEvents: [] as { at: number; payload: unknown }[],
      };
      report.pageDiagnostics.push(diagnostic);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          navigations.push(frame.url());
          diagnostic.navigationEvents.push({ at: Date.now(), url: frame.url() });
        }
      });
      page.on('console', (message) => {
        if (message.text().includes('[vite]') || message.type() === 'error')
          diagnostic.viteMessages.push({ at: Date.now(), text: message.text() });
      });
      page.on('websocket', (socket) => {
        socket.on('framereceived', ({ payload }) => {
          try {
            const message = JSON.parse(String(payload)) as { type?: string };
            if (['full-reload', 'update', 'error'].includes(message.type ?? ''))
              diagnostic.viteEvents.push({ at: Date.now(), payload: message });
          } catch {
            // Unrelated websocket traffic is not a Vite readiness signal.
          }
        });
      });
      await page.goto(`${url}?turns=${turns}&blocks=${blocks}&tools=${toolsPerTurn}`);
      await page.getByRole('button', { name: 'Small target', exact: true }).click();
      await page.waitForFunction(() => window.initialRenderFixture?.stage() === 3, undefined, {
        timeout: 30_000,
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.enable');
      const pixel = async (data: Buffer) => {
        const image = await imageApi.loadImage(data);
        const canvas = imageApi.createCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return [
          ...context.getImageData(
            image.width - Math.round((image.width / 1440) * 16),
            Math.round((image.height / 800) * 16),
            1,
            1,
          ).data,
        ];
      };
      const colors: number[][] = [];
      for (let stage = 0; stage < 4; stage++) {
        await page.evaluate((value) => window.initialRenderFixture.calibrate(value), stage);
        colors.push(await pixel(await page.screenshot()));
      }
      await page.evaluate(() => window.initialRenderFixture.calibrate());
      const caseName = `${turns}-${blocks}-${lateNavigation ? 'late-navigation' : windowChecks ? 'window-journey' : churnMode ? 'churn' : cancel ? 'cancel' : 'initial'}`;
      const folder = path.join(artifact, caseName);
      mkdirSync(folder);
      const paints: Paint[] = [];
      let decoding = Promise.resolve();
      cdp.on('Page.screencastFrame', (event) => {
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
        decoding = decoding.then(async () => {
          const png = Buffer.from(event.data, 'base64');
          const rgba = await pixel(png);
          const stage = colors.findIndex((color) =>
            color.every((value, index) => Math.abs(value - rgba[index]!) <= 4),
          );
          const file = `${String(paints.length).padStart(4, '0')}.png`;
          writeFileSync(path.join(folder, file), png);
          paints.push({
            at: event.metadata.timestamp! * 1000,
            stage,
            image: file,
            metadata: { ...event.metadata },
          });
        });
      });
      await cdp.send('Page.startScreencast', {
        format: 'png',
        everyNthFrame: 1,
        maxWidth: 1440,
        maxHeight: 800,
      });
      const smallBounds = await page
        .getByRole('button', { name: 'Small target', exact: true })
        .boundingBox();
      assert.ok(smallBounds);
      await page.evaluate(() => window.initialRenderFixture.begin());
      if (churnMode) await page.evaluate(() => window.initialRenderFixture.startChurn());
      if (lateNavigation) await page.evaluate(() => window.initialRenderFixture.holdHistory());
      if (profileMode) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      let stopped = false;
      const probeRequests: { requestedAt: number; completedAt?: number }[] = [];
      const probeLoop = async () => {
        while (!stopped) {
          const record = { requestedAt: Date.now(), completedAt: undefined as number | undefined };
          probeRequests.push(record);
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: 1390,
            y: 786,
            button: 'left',
            clickCount: 1,
          });
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: 1390,
            y: 786,
            button: 'left',
            clickCount: 1,
          });
          record.completedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      await page.getByRole('button', { name: 'Large history', exact: true }).click();
      const probing = cancel ? Promise.resolve() : probeLoop();
      let cancelRequestedAt: number | undefined;
      if (cancel) {
        if (lateNavigation)
          await page.waitForFunction(() => window.initialRenderFixture.pendingHistory() > 0);
        else await new Promise((resolve) => setTimeout(resolve, 40));
        cancelRequestedAt = Date.now();
        const x = smallBounds.x + smallBounds.width / 2,
          y = smallBounds.y + smallBounds.height / 2;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      }
      await page.waitForFunction(
        (expected) => window.initialRenderFixture.stage() === expected,
        cancel ? 3 : 2,
        { timeout: 120_000 },
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      // Screencast delivery is asynchronous even after the matching RAF. Retain
      // the original compositor timestamp and wait for its PNG to arrive.
      for (let attempt = 0; attempt < 40; attempt++) {
        await decoding;
        if (
          paints.some(
            (paint) =>
              paint.stage === (cancel ? 3 : 2) && (!cancel || paint.at >= cancelRequestedAt!),
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (churnMode) {
        // A fast first window may paint before three ticks. Keep genuine updates
        // running afterwards rather than artificially delaying its first paint.
        await page.waitForFunction(
          () => {
            const fixture = window.initialRenderFixture;
            const readable = fixture.frames.filter(
              (frame) => frame.stage === 1 || frame.stage === 2,
            );
            return (
              fixture.events.filter(
                (event) => event.kind === 'history:incremental' && (event.count ?? 0) > 0,
              ).length >= 3 &&
              readable.some(
                (frame) => frame.domVersion > 1 && frame.domVersion === frame.committedVersion,
              )
            );
          },
          undefined,
          { timeout: 120_000 },
        );
        await page.evaluate(() => window.initialRenderFixture.stopChurn());
      }
      stopped = true;
      await probing;
      const data = await page.evaluate(() => window.initialRenderFixture.end());
      if (profileMode) {
        const { profile } = await cdp.send('Profiler.stop');
        writeFileSync(path.join(folder, 'cpu.cpuprofile'), JSON.stringify(profile));
      }
      await cdp.send('Page.stopScreencast');
      await decoding;
      const click = data.clicks.find((click) => click.target === 'Large history')!;
      assert.ok(click?.trusted, 'large navigation must use a trusted click');
      const first = paints.find(
        (frame) => frame.at >= click.at && (frame.stage === 1 || frame.stage === 2),
      );
      const complete = paints.find((frame) => frame.at >= click.at && frame.stage === 2);
      const smallClick = data.clicks.find(
        (entry) => entry.at > click.at && entry.target === 'Small target',
      );
      const smallPaint = smallClick
        ? paints.find((frame) => frame.at >= smallClick.at && frame.stage === 3)
        : undefined;
      const eof = data.events.find(
        (event) =>
          event.kind === 'history:eof' && event.sessionId === 'large' && event.at >= click.at,
      );
      const nodeCounts = await page.evaluate(() => ({
        elements: document.querySelectorAll('.conversation-viewport *').length,
        messages: document.querySelectorAll('.conversation-viewport [data-message-id]').length,
        entries: document.querySelectorAll('.conversation-viewport .conversation-entry').length,
      }));
      const structural = data.events.find(
        (event) => event.kind === 'structural:ready' && event.at >= click.at,
      );
      const visibleCommits = data.commits.filter(
        (entry) => entry.at >= click.at && entry.at <= (first?.at ?? Number.POSITIVE_INFINITY),
      );
      const expectedInitialEntries = turns * 2 > 100 ? 40 : turns * 2;
      const expectedSourceMessages = turns * (toolsPerTurn + 2);
      const initialWindowFrame = data.frames.find(
        (frame) => frame.at >= click.at && frame.entryKeys.length === expectedInitialEntries,
      );
      const initialReadFrames = data.frames.filter(
        (frame) => frame.at >= click.at && (frame.stage === 1 || frame.stage === 2),
      );
      const sourceMessageIds = new Set(
        data.events
          .filter(
            (event) =>
              event.sessionId === 'large' && event.readKind === 'baseline' && event.at >= click.at,
          )
          .flatMap((event) => event.messageIds ?? []),
      );
      const unblockedFrame = data.frames.find(
        (frame) =>
          frame.at >= click.at &&
          !frame.loader &&
          !frame.hidden &&
          !frame.inert &&
          frame.opacity > 0 &&
          frame.entryKeys.length === expectedInitialEntries,
      );
      const summary = {
        caseName,
        turns,
        sourceMessages: expectedSourceMessages,
        baselineMessagesRead: sourceMessageIds.size,
        expectedInitialEntries,
        initialWindowDomMs: initialWindowFrame ? initialWindowFrame.at - click.at : undefined,
        loaderExitMs: unblockedFrame ? unblockedFrame.at - click.at : undefined,
        blocks,
        cancel,
        churn: churnMode,
        staleVisibleFrames: data.frames.filter((frame) => frame.staleVisible).length,
        churnTicksBeforeReadable: first
          ? data.events.filter((event) => event.kind === 'churn:tick' && event.at < first.at).length
          : undefined,
        revealedBeforeChurnStopped: first
          ? data.events.some((event) => event.kind === 'churn:stop' && event.at > first.at)
          : undefined,
        firstReadablePaintMs: first ? first.at - click.at : undefined,
        loadedWindowStablePaintMs: complete ? complete.at - click.at : undefined,
        historyEofMs: eof ? eof.at - click.at : undefined,
        structuralReadyMs: structural ? structural.at - click.at : undefined,
        structuralToReadablePaintMs: structural && first ? first.at - structural.at : undefined,
        reactCommitCountBeforeReadable: visibleCommits.length,
        reactRenderMsBeforeReadable: visibleCommits.length
          ? visibleCommits.reduce((sum, entry) => sum + entry.duration, 0)
          : undefined,
        maxReactRenderMs: visibleCommits.length
          ? Math.max(...visibleCommits.map((entry) => entry.duration))
          : undefined,
        maxCommitToProfilerCallbackMs: visibleCommits.length
          ? Math.max(...visibleCommits.map((entry) => entry.observedAt - entry.at))
          : undefined,
        eofToReadablePaintMs: eof && first ? first.at - eof.at : undefined,
        maxInitialLongTaskMs: Math.max(
          0,
          ...data.longTasks
            .filter((entry) => entry.at >= click.at && (!first || entry.at <= first.at))
            .map((entry) => entry.duration),
        ),
        maxLongTaskMs: Math.max(
          0,
          ...data.longTasks.filter((entry) => entry.at >= click.at).map((entry) => entry.duration),
        ),
        maxHeartbeatDelayMs: Math.max(0, ...data.heartbeats.map((entry) => entry.delay)),
        maxProbeRoundTripMs: Math.max(
          0,
          ...probeRequests
            .filter((entry) => entry.completedAt)
            .map((entry) => entry.completedAt! - entry.requestedAt),
        ),
        cancelInputDelayMs:
          smallClick && cancelRequestedAt ? smallClick.processedAt - cancelRequestedAt : undefined,
        cancelToSmallPaintMs:
          smallPaint && cancelRequestedAt ? smallPaint.at - cancelRequestedAt : undefined,
        ...nodeCounts,
      };
      const record = {
        summary,
        click,
        cancelRequestedAt,
        smallClick,
        colors,
        paints,
        data,
        probeRequests,
        errors,
        navigations,
        windowJourney: undefined as unknown,
        lateNavigation: undefined as unknown,
      };
      report.cases.push(record);
      writeFileSync(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(summary));
      assert.deepEqual(errors, []);
      assert.equal(navigations.length, 1, 'measurement was interrupted by navigation');
      if (churnMode) {
        assert.equal(
          summary.staleVisibleFrames,
          0,
          'visible DOM differs from committed input snapshot',
        );
        assert.ok(
          data.events.filter(
            (event) => event.kind === 'history:incremental' && (event.count ?? 0) > 0,
          ).length >= 3,
          'fewer than three genuine updates overlapped the readable session',
        );
        assert.equal(summary.revealedBeforeChurnStopped, true, 'render waited for quiet input');
        assert.ok(
          data.events.some(
            (event) => event.kind === 'history:incremental' && (event.count ?? 0) > 0,
          ),
          'no incremental text update returned',
        );
        assert.ok(
          data.frames.some(
            (frame) =>
              (frame.stage === 1 || frame.stage === 2) &&
              frame.domVersion > 1 &&
              frame.domVersion === frame.committedVersion,
          ),
          'revealed original baseline instead of updated committed text',
        );
      }
      if (toolsPerTurn && !cancel) {
        const forbidden = data.events.filter((event) => event.kind.startsWith('cold-reader:'));
        assert.deepEqual(forbidden, [], 'closed process opened a full/source-input reader');
        const toolsObserved = new Set(
          data.events
            .filter((event) => event.kind === 'tools:metadata' && event.sessionId === 'large')
            .flatMap((event) => event.messageIds ?? []),
        );
        assert.equal(
          toolsObserved.size,
          turns * toolsPerTurn,
          'tool metadata was missing or raw history was truncated',
        );
        const folded = await page.evaluate(() => ({
          open: document.querySelectorAll(
            '.conversation-viewport .agent-turn-process[data-state="open"]',
          ).length,
          tools: document.querySelectorAll('.conversation-viewport .tool-activity').length,
        }));
        assert.equal(folded.open, 0, 'cold settled tool process opened before presentation');
        assert.equal(folded.tools, 0, 'closed tool process eagerly mounted activity bodies');
      }
      if (cancel) {
        assert.ok(smallClick?.trusted);
        assert.ok(smallPaint, 'no correct small target compositor frame');
      } else {
        assert.ok(first, 'no readable large target compositor frame');
        assert.ok(complete, 'no stable loaded-window compositor frame');
        assert.equal(
          sourceMessageIds.size,
          expectedSourceMessages,
          'baseline history did not read every source message',
        );
        assert.equal(nodeCounts.entries, expectedInitialEntries);
        assert.equal(nodeCounts.messages, expectedInitialEntries);
        assert.ok(initialReadFrames.length);
        const expectedIds = Array.from({ length: expectedInitialEntries }, (_, index) => {
          const sourceIndex = turns * 2 - expectedInitialEntries + index;
          return `${sourceIndex % 2 ? 'm' : 'u'}-large-${Math.floor(sourceIndex / 2)}`;
        });
        assert.deepEqual(
          initialReadFrames[0]!.messageIds,
          expectedIds,
          'initial DOM is not the latest complete entries',
        );
        if (shape === 'long') {
          const bodyCounts = await page.evaluate(() => ({
            headings: document.querySelectorAll('.reading-column h2').length,
            tables: document.querySelectorAll('.reading-column table').length,
            code: document.querySelectorAll('.reading-column pre').length,
          }));
          assert.deepEqual(
            bodyCounts,
            { headings: blocks, tables: blocks, code: blocks },
            'a single reply was partially mounted',
          );
        }
      }
      if (windowChecks && !cancel) record.windowJourney = await windowJourney(page, folder);
      if (lateNavigation) record.lateNavigation = await lateNavigationJourney(page);
      writeFileSync(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      await page.screenshot({ path: path.join(folder, 'final.png') });
      if (!electron) await page.close();
    }
  }
} catch (error) {
  const failureSnapshot = currentPage
    ? await currentPage
        .evaluate(() => ({
          text: document.body.textContent?.slice(-4000),
          data: window.initialRenderFixture?.end(),
        }))
        .catch(() => undefined)
    : undefined;
  await currentPage?.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
  writeFileSync(
    path.join(artifact, 'report.json'),
    JSON.stringify({ ...report, failure: String(error), failureSnapshot }, null, 2),
  );
  throw error;
} finally {
  console.log(JSON.stringify({ artifact }));
  await browser?.close();
  await electron?.close();
  server?.stop(true);
  await dev?.close();
}
