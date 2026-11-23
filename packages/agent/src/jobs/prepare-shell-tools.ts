import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type OfficeCliPackageEntry, officeCliReleaseAsset } from './officecli-runtime';
import { readOfficeCliRelease } from './prepare-officecli';
import { ripgrepCachePath, ripgrepReleaseAsset } from './ripgrep';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ensureAsset(
  path: string,
  expected: { bytes: number; sha256: string },
  readBytes: () => Uint8Array | Promise<Uint8Array>,
  executable = false,
): Promise<void> {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (
    current?.isFile() &&
    current.size === expected.bytes &&
    (!executable || process.platform === 'win32' || (current.mode & 0o100) !== 0) &&
    sha256(readFileSync(path)) === expected.sha256
  )
    return;

  const bytes = await readBytes();
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
    throw Error(`shell_tool_checksum_mismatch:${path}`);
  const pending = `${path}-${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, bytes, { mode: executable ? 0o755 : 0o644, flag: 'wx' });
    if (executable) chmodSync(pending, 0o755);
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}

async function prepareRipgrep(asset = ripgrepReleaseAsset()): Promise<string> {
  const path = ripgrepCachePath(asset);
  mkdirSync(dirname(path), { recursive: true });
  await ensureAsset(
    path,
    asset,
    async () => {
      console.error(`[shell-tools] Downloading ${asset.name}...`);
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw Error(`ripgrep_download_failed:${asset.name}:${response.status}`);
      const archive = await response.bytes();
      if (archive.length !== asset.archiveBytes || sha256(archive) !== asset.archiveSha256)
        throw Error(`ripgrep_archive_checksum_mismatch:${asset.name}`);

      if (asset.format === 'zip') {
        // Windows ships bsdtar, which can stream a single file from the ZIP.
        const tar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
        const result = Bun.spawnSync([tar, '-xOf', '-', asset.member], { stdin: archive });
        if (result.exitCode !== 0)
          throw Error(`ripgrep_extract_failed:${asset.name}:${result.stderr.toString()}`);
        return result.stdout;
      }
      const files = await new Bun.Archive(Bun.gunzipSync(archive)).files();
      const executable = files.get(asset.member);
      if (!executable) throw Error(`ripgrep_extract_failed:${asset.name}`);
      return new Uint8Array(await executable.arrayBuffer());
    },
    true,
  );
  return path;
}

export async function prepareShellTools(directory: string): Promise<void> {
  const release = ripgrepReleaseAsset();
  const sourceRg = await prepareRipgrep(release);
  const rg = {
    version: release.version,
    asset: release.name,
    upstreamSha256: release.archiveSha256,
    sha256: release.sha256,
  };
  const office = officeCliReleaseAsset();
  const officecli: OfficeCliPackageEntry = {
    version: office.version,
    asset: office.name,
    upstreamSha256: office.sha256,
    sha256: office.sha256,
  };

  mkdirSync(directory, { recursive: true });
  await ensureAsset(
    join(directory, office.executable),
    office,
    () => readOfficeCliRelease(office),
    true,
  );
  await ensureAsset(
    join(directory, release.executable),
    release,
    () => readFileSync(sourceRg),
    true,
  );

  const licenses = ['LICENSE-MIT.txt', 'LICENSE-PCRE2.txt', 'LICENSE-SLJIT.txt', 'UNLICENSE'];
  for (const name of licenses) {
    const bytes = readFileSync(join(import.meta.dir, 'ripgrep-licenses', name));
    await ensureAsset(
      join(directory, name),
      { bytes: bytes.length, sha256: sha256(bytes) },
      () => bytes,
    );
  }
  rmSync(join(directory, 'LICENSE.vscode-ripgrep'), { force: true });

  // Publish the manifest after every file it describes is in place.
  const manifest = Buffer.from(
    `${JSON.stringify({ platform: process.platform, arch: process.arch, rg, officecli }, null, 2)}\n`,
  );
  await ensureAsset(
    join(directory, 'manifest.json'),
    { bytes: manifest.length, sha256: sha256(manifest) },
    () => manifest,
  );
}

if (import.meta.main) {
  const dist = resolve(import.meta.dir, '../../dist');
  if (lstatSync(join(dist, 'jobs/shell.js'), { throwIfNoEntry: false })?.isFile()) {
    const tools = join(dist, 'platform/process/tools');
    for (const path of [dist, join(dist, 'platform'), join(dist, 'platform/process'), tools]) {
      const directory = lstatSync(path, { throwIfNoEntry: false });
      if (directory && !directory.isDirectory())
        throw Error('shell_tools_output_is_not_a_directory');
    }
    await prepareShellTools(tools);
  } else {
    await prepareRipgrep();
  }
}
