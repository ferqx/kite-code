import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  brokenEmbeddedFontPdf,
  chinesePagedPdf,
  columnsAndTablePdf,
  noisyPagedPdf,
  simplePdf,
} from '../../../../../tests/fixtures/pdf';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import type { ArtifactWriter, AuthorizationRequest, ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, withInputFileReads } from '../../../src/files';
import type { InputFileImport } from '../../../src/storage/input-file-imports';
import { readCachedPdf, readPdf } from '../../../src/tools/documents/pdf';

test('public Files preserves the fixed column-major and table-row text while publishing the actual page image', async () => {
  const profilePath = temporaryDirectory('kite-pdf-layout-');
  const files = createWorkspaceFiles({ root: profilePath });
  const bytes = columnsAndTablePdf();
  const path = join(profilePath, 'layout.pdf');
  writeFileSync(path, bytes);
  const imported: InputFileImport = {
    id: 'layout',
    sessionId: 'session',
    subjectId: 'owner',
    originStoreId: 'store',
    name: 'layout.pdf',
    uri: pathToFileURL(path).href,
    state: 'bound',
    boundCommandId: 'original',
    createdAt: 1,
    reference: {
      id: 'original-pdf',
      storeId: 'store',
      sessionId: 'session',
      subjectId: 'owner',
      scope: { kind: 'session', id: 'session' },
      hash: createHash('sha256').update(bytes).digest('hex'),
      size: String(bytes.length),
      mediaType: 'application/pdf',
    },
  };
  // This format fixture supplies only exact scope/publication ports. Actual
  // Store binding, Artifact verification and Model delivery have their own tests.
  const adapter = withInputFileReads({
    profilePath,
    tools: createFileTools(files),
    async resolve(request, uri) {
      return request.sessionId === imported.sessionId && uri === imported.uri ? imported : null;
    },
  });
  const published = new Map<string, Uint8Array>();
  const artifacts: ArtifactWriter = {
    async publish(input) {
      const id = `${published.size}:${input.key}`;
      published.set(id, Uint8Array.from(input.content));
      return {
        id,
        mediaType: input.mediaType,
        size: String(input.content.byteLength),
        scope: { kind: 'execution', id: 'read-layout' },
      };
    },
    async read(reference) {
      return published.get(reference.id)!;
    },
  };
  const read = async (mode: 'text' | 'image') => {
    const input = { path, pages: '1', mode };
    const request: AuthorizationRequest = {
      kind: 'tool',
      definitionId: 'files.read',
      definitionVersion: '5',
      sessionId: 'session',
      runId: 'original-run',
      executionId: 'read-layout',
      signal: new AbortController().signal,
      input,
    };
    const capability = await adapter.describeRequest(request);
    expect(capability?.hardAllowed).toBe(true);
    return adapter.tools
      .find((tool) => tool.id === 'files.read')!
      .execute(input, {
        ...request,
        artifacts,
        dispatchAuthorization: {
          revision: 'accepted-layout-read',
          snapshot: {
            namespace: 'builtin.permissions',
            version: '1',
            data: { capability },
          },
        },
      } as unknown as ToolContext);
  };
  try {
    const text = await read('text');
    expect(text.outcome).toBe('succeeded');
    const body = JSON.parse(text.content);
    expect(body.pages[0].text.replace(/[ \t]+/g, ' ').trim()).toBe(
      [
        'Two columns and a table',
        'LEFT 1: apples',
        'LEFT 2: pears',
        'LEFT 3: total 10',
        'RIGHT 1: oranges',
        'RIGHT 2: lemons',
        'RIGHT 3: total 12',
        'Fruit Count',
        'Apples 7',
        'Pears 3',
      ].join('\n'),
    );
    expect(body).toMatchObject({
      totalPages: 1,
      nextPage: null,
      pages: [{ number: 1, extraction: 'text_extracted_reading_order_not_guaranteed' }],
    });
    expect(Buffer.from(await artifacts.read(text.modelContent!.reference)).toString()).toBe(
      text.content,
    );
    const image = await read('image');
    expect(image.outcome).toBe('succeeded');
    expect(JSON.parse(image.content).pages).toEqual([
      { number: 1, label: null, text: '', extraction: 'page_image' },
    ]);
    expect(image.modelImages).toHaveLength(1);
    const png = await artifacts.read(image.modelImages![0]!);
    const decoded = await loadImage(Buffer.from(png));
    expect([decoded.width, decoded.height]).toEqual([918, 1188]);
    const canvas = createCanvas(decoded.width, decoded.height);
    const context = canvas.getContext('2d');
    context.drawImage(decoded, 0, 0);
    expect([...context.getImageData(80, 360, 1, 1).data]).toEqual([204, 230, 255, 255]);
    // Visible table rules remain in the image although text extraction returns no grid.
    expect(context.getImageData(100, 408, 1, 1).data[0]).toBeLessThan(100);
    expect(context.getImageData(450, 440, 1, 1).data[0]).toBeLessThan(100);
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    await files.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
}, 20000);

test('encrypted PDF requests a password and a later independent read still succeeds', async () => {
  // Genuine AES-128 encrypted blank PDF, generated by pypdf 6.10.0 with a test password.
  const bytes = readFileSync(
    new URL('../../../../../tests/fixtures/password.pdf', import.meta.url),
  );
  await expect(readPdf(bytes, {}, new AbortController().signal)).rejects.toMatchObject({
    code: 'pdf_password_required',
  });
  expect((await readPdf(simplePdf(), {}, new AbortController().signal)).pages[0]!.text).toBe(
    'Hello PDF',
  );
}, 20000);

test('PDF rejects the actual combined PNG output budget and permits a later independent read', async () => {
  const bytes = noisyPagedPdf();
  const signal = new AbortController().signal;
  const page = await readPdf(bytes, { pages: '1', mode: 'image' }, signal);
  const image = page.pages[0]!.image!;
  expect(Buffer.from(image).readUInt32BE(16)).toBe(2048);
  expect(Buffer.from(image).readUInt32BE(20)).toBe(2048);
  expect(image.byteLength).toBeGreaterThan(8 * 1024 * 1024);
  expect(image.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(page.nextPage).toBe(2);
  await expect(readPdf(bytes, { pages: '1-2', mode: 'image' }, signal)).rejects.toMatchObject({
    code: 'pdf_result_too_large',
  });
  expect((await readPdf(simplePdf(), {}, signal)).pages[0]!.text).toBe('Hello PDF');
}, 20000);

test('PDF rejects a broken embedded font in text and image modes and permits subsequent reads', async () => {
  const bytes = brokenEmbeddedFontPdf();
  const signal = new AbortController().signal;
  for (const mode of ['text', 'image'] as const) {
    await expect(readPdf(bytes, { mode }, signal)).rejects.toMatchObject({
      code: 'pdf_font_invalid',
    });
    const normal = await readPdf(simplePdf(), { mode }, signal);
    if (mode === 'text') expect(normal.pages[0]!.text).toBe('Hello PDF');
    else
      expect(Buffer.from(normal.pages[0]!.image!).subarray(0, 8).toString('hex')).toBe(
        '89504e470d0a1a0a',
      );
  }
}, 20000);

test('PDF queued cancellation does not spawn a worker; cancelling a dispatched request frees capacity', async () => {
  const OriginalWorker = globalThis.Worker;
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const workers: Worker[] = [];
  const terminated: Worker[] = [];
  let dispatched = 0;
  let ready!: () => void;
  const bothDispatched = new Promise<void>((resolve) => {
    ready = resolve;
  });
  // Observe real workers without replacing their parser, messages, or lifecycle operations.
  globalThis.Worker = new Proxy(OriginalWorker, {
    construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      workers.push(worker);
      worker.postMessage = new Proxy(worker.postMessage, {
        apply(target, _receiver, input) {
          const result = Reflect.apply(target, worker, input);
          if (++dispatched === 2) ready();
          return result;
        },
      });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        terminated.push(worker);
        return terminate();
      };
      return worker;
    },
  });
  const results: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 2; index++)
      results.push(readPdf(simplePdf(), { mode: 'image' }, controllers[index]!.signal));
    // A rejection handler is present before either cancellation.
    const running = Promise.allSettled(results);
    await Promise.race([
      bothDispatched,
      Bun.sleep(5000).then(() => {
        throw Error('pdf_dispatch_deadline');
      }),
    ]);
    const queued = readPdf(simplePdf(), {}, controllers[2]!.signal);
    const queuedResult = Promise.allSettled([queued]);
    controllers[2]!.abort(new Error('queued-cancel'));
    controllers[0]!.abort(new Error('active-cancel'));
    expect((await queuedResult)[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'queued-cancel' },
    });
    expect(workers).toHaveLength(2);
    const settled = await running;
    expect(settled[0]).toMatchObject({ status: 'rejected', reason: { message: 'active-cancel' } });
    expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { totalPages: 1 } });
    expect(terminated).toHaveLength(workers.length);
    for (const worker of workers)
      expect(terminated.filter((entry) => entry === worker)).toHaveLength(1);
    expect((await readPdf(simplePdf(), {}, new AbortController().signal)).pages[0]!.text).toBe(
      'Hello PDF',
    );
    expect(workers).toHaveLength(3);
    expect(terminated).toHaveLength(3);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(results);
    globalThis.Worker = OriginalWorker;
  }
}, 20000);

test('PDF local CMaps, labels, continuation and rotated non-text pages retain their actual meaning', async () => {
  const bytes = chinesePagedPdf(),
    signal = new AbortController().signal;
  expect(await readPdf(bytes, {}, signal)).toMatchObject({
    totalPages: 2,
    nextPage: 2,
    pages: [{ number: 1, label: 'i', text: '中文' }],
  });
  expect(await readPdf(bytes, { pages: '2' }, signal)).toMatchObject({
    nextPage: null,
    pages: [{ number: 2, label: 'ii', text: '' }],
  });
  const image = (await readPdf(bytes, { pages: '2', mode: 'image' }, signal)).pages[0]!.image!;
  expect(Buffer.from(image).readUInt32BE(16)).toBe(1024);
  expect(Buffer.from(image).readUInt32BE(20)).toBe(2048);
  await expect(readPdf(Buffer.from('not a PDF'), {}, signal)).rejects.toMatchObject({
    code: 'pdf_invalid',
  });
  expect((await readPdf(simplePdf(), {}, signal)).pages[0]!.text).toBe('Hello PDF');
}, 20000);

test('fixed PDF worker extracts physical pages and renders real PNG bytes', async () => {
  const signal = new AbortController().signal;
  const text = await readPdf(simplePdf(), {}, signal);
  expect(text).toMatchObject({
    totalPages: 1,
    nextPage: null,
    pages: [{ number: 1, text: 'Hello PDF' }],
  });
  const rendered = await readPdf(simplePdf(), { mode: 'image' }, signal);
  expect(Buffer.from(rendered.pages[0]!.image!).subarray(0, 8).toString('hex')).toBe(
    '89504e470d0a1a0a',
  );
  for (const input of [
    { pages: '0' },
    { pages: '2' },
    { pages: '1-21' },
    { mode: 'image', pages: '1-5' },
  ]) {
    let error: unknown;
    try {
      await readPdf(simplePdf(), input, signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
  }
  let cancelled: unknown;
  try {
    await readPdf(simplePdf(), {}, AbortSignal.abort(new Error('cancelled')));
  } catch (error) {
    cancelled = error;
  }
  expect(String(cancelled)).toContain('cancelled');
}, 20000);

test('PDF cache is disposable: corrupt UTF-8, partial JSON and deletion rebuild the original result', async () => {
  const profilePath = temporaryDirectory('kite-pdf-cache-');
  try {
    const bytes = simplePdf(),
      signal = new AbortController().signal;
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    const scope = { profilePath, storeId: 'store', sourceHash };
    const original = await readCachedPdf(bytes, {}, scope, signal);
    const directory = join(
      profilePath,
      'cache/documents',
      createHash('sha256').update('store').digest('hex'),
      sourceHash,
    );
    const cached = join(directory, readdirSync(directory)[0]!, 'result.json');
    expect(await readCachedPdf(bytes, {}, scope, signal)).toEqual(original);
    for (const invalid of [Buffer.from([0xff, 0xfe, 0]), Buffer.from('{"body":')]) {
      writeFileSync(cached, invalid);
      expect(await readCachedPdf(bytes, {}, scope, signal)).toEqual(original);
    }
    rmSync(cached);
    expect(await readCachedPdf(bytes, {}, scope, signal)).toEqual(original);
    const rendered = await readCachedPdf(bytes, { mode: 'image' }, scope, signal);
    expect((await readCachedPdf(bytes, { mode: 'image' }, scope, signal)).pages[0]!.image).toEqual(
      rendered.pages[0]!.image,
    );
    expect(readdirSync(directory)).toHaveLength(2);
  } finally {
    rmSync(profilePath, { recursive: true, force: true });
  }
}, 30000);
