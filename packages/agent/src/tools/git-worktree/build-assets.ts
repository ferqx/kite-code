import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/git-worktree');
mkdirSync(destination, { recursive: true });
const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'worker.ts')],
  outdir: destination,
  target: 'bun',
  packages: 'bundle',
  naming: 'worker.js',
});
if (!built.success) throw new Error('git_worktree_worker_build_failed');
copyFileSync(
  resolve(import.meta.dir, 'empty-bunfig.toml'),
  resolve(destination, 'empty-bunfig.toml'),
);
mkdirSync(resolve(destination, 'empty-hooks'), { recursive: true });
if (readdirSync(resolve(destination, 'empty-hooks')).length)
  throw new Error('git_worktree_hooks_asset_not_empty');
const files = Object.fromEntries(
  ['worker.js', 'empty-bunfig.toml'].map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(resolve(destination, name)))
      .digest('hex'),
  ]),
);
writeFileSync(
  resolve(destination, 'manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, files, emptyHooks: 'empty-hooks' }, null, 2)}\n`,
);
