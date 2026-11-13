import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const nodeReleaseVersion = '26.13.1';
const versionDir = `node-v${nodeReleaseVersion}`;
const nodeDigests: Readonly<Record<string, string>> = {
  [`${versionDir}-darwin-arm64.tar.xz`]:
    'af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559',
  [`${versionDir}-darwin-x64.tar.xz`]:
    '2693310b2820f9350d29524f21344e1c623875bab773457d55b2aceb9670716f',
  [`${versionDir}-linux-arm64.tar.xz`]:
    '89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd',
  [`${versionDir}-linux-x64.tar.xz`]:
    '5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864',
  [`${versionDir}-win-x64.zip`]: 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7',
  [`${versionDir}-headers.tar.xz`]:
    '02c39fd1ae84fdb2c5114ffff7cb3abefdf422c23546604882892ebf975818fc',
  'node.lib': 'caad0090dc3add94c06abd01e395e8ec0f1586c10071bda1f99480445d695f6f',
};
const sqliteVersion = '3530400';
const sqliteArchive = `sqlite-amalgamation-${sqliteVersion}.zip`;
const sqliteDigest = '628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e';
const windows = process.platform === 'win32';
const platform = windows ? 'win' : process.platform;
const distribution = `${versionDir}-${platform}-${process.arch}`;
const archiveName = distribution + (windows ? '.zip' : '.tar.xz');
const nodeDirectory = `release-node-v${nodeReleaseVersion}`;
const sqliteDirectory = `release-sqlite-${sqliteVersion}`;
const executablePath = windows ? 'node.exe' : 'bin/node';
const nodeSite = `https://nodejs.org/dist/v${nodeReleaseVersion}`;

export function cachedNodeDistribution(repository: string) {
  if (!Object.hasOwn(nodeDigests, archiveName)) throw Error('node_release_target_unsupported');
  return join(repository, '.cache', nodeDirectory, archiveName);
}

export function preparedDevelopmentNode(repository: string): string {
  return realpathSync.native(
    join(dirname(cachedNodeDistribution(repository)), distribution, executablePath),
  );
}

function verified(path: string, algorithm: string, digest: string) {
  if (!existsSync(path)) throw Error(`runtime_build_input_missing:${basename(path)}`);
  const bytes = readFileSync(path);
  if (createHash(algorithm).update(bytes).digest('hex') !== digest)
    throw Error(`runtime_build_input_changed:${basename(path)}`);
  return bytes;
}

function unpack(bytes: Uint8Array, archive: string, target: string, files: string[]) {
  // Archives have fixed digests. Use a private copy so the extractor sees the bytes that were checked.
  const path = join(target, basename(archive));
  writeFileSync(path, bytes, { flag: 'wx' });
  try {
    const tar = windows
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';
    const extracted = spawnSync(tar, ['-xf', path, '-C', target, ...files], {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    });
    if (extracted.error || extracted.status !== 0)
      throw Error(`runtime_build_input_extract_failed:${basename(archive)}`, {
        cause: extracted.error,
      });
  } finally {
    rmSync(path);
  }
}

export function extractNodeDistribution(repository: string, archive: string, destination: string) {
  const digest = nodeDigests[archiveName];
  if (!digest) throw Error('node_release_target_unsupported');
  const dir = join(destination, distribution);
  const nodeFiles = [`${distribution}/${executablePath}`, `${distribution}/LICENSE`];
  if (!windows) nodeFiles.push(`${distribution}/include/node`);
  unpack(verified(archive, 'sha256', digest), archiveName, destination, nodeFiles);
  const headerArchive = `${versionDir}-headers.tar.xz`;
  const headers = windows
    ? join(destination, versionDir, 'include/node')
    : join(dir, 'include/node');
  let library: string | undefined;
  if (windows) {
    const cache = dirname(cachedNodeDistribution(repository));
    unpack(
      verified(join(cache, headerArchive), 'sha256', nodeDigests[headerArchive]!),
      headerArchive,
      destination,
      [`${versionDir}/include/node`],
    );
    library = join(destination, 'node.lib');
    writeFileSync(library, verified(join(cache, 'node.lib'), 'sha256', nodeDigests['node.lib']!), {
      flag: 'wx',
    });
  }
  return {
    executable: join(dir, executablePath),
    license: join(dir, 'LICENSE'),
    headers,
    library,
    version: nodeReleaseVersion,
  };
}

export function extractReviewedSqlite(repository: string, destination: string) {
  const archive = join(repository, '.cache', sqliteDirectory, sqliteArchive);
  unpack(verified(archive, 'sha3-256', sqliteDigest), sqliteArchive, destination, [
    `sqlite-amalgamation-${sqliteVersion}/sqlite3.c`,
    `sqlite-amalgamation-${sqliteVersion}/sqlite3.h`,
  ]);
  return join(destination, `sqlite-amalgamation-${sqliteVersion}`);
}

async function download(url: string, target: string, algorithm: string, digest: string) {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    verified(target, algorithm, digest);
    return;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok)
    throw Error(`runtime_build_input_download_failed:${basename(target)}:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash(algorithm).update(bytes).digest('hex') !== digest)
    throw Error(`runtime_build_input_changed:${basename(target)}`);
  const staged = `${target}.${process.pid}.partial`;
  writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(staged, target);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** CI and checkout preparation only. A release build never downloads an input. */
export async function prepareNodeBuildInputs(repository: string) {
  const archive = cachedNodeDistribution(repository);
  const cache = dirname(archive);
  const headerArchive = `${versionDir}-headers.tar.xz`;
  await Promise.all([
    download(`${nodeSite}/${archiveName}`, archive, 'sha256', nodeDigests[archiveName]!),
    download(
      `https://sqlite.org/2026/${sqliteArchive}`,
      join(repository, '.cache', sqliteDirectory, sqliteArchive),
      'sha3-256',
      sqliteDigest,
    ),
    ...(windows
      ? [
          download(
            `${nodeSite}/${headerArchive}`,
            join(cache, headerArchive),
            'sha256',
            nodeDigests[headerArchive]!,
          ),
          download(
            `${nodeSite}/win-x64/node.lib`,
            join(cache, 'node.lib'),
            'sha256',
            nodeDigests['node.lib']!,
          ),
        ]
      : []),
  ]);
  // The release uses a fresh extraction. This separate executable serves checkout launches.
  if (!existsSync(join(cache, distribution, executablePath))) {
    const name = `prepare-${process.pid}`;
    const stage = join(cache, name);
    mkdirSync(stage, { mode: 0o700 });
    try {
      const prepared = extractNodeDistribution(repository, archive, stage);
      if (!windows) chmodSync(prepared.executable, 0o755);
      renameSync(join(stage, distribution), join(cache, distribution));
    } finally {
      rmSync(stage, { force: true, recursive: true });
    }
  }
  return preparedDevelopmentNode(repository);
}

if (import.meta.main)
  console.log(await prepareNodeBuildInputs(resolve(import.meta.dirname, '../..')));
