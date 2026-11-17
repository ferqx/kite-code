import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron, type Page } from 'playwright';
import { build } from 'vite';
import sharp from '../../../packages/agent/node_modules/sharp';
import { buildImageDisplay } from '../scripts/build-image-display';
import type {} from './image-display-electron.fixture';
import type {} from './image-display-electron-main.fixture';

const repository = resolve(import.meta.dir, '../../..');
await mkdir(join(repository, '.cache'), { recursive: true });
const directory = await mkdtemp(join(repository, '.cache/image-display-electron-'));
const outdir = join(directory, 'dist');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const sources: { name: string; mediaType: string; hash: string; size: number; path: string }[] = [];
for (const [index, format] of ['png', 'jpeg', 'webp', 'gif'].entries()) {
  const animated = format === 'gif' || format === 'webp';
  const source = sharp({
    create: {
      width: 1600,
      height: animated ? 2000 : 1000,
      channels: 4,
      background: { r: 40 + index * 30, g: 80, b: 150, alpha: format === 'png' ? 0.6 : 1 },
      ...(animated ? { pageHeight: 1000 } : {}),
    },
  });
  const label = Buffer.from(
    `<svg width="1600" height="1000"><text x="80" y="300" fill="white" font-family="sans-serif" font-size="130">Kite ${format.toUpperCase()}</text><text x="80" y="500" fill="white" font-family="sans-serif" font-size="60">Original bytes remain unchanged</text></svg>`,
  );
  const pipeline = source.composite([{ input: label, top: 0, left: 0 }]);
  const data =
    format === 'jpeg'
      ? await pipeline.withMetadata({ orientation: 6 }).jpeg().toBuffer()
      : format === 'webp'
        ? await pipeline.webp({ delay: [200, 200], loop: 0 }).toBuffer()
        : format === 'gif'
          ? await pipeline.gif({ delay: [200, 200], loop: 0 }).toBuffer()
          : await pipeline.png().toBuffer();
  const path = join(directory, `sample.${format}`);
  await writeFile(path, data);
  sources.push({
    name: `sample.${format}`,
    mediaType: `image/${format}`,
    hash: digest(data),
    size: data.length,
    path,
  });
}
// Compression-free valid PNG crosses both historical32MiB and local64MiB limits.
const largePath = join(directory, 'large-65MiB.png');
await sharp({ create: { width: 4200, height: 4100, channels: 4, background: '#638ab1' } })
  .png({ compressionLevel: 0 })
  .toFile(largePath);
const highPath = join(directory, 'high-pixel.png');
await sharp({ create: { width: 12000, height: 8000, channels: 3, background: '#3a5c7a' } })
  .png()
  .toFile(highPath);
const longPath = join(directory, 'long-screenshot.png');
await sharp({ create: { width: 1000, height: 40000, channels: 3, background: '#f5f5f2' } })
  .composite(
    Array.from({ length: 40 }, (_, index) => ({
      input: Buffer.from(
        `<svg width="1000" height="1000"><rect x="0" y="0" width="1000" height="1000" fill="${index % 2 ? '#e2ebed' : '#f5f5f2'}"/><text x="32" y="70" fill="#163e45" font-size="36" font-family="sans-serif">Long screenshot section ${index + 1}</text>${Array.from({ length: 20 }, (_, row) => `<text x="32" y="${120 + row * 40}" fill="#263b40" font-size="24" font-family="sans-serif">Readable original pixels: line ${row + 1}, source row ${index * 1000 + 120 + row * 40}</text>`).join('')}</svg>`,
      ),
      left: 0,
      top: index * 1000,
    })),
  )
  .png()
  .toFile(longPath);
const widePath = join(directory, 'wide-panorama.png');
await sharp({ create: { width: 40000, height: 2000, channels: 3, background: '#3a5c7a' } })
  .png()
  .toFile(widePath);
const largeSourceHashes = Object.fromEntries(
  await Promise.all(
    [largePath, highPath, longPath, widePath].map(async (path) => [
      path,
      digest(await readFile(path)),
    ]),
  ),
);
const asset = await buildImageDisplay(directory);
const built = await Bun.build({
  entrypoints: [
    join(import.meta.dir, 'image-display-electron-main.fixture.ts'),
    join(import.meta.dir, '../electron/preload.ts'),
    join(import.meta.dir, '../electron/image-gallery-preload.ts'),
  ],
  outdir: directory,
  target: 'node',
  format: 'cjs',
  external: ['electron'],
  naming: '[name].cjs',
  define: { __KITE_DESKTOP_IMAGE_DISPLAY__: JSON.stringify(asset) },
});
if (!built.success) throw new AggregateError(built.logs, 'fixture_main_build_failed');
await build({
  root: resolve(import.meta.dir, '..'),
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  base: './',
  logLevel: 'warn',
  define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: outdir,
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: {
        fixture: join(import.meta.dir, 'image-display-electron.fixture.tsx'),
        'image-gallery': join(import.meta.dir, '../src/native-image-gallery-main.tsx'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: 'fixture',
    },
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/sources') return Response.json(sources.map(({ path, ...source }) => source));
    if (/^\/source\/\d+$/.test(path))
      return new Response(Bun.file(sources[Number(path.split('/').pop())]!.path));
    if (path === '/' || path === '/image-gallery.html')
      return new Response(
        `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/${path === '/' ? 'fixture' : 'image-gallery'}.js"></script>`,
        { headers: { 'content-type': 'text/html' } },
      );
    const file = resolve(outdir, `.${path}`);
    return file.startsWith(`${outdir}/`)
      ? new Response(Bun.file(file))
      : new Response(null, { status: 404 });
  },
});
const env: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  KITE_DISPLAY_FIXTURE_DIRECTORY: directory,
  KITE_DISPLAY_FIXTURE_URL: server.url.toString(),
};
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS'])
  delete env[name];
const electron =
  '/Applications/Kite Desktop.app/Contents/Resources/native/electron/Electron.app/Contents/MacOS/Electron';
const application = await _electron.launch({
  executablePath: electron,
  args: [join(directory, 'image-display-electron-main.fixture.cjs')],
  env,
  cwd: repository,
  timeout: 30000,
});
const stages: unknown[] = [],
  memory: unknown[] = [],
  errors: string[] = [],
  diagnostics: string[] = [];
application.process().stderr?.on('data', (chunk) => diagnostics.push(String(chunk)));
let currentRoot: Page | undefined;
const pid = application.process().pid!;
let sampling = true,
  phase = 'launch';
const sample = async () => {
  while (sampling) {
    try {
      const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], {
        encoding: 'utf8',
      })
        .split('\n')
        .flatMap((line) => {
          const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          return m
            ? [{ pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), command: m[4]! }]
            : [];
        });
      const owned = new Set([pid]);
      for (let i = 0; i < 6; i++)
        for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
      const processes = rows.filter((row) => owned.has(row.pid));
      const totalKiB = processes.reduce((n, row) => n + row.rssKiB, 0);
      memory.push({ at: Date.now(), phase, totalKiB, processes });
      if (totalKiB > 3 * 1024 * 1024) throw Error('fixture_aggregate_rss_stop_3GiB');
    } catch (error) {
      errors.push(String(error));
      sampling = false;
      await application.close();
    }
    await Bun.sleep(100);
  }
};
const sampleTask = sample();
try {
  const waitPage = async (predicate: (page: Page) => boolean) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const found = application.windows().find(predicate);
      if (found) return found;
      await Bun.sleep(50);
    }
    throw Error('fixture_page_missing');
  };
  const root = await waitPage((page) => page.url() === server.url.toString());
  currentRoot = root;
  root.on('console', (message) => diagnostics.push(message.text()));
  const viewer = await waitPage((page) => page.url().endsWith('/image-gallery.html'));
  root.on('pageerror', (error) => errors.push(error.message));
  viewer.on('pageerror', (error) => errors.push(error.message));
  await root.waitForFunction(() => !!window.imageDisplayFixture);
  const checkpoint = async (name: string, page = root) => {
    phase = name;
    await Bun.sleep(180);
    const image = join(directory, `${name}.png`);
    await page.screenshot({ path: image });
    const state = await page.evaluate(() => ({
      body: document.body.textContent?.slice(0, 1000),
      images: [...document.images].map((image) => ({
        src: image.src,
        alt: image.alt,
        width: image.naturalWidth,
        height: image.naturalHeight,
        display: getComputedStyle(image).display,
      })),
      busy: !!document.querySelector('[aria-busy="true"]'),
    }));
    const views = await application.evaluate(() => globalThis.imageDisplayMain.views());
    stages.push({ name, image, state, views });
    await writeFile(
      join(directory, 'progress.json'),
      JSON.stringify({ directory, phase, stages, errors }, null, 2),
    );
    console.log(JSON.stringify({ stage: name, image }));
  };
  const waitGallery = async () =>
    viewer.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        );
        return (
          image?.complete && image.naturalWidth > 0 && !document.querySelector('[aria-busy="true"]')
        );
      },
      { timeout: 30000 },
    );
  const probe = await root.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/source/0')).arrayBuffer());
    const value = await window.kiteNativeImageDisplay!.render({
      id: 'probe',
      bytes,
      mediaType: 'image/png',
      edge: 512,
    });
    return value.ok ? { ok: true, width: value.value.width, height: value.value.height } : value;
  });
  console.log(JSON.stringify({ probe }));
  assert.equal(probe.ok, true, JSON.stringify(probe));
  if (!process.argv.includes('--output-only')) {
    phase = 'draft';
    await root.evaluate(() => window.imageDisplayFixture.add());
    await checkpoint('00-draft-preparing');
    await root.waitForFunction(
      () => {
        const data = window.imageDisplayFixture.snapshot();
        return (
          data.drafts.length === 4 &&
          data.drafts.every((v) => !v.loading && !v.error && !v.previewError)
        );
      },
      { timeout: 30000 },
    );
    await checkpoint('01-draft-four-formats');
    const uploads = await root.evaluate(() => window.imageDisplayFixture.snapshot());
    assert.deepEqual(uploads.uploadHashes, uploads.sourceHashes);
    for (const mode of ['draft', 'user', 'tool']) {
      if (mode !== 'draft') {
        await root.evaluate((mode) => window.imageDisplayFixture.mode(mode), mode);
        await root.waitForFunction(
          () => document.querySelectorAll('[data-source] img').length === 4,
        );
      }
      const selector = mode === 'draft' ? '.composer img' : '[data-source] img';
      for (let i = 0; i < 4; i++) {
        phase = `${mode}-${i}`;
        await root.locator(selector).nth(i).click();
        await waitGallery();
        const dimensions = await viewer.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>(
            '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
          )!;
          return {
            width: image.naturalWidth,
            height: image.naturalHeight,
            text: document.body.textContent,
          };
        });
        assert.ok(dimensions.width <= 4096 && dimensions.height <= 4096);
        if (i >= 2) assert.match(dimensions.text ?? '', /首帧/);
        await checkpoint(`02-${mode}-${i}`, viewer);
        await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
        await viewer.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      }
    }
    // Fast selection/close/reopen: newest selection commits, no old source returns.
    await root.locator('[data-source] img').first().click();
    await waitGallery();
    await viewer.evaluate(() => {
      const frames: { at: number; name?: string; alt?: string; decoded: boolean; count: number }[] =
        [];
      Object.assign(window, { imageDisplayFrames: frames });
      const sample = () => {
        if (!document.querySelector('[role="dialog"]')) return;
        const image = document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        );
        frames.push({
          at: performance.now(),
          name:
            document.querySelector('.image-gallery-caption')?.children[0]?.textContent ?? undefined,
          alt: image?.alt,
          decoded: !!image?.complete && image.naturalWidth > 0,
          count: document.querySelectorAll('.image-gallery-image').length,
        });
        requestAnimationFrame(sample);
      };
      sample();
    });
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await waitGallery();
    assert.match(await viewer.locator('.image-gallery-caption').innerText(), /sample.webp/);
    await checkpoint('03-fast-selection', viewer);
    const transitionFrames = await viewer.evaluate(
      () =>
        Reflect.get(window, 'imageDisplayFrames') as {
          name?: string;
          alt?: string;
          decoded: boolean;
          count: number;
        }[],
    );
    assert.ok(transitionFrames.length > 0);
    assert.equal(
      transitionFrames.filter(
        (frame) => !frame.decoded || frame.name !== frame.alt || frame.count > 2,
      ).length,
      0,
    );
    stages.push({ name: 'fast-selection-frames', frames: transitionFrames });
    await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await root.evaluate(() => window.imageDisplayFixture.available(false));
    await Bun.sleep(200);
    await root.evaluate(() => window.imageDisplayFixture.available(true));
  }
  for (const local of [false, true])
    for (const source of [...sources.map((v) => v.path), largePath, highPath, longPath, widePath]) {
      phase = `${local ? 'local' : 'output'}-${source.split('/').pop()}`;
      await application.evaluate(
        async (_, { source, local, width }) =>
          globalThis.imageDisplayMain.output(source, local, width),
        { source, local, width: source === widePath ? 320 : 820 },
      );
      const page = await waitPage((page) => page.url().startsWith('kite-preview:'));
      await page.waitForFunction(
        () => document.images[0]?.complete && document.images[0]!.naturalWidth > 0,
        { timeout: 30000 },
      );
      const image = await page.evaluate(() => ({
        width: document.images[0]!.naturalWidth,
        height: document.images[0]!.naturalHeight,
        src: document.images[0]!.src,
        text: document.body.textContent,
      }));
      assert.ok(image.width <= 4096 && image.height <= 4096);
      assert.ok(image.src.startsWith('kite-preview:'));
      assert.ok(!image.src.includes('/source'));
      await checkpoint(`04-${local ? 'local' : 'output'}-${source.split('/').pop()}`, page);
      if (source === widePath) {
        const fitted = await page.evaluate(() => ({
          viewport: innerWidth,
          width: document.getElementById('image-stage')!.getBoundingClientRect().width,
          label: document.getElementById('image-zoom-label')!.textContent,
        }));
        assert.deepEqual(fitted, { viewport: 320, width: 320, label: '0.8%' });
        await page.getByRole('button', { name: '缩小', exact: true }).click();
        assert.equal(
          await page.locator('#image-stage').evaluate((node) => node.getBoundingClientRect().width),
          320,
        );
        await checkpoint(`04-${local ? 'local' : 'output'}-wide-fit-320`, page);
      }
      if (source === longPath) {
        await page.getByRole('button', { name: '原始大小', exact: true }).click();
        await page.evaluate(() => scrollTo(0, 20000));
        await page.waitForFunction(() => {
          const image = document.querySelector<HTMLImageElement>('[data-image-region="current"]');
          const region = image && (Reflect.get(image, 'region') as { top: number } | undefined);
          return (
            !!image?.complete &&
            image.naturalWidth === Math.min(innerWidth, 1000) &&
            !!region &&
            region.top >= 19000
          );
        });
        await checkpoint(`04-${local ? 'local' : 'output'}-long-original-middle`, page);
        await page.evaluate(() => {
          scrollTo(0, 5000);
          scrollTo(0, 10000);
          scrollTo(0, 30000);
        });
        await page.waitForFunction(() => {
          const image = document.querySelector<HTMLImageElement>('[data-image-region="current"]');
          const region = image && (Reflect.get(image, 'region') as { top: number } | undefined);
          return !!image?.complete && !!region && region.top >= 29000;
        });
        assert.equal(await page.locator('img').count(), 2);
        await checkpoint(`04-${local ? 'local' : 'output'}-long-latest-viewport`, page);
      }
      await application.evaluate(() => globalThis.imageDisplayMain.close());
    }
  // Revocation removes the already visible content, not merely future requests.
  await application.evaluate(
    async (_, source) => globalThis.imageDisplayMain.output(source, true),
    largePath,
  );
  await application.evaluate(() => globalThis.imageDisplayMain.revoke());
  await root.waitForTimeout(500);
  const revoked = await application.evaluate(() => globalThis.imageDisplayMain.views());
  assert.equal(
    revoked.some((v) => v.url.startsWith('kite-preview:')),
    false,
  );
  await checkpoint('05-revoked-source-closed');
  for (const [path, hash] of Object.entries(largeSourceHashes))
    assert.equal(digest(await readFile(path)), hash);
  for (const source of sources) assert.equal(digest(await readFile(source.path)), source.hash);
  await application.evaluate(async () => globalThis.imageDisplayMain.dispose());
  await Bun.sleep(2000);
  await checkpoint('06-closed-and-reclaimed');
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(String(error));
  if (currentRoot && !currentRoot.isClosed()) {
    await currentRoot.screenshot({ path: join(directory, 'failure.png') });
    const state = await currentRoot.evaluate(() => ({
      body: document.body.textContent,
      fixture: window.imageDisplayFixture?.snapshot(),
    }));
    stages.push({ name: 'failure', state });
    console.log(JSON.stringify({ failureState: state }));
  }
  throw error;
} finally {
  sampling = false;
  await sampleTask;
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(
      {
        directory,
        phase,
        stages,
        errors,
        diagnostics,
        memory,
        note: 'RSS sums include shared pages and are not private footprint or a hard limit.',
      },
      null,
      2,
    ),
  );
  await application.close();
  server.stop(true);
  console.log(JSON.stringify({ directory, phase, errors }));
}
