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
  let done: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  function enter(): () => void {
    if (closing) throw new AgentError('artifact_closed');
    if (active >= 8) throw new AgentError('artifact_busy');
    active++;
    return () => {
      if (--active === 0) done?.();
    };
  }
  async function use<T>(work: () => Promise<T>): Promise<T> {
    const release = enter();
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
  ): Promise<ArtifactReference> {
    const { content, signal, ...metadata } = input;
    const sealed = { ...metadata, scope: { ...metadata.scope } };
    return use(async () => {
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
        const hash = digest.digest('hex');
        const target = artifactPath(access.profilePath, hash);
        privateDirectory(dirname(target));
        fchmodSync(fd, 0o400);
        fsyncSync(fd);
        try {
          linkSync(temp, target);
        } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
        }
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
        closeSync(fd);
        unlinkSync(temp);
      }
    });
  }
  return {
    publish(input) {
      if (!(input.content instanceof Uint8Array))
        return Promise.reject(new AgentError('artifact_content_invalid'));
      const bytes = Uint8Array.from(input.content);
      return publishStream({ ...input, content: [bytes] });
    },
    publishStream,
    read(input) {
      return use(async () => {
        const ref = await options.store.getArtifactReference(input);
        if (!ref) throw new AgentError('artifact_reference_not_found');
        return readPublishedArtifact(access.profilePath, ref.hash, ref.size);
      });
    },
    readReference(input) {
      const expectedStoreId = input.expectedStoreId;
      const reference = { ...input.reference, scope: { ...input.reference.scope } };
      return use(async () => {
        const original = await options.store.getArtifactReference({
          expectedStoreId,
          sessionId: reference.sessionId,
          subjectId: reference.subjectId,
          refId: reference.id,
          scope: reference.scope,
        });
        if (
          !original ||
          canonicalJson(original as unknown as Json) !== canonicalJson(reference as unknown as Json)
        )
          throw new AgentError('artifact_reference_mismatch');
        return readPublishedArtifact(access.profilePath, original.hash, original.size);
      });
    },
    async *readStream(input) {
      const release = enter();
      const { signal, ...request } = input;
      try {
        signal?.throwIfAborted();
        const ref = await options.store.getArtifactReference(request);
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
          if (active)
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
