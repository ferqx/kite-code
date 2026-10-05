import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSymlinkPath } from './platform/profile-identity';
import { readWindowsArtifactChunks } from './platform/windows-artifact-files';
import { AgentError } from './storage/types';

export const artifactChunkBytes = 64 * 1024;
export function artifactPath(profilePath: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new AgentError('artifact_hash_invalid');
  return join(profilePath, 'blobs', hash.slice(0, 2), hash);
}
/** Chunk ownership is transferred to the caller. Integrity is established only at successful EOF. */
export function* readPublishedArtifactChunks(
  profilePath: string,
  hash: string,
  size: string,
): Generator<Uint8Array> {
  if (!/^(0|[1-9][0-9]*)$/.test(size) || BigInt(size) > 9223372036854775807n)
    throw new AgentError('artifact_size_invalid');
  if (process.platform === 'win32') {
    yield* readWindowsArtifactChunks(profilePath, hash, size);
    return;
  }
  const path = artifactPath(profilePath, hash);
  assertNoSymlinkPath(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(size) || (Number(before.mode) & 0o222) !== 0)
    throw new AgentError('artifact_content_mismatch');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new AgentError('artifact_content_mismatch');
    const digest = createHash('sha256');
    let count = 0n;
    while (true) {
      const buffer = Buffer.alloc(artifactChunkBytes);
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      count += BigInt(read);
      if (count > BigInt(size)) throw new AgentError('artifact_content_mismatch');
      const bytes = buffer.subarray(0, read);
      digest.update(bytes);
      yield bytes;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      count !== BigInt(size) ||
      after.size !== opened.size ||
      after.ctimeNs !== opened.ctimeNs ||
      digest.digest('hex') !== hash
    )
      throw new AgentError('artifact_content_mismatch');
  } finally {
    closeSync(fd);
  }
}
/** Storage registration validates the whole object with fixed memory before saving a reference. */
export function verifyPublishedArtifact(profilePath: string, hash: string, size: string): void {
  for (const _chunk of readPublishedArtifactChunks(profilePath, hash, size)) {
    /* Full hash/identity verification at EOF. */
  }
}
export function readPublishedArtifact(profilePath: string, hash: string, size: string): Uint8Array {
  const chunks = [...readPublishedArtifactChunks(profilePath, hash, size)];
  return Buffer.concat(chunks);
}
