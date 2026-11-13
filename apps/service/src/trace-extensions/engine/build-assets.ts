import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from '../../../../../scripts/tooling/bun-build';
import { engineAssetNames, engineDigest, type TraceEngineAssets } from './assets';

/** Explicit Service build leaf. The emitted runner bundles its JS dependency closure. */
export async function buildTraceEngineAssets(directory: string): Promise<TraceEngineAssets> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = await bundle({
    entrypoints: [fileURLToPath(new URL('./runner.ts', import.meta.url))],
    outdir: directory,
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    minify: false,
    naming: 'runner.js',
  });
  if (!result.success) throw new AggregateError(result.logs, 'trace_engine_build_failed');
  copyFileSync(
    fileURLToPath(import.meta.resolve('@jitl/quickjs-wasmfile-release-sync/wasm')),
    join(directory, 'quickjs.wasm'),
  );
  const manifest = JSON.stringify({
    schema: 'kite.trace-engine-assets',
    version: 1,
    quickjsVersion: '0.32.0',
    files: engineAssetNames.map((name) => {
      const bytes = readFileSync(join(directory, name));
      return { name, bytes: bytes.byteLength, sha256: engineDigest(bytes) };
    }),
  });
  writeFileSync(join(directory, 'manifest.json'), manifest);
  return { directory, manifestSha256: engineDigest(manifest) };
}
if (import.meta.main)
  await buildTraceEngineAssets(join(process.argv[2] ?? 'dist', 'trace-extensions/engine/runtime'));
