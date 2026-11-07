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
export { pdfAssets } from './tools/documents/pdf';
export { withExternalFileReads } from './tools/external-file-reads';
export {
  createWorkspaceFiles,
  type FileBaseline,
  type FileByteSnapshot,
  type FileChangePreview,
  type FileEntry,
  type FileIdentity,
  type FileRemoval,
  type FileSearchInput,
  type FileSearchMatch,
  type FileSearchResult,
  type FileSnapshot,
  type WorkspaceFiles,
} from './tools/files';
export { createFileToolBehaviors } from './tools/files-approval';
export type { FileMutationCapture } from './tools/files-tools';
export { createFileTools } from './tools/files-tools';
export { withFullAccessFiles } from './tools/full-access-files';
export { imageAssets } from './tools/images/processor';
export { createImageFileReads } from './tools/images/reader';
export { createViewImagesTool } from './tools/images/tool';
export { withInputFileReads } from './tools/input-files';
export { type EditablePlanFile, withPlanFileTools } from './tools/plan-files';
export {
  isManagedWorkingFilePath,
  isSessionOutputName,
  isSessionOutputPath,
} from './tools/session-output-path';
export { type SessionOutput, withSessionOutputs } from './tools/session-outputs';
