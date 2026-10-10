import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? 'dist', 'mcp');
mkdirSync(destination, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, 'stdio-guardian.ts'),
    resolve(import.meta.dir, 'windows-stdio-guardian.ts'),
  ],
  outdir: destination,
  target: 'bun',
  naming: '[name].js',
});
if (!result.success) throw new Error('mcp_stdio_guardian_build_failed');
