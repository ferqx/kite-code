import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { officeCliReleaseAsset } from './officecli-runtime';

const cache = resolve(import.meta.dir, '../../../../.cache/officecli-assets');

export async function readOfficeCliRelease(
  asset: ReturnType<typeof officeCliReleaseAsset>,
  cacheDirectory = cache,
) {
  const cached = join(cacheDirectory, asset.sha256);
  function matchesRelease(bytes: Uint8Array) {
    return (
      bytes.length === asset.bytes &&
      createHash('sha256').update(bytes).digest('hex') === asset.sha256
    );
  }
  try {
    const bytes = await readFile(cached);
    if (matchesRelease(bytes)) return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(cacheDirectory, { recursive: true });
  console.error(`[shell-tools] Downloading ${asset.name} (OfficeCLI ${asset.version})...`);
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw Error(`officecli_download_failed:${asset.name}:${response.status}`);
  const bytes = await response.bytes();
  if (!matchesRelease(bytes)) throw Error(`officecli_checksum_mismatch:${asset.name}`);
  const pending = `${cached}-${randomUUID()}.tmp`;
  try {
    await writeFile(pending, bytes, { mode: 0o600, flag: 'wx' });
    await rename(pending, cached);
  } finally {
    await rm(pending, { force: true });
  }
  return bytes;
}
