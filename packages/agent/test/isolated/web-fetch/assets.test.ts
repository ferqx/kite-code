import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteStorageAssets } from '@kite-ai/agent/sqlite';
import { type createPassiveWebExtractor, webExtractorAsset } from '@kite-ai/agent/web-fetch';

test('formal built public entry selects package Worker asset/hash; source path has no parser fallback and mismatching captured identity fails', async () => {
  const path = webExtractorAsset();
  expect(path.endsWith('/dist/tools/web-fetch/extractor-worker.js')).toBe(true);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  expect(readFileSync(path.replace('.js', '.sha256'), 'utf8').trim()).toBe(hash);
  const built = await import(resolve(import.meta.dir, '../../../dist/tools/web-fetch/index.js'));
  expect(built.webExtractorAsset()).toBe(path);
  const storage = sqliteStorageAssets();
  expect(storage.preload.pathname.endsWith('/storage/worker/observer-preload.ts')).toBe(true);
  expect(storage.observerModules.map((module) => module.pathname)).toEqual([
    new URL('../../../src/platform/process/owned-worker.ts', import.meta.url).pathname,
    new URL('../../../src/platform/process/worker-thread.darwin.ts', import.meta.url).pathname,
  ]);
  const builtStorage = await import(resolve(import.meta.dir, '../../../dist/sqlite.js'));
  const actualBuiltAssets = builtStorage.sqliteStorageAssets();
  expect(built.webExtractorAssets().preload).toBe(fileURLToPath(actualBuiltAssets.preload));
  expect(actualBuiltAssets.preload.pathname.endsWith('/storage/worker/observer-preload.js')).toBe(
    true,
  );
  for (const module of [actualBuiltAssets.preload, ...actualBuiltAssets.observerModules]) {
    expect(existsSync(module)).toBe(true);
    expect(module.pathname.endsWith('.js')).toBe(true);
  }
  const extractor = built.createPassiveWebExtractor() as ReturnType<
    typeof createPassiveWebExtractor
  >;
  expect(await extractor.prepare!()).toEqual({ hash });
  const result = await extractor.extract(
    {
      html: '<article><p>Complete passive worker content.</p></article>',
      url: 'https://no-network.invalid/',
    },
    { signal: new AbortController().signal, expectedAssetHash: hash },
  );
  expect(result.content).toContain('Complete passive worker content.');
  let code: unknown;
  try {
    await extractor.extract(
      { html: '<p>never parsed</p>', url: 'https://no-network.invalid/' },
      { signal: new AbortController().signal, expectedAssetHash: '0'.repeat(64) },
    );
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe('web_parser_unavailable');
});
