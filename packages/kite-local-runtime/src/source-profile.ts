import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** One source-checkout Store namespace; a format-epoch change never reopens an older file. */
export function sourceKiteSessionStoreDirectoryFromCanonicalRoots(
  canonicalKiteHome: string,
  canonicalRepositoryRoot: string,
  storeFormatEpoch: string,
): string {
  if (!storeFormatEpoch) throw new Error('Source Session Store format epoch is required.');
  const digest = createHash('sha256')
    .update('kite-source-runtime-profile\0')
    .update(canonicalKiteHome)
    .update('\0')
    .update(canonicalRepositoryRoot)
    .update('\0')
    .update(storeFormatEpoch)
    .digest('hex')
    .slice(0, 32);
  return join(canonicalKiteHome, 'source-profiles', digest);
}
