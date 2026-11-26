import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWebAssets } from './build-assets';

const { assets, manifest } = await buildWebAssets();
const destination = join(import.meta.dir, 'dist');
await mkdir(destination, { recursive: true });
for (const [path, asset] of assets)
  await Bun.write(join(destination, path.slice(1)), asset.content);
await Bun.write(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
await Bun.write(
  join(destination, 'assets.js'),
  `const entries=${JSON.stringify([...assets])};\nexport const assetManifest=Object.freeze(${JSON.stringify(manifest)}.map(Object.freeze));\nexport function getTrustedAssets(){return new Map(entries.map(([path,asset])=>[path,Object.freeze({...asset})]));}\n`,
);
await Bun.write(
  join(destination, 'assets.d.ts'),
  'export interface TrustedAsset{readonly content:string;readonly mediaType:string}\nexport interface AssetManifestEntry{readonly path:string;readonly mediaType:string;readonly size:number;readonly sha256:string}\nexport declare const assetManifest:readonly AssetManifestEntry[];\nexport declare function getTrustedAssets():ReadonlyMap<string,TrustedAsset>;\n',
);
