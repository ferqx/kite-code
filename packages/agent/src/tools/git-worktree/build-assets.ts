import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as bundle } from '../../../../../scripts/tooling/bun-build';
import { runtimeBuildOptions } from '../../../scripts/runtime-build-options';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/git-worktree');
const runtime = runtimeBuildOptions(destination);
mkdirSync(destination, { recursive: true });
const built = await bundle({
  entrypoints: [resolve(import.meta.dirname, 'worker.ts')],
  outdir: destination,
  ...runtime,
  packages: 'bundle',
  naming: 'worker.js',
});
if (!built.success) throw new Error('git_worktree_worker_build_failed');
mkdirSync(resolve(destination, 'empty-hooks'), { recursive: true });
if (readdirSync(resolve(destination, 'empty-hooks')).length)
  throw new Error('git_worktree_hooks_asset_not_empty');
const files = {
  'worker.js': createHash('sha256')
    .update(readFileSync(resolve(destination, 'worker.js')))
    .digest('hex'),
};
writeFileSync(
  resolve(destination, 'manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, files, emptyHooks: 'empty-hooks' }, null, 2)}\n`,
);
