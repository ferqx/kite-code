export type { WorkspaceFilesystemGrantVerifier } from '@kite/runtime-spi';
export {
  assertDescriptorRelativeMutationSupported,
  atomicReplaceInLockedWindowsDirectory,
  closeOpenedDirectoryChain,
  type DescriptorRelativeDirectoryChain,
  openExclusiveFileAt,
  openOrCreateDirectoryChainAt,
  renameAt,
  unlinkAt,
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
  validateWorkspaceFilesystemIntentRecord,
  validateWorkspaceFilesystemMutationReadyRecord,
  validateWorkspaceFilesystemObservationRecord,
  workspaceFilesystemIntentDigest,
  workspaceFilesystemMutationReadyDigest,
} from './evidence';
export {
  validateWorkspaceFilesystemOperation,
  WorkspaceFilesystemGrantAuthority,
  type WorkspaceFilesystemGrantAuthorityOptions,
  WorkspaceFilesystemGrantError,
  workspaceFilesystemContentHash,
  workspaceFilesystemOperationDigest,
  workspaceFilesystemProtectedBoundaryDigest,
  workspaceFilesystemStringDigest,
  workspaceFilesystemTargetEvidence,
  workspaceFilesystemTargetIdentityDigest,
} from './grant-authority';
export {
  LocalWorkspaceFilesystemProvider,
  type LocalWorkspaceFilesystemProviderOptions,
} from './local-provider';
export type {
  BuiltinWorkspaceFilesystemMutationDispatchErrorCode,
  BuiltinWorkspaceFilesystemRewindProjection,
  CreateBuiltinWorkspaceFilesystemMutationDispatcherInput,
} from './mutation-dispatcher';
export {
  BuiltinWorkspaceFilesystemMutationCommitUnknownError,
  BuiltinWorkspaceFilesystemMutationDispatchError,
  createBuiltinWorkspaceFilesystemMutationDispatcher,
} from './mutation-dispatcher';
export type {
  BuiltinWorkspaceFilesystemObservationAuthorityErrorCode,
  BuiltinWorkspaceFilesystemTerminalVerificationResult,
  BuiltinWorkspaceFilesystemTerminalVerifier,
} from './observation-authority';
export {
  BuiltinWorkspaceFilesystemObservationAuthorityError,
  verifyBuiltinWorkspaceFilesystemTerminal,
} from './observation-authority';
export {
  FilesystemPreimageArtifactError,
  type FilesystemPreimageArtifactErrorCode,
  type FilesystemPreimageArtifactPayload,
  FilesystemPreimageArtifactStore,
  type FilesystemPreimageArtifactStoreOptions,
  type FilesystemPreimageArtifactWriter,
  filesystemPreimageArtifactRoot,
} from './preimage-artifacts';
export {
  projectionDigest,
  truncateProjectedLines,
  truncateProjectedOutput,
  truncateProjectedStreams,
} from './projection';
export type {
  BuiltinWorkspaceFilesystemActorIdentity,
  BuiltinWorkspaceFilesystemReadDispatchErrorCode,
  CreateBuiltinWorkspaceFilesystemReadDispatcherInput,
} from './read-dispatcher';
export {
  BuiltinWorkspaceFilesystemReadDispatchError,
  createBuiltinWorkspaceFilesystemReadDispatcher,
} from './read-dispatcher';
export type {
  BuiltinWorkspaceFilesystemInvocationDispatcher,
  BuiltinWorkspaceFilesystemPipelineObservation,
  BuiltinWorkspaceFilesystemPipelineResult,
  BuiltinWorkspaceFilesystemRuntime,
} from './runtime-composition';
