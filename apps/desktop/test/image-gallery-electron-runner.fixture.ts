import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron, type Page } from 'playwright';
import { build } from 'vite';
import type { NativeRootWindow } from '../electron/native-root-window';
import type {} from './image-gallery-electron.fixture';

type FixtureNativeState = {
  secondary?: {
    focused: boolean;
    mediaSourceId: string;
    views: { visible: boolean; url?: string }[];
  };
  originalHash?: string;
  windowContentSize: number[];
  rootZoom: number;
  calls: unknown[];
  views: {
    index: number;
    visible: boolean;
    focused?: boolean;
    url?: string;
    bounds: { x: number; y: number; width: number; height: number };
  }[];
};
type FixtureMain = {
  window: NativeRootWindow;
  snapshot(): FixtureNativeState;
  trace(): {
    at: number;
    type: string;
    selectedId?: string;
    status?: string;
    bytes?: number;
    action?: string;
    revision?: string;
  }[];
  clearTrace(): void;
  openOther(): Promise<void>;
  closeOther(): void;
  confirm(): void;
  wake(): void;
  gallery: { dismiss(): void };
};
declare global {
  interface Window {
    galleryRetryProbe: {
      snapshot(): { frames: Record<string, unknown>[]; events: Record<string, unknown>[] };
    };
    galleryFixtureSources: {
      hash(src: string): Promise<string | undefined>;
      snapshot(): { src: string; size: number }[];
    };
    galleryFlickerProbe: {
      clear(): void;
      snapshot(): { events: Record<string, unknown>[]; frames: Record<string, unknown>[] };
    };
    galleryRootBlobProbe: { clear(): void; snapshot(): Record<string, unknown>[] };
  }
  var galleryMain: FixtureMain;
}

const repository = resolve(import.meta.dir, '../../..'),
  cache = join(repository, '.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, 'image-gallery-electron-')),
  output = join(root, 'dist');
const mainBuild = await Bun.build({
  entrypoints: [
    join(import.meta.dir, 'image-gallery-electron-main.fixture.ts'),
    join(import.meta.dir, '../electron/preload.ts'),
    join(import.meta.dir, '../electron/image-gallery-preload.ts'),
    join(import.meta.dir, '../electron/global-dialog-preload.ts'),
  ],
  outdir: root,
  target: 'node',
  format: 'cjs',
  external: ['electron'],
  naming: '[name].cjs',
});
if (!mainBuild.success) throw new AggregateError(mainBuild.logs, 'isolated_main_build_failed');
await build({
  root: resolve(import.meta.dir, '..'),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  base: './',
  logLevel: 'warn',
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: output,
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: {
        fixture: join(import.meta.dir, 'image-gallery-electron.fixture.tsx'),
        'image-gallery': join(import.meta.dir, '../src/native-image-gallery-main.tsx'),
        'global-dialog': join(import.meta.dir, '../src/native-global-dialog-main.tsx'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: 'fixture',
    },
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/native-page')
      return new Response(
        '<!doctype html><meta charset="utf-8"><style>body{background:#f0e5c6;color:#3a2525;padding:30px;font:22px sans-serif}button{padding:20px}</style><h2>Actual Native Browser</h2><p>This right page is a separate production WebContentsView.</p><button onclick="this.textContent=\'CLICKED\';window.clicks=(window.clicks||0)+1">Do not click through</button>',
        { headers: { 'content-type': 'text/html' } },
      );
    if (path === '/image-gallery.html' || path === '/global-dialog.html') {
      const name = path.slice(1, -5);
      return new Response(
        `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/${name}.js"></script>`,
        { headers: { 'content-type': 'text/html' } },
      );
    }
    if (path === '/')
      return new Response(
        '<!doctype html><html class="dark" data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = resolve(output, `.${path}`);
    if (!file.startsWith(`${output}/`)) return new Response(null, { status: 404 });
    return new Response(Bun.file(file));
  },
});
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS'])
  delete env[name];
env.KITE_GALLERY_FIXTURE_DIRECTORY = root;
env.KITE_GALLERY_FIXTURE_URL = server.url.toString();
const application = await _electron.launch({
  executablePath:
    process.env.KITE_GALLERY_ELECTRON_EXECUTABLE ??
    '/Applications/Kite Desktop.app/Contents/Resources/native/electron/Electron.app/Contents/MacOS/Electron',
  args: [join(root, 'image-gallery-electron-main.fixture.cjs')],
  env,
  cwd: repository,
  timeout: 30000,
});
const stages: unknown[] = [],
  errors: string[] = [],
  diagnostics: string[] = [];
let downloads = 0,
  phase = 'launch';
application.process().stderr?.on('data', (chunk) => diagnostics.push(String(chunk)));
try {
  const deadline = Date.now() + 30000;
  let page: Page | undefined;
  while (!page) {
    page = application.windows().find((page) => page.url() === server.url.toString());
    if (Date.now() > deadline) throw Error('actual_root_not_found');
    await new Promise((r) => setTimeout(r, 30));
  }
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('download', () => downloads++);
  await page.waitForFunction(() => !!window.imageGalleryFixture);
  for (const observed of application.windows()) {
    if (observed !== page) {
      observed.on('pageerror', (error) => errors.push(`${observed.url()}: ${error.message}`));
      observed.on('download', () => downloads++);
    }
  }
  const fixtureViewer = application
    .windows()
    .find((candidate) => candidate.url().endsWith('/image-gallery.html'))!;
  await fixtureViewer.evaluate(() => {
    const sources = new Map<string, Blob>();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const src = create(blob);
      if (blob instanceof Blob) sources.set(src, blob);
      return src;
    };
    URL.revokeObjectURL = (src) => {
      sources.delete(src);
      revoke(src);
    };
    window.galleryFixtureSources = {
      async hash(src) {
        const blob = sources.get(src);
        return blob
          ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
          : undefined;
      },
      snapshot() {
        return [...sources].map(([src, blob]) => ({ src, size: blob.size }));
      },
    };
  });
  const waitDisplayed = async (
    index: number,
    expected = {
      name: `original-${index === 5 ? 1 : index + 1}.png`,
      position: index + 1,
      total: 6,
    },
  ) => {
    await fixtureViewer.waitForFunction((expected) => {
      const image = document.querySelector<HTMLImageElement>(
        '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
      );
      const caption = document.querySelector('.image-gallery-caption');
      return (
        caption?.children[0]?.textContent === expected.name &&
        caption.children[1]?.textContent?.trim() === `${expected.position} / ${expected.total}` &&
        image?.alt === expected.name &&
        image.complete &&
        image.naturalWidth === 4096 &&
        getComputedStyle(image).visibility === 'visible' &&
        document.querySelector('.image-gallery-viewport')?.getAttribute('aria-busy') !== 'true'
      );
    }, expected);
    const source = await fixtureViewer
      .locator('.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image')
      .getAttribute('src');
    assert.ok(source);
    const hash = await fixtureViewer.evaluate(
      (src) => window.galleryFixtureSources.hash(src),
      source,
    );
    const expectedHash = await page!.evaluate(
      (index) =>
        (window.imageGalleryFixture.snapshot() as { originals: string[] }).originals[index],
      index,
    );
    assert.equal(hash, expectedHash, 'committed_image_url_bytes_match_target');
  };
  const native = () => application.evaluate(() => globalThis.galleryMain.snapshot());
  const checkpoint = async (stage: string) => {
    phase = stage;
    await page!.waitForTimeout(180);
    const file = join(root, `${stage}.png`);
    await page!.screenshot({ path: file });
    let composed: string | undefined;
    let captureError: string | undefined;
    try {
      const media = await application.evaluate(() =>
        globalThis.galleryMain.window.getMediaSourceId(),
      );
      composed = join(root, `${stage}-native-composed.png`);
      execFileSync('/usr/sbin/screencapture', ['-x', '-l', media.split(':')[1]!, composed]);
    } catch (e) {
      captureError = String(e);
    }
    const state = await page!.evaluate(() => ({
      fixture: window.imageGalleryFixture.snapshot(),
      focus: document.activeElement?.outerHTML?.slice(0, 350),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => ({
        text: node.textContent?.slice(0, 200),
        rect: node.getBoundingClientRect().toJSON(),
      })),
      images: [...document.images].map((node) => ({
        src: node.src,
        alt: node.alt,
        width: node.naturalWidth,
        height: node.naturalHeight,
        rect: node.getBoundingClientRect().toJSON(),
      })),
    }));
    const viewerPage = application
      .windows()
      .find((candidate) => candidate.url().endsWith('/image-gallery.html'));
    const viewerState = viewerPage
      ? await viewerPage.evaluate(() => ({
          focus: document.activeElement?.outerHTML?.slice(0, 350),
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => ({
            text: node.textContent?.slice(0, 200),
            rect: node.getBoundingClientRect().toJSON(),
          })),
          images: [...document.images].map((node) => ({
            alt: node.alt,
            width: node.naturalWidth,
            height: node.naturalHeight,
            rect: node.getBoundingClientRect().toJSON(),
          })),
          body: getComputedStyle(document.body).backgroundColor,
          root: getComputedStyle(document.getElementById('root')!).backgroundColor,
        }))
      : undefined;
    let secondaryComposed: string | undefined;
    const currentNative = await native();
    if (currentNative.secondary) {
      secondaryComposed = join(root, `${stage}-secondary-native-composed.png`);
      execFileSync('/usr/sbin/screencapture', [
        '-x',
        '-l',
        currentNative.secondary.mediaSourceId.split(':')[1]!,
        secondaryComposed,
      ]);
    }
    const value = {
      stage,
      file,
      composed,
      captureError,
      state,
      viewerState,
      secondaryComposed,
      native: await native(),
    };
    stages.push(value);
    writeFileSync(
      join(root, 'progress.json'),
      JSON.stringify({ root, phase, stages, errors, diagnostics, downloads }, null, 2),
    );
    console.log(JSON.stringify({ stage, file, composed, captureError }));
    if (
      process.argv.includes('--observe') &&
      Number.parseInt(stage, 10) >=
        Number(
          process.argv.find((value) => value.startsWith('--observe-from='))?.split('=')[1] ?? 0,
        )
    ) {
      const limit = Date.now() + 600000;
      while (!existsSync(join(root, `${stage}.continue`))) {
        if (Date.now() > limit) throw Error(`observation_timeout:${stage}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  phase = 'navigate';
  await page.evaluate(async (url) => {
    await window.kiteNative!.browserRequest!({
      action: 'navigate',
      id: 'gallery-native-browser',
      input: url,
      draft: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  }, new URL('/native-page', server.url).href);
  await page.waitForTimeout(1000);
  await checkpoint('01-browser-and-draft');
  await page.evaluate(() => window.imageGalleryFixture.add());
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.composer img').length === 6 &&
      [...document.querySelectorAll<HTMLImageElement>('.composer img')].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  await checkpoint('02-six-draft-thumbnails');
  if (process.argv.includes('--retry-decode')) {
    const viewer = fixtureViewer;
    await page.evaluate(() => window.imageGalleryFixture.mode('messages'));
    await page.locator('[data-fixture-user] img').first().waitFor();
    await page.waitForTimeout(500);
    await page.locator('[data-fixture-user] img').first().click();
    await waitDisplayed(0);
    await application.evaluate(() => globalThis.galleryMain.clearTrace());
    await page.evaluate(() => window.imageGalleryFixture.clearTrace());
    await viewer.evaluate(() => {
      const frames: Record<string, unknown>[] = [];
      const events: Record<string, unknown>[] = [];
      const original = HTMLImageElement.prototype.decode;
      const ids = new WeakMap<object, number>();
      let serial = 0,
        failOnce = true;
      const id = (node: object | null) => {
        if (!node) return null;
        let value = ids.get(node);
        if (!value) {
          value = ++serial;
          ids.set(node, value);
        }
        return value;
      };
      HTMLImageElement.prototype.decode = function () {
        const at = performance.timeOrigin + performance.now();
        events.push({
          at,
          type: 'decode',
          node: id(this),
          src: this.src,
          alt: this.alt,
          candidate: !!this.closest('.image-gallery-candidate'),
        });
        if (failOnce && this.alt === 'original-2.png') {
          failOnce = false;
          events.push({ at, type: 'decode-rejected-once', src: this.src });
          return Promise.reject(new DOMException('isolated_decode_once', 'EncodingError'));
        }
        return original.call(this);
      };
      requestAnimationFrame(function sample() {
        const image = document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        );
        const caption = document.querySelector('.image-gallery-caption');
        const candidate = document.querySelector<HTMLImageElement>(
          '.image-gallery-candidate .image-gallery-image',
        );
        frames.push({
          at: performance.timeOrigin + performance.now(),
          node: id(image),
          src: image?.src,
          alt: image?.alt,
          name: caption?.children[0]?.textContent,
          position: caption?.children[1]?.textContent?.trim(),
          visible:
            !!image &&
            image.complete &&
            image.naturalWidth === 4096 &&
            getComputedStyle(image).visibility === 'visible',
          candidate: candidate
            ? { node: id(candidate), src: candidate.src, alt: candidate.alt }
            : undefined,
        });
        requestAnimationFrame(sample);
      });
      window.galleryRetryProbe = {
        snapshot() {
          return { frames: [...frames], events: [...events] };
        },
      };
    });
    const cdp = await viewer.context().newCDPSession(viewer);
    const shots: { at: number; file: string }[] = [];
    cdp.on('Page.screencastFrame', (event) => {
      const file = join(root, `retry-cdp-${String(shots.length).padStart(4, '0')}.jpg`);
      shots.push({ at: (event.metadata.timestamp ?? Date.now() / 1000) * 1000, file });
      writeFileSync(file, Buffer.from(event.data, 'base64'));
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 75,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    const media = await application.evaluate(() =>
      globalThis.galleryMain.window.getMediaSourceId(),
    );
    const movie = join(root, 'retry-native-composed.mov');
    const recording = spawn('/usr/sbin/screencapture', [
      '-x',
      '-v',
      '-V',
      '4',
      '-l',
      media.split(':')[1]!,
      movie,
    ]);
    let recordingError = '';
    recording.stderr.on('data', (chunk) => (recordingError += String(chunk)));
    const recordingDone = new Promise<number | null>((resolve) => recording.once('exit', resolve));
    await page.waitForTimeout(500);
    const prior = await viewer
      .locator('.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image')
      .getAttribute('src');
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await viewer.getByRole('alert').filter({ hasText: '图片预览不可用' }).waitFor();
    const failed = await viewer.evaluate(() => ({
      caption: document.querySelector('.image-gallery-caption')?.textContent,
      name: document.querySelector('.image-gallery-caption')?.children[0]?.textContent,
      src: document.querySelector<HTMLImageElement>(
        '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
      )?.src,
      zoomDisabled: [
        ...document.querySelectorAll<HTMLButtonElement>('.image-gallery-zoom button'),
      ].every((button) => button.disabled),
    }));
    assert.equal(failed.src, prior);
    assert.equal(failed.name, 'original-1.png');
    assert.equal(failed.zoomDisabled, true);
    await checkpoint('40-decoder-failure-retains-A');
    const before = (await application.evaluate(() => globalThis.galleryMain.trace()))
      .filter(
        (event) =>
          event.type === 'viewer-state' && event.status === 'ready' && event.selectedId === '1',
      )
      .at(-1);
    assert.ok(before?.revision);
    await viewer.getByRole('button', { name: '重试', exact: true }).click();
    await waitDisplayed(1);
    await checkpoint('41-same-revision-retry-commits-B');
    const trace = await application.evaluate(() => globalThis.galleryMain.trace());
    const after = trace
      .filter(
        (event) =>
          event.type === 'viewer-state' && event.status === 'ready' && event.selectedId === '1',
      )
      .at(-1);
    assert.equal(after?.revision, before.revision);
    const probe = await viewer.evaluate(() => window.galleryRetryProbe.snapshot());
    assert.equal(probe.events.filter((event) => event.type === 'decode-rejected-once').length, 1);
    assert.equal(probe.frames.filter((frame) => !frame.visible).length, 0);
    assert.equal(probe.frames.filter((frame) => frame.alt !== frame.name).length, 0);
    const retried = await viewer
      .locator('.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image')
      .getAttribute('src');
    const rejected = probe.events.find((event) => event.type === 'decode-rejected-once')?.src;
    assert.notEqual(retried, rejected);
    const recordingExit = await recordingDone;
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    await viewer.keyboard.press('Escape');
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    assert.equal((await viewer.evaluate(() => window.galleryFixtureSources.snapshot())).length, 0);
    await checkpoint('42-retry-close-clears-all-URLs');
    const result = {
      passed: true,
      root,
      failed,
      beforeRevision: before.revision,
      afterRevision: after?.revision,
      probe,
      main: trace,
      reads: await page.evaluate(() => window.imageGalleryFixture.snapshot()),
      shots,
      recording: { movie, exit: recordingExit, error: recordingError },
      stages,
      errors,
      diagnostics,
      downloads,
      qualification:
        'One isolated renderer decode() rejection; real button Retry, same original Blob revision and Native host. Does not claim deterministic React event batching; exact coalesced loading/ready regression is covered by the separate DOM test.',
    };
    writeFileSync(join(root, 'retry-report.json'), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        retryReport: join(root, 'retry-report.json'),
        passed: true,
        revision: before.revision,
        frames: probe.frames.length,
        errors,
        downloads,
      }),
    );
  } else if (process.argv.includes('--flicker')) {
    const viewer = application
      .windows()
      .find((candidate) => candidate.url().endsWith('/image-gallery.html'))!;
    viewer.setDefaultTimeout(12000);
    await viewer.evaluate(() => {
      const events: Record<string, unknown>[] = [];
      const frames: Record<string, unknown>[] = [];
      const nodes = new WeakMap<object, number>();
      let serial = 0,
        lastState: { selectedId?: string; status?: string } = {};
      const identity = (node: object | null) => {
        if (!node) return null;
        let id = nodes.get(node);
        if (!id) {
          id = ++serial;
          nodes.set(node, id);
        }
        return id;
      };
      const stamp = () => performance.timeOrigin + performance.now();
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const src = create(blob);
        events.push({
          at: stamp(),
          type: 'url-create',
          src,
          size: blob instanceof Blob ? blob.size : undefined,
        });
        return src;
      };
      URL.revokeObjectURL = (src) => {
        events.push({ at: stamp(), type: 'url-revoke', src });
        revoke(src);
      };
      window.kiteImageGalleryViewer!.watch((state) => {
        lastState = { selectedId: state?.selectedId, status: state?.image.status };
        events.push({ at: stamp(), type: 'viewer-state', ...lastState });
      });
      document.addEventListener(
        'load',
        (event) => {
          if (event.target instanceof HTMLImageElement)
            events.push({
              at: stamp(),
              type: 'image-load',
              node: identity(event.target),
              src: event.target.src,
              width: event.target.naturalWidth,
              candidate: !!event.target.closest('.image-gallery-candidate'),
            });
        },
        true,
      );
      document.addEventListener(
        'click',
        (event) => {
          const target = event.target instanceof Element ? event.target.closest('button') : null;
          if (target)
            events.push({ at: stamp(), type: 'click', label: target.getAttribute('aria-label') });
        },
        true,
      );
      requestAnimationFrame(function tick(now) {
        const image = document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        );
        const style = image ? getComputedStyle(image) : undefined;
        const candidate = document.querySelector<HTMLImageElement>(
          '.image-gallery-candidate .image-gallery-image',
        );
        const caption = document.querySelector('.image-gallery-caption');
        const busy =
          document.querySelector('.image-gallery-viewport')?.getAttribute('aria-busy') === 'true';
        frames.push({
          at: performance.timeOrigin + performance.now(),
          frameAt: performance.timeOrigin + now,
          ...lastState,
          caption: caption?.textContent,
          captionName: caption?.children[0]?.textContent,
          captionPosition: caption?.children[1]?.textContent?.trim(),
          alt: image?.alt,
          busy,
          candidate: candidate
            ? {
                node: identity(candidate),
                src: candidate.src,
                alt: candidate.alt,
                complete: candidate.complete,
                width: candidate.naturalWidth,
                visibility: getComputedStyle(candidate).visibility,
                ariaHidden: candidate.closest('.image-gallery-stage')?.getAttribute('aria-hidden'),
              }
            : undefined,
          zoomDisabled: [
            ...document.querySelectorAll<HTMLButtonElement>('.image-gallery-zoom button'),
          ].map((button) => button.disabled),
          download: [...document.querySelectorAll('[aria-label="下载图片"]')].map((node) => ({
            tag: node.tagName,
            disabled: node instanceof HTMLButtonElement ? node.disabled : false,
          })),
          node: identity(image),
          src: image?.src,
          complete: image?.complete,
          width: image?.naturalWidth,
          visibility: style?.visibility,
          opacity: style?.opacity,
          spinner: !!document.querySelector('.image-gallery-status'),
          visible:
            !!image &&
            image.complete &&
            image.naturalWidth > 0 &&
            style?.visibility === 'visible' &&
            style.opacity !== '0',
        });
        if (frames.length > 1800) frames.shift();
        requestAnimationFrame(tick);
      });
      window.galleryFlickerProbe = {
        clear() {
          events.length = 0;
          frames.length = 0;
        },
        snapshot() {
          return { events: [...events], frames: [...frames] };
        },
      };
    });
    await page.evaluate(() => {
      const events: Record<string, unknown>[] = [];
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function () {
        const at = performance.timeOrigin + performance.now();
        const bytes = await Reflect.apply(original, this, []);
        events.push({
          at,
          endAt: performance.timeOrigin + performance.now(),
          size: this.size,
          type: this.type,
        });
        return bytes;
      };
      window.galleryRootBlobProbe = {
        clear() {
          events.length = 0;
        },
        snapshot() {
          return [...events];
        },
      };
    });
    const waitReady = waitDisplayed;
    const cases: unknown[] = [];
    for (const scenario of [
      { name: 'draft-zero', mode: 'draft', selector: '.composer img', delay: 0, freshScope: false },
      {
        name: 'user-zero',
        mode: 'messages',
        selector: '[data-fixture-user] img',
        delay: 0,
        freshScope: false,
      },
      {
        name: 'tool-zero',
        mode: 'messages',
        selector: '[data-fixture-tool] img',
        delay: 0,
        freshScope: false,
      },
      {
        name: 'user-delay30',
        mode: 'messages',
        selector: '[data-fixture-user] img',
        delay: 30,
        freshScope: true,
      },
    ]) {
      phase = scenario.name;
      await page.evaluate((scenario) => {
        if (scenario.freshScope) window.imageGalleryFixture.scope(scenario.name);
        window.imageGalleryFixture.mode(scenario.mode);
        window.imageGalleryFixture.readDelay(0);
      }, scenario);
      await page.locator(scenario.selector).first().waitFor();
      await page.waitForTimeout(500);
      await page.waitForFunction(
        () => (window.imageGalleryFixture.snapshot() as { leases: number }).leases === 0,
      );
      await application.evaluate(({ app }) => {
        const window = globalThis.galleryMain.window;
        window.focus();
        window.webContents.focus();
        app.focus({ steal: true });
      });
      await page.locator(scenario.selector).first().click();
      await waitReady(0);
      await page.waitForTimeout(250);
      await page.evaluate((delay) => {
        window.imageGalleryFixture.readDelay(delay);
        window.imageGalleryFixture.clearTrace();
        window.galleryRootBlobProbe.clear();
      }, scenario.delay);
      await viewer.evaluate(() => window.galleryFlickerProbe.clear());
      await application.evaluate(() => globalThis.galleryMain.clearTrace());
      const directory = join(root, scenario.name);
      mkdirSync(directory, { recursive: true });
      const cdp = await viewer.context().newCDPSession(viewer);
      const screenshots: { at: number; file: string }[] = [];
      cdp.on('Page.screencastFrame', (event) => {
        const file = join(directory, `cdp-${String(screenshots.length).padStart(4, '0')}.jpg`);
        screenshots.push({ at: (event.metadata.timestamp ?? Date.now() / 1000) * 1000, file });
        writeFileSync(file, Buffer.from(event.data, 'base64'));
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 75,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });
      const media = await application.evaluate(() =>
        globalThis.galleryMain.window.getMediaSourceId(),
      );
      const movie = join(directory, 'native-composed.mov');
      const recording = spawn('/usr/sbin/screencapture', [
        '-x',
        '-v',
        '-V',
        '4',
        '-l',
        media.split(':')[1]!,
        movie,
      ]);
      let recorderError = '';
      recording.stderr.on('data', (chunk) => (recorderError += String(chunk)));
      const recordingDone = new Promise<number | null>((resolve) =>
        recording.once('exit', resolve),
      );
      await page.waitForTimeout(500);
      const actions: { at: number; target: number }[] = [];
      for (const target of [1, 0, 1, 0]) {
        actions.push({ at: Date.now(), target });
        await viewer
          .getByRole('button', { name: target === 1 ? '下一张图片' : '上一张图片', exact: true })
          .click();
        await waitReady(target);
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(200);
      await cdp.send('Page.stopScreencast');
      await cdp.detach();
      const recordingExit = await recordingDone;
      const viewerTrace = await viewer.evaluate(() => window.galleryFlickerProbe.snapshot());
      const rootState = await page.evaluate(() => window.imageGalleryFixture.snapshot());
      const rootBlob = await page.evaluate(() => window.galleryRootBlobProbe.snapshot());
      const mainTrace = await application.evaluate(() => globalThis.galleryMain.trace());
      const frames = viewerTrace.frames as {
        visible: boolean;
        node: number | null;
        src?: string;
        spinner: boolean;
        status?: string;
        visibility?: string;
      }[];
      const summary = {
        sampledFrames: frames.length,
        blankFrames: frames.filter((frame) => !frame.visible).length,
        noImageFrames: frames.filter((frame) => frame.node === null).length,
        hiddenDecodeFrames: frames.filter(
          (frame) => frame.node !== null && frame.visibility === 'hidden',
        ).length,
        loadingStateFrames: frames.filter((frame) => frame.status === 'loading').length,
        spinnerFrames: frames.filter((frame) => frame.spinner).length,
        distinctImageNodes: new Set(frames.map((frame) => frame.node).filter(Boolean)).size,
        distinctUrls: new Set(frames.map((frame) => frame.src).filter(Boolean)).size,
        captionMismatchFrames: viewerTrace.frames.filter(
          (frame) => frame.visible && frame.alt !== frame.captionName,
        ).length,
        busyWithEnabledZoomFrames: viewerTrace.frames.filter(
          (frame) => frame.busy && (frame.zoomDisabled as boolean[]).some((disabled) => !disabled),
        ).length,
      };
      const result = {
        ...scenario,
        actions,
        summary,
        viewerTrace,
        rootState,
        rootBlob,
        mainTrace,
        screenshots,
        recording: { movie, exit: recordingExit, error: recorderError },
        native: await native(),
      };
      cases.push(result);
      writeFileSync(join(directory, 'trace.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ flicker: scenario.name, summary, recordingExit, movie }));
      await viewer.keyboard.press('Escape');
      await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
      await page.evaluate(() => window.imageGalleryFixture.readDelay(0));
    }
    const extraChecks: unknown[] = [];
    const displayed = () =>
      viewer.evaluate(() => {
        const image = document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        );
        const caption = document.querySelector('.image-gallery-caption');
        return {
          src: image?.src,
          alt: image?.alt,
          name: caption?.children[0]?.textContent,
          position: caption?.children[1]?.textContent?.trim(),
          busy:
            document.querySelector('.image-gallery-viewport')?.getAttribute('aria-busy') === 'true',
          zoomDisabled: [
            ...document.querySelectorAll<HTMLButtonElement>('.image-gallery-zoom button'),
          ].map((button) => button.disabled),
          downloads: [...document.querySelectorAll('[aria-label="下载图片"]')].map((node) => ({
            tag: node.tagName,
            disabled: node instanceof HTMLButtonElement ? node.disabled : false,
          })),
        };
      });
    await viewer.evaluate(() => window.galleryFlickerProbe.clear());
    await application.evaluate(() => globalThis.galleryMain.clearTrace());
    await page.evaluate(() => {
      window.imageGalleryFixture.controlledHold(1, true);
      window.imageGalleryFixture.controlled(0);
    });
    await waitDisplayed(0);
    const originalA = await displayed();
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await viewer.waitForFunction(
      () => document.querySelector('.image-gallery-viewport')?.getAttribute('aria-busy') === 'true',
    );
    const pendingB = await displayed();
    assert.equal(pendingB.src, originalA.src);
    assert.equal(pendingB.name, 'original-1.png');
    assert.equal(pendingB.alt, pendingB.name);
    assert.equal(pendingB.position, '1 / 6');
    assert.ok(pendingB.zoomDisabled.every(Boolean));
    assert.ok(pendingB.downloads.every((button) => button.tag !== 'A' && button.disabled));
    extraChecks.push({ step: 'pending-B-keeps-A-caption-and-disabled-controls', state: pendingB });
    await checkpoint('30-busy-retains-committed-A');
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await waitDisplayed(2);
    await checkpoint('31-C-committed-before-late-B');
    await page.evaluate(() => window.imageGalleryFixture.controlledHold(1, false));
    await page.waitForTimeout(180);
    await waitDisplayed(2);
    const lateC = await displayed();
    extraChecks.push({ step: 'late-B-does-not-replace-C', state: lateC });
    await checkpoint('32-late-B-remains-C');
    const controlledReads = await page.evaluate(
      () =>
        (
          window.imageGalleryFixture.snapshot() as {
            controlledReads: { index: number; settledAt?: number }[];
          }
        ).controlledReads,
    );
    const lateBRead = controlledReads.find((read) => read.index === 1),
      earlierCRead = controlledReads.find((read) => read.index === 2);
    assert.ok(lateBRead?.settledAt !== undefined);
    assert.ok(earlierCRead?.settledAt !== undefined);
    assert.ok(lateBRead.settledAt > earlierCRead.settledAt);
    await page.evaluate(() => window.imageGalleryFixture.controlledFail(3, true));
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await viewer.getByRole('alert').filter({ hasText: '图片预览不可用' }).waitFor();
    const failedD = await displayed();
    assert.equal(failedD.src, lateC.src);
    assert.equal(failedD.name, 'original-3.png');
    assert.equal(failedD.alt, failedD.name);
    assert.equal(failedD.position, '3 / 6');
    assert.ok(failedD.zoomDisabled.every(Boolean));
    extraChecks.push({ step: 'failed-D-keeps-C-and-explains-requested-D', state: failedD });
    await checkpoint('33-failed-D-retains-C-name');
    await page.evaluate(() => window.imageGalleryFixture.controlledFail(3, false));
    await viewer.getByRole('button', { name: '重试', exact: true }).click();
    await waitDisplayed(3);
    await checkpoint('34-retry-atomically-commits-D');
    await page.evaluate(() => window.imageGalleryFixture.controlledRemove(3));
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    assert.equal((await viewer.evaluate(() => window.galleryFixtureSources.snapshot())).length, 0);
    extraChecks.push({ step: 'current-source-removed-clears-native-URLs' });
    await checkpoint('35-current-source-removed-closes-and-clears');
    await page.locator('[data-fixture-user] img').first().click();
    await waitDisplayed(0);
    await page.evaluate(() => window.imageGalleryFixture.readAvailable(false));
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    assert.equal((await viewer.evaluate(() => window.galleryFixtureSources.snapshot())).length, 0);
    await checkpoint('36-native-read-revoked-clears-gallery');
    await page.evaluate(() => window.imageGalleryFixture.readAvailable(true));
    await page.locator('[data-fixture-user] img').first().click();
    await waitDisplayed(0);
    await page.evaluate(() => window.imageGalleryFixture.scope('revoked-scope'));
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    await page.waitForTimeout(180);
    assert.equal((await viewer.evaluate(() => window.galleryFixtureSources.snapshot())).length, 0);
    await checkpoint('37-scope-change-clears-all-native-URLs');
    const stressTrace = await viewer.evaluate(() => window.galleryFlickerProbe.snapshot());
    assert.equal(
      stressTrace.frames.filter((frame) => frame.visible && frame.alt !== frame.captionName).length,
      0,
    );
    assert.equal(
      stressTrace.frames.filter(
        (frame) => frame.busy && (frame.zoomDisabled as boolean[]).some((disabled) => !disabled),
      ).length,
      0,
    );
    writeFileSync(
      join(root, 'stress-trace.json'),
      JSON.stringify(
        {
          extraChecks,
          viewer: stressTrace,
          main: await application.evaluate(() => globalThis.galleryMain.trace()),
          root: await page.evaluate(() => window.imageGalleryFixture.snapshot()),
          stages,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(root, 'flicker-report.json'),
      JSON.stringify(
        {
          root,
          electron: await application.evaluate(() => process.versions.electron),
          cases,
          extraChecks,
          errors,
          diagnostics,
          downloads,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ flickerReport: join(root, 'flicker-report.json'), errors, downloads }),
    );
  } else if (process.argv.includes('--scaffold-only')) {
    console.log(JSON.stringify({ scaffold: true, root, errors, native: await native() }));
  } else {
    const viewer = application
      .windows()
      .find((candidate) => candidate.url().endsWith('/image-gallery.html'))!;
    assert.ok(viewer, 'actual_native_gallery_renderer');
    viewer.setDefaultTimeout(12000);
    const waitOriginal = async (
      index: number,
      expected = {
        name: `original-${index === 5 ? 1 : index + 1}.png`,
        position: index + 1,
        total: 6,
      },
    ) => {
      await viewer.locator('.image-gallery-dialog').waitFor();
      await waitDisplayed(index, expected);
      const geometry = await viewer.locator('.image-gallery-dialog').evaluate((node) => ({
        box: node.getBoundingClientRect().toJSON(),
        translate: getComputedStyle(node).translate,
        width: innerWidth,
        height: innerHeight,
      }));
      assert.equal(geometry.box.x, 0);
      assert.equal(geometry.box.y, 0);
      assert.ok(Math.abs(geometry.box.width - geometry.width) < 1);
      assert.ok(Math.abs(geometry.box.height - geometry.height) < 1);
      assert.ok(['none', '0px', '0px 0px'].includes(geometry.translate));
      const expectedHash = await page!.evaluate(
        (index) =>
          (window.imageGalleryFixture.snapshot() as { originals: string[] }).originals[index],
        index,
      );
      const hash = (await native()).originalHash;
      assert.equal(hash, expectedHash, 'displayed_transport_bytes_are_original');
      const state = await native();
      assert.ok(
        state.views.find((view: { url?: string; visible: boolean }) =>
          view.url?.endsWith('/native-page'),
        )?.visible ||
          state.views.find((view: { url?: string; visible: boolean }) =>
            view.url?.startsWith('kite-preview:'),
          )?.visible,
        'underlying_native_view_stays_visible',
      );
      const gallery = state.views.find((view: { url?: string }) =>
        view.url?.endsWith('/image-gallery.html'),
      );
      assert.ok(gallery);
      assert.equal(gallery.visible, true);
      assert.equal(gallery.bounds.width, state.windowContentSize[0]);
      assert.equal(gallery.bounds.height, state.windowContentSize[1]);
      assert.ok(Math.abs(geometry.box.width - gallery.bounds.width / state.rootZoom) < 1);
      assert.ok(Math.abs(geometry.box.height - gallery.bounds.height / state.rootZoom) < 1);
      assert.equal(gallery.bounds.x, 0);
      assert.equal(gallery.bounds.y, 0);
    };
    const open = async (
      locator: ReturnType<Page['locator']>,
      index: number,
      expected = {
        name: `original-${index === 5 ? 1 : index + 1}.png`,
        position: index + 1,
        total: 6,
      },
    ) => {
      await application.evaluate(({ app }) => {
        const window = globalThis.galleryMain.window;
        window.show();
        window.focus();
        window.webContents.focus();
        app.focus({ steal: true });
      });
      await locator.click();
      await waitOriginal(index, expected);
    };
    const close = async () => {
      await application.evaluate(({ app }) => {
        const window = globalThis.galleryMain.window;
        window.focus();
        app.focus({ steal: true });
      });
      await viewer.keyboard.press('Escape');
      await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
      await page!.waitForTimeout(80);
    };
    await open(page.locator('.composer img').nth(0), 0);
    await checkpoint('03-draft-open-original');
    for (let index = 1; index < 6; index++) {
      await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
      await viewer.getByText(`${index + 1} / 6`, { exact: true }).waitFor();
      await waitOriginal(index);
      await checkpoint(`04-draft-switch-${index + 1}`);
    }
    assert.equal(
      await viewer.getByRole('button', { name: '下一张图片', exact: true }).isDisabled(),
      true,
    );
    await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
    await viewer
      .getByRole('button', { name: '重置图片缩放', exact: true })
      .filter({ hasText: '125%' })
      .waitFor();
    await checkpoint('05-zoom-125');
    await viewer.keyboard.press('ArrowLeft');
    await viewer.getByText('5 / 6', { exact: true }).waitFor();
    await waitOriginal(4);
    await checkpoint('06-keyboard-switch');
    await close();
    await checkpoint('07-closed-focus');
    await open(page.locator('.composer img').nth(1), 1);
    await checkpoint('08-reopen-selected');
    await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    await page.evaluate(() => window.imageGalleryFixture.mode('messages'));
    await page.locator('[data-fixture-user] img').first().waitFor();
    await page.waitForTimeout(1000);
    await checkpoint('09-user-tool-groups');
    await open(page.locator('[data-fixture-user] img').nth(2), 2);
    await viewer.getByText('3 / 6', { exact: true }).waitFor();
    await checkpoint('10-user-third-original');
    await close();
    await open(page.locator('[data-fixture-tool] img').nth(4), 4);
    await viewer.getByText('5 / 6', { exact: true }).waitFor();
    await checkpoint('11-tool-fifth-original');
    await close();
    await open(page.locator('[data-fixture-isolated] img').nth(0), 3, {
      name: 'original-4.png',
      position: 1,
      total: 2,
    });
    await viewer.getByText('1 / 2', { exact: true }).waitFor();
    await checkpoint('12-isolated-message-group');
    await close();
    await page.evaluate(() => {
      window.imageGalleryFixture.fail(true);
      window.imageGalleryFixture.error();
    });
    await viewer.getByRole('alert').filter({ hasText: '图片预览不可用' }).waitFor();
    await checkpoint('13-original-failed');
    await page.evaluate(() => window.imageGalleryFixture.fail(false));
    await viewer.getByRole('button', { name: '重试', exact: true }).click();
    await waitOriginal(2, { name: '重试原图.png', position: 1, total: 1 });
    await checkpoint('14-retried-original');
    await close();
    await page.evaluate(() => window.imageGalleryFixture.ordinary(true));
    await page.getByRole('button', { name: '从对话框打开图片', exact: true }).click();
    await waitOriginal(2, { name: '重试原图.png', position: 1, total: 1 });
    await checkpoint('15-above-ordinary-dialog');
    await close();
    assert.equal(
      await page.getByRole('dialog', { name: '普通对话框', exact: true }).isVisible(),
      true,
    );
    await page.keyboard.press('Escape');
    await open(page.locator('[data-fixture-user] img').nth(0), 0);
    await application.evaluate(() => globalThis.galleryMain.confirm());
    const confirmation = application
      .windows()
      .find((candidate) => candidate.url().endsWith('/global-dialog.html'))!;
    await confirmation.getByRole('alertdialog').waitFor();
    await checkpoint('16-confirmation-above-gallery');
    await confirmation.keyboard.press('Escape');
    await confirmation.getByRole('alertdialog').waitFor({ state: 'detached' });
    await waitOriginal(0);
    await checkpoint('17-gallery-resumes-after-confirmation');
    await close();
    await application.evaluate(() => globalThis.galleryMain.confirm());
    await confirmation.getByRole('alertdialog').waitFor();
    await page.evaluate(() => window.imageGalleryFixture.error());
    await waitOriginal(2, { name: '重试原图.png', position: 1, total: 1 });
    const confirmationFirst = await native();
    assert.ok(
      confirmationFirst.views.findIndex(
        (view: { visible: boolean; url?: string }) =>
          view.visible && view.url?.endsWith('/global-dialog.html'),
      ) >
        confirmationFirst.views.findIndex(
          (view: { visible: boolean; url?: string }) =>
            view.visible && view.url?.endsWith('/image-gallery.html'),
        ),
    );
    await checkpoint('17b-confirmation-retains-priority-on-gallery-open');
    await application.evaluate(() => globalThis.galleryMain.gallery.dismiss());
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    assert.equal(await confirmation.getByRole('alertdialog').isVisible(), true);
    assert.equal(
      (await native()).views.find((view: { url?: string }) =>
        view.url?.endsWith('/global-dialog.html'),
      )?.focused,
      true,
    );
    await checkpoint('17c-confirmation-retains-focus-after-gallery-close');
    await confirmation.keyboard.press('Escape');
    await confirmation.getByRole('alertdialog').waitFor({ state: 'detached' });
    await page.evaluate(() => window.imageGalleryFixture.native('office'));
    await page.waitForTimeout(500);
    await checkpoint('18-native-document-visible');
    await open(page.locator('[data-fixture-user] img').nth(0), 0);
    await checkpoint('19-gallery-over-native-document');
    await application.evaluate(() => globalThis.galleryMain.window.setSize(620, 720));
    await application.evaluate(() => globalThis.galleryMain.wake());
    await waitOriginal(0);
    await checkpoint('20-narrow-native-wake');
    await close();
    await application.evaluate(() => {
      const window = globalThis.galleryMain.window;
      window.setSize(1150, 850);
      window.webContents.setZoomFactor(1.5);
    });
    await open(page.locator('[data-fixture-user] img').nth(0), 0);
    await checkpoint('21-renderer-zoom-150');
    await close();
    await open(page.locator('[data-fixture-user] img').nth(0), 0);
    await page.evaluate(() => window.imageGalleryFixture.scope('other-session'));
    await viewer.locator('.image-gallery-dialog').waitFor({ state: 'detached' });
    await checkpoint('21b-scope-switch-closes-original');
    await page.evaluate(() => {
      window.imageGalleryFixture.hold(true);
      window.imageGalleryFixture.error();
    });
    await viewer.getByRole('status', { name: '加载图片', exact: true }).waitFor();
    await checkpoint('22-held-original-loading');
    await close();
    await page.evaluate(() => window.imageGalleryFixture.release());
    await page.waitForTimeout(200);
    assert.equal(await viewer.locator('.image-gallery-dialog').count(), 0);
    await checkpoint('23-canceled-read-stays-closed');
    await open(page.locator('[data-fixture-user] img').nth(0), 0);
    await application.evaluate(() => globalThis.galleryMain.openOther());
    await application.evaluate(() => globalThis.galleryMain.wake());
    await page.waitForTimeout(150);
    const otherState = await native();
    assert.equal(otherState.secondary?.focused, true);
    assert.ok(
      otherState.secondary?.views.every((view) => !view.url?.includes('image-gallery.html')),
    );
    assert.equal(
      otherState.views.find((view) => view.url?.endsWith('/image-gallery.html'))?.visible,
      true,
    );
    assert.equal(
      otherState.views.find((view) => view.url?.endsWith('/image-gallery.html'))?.focused,
      false,
    );
    await checkpoint('24-other-native-window-keeps-focus-and-no-gallery');
    await application.evaluate(() => globalThis.galleryMain.closeOther());
    await waitOriginal(0);
    assert.equal(
      (await native()).views.find((view) => view.url?.endsWith('/image-gallery.html'))?.focused,
      true,
    );
    await checkpoint('25-original-window-retains-selection-and-top-gallery');
    await close();
    assert.deepEqual(errors, []);
    assert.equal(downloads, 0);
    writeFileSync(
      join(root, 'report.json'),
      JSON.stringify(
        {
          passed: true,
          root,
          electron: await application.evaluate(() => process.versions.electron),
          stages,
          errors,
          downloads,
          diagnostics,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, root, stages: stages.length, errors, downloads }));
  }
} catch (error) {
  writeFileSync(
    join(root, 'failure-cause.json'),
    JSON.stringify({ phase, error: String(error) }, null, 2),
  );
  try {
    const media = await application.evaluate(() =>
      globalThis.galleryMain.window.getMediaSourceId(),
    );
    execFileSync('/usr/sbin/screencapture', [
      '-x',
      '-l',
      media.split(':')[1]!,
      join(root, 'failure-native-composed.png'),
    ]);
  } catch {}
  const failurePages = [];
  for (const current of application.windows()) {
    try {
      failurePages.push({
        url: current.url(),
        body: await current.locator('body').innerHTML(),
        geometry: await current.evaluate(() => ({
          innerWidth,
          innerHeight,
          dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(
            (node) => ({
              box: node.getBoundingClientRect().toJSON(),
              translate: getComputedStyle(node).translate,
            }),
          ),
        })),
      });
      await current.screenshot({
        path: join(root, `failure-${failurePages.length}.png`),
        timeout: 3000,
      });
    } catch {}
  }
  try {
    writeFileSync(
      join(root, 'failure-live.json'),
      JSON.stringify(
        {
          pages: failurePages,
          native: await application.evaluate(() => globalThis.galleryMain.snapshot()),
        },
        null,
        2,
      ),
    );
  } catch {}
  writeFileSync(
    join(root, 'failure.json'),
    JSON.stringify(
      {
        root,
        phase,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
        stages,
        errors,
        diagnostics,
      },
      null,
      2,
    ),
  );
  console.error(JSON.stringify({ root, phase, error: String(error) }));
  throw error;
} finally {
  await application.close();
  server.stop(true);
}
