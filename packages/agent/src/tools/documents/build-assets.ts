import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopModulePlugin } from '../../../scripts/desktop-bundling';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/documents');
const desktop = process.argv[3] === '--desktop';
mkdirSync(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'pdf-worker.ts')],
  outdir: destination,
  target: 'bun',
  packages: 'bundle',
  external: ['pdfjs-dist'],
  define: desktop ? { __KITE_DESKTOP_ASSETS__: 'true' } : {},
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
