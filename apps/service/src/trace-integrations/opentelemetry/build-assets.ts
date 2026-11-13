import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { desktopModulePlugin } from '../../../../../packages/agent/scripts/desktop-bundling';
import {
  type BunBundleConfig,
  type BunPluginBuilder,
  build as bundle,
} from '../../../../../scripts/tooling/bun-build';
import { type OtelAdapterAssets, otelAdapterAssetNames } from './assets';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function buildOtelAdapterAssets(
  directory: string,
  plugins?: BunBundleConfig['plugins'],
): Promise<OtelAdapterAssets> {
  mkdirSync(directory, { recursive: true });
  const build = await bundle({
    entrypoints: [fileURLToPath(new URL('./runner.ts', import.meta.url))],
    outdir: directory,
    target: 'node',
    packages: 'bundle',
    plugins,
    // The packaged Node addon and SQLite engine are relative to the Agent package.
    external: ['@kite-ai/agent'],
    naming: 'runner.js',
  });
  if (!build.success) throw new AggregateError(build.logs, 'otel_adapter_build_failed');
  const bytes = JSON.stringify({
    schema: 'kite.otel-adapter-assets',
    version: 1,
    files: otelAdapterAssetNames.map((name) => {
      const bytes = readFileSync(join(directory, name));
      return { name, size: bytes.byteLength, sha256: hash(bytes) };
    }),
  });
  writeFileSync(join(directory, 'manifest.json'), bytes);
  return { directory: realpathSync.native(directory), manifestSha256: hash(bytes) };
}
const sqliteModules = ['@kite-ai/agent/sqlite-engine', '@kite-ai/agent/runtime-sqlite'];
export function checkoutOtelModulePlugin() {
  return {
    name: 'checkout-otel-sqlite',
    setup(build: BunPluginBuilder) {
      build.onResolve(
        { filter: /^@kite-ai\/agent\/(sqlite-engine|runtime-sqlite)$/ },
        ({ path }) => ({
          path: pathToFileURL(
            resolve(
              import.meta.dirname,
              '../../../../../packages/agent/dist',
              path.split('/').at(-1)! + '.js',
            ),
          ).href,
          external: true,
        }),
      );
    },
  };
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? 'dist');
  await buildOtelAdapterAssets(
    join(out, 'trace-integrations/opentelemetry/runtime'),
    process.argv[3] === '--desktop'
      ? [desktopModulePlugin(sqliteModules)]
      : out === resolve(import.meta.dirname, '../../../dist')
        ? [checkoutOtelModulePlugin()]
        : undefined,
  );
}
