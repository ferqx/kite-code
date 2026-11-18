import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { packagedToolDirectory } from './ripgrep';

const releaseVersion = '1.0.161';
const releaseAssets = {
  'win32-x64': {
    name: 'officecli-win-x64.exe',
    bytes: 33558440,
    sha256: '7d0872af30e0b2aa827f4e2eb0761b8852044a1385c8579f9717db8a8b91c357',
  },
  'darwin-arm64': {
    name: 'officecli-mac-arm64',
    bytes: 33933168,
    sha256: '14c71ed62b04e895b0dc4818908ccdc14f6012513350be4ee19c0cbef91fc71b',
  },
  'darwin-x64': {
    name: 'officecli-mac-x64',
    bytes: 34911296,
    sha256: 'fc6497a9a1c36cd54d6a239d7aa102491b5b6c6e69535d414cf3a5a3a54505fc',
  },
  'linux-x64': {
    name: 'officecli-linux-x64',
    bytes: 35527269,
    sha256: 'ed551216f7a62c562d8d231c0416374566684fcc6163176f2ba4ad721c62900a',
  },
  'linux-arm64': {
    name: 'officecli-linux-arm64',
    bytes: 34917895,
    sha256: '3ff44a8f527e4805c0db7abfea8da68b2353f8b1d83e1099d7cae27fc140f95a',
  },
} as const;

export function officeCliReleaseAsset(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const asset = releaseAssets[target as keyof typeof releaseAssets];
  if (!asset) throw Error(`officecli_target_unsupported:${target}`);
  return {
    ...asset,
    version: releaseVersion,
    executable: platform === 'win32' ? 'officecli.exe' : 'officecli',
    url: `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${releaseVersion}/${asset.name}`,
  };
}

export interface OfficeCliPackageEntry {
  version: string;
  asset: string;
  upstreamSha256: string;
  sha256: string;
}

/** Source-only hosts have no packaged executable. Only an admitted package adds the tool. */
export function bundledOfficeCliAsset(): string | undefined {
  const directory = packagedToolDirectory();
  if (!directory) return;
  const expected = officeCliReleaseAsset();
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
    platform?: string;
    arch?: string;
    officecli?: OfficeCliPackageEntry;
  };
  const entry = manifest.officecli;
  const executable = join(directory, expected.executable);
  const file = lstatSync(executable);
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    entry?.version !== expected.version ||
    entry.asset !== expected.name ||
    entry.upstreamSha256 !== expected.sha256 ||
    !file.isFile() ||
    file.size > 64 * 1024 * 1024 ||
    // The macOS signer changes executable bytes and records the final digest.
    (process.platform !== 'darwin' &&
      (entry.sha256 !== expected.sha256 || file.size !== expected.bytes)) ||
    createHash('sha256').update(readFileSync(executable)).digest('hex') !== entry.sha256
  )
    throw Error('officecli_asset_changed');
  return realpathSync.native(executable);
}
