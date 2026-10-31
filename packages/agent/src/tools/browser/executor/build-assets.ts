import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/browser/executor');
mkdirSync(destination, { recursive: true });
const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'worker.ts')],
  target: 'bun',
  outdir: destination,
  naming: 'worker.js',
});
if (!built.success) throw Error('browser_executor_asset_build_failed');
