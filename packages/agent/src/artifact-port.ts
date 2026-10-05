import type { ArtifactReference, ArtifactScope } from './storage/types';

export interface ArtifactReadInput {
  expectedStoreId: string;
  refId: string;
  sessionId: string;
  subjectId: string;
  scope: ArtifactScope;
}
/** Host I/O port; the core imports no filesystem implementation. */
export interface ArtifactContentStore {
  publish(
    input: ArtifactReadInput & { content: Uint8Array; mediaType: string },
  ): Promise<ArtifactReference>;
  read(input: ArtifactReadInput): Promise<Uint8Array>;
  close(): Promise<void>;
}
