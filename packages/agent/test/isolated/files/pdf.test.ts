import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, withInputFileReads } from '../../../src/files';
import type { InputFileImport } from '../../../src/storage/input-file-imports';
import type { Json } from '../../../src/storage/types';
import { readCachedPdf, readPdf } from '../../../src/tools/documents/pdf';
import { readPdfForShell } from '../../../src/tools/documents/pdf-shell';

test('engineering text keeps its baseline and document types are routed without reading their bytes', async () => {
  const root = temporaryDirectory('kite-pdf-text-contract-'),
    workspace = join(root, 'workspace'),
    profilePath = join(root, 'profile');
  mkdirSync(workspace);
  mkdirSync(profilePath);
  const text = 'first\nWORKSPACE_TOKEN\nthird\n',
    path = join(profilePath, 'saved.txt');
  writeFileSync(join(workspace, 'note.txt'), text);
  writeFileSync(path, text);
  const files = createWorkspaceFiles({ root: workspace });
  const imported: InputFileImport = {
    id: 'saved-text',
    sessionId: 'session',
    subjectId: 'owner',
    originStoreId: 'store',
    name: 'saved.txt',
    uri: pathToFileURL(path).href,
    state: 'bound',
    boundCommandId: 'original',
    createdAt: 1,
    reference: {
      id: 'original-text',
      storeId: 'store',
      sessionId: 'session',
      subjectId: 'owner',
      scope: { kind: 'session', id: 'session' },
      hash: createHash('sha256').update(text).digest('hex'),
      size: String(Buffer.byteLength(text)),
      mediaType: 'text/plain',
    },
  };
  const adapter = withInputFileReads({
    profilePath,
    tools: createFileTools(files),
    async resolve(request, uri) {
      return request.sessionId === imported.sessionId && uri === imported.uri ? imported : null;
    },
  });
  const read = adapter.tools.find((tool) => tool.id === 'files.read')!;
  const context = {
    sessionId: 'session',
    executionId: 'read-text',
    signal: new AbortController().signal,
  } as ToolContext;
  try {
    const ordinary = await read.execute({ path: 'note.txt', offset: 2, limit: 1 }, context);
    expect(ordinary.outcome).toBe('succeeded');
    expect(ordinary.content).toContain('WORKSPACE_TOKEN');
    expect(ordinary.content).not.toContain('first');
    const props = read.inputSchema.properties as Record<string, Json>;
    expect(props.pages).toBeUndefined();
    expect(props.mode).toBeUndefined();
    writeFileSync(join(workspace, 'table.csv'), 'private,CANARY');
    writeFileSync(join(workspace, 'renamed.ts'), simplePdf());
    const prefixed = Buffer.concat([Buffer.from('\r\n'), simplePdf()]);
    writeFileSync(join(workspace, 'prefixed.ts'), prefixed);
    expect((await readPdf(prefixed, { mode: 'text' }, context.signal)).pages[0]!.text).toBe(
      'Hello PDF',
    );
    writeFileSync(join(workspace, 'pdf-example.ts'), 'export const header = "%PDF-1.7";\n');
    expect(await read.execute({ path: 'pdf-example.ts' }, context)).toMatchObject({
      outcome: 'succeeded',
      content: expect.stringContaining('%PDF-1.7'),
    });
    for (const [name, hint] of [
      ['table.csv', 'exec_command'],
      ['renamed.ts', 'pdf-text'],
      ['prefixed.ts', 'pdf-text'],
    ]) {
      const refused = await read.execute({ path: name! }, context);
      expect(refused).toMatchObject({
        outcome: 'failed',
        details: { code: 'unsupported_file_type' },
      });
      expect(refused.content).toContain(hint!);
      expect(refused.content).not.toContain('private,CANARY');
      expect(refused.modelImages).toBeUndefined();
    }
    const request: AuthorizationRequest = {
      kind: 'tool',
      definitionId: 'files.read',
      definitionVersion: '5',
      sessionId: 'session',
      runId: 'run',
      executionId: 'read-text',
      signal: context.signal,
      input: { path },
    };
    const capability = await adapter.describeRequest(request);
    const saved = await read.execute(request.input, {
      ...context,
      dispatchAuthorization: {
        revision: 'saved-text-read',
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: { capability: capability as unknown as Json },
        },
      },
    });
    expect(saved.outcome).toBe('succeeded');
    expect(saved.content).toContain('WORKSPACE_TOKEN');
    const foreign = await read.execute({ path }, { ...context, sessionId: 'other' });
    expect(foreign).toMatchObject({ outcome: 'failed', content: 'input_file_scope_denied' });
    writeFileSync(path, 'changed saved attachment');
    const changed = await read.execute(
      { path },
      {
        ...context,
        dispatchAuthorization: {
          revision: 'saved-text-read',
          snapshot: {
            namespace: 'builtin.permissions',
            version: '1',
            data: { capability: capability as unknown as Json },
          },
        },
      },
    );
    expect(changed).toMatchObject({ outcome: 'failed', content: 'artifact_content_mismatch' });
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a saved PDF read refuses cleanly while the Shell helper delivers text and the selected PNG', async () => {
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
  const adapter = withInputFileReads({
    profilePath,
    tools: createFileTools(files),
    async resolve(request, uri) {
      return request.sessionId === imported.sessionId && uri === imported.uri ? imported : null;
    },
  });
  const signal = new AbortController().signal;
  const request: AuthorizationRequest = {
    kind: 'tool',
    definitionId: 'files.read',
    definitionVersion: '5',
    sessionId: 'session',
    runId: 'original-run',
    executionId: 'read-layout',
    signal,
    input: { path },
  };
  const capability = await adapter.describeRequest(request);
  expect(capability?.hardAllowed).toBe(true);
  const tool = adapter.tools.find(({ id }) => id === 'files.read')!;
  const context = {
    ...request,
    dispatchAuthorization: {
      revision: 'accepted-layout-read',
      snapshot: {
        namespace: 'builtin.permissions',
        version: '1',
        data: { capability },
      },
    },
  } as unknown as ToolContext;
  try {
    const refused = await tool.execute({ path }, context);
    expect(refused).toMatchObject({
      outcome: 'failed',
      details: { code: 'unsupported_file_type' },
    });
    expect(refused.content).toContain('pdf-text');
    expect(refused.content).toContain('workspace copy');
    expect(refused.artifactRefs).toBeUndefined();
    expect(refused.modelImages).toBeUndefined();
    const body = JSON.parse(
      JSON.stringify(await readPdfForShell({ input: path, mode: 'text', pages: '1', signal })),
    );
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
    const textFile = join(profilePath, 'selected.json');
    const saved = await readPdfForShell({ input: path, mode: 'text', out: textFile, signal });
    expect(saved).toMatchObject({ outputPath: textFile });
    expect(JSON.parse(readFileSync(textFile, 'utf8'))).toEqual(body);
    await expect(
      readPdfForShell({ input: path, mode: 'text', out: textFile, signal }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    const image = await readPdfForShell({
      input: path,
      mode: 'image',
      pages: '1',
      out: profilePath,
      signal,
    });
    const page = image.pages[0]!;
    if (!('path' in page)) throw Error('rendered page missing');
    expect({ number: page.number, label: page.label }).toEqual({ number: 1, label: null });
    const png = readFileSync(page.path);
    const decoded = await loadImage(Buffer.from(png));
    expect([decoded.width, decoded.height]).toEqual([918, 1188]);
    const canvas = createCanvas(decoded.width, decoded.height);
    const canvasContext = canvas.getContext('2d');
    canvasContext.drawImage(decoded, 0, 0);
    expect([...canvasContext.getImageData(80, 360, 1, 1).data]).toEqual([204, 230, 255, 255]);
    // Visible table rules remain in the image although text extraction returns no grid.
    expect(canvasContext.getImageData(100, 408, 1, 1).data[0]).toBeLessThan(100);
    expect(canvasContext.getImageData(450, 440, 1, 1).data[0]).toBeLessThan(100);
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
