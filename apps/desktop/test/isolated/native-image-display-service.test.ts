import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { GifEncoder } from '../../../../packages/agent/node_modules/@napi-rs/canvas';
import { imageDisplayContainer } from '../../electron/image-display-format';
import {
  createImageDisplayService,
  type ImageDisplayAssets,
} from '../../electron/image-display-service';
import { buildImageDisplay } from '../../scripts/build-image-display';
import {
  type NativeImageDisplayMediaType,
  nativeImageDisplaySourceByteLimit,
} from '../../src/native-image-display-bridge';

let directory: string, assets: ImageDisplayAssets, png: Buffer;
const signal = () => new AbortController().signal;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kite-image-display-codec-'));
  const built = await buildImageDisplay(directory);
  assets = {
    child: join(directory, built.relativePath),
    sha256: built.sha256,
    executable: Bun.which('node')!,
  };
  png = await sharp({
    create: { width: 96, height: 48, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function service(overrides: Parameters<typeof createImageDisplayService>[0] = {}) {
  return createImageDisplayService({ assets: () => assets, ...overrides });
}
async function fixture(name: string, code: string) {
  const child = join(directory, `${name}.cjs`);
  await writeFile(child, code);
  return { child, sha256: hash(Buffer.from(code)), executable: assets.executable };
}
async function eventually(predicate: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw Error('fixture_timeout');
    await Bun.sleep(5);
  }
}
function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test('self-contained emitted codec decodes PNG JPEG WebP GIF without source-tree modules and leaves originals unchanged', async () => {
  const codec = service();
  try {
    expect(assets.child.startsWith(tmpdir())).toBe(true);
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const bytes = await sharp(png).toFormat(format).toBuffer(),
        original = hash(bytes);
      const result = await codec.render({
        source: { bytes },
        mediaType: `image/${format}`,
        edge: 512,
        signal: signal(),
      });
      expect(hash(bytes)).toBe(original);
      expect(result).toMatchObject({
        mimeType: 'image/webp',
        width: 96,
        height: 48,
        sourceWidth: 96,
        sourceHeight: 48,
        animated: false,
        frame: 'static',
      });
      expect(imageDisplayContainer(result.bytes)).toBe('webp');
      const pixel = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
      expect(pixel[0]).toBeGreaterThan(240);
      expect(pixel[2]).toBeLessThan(16);
    }
  } finally {
    await codec.dispose();
  }
}, 15000);

test('EXIF orientation, transparency and animation produce explicit static first-frame derivatives', async () => {
  const codec = service();
  const decode = (bytes: Uint8Array, mediaType: NativeImageDisplayMediaType) =>
    codec.render({ source: { bytes }, mediaType, edge: 512, signal: signal() });
  try {
    const jpeg = await sharp(png).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await decode(jpeg, 'image/jpeg')).toMatchObject({
      width: 48,
      height: 96,
      sourceWidth: 48,
      sourceHeight: 96,
    });
    const transparent = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const alpha = await sharp((await decode(transparent, 'image/png')).bytes)
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(alpha[3]).toBe(0);
    using gif = new GifEncoder(4, 4);
    gif.addFrame(
      Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)),
      4,
      4,
    );
    gif.addFrame(
      Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 2 || i % 4 === 3 ? 255 : 0)),
      4,
      4,
    );
    const animatedGif = gif.finish();
    for (const [bytes, mediaType] of [
      [animatedGif, 'image/gif'],
      [await sharp(animatedGif, { animated: true }).webp().toBuffer(), 'image/webp'],
    ] as const) {
      const result = await decode(bytes, mediaType);
      expect(result).toMatchObject({ animated: true, frame: 'first', width: 4, height: 4 });
      const pixel = await sharp(result.bytes).raw().toBuffer();
      expect(pixel[0]).toBeGreaterThan(240);
      expect(pixel[2]).toBeLessThan(16);
      expect((await sharp(result.bytes).metadata()).pages ?? 1).toBe(1);
    }
  } finally {
    await codec.dispose();
  }
});

test('spoofed MIME, corrupt CRC, truncated PNG JPEG WebP GIF and unsupported SVG fail, then valid decode recovers', async () => {
  const codec = service();
  try {
    const jpeg = await sharp(png).jpeg().toBuffer(),
      webp = await sharp(png).webp().toBuffer(),
      gif = await sharp(png).gif().toBuffer();
    const crc = Buffer.from(png);
    crc[29] = crc[29]! ^ 1;
    for (const [bytes, mediaType] of [
      [png, 'image/jpeg'],
      [crc, 'image/png'],
      [png.subarray(0, -12), 'image/png'],
      [jpeg.subarray(0, -20), 'image/jpeg'],
      [Buffer.concat([jpeg.subarray(0, jpeg.length / 2), Buffer.from([255, 217])]), 'image/jpeg'],
      [webp.subarray(0, -4), 'image/webp'],
      [gif.subarray(0, -2), 'image/gif'],
      [Buffer.from('<svg/>'), 'image/png'],
    ] as const) {
      await expect(
        codec.render({ source: { bytes }, mediaType, edge: 512, signal: signal() }),
      ).rejects.toThrow(/native_image_display_(invalid|decode_failed|format_unsupported)/);
      expect(
        (
          await codec.render({
            source: { bytes: png },
            mediaType: 'image/png',
            edge: 512,
            signal: signal(),
          })
        ).width,
      ).toBe(96);
    }
  } finally {
    await codec.dispose();
  }
}, 15000);

test('trusted snapshot path streams to child; original bytes unchanged and final symlink/empty/path over source budget denied', async () => {
  const codec = service();
  const path = join(directory, 'source.png');
  await writeFile(path, png);
  try {
    expect(
      (
        await codec.render({
          source: { path },
          mediaType: 'image/png',
          edge: 512,
          signal: signal(),
        })
      ).width,
    ).toBe(96);
    expect(hash(await readFile(path))).toBe(hash(png));
    const link = join(directory, 'link.png');
    await symlink(path, link);
    if (process.platform !== 'win32')
      await expect(
        codec.render({
          source: { path: link },
          mediaType: 'image/png',
          edge: 512,
          signal: signal(),
        }),
      ).rejects.toThrow();
    await expect(
      codec.render({
        source: { bytes: new Uint8Array() },
        mediaType: 'image/png',
        edge: 512,
        signal: signal(),
      }),
    ).rejects.toThrow('native_image_display_invalid');
    const huge = new Uint8Array(nativeImageDisplaySourceByteLimit + 1);
    await expect(
      codec.render({
        source: { bytes: huge },
        mediaType: 'image/png',
        edge: 512,
        signal: signal(),
      }),
    ).rejects.toThrow('native_image_display_source_too_large');
  } finally {
    await codec.dispose();
  }
});

test('large sources beyond previous display/tool limits use bounded tiers; dimensions safety remains separate', async () => {
  const codec = service();
  try {
    // Uncompressed 9000x4000 PNG is >32MiB and >32MP, still a valid display source.
    const bytes = await sharp({
      create: { width: 9000, height: 4000, channels: 3, background: '#568eab' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(32 * 1024 * 1024);
    const path = join(directory, 'large.png');
    await writeFile(path, bytes);
    const result = await codec.render({
      source: { path },
      mediaType: 'image/png',
      edge: 1024,
      signal: signal(),
    });
    expect(result).toMatchObject({
      width: 1024,
      height: 455,
      sourceWidth: 9000,
      sourceHeight: 4000,
    });
    expect(result.bytes.length).toBeLessThan(1024 * 1024);
    // Metadata guard stops this tiny compressed extreme dimension before pixel decode.
    const extreme = await sharp({
      create: { width: 65536, height: 1, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    await expect(
      codec.render({
        source: { bytes: extreme },
        mediaType: 'image/png',
        edge: 512,
        signal: signal(),
      }),
    ).rejects.toThrow('native_image_display_dimensions_exceeded');
  } finally {
    await codec.dispose();
  }
}, 30000);

test('cancel waits for actual child exit, removes queued requests, and next valid decoder can recover', async () => {
  const pidFile = join(directory, 'cancel.pid');
  let selected = await fixture(
    'cancel',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,
  );
  const codec = service({ assets: () => selected });
  const first = new AbortController(),
    queued = new AbortController();
  const firstResult = codec
    .render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: first.signal })
    .catch((cause) => cause);
  await eventually(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const queuedResult = codec
    .render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: queued.signal })
    .catch((cause) => cause);
  queued.abort(Error('queued_cancel'));
  expect((await queuedResult).message).toBe('queued_cancel');
  selected = assets;
  first.abort(Error('active_cancel'));
  expect((await firstResult).message).toBe('active_cancel');
  expect(gone(pid)).toBe(true);
  expect(
    (
      await codec.render({
        source: { bytes: png },
        mediaType: 'image/png',
        edge: 512,
        signal: signal(),
      })
    ).width,
  ).toBe(96);
  await codec.dispose();
});

test('queue depth, timeout, child crash, output overflow and malformed metadata fail closed without poisoning normal recovery', async () => {
  const pidFile = join(directory, 'timeout.pid');
  const slow = await fixture(
    'timeout',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,
  );
  const codec = service({ assets: () => slow, timeoutMs: 200 });
  const pending = Array.from({ length: 9 }, () =>
    codec
      .render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: signal() })
      .catch((cause) => cause),
  );
  await expect(
    codec.render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: signal() }),
  ).rejects.toThrow('native_image_display_queue_full');
  expect((await pending[0]).message).toBe('native_image_display_timeout');
  expect(gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  await codec.dispose();
  await Promise.all(pending);
  for (const [name, code, failure] of [
    [
      'crash',
      `process.stdin.resume();process.stdin.on('end',()=>process.exit(23));`,
      'process_failed',
    ],
    [
      'overflow',
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(17*1024*1024)));`,
      'output_invalid',
    ],
    [
      'metadata',
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([0,0,0,1,123,1])));`,
      'output_invalid',
    ],
  ] as const) {
    let selected = await fixture(name, code);
    const current = service({ assets: () => selected });
    await expect(
      current.render({
        source: { bytes: png },
        mediaType: 'image/png',
        edge: 512,
        signal: signal(),
      }),
    ).rejects.toThrow(`native_image_display_${failure}`);
    selected = assets;
    expect(
      (
        await current.render({
          source: { bytes: png },
          mediaType: 'image/png',
          edge: 512,
          signal: signal(),
        })
      ).width,
    ).toBe(96);
    await current.dispose();
  }
});

test('checksum mismatch, wrong binary dimensions and extra metadata cannot admit output; disposal kills the active process', async () => {
  const badChecksum = service({ assets: () => ({ ...assets, sha256: '0'.repeat(64) }) });
  await expect(
    badChecksum.render({
      source: { bytes: png },
      mediaType: 'image/png',
      edge: 512,
      signal: signal(),
    }),
  ).rejects.toThrow('native_image_display_unavailable');
  await badChecksum.dispose();
  const webp = await sharp(png).webp().toBuffer();
  for (const metadata of [
    {
      mimeType: 'image/webp',
      width: 95,
      height: 48,
      sourceWidth: 96,
      sourceHeight: 48,
      animated: false,
      frame: 'static',
    },
    {
      mimeType: 'image/webp',
      width: 96,
      height: 48,
      sourceWidth: 96,
      sourceHeight: 48,
      animated: false,
      frame: 'static',
      path: '/secret',
    },
  ]) {
    const header = Buffer.from(JSON.stringify(metadata)),
      length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const packet = Buffer.concat([length, header, webp]);
    const asset = await fixture(
      'wrong-output',
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from(${JSON.stringify(packet.toString('base64'))},'base64')));`,
    );
    const codec = service({ assets: () => asset });
    await expect(
      codec.render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: signal() }),
    ).rejects.toThrow('native_image_display_output_invalid');
    await codec.dispose();
  }
  const pidFile = join(directory, 'dispose.pid');
  const slow = await fixture(
    'dispose',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,
  );
  const codec = service({ assets: () => slow });
  const result = codec
    .render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: signal() })
    .catch((cause) => cause);
  await eventually(() => existsSync(pidFile));
  await codec.dispose();
  expect((await result).message).toBe('native_image_display_cancelled');
  expect(gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  await expect(
    codec.render({ source: { bytes: png }, mediaType: 'image/png', edge: 512, signal: signal() }),
  ).rejects.toThrow('native_image_display_unavailable');
});

test('actual emitted codec exits on owning Main IPC disconnect, even while waiting for source bytes', async () => {
  const child = spawn(assets.executable, [assets.child, 'image/png', '512', '100'], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { UV_THREADPOOL_SIZE: '1', VIPS_CONCURRENCY: '1' },
  });
  let closed = false;
  const exit = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  try {
    await Bun.sleep(150);
    expect(closed).toBe(false);
    child.disconnect();
    await Promise.race([
      exit,
      Bun.sleep(2000).then(() => {
        throw Error('orphan_codec');
      }),
    ]);
    expect(gone(child.pid!)).toBe(true);
  } finally {
    if (!closed) child.kill('SIGKILL');
    await exit;
  }
});

test('unconfirmed child pipe exit fails closed and does not release decoder ownership to queued work', async () => {
  const pidFile = join(directory, 'retained-pipe.pid');
  // Fault injection only: the production sealed codec has no descendant-launch API.
  const asset = await fixture(
    'retained-pipe',
    `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
  );
  const codec = service({ assets: () => asset, timeoutMs: 1000, closeTimeoutMs: 50 });
  const request = {
    source: { bytes: png },
    mediaType: 'image/png',
    edge: 512,
    signal: signal(),
  } as const;
  const one = codec.render(request).catch((cause) => cause),
    two = codec.render(request).catch((cause) => cause);
  let pid: number | undefined;
  try {
    await eventually(() => existsSync(pidFile));
    pid = Number(readFileSync(pidFile, 'utf8'));
    expect((await one).message).toBe('native_image_display_exit_unconfirmed');
    expect((await two).message).toBe('native_image_display_exit_unconfirmed');
    await expect(codec.render(request)).rejects.toThrow('native_image_display_exit_unconfirmed');
    await expect(codec.dispose()).rejects.toThrow('native_image_display_exit_unconfirmed');
  } finally {
    if (pid && !gone(pid)) process.kill(pid, 'SIGKILL');
  }
}, 5000);

test('complete PNG and JPEG accept padding and Motion Photo trailers without changing originals; embedded EOI cannot mask truncation', async () => {
  const codec = service();
  try {
    const jpeg = await sharp(png).jpeg({ progressive: true }).toBuffer();
    const trailer = Buffer.concat([
      Buffer.alloc(8),
      Buffer.from('ftypmp42'),
      Buffer.alloc(1024, 0xa5),
    ]);
    for (const [original, mediaType] of [
      [png, 'image/png'],
      [jpeg, 'image/jpeg'],
    ] as const) {
      for (const padding of [Buffer.alloc(128), trailer]) {
        const bytes = Buffer.concat([original, padding]),
          originalHash = hash(bytes);
        expect(
          (await codec.render({ source: { bytes }, mediaType, edge: 512, signal: signal() })).width,
        ).toBe(96);
        expect(hash(bytes)).toBe(originalHash);
      }
    }
    // This APP1 payload contains a complete thumbnail marker sequence but no source EOI.
    const embedded = Buffer.from([255, 225, 0, 8, 255, 216, 0, 0, 255, 217]);
    const complete = Buffer.concat([jpeg.subarray(0, 2), embedded, jpeg.subarray(2)]);
    expect(
      (
        await codec.render({
          source: { bytes: complete },
          mediaType: 'image/jpeg',
          edge: 512,
          signal: signal(),
        })
      ).width,
    ).toBe(96);
    for (const truncated of [
      jpeg.subarray(0, -2),
      Buffer.concat([jpeg.subarray(0, 2), embedded, jpeg.subarray(2, -2)]),
      Buffer.concat([jpeg.subarray(0, jpeg.length / 2), Buffer.from([255, 217])]),
      Buffer.from([255, 216, 255, 225, 255, 255, 0, 0, 255, 217]),
    ]) {
      await expect(
        codec.render({
          source: { bytes: truncated },
          mediaType: 'image/jpeg',
          edge: 512,
          signal: signal(),
        }),
      ).rejects.toThrow('native_image_display_decode_failed');
    }
    await expect(
      codec.render({
        source: { bytes: Buffer.concat([png.subarray(0, -12), trailer]) },
        mediaType: 'image/png',
        edge: 512,
        signal: signal(),
      }),
    ).rejects.toThrow('native_image_display_invalid');
  } finally {
    await codec.dispose();
  }
});

test('ROI uses original oriented pixels for four formats and non-square EXIF JPEG, preserving source bytes', async () => {
  const codec = service();
  const raw = Buffer.alloc(120 * 80 * 3);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 120; x++) raw[(y * 120 + x) * 3 + (x < 60 ? 0 : 2)] = 255;
  const crop = { left: 70, top: 20, width: 30, height: 40 };
  try {
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const bytes = await sharp(raw, { raw: { width: 120, height: 80, channels: 3 } })
        .toFormat(format)
        .toBuffer();
      const original = hash(bytes);
      const value = await codec.render({
        source: { bytes },
        mediaType: `image/${format}`,
        edge: 2048,
        region: crop,
        signal: signal(),
      });
      expect(value).toMatchObject({
        width: 30,
        height: 40,
        sourceWidth: 120,
        sourceHeight: 80,
        region: crop,
      });
      const pixel = await sharp(value.bytes).raw().toBuffer();
      expect(pixel[0]).toBeLessThan(16);
      expect(pixel[2]).toBeGreaterThan(240);
      expect(hash(bytes)).toBe(original);
    }
    const oriented = await sharp(raw, { raw: { width: 120, height: 80, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const region = { left: 10, top: 70, width: 30, height: 40 };
    const value = await codec.render({
      source: { bytes: oriented },
      mediaType: 'image/jpeg',
      edge: 1024,
      region,
      signal: signal(),
    });
    expect(value).toMatchObject({
      width: 30,
      height: 40,
      sourceWidth: 80,
      sourceHeight: 120,
      region,
    });
    const pixel = await sharp(value.bytes).raw().toBuffer();
    expect(pixel[0]).toBeLessThan(16);
    expect(pixel[2]).toBeGreaterThan(240);
    const path = join(directory, 'roi-source.jpg');
    await writeFile(path, oriented);
    expect(
      await codec.render({
        source: { path },
        mediaType: 'image/jpeg',
        edge: 1024,
        region,
        signal: signal(),
      }),
    ).toEqual(value);
    expect(hash(await readFile(path))).toBe(hash(oriented));
    const large = await sharp({
      create: { width: 3200, height: 1800, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const largeRegion = { left: 100, top: 100, width: 3000, height: 1500 };
    expect(
      await codec.render({
        source: { bytes: large },
        mediaType: 'image/png',
        edge: 2048,
        region: largeRegion,
        signal: signal(),
      }),
    ).toMatchObject({ width: 2048, height: 1024, region: largeRegion });
  } finally {
    await codec.dispose();
  }
}, 15000);

test('ROI refuses unsafe rectangles, actual-source out-of-bounds, >2048 crop tiers and mismatched child region metadata', async () => {
  const codec = service();
  const valid = { left: 10, top: 5, width: 16, height: 8 };
  try {
    for (const region of [
      { ...valid, left: -1 },
      { ...valid, top: Number.NaN },
      { ...valid, width: 0 },
      { ...valid, width: 1.5 },
      { ...valid, height: Number.POSITIVE_INFINITY },
      { ...valid, path: '/secret' },
      { ...valid, left: Number.MAX_SAFE_INTEGER },
      { ...valid, left: 90 },
      { ...valid, top: 45 },
    ])
      await expect(
        codec.render({
          source: { bytes: png },
          mediaType: 'image/png',
          edge: 512,
          region,
          signal: signal(),
        }),
      ).rejects.toThrow('native_image_display_invalid');
    await expect(
      codec.render({
        source: { bytes: png },
        mediaType: 'image/png',
        edge: 4096,
        region: valid,
        signal: signal(),
      }),
    ).rejects.toThrow('native_image_display_invalid');
  } finally {
    await codec.dispose();
  }
  const webp = await sharp(png).extract(valid).webp().toBuffer();
  const base = {
    mimeType: 'image/webp',
    width: 16,
    height: 8,
    sourceWidth: 96,
    sourceHeight: 48,
    animated: false,
    frame: 'static',
  };
  for (const [metadata, requested] of [
    [base, valid],
    [{ ...base, region: { ...valid, left: 11 } }, valid],
    [{ ...base, region: { ...valid, width: 15 } }, valid],
    [{ ...base, region: { ...valid, left: 95 } }, valid],
    [{ ...base, region: valid }, undefined],
  ] as const) {
    const header = Buffer.from(JSON.stringify(metadata)),
      length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const packet = Buffer.concat([length, header, webp]);
    const asset = await fixture(
      'wrong-roi',
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from(${JSON.stringify(packet.toString('base64'))},'base64')));`,
    );
    const current = service({ assets: () => asset });
    await expect(
      current.render({
        source: { bytes: png },
        mediaType: 'image/png',
        edge: 512,
        region: requested,
        signal: signal(),
      }),
    ).rejects.toThrow('native_image_display_output_invalid');
    await current.dispose();
  }
});

test('superseded ROI cancellation waits for child exit and admits only the latest requested rectangle', async () => {
  const pidFile = join(directory, 'roi-cancel.pid');
  let selected = await fixture(
    'roi-cancel',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,
  );
  const codec = service({ assets: () => selected });
  const abort = new AbortController();
  const first = codec
    .render({
      source: { bytes: png },
      mediaType: 'image/png',
      edge: 512,
      region: { left: 0, top: 0, width: 20, height: 10 },
      signal: abort.signal,
    })
    .catch((cause) => cause);
  try {
    await eventually(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    selected = assets;
    const region = { left: 50, top: 20, width: 30, height: 15 };
    const latest = codec.render({
      source: { bytes: png },
      mediaType: 'image/png',
      edge: 512,
      region,
      signal: signal(),
    });
    abort.abort(Error('viewport_changed'));
    expect((await first).message).toBe('viewport_changed');
    expect(gone(pid)).toBe(true);
    expect(await latest).toMatchObject({ region, width: 30, height: 15 });
  } finally {
    await codec.dispose();
  }
});
