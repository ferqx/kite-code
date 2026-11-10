import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const engineAssetNames = [
  'runner.js',
  'quickjs.wasm',
  'empty-bunfig.toml',
  'empty-tsconfig.json',
] as const;
const assetManifestSchema = z.strictObject({
  schema: z.literal('kite.trace-engine-assets'),
  version: z.literal(1),
  quickjsVersion: z.literal('0.32.0'),
  files: z
    .array(
      z.strictObject({
        name: z.enum(engineAssetNames),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .length(4),
});
export type TraceEngineAssets = { directory: string; manifestSha256: string };
export const engineDigest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
/** Parent-provided authenticated asset manifest; no package lookup or project fallback at launch. */
export function verifyTraceEngineAssets(assets: TraceEngineAssets): void {
  const root = realpathSync.native(assets.directory);
  const manifestPath = join(root, 'manifest.json');
  const bytes = readFileSync(manifestPath);
  if (engineDigest(bytes) !== assets.manifestSha256) throw Error('trace_engine_assets_changed');
  const manifest = assetManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (new Set(manifest.files.map((file) => file.name)).size !== engineAssetNames.length)
    throw Error('trace_engine_assets_invalid');
  for (const file of manifest.files) {
    const path = join(root, file.name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      realpathSync.native(path) !== path ||
      stat.size !== file.bytes ||
      engineDigest(readFileSync(path)) !== file.sha256
    )
      throw Error('trace_engine_assets_changed');
  }
}
