import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as bundle } from '../../../../../scripts/tooling/bun-build';
import { desktopModulePlugin } from '../../../scripts/desktop-bundling';
import { runtimeBuildOptions } from '../../../scripts/runtime-build-options';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/images');
mkdirSync(destination, { recursive: true });
const result = await bundle({
  entrypoints: [resolve(import.meta.dirname, 'child.ts')],
  outdir: destination,
  ...runtimeBuildOptions(destination),
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
