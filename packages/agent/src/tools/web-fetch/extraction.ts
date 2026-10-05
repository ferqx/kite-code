import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebFetchError } from './network';

export interface WebExtractor {
  prepare?(): Promise<{ hash: string }>;
  extract(
    input: { html: string; url: string },
    options: { signal: AbortSignal; expectedAssetHash?: string },
  ): Promise<{ title: string; content: string }>;
}
/** Source entrypoints select the built package asset, never the TypeScript parser source. */
export function webExtractorAsset(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith('.js')
        ? './extractor-worker.js'
        : '../../../dist/tools/web-fetch/extractor-worker.js',
      import.meta.url,
    ),
  );
}
/** Exact worker/checksum loader selections, including trusted custom worker paths; pure metadata. */
export function webExtractorAssets(worker = webExtractorAsset()) {
  return Object.freeze({ worker, checksum: worker.replace(/\.js$/, '.sha256') });
}
/** Explicit parser asset identity, no worker/DOM/network at import or factory time. */
export function createPassiveWebExtractor(
  options: { workerPath?: string; expectedHash?: string } = {},
): WebExtractor {
  const workerPath = options.workerPath;
  async function asset() {
    const path = workerPath ?? webExtractorAsset();
    if (!path || !isAbsolute(path) || !existsSync(path))
      throw new WebFetchError('web_parser_unavailable');
    try {
      const bytes = await readFile(path);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      const expected =
        options.expectedHash ?? (await readFile(webExtractorAssets(path).checksum, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(expected) || hash !== expected)
        throw new WebFetchError('web_parser_unavailable');
      return { path, hash };
    } catch {
      throw new WebFetchError('web_parser_unavailable');
    }
  }
  return {
    async prepare() {
      return { hash: (await asset()).hash };
    },
    async extract(input, { signal, expectedAssetHash }) {
      signal.throwIfAborted();
      const { path, hash } = await asset();
      if (expectedAssetHash !== undefined && expectedAssetHash !== hash)
        throw new WebFetchError('web_parser_unavailable');
      signal.throwIfAborted();
      const worker = new Worker(path);
      let removeAbort: (() => void) | undefined;
      try {
        return await new Promise((resolve, reject) => {
          const abort = () => {
            worker.terminate();
            reject(signal.reason ?? new WebFetchError('web_cancelled'));
          };
          signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', abort);
          worker.onmessage = (
            event: MessageEvent<{ title?: string; content?: string; error?: string }>,
          ) => {
            signal.removeEventListener('abort', abort);
            if (event.data.error || typeof event.data.content !== 'string')
              reject(new WebFetchError('web_content_unavailable'));
            else resolve({ title: event.data.title ?? '', content: event.data.content });
          };
          worker.onerror = () => {
            signal.removeEventListener('abort', abort);
            reject(new WebFetchError('web_parser_unavailable'));
          };
          if (signal.aborted) abort();
          else worker.postMessage(structuredClone(input));
        });
      } finally {
        removeAbort?.();
        worker.terminate();
      }
    },
  };
}
