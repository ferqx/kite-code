import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDirectory } from '../../maintenance/files';
import { createOwnedWorker } from '../../platform/process/owned-worker';
import { AgentError } from '../../storage/types';
import { createWorkspaceFiles } from '../files';

export interface PdfPage {
  number: number;
  label: string | null;
  text: string;
  image?: Uint8Array;
}
export interface PdfResult {
  totalPages: number;
  pages: PdfPage[];
  nextPage: number | null;
}
export const pdfRecipe = 'pdfjs-6.4.299-layout-1-render-2048-1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Disposable derivative, never a grant to read the source or a historical result. */
export async function readCachedPdf(
  bytes: Uint8Array,
  input: { pages?: string; mode?: string },
  scope: { profilePath: string; storeId: string; sourceHash: string },
  signal: AbortSignal,
): Promise<PdfResult> {
  const checksum = (await readFile(pdfAssets().checksum, 'utf8')).trim();
  const recipe = JSON.stringify({
    version: pdfRecipe,
    worker: checksum,
    pages: input.pages ?? '1',
    mode: input.mode ?? 'text',
  });
  const root = join(
    scope.profilePath,
    'cache',
    'documents',
    hash(scope.storeId),
    scope.sourceHash,
    hash(recipe),
  );
  privateDirectory(root, true);
  const files = createWorkspaceFiles({ root, strictReads: true, maxFileBytes: 32 * 1024 * 1024 });
  let prior: import('../files').FileBaseline | null = null;
  try {
    try {
      signal.throwIfAborted();
      const cached = await files.readBytes('result.json', { maxBytes: 32 * 1024 * 1024 });
      prior = cached.baseline;
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cached.bytes));
      if (
        envelope.sourceHash === scope.sourceHash &&
        envelope.recipe === recipe &&
        typeof envelope.body === 'string' &&
        envelope.hash === hash(envelope.body)
      ) {
        const parsed = JSON.parse(envelope.body);
        const result = decodeCachedResult(parsed, input);
        if (result) return result;
      }
    } catch (error) {
      if (
        (error as { code?: string }).code !== 'ENOENT' &&
        !(error instanceof SyntaxError) &&
        !(error instanceof TypeError)
      )
        throw error;
    }
    const result = await readPdf(bytes, input, signal);
    const body = JSON.stringify({
      ...result,
      pages: result.pages.map((page) => ({
        ...page,
        ...(page.image ? { image: Buffer.from(page.image).toString('base64') } : {}),
      })),
    });
    signal.throwIfAborted();
    try {
      await files.restore({
        path: 'result.json',
        base: prior,
        bytes: Buffer.from(
          JSON.stringify({ sourceHash: scope.sourceHash, recipe, hash: hash(body), body }),
        ),
        maxBytes: 32 * 1024 * 1024,
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'file_baseline_conflict') throw error;
    }
    return result;
  } finally {
    await files.close();
  }
}
function decodeCachedResult(
  value: unknown,
  input: { pages?: string; mode?: string },
): PdfResult | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as PdfResult;
  const match = /^(\d+)(?:-(\d+))?$/.exec(input.pages ?? '1');
  const start = Number(match?.[1]),
    end = Number(match?.[2] ?? match?.[1]);
  const mode = input.mode ?? 'text';
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    !['text', 'image'].includes(mode) ||
    end - start >= (mode === 'image' ? 4 : 20) ||
    !Number.isSafeInteger(data.totalPages) ||
    data.totalPages < start ||
    !Array.isArray(data.pages) ||
    data.pages.length !== Math.min(end, data.totalPages) - start + 1 ||
    data.nextPage !== (end < data.totalPages ? end + 1 : null)
  )
    return null;
  const pages: PdfPage[] = [];
  let size = 0;
  for (const [index, candidate] of data.pages.entries()) {
    if (
      !candidate ||
      candidate.number !== start + index ||
      (candidate.label !== null && typeof candidate.label !== 'string') ||
      typeof candidate.text !== 'string'
    )
      return null;
    const page: PdfPage = {
      number: candidate.number,
      label: candidate.label,
      text: candidate.text,
    };
    size += Buffer.byteLength(page.text);
    if (mode === 'image') {
      if (typeof candidate.image !== 'string') return null;
      const image = Buffer.from(candidate.image, 'base64');
      if (
        image.toString('base64') !== candidate.image ||
        image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        return null;
      page.image = image;
      size += image.byteLength;
    } else if (candidate.image !== undefined) return null;
    if (size > 16 * 1024 * 1024) return null;
    pages.push(page);
  }
  return { totalPages: data.totalPages, nextPage: data.nextPage, pages };
}
export function pdfAssets() {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.js')
        ? './tools/documents/pdf-worker.js'
        : '../../../dist/tools/documents/pdf-worker.js',
      import.meta.url,
    ),
  );
  const require = createRequire(import.meta.url);
  const parser = require.resolve('pdfjs-dist/package.json');
  const canvas = require.resolve('@napi-rs/canvas/package.json');
  const canvasRequire = createRequire(canvas);
  const dependencies = [dirname(parser), dirname(canvas)];
  for (const name of Object.keys(canvasRequire(canvas).optionalDependencies ?? {})) {
    try {
      dependencies.push(dirname(canvasRequire.resolve(`${name}/package.json`)));
    } catch {
      /* Other platforms' optional native assets are not installed. */
    }
  }
  return { worker, checksum: worker.replace(/\.js$/, '.sha256'), dependencies };
}
let active = 0;
const waiters = new Set<() => void>();
async function acquire(signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    if (active < 2) {
      active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        waiters.delete(wake);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(wake);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
/** Finite per-request worker lifetime; no PDF parser runs on the Service event loop. */
export async function readPdf(
  bytes: Uint8Array,
  input: { pages?: string; mode?: string },
  signal: AbortSignal,
): Promise<PdfResult> {
  const mode = input.mode ?? 'text';
  const match = /^(\d+)(?:-(\d+))?$/.exec(input.pages ?? '1');
  const start = Number(match?.[1]),
    end = Number(match?.[2] ?? match?.[1]);
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    start < 1 ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end - start >= (mode === 'image' ? 4 : 20) ||
    !['text', 'image'].includes(mode)
  )
    throw new AgentError('pdf_range_invalid');
  if (
    bytes.byteLength > 256 * 1024 * 1024 ||
    Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0
  )
    throw new AgentError('pdf_invalid');
  await acquire(signal);
  let owned: ReturnType<typeof createOwnedWorker> | undefined;
  let closed = false;
  try {
    const asset = pdfAssets();
    const expected = (await readFile(asset.checksum, 'utf8')).trim();
    const hash = createHash('sha256')
      .update(await readFile(asset.worker))
      .digest('hex');
    if (!/^[a-f0-9]{64}$/.test(expected) || hash !== expected)
      throw new AgentError('pdf_assets_invalid');
    signal.throwIfAborted();
    owned = createOwnedWorker(asset.worker);
    const worker = owned.worker;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    return await new Promise<PdfResult>((resolve, reject) => {
      const finish = (error?: unknown, result?: PdfResult) => {
        requestSignal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result!);
      };
      const abort = () => finish(requestSignal.reason);
      requestSignal.addEventListener('abort', abort, { once: true });
      worker.onerror = (event) =>
        finish(Object.assign(new AgentError('pdf_worker_failed'), { cause: event.message }));
      worker.onmessage = (event: MessageEvent<PdfResult & { error?: string }>) =>
        event.data.error ? finish(new AgentError(event.data.error)) : finish(undefined, event.data);
      if (requestSignal.aborted) abort();
      else
        worker.postMessage({ bytes: Uint8Array.from(bytes), start, count: end - start + 1, mode });
    });
  } finally {
    // Never release a parser slot while its original worker may still be live.
    if (owned) {
      await owned.terminate();
      closed = true;
    }
    if (!owned || closed) {
      active--;
      for (const wake of waiters) wake();
    }
  }
}
