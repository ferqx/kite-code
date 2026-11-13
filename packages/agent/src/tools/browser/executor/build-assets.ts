import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as bundle } from '../../../../../../scripts/tooling/bun-build';
import { runtimeBuildOptions } from '../../../../scripts/runtime-build-options';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/browser/executor');
mkdirSync(destination, { recursive: true });
const built = await bundle({
  entrypoints: [resolve(import.meta.dirname, 'worker.ts')],
  ...runtimeBuildOptions(destination),
  outdir: destination,
  naming: 'worker.mjs',
});
if (!built.success) throw Error('browser_executor_asset_build_failed');
