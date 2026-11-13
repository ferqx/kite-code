import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as bundle } from '../../../../../scripts/tooling/bun-build';
import { desktopModulePlugin } from '../../../scripts/desktop-bundling';
import { runtimeBuildOptions } from '../../../scripts/runtime-build-options';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/documents');
const desktop = process.argv[3] === '--desktop';
const runtime = runtimeBuildOptions(destination);
mkdirSync(destination, { recursive: true });
const result = await bundle({
  entrypoints: [resolve(import.meta.dirname, 'pdf-worker.ts')],
  outdir: destination,
  ...runtime,
  packages: 'bundle',
  external: ['pdfjs-dist'],
  ...(desktop ? { define: { ...runtime.define, __KITE_DESKTOP_ASSETS__: 'true' } } : {}),
  plugins: desktop ? [desktopModulePlugin(['pdfjs-dist/legacy/build/pdf.mjs'])] : [],
  naming: 'pdf-worker.js',
});
if (!result.success) throw new Error('pdf_worker_build_failed');
writeFileSync(
  resolve(destination, 'pdf-worker.sha256'),
  createHash('sha256')
    .update(readFileSync(resolve(destination, 'pdf-worker.js')))
    .digest('hex') + '\n',
);
