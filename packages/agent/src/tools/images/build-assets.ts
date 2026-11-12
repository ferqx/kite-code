import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopModulePlugin } from '../../../scripts/desktop-bundling';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/images');
mkdirSync(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'child.ts')],
  outdir: destination,
  target: 'bun',
  packages: 'bundle',
  external: ['sharp'],
  plugins: process.argv[3] === '--desktop' ? [desktopModulePlugin(['sharp'])] : [],
  naming: 'image-child.js',
});
if (!result.success) throw new Error('image_child_build_failed');
writeFileSync(
  resolve(destination, 'image-child.sha256'),
  `${createHash('sha256')
    .update(readFileSync(resolve(destination, 'image-child.js')))
    .digest('hex')}\n`,
);
