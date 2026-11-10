import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OtelAdapterAssets {
  directory: string;
  manifestSha256: string;
}
const names = ['runner.js', 'empty-bunfig.toml', 'empty-tsconfig.json'] as const;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function buildOtelAdapterAssets(directory: string): Promise<OtelAdapterAssets> {
  mkdirSync(directory, { recursive: true });
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./runner.ts', import.meta.url))],
    outdir: directory,
    target: 'bun',
    packages: 'bundle',
    naming: 'runner.js',
  });
  if (!build.success) throw new AggregateError(build.logs, 'otel_adapter_build_failed');
  writeFileSync(join(directory, 'empty-bunfig.toml'), '');
  writeFileSync(join(directory, 'empty-tsconfig.json'), '{}');
  const manifest = {
    schema: 'kite.otel-adapter-assets',
    version: 1,
    files: names.map((name) => {
      const bytes = readFileSync(join(directory, name));
      return { name, size: bytes.byteLength, sha256: hash(bytes) };
    }),
  };
  const bytes = JSON.stringify(manifest);
  writeFileSync(join(directory, 'manifest.json'), bytes);
  return { directory: realpathSync.native(directory), manifestSha256: hash(bytes) };
}
export function verifyOtelAdapterAssets(assets: OtelAdapterAssets): string {
  const root = realpathSync.native(assets.directory),
    bytes = readFileSync(join(root, 'manifest.json'));
  if (hash(bytes) !== assets.manifestSha256) throw Error('otel_assets_changed');
  const manifest = JSON.parse(bytes.toString()) as {
    schema: string;
    version: number;
    files: { name: string; size: number; sha256: string }[];
  };
  if (
    manifest.schema !== 'kite.otel-adapter-assets' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== names.length ||
    new Set(manifest.files.map((item) => item.name)).size !== names.length
  )
    throw Error('otel_assets_invalid');
  for (const item of manifest.files) {
    if (!names.includes(item.name as (typeof names)[number])) throw Error('otel_assets_invalid');
    const path = join(root, item.name),
      file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      realpathSync.native(path) !== path ||
      file.size !== item.size ||
      hash(readFileSync(path)) !== item.sha256
    )
      throw Error('otel_assets_changed');
  }
  return root;
}
