import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArtifactReferenceReadInput } from './artifact-port';
import {
  artifactChunkBytes,
  artifactPath,
  readPublishedArtifact,
  readPublishedArtifactChunks,
  verifyPublishedArtifact,
} from './artifacts-files';
import { canonicalJson } from './json';
import { acquireProfileAccess, assertNoSymlinkPath, type ProfileOptions } from './platform/profile';
import { createWindowsArtifactTemporary } from './platform/windows-artifact-files';
import type { Store } from './storage/port';
import { AgentError, type ArtifactReference, type ArtifactScope, type Json } from './storage/types';

export type { ArtifactReference, ArtifactScope } from './storage/types';
export interface ArtifactReadInput {
  expectedStoreId: string;
  refId: string;
  sessionId: string;
  subjectId: string;
  scope: ArtifactScope;
  signal?: AbortSignal;
}
export interface ArtifactPublishInput extends ArtifactReadInput {
  mediaType: string;
}
export interface ArtifactStore {
  publish(input: ArtifactPublishInput & { content: Uint8Array }): Promise<ArtifactReference>;
  publishStream(
    input: ArtifactPublishInput & {
      content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
      signal?: AbortSignal;
    },
  ): Promise<ArtifactReference>;
  read(input: ArtifactReadInput): Promise<Uint8Array>;
  readReference(input: ArtifactReferenceReadInput): Promise<Uint8Array>;
  /** Successful EOF verifies full hash and identity; cancellation/partial bytes are not a complete body. */
  readStream(input: ArtifactReadInput & { signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
/** Explicit host I/O. Profile use authority is held until all publication/reads settle. */
export function createArtifactStore(options: {
  profile: ProfileOptions;
  store: Store;
}): ArtifactStore {
  const access = acquireProfileAccess(options.profile);
  let closing = false;
  let active = 0;
  let activeReads = 0;
  let queuedBytes = 0;
  let queuedReads = 0;
  let publisherBurst = 0;
  type Kind = 'read' | 'publish';
  type Waiting = {
    kind: Kind;
    bytes: number;
    signal?: AbortSignal;
    abort: () => void;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
  };
  const waiting: Waiting[] = [];
  let done: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  function permit(kind: Kind): () => void {
    active++;
    if (kind === 'read') activeReads++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      if (kind === 'read') activeReads--;
      pump();
    };
  }
  function remove(entry: Waiting) {
    const index = waiting.indexOf(entry);
    if (index < 0) return false;
    waiting.splice(index, 1);
    queuedBytes -= entry.bytes;
    if (entry.kind === 'read') queuedReads--;
    entry.signal?.removeEventListener('abort', entry.abort);
    return true;
  }
  function pump() {
    while (active < 8) {
      const publisher = waiting.findIndex((entry) => entry.kind === 'publish');
      // Two active positions remain available for publication even with held read streams.
      const reader = activeReads < 6 ? waiting.findIndex((entry) => entry.kind === 'read') : -1;
      const index = publisher >= 0 && (publisherBurst < 4 || reader < 0) ? publisher : reader;
      if (index < 0) break;
      const entry = waiting[index]!;
      remove(entry);
      publisherBurst = entry.kind === 'publish' ? publisherBurst + 1 : 0;
      entry.resolve(permit(entry.kind));
    }
    if (!active && !waiting.length) done?.();
  }
  function metadataBytes(input: ArtifactReadInput) {
    return (
      512 +
      [
        input.expectedStoreId,
        input.refId,
        input.sessionId,
        input.subjectId,
        input.scope.kind,
        input.scope.id,
        'mediaType' in input && typeof input.mediaType === 'string' ? input.mediaType : '',
      ].reduce((sum, value) => sum + value.length * 2, 0)
    );
  }
  /** Queue bounds cover retained ticket metadata and known byte-array publications, not lazy source closures. */
  function enter(kind: Kind, bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (closing) throw new AgentError('artifact_closed');
    signal?.throwIfAborted();
    if (!waiting.length && active < 8 && (kind === 'publish' || activeReads < 6))
      return Promise.resolve(permit(kind));
    // Reader floods cannot consume all pending admission positions needed by producers.
    if (
      waiting.length >= 64 ||
      (kind === 'read' && queuedReads >= 32) ||
      queuedBytes + bytes > 16 * 1024 * 1024
    )
      throw new AgentError('artifact_busy', 'artifact_busy', true);
    const promise = new Promise<() => void>((resolve, reject) => {
      const entry: Waiting = {
        kind,
        bytes,
        signal,
        resolve,
        reject,
        abort() {
          if (!remove(entry)) return;
          reject(signal!.reason);
          pump();
        },
      };
      waiting.push(entry);
      queuedBytes += bytes;
      if (kind === 'read') queuedReads++;
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) entry.abort();
    });
    pump();
    return promise;
  }
  async function use<T>(admission: Promise<() => void>, work: () => Promise<T>): Promise<T> {
    const release = await admission;
    try {
      return await work();
    } finally {
      release();
    }
  }
  function privateDirectory(path: string): void {
    assertNoSymlinkPath(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new AgentError('artifact_directory_invalid');
  }
  function publishStream(
    input: ArtifactPublishInput & {
      content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
      signal?: AbortSignal;
    },
    admission?: Promise<() => void>,
  ): Promise<ArtifactReference> {
    const { content, signal, ...metadata } = input;
    const sealed = { ...metadata, scope: { ...metadata.scope } };
    let accepted: Promise<() => void>;
    try {
      const knownBytes = Array.isArray(content)
        ? content.reduce(
            (sum, chunk) => sum + (chunk instanceof Uint8Array ? chunk.byteLength : 0),
            0,
          )
        : 0;
      accepted = admission ?? enter('publish', metadataBytes(input) + knownBytes, signal);
    } catch (error) {
      return Promise.reject(error);
    }
    return use(accepted, async () => {
      signal?.throwIfAborted();
      if ((await options.store.getMetadata()).storeId !== sealed.expectedStoreId)
        throw new AgentError('store_identity_mismatch');
      if (process.platform === 'win32') {
        const temporary = createWindowsArtifactTemporary(access.profilePath);
        const digest = createHash('sha256');
        let size = 0n;
        try {
          for await (const chunk of content) {
            signal?.throwIfAborted();
            if (!(chunk instanceof Uint8Array)) throw new AgentError('artifact_chunk_invalid');
            for (let start = 0; start < chunk.byteLength; start += artifactChunkBytes) {
              signal?.throwIfAborted();
              const part = Uint8Array.from(chunk.subarray(start, start + artifactChunkBytes));
              size += BigInt(part.byteLength);
              if (size > 9223372036854775807n) throw new AgentError('artifact_size_invalid');
              digest.update(part);
              temporary.write(part);
            }
          }
          signal?.throwIfAborted();
          const hash = digest.digest('hex');
          temporary.publish(hash, String(size));
          temporary.close();
          signal?.throwIfAborted();
          verifyPublishedArtifact(access.profilePath, hash, String(size));
          return await options.store.registerArtifact({ ...sealed, hash, size: String(size) });
        } finally {
          temporary.close();
        }
      }
      privateDirectory(access.profilePath);
      privateDirectory(join(access.profilePath, 'blobs'));
      const temp = join(access.profilePath, 'blobs', `.publish-${randomUUID()}`);
      const fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const digest = createHash('sha256');
      let size = 0n;
      let writerClosed = false;
      let temporaryExists = true;
      try {
        try {
          for await (const chunk of content) {
            signal?.throwIfAborted();
            if (!(chunk instanceof Uint8Array)) throw new AgentError('artifact_chunk_invalid');
            for (let start = 0; start < chunk.byteLength; start += artifactChunkBytes) {
              signal?.throwIfAborted();
              const part = Uint8Array.from(chunk.subarray(start, start + artifactChunkBytes));
              size += BigInt(part.byteLength);
              if (size > 9223372036854775807n) throw new AgentError('artifact_size_invalid');
              digest.update(part);
              let offset = 0;
              while (offset < part.byteLength) {
                const written = writeSync(fd, part, offset, part.byteLength - offset);
                if (!written) throw new AgentError('artifact_write_incomplete');
                offset += written;
              }
            }
          }
          signal?.throwIfAborted();
          fchmodSync(fd, 0o400);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
          writerClosed = true;
        }
        const hash = digest.digest('hex');
        const target = artifactPath(access.profilePath, hash);
        privateDirectory(dirname(target));
        try {
          linkSync(temp, target);
        } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
        }
        // Removing the same-inode temporary changes ctime; finish it before verification/registration.
        unlinkSync(temp);
        temporaryExists = false;
        verifyPublishedArtifact(access.profilePath, hash, String(size));
        const directory = openSync(
          dirname(target),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
        return await options.store.registerArtifact({ ...sealed, hash, size: String(size) });
      } finally {
        if (writerClosed && temporaryExists) unlinkSync(temp);
      }
    });
  }
  return {
    publish(input) {
      if (!(input.content instanceof Uint8Array))
        return Promise.reject(new AgentError('artifact_content_invalid'));
      try {
        // Reserve the retained payload budget before copying, but seal bytes at the call boundary.
        const admission = enter(
          'publish',
          metadataBytes(input) + input.content.byteLength,
          input.signal,
        );
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(input.content);
        } catch (error) {
          void admission.then(
            (release) => release(),
            () => {},
          );
          return Promise.reject(error);
        }
        return publishStream({ ...input, content: [bytes] }, admission);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    publishStream(input) {
      return publishStream(input);
    },
    async read(input) {
      const { signal, ...request } = input;
      const sealed = { ...request, scope: { ...request.scope } };
      return use(enter('read', metadataBytes(sealed), signal), async () => {
        signal?.throwIfAborted();
        const ref = await options.store.getArtifactReference(sealed);
        signal?.throwIfAborted();
        if (!ref) throw new AgentError('artifact_reference_not_found');
        return readPublishedArtifact(access.profilePath, ref.hash, ref.size);
      });
    },
    async readReference(input) {
      const expectedStoreId = input.expectedStoreId;
      const reference = { ...input.reference, scope: { ...input.reference.scope } };
      const signal = input.signal;
      return use(
        enter(
          'read',
          metadataBytes({
            expectedStoreId,
            refId: reference.id,
            sessionId: reference.sessionId,
            subjectId: reference.subjectId,
            scope: reference.scope,
          }),
          signal,
        ),
        async () => {
          signal?.throwIfAborted();
          const original = await options.store.getArtifactReference({
            expectedStoreId,
            sessionId: reference.sessionId,
            subjectId: reference.subjectId,
            refId: reference.id,
            scope: reference.scope,
          });
          signal?.throwIfAborted();
          if (
            !original ||
            canonicalJson(original as unknown as Json) !==
              canonicalJson(reference as unknown as Json)
          )
            throw new AgentError('artifact_reference_mismatch');
          return readPublishedArtifact(access.profilePath, original.hash, original.size);
        },
      );
    },
    async *readStream(input) {
      const { signal, ...request } = input;
      const sealed = { ...request, scope: { ...request.scope } };
      const release = await enter('read', metadataBytes(sealed), signal);
      try {
        signal?.throwIfAborted();
        const ref = await options.store.getArtifactReference(sealed);
        signal?.throwIfAborted();
        if (!ref) throw new AgentError('artifact_reference_not_found');
        for (const chunk of readPublishedArtifactChunks(access.profilePath, ref.hash, ref.size)) {
          signal?.throwIfAborted();
          yield chunk;
        }
      } finally {
        release();
      }
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          if (active || waiting.length)
            await new Promise<void>((resolve) => {
              done = resolve;
            });
          access.lock.release();
        })();
      }
      return closePromise;
    },
  };
}
