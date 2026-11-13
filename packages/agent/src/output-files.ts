import type { ArtifactReference } from './storage/types';

export interface OutputDirectoryIdentity {
  path: string;
  canonical: string;
  device: string;
  inode: string;
  mode: string;
  digest: string | null;
}

export interface OutputFileTarget {
  storeId: string;
  sessionId: string;
  fileId: string;
  locator:
    | { kind: 'delivery'; key: string }
    | { kind: 'legacy-operation'; executionId: string }
    | { kind: 'legacy-inherited'; key: string };
}
export interface OutputFileSummary extends OutputFileTarget {
  ownerRunId: string;
  name: string;
  mediaType: string;
  size: string;
  publishedAt: string;
}
export interface OutputFilesPage {
  scope: { storeId: string; sessionId: string };
  revision: string;
  items: OutputFileSummary[];
  collections: Array<{
    collectionId: string;
    revision: string;
    ownerRunId: string;
    state: 'pending' | 'failed' | 'ready';
    expectedCount: number | null;
    publishedCount: number;
    errorCode?: string;
    retryUntil?: string;
  }>;
  nextCursor?: string;
  nextCollectionCursor?: string;
}
export interface OutputFileRecord {
  fileId: string;
  collectionId: string | null;
  sourceRunId: string;
  sourceExecutionId: string;
  name: string;
  relativePath: string;
  mediaType: string;
  size: string;
  reference: ArtifactReference;
  publishedAt: string;
}
export interface OutputSourceIdentity {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}
export interface ExpectedOutputFile {
  relativePath: string;
  sourceIdentity: OutputSourceIdentity;
}
export interface OutputCollection {
  id: string;
  key: string;
  revision: string;
  source: {
    storeId: string;
    sessionId: string;
    subjectId: string;
    runId: string;
    runOriginSeq: string;
    producerExecutionId: string;
    producerToolExecutionId: string;
    producerResultRevision: string | null;
  };
  allocation: {
    identity: OutputDirectoryIdentity;
    outputIdentity: OutputDirectoryIdentity;
    outputRelativePath: 'out';
  };
  state: 'allocated' | 'pending' | 'ready' | 'failed';
  attempt: number;
  startCommandId: string | null;
  collectorExecutionId: string | null;
  expectedFiles: ExpectedOutputFile[] | null;
  publishedCount: number;
  errorCode: string | null;
  errors: Array<{ relativePath?: string; code: string }>;
  retryUntil: string | null;
  /** Private retention deadline, independent of whether retry is permitted. */
  cleanupAfter?: string;
}
export interface OutputScope {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
}
export interface OutputFilesQuery extends OutputScope {
  runId?: string;
  beforeKey?: string;
  collectionBeforeKey?: string;
  limit?: number;
}
export const outputCollectionLimits = Object.freeze({
  files: 100,
  entries: 1000,
  depth: 8,
  fileBytes: 256 * 1024 * 1024,
  batchBytes: 1024 * 1024 * 1024,
});
export type OutputCollectionMutation =
  | { kind: 'bind'; collectionId: string; attempt: number }
  | {
      kind: 'freeze';
      collectionId: string;
      expectedRevision: string;
      entries: ExpectedOutputFile[];
    }
  | { kind: 'commit'; collectionId: string; relativePath: string; reference: ArtifactReference }
  | {
      kind: 'settle';
      collectionId: string;
      expectedRevision: string;
      errors: OutputCollection['errors'];
    };
