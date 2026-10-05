export interface TrustedAsset {
  readonly content: string;
  readonly mediaType: string;
}
export interface AssetManifestEntry {
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}
export type AssetManifest = readonly AssetManifestEntry[];
export const assetPaths = ['/index.html', '/app.js', '/app.css'] as const;
const mediaTypes = [
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
];
export const documentHTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kite read-only observation</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div></body></html>';
export const documentCSS = `:root{font-family:system-ui,sans-serif;color-scheme:dark light}*{box-sizing:border-box}body{margin:0}button,a{font:inherit}button{cursor:pointer}a{color:inherit}button{padding:.45rem .65rem;border:1px solid #8886;border-radius:5px;background:transparent;color:inherit}.web-page{min-height:100vh;background:#181a20;color:#eef0f5}.web-page[data-theme=light]{background:#fafafa;color:#242630}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #8886;padding:1rem}.web-layout{display:grid;grid-template-columns:minmax(200px,280px) minmax(0,1fr)}nav{padding:1rem;border-right:1px solid #8886}nav ul{padding-left:1.2rem}nav li{margin:.5rem 0}main{padding:1.5rem;min-width:0}.conversation-header{display:flex;align-items:center;justify-content:space-between;gap:1rem}h1{font-size:1.5rem}h2{font-size:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;user-select:text}.history article{padding:.75rem 0;border-top:1px solid #8884}small{opacity:.7}a[aria-current=page]{font-weight:700}[role=alert]{color:#dc8857}@media(max-width:640px){.web-layout{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid #8886}main{padding:1rem}}`;
// Selection belongs to message bodies, and the history is an independent viewport.
export const readingCSS = `.web-page{height:100dvh;display:flex;flex-direction:column;user-select:none}.web-layout{flex:1;min-height:0}nav{overflow:auto}main{min-height:0;display:flex;flex-direction:column;overflow:auto}.history{overflow:auto;min-height:100px;flex:1;user-select:text;overscroll-behavior:contain}.diagnostic-panel{max-height:45vh;overflow:auto;border:1px solid #8886;padding:.5rem}.diagnostic-panel pre{user-select:text}.diagnostics,.model-inputs{flex-shrink:0}.model-input-panel{max-height:55vh;overflow:auto;border:1px solid #8886;padding:.5rem}.model-input-panel pre{user-select:text}.history summary{user-select:none;cursor:pointer}.message-markdown{padding:0;max-width:none;width:100%;overflow-wrap:anywhere}.message-markdown pre{overflow:auto;white-space:pre;max-width:100%;font-family:monospace}.message-markdown table{border-collapse:collapse;display:block;overflow:auto}.message-markdown td,.message-markdown th{border:1px solid #8886;padding:.3em}.message-markdown blockquote{margin-left:0;border-left:3px solid #8886;padding-left:1em}.message-markdown>*:first-child{margin-top:0}.message-markdown>*:last-child{margin-bottom:0}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;
export async function assetDigest(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function createTrustedAssets(bundle: string) {
  const contents = [documentHTML, bundle, documentCSS + readingCSS];
  const assets = new Map<string, TrustedAsset>();
  const manifest: AssetManifestEntry[] = [];
  for (let index = 0; index < assetPaths.length; index++) {
    const path = assetPaths[index]!,
      content = contents[index]!,
      mediaType = mediaTypes[index]!;
    assets.set(path, Object.freeze({ content, mediaType }));
    manifest.push(
      Object.freeze({
        path,
        mediaType,
        size: new TextEncoder().encode(content).byteLength,
        sha256: await assetDigest(content),
      }),
    );
  }
  return { assets: assets as ReadonlyMap<string, TrustedAsset>, manifest: Object.freeze(manifest) };
}
/** Host validates its explicitly selected finite build output; no URL or filesystem loader. */
export async function validateTrustedAssets(
  assets: ReadonlyMap<string, TrustedAsset>,
  manifest: AssetManifest,
): Promise<void> {
  if (assets.size !== assetPaths.length || manifest.length !== assetPaths.length)
    throw new Error('invalid_web_assets');
  const seen = new Set<string>();
  for (const entry of manifest) {
    const index = assetPaths.indexOf(entry.path as (typeof assetPaths)[number]);
    if (index < 0 || seen.has(entry.path)) throw new Error('invalid_web_assets');
    seen.add(entry.path);
    const asset = assets.get(entry.path);
    if (
      !asset ||
      asset.mediaType !== mediaTypes[index] ||
      entry.mediaType !== asset.mediaType ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      new TextEncoder().encode(asset.content).byteLength !== entry.size ||
      (await assetDigest(asset.content)) !== entry.sha256
    )
      throw new Error('invalid_web_assets');
  }
}
