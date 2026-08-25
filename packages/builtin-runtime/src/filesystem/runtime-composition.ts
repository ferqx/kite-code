import type { WorkspaceFilesystemObservationRecord } from '@kite-ai/runtime-contract';
import type {
  WorkspaceFilesystemCommittedMutation,
  WorkspaceFilesystemObserveObservation,
  WorkspaceFilesystemOperation,
  WorkspaceFilesystemPreimageObservation,
  WorkspaceFilesystemProvider,
  WorkspaceFilesystemProviderFailure,
} from '@kite-ai/runtime-spi';
import type { CapabilityArtifactReader } from '../capability-artifacts';
import type { WorkspaceFilesystemGrantAuthority } from './grant-authority';
import type { FilesystemPreimageArtifactWriter } from './preimage-artifacts';

/**
 * Provider-neutral filesystem composition consumed by the Builtin filesystem
 * semantics. Persistence and Host attempt authority are intentionally absent.
 */
export interface BuiltinWorkspaceFilesystemRuntime {
  readonly canonicalWorkspace: string;
  readonly provider: WorkspaceFilesystemProvider;
  readonly grants: WorkspaceFilesystemGrantAuthority;
  readonly preimageArtifacts: FilesystemPreimageArtifactWriter;
  /** Required for edit admission; absence or corrupt evidence fails closed. */
  readonly capabilityArtifacts?: CapabilityArtifactReader;
  readonly grantTtlMs?: number;
}

export type BuiltinWorkspaceFilesystemPipelineObservation =
  | WorkspaceFilesystemObserveObservation
  | WorkspaceFilesystemCommittedMutation;

export type BuiltinWorkspaceFilesystemPipelineResult =
  | {
      readonly ok: true;
      readonly observation: BuiltinWorkspaceFilesystemPipelineObservation;
      readonly filesystemObservation?: WorkspaceFilesystemObservationRecord;
      readonly preimage?: WorkspaceFilesystemPreimageObservation;
    }
  | { readonly ok: false; readonly failure: WorkspaceFilesystemProviderFailure };

/** Neutral Builtin filesystem mechanism injected after Host attempt acknowledgement. */
export interface BuiltinWorkspaceFilesystemInvocationDispatcher {
  dispatch(
    operation: WorkspaceFilesystemOperation,
  ): Promise<BuiltinWorkspaceFilesystemPipelineResult>;
}
