import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { windowsDesktopModulePlugin } from '../../../scripts/windows-desktop-bundling';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/web-fetch');
mkdirSync(destination, { recursive: true });
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'extractor-worker.ts')],
  outdir: destination,
  target: 'bun',
  packages: 'bundle',
  // jsdom owns runtime CSS/DOM assets. Readability and Turndown/Domino are pure JS.
  external: ['jsdom'],
  plugins: process.argv[3] === '--windows-desktop' ? [windowsDesktopModulePlugin(['jsdom'])] : [],
  naming: 'extractor-worker.js',
});
if (!build.success) throw new Error('web_parser_build_failed');
const hash = createHash('sha256')
  .update(readFileSync(resolve(destination, 'extractor-worker.js')))
  .digest('hex');
writeFileSync(resolve(destination, 'extractor-worker.sha256'), `${hash}\n`);
