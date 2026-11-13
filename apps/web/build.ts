import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build as bundle } from '../../scripts/tooling/bun-build';
import { createTrustedAssets } from './src/assets';

// This build host is outside browser source. Output paths are fixed, never browser inputs.
const build = await bundle({
  entrypoints: [join(import.meta.dirname, 'src/browser.tsx')],
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: false,
});
if (!build.success) throw new AggregateError(build.logs, 'web_bundle_failed');
const output = build.outputs.find((item) => item.kind === 'entry-point');
if (!output || build.outputs.length !== 1) throw new Error('unexpected_web_outputs');
const { assets, manifest } = await createTrustedAssets(await output.text());
const destination = join(import.meta.dirname, 'dist');
await mkdir(destination, { recursive: true });
for (const [path, asset] of assets)
  await writeFile(join(destination, path.slice(1)), asset.content);
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(
  join(destination, 'assets.js'),
  `const entries=${JSON.stringify([...assets])};\nexport const assetManifest=Object.freeze(${JSON.stringify(manifest)}.map(Object.freeze));\nexport function getTrustedAssets(){return new Map(entries.map(([path,asset])=>[path,Object.freeze({...asset})]));}\n`,
);
await writeFile(
  join(destination, 'assets.d.ts'),
  'export interface TrustedAsset{readonly content:string;readonly mediaType:string}\nexport interface AssetManifestEntry{readonly path:string;readonly mediaType:string;readonly size:number;readonly sha256:string}\nexport declare const assetManifest:readonly AssetManifestEntry[];\nexport declare function getTrustedAssets():ReadonlyMap<string,TrustedAsset>;\n',
);
