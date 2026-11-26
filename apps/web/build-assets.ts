import { join } from 'node:path';
import { createTrustedAssets } from './src/assets';

/** The development launcher and packaged terminal use the same production browser build. */
export async function buildWebAssets(repository = join(import.meta.dir, '../..')) {
  const build = await Bun.build({
    entrypoints: [join(repository, 'apps/web/src/browser.tsx')],
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!build.success) throw new AggregateError(build.logs, 'web_bundle_failed');
  const entry = build.outputs[0];
  if (build.outputs.length !== 1 || entry?.kind !== 'entry-point')
    throw Error('unexpected_web_outputs');
  return createTrustedAssets(await entry.text());
}
