import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ripgrepVersion = '15.2.0';

// Archive digests are published with the upstream release. Executable digests
// verify source installs without depending on mutable cache metadata.
const releases = {
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    archiveBytes: 1789611,
    archiveSha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    bytes: 4218880,
    sha256: '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680',
  },
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    archiveBytes: 1764284,
    archiveSha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
    bytes: 4014576,
    sha256: 'a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    archiveBytes: 1878284,
    archiveSha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
    bytes: 4387000,
    sha256: '0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu',
    archiveBytes: 1854661,
    archiveSha256: 'a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d',
    bytes: 4506992,
    sha256: 'e36d0eb52e70696bdf1781392722e05a21bb91d3b7b762ef5ec20e5df2ec687b',
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-musl',
    archiveBytes: 2265718,
    archiveSha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
    bytes: 5408904,
    sha256: 'e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849',
  },
};

export function ripgrepReleaseAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(releases, key)) throw Error(`ripgrep_platform_unsupported:${key}`);
  const release = releases[key as keyof typeof releases];
  const prefix = `ripgrep-${ripgrepVersion}-${release.target}`;
  const format = platform === 'win32' ? 'zip' : 'tar.gz';
  const name = `${prefix}.${format}`;
  const executable = platform === 'win32' ? 'rg.exe' : 'rg';
  return {
    ...release,
    version: ripgrepVersion,
    format,
    name,
    executable,
    member: `${prefix}/${executable}`,
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${name}`,
  };
}

export function ripgrepCachePath(asset: ReturnType<typeof ripgrepReleaseAsset>): string {
  return resolve(
    import.meta.dir,
    '../../../../.cache/ripgrep-assets',
    asset.archiveSha256,
    asset.executable,
  );
}

export function packagedToolDirectory(): string | undefined {
  if (!import.meta.url.endsWith('.js')) return;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const root = ['jobs', 'permissions'].includes(basename(moduleDirectory))
    ? dirname(moduleDirectory)
    : moduleDirectory;
  return join(root, 'platform/process/tools');
}

/** Resolve a prepared executable without searching the user's PATH or downloading. */
export function bundledRipgrepAsset(): { executable: string; version: string } {
  const release = ripgrepReleaseAsset();
  const directory = packagedToolDirectory();
  const path = directory ? join(directory, release.executable) : ripgrepCachePath(release);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile())
    throw Error('ripgrep_asset_unavailable');
  const executable = realpathSync.native(path);
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (directory) {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    // macOS distribution signing updates the executable digest in this manifest.
    if (
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      manifest.rg?.version !== release.version ||
      manifest.rg.asset !== release.name ||
      manifest.rg.upstreamSha256 !== release.archiveSha256 ||
      manifest.rg.sha256 !== digest
    )
      throw Error('ripgrep_asset_changed');
  } else if (digest !== release.sha256) {
    throw Error('ripgrep_asset_changed');
  }
  return { executable, version: release.version };
}

export function ripgrepAsset(): string {
  return bundledRipgrepAsset().executable;
}

/** One scoped child environment, with the bundled command ahead of ambient commands. */
export function withBundledRipgrep(environment: Readonly<Record<string, string>>) {
  const key = Object.hasOwn(environment, 'PATH')
    ? 'PATH'
    : Object.keys(environment).find((key) => key.toLowerCase() === 'path');
  const path = key === undefined ? '' : environment[key]!;
  const executable = ripgrepAsset();
  return {
    executable,
    root: dirname(executable),
    env: {
      ...Object.fromEntries(
        Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'path'),
      ),
      PATH: [dirname(executable), ...(path ? [path] : [])].join(delimiter),
    },
  };
}
