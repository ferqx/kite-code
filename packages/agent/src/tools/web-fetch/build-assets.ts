import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as bundle } from '../../../../../scripts/tooling/bun-build';
import { desktopModulePlugin } from '../../../scripts/desktop-bundling';
import { runtimeBuildOptions } from '../../../scripts/runtime-build-options';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/web-fetch');
mkdirSync(destination, { recursive: true });
const build = await bundle({
  entrypoints: [resolve(import.meta.dirname, 'extractor-worker.ts')],
  outdir: destination,
  ...runtimeBuildOptions(destination),
  packages: 'bundle',
  // jsdom owns runtime CSS/DOM assets. Readability and Turndown/Domino are pure JS.
  external: ['jsdom'],
  plugins: process.argv[3] === '--desktop' ? [desktopModulePlugin(['jsdom'])] : [],
  naming: 'extractor-worker.js',
});
if (!build.success) throw new Error('web_parser_build_failed');
const hash = createHash('sha256')
  .update(readFileSync(resolve(destination, 'extractor-worker.js')))
  .digest('hex');
writeFileSync(resolve(destination, 'extractor-worker.sha256'), `${hash}\n`);
