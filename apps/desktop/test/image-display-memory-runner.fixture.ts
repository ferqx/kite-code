import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { _electron, type Page } from 'playwright';
import { build } from 'vite';
import sharp from '../../../packages/agent/node_modules/sharp';
import { buildImageDisplay } from '../scripts/build-image-display';
import type {} from './image-display-memory.fixture';
import type {} from './image-display-memory-main.fixture';

const repository = resolve(import.meta.dir, '../../..');
const old = '/Users/chenchao/kite-image-stress-20261117-SmAWOY/.stress';
type Source = {
  group: string;
  mediaType?: string;
  index: number;
  name: string;
  width: number;
  height: number;
  encoded: number;
  sha256: string;
};
const sources: Source[] = JSON.parse(await readFile(join(old, 'fixtures.json'), 'utf8'));
const paths = new Map(sources.map((source) => [source.name, join(old, 'images', source.name)]));
const roiMode = process.argv.includes('--roi') || process.argv.includes('--roi-text');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const source of sources)
  assert.equal(hash(await readFile(paths.get(source.name)!)), source.sha256);
await mkdir(join(repository, '.cache'), { recursive: true });
const prepared = process.argv
  .find((value) => value.startsWith('--prepared='))
  ?.slice('--prepared='.length);
const directory = prepared ?? (await mkdtemp(join(repository, '.cache/image-display-memory-')));
console.log(JSON.stringify({ directory, phase: 'prepare' }));
if (roiMode) {
  for (const [group, width, height, orientation] of [
    ['long', 1000, 40000, 1],
    ['roi-exif', 2000, 8000, 6],
  ] as const) {
    const text = Buffer.from(
      `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${Array.from(
        { length: Math.floor(height / 256) },
        (_, index) => 128 + index * 256,
      )
        .map(
          (y) =>
            `<text x="40" y="${y}" fill="black" font-family="sans-serif" font-size="24">SOURCE PIXEL TEXT ${group} y=${y} 0123456789 ABCDEFG</text>`,
        )
        .join('')}</svg>`,
    );
    const image = sharp({ create: { width, height, channels: 3, background: 'white' } }).composite([
      { input: text },
    ]);
    const bytes =
      orientation === 6
        ? await image.withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer()
        : await image.png().toBuffer();
    const name = `${group}.${orientation === 6 ? 'jpeg' : 'png'}`;
    const path = join(directory, name);
    await writeFile(path, bytes);
    paths.set(name, path);
    sources.push({
      group,
      index: 0,
      name,
      width: orientation === 6 ? height : width,
      height: orientation === 6 ? width : height,
      encoded: bytes.length,
      sha256: hash(bytes),
      mediaType: orientation === 6 ? 'image/jpeg' : 'image/png',
    });
  }
}

await writeFile(join(directory, 'sources.json'), JSON.stringify(sources, null, 2));
const outdir = join(directory, 'dist');
if (!prepared) {
  const asset = await buildImageDisplay(directory);
  const main = await Bun.build({
    entrypoints: [
      join(import.meta.dir, 'image-display-memory-main.fixture.ts'),
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
  if (!main.success) throw new AggregateError(main.logs, 'memory_main_build_failed');
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
          fixture: join(import.meta.dir, 'image-display-memory.fixture.tsx'),
          'image-gallery': join(import.meta.dir, '../src/native-image-gallery-main.tsx'),
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
        cssFileName: 'fixture',
      },
    },
  });
}
if (process.argv.includes('--prepare')) {
  console.log(JSON.stringify({ directory, prepared: true, sourceCount: sources.length }));
  process.exit(0);
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/sources') return Response.json(sources);
    if (/^\/source\/\d+$/.test(path)) {
      const source = sources[Number(path.slice(8))];
      return source
        ? new Response(Bun.file(paths.get(source.name)!))
        : new Response(null, { status: 404 });
    }
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
  KITE_MEMORY_DIRECTORY: directory,
  KITE_MEMORY_URL: server.url.toString(),
};
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS'])
  delete env[name];
const app = await _electron.launch({
  executablePath:
    '/Applications/Kite Desktop.app/Contents/Resources/native/electron/Electron.app/Contents/MacOS/Electron',
  args: [join(directory, 'image-display-memory-main.fixture.cjs')],
  cwd: repository,
  env,
  timeout: 30000,
});
const pid = app.process().pid!;
await writeFile(join(directory, 'pid'), String(pid));
const errors: string[] = [],
  phases: unknown[] = [],
  memory: Memory[] = [];
type Process = { pid: number; ppid: number; rssKiB: number; command: string; role?: string };
type Memory = { at: number; phase: string; totalKiB: number; processes: Process[] };
let phase = 'launch',
  stopping = false,
  thresholdExceeded = false,
  sampling = true,
  rootPid = 0,
  galleryPid = 0;
let owned = new Set<number>([pid]);
const killOwned = () => {
  for (const current of [...owned].reverse())
    try {
      process.kill(current, 'SIGTERM');
    } catch {}
};
const sampleTask = (async () => {
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
      const next = new Set([pid]);
      for (let n = 0; n < 8; n++) for (const row of rows) if (next.has(row.ppid)) next.add(row.pid);
      owned = next;
      const processes = rows
        .filter((row) => next.has(row.pid))
        .map((row) => ({
          ...row,
          role:
            row.pid === pid
              ? 'Main'
              : row.pid === rootPid
                ? 'Root'
                : row.pid === galleryPid
                  ? 'Gallery'
                  : row.command.includes('image-display-codec/child.cjs')
                    ? 'decoder'
                    : 'other',
        }));
      const sample = {
        at: Date.now(),
        phase,
        totalKiB: processes.reduce((n, row) => n + row.rssKiB, 0),
        processes,
      };
      memory.push(sample);
      await appendFile(join(directory, 'rss.ndjson'), `${JSON.stringify(sample)}\n`);
      if (sample.totalKiB >= 3 * 1024 * 1024) {
        stopping = true;
        thresholdExceeded = true;
        errors.push('aggregate_rss_stop_3GiB');
        killOwned();
        setTimeout(() => {
          for (const current of owned)
            try {
              process.kill(current, 'SIGKILL');
            } catch {}
        }, 1000);
        break;
      }
    } catch (error) {
      errors.push(`sampler:${String(error)}`);
      stopping = true;
      killOwned();
      break;
    }
    await Bun.sleep(100);
  }
})();
async function waitPage(match: (page: Page) => boolean) {
  for (let n = 0; n < 300; n++) {
    const page = app.windows().find(match);
    if (page) return page;
    await Bun.sleep(100);
  }
  throw Error('memory_page_missing');
}
declare global {
  interface Window {
    imageMemoryObservation: { live: string[]; created: number; revoked: number; trace: unknown[] };
  }
}
const screenshots: string[] = [];
try {
  const installObservation = () => {
    const live = new Set<string>(),
      originalCreate = URL.createObjectURL.bind(URL),
      originalRevoke = URL.revokeObjectURL.bind(URL);
    const state = { live: [] as string[], created: 0, revoked: 0, trace: [] as unknown[] };
    window.imageMemoryObservation = state;
    URL.createObjectURL = (blob) => {
      const url = originalCreate(blob);
      live.add(url);
      state.created++;
      state.live = [...live];
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (live.delete(url)) state.revoked++;
      state.live = [...live];
      originalRevoke(url);
    };
    let previous = '';
    setInterval(() => {
      const data = {
        at: performance.now(),
        caption: document.querySelector('.image-gallery-caption')?.textContent,
        alerts: [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent),
        busy: document.querySelectorAll('[aria-busy="true"]').length,
        images: [...document.images].map((image) => ({
          src: image.src,
          width: image.naturalWidth,
          height: image.naturalHeight,
          candidate: !!image.closest('.image-gallery-candidate'),
        })),
        dialog: !!document.querySelector('.image-gallery-dialog'),
        live: live.size,
      };
      const key = JSON.stringify({ ...data, at: 0 });
      if (key !== previous && state.trace.length < 25000) {
        state.trace.push(data);
        previous = key;
      }
    }, 16);
  };
  const root = await waitPage((page) => page.url() === server.url.toString());
  const viewer = await waitPage((page) => page.url().endsWith('/image-gallery.html'));
  for (const page of [root, viewer])
    page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  await root.waitForFunction(() => !!window.imageMemoryFixture);
  await viewer.waitForLoadState();
  await root.evaluate(installObservation);
  await viewer.evaluate(installObservation);
  const views = await app.evaluate(() => globalThis.imageMemoryMain.views());
  rootPid = views.find((v) => v.url === server.url.toString())?.pid ?? 0;
  galleryPid = views.find((v) => v.url.endsWith('/image-gallery.html'))?.pid ?? 0;
  const capture = async (name: string, page = root) => {
    phase = name;
    const path = join(directory, `${name}.png`);
    await page.screenshot({ path });
    screenshots.push(path);
  };
  const checkpoint = async (name: string) => {
    phase = name;
    const value = {
      name,
      at: Date.now(),
      root: await root.evaluate(() => ({
        fixture: window.imageMemoryFixture.snapshot(),
        observation: window.imageMemoryObservation,
      })),
      gallery: await viewer.evaluate(() => window.imageMemoryObservation),
      rss: memory.at(-1),
      views: await app.evaluate(() => globalThis.imageMemoryMain.views()),
    };
    phases.push(value);
    await writeFile(
      join(directory, 'progress.json'),
      JSON.stringify({ directory, phase, errors, phases, screenshots }, null, 2),
    );
    console.log(JSON.stringify({ phase: name, rssMiB: (memory.at(-1)?.totalKiB ?? 0) / 1024 }));
  };
  const ready = async (name: string, edge: number) => {
    await viewer.waitForFunction(
      ({ name, edge }) => {
        const image = document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        );
        return (
          image?.alt === name &&
          image.complete &&
          image.naturalWidth === edge &&
          !document.querySelector('[role="alert"]')
        );
      },
      { name, edge },
      { timeout: 30000 },
    );
  };
  for (const [group, rounds] of (roiMode
    ? process.argv.includes('--roi-text')
      ? [
          ['long', 1],
          ['roi-exif', 1],
        ]
      : [
          ['8k', 1],
          ['long', 1],
          ['roi-exif', 1],
        ]
    : [
        ['4k', 2],
        ['8k', 3],
        ['encoded', 2],
      ]) as [string, number][]) {
    const list = sources
      .map((source, index) => ({ source, index }))
      .filter((item) => item.source.group === group);
    phase = `${group}-thumbnails`;
    await root.evaluate((group) => window.imageMemoryFixture.group(group), group);
    await root.waitForFunction(
      (count) =>
        window.imageMemoryFixture.snapshot().thumbnailDone &&
        window.imageMemoryFixture.snapshot().thumbnailCount === count,
      list.length,
      { timeout: 180000 },
    );
    await capture(`${group}-thumbnails`);
    await checkpoint(`${group}-thumbnail-ready`);
    for (let round = 0; round < rounds; round++) {
      for (const { source, index } of list) {
        if (stopping) throw Error('memory_stopped');
        phase = `${group}-round${round + 1}-image${index}`;
        const start = performance.now();
        if (index === list[0]!.index)
          await root.evaluate((index) => window.imageMemoryFixture.select(String(index)), index);
        else await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
        await viewer.waitForFunction(
          (name) =>
            document.querySelector<HTMLImageElement>(
              '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
            )?.alt === name,
          source.name,
          { timeout: 30000 },
        );
        // Exercise real shared zoom controls until physical display demand reaches the top tier.
        for (let step = 0; step < 12; step++) {
          const natural = await viewer
            .locator('.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image')
            .evaluate((node) => (node as HTMLImageElement).naturalWidth);
          if (
            natural >=
            Math.round(source.width * Math.min(1, 4096 / Math.max(source.width, source.height)))
          )
            break;
          await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
          await Bun.sleep(60);
        }
        await ready(
          source.name,
          Math.round(source.width * Math.min(1, 4096 / Math.max(source.width, source.height))),
        );
        if (roiMode) {
          await viewer.getByRole('button', { name: '原始大小', exact: true }).click();
          for (const position of [0, 0.48, 0.97]) {
            await viewer.evaluate((position) => {
              const view = document.querySelector<HTMLElement>('.image-gallery-viewport')!;
              view.scrollTop =
                (view.scrollHeight - view.clientHeight) * Math.max(0, position - 0.03);
              view.dispatchEvent(new Event('scroll'));
              view.scrollTop = (view.scrollHeight - view.clientHeight) * position;
              view.scrollLeft = (view.scrollWidth - view.clientWidth) * position;
              view.dispatchEvent(new Event('scroll'));
            }, position);
            await viewer.waitForFunction(
              () => {
                const view = document.querySelector<HTMLElement>('.image-gallery-viewport')!;
                const base = document.querySelector<HTMLImageElement>(
                  '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
                )!;
                const crop = [
                  ...document.querySelectorAll<HTMLImageElement>('.image-gallery-detail'),
                ].find((image) => image.style.visibility === 'visible');
                if (!crop?.complete || !crop.naturalWidth) return false;
                const v = view.getBoundingClientRect(),
                  b = base.getBoundingClientRect(),
                  r = crop.getBoundingClientRect();
                return (
                  crop.naturalWidth <= 2048 &&
                  crop.naturalHeight <= 2048 &&
                  r.top <= Math.max(v.top, b.top) + 2 &&
                  r.bottom >= Math.min(v.bottom, b.bottom) - 2 &&
                  r.left <= Math.max(v.left, b.left) + 2 &&
                  r.right >= Math.min(v.right, b.right) - 2
                );
              },
              undefined,
              { timeout: 30000 },
            );
            assert((await viewer.locator('.image-gallery-detail').count()) <= 2);
            if (index === list[0]!.index) await capture(`${group}-roi-${position}`, viewer);
          }
        }
        phases.push({
          name: phase,
          at: Date.now(),
          readyMs: performance.now() - start,
          rss: memory.at(-1),
        });
        if (index === list[0]!.index || index === list.at(-1)!.index)
          await capture(`${group}-round${round + 1}-${source.index}`, viewer);
      }
      await checkpoint(`${group}-round${round + 1}-complete`);
      await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
      await viewer.waitForFunction(() => !document.querySelector('.image-gallery-dialog'));
      await Bun.sleep(2000);
      assert.equal(await viewer.evaluate(() => window.imageMemoryObservation.live.length), 0);
      await checkpoint(`${group}-round${round + 1}-closed-2s`);
    }
    // A held original is cancelled by close; releasing late bytes cannot reopen the gallery.
    await root.evaluate((index) => {
      window.imageMemoryFixture.hold(true);
      window.imageMemoryFixture.select(String(index));
    }, list[0]!.index);
    await viewer.waitForSelector('.image-gallery-dialog');
    await capture(`${group}-pending`, viewer);
    await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await root.evaluate(() => window.imageMemoryFixture.hold(false));
    await Bun.sleep(300);
    assert.equal(await viewer.locator('.image-gallery-dialog').count(), 0);
    // Corrupt display input after original verification exercises visible failure and in-place retry.
    await root.evaluate((index) => {
      window.imageMemoryFixture.corrupt(true);
      window.imageMemoryFixture.select(String(index));
    }, list[0]!.index);
    await viewer.waitForSelector('[role="alert"]');
    await capture(`${group}-failure`, viewer);
    await root.evaluate(() => window.imageMemoryFixture.corrupt(false));
    await viewer.getByRole('button', { name: '重试', exact: true }).click();
    await viewer.waitForFunction(
      (name) =>
        document.querySelector<HTMLImageElement>(
          '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
        )?.alt === name,
      list[0]!.source.name,
    );
    await capture(`${group}-recovered`, viewer);
    await root.evaluate(() => window.imageMemoryFixture.clear());
    await Bun.sleep(2000);
    assert.equal(await root.evaluate(() => window.imageMemoryObservation.live.length), 0);
    assert.equal(await viewer.evaluate(() => window.imageMemoryObservation.live.length), 0);
    await checkpoint(`${group}-cleared-2s`);
  }
  for (const source of sources)
    assert.equal(hash(await readFile(paths.get(source.name)!)), source.sha256);
  assert.deepEqual(errors, []);
  await app.evaluate(() => globalThis.imageMemoryMain.dispose());
} catch (error) {
  errors.push(String(error));
  console.error(error);
  for (const page of app.windows())
    try {
      await writeFile(
        join(
          directory,
          page.url().includes('image-gallery') ? 'failure-gallery.json' : 'failure-root.json',
        ),
        JSON.stringify(
          await page.evaluate(() => ({
            body: document.body.innerText,
            observation: window.imageMemoryObservation,
          })),
          null,
          2,
        ),
      );
    } catch {}
} finally {
  sampling = false;
  await sampleTask;
  await Promise.race([app.close().catch(() => {}), Bun.sleep(3000)]);
  killOwned();
  await Bun.sleep(300);
  const remains = [...owned].filter((current) => {
    try {
      process.kill(current, 0);
      return true;
    } catch {
      return false;
    }
  });
  for (const current of remains)
    try {
      process.kill(current, 'SIGKILL');
    } catch {}
  await Bun.sleep(200);
  const survivors = remains.filter((current) => {
    try {
      process.kill(current, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (survivors.length) errors.push(`fixture_process_exit_unconfirmed:${survivors.join(',')}`);
  server.stop(true);
  const summary = {
    directory,
    pid,
    stoppedAt3GiB: thresholdExceeded,
    ownedProcessesTerminated: survivors.length === 0,
    errors,
    peakRssMiB: Math.max(...memory.map((m) => m.totalKiB)) / 1024,
    processPeakRssMiB: Object.fromEntries(
      ['Main', 'Root', 'Gallery', 'decoder', 'other'].map((role) => [
        role,
        Math.max(
          0,
          ...memory.map((m) =>
            m.processes.filter((p) => p.role === role).reduce((n, p) => n + p.rssKiB, 0),
          ),
        ) / 1024,
      ]),
    ),
    qualification:
      'Real Electron + production byte codec/gallery, explicit fixture source authority. RSS sum double-counts shared pages; not private footprint or hard memory bound.',
    phases,
    screenshots,
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      directory,
      errors,
      peakRssMiB: summary.peakRssMiB,
      processPeakRssMiB: summary.processPeakRssMiB,
    }),
  );
}
if (errors.length) process.exitCode = 1;
