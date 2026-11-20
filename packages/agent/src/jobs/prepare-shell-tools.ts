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
import { basename, dirname, join, resolve } from 'node:path';
import { type OfficeCliPackageEntry, officeCliReleaseAsset } from './officecli-runtime';
import { readOfficeCliRelease } from './prepare-officecli';
import { ripgrepAsset } from './ripgrep';

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
  const pending = `${path}-${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, bytes, { mode: executable ? 0o755 : 0o644, flag: 'wx' });
    if (executable) chmodSync(pending, 0o755);
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}

export async function prepareShellTools(directory: string): Promise<void> {
  const sourceRg = ripgrepAsset();
  const rgBytes = readFileSync(sourceRg);
  const rg = {
    version: '15.0.0',
    package: '@vscode/ripgrep',
    packageVersion: '1.18.0',
    sha256: sha256(rgBytes),
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
    join(directory, basename(sourceRg)),
    { bytes: rgBytes.length, sha256: rg.sha256 },
    () => rgBytes,
    true,
  );

  const licenses = ['LICENSE-MIT.txt', 'LICENSE-PCRE2.txt', 'LICENSE-SLJIT.txt'];
  for (const [name, path] of [
    ['LICENSE.vscode-ripgrep', join(dirname(dirname(sourceRg)), 'LICENSE')],
    ...licenses.map((name) => [name, join(import.meta.dir, 'ripgrep-licenses', name)] as const),
  ] as const) {
    const bytes = readFileSync(path);
    await ensureAsset(
      join(directory, name),
      { bytes: bytes.length, sha256: sha256(bytes) },
      () => bytes,
    );
  }

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
  }
}
