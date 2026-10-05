import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type createPassiveWebExtractor, webExtractorAsset } from '@kite-ai/agent/web-fetch';

test('formal built public entry selects package Worker asset/hash; source path has no parser fallback and mismatching captured identity fails', async () => {
  const path = webExtractorAsset();
  expect(path.endsWith('/dist/tools/web-fetch/extractor-worker.js')).toBe(true);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  expect(readFileSync(path.replace('.js', '.sha256'), 'utf8').trim()).toBe(hash);
  const built = await import(resolve(import.meta.dir, '../../../dist/tools/web-fetch/index.js'));
  expect(built.webExtractorAsset()).toBe(path);
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
