import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? 'dist', 'platform/process');
mkdirSync(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../platform/process/shell-supervisor.ts')],
  outdir: destination,
  target: 'bun',
  naming: 'shell-supervisor.js',
});
if (!result.success) throw new Error('shell_supervisor_build_failed');
