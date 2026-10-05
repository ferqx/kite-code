import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
/** Package build companion: a standalone Worker bundle and reviewed migration assets. */
export async function buildStorageAssets(outdir: string): Promise<void> {
  const workerDirectory = join(resolve(outdir), 'storage', 'worker');
  const migrations = join(resolve(outdir), 'storage', 'migrations');
  mkdirSync(workerDirectory, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  const result = await Bun.build({
    entrypoints: [new URL('./main.ts', import.meta.url).pathname],
    outdir: workerDirectory,
    target: 'bun',
    packages: 'bundle',
  });
  if (!result.success) throw new AggregateError(result.logs, 'Storage Worker build failed.');
  copyFileSync(
    new URL('../migrations/0001-baseline.sql', import.meta.url),
    join(migrations, '0001-baseline.sql'),
  );
}
if (import.meta.main)
  await buildStorageAssets(process.argv[2] ?? new URL('../../../dist', import.meta.url).pathname);
