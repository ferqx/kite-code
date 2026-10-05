import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? 'dist', 'tools/web-fetch');
mkdirSync(destination, { recursive: true });
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'extractor-worker.ts')],
  outdir: destination,
  target: 'bun',
  packages: 'external',
  naming: 'extractor-worker.js',
});
if (!build.success) throw new Error('web_parser_build_failed');
const hash = createHash('sha256')
  .update(readFileSync(resolve(destination, 'extractor-worker.js')))
  .digest('hex');
writeFileSync(resolve(destination, 'extractor-worker.sha256'), `${hash}\n`);
