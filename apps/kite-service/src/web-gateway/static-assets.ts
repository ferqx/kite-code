import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const WEB_GATEWAY_ASSET_DIAGNOSTIC_ = 'web_assets_missing' as const;

export class WebGatewayStaticAssetsError extends Error {
  readonly diagnostic = WEB_GATEWAY_ASSET_DIAGNOSTIC_;

  constructor() {
    super('Web Gateway static assets are missing or invalid.');
    this.name = 'WebGatewayStaticAssetsError';
  }
}

export interface WebGatewayStaticAssetIdentity {
  readonly root: string;
  readonly digest: string;
}

/** Validate the fixed production asset surface without returning a path-bearing diagnostic. */
export function preflightWebGatewayStaticAssets(root: string): string {
  return inspectWebGatewayStaticAssets(root).root;
}

/**
 * Validate and hash the complete fixed Web asset surface. The digest is an in-memory Service
 * registration identity; it is never written beside the bundle or into Kite Home.
 */
export function inspectWebGatewayStaticAssets(root: string): WebGatewayStaticAssetIdentity {
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
    assertRealDirectory(join(absolute, 'api-docs'));
    const assets = join(absolute, 'assets');
    assertRealDirectory(assets);
    const entries = readdirSync(assets).sort((left, right) => left.localeCompare(right));
    if (!entries.some((entry) => /^[A-Za-z0-9_-]+\.js$/u.test(entry))) {
      throw new Error('missing application bundle');
    }
    for (const entry of entries) {
      if (!/^[A-Za-z0-9_-]+\.(?:css|ico|js|mjs|png|svg|woff2)$/u.test(entry)) {
        throw new Error('unknown asset');
      }
      assertRegularFile(join(assets, entry));
    }
    const files = [
      'index.html',
      join('api-docs', 'openapi.json'),
      ...entries.map((entry) => join('assets', entry)),
    ];
    const hash = createHash('sha256');
    for (const name of files) {
      const path = join(absolute, name);
      const bytes = readRegularFile(path);
      const normalizedName = name.split(sep).join('/');
      hash.update(normalizedName, 'utf8');
      hash.update('\0', 'utf8');
      hash.update(String(bytes.byteLength), 'utf8');
      hash.update('\0', 'utf8');
      hash.update(bytes);
    }
    return Object.freeze({ root: absolute, digest: hash.digest('hex') });
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

function readRegularFile(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const parent = lstatSync(resolve(path, '..'));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('invalid asset parent');
    const lexical = resolve(path);
    const parentRoot = resolve(path, '..');
    const relativeName = relative(parentRoot, lexical);
    if (
      relativeName === '..' ||
      relativeName.startsWith(`..${sep}`) ||
      relativeName.includes(`..${sep}`)
    ) {
      throw new Error('invalid asset path');
    }
    descriptor = openSync(lexical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('invalid asset');
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
