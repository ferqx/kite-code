/** Explicit Workspace file capabilities; importing this entry does not open files. */

export {
  type CheckpointSource,
  createFileCheckpointing,
  createScopedFileCheckpointing,
  type FileCheckpoint,
  type FileCheckpointBoundary,
  type FileCheckpointCaptureProof,
  type FileCheckpointOptions,
  type FileCheckpointPreview,
  type FileCheckpointReadContext,
  type FileCheckpointRecord,
  type FileCheckpointRecoveryBoundary,
  type FileCheckpointRestoreJournal,
  type FileCheckpointSelectedLineage,
} from './business/file-checkpoints';
export { filesNativeAssets } from './files-native-binding';
export {
  createWorkspaceFiles,
  type FileBaseline,
  type FileByteSnapshot,
  type FileChangePreview,
  type FileEntry,
  type FileIdentity,
  type FileRemoval,
  type FileSnapshot,
  type WorkspaceFiles,
} from './tools/files';
export type { FileMutationCapture } from './tools/files-tools';
export { createFileTools } from './tools/files-tools';
export { createPathFileTools } from './tools/path-files';
