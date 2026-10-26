import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release } from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import ts from 'typescript';
import { build, createServer, type ViteDevServer } from 'vite';
import type {} from './session-cache-performance-browser.fixture';

const mode = process.argv.includes('--dev') ? 'development' : 'production';
const electronMode = process.argv.includes('--electron');
const profileMode = process.argv.includes('--profile');
const reducedMotion = process.argv.includes('--reduce-motion') ? 'reduce' : 'no-preference';
const iterations = Number(
  process.argv.find((arg) => arg.startsWith('--iterations='))?.slice(13) ?? 100,
);
assert.ok(Number.isInteger(iterations) && iterations > 0 && iterations <= 1000);
const directory = import.meta.dir;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, `session-cache-performance-${mode}-`));
const output = path.join(artifact, 'dist');
const entry = path.join(directory, 'session-cache-performance-browser.fixture.tsx');
const html = (script: string, style = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${style}</head><body style="margin:0"><div id="root"></div><script type="module" src="${script}"></script></body></html>`;
// These readiness attributes are injected only into this standalone test build.
// Neither ordinary development nor production entrypoints load this plugin.
const budgetReadiness = {
  name: 'fixture-only-cache-cost-readiness',
  enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (!id.endsWith('/packages/ui/src/desktop/conversation-cache-cost.ts')) return;
    assert.ok(source.includes('this.measured = { revision, bytes, nodes };'));
    return source
      .replaceAll(
        'this.measured = { revision, bytes, nodes };',
        'this.measured = { revision, bytes, nodes }; this.container.dataset.fixtureCostReady = String(revision);',
      )
      .replaceAll(
        'this.measured = undefined;',
        'this.measured = undefined; delete this.container.dataset.fixtureCostReady;',
      );
  },
};
// Profile-only wrappers identify React work without changing exported components.
const componentProfilers = {
  name: 'fixture-only-component-profilers',
  enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (
      !profileMode ||
      ![
        '/apps/desktop/src/native.tsx',
        '/packages/ui/src/desktop/SessionPage.tsx',
        '/packages/ui/src/desktop/ConversationCache.tsx',
      ].some((path) => id.endsWith(path))
    )
      return;
    const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: { position: number; text: string }[] = [];
    const names = new Set([
      'SessionPage',
      'SessionPageContent',
      'Sidebar',
      'MemoizedSidebar',
      'Composer',
      'NativeModelPicker',
      'Conversation',
      'CacheEntry',
      'CacheHost',
    ]);
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
        const tag = ts.isJsxSelfClosingElement(node) ? node.tagName : node.openingElement.tagName;
        const name = tag.getText(file);
        if (names.has(name)) {
          const start = node.getStart(file),
            end = node.getEnd();
          edits.push({
            position: start,
            text: `<FixtureProfiler id="${name}" onRender={window.sessionCachePerformanceFixture.recordComponentCommit}>`,
          });
          edits.push({ position: end, text: '</FixtureProfiler>' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const edit of edits.sort(
      (a, b) => b.position - a.position || (a.text.startsWith('</') ? 1 : -1),
    ))
      source = source.slice(0, edit.position) + edit.text + source.slice(edit.position);
    if (id.endsWith('/apps/desktop/src/native.tsx')) {
      const point = '  return windowFrame(\n    <FixtureProfiler id="SessionPage"';
      assert.ok(source.includes(point));
      source = source.replace(
        point,
        `  window.sessionCachePerformanceFixture.nativeRenders.push({
        at: performance.timeOrigin + performance.now(), selected: selected.current,
        selection: selection?.session.id, view: selection?.viewSelection,
        pending: pendingReading?.sessionId, phase: historyState.phase,
        metadataLoading: historyMetadataLoading, choiceIdentity, resolvedChoice,
        nextModelReady, sessionLoading,
      });\n${point}`,
      );
    }
    return edits.length ? `import {Profiler as FixtureProfiler} from 'react';\n${source}` : source;
  },
};
// Direct call instrumentation preserves setter identities and never enters the
// normal build. Source lines identify which effect requested a nested update.
const stateUpdateTrace = {
  name: 'fixture-only-state-update-trace',
  enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (!profileMode || !id.includes('/apps/desktop/src/native') || !/\.tsx?$/.test(id)) return;
    const file = ts.createSourceFile(
      id,
      source,
      ts.ScriptTarget.Latest,
      true,
      id.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^set[A-Z]/.test(node.expression.text)
      ) {
        const start = node.expression.getStart(file);
        const name = node.expression.text;
        const line = file.getLineAndCharacterOfPosition(start).line + 1;
        edits.push({
          start,
          end: node.expression.getEnd(),
          text: `(window.sessionCachePerformanceFixture.stateUpdates.push({at:performance.timeOrigin+performance.now(),source:${JSON.stringify(`${path.basename(id)}:${line}:${name}`)}}),${name})`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const edit of edits.sort((a, b) => b.start - a.start))
      source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    return edits.length ? source : undefined;
  },
};
const define = {
  __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false',
  'process.env.NODE_ENV': JSON.stringify(mode),
};
let development: ViteDevServer | undefined;
let production: ReturnType<typeof Bun.serve> | undefined;
let url: string;
if (mode === 'development') {
  development = await createServer({
    root: path.dirname(directory),
    configFile: false,
    envFile: false,
    plugins: [
      stateUpdateTrace,
      componentProfilers,
      budgetReadiness,
      react(),
      tailwindcss(),
      {
        name: 'isolated-cache-performance-entry',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/') return next();
            response.setHeader('content-type', 'text/html');
            response.end(await server.transformIndexHtml('/', html(`/@fs/${entry}`)));
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
  await development.listen();
  const address = development.httpServer!.address();
  assert.ok(address && typeof address === 'object');
  url = `http://127.0.0.1:${address.port}`;
} else {
  await build({
    root: path.dirname(directory),
    configFile: false,
    envFile: false,
    plugins: [componentProfilers, budgetReadiness, react(), tailwindcss()],
    base: './',
    logLevel: 'error',
    define,
    build: {
      outDir: output,
      emptyOutDir: false,
      lib: { entry, formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' },
      target: 'esnext',
    },
  });
  production = Bun.serve({
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
  url = production.url.toString();
}

const canvasPackage = createRequire(
  new URL('../../../packages/agent/package.json', import.meta.url),
)('@napi-rs/canvas') as {
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
type CapturedFrame = {
  timestamp: number;
  metadata: Record<string, unknown>;
  sessionId?: string;
  width: number;
  height: number;
  pixel: number[];
  image: string;
};
type SwitchResult = {
  click: { index: number; target: string; at: number; trusted: boolean };
  paintAt: number;
  paintMs: number;
  domAt: number;
  same: boolean;
  scrollTop: number;
  scrollObservedAt: number;
  frames: number;
  scansBeforePaint: number;
  longTasks: { start: number; duration: number }[];
  reactCommits: { phase: string; actualDuration: number; commitTime: number }[];
  componentCommits: { id: string; phase: string; actualDuration: number; commitTime: number }[];
};
const frameFolder = path.join(artifact, 'paint-frames');
mkdirSync(frameFolder);
const report = {
  mode,
  reducedMotion,
  environment: {
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    bun: Bun.version,
    react: createRequire(import.meta.url)('react/package.json').version as string,
    profileMode,
    desktopDiagnostics: false,
  },
  browser: browser?.version() ?? 'Electron',
  iterations,
  method:
    'Trusted click timeOrigin + event.timeStamp to first decoded matching PNG compositor screencast frame; raw timestamp and PNG retained. Marker requires correct title, 20 user/20 assistant messages, final reply, table and code. DOM timestamps are reported separately.',
  cases: [] as SwitchResult[],
  frames: [] as Omit<CapturedFrame, 'image'>[],
  errors: [] as string[],
  navigations: [] as { url: string; at: number }[],
  viteMessages: [] as string[],
  viteEvents: [] as { at: number; payload: unknown }[],
  boundaries: {} as Record<string, unknown>,
  summary: undefined as
    | {
        artifact: string;
        mode: string;
        p50: number;
        p95: number;
        max: number;
        samples: number;
        errors: string[];
      }
    | undefined,
};
try {
  let page: Page;
  if (electronMode) {
    const main = path.join(artifact, 'main.cjs');
    writeFileSync(
      main,
      `const {app,BrowserWindow}=require('electron');
      app.whenReady().then(()=>new BrowserWindow({show:true,autoHideMenuBar:true,
        webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));
      app.on('window-all-closed',()=>app.quit());`,
    );
    electron = await _electron.launch({
      executablePath: createRequire(import.meta.url)('electron') as string,
      args: [main, `--user-data-dir=${path.join(artifact, 'electron-profile')}`],
    });
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 800),
    );
    page = await electron.firstWindow();
    await page.emulateMedia({ colorScheme: 'light', reducedMotion });
    report.browser = await page.evaluate(() => navigator.userAgent);
  } else {
    page = await browser!.newPage({
      viewport: { width: 1440, height: 800 },
      colorScheme: 'light',
      locale: 'zh-CN',
      reducedMotion,
    });
  }
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) report.navigations.push({ url: frame.url(), at: Date.now() });
  });
  page.on('console', (message) => {
    if (message.text().includes('[vite]') || message.type() === 'error')
      report.viteMessages.push(message.text());
  });
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as { type?: string };
        if (message.type === 'full-reload' || message.type === 'update' || message.type === 'error')
          report.viteEvents.push({ at: Date.now(), payload: message });
      } catch {
        // Other websocket protocols have no role in dependency readiness.
      }
    });
  });
  if (development) {
    const client = development.environments.client!;
    await Promise.all([
      client.warmupRequest(`/@fs/${entry}`),
      client.warmupRequest(`/@fs/${path.join(directory, '../src/native-markdown-worker.ts')}`),
      client.warmupRequest(`/@fs/${path.join(directory, '../src/native-image-preview-worker.ts')}`),
    ]);
    await client.waitForRequestsIdle();
    const optimizer = client.depsOptimizer;
    await optimizer?.scanProcessing;
    for (;;) {
      const pending = Object.values(optimizer?.metadata.discovered ?? {})
        .map((dependency) => dependency.processing)
        .filter((promise): promise is Promise<void> => !!promise);
      if (!pending.length) break;
      await Promise.all(pending);
    }
    report.boundaries.dependencyAdmission = {
      at: Date.now(),
      method:
        'Vite warmupRequest for fixture/workers, waitForRequestsIdle, scanProcessing and all discovered dependency processing promises',
      browserHash: optimizer?.metadata.browserHash,
      optimized: Object.keys(optimizer?.metadata.optimized ?? {}),
      discovered: Object.keys(optimizer?.metadata.discovered ?? {}),
    };
  }
  await page.goto(profileMode ? `${url}${url.includes('?') ? '&' : '?'}profile` : url);
  const ready = async (id: string) => {
    await page.waitForFunction(
      (id) =>
        window.sessionCachePerformanceFixture.markerSession() === id &&
        !document.querySelector('[data-model-trigger]')?.matches(':disabled') &&
        !document.querySelector('fieldset.conversation-cache-entry')?.hasAttribute('aria-busy'),
      id,
    );
    await page.waitForFunction(
      () =>
        !!document.querySelector('.conversation-cache-container[data-fixture-cost-ready]') &&
        window.sessionCachePerformanceFixture.settled(),
    );
  };
  const click = (index: number) =>
    page
      .getByRole('button', { name: `Cache ${String(index + 1).padStart(2, '0')}`, exact: true })
      .click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const actualColors: number[][] = [];
  const scrollBaselines: { sessionId: string; at: number; scrollTop: number; reason: string }[] =
    [];
  const warmPageNodes: {
    sessionId: string;
    nodes: number;
    elements: number;
    text: number;
    comments: number;
  }[] = [];
  const markerPixel = async (data: Buffer) => {
    const image = await canvasPackage.loadImage(data);
    const canvas = canvasPackage.createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(image.width - 16, 16, 1, 1).data];
  };
  // Warm all nine pages, confirming each original viewport rather than sleeping
  // a fixed period and assuming asynchronous cache admission has happened.
  for (let index = 0; index < 9; index++) {
    await click(index);
    await ready(`s-${index}`);
    await page.evaluate((id) => window.sessionCachePerformanceFixture.remember(id), `s-${index}`);
    scrollBaselines.push(
      await page.evaluate(
        (sessionId) => ({
          sessionId,
          at: performance.timeOrigin + performance.now(),
          scrollTop: document.querySelector<HTMLElement>('.conversation-viewport')!.scrollTop,
          reason: 'warm admitted original page',
        }),
        `s-${index}`,
      ),
    );
    const nodeCost = await page.evaluate((sessionId) => {
      const container = document.querySelector('.conversation-cache-container')!;
      const walker = document.createTreeWalker(container, 0xffffffff);
      let nodes = 0,
        elements = 0,
        text = 0,
        comments = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes++;
        if (node.nodeType === 1) elements++;
        else if (node.nodeType === 3) text++;
        else if (node.nodeType === 8) comments++;
      }
      return { sessionId, nodes, elements, text, comments };
    }, `s-${index}`);
    assert.ok(
      nodeCost.nodes <= 2000,
      `small session ${index} exceeded 2000 full DOM nodes: ${nodeCost.nodes}`,
    );
    warmPageNodes.push(nodeCost);
    const calibration = new Promise<number[]>((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error('compositor calibration deadline')), 3000);
      cdp.once('Page.screencastFrame', (event) => {
        clearTimeout(deadline);
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
        const png = Buffer.from(event.data, 'base64');
        writeFileSync(path.join(artifact, `warm-s-${index}.png`), png);
        void markerPixel(png).then(resolve, reject);
      });
    });
    await cdp.send('Page.startScreencast', {
      format: 'png',
      everyNthFrame: 1,
      maxWidth: 1440,
      maxHeight: 800,
    });
    actualColors[index] = await calibration;
    await cdp.send('Page.stopScreencast');
  }
  for (let index = 0; index < 9; index++) {
    await click(index);
    await ready(`s-${index}`);
    assert.equal(
      await page.evaluate((id) => window.sessionCachePerformanceFixture.same(id), `s-${index}`),
      true,
      `nine-page warm set lost original s-${index}`,
    );
  }
  const nodes = await page.evaluate(() => {
    const root = document.querySelector('.conversation-cache-container')!;
    const walker = document.createTreeWalker(root, 0xffffffff);
    let count = 0;
    while (walker.nextNode()) count++;
    return count;
  });
  assert.ok(nodes <= 2000, `small-session fixture exceeded 2000 DOM nodes: ${nodes}`);
  report.boundaries.nodesPerConversation = nodes;
  report.boundaries.warmPages = warmPageNodes;
  report.boundaries.nodeMeasurement =
    'TreeWalker SHOW_ALL descendants, including text/comment and excluding container itself, identical to budget estimator';
  report.boundaries.originalIdentityPages = warmPageNodes.map((page) => page.sessionId);
  report.boundaries.directory = { workspaces: 20, sessions: 100, turns: 20, messages: 40 };
  assert.equal(report.navigations.length, 1, 'warm admission must not contain a Vite page reload');
  report.boundaries.measurementStartedAt = Date.now();

  if (profileMode) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const captured: CapturedFrame[] = [];
  let decoding = Promise.resolve();
  const colors = actualColors;
  report.boundaries.actualMarkerColors = actualColors;
  report.boundaries.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
  }));
  cdp.on('Page.screencastFrame', (event) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    decoding = decoding.then(async () => {
      const image = await canvasPackage.loadImage(Buffer.from(event.data, 'base64'));
      const canvas = canvasPackage.createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const x = Math.max(0, image.width - Math.round((image.width / 1440) * 16));
      const y = Math.max(0, Math.round((image.height / 800) * 16));
      const pixel = [...context.getImageData(x, y, 1, 1).data];
      const color = colors.findIndex((rgb) =>
        rgb.every((component, index) => Math.abs(component - pixel[index]!) <= 4),
      );
      captured.push({
        timestamp: event.metadata.timestamp!,
        metadata: { ...event.metadata },
        sessionId: color >= 0 ? `s-${color}` : undefined,
        width: image.width,
        height: image.height,
        pixel,
        image: event.data,
      });
      const { image: _image, ...frame } = captured[captured.length - 1]!;
      report.frames.push(frame);
      writeFileSync(
        path.join(frameFolder, `${String(captured.length - 1).padStart(4, '0')}.png`),
        Buffer.from(event.data, 'base64'),
      );
    });
  });
  await cdp.send('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
    maxWidth: 1440,
    maxHeight: 800,
  });
  const waitPaint = async (target: string, after: number) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      await decoding;
      const frame = captured.find(
        (frame) => frame.sessionId === target && frame.timestamp * 1000 >= after,
      );
      if (frame) return frame;
      assert.ok(Date.now() < deadline, `no compositor frame for ${target}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const measure = async (index: number) => {
    const target = `s-${index}`;
    const before = await page.evaluate(() => window.sessionCachePerformanceFixture.clicks.length);
    await click(index);
    const input = await page.evaluate(
      (before) => window.sessionCachePerformanceFixture.clicks[before]!,
      before,
    );
    if (!input)
      report.boundaries.clickCaptureFailure = await page.evaluate(() => ({
        href: location.href,
        timeOrigin: performance.timeOrigin,
        clicks: window.sessionCachePerformanceFixture?.clicks,
        body: document.body.textContent?.slice(0, 300),
      }));
    assert.ok(input, 'trusted click disappeared, inspect navigation evidence');
    assert.equal(input.target, target);
    assert.equal(input.trusted, true, 'performance measurements require a trusted physical click');
    const frame = await waitPaint(target, input.at);
    const observed = await page.evaluate(
      ({ target, after, paintAt }) => {
        const fixture = window.sessionCachePerformanceFixture;
        const dom = fixture.domFrames.find(
          (frame) =>
            frame.at >= after &&
            frame.complete &&
            frame.sessionId === target &&
            frame.title === `Cache ${String(Number(target.slice(2)) + 1).padStart(2, '0')}`,
        );
        return {
          domAt: dom?.at ?? -1,
          same: fixture.same(target),
          scrollTop: document.querySelector<HTMLElement>('.conversation-viewport')?.scrollTop ?? -1,
          scrollObservedAt: performance.timeOrigin + performance.now(),
          longTasks: fixture.longTasks.filter(
            (task) => task.start >= after && task.start <= paintAt,
          ),
          componentCommits: fixture.componentCommits.filter(
            (commit) => commit.commitTime >= after && commit.commitTime <= paintAt,
          ),
          reactCommits: fixture.reactCommits.filter(
            (commit) => commit.commitTime >= after && commit.commitTime <= paintAt,
          ),
          scansBeforePaint: fixture.scans.filter((scan) => scan.at >= after && scan.at <= paintAt)
            .length,
        };
      },
      { target, after: input.at, paintAt: frame.timestamp * 1000 },
    );
    const result: SwitchResult = {
      click: input,
      paintAt: frame.timestamp * 1000,
      paintMs: frame.timestamp * 1000 - input.at,
      frames: captured.length,
      ...observed,
    };
    report.cases.push(result);
    assert.equal(result.same, true, `hot switch remounted ${target}`);
    assert.equal(
      result.scansBeforePaint,
      0,
      `budget scan blocked the first target paint for ${target}`,
    );
    assert.ok(
      result.paintMs >= 0 && result.paintMs < 3000,
      'compositor and click clocks did not align',
    );
    await ready(target);
    return result;
  };
  // Five early samples validate timestamp alignment before the full run.
  for (let index = 0; index < Math.min(iterations, 5); index++) await measure(index % 9);
  for (let index = 5; index < iterations; index++) await measure(index % 9);

  await page.evaluate(() => window.sessionCachePerformanceFixture.setSelectionDelay(500));
  const heldIndex = Number(report.cases.at(-1)!.click.target.slice(2)) === 0 ? 1 : 0;
  const delayed = await measure(heldIndex);
  const delayedRequest = await page.evaluate(
    ({ target, after }) =>
      window.sessionCachePerformanceFixture.selections.find(
        (selection) => selection.sessionId === target && selection.startedAt >= after,
      ),
    { target: delayed.click.target, after: delayed.click.at },
  );
  assert.ok(
    delayedRequest?.settledAt && delayedRequest.settledAt - delayed.paintAt >= 400,
    '500ms selection must remain unconfirmed at the first target paint',
  );
  report.boundaries.delayedSelection = { ...delayed, request: delayedRequest };
  await page.evaluate(() => window.sessionCachePerformanceFixture.setSelectionDelay(0));

  // Park a manual position and an actual editor draft, then return through an
  // unconfirmed selection. Both identity and request gates must hold.
  const parkedBaseline = await page.evaluate((sessionId) => {
    const viewport = document.querySelector<HTMLElement>('.conversation-viewport')!;
    const at = performance.timeOrigin + performance.now();
    viewport.scrollTop = 240;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      sessionId,
      at,
      scrollTop: viewport.scrollTop,
      reason: 'explicit user scroll before held selection',
    };
  }, `s-${heldIndex}`);
  scrollBaselines.push(parkedBaseline);
  const parked = parkedBaseline.scrollTop;
  const source = heldIndex;
  const privateDraft = `Private draft s-${source} 雪🙂`;
  await page.locator('[role="textbox"][aria-label="当前会话私有草稿"]').fill(privateDraft);
  const other = source === 0 ? 1 : 0;
  await measure(other);
  await page.evaluate(() => window.sessionCachePerformanceFixture.holdNextSelection());
  const beforeHeld = await page.evaluate(() => window.sessionCachePerformanceFixture.clicks.length);
  await click(source);
  await page.waitForFunction(
    (id) => window.sessionCachePerformanceFixture.pending(id),
    `s-${source}`,
  );
  const heldClick = await page.evaluate(
    (index) => window.sessionCachePerformanceFixture.clicks[index]!,
    beforeHeld,
  );
  const heldPaint = await waitPaint(`s-${source}`, heldClick.at);
  const gated = await page.evaluate(
    ({ source, parked }) => {
      const fixture = window.sessionCachePerformanceFixture;
      const start = fixture.requests.length;
      const fieldset = document.querySelector('fieldset.conversation-cache-entry')!;
      const copy = document.querySelector<HTMLButtonElement>('.message-copy');
      const submit = document.querySelector<HTMLButtonElement>('.composer button[type="submit"]');
      copy?.click();
      submit?.click();
      return {
        same: fixture.same(`s-${source}`),
        scrollTop: document.querySelector<HTMLElement>('.conversation-viewport')!.scrollTop,
        scrollObservedAt: performance.timeOrigin + performance.now(),
        expectedScrollTop: parked,
        disabled: fieldset.getAttribute('aria-disabled'),
        submitDisabled: submit?.disabled,
        newRequests: fixture.requests.slice(start),
        draft: document.querySelector('[role="textbox"]')?.textContent,
      };
    },
    { source, parked },
  );
  assert.equal(gated.same, true);
  assert.equal(gated.disabled, 'true');
  assert.equal(gated.submitDisabled, true);
  assert.equal(gated.scrollTop, parked);
  assert.deepEqual(gated.newRequests, []);
  const heldRequests = await page.evaluate(
    (after) =>
      window.sessionCachePerformanceFixture.requests.filter((request) => request.at >= after),
    heldClick.at,
  );
  const unsafeReads = heldRequests.filter(
    (request) =>
      !['select', 'state'].includes(request.method) && !request.method.endsWith('.close'),
  );
  assert.deepEqual(
    unsafeReads,
    [],
    'pending selection must not start reads using cached authority',
  );
  report.boundaries.held = {
    ...gated,
    click: heldClick,
    paintAt: heldPaint.timestamp * 1000,
    frameIndex: captured.indexOf(heldPaint),
    paintMs: heldPaint.timestamp * 1000 - heldClick.at,
    requests: heldRequests,
  };
  // A late original select is deliberately resolved only after the newer target
  // has been admitted. It must not start history reads or replace that page.
  await measure(other);
  const callsBeforeLate = await page.evaluate(
    () => window.sessionCachePerformanceFixture.requests.length,
  );
  await page.evaluate((id) => window.sessionCachePerformanceFixture.release(id), `s-${source}`);
  await ready(`s-${other}`);
  const late = await page.evaluate(
    (before) => ({
      selected: window.sessionCachePerformanceFixture.markerSession(),
      requests: window.sessionCachePerformanceFixture.requests.slice(before),
    }),
    callsBeforeLate,
  );
  assert.equal(late.selected, `s-${other}`);
  assert.deepEqual(late.requests, []);
  report.boundaries.lateSelection = late;
  await measure(source);
  const restoredDraft = await page
    .locator('[role="textbox"][aria-label="当前会话私有草稿"]')
    .textContent();
  assert.equal(restoredDraft, privateDraft);
  report.boundaries.restoredDraft = restoredDraft;

  await cdp.send('Page.stopScreencast');
  await decoding;
  const positionSamples = await page.evaluate(() => {
    const fixture = window.sessionCachePerformanceFixture;
    return {
      scroll: fixture.scrollSamples,
      dom: fixture.domFrames
        .filter((frame) => frame.complete && frame.sessionId)
        .map((frame) => ({
          at: frame.at,
          sessionId: frame.sessionId!,
          scrollTop: frame.scrollTop,
        })),
      clicks: fixture.clicks,
    };
  });
  const positionChecks = [];
  for (const result of [
    ...report.cases,
    {
      click: heldClick,
      paintAt: heldPaint.timestamp * 1000,
      scrollTop: gated.scrollTop,
      scrollObservedAt: gated.scrollObservedAt,
    },
  ]) {
    const leaveAt =
      positionSamples.clicks.find((click) => click.index > result.click.index)?.at ?? Infinity;
    const samples = [
      { at: result.scrollObservedAt, sessionId: result.click.target, scrollTop: result.scrollTop },
      ...positionSamples.scroll,
      ...positionSamples.dom,
    ].filter(
      (sample) =>
        sample.at >= result.paintAt &&
        sample.at < leaveAt &&
        sample.sessionId === result.click.target,
    );
    for (const sample of samples) {
      const baseline = [...scrollBaselines]
        .reverse()
        .find((value) => value.sessionId === sample.sessionId && value.at <= sample.at);
      assert.ok(baseline, `missing reading position baseline for ${sample.sessionId}`);
      assert.equal(
        sample.scrollTop,
        baseline.scrollTop,
        `reading position moved after first paint for click ${result.click.index}`,
      );
    }
    positionChecks.push({
      click: result.click.index,
      sessionId: result.click.target,
      samples: samples.length,
    });
  }
  report.boundaries.scrollBaselines = scrollBaselines;
  report.boundaries.scrollSamples = positionSamples.scroll;
  report.boundaries.positionChecks = positionChecks;
  assert.equal(report.navigations.length, 1, 'measurement must not contain a Vite page reload');
  if (profileMode) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(path.join(artifact, 'cpu.cpuprofile'), JSON.stringify(profile));
    report.boundaries.reactCommits = await page.evaluate(
      () => window.sessionCachePerformanceFixture.reactCommits,
    );
    report.boundaries.componentCommits = await page.evaluate(
      () => window.sessionCachePerformanceFixture.componentCommits,
    );
    report.boundaries.nativeRenders = await page.evaluate(
      () => window.sessionCachePerformanceFixture.nativeRenders,
    );
    report.boundaries.stateUpdates = await page.evaluate(
      () => window.sessionCachePerformanceFixture.stateUpdates,
    );
  }
  for (let index = 0; index < report.cases.length - 1; index++) {
    const result = report.cases[index]!;
    const next = report.cases[index + 1]!;
    // A manual held/cancelled boundary is checked separately below; normal
    // consecutive measured clicks must never paint another session in between.
    if (next.click.index !== result.click.index + 1) continue;
    const between = captured.filter(
      (frame) => frame.timestamp * 1000 >= result.paintAt && frame.timestamp * 1000 < next.click.at,
    );
    assert.ok(
      between.every((frame) => frame.sessionId === result.click.target),
      `painted target regressed after ${result.click.index}`,
    );
  }
  report.frames = captured.map(({ image: _image, ...frame }) => frame);
  const times = report.cases
    .slice(0, iterations)
    .map((result) => result.paintMs)
    .sort((a, b) => a - b);
  const p95 = times[Math.max(0, Math.ceil(times.length * 0.95) - 1)]!;
  const summary = {
    artifact,
    mode,
    p50: times[Math.floor(times.length * 0.5)]!,
    p95,
    max: times.at(-1)!,
    samples: times.length,
    errors: report.errors,
  };
  report.summary = summary;
  report.boundaries.summary = summary;
  await Bun.write(
    path.join(artifact, 'report.json'),
    JSON.stringify({ ...report, summary }, null, 2),
  );
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(summary));
  assert.ok(
    p95 <= 32,
    `click to first target compositor paint P95 ${p95.toFixed(2)}ms exceeds 32ms`,
  );
} catch (error) {
  await Bun.write(
    path.join(artifact, 'report.json'),
    JSON.stringify({ ...report, failure: String(error) }, null, 2),
  );
  console.error(JSON.stringify({ artifact, mode, failure: String(error) }));
  throw error;
} finally {
  await browser?.close();
  await electron?.close();
  production?.stop(true);
  await development?.close();
}
