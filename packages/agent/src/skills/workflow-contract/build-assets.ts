import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function buildWorkflowCompilerAssets(outdir: string) {
  const target = join(resolve(outdir), 'skills', 'workflow-contract');
  await mkdir(target, { recursive: true });
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
    outdir: target,
    target: 'bun',
    packages: 'bundle',
  });
  if (!result.success)
    throw new AggregateError(result.logs, 'Workflow compiler Worker build failed.');
  const bytes = await readFile(join(target, 'worker.js'));
  await writeFile(
    join(target, 'worker.sha256'),
    Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex') + '\n',
  );
}
if (import.meta.main)
  await buildWorkflowCompilerAssets(
    process.argv[2] ?? fileURLToPath(new URL('../../../dist', import.meta.url)),
  );
