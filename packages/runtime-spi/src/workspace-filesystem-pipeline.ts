import type { CapabilityArtifactRef } from '@kite/runtime-contract';
import type { RuntimeJsonValueV1 } from './contracts';
import type {
  PreparedToolInvocationV1,
  ToolPipelineAttemptAcknowledgementV1,
} from './tool-pipeline';
import type {
  FilesystemPreimageArtifactRefV1,
  WorkspaceEditFileOperationV1,
  WorkspaceFilesystemIntentRecordV1,
  WorkspaceFilesystemMutationReadyRecordV1,
  WorkspaceFilesystemObservationRecordV1,
  WorkspaceReadFileOperationV1,
  WorkspaceSearchContentOperationV1,
  WorkspaceSearchFilesOperationV1,
  WorkspaceWriteFileOperationV1,
} from './workspace-filesystem-provider';

/** Neutral post-ack contract for durable Workspace filesystem intent evidence. */
export const WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 =
  'kite.workspace-filesystem-pipeline.v1' as const;

/** Read operations are cut over before mutation; this union cannot admit a write. */
export type WorkspaceFilesystemReadOperationIdV1 =
  | 'builtin:read_file'
  | 'builtin:search_files'
  | 'builtin:search_content';

export type WorkspaceFilesystemReadOperationV1 =
  | (Readonly<WorkspaceReadFileOperationV1> & { readonly operationId: 'builtin:read_file' })
  | (Readonly<WorkspaceSearchFilesOperationV1> & {
      readonly operationId: 'builtin:search_files';
    })
  | (Readonly<WorkspaceSearchContentOperationV1> & {
      readonly operationId: 'builtin:search_content';
    });

/**
 * Builtin creates this draft only after its prepared-identity verifier has
 * accepted the exact Host-issued object. The raw lexical path remains solely
 * in `operation.path`; App must not resolve or canonicalize it.
 */
export interface WorkspaceFilesystemIntentDraftV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>;
  readonly operation: Readonly<WorkspaceFilesystemReadOperationV1>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecordV1>;
}

/**
 * Process-local result issued only by the persistence instance that recorded
 * this exact prepared attempt. Its JSON shape is never sufficient authority.
 */
export interface WorkspaceFilesystemPersistedIntentV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly status: 'durably_persisted';
  readonly prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>;
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly operation: Readonly<WorkspaceFilesystemReadOperationV1>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecordV1>;
}

export type WorkspaceFilesystemPersistedIntentVerificationResultV1 =
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
 * `ToolPipelinePersistenceV1.recordAttempt`. `persistIntent` must throw on a
 * false, thrown, or stale State write so Host records the acknowledged
 * attempt as unknown. Builtin must call `verifyPersistedIntent` immediately
 * before issuing a Provider grant; clones and cross-instance values fail.
 */
export interface WorkspaceFilesystemDurableEvidencePortV1 {
  readonly persistIntent: <
    TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
    TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  >(
    draft: Readonly<WorkspaceFilesystemIntentDraftV1<TArguments, TRequest>>,
  ) => Promise<Readonly<WorkspaceFilesystemPersistedIntentV1<TArguments, TRequest>>>;
  readonly verifyPersistedIntent: (
    intent: Readonly<WorkspaceFilesystemPersistedIntentV1>,
  ) => WorkspaceFilesystemPersistedIntentVerificationResultV1;
}

/**
 * Mutation operations stay in a separate closed union until their durable
 * ready/terminal route is connected. In particular, adding these ids here
 * cannot accidentally widen the read evidence port above.
 */
export type WorkspaceFilesystemMutationOperationIdV1 = 'builtin:write_file' | 'builtin:edit_file';

export type WorkspaceFilesystemMutationPipelineOperationV1 =
  | (Readonly<WorkspaceWriteFileOperationV1> & {
      readonly operationId: 'builtin:write_file';
    })
  | (Readonly<WorkspaceEditFileOperationV1> & {
      readonly operationId: 'builtin:edit_file';
    });

/** The mutation intent draft is created only after the exact Host attempt ack. */
export interface WorkspaceFilesystemMutationIntentDraftV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>;
  readonly operation: Readonly<WorkspaceFilesystemMutationPipelineOperationV1>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecordV1>;
}

/**
 * The returned value is a process-local capability, not a second attempt
 * authority. The acknowledgement is supplied by the App persistence owner
 * that already owns the exact prepared object; JSON-equivalent clones must be
 * rejected by that owner.
 */
export interface WorkspaceFilesystemPersistedMutationIntentV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly status: 'durably_persisted';
  readonly prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>;
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly operation: Readonly<WorkspaceFilesystemMutationPipelineOperationV1>;
  readonly record: Readonly<WorkspaceFilesystemIntentRecordV1>;
}

export type WorkspaceFilesystemPersistedMutationIntentVerificationResultV1 =
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
export interface WorkspaceFilesystemPreparedMutationEvidenceV1 {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
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
export interface WorkspaceFilesystemMutationReadyDraftV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly intent: Readonly<WorkspaceFilesystemPersistedMutationIntentV1<TArguments, TRequest>>;
  readonly preparedEvidence: Readonly<WorkspaceFilesystemPreparedMutationEvidenceV1>;
  readonly preimageArtifact: Readonly<FilesystemPreimageArtifactRefV1>;
  readonly record: Readonly<WorkspaceFilesystemMutationReadyRecordV1>;
}

export interface WorkspaceFilesystemPersistedMutationReadyV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly status: 'durably_persisted';
  readonly intent: Readonly<WorkspaceFilesystemPersistedMutationIntentV1<TArguments, TRequest>>;
  /** Opaque identity only; the Artifact contains no preimage content here. */
  readonly preimageArtifact: Readonly<FilesystemPreimageArtifactRefV1>;
  readonly record: Readonly<WorkspaceFilesystemMutationReadyRecordV1>;
}

export type WorkspaceFilesystemPersistedMutationReadyVerificationResultV1 =
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
export interface WorkspaceFilesystemMutationDurableEvidencePortV1 {
  readonly persistIntent: <
    TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
    TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  >(
    draft: Readonly<WorkspaceFilesystemMutationIntentDraftV1<TArguments, TRequest>>,
  ) => Promise<Readonly<WorkspaceFilesystemPersistedMutationIntentV1<TArguments, TRequest>>>;
  readonly verifyPersistedIntent: (
    intent: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
  ) => WorkspaceFilesystemPersistedMutationIntentVerificationResultV1;
  readonly persistMutationReady: <
    TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
    TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  >(
    draft: Readonly<WorkspaceFilesystemMutationReadyDraftV1<TArguments, TRequest>>,
  ) => Promise<Readonly<WorkspaceFilesystemPersistedMutationReadyV1<TArguments, TRequest>>>;
  readonly verifyPersistedMutationReady: (
    ready: Readonly<WorkspaceFilesystemPersistedMutationReadyV1>,
  ) => WorkspaceFilesystemPersistedMutationReadyVerificationResultV1;
}

/** Digest-only query facts used to bind edit_file to one authentic prior read. */
export interface WorkspaceFilesystemEditObservationQueryV1 {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1;
  readonly actorIdentityDigest: string;
  readonly lexicalTargetDigest: string;
}

export type WorkspaceFilesystemEditObservationQueryResultV1 =
  | {
      readonly status: 'found';
      readonly query: Readonly<WorkspaceFilesystemEditObservationQueryV1>;
      readonly invocationId: string;
      readonly attempt: number;
      readonly capabilityRevision: string;
      readonly resultDigest: string;
      readonly evidenceDigest: string;
      readonly artifact: Readonly<CapabilityArtifactRef>;
      readonly observation: Readonly<WorkspaceFilesystemObservationRecordV1>;
    }
  | {
      readonly status: 'missing';
      readonly code: 'read_required';
      readonly query: Readonly<WorkspaceFilesystemEditObservationQueryV1>;
    };

export type WorkspaceFilesystemEditObservationQueryVerificationResultV1 =
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
export interface WorkspaceFilesystemEditObservationPortV1 {
  readonly findLatestAuthenticRead: (
    query: Readonly<WorkspaceFilesystemEditObservationQueryV1>,
  ) => Promise<Readonly<WorkspaceFilesystemEditObservationQueryResultV1>>;
  readonly verifyLatestAuthenticRead: (
    result: Readonly<WorkspaceFilesystemEditObservationQueryResultV1>,
  ) => WorkspaceFilesystemEditObservationQueryVerificationResultV1;
}
