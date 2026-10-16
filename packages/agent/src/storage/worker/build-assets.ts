import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Package build companion: a standalone Worker bundle and reviewed migration assets. */
export async function buildStorageAssets(outdir: string): Promise<void> {
  const workerDirectory = join(resolve(outdir), 'storage', 'worker');
  const migrations = join(resolve(outdir), 'storage', 'migrations');
  mkdirSync(workerDirectory, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL('./main.ts', import.meta.url)),
      fileURLToPath(new URL('./observer-preload.ts', import.meta.url)),
    ],
    outdir: workerDirectory,
    target: 'bun',
    packages: 'bundle',
  });
  if (!result.success) throw new AggregateError(result.logs, 'Storage Worker build failed.');
  for (const name of ['0001-baseline.sql', '0002-recovery-audit.sql'])
    copyFileSync(new URL(`../migrations/${name}`, import.meta.url), join(migrations, name));
}
if (import.meta.main)
  await buildStorageAssets(
    process.argv[2] ?? fileURLToPath(new URL('../../../dist', import.meta.url)),
  );
