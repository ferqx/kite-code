import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KITE_SESSION_STORE_FORMAT_EPOCH } from '../../../packages/runtime-storage-sqlite/src/kite-session-store-format';

const root = resolve(import.meta.dir, '..');
// Pin the verified candidate identity into the host, never trust a replaced runtime manifest.
const serviceManifest = JSON.parse(readFileSync(resolve(root, 'service/desktop.json'), 'utf8'));
const sourceStoreEpoch = KITE_SESSION_STORE_FORMAT_EPOCH;
if (!/^kite-session-[A-Za-z0-9._-]{1,128}$/u.test(sourceStoreEpoch)) {
  throw new Error('Current source Store format epoch is invalid.');
}
// Sandboxed Electron preloads use CommonJS; bundle local imports into one file.
for (const entry of ['main', 'preload']) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `electron/${entry}.ts`)],
    outdir: resolve(root, 'dist-electron'),
    naming: `${entry}.cjs`,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    define: {
      __KITE_DESKTOP_SERVICE_MANIFEST__: JSON.stringify(serviceManifest),
      __KITE_DESKTOP_SOURCE_STORE_EPOCH__: JSON.stringify(sourceStoreEpoch),
    },
    sourcemap: 'external',
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build Electron ${entry}.`);
}
