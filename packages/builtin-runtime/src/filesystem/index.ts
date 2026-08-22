export type { WorkspaceFilesystemGrantVerifierV1 } from '@kite/runtime-spi';
export {
  assertDescriptorRelativeMutationSupportedV1,
  atomicReplaceInLockedWindowsDirectoryV1,
  closeOpenedDirectoryChainV1,
  type DescriptorRelativeDirectoryChainV1,
  openExclusiveFileAtV1,
  openOrCreateDirectoryChainAtV1,
  renameAtV1,
  unlinkAtV1,
} from './descriptor-relative';
export {
  computeLineDiff,
  type DiffLine,
  type DiffResult,
  formatContentOutput,
  formatDiffOutput,
  formatMultiHunkDiff,
} from './diff';
export {
  validateWorkspaceFilesystemIntentRecordV1,
  validateWorkspaceFilesystemMutationReadyRecordV1,
  validateWorkspaceFilesystemObservationRecordV1,
  workspaceFilesystemIntentDigestV1,
  workspaceFilesystemMutationReadyDigestV1,
} from './evidence';
export {
  validateWorkspaceFilesystemOperationV1,
  type WorkspaceFilesystemGrantAuthorityOptionsV1,
  WorkspaceFilesystemGrantAuthorityV1,
  WorkspaceFilesystemGrantErrorV1,
  workspaceFilesystemContentHashV1,
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
  workspaceFilesystemStringDigestV1,
  workspaceFilesystemTargetEvidenceV1,
  workspaceFilesystemTargetIdentityDigestV1,
} from './grant-authority';
export {
  type LocalWorkspaceFilesystemProviderOptionsV1,
  LocalWorkspaceFilesystemProviderV1,
} from './local-provider';
export type {
  BuiltinWorkspaceFilesystemCheckpointProjectionV1,
  BuiltinWorkspaceFilesystemMutationDispatchErrorCodeV1,
  CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1,
} from './mutation-dispatcher';
export {
  BuiltinWorkspaceFilesystemMutationCommitUnknownErrorV1,
  BuiltinWorkspaceFilesystemMutationDispatchErrorV1,
  createBuiltinWorkspaceFilesystemMutationDispatcherV1,
} from './mutation-dispatcher';
export type {
  BuiltinWorkspaceFilesystemObservationAuthorityErrorCodeV1,
  BuiltinWorkspaceFilesystemTerminalVerificationResultV1,
  BuiltinWorkspaceFilesystemTerminalVerifierV1,
} from './observation-authority';
export {
  BuiltinWorkspaceFilesystemObservationAuthorityErrorV1,
  verifyBuiltinWorkspaceFilesystemTerminalV1,
} from './observation-authority';
export {
  type FilesystemPreimageArtifactErrorCodeV1,
  FilesystemPreimageArtifactErrorV1,
  type FilesystemPreimageArtifactPayloadV1,
  type FilesystemPreimageArtifactStoreOptionsV1,
  FilesystemPreimageArtifactStoreV1,
  type FilesystemPreimageArtifactWriterV1,
  filesystemPreimageArtifactRootV1,
} from './preimage-artifacts';
export {
  projectionDigest,
  truncateProjectedLines,
  truncateProjectedOutput,
  truncateProjectedStreams,
} from './projection';
export type {
  BuiltinWorkspaceFilesystemActorIdentityV1,
  BuiltinWorkspaceFilesystemReadDispatchErrorCodeV1,
  CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1,
} from './read-dispatcher';
export {
  BuiltinWorkspaceFilesystemReadDispatchErrorV1,
  createBuiltinWorkspaceFilesystemReadDispatcherV1,
} from './read-dispatcher';
export type {
  BuiltinWorkspaceFilesystemInvocationDispatcherV1,
  BuiltinWorkspaceFilesystemPipelineObservationV1,
  BuiltinWorkspaceFilesystemPipelineResultV1,
  BuiltinWorkspaceFilesystemRuntimeV1,
} from './runtime-composition';
