import type { AssetManifest, TrustedAsset } from './assets';

export type { AssetManifest, TrustedAsset } from './assets';
/** Implemented by the build's source-independent dist/assets.js. */
export declare const assetManifest: AssetManifest;
export declare function getTrustedAssets(): ReadonlyMap<string, TrustedAsset>;
