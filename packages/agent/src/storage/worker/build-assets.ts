import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from '../../../../../scripts/tooling/bun-build';
import { runtimeBuildOptions } from '../../../scripts/runtime-build-options';
/** Package build companion: a standalone Worker bundle and reviewed migration assets. */
export async function buildStorageAssets(outdir: string): Promise<void> {
  const workerDirectory = join(resolve(outdir), 'storage', 'worker');
  const migrations = join(resolve(outdir), 'storage', 'migrations');
  const runtime = runtimeBuildOptions(workerDirectory, resolve(outdir));
  mkdirSync(workerDirectory, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  const result = await bundle({
    entrypoints: [
      fileURLToPath(new URL('./main.ts', import.meta.url)),
      fileURLToPath(new URL('./observer-preload.ts', import.meta.url)),
    ],
    outdir: workerDirectory,
    ...runtime,
    packages: 'bundle',
  });
  if (!result.success) throw new AggregateError(result.logs, 'Storage Worker build failed.');
  for (const name of ['0001-baseline.sql', '0002-trajectory-facts.sql'])
    copyFileSync(new URL(`../migrations/${name}`, import.meta.url), join(migrations, name));
}
if (import.meta.main)
  await buildStorageAssets(
    process.argv[2] ?? fileURLToPath(new URL('../../../dist', import.meta.url)),
  );
