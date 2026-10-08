import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [output] = process.argv.slice(2);
if (!output?.startsWith('--outdir=') || process.argv.slice(2).length !== 1)
  throw Error('usage_build_desktop_outdir');
const outdir = resolve(output.slice('--outdir='.length));
const source = resolve(import.meta.dir, '../src/desktop');
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(source, 'index.ts')],
  target: 'browser',
  packages: 'external',
  outdir,
});
if (!result.success) throw new AggregateError(result.logs, 'desktop_ui_build_failed');
await copyFile(join(source, 'style.css'), join(outdir, 'style.css'));
