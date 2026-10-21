import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
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
  const expected = artifactSize(size);
  if (process.platform === 'win32') {
    yield* readWindowsArtifactChunks(profilePath, hash, size);
    return;
  }
  yield* readPosixArtifact(profilePath, hash, expected, 'chunks');
}
function artifactSize(size: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(size) || BigInt(size) > 9223372036854775807n)
    throw new AgentError('artifact_size_invalid');
  return BigInt(size);
}
/** Reused scratch and whole-body views never escape these private consumers. */
function* readPosixArtifact(
  profilePath: string,
  hash: string,
  expected: bigint,
  mode: 'chunks' | 'verify' | 'whole',
): Generator<Uint8Array, Uint8Array | undefined> {
  const path = artifactPath(profilePath, hash);
  assertNoSymlinkPath(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size !== expected || (Number(before.mode) & 0o222) !== 0)
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
    let target: Buffer | undefined;
    if (mode === 'whole') {
      // A contiguous result has the runtime's intrinsic Buffer limit; streaming does not.
      if (expected > BigInt(bufferConstants.MAX_LENGTH) || !Number.isSafeInteger(Number(expected)))
        throw new AgentError('artifact_content_unavailable');
      try {
        target = Buffer.alloc(Number(expected));
      } catch (error) {
        if (error instanceof RangeError) throw new AgentError('artifact_content_unavailable');
        throw error;
      }
    }
    const scratch =
      mode === 'verify'
        ? Buffer.alloc(
            Number(expected < BigInt(artifactChunkBytes) ? expected : BigInt(artifactChunkBytes)),
          )
        : undefined;
    const digest = createHash('sha256');
    let count = 0n;
    while (count < expected) {
      const remaining = expected - count;
      const length = Number(
        remaining < BigInt(artifactChunkBytes) ? remaining : BigInt(artifactChunkBytes),
      );
      const buffer = target
        ? target.subarray(Number(count), Number(count) + length)
        : scratch
          ? scratch.subarray(0, length)
          : Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) throw new AgentError('artifact_content_mismatch');
      count += BigInt(read);
      const bytes = buffer.subarray(0, read);
      digest.update(bytes);
      yield bytes;
    }
    // Still establish actual EOF: a size limit must never silently accept a grown file.
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new AgentError('artifact_content_mismatch');
    const after = fstatSync(fd, { bigint: true });
    if (
      count !== expected ||
      after.size !== opened.size ||
      after.ctimeNs !== opened.ctimeNs ||
      digest.digest('hex') !== hash
    )
      throw new AgentError('artifact_content_mismatch');
    return target;
  } finally {
    closeSync(fd);
  }
}
/** Storage registration validates the whole object with fixed memory before saving a reference. */
export function* verifyPublishedArtifactSteps(
  profilePath: string,
  hash: string,
  size: string,
): Generator<unknown, void, void> {
  const chunks =
    process.platform === 'win32'
      ? readPublishedArtifactChunks(profilePath, hash, size)
      : readPosixArtifact(profilePath, hash, artifactSize(size), 'verify');
  for (const _chunk of chunks) {
    yield;
  }
}
export function verifyPublishedArtifact(profilePath: string, hash: string, size: string): void {
  for (const _step of verifyPublishedArtifactSteps(profilePath, hash, size)) {
    /* Full hash/identity verification at EOF. */
  }
}
export function readPublishedArtifact(profilePath: string, hash: string, size: string): Uint8Array {
  if (process.platform === 'win32') {
    const chunks = [...readPublishedArtifactChunks(profilePath, hash, size)];
    return Buffer.concat(chunks);
  }
  const reading = readPosixArtifact(profilePath, hash, artifactSize(size), 'whole');
  let next = reading.next();
  while (!next.done) next = reading.next();
  if (next.value === undefined) throw new AgentError('artifact_content_mismatch');
  return next.value;
}

/** Keep the original file/HANDLE and complete verifier live across real event-loop turns. */
function readCheckpoint(signal?: AbortSignal): () => Promise<void> | undefined {
  let deadline = performance.now() + 8;
  let chunks = 0;
  return () => {
    signal?.throwIfAborted();
    if (++chunks < 64 && performance.now() < deadline) return;
    return yieldToEventLoop().then(() => {
      signal?.throwIfAborted();
      chunks = 0;
      deadline = performance.now() + 8;
    });
  };
}

/** A yielded prefix is unverified until the original reader reaches successful EOF. */
export async function* readPublishedArtifactChunksAsync(
  profilePath: string,
  hash: string,
  size: string,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  const checkpoint = readCheckpoint(signal);
  for (const chunk of readPublishedArtifactChunks(profilePath, hash, size)) {
    const pause = checkpoint();
    if (pause) await pause;
    yield chunk;
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
}

/** Publication readback keeps fixed scratch space and all original EOF/identity/hash checks. */
export async function verifyPublishedArtifactAsync(
  profilePath: string,
  hash: string,
  size: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const checkpoint = readCheckpoint(signal);
  for (const _step of verifyPublishedArtifactSteps(profilePath, hash, size)) {
    const pause = checkpoint();
    if (pause) await pause;
  }
  signal?.throwIfAborted();
}

export async function readPublishedArtifactAsync(
  profilePath: string,
  hash: string,
  size: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (process.platform === 'win32') {
    // The native generator still proves the complete original HANDLE before success.
    const chunks: Uint8Array[] = [];
    for await (const chunk of readPublishedArtifactChunksAsync(profilePath, hash, size, signal))
      chunks.push(chunk);
    const result = Buffer.concat(chunks);
    signal?.throwIfAborted();
    return result;
  }
  const checkpoint = readCheckpoint(signal);
  const reading = readPosixArtifact(profilePath, hash, artifactSize(size), 'whole');
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = reading.next();
      if (next.done) {
        signal?.throwIfAborted();
        if (next.value === undefined) throw new AgentError('artifact_content_mismatch');
        return next.value;
      }
      const pause = checkpoint();
      if (pause) await pause;
    }
  } finally {
    reading.return(undefined);
  }
}
