import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
// Pin the verified candidate identity into the host, never trust a replaced runtime manifest.
const serviceManifest = JSON.parse(readFileSync(resolve(root, 'service/desktop.json'), 'utf8'));
// Sandboxed Electron preloads use CommonJS; bundle local imports into one file.
for (const entry of ['main', 'preload']) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `electron/${entry}.ts`)],
    outdir: resolve(root, 'dist-electron'),
    naming: `${entry}.cjs`,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    define: { __KITE_DESKTOP_SERVICE_MANIFEST__: JSON.stringify(serviceManifest) },
    sourcemap: 'external',
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build Electron ${entry}.`);
}
