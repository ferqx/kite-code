import type { ArtifactRef, PublicExecution, ReadContext, ToolContext } from '../../extensions';
import type { FileBaseline } from '../../tools/files';

export interface FileCheckpointBoundary {
  storeId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  contextSelectionId: string;
  messageId: string | null;
  messageSeq: string;
  triggerMessageId: string;
  triggerSeq: string;
}
export interface FileCheckpointCaptureProof {
  boundary: FileCheckpointBoundary;
  modelExecutionId: string;
  modelInputHash: string;
}
export interface FileCheckpointSelectedLineage {
  /** Current Store observation; each original checkpoint preserves its own origin Store. */
  storeId: string;
  workspaceId: string;
  sessionId: string;
  contextSelectionId: string;
  upperSeq: string;
  messages: readonly { id: string; seq: string }[];
}
/** Current selected Message identities for an original point; no execution or restore grant. */
export interface FileCheckpointRecoveryBoundary {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  contextSelectionId: string;
  checkpoint: FileCheckpoint;
  boundary: { messageId: string; seq: string } | null;
  trigger: { messageId: string; seq: string };
}
export interface FileCheckpointOptions {
  workspace: { id: string; root: string };
  maxBytes: number;
  protectedPaths: readonly string[];
  /** Trusted host opt-in: ordinary read/list/search/glob and mutations share the protected scope. */
  protectReads?: boolean;
  /** Actual Store/Session/Workspace/Run/selected complete Message proof, never user JSON. */
  readBoundary?: (
    context: ToolContext,
    actual: Readonly<PublicExecution>,
  ) => Promise<FileCheckpointCaptureProof>;
  readSelectedLineage?: (
    context: ReadContext,
    point: FileCheckpoint,
  ) => Promise<FileCheckpointSelectedLineage>;
  verifyCaptureSource?: (
    context: ReadContext,
    point: FileCheckpoint,
    source: Readonly<CheckpointSource>,
  ) => Promise<void>;
}
export interface CheckpointSource {
  executionId: string;
  runId: string;
  definitionId: string;
  definitionVersion: string;
  attempt: number;
  inputDigest: string;
  modelExecutionId: string;
  modelInputHash: string;
}
export interface CheckpointPreimage {
  source: CheckpointSource;
  baseline: FileBaseline | null;
  artifact: ArtifactRef | null;
}
export interface FileCheckpoint {
  id: string;
  boundary: FileCheckpointBoundary;
  workspace: { device: string; inode: string };
}
export interface FileCheckpointRecord {
  checkpointId: string;
  path: string;
  first: CheckpointPreimage | null;
  last: { source: CheckpointSource; baseline: FileBaseline } | null;
  pending: CheckpointPreimage | null;
  state: 'pending' | 'captured' | 'failed' | 'unknown';
}
export interface FileCheckpointPreview {
  checkpoint: FileCheckpoint;
  files: {
    path: string;
    recordRevision: string;
    status: 'restore' | 'remove' | 'unchanged' | 'conflict' | 'unavailable';
    reason: string | null;
    preimage: ArtifactRef | null;
    original: FileBaseline | null;
    expected: FileBaseline | null;
  }[];
}
export interface FileCheckpointRestoreJournal {
  id: string;
  checkpointId: string;
  executionId: string;
  planDigest: string;
  /** Sequence of the actual runless carrier in its original Session. */
  rootWorkSeq: string;
  phase: 'restoring' | 'restored' | 'failed' | 'outcome_unknown';
  files: {
    path: string;
    operation: 'restore' | 'remove' | 'unchanged';
    state:
      | 'not_started'
      | 'pending'
      | 'restored'
      | 'removed'
      | 'unchanged'
      | 'failed'
      | 'outcome_unknown';
    expected: FileBaseline | null;
    original: FileBaseline | null;
    preimage: ArtifactRef | null;
    /** Actual confirmed post-IO result; null is unconfirmed, { baseline: null } is confirmed missing. */
    confirmedPost: { baseline: FileBaseline | null } | null;
    error: string | null;
  }[];
}
/** Original metadata saved by the trusted rule; contains no executable Fork provenance. */
export type FileCheckpointSnapshotRecord = Omit<
  import('../../extensions').ExtensionRecord,
  'forkProvenance'
>;
export type FileCheckpointForkEvent =
  | {
      kind: 'capture';
      point: FileCheckpointSnapshotRecord;
      head: FileCheckpointSnapshotRecord;
      files: FileCheckpointSnapshotRecord[];
    }
  | {
      kind: 'restore';
      journal: FileCheckpointSnapshotRecord;
      effects: FileCheckpointSnapshotRecord[];
    };
export interface FileCheckpointForkSnapshot {
  events: FileCheckpointForkEvent[];
}
export interface FileCheckpointRestoreEffect {
  restoreId: string;
  checkpointId: string;
  executionId: string;
  rootWorkSeq: string;
  path: string;
  expected: FileBaseline | null;
  beforeImage: ArtifactRef | null;
  confirmedPost: { baseline: FileBaseline | null } | null;
  state: 'pending' | 'confirmed' | 'unknown';
}
export type FileCheckpointReadContext = ReadContext;
