import type {
  FilesystemPreimageArtifactRefV1 as RuntimeFilesystemPreimageArtifactRefV1,
  WorkspaceFilesystemIntentRecordV1 as RuntimeWorkspaceFilesystemIntentRecordV1,
  WorkspaceFilesystemMutationReadyRecordV1 as RuntimeWorkspaceFilesystemMutationReadyRecordV1,
  WorkspaceFilesystemObservationRecordV1 as RuntimeWorkspaceFilesystemObservationRecordV1,
} from '@kite/runtime-contract';

/** Compatibility exports; the durable shapes are owned by Runtime Contract. */
export type FilesystemPreimageArtifactRefV1 = RuntimeFilesystemPreimageArtifactRefV1;
export type WorkspaceFilesystemIntentRecordV1 = RuntimeWorkspaceFilesystemIntentRecordV1;
export type WorkspaceFilesystemMutationReadyRecordV1 =
  RuntimeWorkspaceFilesystemMutationReadyRecordV1;
export type WorkspaceFilesystemObservationRecordV1 = RuntimeWorkspaceFilesystemObservationRecordV1;

/** Protocol-first contract for the governed Workspace filesystem seam (ADR-0111). */

export const WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1 =
  'kite.workspace-filesystem-provider.v1' as const;

export type WorkspaceFilesystemPathScopeV1 =
  | 'workspace_only'
  | 'external_read'
  | 'approved_external';

/** Policy-projected, JSON-safe path boundary mechanically enforced by Provider. */
export interface WorkspaceFilesystemProtectedBoundaryV1 {
  readonly schema: 'kite.workspace-filesystem-protected-boundary.v1';
  readonly canonicalWorkspace: string;
  readonly policyMode: 'deny' | 'prompt';
  readonly excludedSubtrees: readonly string[];
  readonly excludedFiles: readonly string[];
  readonly excludedFilePrefixes: readonly string[];
  readonly additionalDeniedCanonicalPaths: readonly string[];
  readonly allowedCanonicalPaths: readonly string[];
  readonly boundaryDigest: string;
}

interface WorkspaceFilesystemOperationBaseV1 {
  readonly path: string;
  readonly pathScope: WorkspaceFilesystemPathScopeV1;
}

export interface WorkspaceReadFileOperationV1 extends WorkspaceFilesystemOperationBaseV1 {
  readonly kind: 'read_file';
  readonly offset?: number;
  readonly limit?: number;
}

export interface WorkspaceSearchFilesOperationV1 extends WorkspaceFilesystemOperationBaseV1 {
  readonly kind: 'search_files';
  readonly pattern: string;
}

export interface WorkspaceSearchContentOperationV1 extends WorkspaceFilesystemOperationBaseV1 {
  readonly kind: 'search_content';
  readonly pattern: string;
  readonly glob?: string;
}

export interface WorkspaceWriteFileOperationV1 extends WorkspaceFilesystemOperationBaseV1 {
  readonly kind: 'write_file';
  readonly content: string;
}

export interface WorkspaceEditFileOperationV1 extends WorkspaceFilesystemOperationBaseV1 {
  readonly kind: 'edit_file';
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export type WorkspaceFilesystemObserveOperationV1 =
  | WorkspaceReadFileOperationV1
  | WorkspaceSearchFilesOperationV1
  | WorkspaceSearchContentOperationV1;

export type WorkspaceFilesystemMutationOperationV1 =
  | WorkspaceWriteFileOperationV1
  | WorkspaceEditFileOperationV1;

export type WorkspaceFilesystemOperationV1 =
  | WorkspaceFilesystemObserveOperationV1
  | WorkspaceFilesystemMutationOperationV1;

/** Identity already authorized by Tool Pipeline. Provider implementations cannot widen it. */
export interface WorkspaceFilesystemGrantBindingV1 {
  readonly threadId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly intentDigest: string;
  readonly searchBoundaryDigest: string | null;
  readonly capabilityRevision: string;
  readonly effectDigest: string;
  readonly canonicalWorkspace: string;
  readonly protectedPathRevision: string;
  readonly approvalSummary: string;
}

export interface WorkspaceFilesystemStatIdentityV1 {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
}

/** Immutable no-follow and followed identities captured by mutation preparation. */
export interface WorkspaceFilesystemTargetIdentityV1 {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1;
  readonly lexicalPath: string;
  readonly resolvedPath: string;
  readonly canonicalPath: string;
  readonly exists: boolean;
  readonly noFollow: WorkspaceFilesystemStatIdentityV1 | null;
  readonly followed: WorkspaceFilesystemStatIdentityV1 | null;
  readonly nearestExistingCanonicalPath: string;
  readonly nearestExistingNoFollow: WorkspaceFilesystemStatIdentityV1;
}

export interface WorkspaceFilesystemPreimageObservationV1 {
  readonly existed: boolean;
  readonly content: string | null;
  readonly contentDigest: string | null;
  readonly byteLength: number;
}

/** Digest-only target stamps suitable for Runtime state and receipts. */
export interface WorkspaceFilesystemTargetEvidenceV1 {
  readonly lexicalTargetDigest: string;
  readonly canonicalTargetDigest: string;
  readonly targetIdentityDigest: string;
}

interface WorkspaceFilesystemGrantBaseV1 extends WorkspaceFilesystemGrantBindingV1 {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1;
  readonly grantId: string;
  readonly operation: WorkspaceFilesystemOperationV1;
  readonly operationDigest: string;
  readonly protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface FilesystemObserveGrantV1 extends WorkspaceFilesystemGrantBaseV1 {
  readonly purpose: 'observe';
  readonly operation: WorkspaceFilesystemObserveOperationV1;
}

export interface FilesystemPrepareGrantV1 extends WorkspaceFilesystemGrantBaseV1 {
  readonly purpose: 'prepare_mutation';
  readonly operation: WorkspaceFilesystemMutationOperationV1;
}

export interface FilesystemCommitGrantV1 extends WorkspaceFilesystemGrantBaseV1 {
  readonly purpose: 'commit_mutation';
  readonly operation: WorkspaceFilesystemMutationOperationV1;
  readonly preparedTargetIdentity: WorkspaceFilesystemTargetIdentityV1;
  readonly preparedTargetIdentityDigest: string;
  readonly preimageDigest: string | null;
  readonly preimageArtifact: FilesystemPreimageArtifactRefV1;
  readonly mutationReady: WorkspaceFilesystemMutationReadyRecordV1;
  readonly mutationReadyDigest: string;
}

export type WorkspaceFilesystemGrantV1 =
  | FilesystemObserveGrantV1
  | FilesystemPrepareGrantV1
  | FilesystemCommitGrantV1;

/** Narrow private verifier consumed by the concrete Builtin filesystem Provider. */
export interface WorkspaceFilesystemGrantVerifierV1 {
  verifyObserve(grant: FilesystemObserveGrantV1): Readonly<FilesystemObserveGrantV1>;
  verifyPrepare(grant: FilesystemPrepareGrantV1): Readonly<FilesystemPrepareGrantV1>;
  verifyAndConsumeCommit(grant: FilesystemCommitGrantV1): Readonly<FilesystemCommitGrantV1>;
}

export interface WorkspaceReadFileObservationV1 {
  readonly kind: 'read_file';
  readonly target: WorkspaceFilesystemTargetIdentityV1;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidenceV1;
  readonly content: string;
  readonly rawContent: string;
  readonly contentDigest: string;
  readonly totalLines: number;
  readonly fromLine: number;
  readonly toLine: number;
}

export interface WorkspaceSearchFilesObservationV1 {
  readonly kind: 'search_files';
  readonly target: WorkspaceFilesystemTargetIdentityV1;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidenceV1;
  readonly matches: readonly string[];
  readonly contentDigest: string;
}

export interface WorkspaceSearchContentMatchV1 {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface WorkspaceSearchContentObservationV1 {
  readonly kind: 'search_content';
  readonly target: WorkspaceFilesystemTargetIdentityV1;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidenceV1;
  readonly matches: readonly WorkspaceSearchContentMatchV1[];
  readonly contentDigest: string;
}

export type WorkspaceFilesystemObserveObservationV1 =
  | WorkspaceReadFileObservationV1
  | WorkspaceSearchFilesObservationV1
  | WorkspaceSearchContentObservationV1;

export interface WorkspaceFilesystemPreparedMutationV1 {
  readonly kind: 'prepared_mutation';
  readonly operationKind: WorkspaceFilesystemMutationOperationV1['kind'];
  readonly operationDigest: string;
  readonly target: WorkspaceFilesystemTargetIdentityV1;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidenceV1;
  readonly targetIdentityDigest: string;
  readonly preimage: WorkspaceFilesystemPreimageObservationV1;
}

export interface WorkspaceFilesystemCommittedMutationV1 {
  readonly kind: 'committed_mutation';
  readonly operationKind: WorkspaceFilesystemMutationOperationV1['kind'];
  readonly operationDigest: string;
  readonly target: WorkspaceFilesystemTargetIdentityV1;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidenceV1;
  readonly beforeContentDigest: string | null;
  readonly afterContentDigest: string;
  readonly changed: boolean;
  readonly created: boolean;
  readonly content: string;
  readonly lines: number;
  readonly fromLine?: number;
  readonly toLine?: number;
  readonly replacements?: number;
  readonly matchLines?: readonly number[];
}

export type WorkspaceFilesystemProviderFailureCodeV1 =
  | 'invalid_grant'
  | 'expired_grant'
  | 'consumed_grant'
  | 'cancelled'
  | 'workspace_mismatch'
  | 'path_invalid'
  | 'path_outside_workspace'
  | 'not_found'
  | 'not_a_file'
  | 'not_a_directory'
  | 'binary_file'
  | 'observation_too_large'
  | 'read_required'
  | 'stale_read'
  | 'edit_not_found'
  | 'edit_ambiguous'
  | 'stale_preimage'
  | 'operation_failed'
  | 'fake_denied'
  | 'fake_crashed';

export interface WorkspaceFilesystemProviderFailureV1 {
  readonly code: WorkspaceFilesystemProviderFailureCodeV1;
  readonly message: string;
}

export type WorkspaceFilesystemProviderResultV1<Observation> =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly failure: WorkspaceFilesystemProviderFailureV1 };

export interface WorkspaceFilesystemProviderV1 {
  observe(input: {
    readonly grant: FilesystemObserveGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemObserveObservationV1>>;

  prepareMutation(input: {
    readonly grant: FilesystemPrepareGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemPreparedMutationV1>>;

  commitMutation(input: {
    readonly grant: FilesystemCommitGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemCommittedMutationV1>>;
}
