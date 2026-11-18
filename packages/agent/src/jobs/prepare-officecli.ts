import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type OfficeCliPackageEntry, officeCliReleaseAsset } from './officecli-runtime';

const cache = resolve(import.meta.dir, '../../../../.cache/officecli-assets');

async function readRelease(asset: ReturnType<typeof officeCliReleaseAsset>) {
  const cached = join(cache, asset.sha256);
  function verify(bytes: Uint8Array) {
    if (
      bytes.length !== asset.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256
    )
      throw Error(`officecli_checksum_mismatch:${asset.name}`);
    return bytes;
  }
  try {
    return verify(await readFile(cached));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw Error(`officecli_download_failed:${asset.name}:${response.status}`);
  const bytes = verify(await response.bytes());
  const pending = join(cache, `${asset.sha256}-${randomUUID()}.tmp`);
  try {
    await writeFile(pending, bytes, { mode: 0o600, flag: 'wx' });
    await rename(pending, cached);
  } finally {
    await rm(pending, { force: true });
  }
  return bytes;
}

export async function prepareBundledOfficeCli(directory: string): Promise<OfficeCliPackageEntry> {
  const asset = officeCliReleaseAsset();
  await mkdir(cache, { recursive: true });
  const bytes = await readRelease(asset);
  const executable = join(directory, asset.executable);
  await writeFile(executable, bytes, { mode: 0o755 });
  await chmod(executable, 0o755);
  return {
    version: asset.version,
    asset: asset.name,
    upstreamSha256: asset.sha256,
    sha256: asset.sha256,
  };
}
