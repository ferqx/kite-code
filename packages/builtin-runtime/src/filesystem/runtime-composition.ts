import type { WorkspaceFilesystemObservationRecordV1 } from '@kite/runtime-contract';
import type {
  WorkspaceFilesystemCommittedMutationV1,
  WorkspaceFilesystemObserveObservationV1,
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemPreimageObservationV1,
  WorkspaceFilesystemProviderFailureV1,
  WorkspaceFilesystemProviderV1,
} from '@kite/runtime-spi';
import type { CapabilityArtifactReaderV1 } from '../capability-artifacts';
import type { WorkspaceFilesystemGrantAuthorityV1 } from './grant-authority';
import type { FilesystemPreimageArtifactWriterV1 } from './preimage-artifacts';

/**
 * Provider-neutral filesystem composition consumed by the Builtin filesystem
 * semantics. Persistence and Host attempt authority are intentionally absent.
 */
export interface BuiltinWorkspaceFilesystemRuntimeV1 {
  readonly canonicalWorkspace: string;
  readonly provider: WorkspaceFilesystemProviderV1;
  readonly grants: WorkspaceFilesystemGrantAuthorityV1;
  readonly preimageArtifacts: FilesystemPreimageArtifactWriterV1;
  /** Required for edit admission; absence or corrupt evidence fails closed. */
  readonly capabilityArtifacts?: CapabilityArtifactReaderV1;
  readonly grantTtlMs?: number;
}

export type BuiltinWorkspaceFilesystemPipelineObservationV1 =
  | WorkspaceFilesystemObserveObservationV1
  | WorkspaceFilesystemCommittedMutationV1;

export type BuiltinWorkspaceFilesystemPipelineResultV1 =
  | {
      readonly ok: true;
      readonly observation: BuiltinWorkspaceFilesystemPipelineObservationV1;
      readonly filesystemObservation?: WorkspaceFilesystemObservationRecordV1;
      readonly preimage?: WorkspaceFilesystemPreimageObservationV1;
    }
  | { readonly ok: false; readonly failure: WorkspaceFilesystemProviderFailureV1 };

/** Neutral Builtin filesystem mechanism injected after Host attempt acknowledgement. */
export interface BuiltinWorkspaceFilesystemInvocationDispatcherV1 {
  dispatch(
    operation: WorkspaceFilesystemOperationV1,
  ): Promise<BuiltinWorkspaceFilesystemPipelineResultV1>;
}
