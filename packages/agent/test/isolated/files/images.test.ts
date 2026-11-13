import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, GifEncoder, loadImage } from '@napi-rs/canvas';
import { expect, test } from '#kite-test';
import {
  directoryLink,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import {
  createImageFileReads,
  createViewImagesTool,
  createWorkspaceFiles,
} from '../../../src/files';
import type { InputFileImport } from '../../../src/storage/input-file-imports';
import { AgentError, type Json } from '../../../src/storage/types';
import { toolImages } from '../../../src/tool-images';
import { imageInputBytes, imageOutputBytes } from '../../../src/tools/images/format';
import {
  createImageProcessor,
  imageAssets,
  processImage,
} from '../../../src/tools/images/processor';

const signal = () => new AbortController().signal;
function sample(width = 96, height = 48) {
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, width / 2, height);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(width / 2, 0, width / 2, height);
  return canvas;
}
async function decode(bytes: Uint8Array) {
  return processImage(async () => ({ bytes }), signal());
}
async function rgba(bytes: Uint8Array) {
  const image = await loadImage(bytes),
    canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

test('strict codec reads real PNG/JPEG/WebP/GIF pixels, alpha, EXIF and first animation frame', async () => {
  const canvas = sample();
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const value = await decode(
      await (format === 'png' ? canvas.encode('png') : canvas.encode(format)),
    );
    expect(value.metadata).toMatchObject({
      sourceFormat: format,
      width: 96,
      height: 48,
      resized: false,
      frame: 0,
    });
    const pixels = await rgba(value.png);
    expect(pixels.data[0]).toBeGreaterThan(240);
    expect(pixels.data[2]).toBeLessThan(15);
  }
  const transparent = createCanvas(8, 8);
  const alpha = await rgba((await decode(await transparent.encode('webp'))).png);
  expect(alpha.data[3]).toBe(0);
  const jpeg = await sample(80, 40).encode('jpeg');
  const exif = Buffer.from(
    '45786966000049492a0008000000010012010300010000000600000000000000',
    'hex',
  );
  const marker = Buffer.alloc(4);
  marker.set([255, 225]);
  marker.writeUInt16BE(exif.length + 2, 2);
  const oriented = await decode(
    Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]),
  );
  expect(oriented.metadata).toMatchObject({
    sourceWidth: 80,
    sourceHeight: 40,
    width: 40,
    height: 80,
    orientationApplied: 6,
    resized: false,
  });
  using gif = new GifEncoder(4, 4);
  gif.addFrame(
    new Uint8Array(Array.from({ length: 64 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0))),
    4,
    4,
  );
  gif.addFrame(
    new Uint8Array(Array.from({ length: 64 }, (_, i) => (i % 4 === 2 || i % 4 === 3 ? 255 : 0))),
    4,
    4,
  );
  const animated = await decode(gif.finish());
  expect(animated.metadata).toMatchObject({ animated: true, frame: 0, width: 4, height: 4 });
  expect(Array.from((await rgba(animated.png)).data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
}, 15000);

test('truncated containers and native scan warnings fail closed; every failure permits a subsequent valid decode', async () => {
  const canvas = sample(1200, 800),
    png = await canvas.encode('png'),
    jpeg = await canvas.encode('jpeg'),
    webp = await canvas.encode('webp');
  const badCRC = Buffer.from(png);
  badCRC[29] = badCRC[29]! ^ 1;
  const invalid = [
    png.subarray(0, -12),
    badCRC,
    jpeg.subarray(0, jpeg.length / 2),
    Buffer.concat([jpeg.subarray(0, jpeg.length / 2), Buffer.from([255, 217])]),
    webp.subarray(0, -4),
    Buffer.from('GIF89a'),
    Buffer.from('<svg/>'),
  ];
  for (const bytes of invalid) {
    await expect(decode(bytes)).rejects.toMatchObject({
      code: expect.stringMatching(/^image_(invalid|decode_failed|format_unsupported)$/),
    });
    expect((await decode(png)).metadata.width).toBe(1200);
  }
});

test('input pixels, dimensions and bytes are bounded, and large valid sources are resized', async () => {
  const large = await sample(8000, 4000).encode('png');
  expect((await decode(large)).metadata).toMatchObject({
    sourceWidth: 8000,
    sourceHeight: 4000,
    width: 2048,
    height: 1024,
    resized: true,
  });
  await expect(decode(new Uint8Array(imageInputBytes + 1))).rejects.toMatchObject({
    code: 'image_input_too_large',
  });
  for (const dimensions of [
    [16385, 1],
    [8001, 4000],
  ]) {
    const bytes = await sample(dimensions[0], dimensions[1]).encode('png');
    await expect(decode(bytes)).rejects.toMatchObject({
      code: expect.stringMatching(/^image_(dimensions_exceeded|decode_failed)$/),
    });
  }
});

test('one retry reduces high entropy alpha output to the PNG byte budget', async () => {
  const canvas = createCanvas(2048, 2048),
    ctx = canvas.getContext('2d'),
    pixels = ctx.createImageData(2048, 2048);
  let state = 123456789;
  for (let at = 0; at < pixels.data.length; at++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels.data[at] = state & 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const bytes = await canvas.encode('webp', 95);
  expect(bytes.length).toBeLessThanOrEqual(imageInputBytes);
  const result = await decode(bytes);
  expect(result.png.length).toBeLessThanOrEqual(imageOutputBytes);
  expect(result.metadata.resized).toBe(true);
  expect(result.metadata.width).toBeLessThan(2048);
  let publications = 0,
    reads = 0;
  const batch = await createViewImagesTool(async (path) => {
    reads++;
    return { path, bytes: result.png };
  }).execute({ paths: ['a', 'b', 'c', 'd'] }, {
    signal: signal(),
    artifacts: {
      async publish() {
        publications++;
        throw Error('must_not_publish');
      },
    },
  } as unknown as ToolContext);
  expect(batch).toMatchObject({ outcome: 'failed', content: 'image_batch_too_large' });
  expect(batch.modelImages).toBeUndefined();
  expect(reads).toBe(3);
  expect(publications).toBe(0);
});

test('one call reads ten images in order, rejects invalid batches before IO and discards failed or cancelled batches', async () => {
  const bytes = await sample().encode('png'),
    paths = Array.from({ length: 10 }, (_, i) => `${i}.png`);
  const reads: string[] = [],
    keys: string[] = [];
  const context = {
    signal: signal(),
    artifacts: {
      async publish(input: { key: string; content: Uint8Array }) {
        keys.push(input.key);
        return {
          id: input.key,
          scope: { kind: 'execution', id: 'batch' },
          mediaType: 'image/png',
          size: String(input.content.length),
        };
      },
    },
  } as unknown as ToolContext;
  const tool = createViewImagesTool(async (path) => {
    reads.push(path);
    return { path, bytes };
  });
  const invalidInputs: Json[] = [
    { paths: [...paths, '11.png'] },
    { paths: [] },
    { paths: ['a', 'a'] },
    { path: 'a', paths: ['b'] },
    { paths: ['a', 'https://example.invalid/b.png'] },
  ];
  for (const input of invalidInputs) {
    expect((await tool.execute(input, context)).outcome).toBe('failed');
  }
  expect(reads).toHaveLength(0);
  expect(keys).toHaveLength(0);
  const result = await tool.execute({ paths }, context);
  expect(result.outcome).toBe('succeeded');
  expect(reads).toEqual(paths);
  expect(keys).toEqual(paths.map((_, i) => `image-${i + 1}`));
  expect(JSON.parse(result.content).images.map((image: { path: string }) => image.path)).toEqual(
    paths,
  );
  expect(toolImages(result.modelImages, 'batch', tool)).toHaveLength(10);
  expect(toolImages(result.modelImages!.slice(0, 4), 'batch')).toHaveLength(4);
  expect(() => toolImages(result.modelImages!.slice(0, 5), 'batch')).toThrow('tool_images_invalid');
  for (const definition of [
    undefined,
    { id: 'files.read', version: '5' },
    { id: 'files.view_images', version: '2' },
  ])
    expect(() => toolImages(result.modelImages, 'batch', definition)).toThrow(
      'tool_images_invalid',
    );
  const atLimit = result
    .modelImages!.slice(0, 2)
    .map((ref) => ({ ...ref, size: String(8 * 1024 * 1024) }));
  expect(toolImages(atLimit, 'batch', tool)).toHaveLength(2);
  expect(() => toolImages([...atLimit, result.modelImages![2]!], 'batch', tool)).toThrow(
    'tool_images_too_large',
  );
  expect(() =>
    toolImages([{ ...atLimit[0]!, size: String(8 * 1024 * 1024 + 1) }], 'batch', tool),
  ).toThrow('tool_images_invalid');
  reads.length = 0;
  keys.length = 0;
  const failed = await createViewImagesTool(async (path) => {
    reads.push(path);
    return { path, bytes: path === 'bad' ? new Uint8Array([1, 2, 3]) : bytes };
  }).execute({ paths: ['good', 'bad', 'never'] }, context);
  expect(failed.outcome).toBe('failed');
  expect(failed.modelImages).toBeUndefined();
  expect(reads).toEqual(['good', 'bad']);
  expect(keys).toHaveLength(0);
  const cancelled = new AbortController();
  reads.length = 0;
  const stopped = await createViewImagesTool(async (path) => {
    reads.push(path);
    if (path === 'stop') cancelled.abort();
    return { path, bytes };
  }).execute({ paths: ['first', 'stop', 'never'] }, { ...context, signal: cancelled.signal });
  expect(stopped.outcome).toBe('cancelled');
  expect(stopped.modelImages).toBeUndefined();
  expect(reads).toEqual(['first', 'stop']);
  expect(keys).toHaveLength(0);
  expect((await tool.execute({ path: 'after' }, context)).outcome).toBe('succeeded');
}, 15000);

test('queued cancellation never reads bytes; active timeout, crash, output overflow and memory termination recover', async () => {
  const root = temporaryDirectory('kite-image-process-');
  const child = join(root, 'child.js'),
    checksum = join(root, 'child.sha256');
  const assets = () => ({ child, checksum, dependencies: [] });
  function program(code: string) {
    writeFileSync(child, code);
    writeFileSync(checksum, createHash('sha256').update(code).digest('hex'));
  }
  const bytes = await sample().encode('png');
  try {
    program('for await (const chunk of process.stdin) {} setInterval(()=>{},1000);');
    const active = new AbortController(),
      queued = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = createImageProcessor({ assets })(async () => {
      entered();
      return { bytes };
    }, active.signal);
    void first.catch(() => {});
    await started;
    let reads = 0;
    const second = processImage(async () => {
      reads++;
      return { bytes };
    }, queued.signal);
    queued.abort(new AgentError('fixture_queue_cancelled'));
    await expect(second).rejects.toMatchObject({ code: 'fixture_queue_cancelled' });
    expect(reads).toBe(0);
    active.abort(new AgentError('fixture_active_cancelled'));
    await expect(first).rejects.toMatchObject({ code: 'fixture_active_cancelled' });
    expect((await decode(bytes)).metadata.width).toBe(96);
    await expect(
      createImageProcessor({ assets, timeoutMs: 150 })(async () => ({ bytes }), signal()),
    ).rejects.toMatchObject({ code: 'image_processing_timeout' });
    for (const code of [
      'for await (const chunk of process.stdin) {} process.abort();',
      'for await (const chunk of process.stdin) {} process.stdout.write(new Uint8Array(9*1024*1024));',
      ...(process.platform === 'win32'
        ? [
            'for await (const chunk of process.stdin) {} const held=[]; for(;;) {const a=Buffer.alloc(32*1024*1024,1); held.push(a);}',
          ]
        : []),
    ]) {
      program(code);
      await expect(
        createImageProcessor({ assets, timeoutMs: 5000 })(async () => ({ bytes }), signal()),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^image_process_(failed|output_invalid)$/),
      });
      expect((await decode(bytes)).metadata.width).toBe(96);
    }
    writeFileSync(checksum, '0'.repeat(64));
    await expect(
      createImageProcessor({ assets })(async () => ({ bytes }), signal()),
    ).rejects.toMatchObject({ code: 'image_assets_invalid' });
    expect((await decode(bytes)).metadata.width).toBe(96);
  } finally {
    removeTemporaryDirectory(root);
  }
}, 20000);

test('image paths reuse native/protected roots, exact input binding and dispatch revision without edit baselines', async () => {
  const root = temporaryDirectory('kite-image-permissions-'),
    workspace = join(root, 'workspace'),
    profile = join(root, 'profile'),
    external = join(root, 'external');
  for (const path of [workspace, profile, external]) mkdirSync(path);
  const bytes = await sample().encode('png'),
    original = join(profile, 'original.png'),
    outside = join(external, 'outside.png');
  for (const path of [join(workspace, 'picture.dat'), original, outside])
    writeFileSync(path, bytes);
  linkSync(outside, join(external, 'shared.png'));
  directoryLink(profile, join(workspace, 'private-link'));
  const imported = {
    id: 'import',
    sessionId: 's',
    subjectId: 'owner',
    originStoreId: 'store',
    uri: pathToFileURL(original).href,
    state: 'bound',
    boundCommandId: 'input',
    createdAt: 1,
    name: 'original.png',
    reference: {
      id: 'original',
      storeId: 'store',
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session', id: 's' },
      hash: createHash('sha256').update(bytes).digest('hex'),
      size: String(bytes.length),
      mediaType: 'image/png',
    },
  } as InputFileImport;
  const files = createWorkspaceFiles({ root: workspace, protectReads: true });
  const adapter = createImageFileReads({
    profilePath: profile,
    async workspaceRoot() {
      return workspace;
    },
    protectedRoots: () => [profile],
    async readWorkspace(path, _context, active) {
      const value = await files.readBytes(files.relativePath(path), {
        maxBytes: imageInputBytes,
        signal: active,
        sharedRead: true,
      });
      return { path, bytes: value.bytes, hash: value.baseline.hash };
    },
    async resolveInput(request, uri) {
      return request.sessionId === 's' && uri === imported.uri ? imported : null;
    },
  });
  const published: Uint8Array[] = [];
  const context = {
    sessionId: 's',
    executionId: 'image',
    signal: signal(),
    artifacts: {
      async publish(input: { content: Uint8Array }) {
        published.push(input.content);
        return {
          id: 'ref',
          scope: { kind: 'execution', id: 'image' },
          mediaType: 'image/png',
          size: String(input.content.length),
        };
      },
    },
  } as unknown as ToolContext;
  const request = (path: string | string[]) =>
    ({
      kind: 'tool',
      definitionId: 'files.view_images',
      definitionVersion: '1',
      sessionId: 's',
      runId: 'r',
      executionId: 'image',
      signal: context.signal,
      input: typeof path === 'string' ? { path } : { paths: path },
    }) as AuthorizationRequest;
  try {
    for (const path of [
      'picture.dat',
      join(workspace, 'picture.dat'),
      outside,
      join(external, 'shared.png'),
    ]) {
      const result = await adapter.tool.execute({ path }, context);
      expect(result.outcome).toBe('succeeded');
      expect(result.modelImages).toHaveLength(1);
      expect(result.content).not.toContain('baseline');
    }
    const capability = await adapter.describeRequest(request(original));
    const bound = {
      ...context,
      dispatchAuthorization: {
        revision: 'dispatch',
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: { capability: capability as unknown as Json },
        },
      },
    } as ToolContext;
    expect((await adapter.tool.execute({ path: original }, bound)).outcome).toBe('succeeded');
    expect((await adapter.tool.execute({ paths: [original, 'picture.dat'] }, bound)).content).toBe(
      'file_dispatch_scope_changed',
    );
    const batchPaths = ['picture.dat', original, outside];
    const batchCapability = await adapter.describeRequest(request(batchPaths));
    const batchBound = {
      ...bound,
      dispatchAuthorization: {
        revision: 'dispatch',
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: { capability: batchCapability as unknown as Json },
        },
      },
    } as ToolContext;
    const batch = await adapter.tool.execute({ paths: batchPaths }, batchBound);
    expect(batch.outcome).toBe('succeeded');
    expect(batch.modelImages).toHaveLength(3);
    const priorPublications = published.length;
    expect(
      (
        await adapter.tool.execute(
          { paths: ['picture.dat', join(profile, 'not-imported.png')] },
          batchBound,
        )
      ).outcome,
    ).toBe('failed');
    expect(published).toHaveLength(priorPublications);
    for (const path of [
      join(profile, 'not-imported.png'),
      'private-link/original.png',
      '../external/outside.png',
      'https://example.invalid/a.png',
    ]) {
      expect((await adapter.tool.execute({ path }, context)).outcome).toBe('failed');
    }
    expect(
      (await adapter.tool.execute({ path: original }, { ...bound, sessionId: 'foreign' })).outcome,
    ).toBe('failed');
    expect((await adapter.tool.execute({ path: original }, context)).content).toBe(
      'file_dispatch_scope_unavailable',
    );
    writeFileSync(original, await sample(8, 8).encode('png'));
    expect((await adapter.tool.execute({ path: original }, bound)).content).toBe(
      'artifact_content_mismatch',
    );
    expect(published).toHaveLength(8);
    const failure = new AgentError('artifact_content_mismatch');
    const unknown = new AgentError('file_close_unknown');
    await expect(
      createViewImagesTool(async () => {
        throw unknown;
      }).execute({ path: 'a' }, context),
    ).rejects.toBe(unknown);
    await expect(
      createViewImagesTool(async () => ({ path: 'a', bytes })).execute({ path: 'a' }, {
        ...context,
        artifacts: {
          async publish() {
            throw failure;
          },
        },
      } as unknown as ToolContext),
    ).rejects.toBe(failure);
  } finally {
    await files.close();
    removeTemporaryDirectory(root);
  }
});

test('pinned image assets contain the actual sharp native closure', () => {
  const assets = imageAssets();
  expect(readFileSync(assets.checksum, 'utf8').trim()).toBe(
    createHash('sha256').update(readFileSync(assets.child)).digest('hex'),
  );
  const names = assets.dependencies.map(
    (path) => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name,
  );
  expect(names).toContain('sharp');
  expect(names.some((name: string) => name.startsWith('@img/sharp-'))).toBe(true);
});
