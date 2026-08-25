import type {
  FilesystemPreimageArtifactRef,
  WorkspaceFilesystemMutationReadyRecord,
} from '@kite-ai/runtime-contract';

/** Protocol-first contract for the governed Workspace filesystem seam (ADR-0111). */

export const WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_ =
  'kite.workspace-filesystem-provider.v1' as const;

export type WorkspaceFilesystemPathScope = 'workspace_only' | 'external_read' | 'approved_external';

/** Policy-projected, JSON-safe path boundary mechanically enforced by Provider. */
export interface WorkspaceFilesystemProtectedBoundary {
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

interface WorkspaceFilesystemOperationBase {
  readonly path: string;
  readonly pathScope: WorkspaceFilesystemPathScope;
}

export interface WorkspaceReadFileOperation extends WorkspaceFilesystemOperationBase {
  readonly kind: 'read_file';
  readonly offset?: number;
  readonly limit?: number;
}

export interface WorkspaceSearchFilesOperation extends WorkspaceFilesystemOperationBase {
  readonly kind: 'search_files';
  readonly pattern: string;
}

export interface WorkspaceSearchContentOperation extends WorkspaceFilesystemOperationBase {
  readonly kind: 'search_content';
  readonly pattern: string;
  readonly glob?: string;
}

export interface WorkspaceWriteFileOperation extends WorkspaceFilesystemOperationBase {
  readonly kind: 'write_file';
  readonly content: string;
}

export interface WorkspaceEditFileOperation extends WorkspaceFilesystemOperationBase {
  readonly kind: 'edit_file';
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export type WorkspaceFilesystemObserveOperation =
  | WorkspaceReadFileOperation
  | WorkspaceSearchFilesOperation
  | WorkspaceSearchContentOperation;

export type WorkspaceFilesystemMutationOperation =
  | WorkspaceWriteFileOperation
  | WorkspaceEditFileOperation;

export type WorkspaceFilesystemOperation =
  | WorkspaceFilesystemObserveOperation
  | WorkspaceFilesystemMutationOperation;

/** Identity already authorized by Tool Pipeline. Provider implementations cannot widen it. */
export interface WorkspaceFilesystemGrantBinding {
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

export interface WorkspaceFilesystemStatIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
}

/** Immutable no-follow and followed identities captured by mutation preparation. */
export interface WorkspaceFilesystemTargetIdentity {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_;
  readonly lexicalPath: string;
  readonly resolvedPath: string;
  readonly canonicalPath: string;
  readonly exists: boolean;
  readonly noFollow: WorkspaceFilesystemStatIdentity | null;
  readonly followed: WorkspaceFilesystemStatIdentity | null;
  readonly nearestExistingCanonicalPath: string;
  readonly nearestExistingNoFollow: WorkspaceFilesystemStatIdentity;
}

export interface WorkspaceFilesystemPreimageObservation {
  readonly existed: boolean;
  readonly content: string | null;
  readonly contentDigest: string | null;
  readonly byteLength: number;
}

/** Digest-only target stamps suitable for Runtime state and receipts. */
export interface WorkspaceFilesystemTargetEvidence {
  readonly lexicalTargetDigest: string;
  readonly canonicalTargetDigest: string;
  readonly targetIdentityDigest: string;
}

interface WorkspaceFilesystemGrantBase extends WorkspaceFilesystemGrantBinding {
  readonly schema: typeof WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_;
  readonly grantId: string;
  readonly operation: WorkspaceFilesystemOperation;
  readonly operationDigest: string;
  readonly protectedBoundary: WorkspaceFilesystemProtectedBoundary;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface FilesystemObserveGrant extends WorkspaceFilesystemGrantBase {
  readonly purpose: 'observe';
  readonly operation: WorkspaceFilesystemObserveOperation;
}

export interface FilesystemPrepareGrant extends WorkspaceFilesystemGrantBase {
  readonly purpose: 'prepare_mutation';
  readonly operation: WorkspaceFilesystemMutationOperation;
}

export interface FilesystemCommitGrant extends WorkspaceFilesystemGrantBase {
  readonly purpose: 'commit_mutation';
  readonly operation: WorkspaceFilesystemMutationOperation;
  readonly preparedTargetIdentity: WorkspaceFilesystemTargetIdentity;
  readonly preparedTargetIdentityDigest: string;
  readonly preimageDigest: string | null;
  readonly preimageArtifact: FilesystemPreimageArtifactRef;
  readonly mutationReady: WorkspaceFilesystemMutationReadyRecord;
  readonly mutationReadyDigest: string;
}

export type WorkspaceFilesystemGrant =
  | FilesystemObserveGrant
  | FilesystemPrepareGrant
  | FilesystemCommitGrant;

/** Narrow private verifier consumed by the concrete Builtin filesystem Provider. */
export interface WorkspaceFilesystemGrantVerifier {
  verifyObserve(grant: FilesystemObserveGrant): Readonly<FilesystemObserveGrant>;
  verifyPrepare(grant: FilesystemPrepareGrant): Readonly<FilesystemPrepareGrant>;
  verifyAndConsumeCommit(grant: FilesystemCommitGrant): Readonly<FilesystemCommitGrant>;
}

export interface WorkspaceReadFileObservation {
  readonly kind: 'read_file';
  readonly target: WorkspaceFilesystemTargetIdentity;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidence;
  readonly content: string;
  readonly rawContent: string;
  readonly contentDigest: string;
  readonly totalLines: number;
  readonly fromLine: number;
  readonly toLine: number;
}

export interface WorkspaceSearchFilesObservation {
  readonly kind: 'search_files';
  readonly target: WorkspaceFilesystemTargetIdentity;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidence;
  readonly matches: readonly string[];
  readonly contentDigest: string;
}

export interface WorkspaceSearchContentMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface WorkspaceSearchContentObservation {
  readonly kind: 'search_content';
  readonly target: WorkspaceFilesystemTargetIdentity;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidence;
  readonly matches: readonly WorkspaceSearchContentMatch[];
  readonly contentDigest: string;
}

export type WorkspaceFilesystemObserveObservation =
  | WorkspaceReadFileObservation
  | WorkspaceSearchFilesObservation
  | WorkspaceSearchContentObservation;

export interface WorkspaceFilesystemPreparedMutation {
  readonly kind: 'prepared_mutation';
  readonly operationKind: WorkspaceFilesystemMutationOperation['kind'];
  readonly operationDigest: string;
  readonly target: WorkspaceFilesystemTargetIdentity;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidence;
  readonly targetIdentityDigest: string;
  readonly preimage: WorkspaceFilesystemPreimageObservation;
}

export interface WorkspaceFilesystemCommittedMutation {
  readonly kind: 'committed_mutation';
  readonly operationKind: WorkspaceFilesystemMutationOperation['kind'];
  readonly operationDigest: string;
  readonly target: WorkspaceFilesystemTargetIdentity;
  readonly targetEvidence: WorkspaceFilesystemTargetEvidence;
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

export type WorkspaceFilesystemProviderFailureCode =
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

export interface WorkspaceFilesystemProviderFailure {
  readonly code: WorkspaceFilesystemProviderFailureCode;
  readonly message: string;
}

export type WorkspaceFilesystemProviderResult<Observation> =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly failure: WorkspaceFilesystemProviderFailure };

export interface WorkspaceFilesystemProvider {
  observe(input: {
    readonly grant: FilesystemObserveGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemObserveObservation>>;

  prepareMutation(input: {
    readonly grant: FilesystemPrepareGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemPreparedMutation>>;

  commitMutation(input: {
    readonly grant: FilesystemCommitGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemCommittedMutation>>;
}
