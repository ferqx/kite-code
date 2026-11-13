import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export interface OtelAdapterAssets {
  directory: string;
  manifestSha256: string;
}
export const otelAdapterAssetNames = ['runner.js'] as const;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function verifyOtelAdapterAssets(assets: OtelAdapterAssets): string {
  const names = otelAdapterAssetNames;
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
