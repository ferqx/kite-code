import type {
  CapabilityArtifactRef,
  FilesystemPreimageArtifactRef,
  WorkspaceFilesystemIntentRecord,
  WorkspaceFilesystemMutationReadyRecord,
  WorkspaceFilesystemObservationRecord,
} from '@kite-ai/runtime-contract';
import type { RuntimeJsonValue } from './capability';
import type { PreparedToolInvocation, ToolPipelineAttemptAcknowledgement } from './tool-pipeline';
import type {
  WorkspaceEditFileOperation,
  WorkspaceReadFileOperation,
  WorkspaceSearchContentOperation,
  WorkspaceSearchFilesOperation,
  WorkspaceWriteFileOperation,
} from './workspace-filesystem-provider';

/** Neutral post-ack contract for durable Workspace filesystem intent evidence. */
export const WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ =
  'kite.workspace-filesystem-pipeline.v1' as const;

/** Read operations are cut over before mutation; this union cannot admit a write. */
export type WorkspaceFilesystemReadOperationId =
  | 'builtin:read_file'
  | 'builtin:search_files'
  | 'builtin:search_content';

export type WorkspaceFilesystemReadOperation =
  | (Readonly<WorkspaceReadFileOperation> & { readonly operationId: 'builtin:read_file' })
  | (Readonly<WorkspaceSearchFilesOperation> & {
      readonly operationId: 'builtin:search_files';
    })
  | (Readonly<WorkspaceSearchContentOperation> & {
      readonly operationId: 'builtin:search_content';
    });

/**
 * Builtin creates this draft only after its prepared-identity verifier has
 * accepted the exact Host-issued object. The raw lexical path remains solely
 * in `operation.path`; App must not resolve or canonicalize it.
 */
export interface WorkspaceFilesystemIntentDraft<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>;
  readonly operation: Readonly<WorkspaceFilesystemReadOperation>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecord>;
}

/**
 * Process-local result issued only by the persistence instance that recorded
 * this exact prepared attempt. Its JSON shape is never sufficient authority.
 */
export interface WorkspaceFilesystemPersistedIntent<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly status: 'durably_persisted';
  readonly prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>;
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly operation: Readonly<WorkspaceFilesystemReadOperation>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecord>;
}

export type WorkspaceFilesystemPersistedIntentVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code:
        | 'intent_not_issued'
        | 'prepared_identity_mismatch'
        | 'attempt_identity_mismatch'
        | 'operation_identity_mismatch'
        | 'durable_state_mismatch';
    };

/**
 * App implements this port with the same prepared-to-ack map used by
 * `ToolPipelinePersistence.recordAttempt`. `persistIntent` must throw on a
 * false, thrown, or stale State write so Host records the acknowledged
 * attempt as unknown. Builtin must call `verifyPersistedIntent` immediately
 * before issuing a Provider grant; clones and cross-instance values fail.
 */
export interface WorkspaceFilesystemDurableEvidencePort {
  readonly persistIntent: <
    TArguments extends RuntimeJsonValue = RuntimeJsonValue,
    TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  >(
    draft: Readonly<WorkspaceFilesystemIntentDraft<TArguments, TRequest>>,
  ) => Promise<Readonly<WorkspaceFilesystemPersistedIntent<TArguments, TRequest>>>;
  readonly verifyPersistedIntent: (
    intent: Readonly<WorkspaceFilesystemPersistedIntent>,
  ) => WorkspaceFilesystemPersistedIntentVerificationResult;
}

/**
 * Mutation operations stay in a separate closed union until their durable
 * ready/terminal route is connected. In particular, adding these ids here
 * cannot accidentally widen the read evidence port above.
 */
export type WorkspaceFilesystemMutationOperationId = 'builtin:write_file' | 'builtin:edit_file';

export type WorkspaceFilesystemMutationPipelineOperation =
  | (Readonly<WorkspaceWriteFileOperation> & {
      readonly operationId: 'builtin:write_file';
    })
  | (Readonly<WorkspaceEditFileOperation> & {
      readonly operationId: 'builtin:edit_file';
    });

/** The mutation intent draft is created only after the exact Host attempt ack. */
export interface WorkspaceFilesystemMutationIntentDraft<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>;
  readonly operation: Readonly<WorkspaceFilesystemMutationPipelineOperation>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecord>;
}

/**
 * The returned value is a process-local capability, not a second attempt
 * authority. The acknowledgement is supplied by the App persistence owner
 * that already owns the exact prepared object; JSON-equivalent clones must be
 * rejected by that owner.
 */
export interface WorkspaceFilesystemPersistedMutationIntent<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly status: 'durably_persisted';
  readonly prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>;
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly operation: Readonly<WorkspaceFilesystemMutationPipelineOperation>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecord>;
}

export type WorkspaceFilesystemPersistedMutationIntentVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code:
        | 'intent_not_issued'
        | 'prepared_identity_mismatch'
        | 'acknowledgement_identity_mismatch'
        | 'attempt_identity_mismatch'
        | 'operation_identity_mismatch'
        | 'record_identity_mismatch'
        | 'durable_state_mismatch';
    };

/**
 * Neutral digest-only projection of the Provider's in-memory prepared
 * mutation. The full Provider DTO (target object and preimage content) never
 * crosses the App/SPI durable evidence boundary.
 */
export interface WorkspaceFilesystemPreparedMutationEvidence {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly operationKind: 'write_file' | 'edit_file';
  readonly operationDigest: string;
  readonly lexicalTargetDigest: string;
  readonly canonicalTargetDigest: string;
  readonly targetIdentityDigest: string;
  readonly preimageDigest: string | null;
  readonly preimageExisted: boolean;
  readonly preimageByteLength: number;
}

/**
 * Ready persistence receives only the digest projection and opaque preimage
 * Artifact ref. The App implementation must bind the prepared evidence,
 * Artifact ref, intent, acknowledgement, and ready record in one process-local
 * authority; structural or digest-equivalent clones are not sufficient.
 */
export interface WorkspaceFilesystemMutationReadyDraft<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly intent: Readonly<WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest>>;
  readonly preparedEvidence: Readonly<WorkspaceFilesystemPreparedMutationEvidence>;
  readonly preimageArtifact: Readonly<FilesystemPreimageArtifactRef>;
  readonly record: Readonly<WorkspaceFilesystemMutationReadyRecord>;
}

export interface WorkspaceFilesystemPersistedMutationReady<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly status: 'durably_persisted';
  readonly intent: Readonly<WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest>>;
  /** Opaque identity only; the Artifact contains no preimage content here. */
  readonly preimageArtifact: Readonly<FilesystemPreimageArtifactRef>;
  readonly record: Readonly<WorkspaceFilesystemMutationReadyRecord>;
}

export type WorkspaceFilesystemPersistedMutationReadyVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code:
        | 'ready_not_issued'
        | 'intent_identity_mismatch'
        | 'prepared_identity_mismatch'
        | 'acknowledgement_identity_mismatch'
        | 'operation_identity_mismatch'
        | 'target_identity_mismatch'
        | 'preimage_identity_mismatch'
        | 'artifact_identity_mismatch'
        | 'ready_identity_mismatch'
        | 'durable_state_mismatch';
    };

/** Mutation intent and ready persistence remain a callback surface, not Store authority. */
export interface WorkspaceFilesystemMutationDurableEvidencePort {
  readonly persistIntent: <
    TArguments extends RuntimeJsonValue = RuntimeJsonValue,
    TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  >(
    draft: Readonly<WorkspaceFilesystemMutationIntentDraft<TArguments, TRequest>>,
  ) => Promise<Readonly<WorkspaceFilesystemPersistedMutationIntent<TArguments, TRequest>>>;
  readonly verifyPersistedIntent: (
    intent: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
  ) => WorkspaceFilesystemPersistedMutationIntentVerificationResult;
  readonly persistMutationReady: <
    TArguments extends RuntimeJsonValue = RuntimeJsonValue,
    TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  >(
    draft: Readonly<WorkspaceFilesystemMutationReadyDraft<TArguments, TRequest>>,
  ) => Promise<Readonly<WorkspaceFilesystemPersistedMutationReady<TArguments, TRequest>>>;
  readonly verifyPersistedMutationReady: (
    ready: Readonly<WorkspaceFilesystemPersistedMutationReady>,
  ) => WorkspaceFilesystemPersistedMutationReadyVerificationResult;
}

/** Digest-only query facts used to bind edit_file to one authentic prior read. */
export interface WorkspaceFilesystemEditObservationQuery {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_;
  readonly actorIdentityDigest: string;
  readonly lexicalTargetDigest: string;
}

export type WorkspaceFilesystemEditObservationQueryResult =
  | {
      readonly status: 'found';
      readonly query: Readonly<WorkspaceFilesystemEditObservationQuery>;
      readonly invocationId: string;
      readonly attempt: number;
      readonly capabilityRevision: string;
      readonly resultDigest: string;
      readonly evidenceDigest: string;
      readonly artifact: Readonly<CapabilityArtifactRef>;
      readonly observation: Readonly<WorkspaceFilesystemObservationRecord>;
    }
  | {
      readonly status: 'missing';
      readonly code: 'read_required';
      readonly query: Readonly<WorkspaceFilesystemEditObservationQuery>;
    };

export type WorkspaceFilesystemEditObservationQueryVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code:
        | 'query_result_not_issued'
        | 'query_identity_mismatch'
        | 'observation_identity_mismatch'
        | 'durable_state_mismatch';
    };

/**
 * App queries State/Store for the latest successful same-actor read. It
 * returns digest-only evidence; Builtin remains the owner of reading its
 * private Artifact and applying edit semantics. The returned object is
 * process-local authority and must be checked before use.
 */
export interface WorkspaceFilesystemEditObservationPort {
  readonly findLatestAuthenticRead: (
    query: Readonly<WorkspaceFilesystemEditObservationQuery>,
  ) => Promise<Readonly<WorkspaceFilesystemEditObservationQueryResult>>;
  readonly verifyLatestAuthenticRead: (
    result: Readonly<WorkspaceFilesystemEditObservationQueryResult>,
  ) => WorkspaceFilesystemEditObservationQueryVerificationResult;
}
