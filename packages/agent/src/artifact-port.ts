import type { ArtifactReference, ArtifactScope } from './storage/types';

export interface ArtifactReadInput {
  expectedStoreId: string;
  refId: string;
  sessionId: string;
  subjectId: string;
  scope: ArtifactScope;
  signal?: AbortSignal;
}
export interface ArtifactReferenceReadInput {
  expectedStoreId: string;
  reference: ArtifactReference;
  signal?: AbortSignal;
}
/** Host I/O port; the core imports no filesystem implementation. */
export interface ArtifactContentStore {
  /** Optional host streaming transport, with the same publication and cancellation guarantees. */
  publishStream?(
    input: ArtifactReadInput & {
      content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
      mediaType: string;
    },
  ): Promise<ArtifactReference>;
  publish(
    input: ArtifactReadInput & { content: Uint8Array; mediaType: string },
  ): Promise<ArtifactReference>;
  read(input: ArtifactReadInput): Promise<Uint8Array>;
  /** Fresh scope lookup must match the complete original reference before verified full-body I/O. */
  readReference?(input: ArtifactReferenceReadInput): Promise<Uint8Array>;
  close(): Promise<void>;
}
