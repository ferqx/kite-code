import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const WEB_GATEWAY_ASSET_DIAGNOSTIC_ = 'web_assets_missing' as const;

export class WebGatewayStaticAssetsError extends Error {
  readonly diagnostic = WEB_GATEWAY_ASSET_DIAGNOSTIC_;

  constructor() {
    super('Web Gateway static assets are missing or invalid.');
    this.name = 'WebGatewayStaticAssetsError';
  }
}

/** Validate the fixed production asset surface without returning a path-bearing diagnostic. */
export function preflightWebGatewayStaticAssets(root: string): string {
  try {
    const absolute = resolve(root);
    const rootStat = lstatSync(absolute);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      realpathSync.native(absolute) !== absolute
    ) {
      throw new Error('invalid root');
    }
    assertRegularFile(join(absolute, 'index.html'));
    assertRealDirectory(join(absolute, 'api-docs'));
    assertRegularFile(join(absolute, 'api-docs', 'openapi.json'));
    const assets = join(absolute, 'assets');
    assertRealDirectory(assets);
    const entries = readdirSync(assets);
    if (!entries.some((entry) => /^[A-Za-z0-9_-]+\.js$/u.test(entry))) {
      throw new Error('missing application bundle');
    }
    for (const entry of entries) {
      if (!/^[A-Za-z0-9_-]+\.(?:css|ico|js|mjs|png|svg|woff2)$/u.test(entry)) {
        throw new Error('unknown asset');
      }
      assertRegularFile(join(assets, entry));
    }
    return absolute;
  } catch (error) {
    if (error instanceof WebGatewayStaticAssetsError) throw error;
    throw new WebGatewayStaticAssetsError();
  }
}

function assertRealDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid directory');
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('invalid asset');
  }
}
