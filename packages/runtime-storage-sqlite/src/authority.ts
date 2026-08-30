import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  assertSqliteRuntimeWorkspaceBinding,
  assertWorkspaceSqliteRuntimeStoreConnection,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';

/**
 * Store-owned Worker authority facts. The record is deliberately narrower
 * than Runtime State: it contains identity, generation and digest evidence,
 * never a command, capability, credential or effect result body.
 */
export const SQLITE_WORKSPACE_AUTHORITY_SCHEMA = 'kite.runtime-workspace-authority.v1' as const;
export const SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA =
  'kite.runtime-controller-operation-receipt.v1' as const;
export const SQLITE_WORKSPACE_EFFECT_EVIDENCE_SCHEMA = 'kite.runtime-effect-evidence.v1' as const;
export const SQLITE_WORKSPACE_RECOVERY_STATE_SCHEMA = 'kite.runtime-recovery-state.v1' as const;
export const SQLITE_WORKSPACE_RESOURCE_LEASE_SCHEMA = 'kite.runtime-resource-lease.v1' as const;
export const SQLITE_WORKSPACE_DETACHED_RECOVERY_SCHEMA =
  'kite.runtime-detached-recovery.v1' as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const AUTHORITY_META_PREFIX = 'workspace_authority_v1:';
const EFFECT_LEASE_PREFIX = 'workspace-authority-effect:';

export type SqliteWorkspaceControllerStatus = 'idle' | 'active' | 'detached';
export type SqliteWorkspaceRecoveryStatus = 'normal' | 'detached' | 'recovery_required';
export type SqliteWorkspaceControllerOperation =
  | 'request_control'
  | 'release_control'
  | 'detach_controller'
  | 'issue_resume_capability'
  | 'resume_controller'
  | 'mint_detached_recovery_capability'
  | 'abandon_detached_controller';

export type SqliteWorkspaceControllerOperationCode =
  | 'acquired'
  | 'released'
  | 'detached'
  | 'resume_capability_issued'
  | 'resumed'
  | 'detached_recovery_capability_issued'
  | 'abandoned'
  | 'controller_busy'
  | 'detached_requires_recovery'
  | 'stale_lease'
  | 'capability_invalid'
  | 'capability_expired'
  | 'capability_consumed'
  | 'recovery_generation_mismatch';

export type SqliteWorkspaceAuthorityErrorCode =
  | 'invalid_input'
  | 'ownership_mismatch'
  | 'idempotency_conflict'
  | 'corrupt'
  | 'stale_lease'
  | 'expired_lease'
  | 'capability_invalid'
  | 'capability_expired'
  | 'capability_consumed'
  | 'recovery_required'
  | 'unknown_result';

export class SqliteWorkspaceAuthorityError extends Error {
  readonly code: SqliteWorkspaceAuthorityErrorCode;

  constructor(code: SqliteWorkspaceAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'SqliteWorkspaceAuthorityError';
    this.code = code;
  }
}

export interface SqliteWorkspaceControllerLease {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  readonly status: Exclude<SqliteWorkspaceControllerStatus, 'idle'>;
}

export interface SqliteWorkspaceControllerState {
  readonly sessionId: string;
  readonly status: SqliteWorkspaceControllerStatus;
  readonly controllerGeneration: number;
  readonly connectionGeneration: number;
  readonly clientId: string | null;
  readonly workerInstanceId: string | null;
  readonly interactionGeneration: number;
  readonly resumeCapabilityExpiresAtMs: number | null;
}

export interface SqliteWorkspaceRecoveryState {
  readonly sessionId: string;
  readonly status: SqliteWorkspaceRecoveryStatus;
  readonly controllerGeneration: number;
  readonly interactionGeneration: number;
  readonly updatedAt: number;
}

export interface SqliteWorkspaceControllerOperationReceipt {
  readonly schema: typeof SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA;
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly operation: SqliteWorkspaceControllerOperation;
  readonly status: 'applied' | 'rejected';
  readonly code: SqliteWorkspaceControllerOperationCode;
  readonly controllerGeneration: number;
  readonly connectionGeneration: number;
  readonly interactionGeneration: number;
  readonly clientId: string | null;
  readonly workerInstanceId: string | null;
  readonly completedAt: number;
}

export type SqliteWorkspaceControllerOperationResult =
  | {
      readonly status: 'applied' | 'replay';
      readonly receipt: SqliteWorkspaceControllerOperationReceipt;
      readonly lease?: SqliteWorkspaceControllerLease;
    }
  | {
      readonly status: 'rejected';
      readonly receipt: SqliteWorkspaceControllerOperationReceipt;
    };

export interface SqliteWorkspaceControllerOperationInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
}

export interface SqliteWorkspaceRequestControlInput
  extends SqliteWorkspaceControllerOperationInput {
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly workerInstanceId: string;
  /** Caller-generated 32-byte base64url secret; only its hash is persisted. */
  readonly resumeSecret: string;
  readonly resumeExpiresAtMs: number;
}

/**
 * Controller facts for Store 7's atomic Runtime-session creation path.  This
 * is the same authenticated lease shape as requestControl; the storage
 * compound port computes controllerGeneration=1 and never accepts a caller
 * supplied generation.
 */
export interface SqliteWorkspaceInitialControllerInput extends SqliteWorkspaceRequestControlInput {}

export interface SqliteWorkspaceLeaseOwner {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
}

export interface SqliteWorkspaceReleaseControlInput
  extends SqliteWorkspaceControllerOperationInput,
    SqliteWorkspaceLeaseOwner {}

export interface SqliteWorkspaceDetachControllerInput extends SqliteWorkspaceReleaseControlInput {
  readonly interactionGeneration: number;
}

export interface SqliteWorkspaceIssueResumeCapabilityInput
  extends SqliteWorkspaceReleaseControlInput {
  /** Raw secret is caller-owned and is hashed before any SQLite write. */
  readonly secret: string;
  readonly expiresAtMs: number;
}

export interface SqliteWorkspaceResumeControllerInput
  extends SqliteWorkspaceControllerOperationInput {
  readonly clientId: string;
  readonly controllerGeneration: number;
  readonly connectionGeneration: number;
  readonly workerInstanceId: string;
  /** Raw old/new secrets never enter a persisted record or error message. */
  readonly currentSecret: string;
  readonly nextSecret: string;
  readonly expiresAtMs: number;
}

export interface SqliteWorkspaceResumeCapabilityValidationInput {
  readonly sessionId: string;
  readonly clientId: string;
  readonly controllerGeneration: number;
  readonly secret: string;
  readonly nowMs?: number;
}

export type SqliteWorkspaceResumeCapabilityValidation =
  | {
      readonly status: 'valid';
      readonly sessionId: string;
      readonly clientId: string;
      readonly controllerGeneration: number;
      readonly connectionGeneration: number;
    }
  | {
      readonly status: 'invalid' | 'expired' | 'generation_mismatch' | 'missing';
    };

export interface SqliteWorkspaceMintDetachedRecoveryCapabilityInput
  extends SqliteWorkspaceControllerOperationInput {
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly workerInstanceId: string;
  readonly expectedControllerGeneration: number;
  readonly expectedInteractionGeneration: number;
  readonly expiresAtMs: number;
  readonly connectionConfirmedAbsent: boolean;
  /** Caller supplies a digest of its absence evidence; raw diagnostics stay out of Store. */
  readonly absenceEvidenceDigest: string;
  /** Raw secret is caller-owned and is hashed before any SQLite write. */
  readonly secret: string;
}

export interface SqliteWorkspaceAbandonDetachedControllerInput
  extends SqliteWorkspaceControllerOperationInput {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly workerInstanceId: string;
  readonly expectedControllerGeneration: number;
  readonly expectedInteractionGeneration: number;
  readonly connectionConfirmedAbsent: boolean;
  readonly secret: string;
}

/** Exact authenticated Controller lease required for every Worker effect write. */
export interface SqliteWorkspaceControllerLeaseBinding {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
}

export interface SqliteWorkspaceEffectPreparationInput {
  readonly sessionId: string;
  readonly effectId: string;
  readonly ownerId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly expiresAtMs: number;
  readonly capabilityDigest?: string;
  readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
}

export interface SqliteWorkspaceEffectEvidence {
  readonly schema: typeof SQLITE_WORKSPACE_EFFECT_EVIDENCE_SCHEMA;
  readonly sessionId: string;
  readonly effectId: string;
  readonly workerScopeId: string;
  readonly workspaceIdentityDigest: string;
  readonly layoutGeneration: string;
  readonly ownerId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly capabilityDigest: string | null;
  readonly state: 'prepared' | 'terminal' | 'unknown';
  readonly outcome: 'succeeded' | 'failed' | 'unknown' | null;
  readonly terminalDigest: string | null;
  readonly terminalCode: string | null;
  readonly leaseRevision: number;
  readonly preparedAt: number;
  readonly terminalAt: number | null;
}

export type SqliteWorkspaceEffectInspection =
  | { readonly status: 'missing' }
  | {
      readonly status: 'prepared' | 'terminal' | 'unknown';
      readonly evidence: SqliteWorkspaceEffectEvidence;
    };

export type SqliteWorkspaceEffectPreparationResult =
  | { readonly status: 'prepared' | 'replay'; readonly evidence: SqliteWorkspaceEffectEvidence }
  | { readonly status: 'rejected'; readonly reason: SqliteWorkspaceAuthorityErrorCode };

export interface SqliteWorkspaceEffectTerminalInput {
  readonly sessionId: string;
  readonly effectId: string;
  readonly ownerId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  readonly terminalDigest: string;
  readonly terminalCode?: string;
  readonly observedAtMs?: number;
  readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
}

export type SqliteWorkspaceEffectTerminalResult =
  | { readonly status: 'terminal' | 'replay'; readonly evidence: SqliteWorkspaceEffectEvidence }
  | {
      readonly status: 'unknown';
      readonly reason: 'missing_preparation' | 'stale_lease' | 'reconciliation_required';
    }
  | { readonly status: 'rejected'; readonly reason: SqliteWorkspaceAuthorityErrorCode };

export interface SqliteWorkspaceResourceLeaseInput {
  readonly sessionId: string;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly leaseRevision?: number;
  readonly expiresAtMs: number;
  readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
}

export interface SqliteWorkspaceResourceLease {
  readonly schema: typeof SQLITE_WORKSPACE_RESOURCE_LEASE_SCHEMA;
  readonly sessionId: string;
  readonly resourceId: string;
  readonly workerScopeId: string;
  readonly workspaceIdentityDigest: string;
  readonly layoutGeneration: string;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly leaseRevision: number;
  readonly expiresAtMs: number;
  readonly externalLeaseDigest: string | null;
  readonly state: 'prepared' | 'held' | 'released' | 'expired';
}

export interface SqliteWorkspaceAuthority {
  readonly binding: SqliteRuntimeWorkspaceBinding;
  readonly controller: {
    requestControl(
      input: SqliteWorkspaceRequestControlInput,
    ): SqliteWorkspaceControllerOperationResult;
    releaseControl(
      input: SqliteWorkspaceReleaseControlInput,
    ): SqliteWorkspaceControllerOperationResult;
    detachController(
      input: SqliteWorkspaceDetachControllerInput,
    ): SqliteWorkspaceControllerOperationResult;
    issueResumeCapability(
      input: SqliteWorkspaceIssueResumeCapabilityInput,
    ): SqliteWorkspaceControllerOperationResult;
    resumeController(
      input: SqliteWorkspaceResumeControllerInput,
    ): SqliteWorkspaceControllerOperationResult;
    mintDetachedRecoveryCapability(
      input: SqliteWorkspaceMintDetachedRecoveryCapabilityInput,
    ): SqliteWorkspaceControllerOperationResult;
    abandonDetachedController(
      input: SqliteWorkspaceAbandonDetachedControllerInput,
    ): SqliteWorkspaceControllerOperationResult;
    read(sessionId: string): SqliteWorkspaceControllerState;
    lease(sessionId: string): SqliteWorkspaceControllerLease | null;
    readRecovery(sessionId: string): SqliteWorkspaceRecoveryState;
    lookupOperation(
      sessionId: string,
      requestId: string,
    ): SqliteWorkspaceControllerOperationReceipt | null;
    validateResumeCapability(
      input: SqliteWorkspaceResumeCapabilityValidationInput,
    ): SqliteWorkspaceResumeCapabilityValidation;
  };
  readonly effects: {
    prepare(input: SqliteWorkspaceEffectPreparationInput): SqliteWorkspaceEffectPreparationResult;
    inspect(
      sessionId: string,
      effectId: string,
      controllerLease?: SqliteWorkspaceControllerLeaseBinding,
    ): SqliteWorkspaceEffectInspection;
    terminal(input: SqliteWorkspaceEffectTerminalInput): SqliteWorkspaceEffectTerminalResult;
  };
  readonly resources: {
    /** Record intent before the external OS-user lease is acquired. */
    prepare(input: SqliteWorkspaceResourceLeaseInput): SqliteWorkspaceResourceLease;
    /** Record an already acquired OS-user lease; this facade never acquires it. */
    recordAcquired(input: {
      readonly sessionId: string;
      readonly resourceId: string;
      readonly ownerId: string;
      readonly attemptId: string;
      readonly requestDigest: string;
      readonly leaseRevision: number;
      readonly expiresAtMs: number;
      readonly externalLeaseDigest: string;
      readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
    }): SqliteWorkspaceResourceLease;
    /** Record release after the external OS-user lease has been released. */
    recordReleased(input: {
      readonly sessionId: string;
      readonly resourceId: string;
      readonly ownerId: string;
      readonly attemptId: string;
      readonly requestDigest: string;
      readonly leaseRevision: number;
      readonly externalLeaseDigest: string;
      readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
    }): SqliteWorkspaceResourceLease;
    inspect(
      sessionId: string,
      resourceId: string,
      controllerLease?: SqliteWorkspaceControllerLeaseBinding,
    ): SqliteWorkspaceResourceLease | null;
  };
}

interface PersistedControllerState {
  readonly schema: typeof SQLITE_WORKSPACE_AUTHORITY_SCHEMA;
  readonly sessionId: string;
  readonly layoutGeneration: string;
  readonly workerScopeId: string;
  readonly workspaceIdentityDigest: string;
  readonly status: SqliteWorkspaceControllerStatus;
  readonly controllerGeneration: number;
  readonly connectionGeneration: number;
  readonly interactionGeneration: number;
  readonly clientId: string | null;
  readonly workerInstanceId: string | null;
  readonly resumeCapabilityHash: string | null;
  readonly resumeCapabilityExpiresAtMs: number | null;
  readonly updatedAt: number;
}

interface PersistedRecoveryState {
  readonly schema: typeof SQLITE_WORKSPACE_RECOVERY_STATE_SCHEMA;
  readonly sessionId: string;
  readonly layoutGeneration: string;
  readonly workerScopeId: string;
  readonly workspaceIdentityDigest: string;
  readonly status: SqliteWorkspaceRecoveryStatus;
  readonly controllerGeneration: number;
  readonly interactionGeneration: number;
  readonly updatedAt: number;
}

interface PersistedDetachedRecoveryCapability {
  readonly schema: typeof SQLITE_WORKSPACE_DETACHED_RECOVERY_SCHEMA;
  readonly sessionId: string;
  readonly layoutGeneration: string;
  readonly workerScopeId: string;
  readonly workspaceIdentityDigest: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly interactionGeneration: number;
  readonly capabilityHash: string;
  readonly absenceEvidenceDigest: string;
  readonly expiresAtMs: number;
  readonly state: 'active' | 'consumed';
  readonly issuedAt: number;
  readonly consumedAt: number | null;
}

interface PersistedOperationReceipt extends SqliteWorkspaceControllerOperationReceipt {
  readonly subjectDigest: string;
  readonly layoutGeneration: string;
  readonly workerScopeId: string;
  readonly workspaceIdentityDigest: string;
}

interface PersistedEffectEvidence extends SqliteWorkspaceEffectEvidence {}

interface PersistedResourceLease extends SqliteWorkspaceResourceLease {}

export interface SqliteWorkspaceAuthorityGenerationCopyRow {
  readonly key: string;
  readonly value: string;
}

export interface SqliteWorkspaceAuthorityGenerationInspection {
  readonly rows: readonly SqliteWorkspaceAuthorityGenerationCopyRow[];
  readonly settled: boolean;
}

/**
 * Validate every Store-owned authority row and rewrite only its generation
 * binding for an offline whole-generation copy. This deliberately remains a
 * package-internal export: migration code may preserve authority facts, while
 * callers outside the SQLite owner must use the public authority ports.
 */
export function inspectSqliteWorkspaceAuthorityGenerationCopy(input: {
  readonly db: Database;
  readonly sourceBinding: SqliteRuntimeWorkspaceBinding;
  readonly targetBinding: SqliteRuntimeWorkspaceBinding;
}): SqliteWorkspaceAuthorityGenerationInspection {
  assertSqliteRuntimeWorkspaceBinding(input.sourceBinding);
  assertSqliteRuntimeWorkspaceBinding(input.targetBinding);
  if (input.sourceBinding.workspaceIdentityDigest !== input.targetBinding.workspaceIdentityDigest) {
    throw new SqliteWorkspaceAuthorityError(
      'ownership_mismatch',
      'Workspace authority copy may not change Workspace identity.',
    );
  }
  const ownedSessions = new Set(
    input.db
      .query<{ session_id: string }, []>(
        `SELECT session_id FROM runtime_sessions
         UNION
         SELECT session_id FROM session_workspace_tombstone`,
      )
      .all()
      .map((row) => row.session_id),
  );
  const rows: SqliteWorkspaceAuthorityGenerationCopyRow[] = [];
  let settled = true;
  for (const row of input.db
    .query<{ key: string; value: string }, [number, string]>(
      'SELECT key, value FROM runtime_store_meta WHERE substr(key, 1, ?) = ? ORDER BY key',
    )
    .iterate(AUTHORITY_META_PREFIX.length, AUTHORITY_META_PREFIX)) {
    const key = parseAuthorityMetadataKey(row.key);
    if (!ownedSessions.has(key.sessionId)) {
      throw new SqliteWorkspaceAuthorityError(
        'ownership_mismatch',
        'Workspace authority metadata has no owned Session or tombstone.',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(row.value) as unknown;
    } catch {
      throw new SqliteWorkspaceAuthorityError(
        'corrupt',
        'Workspace authority metadata is malformed.',
      );
    }
    let record:
      | PersistedControllerState
      | PersistedRecoveryState
      | PersistedDetachedRecoveryCapability
      | PersistedOperationReceipt
      | PersistedEffectEvidence
      | PersistedResourceLease;
    switch (key.kind) {
      case 'controller':
        record = parseControllerState(value, input.sourceBinding, key.sessionId);
        settled &&= record.status === 'idle';
        break;
      case 'recovery':
        record = parseRecoveryState(value, input.sourceBinding, key.sessionId);
        settled &&= record.status === 'normal';
        break;
      case 'detached-recovery':
        record = parseDetachedRecoveryCapability(value, input.sourceBinding, key.sessionId);
        settled &&= record.state === 'consumed';
        break;
      case 'operation':
        record = parseOperationReceipt(value, input.sourceBinding, key.sessionId, key.identity);
        break;
      case 'effect':
        record = parseEffectEvidence(value, input.sourceBinding, key.sessionId, key.identity);
        settled &&= record.state === 'terminal';
        break;
      case 'resource':
        record = parseResourceLease(value, input.sourceBinding, key.sessionId, key.identity);
        settled &&= record.state === 'released' || record.state === 'expired';
        break;
    }
    rows.push({
      key: row.key,
      value: JSON.stringify({
        ...record,
        layoutGeneration: input.targetBinding.layoutGeneration,
        workerScopeId: input.targetBinding.workerScopeId,
        workspaceIdentityDigest: input.targetBinding.workspaceIdentityDigest,
      }),
    });
  }
  return Object.freeze({ rows: Object.freeze(rows), settled });
}

export type ParsedAuthorityMetadataKey =
  | {
      readonly kind: 'controller' | 'recovery' | 'detached-recovery';
      readonly sessionId: string;
    }
  | {
      readonly kind: 'operation' | 'effect' | 'resource';
      readonly sessionId: string;
      readonly identity: string;
    };

function parseAuthorityMetadataKey(key: string): ParsedAuthorityMetadataKey {
  const parts = key.slice(AUTHORITY_META_PREFIX.length).split(':');
  const kind = parts.shift();
  const expectedParts =
    kind === 'controller' || kind === 'recovery' || kind === 'detached-recovery'
      ? 1
      : kind === 'operation' || kind === 'effect' || kind === 'resource'
        ? 2
        : 0;
  if (!kind || expectedParts === 0 || parts.length !== expectedParts) {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Workspace authority metadata key is unknown.',
    );
  }
  let decoded: string[];
  try {
    decoded = parts.map((part) => decodeURIComponent(part));
  } catch {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Workspace authority metadata key is malformed.',
    );
  }
  if (decoded.some((part) => !isNonEmptyText(part)) || authorityKey(kind, ...decoded) !== key) {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Workspace authority metadata key is not canonical.',
    );
  }
  if (expectedParts === 1) {
    return {
      kind: kind as 'controller' | 'recovery' | 'detached-recovery',
      sessionId: decoded[0]!,
    };
  }
  return {
    kind: kind as 'operation' | 'effect' | 'resource',
    sessionId: decoded[0]!,
    identity: decoded[1]!,
  };
}

/** Store-profile adapters may inspect a namespaced key only after stripping their own prefix. */
export function inspectSqliteWorkspaceAuthorityMetadataKey(
  key: string,
): ParsedAuthorityMetadataKey {
  return parseAuthorityMetadataKey(key);
}

export function createSqliteWorkspaceAuthority(input: {
  readonly db: Database;
  readonly binding: SqliteRuntimeWorkspaceBinding;
  readonly nowMs?: () => number;
  /** Store-owner hook invoked before any durable authority mutation. */
  readonly beforeWrite?: () => void;
}): SqliteWorkspaceAuthority {
  return createSqliteWorkspaceAuthorityForConnection_(input);
}

/** Package-internal Store-profile adapter; public callers remain fixed to Store 7 validation. */
export function createSqliteWorkspaceAuthorityForConnection_(input: {
  readonly db: Database;
  readonly binding: SqliteRuntimeWorkspaceBinding;
  readonly nowMs?: () => number;
  readonly assertConnection?: (
    database: Database,
    binding: SqliteRuntimeWorkspaceBinding,
  ) => unknown;
  /** Store-owner hook invoked before any durable authority mutation. */
  readonly beforeWrite?: () => void;
  /** Store-profile transaction owner; when supplied it also owns first-write semantics. */
  readonly runTransaction?: <T>(work: () => T) => T;
  /** Store-profile Session ownership check. */
  readonly ensureSession?: (sessionId: string) => void;
  /** Store-profile namespace for authority metadata keys. */
  readonly metadataKey?: (key: string) => string;
  /** Store-profile metadata reader; defaults to Store 7/8 runtime_store_meta. */
  readonly readMetadata?: (key: string) => unknown | undefined;
  /** Store-profile metadata writer; called only inside the owner transaction. */
  readonly writeMetadata?: (key: string, value: unknown) => void;
}): SqliteWorkspaceAuthority {
  assertSqliteRuntimeWorkspaceBinding(input.binding);
  const assertConnection = input.assertConnection ?? assertWorkspaceSqliteRuntimeStoreConnection;
  assertConnection(input.db, input.binding);
  const now = (): number => {
    const value = input.nowMs?.() ?? Date.now();
    if (!isNonNegativeSafeInteger(value)) {
      throw new SqliteWorkspaceAuthorityError('invalid_input', 'Authority clock is invalid.');
    }
    return value;
  };

  const verifyStore = (): void => {
    assertConnection(input.db, input.binding);
  };
  const transaction =
    input.runTransaction ??
    (<T>(work: () => T): T => {
      input.beforeWrite?.();
      input.db.run('BEGIN IMMEDIATE');
      try {
        const result = work();
        input.db.run('COMMIT');
        return result;
      } catch (error) {
        try {
          input.db.run('ROLLBACK');
        } catch {
          // SQLite may have rolled back after a failed statement.
        }
        throw error;
      }
    });

  const ensureSession =
    input.ensureSession ??
    ((sessionId: string): void => {
      assertSessionId(sessionId);
      const row = input.db
        .query<
          {
            worker_scope_id: string;
            workspace_identity_digest: string;
          },
          [string]
        >(
          'SELECT worker_scope_id, workspace_identity_digest FROM runtime_sessions WHERE session_id = ? LIMIT 1',
        )
        .get(sessionId);
      if (
        !row ||
        row.worker_scope_id !== input.binding.workerScopeId ||
        row.workspace_identity_digest !== input.binding.workspaceIdentityDigest
      ) {
        throw new SqliteWorkspaceAuthorityError(
          'ownership_mismatch',
          'Workspace authority Session ownership is invalid.',
        );
      }
    });

  const metadataKey = input.metadataKey ?? ((key: string): string => key);
  const readMetadata = input.readMetadata ?? ((key: string) => readJson(input.db, key));
  const writeMetadata =
    input.writeMetadata ?? ((key: string, value: unknown) => writeJson(input.db, key, value));

  const stateKey = (sessionId: string): string =>
    metadataKey(authorityKey('controller', sessionId));
  const recoveryKey = (sessionId: string): string =>
    metadataKey(authorityKey('recovery', sessionId));
  const operationKey = (sessionId: string, requestId: string): string =>
    metadataKey(authorityKey('operation', sessionId, requestId));
  const effectKey = (sessionId: string, effectId: string): string =>
    metadataKey(authorityKey('effect', sessionId, effectId));
  const detachedRecoveryKey = (sessionId: string): string =>
    metadataKey(authorityKey('detached-recovery', sessionId));
  const resourceKey = (sessionId: string, resourceId: string): string =>
    metadataKey(authorityKey('resource', sessionId, resourceId));

  const defaultControllerState = (sessionId: string): PersistedControllerState => ({
    schema: SQLITE_WORKSPACE_AUTHORITY_SCHEMA,
    sessionId,
    layoutGeneration: input.binding.layoutGeneration,
    workerScopeId: input.binding.workerScopeId,
    workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
    status: 'idle',
    controllerGeneration: 0,
    connectionGeneration: 0,
    interactionGeneration: 0,
    clientId: null,
    workerInstanceId: null,
    resumeCapabilityHash: null,
    resumeCapabilityExpiresAtMs: null,
    updatedAt: 0,
  });

  const readStateTx = (sessionId: string): PersistedControllerState => {
    const row = readMetadata(stateKey(sessionId));
    return row === undefined
      ? defaultControllerState(sessionId)
      : parseControllerState(row, input.binding, sessionId);
  };
  const assertCurrentControllerLeaseTx = (lease: SqliteWorkspaceControllerLeaseBinding): void => {
    const current = readStateTx(lease.sessionId);
    if (!matchesControllerLease(current, lease, 'active')) {
      throw new SqliteWorkspaceAuthorityError(
        'stale_lease',
        'Controller lease is no longer current for the Workspace effect.',
      );
    }
  };
  const readRecoveryTx = (sessionId: string): PersistedRecoveryState => {
    const row = readMetadata(recoveryKey(sessionId));
    return row === undefined
      ? {
          schema: SQLITE_WORKSPACE_RECOVERY_STATE_SCHEMA,
          sessionId,
          layoutGeneration: input.binding.layoutGeneration,
          workerScopeId: input.binding.workerScopeId,
          workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
          status: 'normal',
          controllerGeneration: 0,
          interactionGeneration: 0,
          updatedAt: 0,
        }
      : parseRecoveryState(row, input.binding, sessionId);
  };
  const writeStateTx = (value: PersistedControllerState): void => {
    writeMetadata(stateKey(value.sessionId), value);
  };
  const writeRecoveryTx = (value: PersistedRecoveryState): void => {
    writeMetadata(recoveryKey(value.sessionId), value);
  };

  const operationSubject = (value: Record<string, unknown>): string => digestJson(value);

  const readOperationTx = (
    sessionId: string,
    requestId: string,
  ): PersistedOperationReceipt | undefined => {
    const value = readMetadata(operationKey(sessionId, requestId));
    if (value === undefined) return undefined;
    return parseOperationReceipt(value, input.binding, sessionId, requestId);
  };

  const operation = (
    request: SqliteWorkspaceControllerOperationInput,
    operationName: SqliteWorkspaceControllerOperation,
    subjectDigest: string,
    work: () => {
      readonly status: 'applied' | 'rejected';
      readonly code: SqliteWorkspaceControllerOperationCode;
      readonly state: PersistedControllerState;
    },
  ): SqliteWorkspaceControllerOperationResult => {
    verifyStore();
    validateOperationInput(request);
    return transaction(() => {
      // Re-read ownership after BEGIN IMMEDIATE.  A create-session compound
      // transaction may publish the Runtime row immediately before this
      // operation; checking outside the writer lock leaves a stale
      // SELECT→BEGIN window.
      ensureSession(request.sessionId);
      const existing = readOperationTx(request.sessionId, request.requestId);
      if (existing) {
        if (
          existing.requestDigest !== request.requestDigest ||
          existing.operation !== operationName ||
          existing.subjectDigest !== subjectDigest
        ) {
          throw new SqliteWorkspaceAuthorityError(
            'idempotency_conflict',
            'Controller operation identity conflicts with its durable receipt.',
          );
        }
        return operationResult(existing, readStateTx(request.sessionId), true);
      }
      const outcome = work();
      const timestamp = now();
      const receipt: PersistedOperationReceipt = {
        schema: SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA,
        sessionId: request.sessionId,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        operation: operationName,
        status: outcome.status,
        code: outcome.code,
        controllerGeneration: outcome.state.controllerGeneration,
        connectionGeneration: outcome.state.connectionGeneration,
        interactionGeneration: outcome.state.interactionGeneration,
        clientId: outcome.state.clientId,
        workerInstanceId: outcome.state.workerInstanceId,
        completedAt: timestamp,
        subjectDigest,
        layoutGeneration: input.binding.layoutGeneration,
        workerScopeId: input.binding.workerScopeId,
        workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
      };
      writeMetadata(operationKey(request.sessionId, request.requestId), receipt);
      return operationResult(receipt, outcome.state, false);
    });
  };

  const requestControl = (
    request: SqliteWorkspaceRequestControlInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertClientIdentity(request.clientId);
    assertGeneration(request.connectionGeneration, 'connection generation', true);
    assertWorkerIdentity(request.workerInstanceId);
    assertSecret(request.resumeSecret);
    assertFutureTimestamp(request.resumeExpiresAtMs, now());
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      workerInstanceId: request.workerInstanceId,
      resumeSecretHash: hashSecret(request.resumeSecret),
      resumeExpiresAtMs: request.resumeExpiresAtMs,
    });
    return operation(request, 'request_control', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      const recovery = readRecoveryTx(request.sessionId);
      if (current.status === 'active') {
        return { status: 'rejected', code: 'controller_busy', state: current };
      }
      if (current.status === 'detached') {
        return { status: 'rejected', code: 'detached_requires_recovery', state: current };
      }
      if (recovery.status !== 'normal') {
        return { status: 'rejected', code: 'detached_requires_recovery', state: current };
      }
      const next: PersistedControllerState = {
        ...current,
        status: 'active',
        controllerGeneration: increment(current.controllerGeneration),
        connectionGeneration: request.connectionGeneration,
        clientId: request.clientId,
        workerInstanceId: request.workerInstanceId,
        resumeCapabilityHash: hashSecret(request.resumeSecret),
        resumeCapabilityExpiresAtMs: request.resumeExpiresAtMs,
        updatedAt: now(),
      };
      writeStateTx(next);
      return { status: 'applied', code: 'acquired', state: next };
    });
  };

  const exactLease = (
    current: PersistedControllerState,
    owner: SqliteWorkspaceLeaseOwner,
    expectedStatus: 'active' | 'detached' = 'active',
  ): boolean => matchesControllerLease(current, owner, expectedStatus);

  const releaseControl = (
    request: SqliteWorkspaceReleaseControlInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertLeaseOwner(request);
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      controllerGeneration: request.controllerGeneration,
      workerInstanceId: request.workerInstanceId,
    });
    return operation(request, 'release_control', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      if (!exactLease(current, request)) {
        return { status: 'rejected', code: 'stale_lease', state: current };
      }
      const next: PersistedControllerState = {
        ...current,
        status: 'idle',
        controllerGeneration: increment(current.controllerGeneration),
        clientId: null,
        workerInstanceId: null,
        resumeCapabilityHash: null,
        resumeCapabilityExpiresAtMs: null,
        updatedAt: now(),
      };
      writeStateTx(next);
      writeRecoveryTx({
        ...readRecoveryTx(request.sessionId),
        status: 'normal',
        controllerGeneration: next.controllerGeneration,
        updatedAt: next.updatedAt,
      });
      return { status: 'applied', code: 'released', state: next };
    });
  };

  const detachController = (
    request: SqliteWorkspaceDetachControllerInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertLeaseOwner(request);
    assertGeneration(request.interactionGeneration, 'interaction generation');
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      controllerGeneration: request.controllerGeneration,
      workerInstanceId: request.workerInstanceId,
      interactionGeneration: request.interactionGeneration,
    });
    return operation(request, 'detach_controller', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      if (!exactLease(current, request)) {
        return { status: 'rejected', code: 'stale_lease', state: current };
      }
      const timestamp = now();
      const next: PersistedControllerState = {
        ...current,
        status: 'detached',
        interactionGeneration: request.interactionGeneration,
        updatedAt: timestamp,
      };
      writeStateTx(next);
      writeRecoveryTx({
        ...readRecoveryTx(request.sessionId),
        status: 'detached',
        controllerGeneration: next.controllerGeneration,
        interactionGeneration: next.interactionGeneration,
        updatedAt: timestamp,
      });
      return { status: 'applied', code: 'detached', state: next };
    });
  };

  const issueResumeCapability = (
    request: SqliteWorkspaceIssueResumeCapabilityInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertLeaseOwner(request);
    assertSecret(request.secret);
    assertFutureTimestamp(request.expiresAtMs, now());
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      controllerGeneration: request.controllerGeneration,
      workerInstanceId: request.workerInstanceId,
      secretHash: hashSecret(request.secret),
      expiresAtMs: request.expiresAtMs,
    });
    return operation(request, 'issue_resume_capability', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      if (!exactLease(current, request)) {
        return { status: 'rejected', code: 'stale_lease', state: current };
      }
      const timestamp = now();
      if (
        current.resumeCapabilityHash &&
        current.resumeCapabilityExpiresAtMs !== null &&
        current.resumeCapabilityExpiresAtMs > timestamp
      ) {
        return { status: 'rejected', code: 'capability_invalid', state: current };
      }
      const next = {
        ...current,
        resumeCapabilityHash: hashSecret(request.secret),
        resumeCapabilityExpiresAtMs: request.expiresAtMs,
        updatedAt: timestamp,
      } satisfies PersistedControllerState;
      writeStateTx(next);
      return { status: 'applied', code: 'resume_capability_issued', state: next };
    });
  };

  const validateResumeCapability = (
    request: SqliteWorkspaceResumeCapabilityValidationInput,
  ): SqliteWorkspaceResumeCapabilityValidation => {
    verifyStore();
    assertSessionId(request.sessionId);
    assertClientIdentity(request.clientId);
    assertGeneration(request.controllerGeneration, 'controller generation');
    assertSecret(request.secret);
    ensureSession(request.sessionId);
    const current = readStateTx(request.sessionId);
    if (current.status === 'idle' || current.clientId !== request.clientId) {
      return { status: 'invalid' };
    }
    if (current.controllerGeneration !== request.controllerGeneration) {
      return { status: 'generation_mismatch' };
    }
    if (!current.resumeCapabilityHash || current.resumeCapabilityExpiresAtMs === null) {
      return { status: 'missing' };
    }
    const timestamp = request.nowMs ?? now();
    if (!isNonNegativeSafeInteger(timestamp)) {
      throw new SqliteWorkspaceAuthorityError(
        'invalid_input',
        'Capability validation clock is invalid.',
      );
    }
    if (current.resumeCapabilityExpiresAtMs <= timestamp) return { status: 'expired' };
    return hashSecret(request.secret) === current.resumeCapabilityHash
      ? {
          status: 'valid',
          sessionId: request.sessionId,
          clientId: request.clientId,
          controllerGeneration: current.controllerGeneration,
          connectionGeneration: current.connectionGeneration,
        }
      : { status: 'invalid' };
  };

  const resumeController = (
    request: SqliteWorkspaceResumeControllerInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertClientIdentity(request.clientId);
    assertWorkerIdentity(request.workerInstanceId);
    assertGeneration(request.controllerGeneration, 'controller generation');
    assertGeneration(request.connectionGeneration, 'connection generation', true);
    assertSecret(request.currentSecret);
    assertSecret(request.nextSecret);
    assertFutureTimestamp(request.expiresAtMs, now());
    if (hashSecret(request.currentSecret) === hashSecret(request.nextSecret)) {
      throw new SqliteWorkspaceAuthorityError(
        'capability_invalid',
        'Resume capability must rotate.',
      );
    }
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      controllerGeneration: request.controllerGeneration,
      connectionGeneration: request.connectionGeneration,
      workerInstanceId: request.workerInstanceId,
      currentSecretHash: hashSecret(request.currentSecret),
      nextSecretHash: hashSecret(request.nextSecret),
      expiresAtMs: request.expiresAtMs,
    });
    return operation(request, 'resume_controller', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      const recovery = readRecoveryTx(request.sessionId);
      const timestamp = now();
      if (
        current.status !== 'detached' ||
        recovery.status !== 'detached' ||
        current.clientId !== request.clientId ||
        current.controllerGeneration !== request.controllerGeneration ||
        !current.resumeCapabilityHash
      ) {
        return { status: 'rejected', code: 'stale_lease', state: current };
      }
      if (
        current.resumeCapabilityExpiresAtMs === null ||
        current.resumeCapabilityExpiresAtMs <= timestamp
      ) {
        return { status: 'rejected', code: 'capability_expired', state: current };
      }
      if (current.resumeCapabilityHash !== hashSecret(request.currentSecret)) {
        return { status: 'rejected', code: 'capability_invalid', state: current };
      }
      if (request.connectionGeneration <= current.connectionGeneration) {
        return { status: 'rejected', code: 'stale_lease', state: current };
      }
      const next: PersistedControllerState = {
        ...current,
        status: 'active',
        connectionGeneration: request.connectionGeneration,
        workerInstanceId: request.workerInstanceId,
        resumeCapabilityHash: hashSecret(request.nextSecret),
        resumeCapabilityExpiresAtMs: request.expiresAtMs,
        updatedAt: timestamp,
      };
      writeStateTx(next);
      writeRecoveryTx({
        ...readRecoveryTx(request.sessionId),
        status: 'normal',
        controllerGeneration: next.controllerGeneration,
        updatedAt: timestamp,
      });
      return { status: 'applied', code: 'resumed', state: next };
    });
  };

  const mintDetachedRecoveryCapability = (
    request: SqliteWorkspaceMintDetachedRecoveryCapabilityInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertClientIdentity(request.clientId);
    assertWorkerIdentity(request.workerInstanceId);
    assertGeneration(request.connectionGeneration, 'connection generation', true);
    assertGeneration(request.expectedControllerGeneration, 'controller generation');
    assertGeneration(request.expectedInteractionGeneration, 'interaction generation');
    assertSecret(request.secret);
    assertDigest(request.absenceEvidenceDigest, 'absence evidence digest');
    if (!request.connectionConfirmedAbsent) {
      throw new SqliteWorkspaceAuthorityError(
        'ownership_mismatch',
        'Detached recovery requires confirmed connection absence.',
      );
    }
    assertFutureTimestamp(request.expiresAtMs, now());
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      workerInstanceId: request.workerInstanceId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      expectedInteractionGeneration: request.expectedInteractionGeneration,
      secretHash: hashSecret(request.secret),
      expiresAtMs: request.expiresAtMs,
      absenceEvidenceDigest: request.absenceEvidenceDigest,
    });
    return operation(request, 'mint_detached_recovery_capability', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      const recovery = readRecoveryTx(request.sessionId);
      if (
        current.status !== 'detached' ||
        current.controllerGeneration !== request.expectedControllerGeneration ||
        recovery.status !== 'detached' ||
        recovery.interactionGeneration !== request.expectedInteractionGeneration
      ) {
        return { status: 'rejected', code: 'recovery_generation_mismatch', state: current };
      }
      const existingValue = readMetadata(detachedRecoveryKey(request.sessionId));
      if (existingValue !== undefined) {
        const existing = parseDetachedRecoveryCapability(
          existingValue,
          input.binding,
          request.sessionId,
        );
        const timestamp = now();
        if (existing.state === 'active' && existing.expiresAtMs > timestamp) {
          return { status: 'rejected', code: 'capability_invalid', state: current };
        }
      }
      const timestamp = now();
      const capability: PersistedDetachedRecoveryCapability = {
        schema: SQLITE_WORKSPACE_DETACHED_RECOVERY_SCHEMA,
        sessionId: request.sessionId,
        layoutGeneration: input.binding.layoutGeneration,
        workerScopeId: input.binding.workerScopeId,
        workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
        clientId: request.clientId,
        connectionGeneration: request.connectionGeneration,
        controllerGeneration: request.expectedControllerGeneration,
        interactionGeneration: request.expectedInteractionGeneration,
        capabilityHash: hashSecret(request.secret),
        absenceEvidenceDigest: request.absenceEvidenceDigest,
        expiresAtMs: request.expiresAtMs,
        state: 'active',
        issuedAt: timestamp,
        consumedAt: null,
      };
      writeMetadata(detachedRecoveryKey(request.sessionId), capability);
      return {
        status: 'applied',
        code: 'detached_recovery_capability_issued',
        state: current,
      };
    });
  };

  const abandonDetachedController = (
    request: SqliteWorkspaceAbandonDetachedControllerInput,
  ): SqliteWorkspaceControllerOperationResult => {
    assertClientIdentity(request.clientId);
    assertWorkerIdentity(request.workerInstanceId);
    assertGeneration(request.connectionGeneration, 'connection generation', true);
    assertGeneration(request.expectedControllerGeneration, 'controller generation');
    assertGeneration(request.expectedInteractionGeneration, 'interaction generation');
    assertSecret(request.secret);
    if (!request.connectionConfirmedAbsent) {
      throw new SqliteWorkspaceAuthorityError(
        'ownership_mismatch',
        'Detached recovery requires confirmed connection absence.',
      );
    }
    const subjectDigest = operationSubject({
      clientId: request.clientId,
      connectionGeneration: request.connectionGeneration,
      workerInstanceId: request.workerInstanceId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      expectedInteractionGeneration: request.expectedInteractionGeneration,
      secretHash: hashSecret(request.secret),
    });
    return operation(request, 'abandon_detached_controller', subjectDigest, () => {
      const current = readStateTx(request.sessionId);
      const recovery = readRecoveryTx(request.sessionId);
      const value = readMetadata(detachedRecoveryKey(request.sessionId));
      if (
        current.status !== 'detached' ||
        current.controllerGeneration !== request.expectedControllerGeneration ||
        recovery.status !== 'detached' ||
        recovery.interactionGeneration !== request.expectedInteractionGeneration
      ) {
        return { status: 'rejected', code: 'recovery_generation_mismatch', state: current };
      }
      if (value === undefined) {
        return { status: 'rejected', code: 'capability_invalid', state: current };
      }
      const capability = parseDetachedRecoveryCapability(value, input.binding, request.sessionId);
      const timestamp = now();
      if (capability.state === 'consumed') {
        return { status: 'rejected', code: 'capability_consumed', state: current };
      }
      if (capability.expiresAtMs <= timestamp) {
        return { status: 'rejected', code: 'capability_expired', state: current };
      }
      if (
        capability.clientId !== request.clientId ||
        capability.controllerGeneration !== request.expectedControllerGeneration ||
        capability.interactionGeneration !== request.expectedInteractionGeneration ||
        capability.capabilityHash !== hashSecret(request.secret)
      ) {
        return { status: 'rejected', code: 'capability_invalid', state: current };
      }
      const next: PersistedControllerState = {
        ...current,
        status: 'idle',
        controllerGeneration: increment(current.controllerGeneration),
        clientId: null,
        workerInstanceId: null,
        resumeCapabilityHash: null,
        resumeCapabilityExpiresAtMs: null,
        updatedAt: timestamp,
      };
      writeStateTx(next);
      writeRecoveryTx({
        ...recovery,
        status: 'normal',
        controllerGeneration: next.controllerGeneration,
        updatedAt: timestamp,
      });
      writeMetadata(detachedRecoveryKey(request.sessionId), {
        ...capability,
        state: 'consumed',
        consumedAt: timestamp,
      } satisfies PersistedDetachedRecoveryCapability);
      return { status: 'applied', code: 'abandoned', state: next };
    });
  };

  const readController = (sessionId: string): SqliteWorkspaceControllerState => {
    verifyStore();
    ensureSession(sessionId);
    const state = readStateTx(sessionId);
    return {
      sessionId,
      status: state.status,
      controllerGeneration: state.controllerGeneration,
      connectionGeneration: state.connectionGeneration,
      clientId: state.clientId,
      workerInstanceId: state.workerInstanceId,
      interactionGeneration: state.interactionGeneration,
      resumeCapabilityExpiresAtMs: state.resumeCapabilityExpiresAtMs,
    };
  };

  const readLease = (sessionId: string): SqliteWorkspaceControllerLease | null => {
    const state = readController(sessionId);
    if (state.status === 'idle' || !state.clientId || !state.workerInstanceId) return null;
    return {
      sessionId,
      clientId: state.clientId,
      connectionGeneration: state.connectionGeneration,
      controllerGeneration: state.controllerGeneration,
      workerInstanceId: state.workerInstanceId,
      status: state.status,
    };
  };

  const readRecovery = (sessionId: string): SqliteWorkspaceRecoveryState => {
    verifyStore();
    ensureSession(sessionId);
    const state = readRecoveryTx(sessionId);
    return {
      sessionId,
      status: state.status,
      controllerGeneration: state.controllerGeneration,
      interactionGeneration: state.interactionGeneration,
      updatedAt: state.updatedAt,
    };
  };

  const lookupOperation = (
    sessionId: string,
    requestId: string,
  ): SqliteWorkspaceControllerOperationReceipt | null => {
    verifyStore();
    ensureSession(sessionId);
    assertRequestId(requestId);
    return readOperationTx(sessionId, requestId) ?? null;
  };

  const readEffectTx = (
    sessionId: string,
    effectId: string,
  ): PersistedEffectEvidence | undefined => {
    const value = readMetadata(effectKey(sessionId, effectId));
    if (value === undefined) return undefined;
    return parseEffectEvidence(value, input.binding, sessionId, effectId);
  };

  const readEffectLeaseTx = (
    sessionId: string,
    effectId: string,
  ): { owner_id: string; lease_revision: number; expires_at_ms: number } | undefined =>
    input.db
      .query<{ owner_id: string; lease_revision: number; expires_at_ms: number }, [string, string]>(
        'SELECT owner_id, lease_revision, expires_at_ms FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? LIMIT 1',
      )
      .get(sessionId, `${EFFECT_LEASE_PREFIX}${effectId}`) ?? undefined;

  const prepareEffect = (
    request: SqliteWorkspaceEffectPreparationInput,
  ): SqliteWorkspaceEffectPreparationResult => {
    verifyStore();
    assertEffectInput(request);
    const timestamp = now();
    if (request.expiresAtMs <= timestamp) {
      throw new SqliteWorkspaceAuthorityError('expired_lease', 'Effect lease is already expired.');
    }
    return transaction(() => {
      ensureSession(request.sessionId);
      assertCurrentControllerLeaseTx(request.controllerLease);
      const existing = readEffectTx(request.sessionId, request.effectId);
      if (existing) {
        if (
          existing.state === 'terminal' &&
          existing.requestDigest === request.requestDigest &&
          existing.ownerId === request.ownerId &&
          existing.invocationId === request.invocationId &&
          existing.attemptId === request.attemptId
        ) {
          return { status: 'replay', evidence: existing };
        }
        if (existing.state === 'unknown') {
          return { status: 'rejected', reason: 'unknown_result' };
        }
        if (
          existing.ownerId !== request.ownerId ||
          existing.requestDigest !== request.requestDigest ||
          existing.invocationId !== request.invocationId ||
          existing.attemptId !== request.attemptId
        ) {
          return { status: 'rejected', reason: 'stale_lease' };
        }
        const lease = readEffectLeaseTx(request.sessionId, request.effectId);
        if (
          !lease ||
          lease.owner_id !== request.ownerId ||
          lease.lease_revision !== existing.leaseRevision ||
          lease.expires_at_ms <= timestamp
        ) {
          writeEffectUnknown(existing, request.sessionId, request.effectId, timestamp);
          return { status: 'rejected', reason: 'stale_lease' };
        }
        return { status: 'replay', evidence: existing };
      }
      const internalEffectId = `${EFFECT_LEASE_PREFIX}${request.effectId}`;
      const existingLease = readEffectLeaseTx(request.sessionId, request.effectId);
      if (existingLease && existingLease.expires_at_ms <= timestamp) {
        input.db
          .query('DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ?')
          .run(request.sessionId, internalEffectId);
      }
      input.db
        .query(
          "INSERT OR IGNORE INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, 0, 'certain', ?)",
        )
        .run(request.sessionId, internalEffectId, request.ownerId, request.expiresAtMs);
      const lease = readEffectLeaseTx(request.sessionId, request.effectId);
      if (!lease || lease.owner_id !== request.ownerId || lease.expires_at_ms <= timestamp) {
        return { status: 'rejected', reason: 'stale_lease' };
      }
      const evidence: PersistedEffectEvidence = {
        schema: SQLITE_WORKSPACE_EFFECT_EVIDENCE_SCHEMA,
        sessionId: request.sessionId,
        effectId: request.effectId,
        workerScopeId: input.binding.workerScopeId,
        workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
        layoutGeneration: input.binding.layoutGeneration,
        ownerId: request.ownerId,
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        requestDigest: request.requestDigest,
        capabilityDigest: request.capabilityDigest ?? null,
        state: 'prepared',
        outcome: null,
        terminalDigest: null,
        terminalCode: null,
        leaseRevision: lease.lease_revision,
        preparedAt: timestamp,
        terminalAt: null,
      };
      writeMetadata(effectKey(request.sessionId, request.effectId), evidence);
      return { status: 'prepared', evidence };
    });
  };

  const writeEffectUnknown = (
    value: PersistedEffectEvidence,
    sessionId: string,
    effectId: string,
    timestamp: number,
  ): PersistedEffectEvidence => {
    const unknown: PersistedEffectEvidence = {
      ...value,
      state: 'unknown',
      outcome: 'unknown',
      terminalDigest: null,
      terminalCode: null,
      terminalAt: timestamp,
    };
    writeMetadata(effectKey(sessionId, effectId), unknown);
    input.db
      .query('DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ?')
      .run(sessionId, `${EFFECT_LEASE_PREFIX}${effectId}`);
    return unknown;
  };

  const inspectEffect = (
    sessionId: string,
    effectId: string,
    controllerLease?: SqliteWorkspaceControllerLeaseBinding,
  ): SqliteWorkspaceEffectInspection => {
    verifyStore();
    assertSessionId(sessionId);
    assertEffectId(effectId);
    if (controllerLease) assertControllerLeaseInput(controllerLease, sessionId);
    ensureSession(sessionId);
    const evidence = readEffectTx(sessionId, effectId);
    if (!evidence) return { status: 'missing' };
    if (evidence.state !== 'prepared') return { status: evidence.state, evidence };
    const timestamp = now();
    const lease = readEffectLeaseTx(sessionId, effectId);
    if (
      lease &&
      lease.owner_id === evidence.ownerId &&
      lease.lease_revision === evidence.leaseRevision &&
      lease.expires_at_ms > timestamp
    ) {
      return { status: 'prepared', evidence };
    }
    const unknown = transaction(() => {
      if (controllerLease) assertCurrentControllerLeaseTx(controllerLease);
      return writeEffectUnknown(evidence, sessionId, effectId, timestamp);
    });
    return { status: 'unknown', evidence: unknown };
  };

  const terminalEffect = (
    request: SqliteWorkspaceEffectTerminalInput,
  ): SqliteWorkspaceEffectTerminalResult => {
    verifyStore();
    assertEffectTerminalInput(request);
    const timestamp = request.observedAtMs ?? now();
    if (!isNonNegativeSafeInteger(timestamp)) {
      throw new SqliteWorkspaceAuthorityError('invalid_input', 'Effect terminal clock is invalid.');
    }
    return transaction(() => {
      ensureSession(request.sessionId);
      assertCurrentControllerLeaseTx(request.controllerLease);
      const existing = readEffectTx(request.sessionId, request.effectId);
      if (!existing) return { status: 'unknown', reason: 'missing_preparation' };
      if (existing.state === 'terminal') {
        return existing.terminalDigest === request.terminalDigest &&
          existing.outcome === request.outcome &&
          existing.ownerId === request.ownerId &&
          existing.attemptId === request.attemptId
          ? { status: 'replay', evidence: existing }
          : { status: 'rejected', reason: 'idempotency_conflict' };
      }
      if (existing.state === 'unknown')
        return { status: 'unknown', reason: 'reconciliation_required' };
      if (
        existing.ownerId !== request.ownerId ||
        existing.invocationId !== request.invocationId ||
        existing.attemptId !== request.attemptId ||
        existing.requestDigest !== request.requestDigest
      ) {
        return { status: 'rejected', reason: 'stale_lease' };
      }
      const lease = readEffectLeaseTx(request.sessionId, request.effectId);
      if (
        !lease ||
        lease.owner_id !== request.ownerId ||
        lease.lease_revision !== existing.leaseRevision ||
        lease.expires_at_ms <= timestamp
      ) {
        writeEffectUnknown(existing, request.sessionId, request.effectId, timestamp);
        return { status: 'unknown', reason: 'stale_lease' };
      }
      const terminal: PersistedEffectEvidence = {
        ...existing,
        state: 'terminal',
        outcome: request.outcome,
        terminalDigest: request.terminalDigest,
        terminalCode: request.terminalCode ?? null,
        terminalAt: timestamp,
      };
      writeMetadata(effectKey(request.sessionId, request.effectId), terminal);
      input.db
        .query(
          'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ?',
        )
        .run(request.sessionId, `${EFFECT_LEASE_PREFIX}${request.effectId}`, request.ownerId);
      return { status: 'terminal', evidence: terminal };
    });
  };

  const resourceMetaTx = (
    sessionId: string,
    resourceId: string,
  ): PersistedResourceLease | undefined => {
    const value = readMetadata(resourceKey(sessionId, resourceId));
    if (value === undefined) return undefined;
    return parseResourceLease(value, input.binding, sessionId, resourceId);
  };

  // Resource mutual exclusion remains with the OS-user lease port. This
  // Store7 surface records attempt/evidence order and never claims a shared
  // filesystem resource for a Workspace on its own.
  const prepareResource = (
    request: SqliteWorkspaceResourceLeaseInput,
  ): SqliteWorkspaceResourceLease => {
    verifyStore();
    assertResourceInput(request);
    const timestamp = now();
    assertFutureTimestamp(request.expiresAtMs, timestamp);
    return transaction(() => {
      ensureSession(request.sessionId);
      assertCurrentControllerLeaseTx(request.controllerLease);
      const existing = resourceMetaTx(request.sessionId, request.resourceId);
      if (existing && (existing.state === 'prepared' || existing.state === 'held')) {
        if (
          existing.ownerId === request.ownerId &&
          existing.attemptId === request.attemptId &&
          existing.requestDigest === request.requestDigest &&
          existing.expiresAtMs > timestamp
        ) {
          return existing;
        }
        throw new SqliteWorkspaceAuthorityError(
          'stale_lease',
          'Resource attempt is already owned.',
        );
      }
      const result: PersistedResourceLease = {
        schema: SQLITE_WORKSPACE_RESOURCE_LEASE_SCHEMA,
        sessionId: request.sessionId,
        resourceId: request.resourceId,
        workerScopeId: input.binding.workerScopeId,
        workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
        layoutGeneration: input.binding.layoutGeneration,
        ownerId: request.ownerId,
        attemptId: request.attemptId,
        requestDigest: request.requestDigest,
        leaseRevision: existing ? increment(existing.leaseRevision) : 0,
        expiresAtMs: request.expiresAtMs,
        externalLeaseDigest: null,
        state: 'prepared',
      };
      writeMetadata(resourceKey(request.sessionId, request.resourceId), result);
      return result;
    });
  };

  const recordResourceAcquired = (request: {
    readonly sessionId: string;
    readonly resourceId: string;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly requestDigest: string;
    readonly leaseRevision: number;
    readonly expiresAtMs: number;
    readonly externalLeaseDigest: string;
    readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
  }): SqliteWorkspaceResourceLease => {
    verifyStore();
    assertResourceAcquiredInput(request);
    const timestamp = now();
    assertFutureTimestamp(request.expiresAtMs, timestamp);
    return transaction(() => {
      ensureSession(request.sessionId);
      assertCurrentControllerLeaseTx(request.controllerLease);
      const existing = resourceMetaTx(request.sessionId, request.resourceId);
      if (
        existing?.state !== 'prepared' ||
        existing.ownerId !== request.ownerId ||
        existing.attemptId !== request.attemptId ||
        existing.requestDigest !== request.requestDigest ||
        existing.leaseRevision !== request.leaseRevision ||
        existing.expiresAtMs <= timestamp ||
        request.expiresAtMs <= timestamp
      ) {
        throw new SqliteWorkspaceAuthorityError(
          'stale_lease',
          'External resource lease evidence is stale.',
        );
      }
      const result: PersistedResourceLease = {
        ...existing,
        expiresAtMs: request.expiresAtMs,
        externalLeaseDigest: request.externalLeaseDigest,
        state: 'held',
      };
      writeMetadata(resourceKey(request.sessionId, request.resourceId), result);
      return result;
    });
  };

  const recordResourceReleased = (request: {
    readonly sessionId: string;
    readonly resourceId: string;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly requestDigest: string;
    readonly leaseRevision: number;
    readonly externalLeaseDigest: string;
    readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
  }): SqliteWorkspaceResourceLease => {
    verifyStore();
    assertResourceReleasedInput(request);
    return transaction(() => {
      ensureSession(request.sessionId);
      assertCurrentControllerLeaseTx(request.controllerLease);
      const existing = resourceMetaTx(request.sessionId, request.resourceId);
      if (
        existing?.state !== 'held' ||
        existing.ownerId !== request.ownerId ||
        existing.attemptId !== request.attemptId ||
        existing.requestDigest !== request.requestDigest ||
        existing.leaseRevision !== request.leaseRevision ||
        existing.externalLeaseDigest !== request.externalLeaseDigest
      ) {
        throw new SqliteWorkspaceAuthorityError(
          'stale_lease',
          'External resource release evidence is stale.',
        );
      }
      const result: PersistedResourceLease = { ...existing, state: 'released' };
      writeMetadata(resourceKey(request.sessionId, request.resourceId), result);
      return result;
    });
  };

  const inspectResource = (
    sessionId: string,
    resourceId: string,
    controllerLease?: SqliteWorkspaceControllerLeaseBinding,
  ): SqliteWorkspaceResourceLease | null => {
    verifyStore();
    assertSessionId(sessionId);
    assertResourceId(resourceId);
    if (controllerLease) assertControllerLeaseInput(controllerLease, sessionId);
    ensureSession(sessionId);
    const existing = resourceMetaTx(sessionId, resourceId);
    if (!existing || existing.state === 'released' || existing.state === 'expired')
      return existing ?? null;
    if (existing.expiresAtMs > now()) return existing;
    const expired: PersistedResourceLease = { ...existing, state: 'expired' };
    transaction(() => {
      if (controllerLease) assertCurrentControllerLeaseTx(controllerLease);
      writeMetadata(resourceKey(sessionId, resourceId), expired);
    });
    return expired;
  };

  return Object.freeze({
    binding: input.binding,
    controller: Object.freeze({
      requestControl,
      releaseControl,
      detachController,
      issueResumeCapability,
      resumeController,
      mintDetachedRecoveryCapability,
      abandonDetachedController,
      read: readController,
      lease: readLease,
      readRecovery,
      lookupOperation,
      validateResumeCapability,
    }),
    effects: Object.freeze({
      prepare: prepareEffect,
      inspect: inspectEffect,
      terminal: terminalEffect,
    }),
    resources: Object.freeze({
      prepare: prepareResource,
      recordAcquired: recordResourceAcquired,
      recordReleased: recordResourceReleased,
      inspect: inspectResource,
    }),
  });
}

function authorityKey(kind: string, ...parts: string[]): string {
  return `${AUTHORITY_META_PREFIX}${kind}:${parts.map((part) => encodeURIComponent(part)).join(':')}`;
}

function writeJson(db: Database, key: string, value: unknown): void {
  db.query('INSERT OR REPLACE INTO runtime_store_meta (key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(value),
  );
}

function readJson(db: Database, key: string): unknown | undefined {
  const row = db
    .query<{ value: string }, [string]>(
      'SELECT value FROM runtime_store_meta WHERE key = ? LIMIT 1',
    )
    .get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Workspace authority metadata is malformed.',
    );
  }
}

function operationResult(
  receipt: PersistedOperationReceipt,
  state: PersistedControllerState,
  replay: boolean,
): SqliteWorkspaceControllerOperationResult {
  const base = {
    receipt: publicReceipt(receipt),
  };
  if (receipt.status === 'rejected') return { status: 'rejected', ...base };
  if (receipt.operation === 'request_control' || receipt.operation === 'resume_controller') {
    if (state.status === 'active' && state.clientId && state.workerInstanceId) {
      return {
        status: replay ? 'replay' : 'applied',
        ...base,
        lease: {
          sessionId: state.sessionId,
          clientId: state.clientId,
          connectionGeneration: state.connectionGeneration,
          controllerGeneration: state.controllerGeneration,
          workerInstanceId: state.workerInstanceId,
          status: 'active',
        },
      };
    }
  }
  return {
    status: replay ? 'replay' : 'applied',
    ...base,
  };
}

function publicReceipt(
  value: PersistedOperationReceipt,
): SqliteWorkspaceControllerOperationReceipt {
  const {
    subjectDigest: _subjectDigest,
    layoutGeneration: _layoutGeneration,
    workerScopeId: _workerScopeId,
    workspaceIdentityDigest: _workspaceIdentityDigest,
    ...receipt
  } = value;
  return receipt;
}

function parseControllerState(
  value: unknown,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
): PersistedControllerState {
  const record = exactRecord(value, [
    'schema',
    'sessionId',
    'layoutGeneration',
    'workerScopeId',
    'workspaceIdentityDigest',
    'status',
    'controllerGeneration',
    'connectionGeneration',
    'interactionGeneration',
    'clientId',
    'workerInstanceId',
    'resumeCapabilityHash',
    'resumeCapabilityExpiresAtMs',
    'updatedAt',
  ]);
  assertRecordBinding(record, binding, sessionId);
  if (
    record.schema !== SQLITE_WORKSPACE_AUTHORITY_SCHEMA ||
    !isControllerStatus(record.status) ||
    !isNonNegativeSafeInteger(record.controllerGeneration) ||
    !isNonNegativeSafeInteger(record.connectionGeneration) ||
    !isNonNegativeSafeInteger(record.interactionGeneration) ||
    !isNullableText(record.clientId) ||
    !isNullableText(record.workerInstanceId) ||
    !isNullableHash(record.resumeCapabilityHash) ||
    !isNullableNonNegativeSafeInteger(record.resumeCapabilityExpiresAtMs) ||
    !isNonNegativeSafeInteger(record.updatedAt) ||
    (record.status === 'idle' && (record.clientId !== null || record.workerInstanceId !== null)) ||
    (record.status !== 'idle' && (!record.clientId || !record.workerInstanceId))
  ) {
    throw new SqliteWorkspaceAuthorityError('corrupt', 'Controller authority metadata is invalid.');
  }
  return record as unknown as PersistedControllerState;
}

function parseRecoveryState(
  value: unknown,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
): PersistedRecoveryState {
  const record = exactRecord(value, [
    'schema',
    'sessionId',
    'layoutGeneration',
    'workerScopeId',
    'workspaceIdentityDigest',
    'status',
    'controllerGeneration',
    'interactionGeneration',
    'updatedAt',
  ]);
  assertRecordBinding(record, binding, sessionId);
  if (
    record.schema !== SQLITE_WORKSPACE_RECOVERY_STATE_SCHEMA ||
    !isRecoveryStatus(record.status) ||
    !isNonNegativeSafeInteger(record.controllerGeneration) ||
    !isNonNegativeSafeInteger(record.interactionGeneration) ||
    !isNonNegativeSafeInteger(record.updatedAt)
  ) {
    throw new SqliteWorkspaceAuthorityError('corrupt', 'Recovery authority metadata is invalid.');
  }
  return record as unknown as PersistedRecoveryState;
}

function parseDetachedRecoveryCapability(
  value: unknown,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
): PersistedDetachedRecoveryCapability {
  const record = exactRecord(value, [
    'schema',
    'sessionId',
    'layoutGeneration',
    'workerScopeId',
    'workspaceIdentityDigest',
    'clientId',
    'connectionGeneration',
    'controllerGeneration',
    'interactionGeneration',
    'capabilityHash',
    'absenceEvidenceDigest',
    'expiresAtMs',
    'state',
    'issuedAt',
    'consumedAt',
  ]);
  assertRecordBinding(record, binding, sessionId);
  if (
    record.schema !== SQLITE_WORKSPACE_DETACHED_RECOVERY_SCHEMA ||
    !isNonEmptyText(record.clientId) ||
    !isPositiveSafeInteger(record.connectionGeneration) ||
    !isNonNegativeSafeInteger(record.controllerGeneration) ||
    !isNonNegativeSafeInteger(record.interactionGeneration) ||
    !isHash(record.capabilityHash) ||
    !isHash(record.absenceEvidenceDigest) ||
    !isPositiveSafeInteger(record.expiresAtMs) ||
    (record.state !== 'active' && record.state !== 'consumed') ||
    !isNonNegativeSafeInteger(record.issuedAt) ||
    !isNullableNonNegativeSafeInteger(record.consumedAt)
  ) {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Detached recovery capability metadata is invalid.',
    );
  }
  return record as unknown as PersistedDetachedRecoveryCapability;
}

function parseOperationReceipt(
  value: unknown,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
  requestId: string,
): PersistedOperationReceipt {
  const record = exactRecord(value, [
    'schema',
    'sessionId',
    'requestId',
    'requestDigest',
    'operation',
    'status',
    'code',
    'controllerGeneration',
    'connectionGeneration',
    'interactionGeneration',
    'clientId',
    'workerInstanceId',
    'completedAt',
    'subjectDigest',
    'layoutGeneration',
    'workerScopeId',
    'workspaceIdentityDigest',
  ]);
  assertRecordBinding(record, binding, sessionId);
  if (
    record.schema !== SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA ||
    record.requestId !== requestId ||
    !isHash(record.requestDigest) ||
    !isControllerOperation(record.operation) ||
    (record.status !== 'applied' && record.status !== 'rejected') ||
    !isControllerOperationCode(record.code) ||
    !isNonNegativeSafeInteger(record.controllerGeneration) ||
    !isNonNegativeSafeInteger(record.connectionGeneration) ||
    !isNonNegativeSafeInteger(record.interactionGeneration) ||
    !isNullableText(record.clientId) ||
    !isNullableText(record.workerInstanceId) ||
    !isNonNegativeSafeInteger(record.completedAt) ||
    !isHash(record.subjectDigest)
  ) {
    throw new SqliteWorkspaceAuthorityError('corrupt', 'Controller operation receipt is invalid.');
  }
  return record as unknown as PersistedOperationReceipt;
}

function parseEffectEvidence(
  value: unknown,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
  effectId: string,
): PersistedEffectEvidence {
  const record = exactRecord(value, [
    'schema',
    'sessionId',
    'effectId',
    'workerScopeId',
    'workspaceIdentityDigest',
    'layoutGeneration',
    'ownerId',
    'invocationId',
    'attemptId',
    'requestDigest',
    'capabilityDigest',
    'state',
    'outcome',
    'terminalDigest',
    'terminalCode',
    'leaseRevision',
    'preparedAt',
    'terminalAt',
  ]);
  assertRecordBinding(record, binding, sessionId);
  if (
    record.schema !== SQLITE_WORKSPACE_EFFECT_EVIDENCE_SCHEMA ||
    record.effectId !== effectId ||
    !isNonEmptyText(record.ownerId) ||
    !isNonEmptyText(record.invocationId) ||
    !isNonEmptyText(record.attemptId) ||
    !isHash(record.requestDigest) ||
    !isNullableHash(record.capabilityDigest) ||
    (record.state !== 'prepared' && record.state !== 'terminal' && record.state !== 'unknown') ||
    !isNullableOutcome(record.outcome) ||
    !isNullableHash(record.terminalDigest) ||
    !isNullableText(record.terminalCode) ||
    !isNonNegativeSafeInteger(record.leaseRevision) ||
    !isNonNegativeSafeInteger(record.preparedAt) ||
    !isNullableNonNegativeSafeInteger(record.terminalAt)
  ) {
    throw new SqliteWorkspaceAuthorityError('corrupt', 'Effect evidence metadata is invalid.');
  }
  if (
    (record.state === 'prepared' &&
      (record.outcome !== null || record.terminalDigest !== null || record.terminalAt !== null)) ||
    (record.state === 'terminal' &&
      (record.outcome === null || record.terminalDigest === null || record.terminalAt === null))
  ) {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Effect evidence terminal state is invalid.',
    );
  }
  if (record.state === 'unknown' && (record.outcome !== 'unknown' || record.terminalAt === null)) {
    throw new SqliteWorkspaceAuthorityError('corrupt', 'Effect evidence unknown state is invalid.');
  }
  return record as unknown as PersistedEffectEvidence;
}

function parseResourceLease(
  value: unknown,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
  resourceId: string,
): PersistedResourceLease {
  const record = exactRecord(value, [
    'schema',
    'sessionId',
    'resourceId',
    'workerScopeId',
    'workspaceIdentityDigest',
    'layoutGeneration',
    'ownerId',
    'attemptId',
    'requestDigest',
    'leaseRevision',
    'expiresAtMs',
    'externalLeaseDigest',
    'state',
  ]);
  assertRecordBinding(record, binding, sessionId);
  if (
    record.schema !== SQLITE_WORKSPACE_RESOURCE_LEASE_SCHEMA ||
    record.resourceId !== resourceId ||
    !isNonEmptyText(record.ownerId) ||
    !isNonEmptyText(record.attemptId) ||
    !isHash(record.requestDigest) ||
    !isNonNegativeSafeInteger(record.leaseRevision) ||
    !isPositiveSafeInteger(record.expiresAtMs) ||
    !isNullableHash(record.externalLeaseDigest) ||
    (record.state !== 'prepared' &&
      record.state !== 'held' &&
      record.state !== 'released' &&
      record.state !== 'expired')
  ) {
    throw new SqliteWorkspaceAuthorityError('corrupt', 'Resource lease metadata is invalid.');
  }
  return record as unknown as PersistedResourceLease;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Workspace authority metadata is not an object.',
    );
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SqliteWorkspaceAuthorityError(
      'corrupt',
      'Workspace authority metadata has unknown fields.',
    );
  }
  return record;
}

function assertRecordBinding(
  record: Record<string, unknown>,
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
): void {
  if (
    record.sessionId !== sessionId ||
    record.layoutGeneration !== binding.layoutGeneration ||
    record.workerScopeId !== binding.workerScopeId ||
    record.workspaceIdentityDigest !== binding.workspaceIdentityDigest
  ) {
    throw new SqliteWorkspaceAuthorityError(
      'ownership_mismatch',
      'Workspace authority binding is invalid.',
    );
  }
}

function matchesControllerLease(
  current: PersistedControllerState,
  expected: SqliteWorkspaceControllerLeaseBinding,
  status: 'active' | 'detached',
): boolean {
  return (
    current.status === status &&
    current.sessionId === expected.sessionId &&
    current.clientId === expected.clientId &&
    current.workerInstanceId === expected.workerInstanceId &&
    current.connectionGeneration === expected.connectionGeneration &&
    current.controllerGeneration === expected.controllerGeneration
  );
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Capability secret is invalid.');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length !== 32 ||
    Buffer.from(bytes).toString('base64url') !== value ||
    new Set(bytes).size < 8
  ) {
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Capability secret is invalid.');
  }
  bytes.fill(0);
}

function assertSessionId(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Session identity is invalid.');
}

function assertRequestId(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Request identity is invalid.');
}

function assertClientIdentity(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Client identity is invalid.');
}

function assertWorkerIdentity(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Worker identity is invalid.');
}

function assertOwnerId(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Lease owner identity is invalid.');
}

function assertEffectId(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Effect identity is invalid.');
}

function assertResourceId(value: unknown): asserts value is string {
  if (!isNonEmptyText(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Resource identity is invalid.');
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (!isHash(value))
    throw new SqliteWorkspaceAuthorityError('invalid_input', `${label} is invalid.`);
}

function assertGeneration(
  value: unknown,
  label: string,
  positive = false,
): asserts value is number {
  const valid = positive ? isPositiveSafeInteger(value) : isNonNegativeSafeInteger(value);
  if (!valid) throw new SqliteWorkspaceAuthorityError('invalid_input', `${label} is invalid.`);
}

function assertFutureTimestamp(value: unknown, timestamp: number): asserts value is number {
  if (!isPositiveSafeInteger(value) || value <= timestamp) {
    throw new SqliteWorkspaceAuthorityError(
      'expired_lease',
      'Authority lease expiry is invalid or expired.',
    );
  }
}

function assertLeaseOwner(value: SqliteWorkspaceLeaseOwner): void {
  assertSessionId(value.sessionId);
  assertClientIdentity(value.clientId);
  assertWorkerIdentity(value.workerInstanceId);
  assertGeneration(value.connectionGeneration, 'connection generation', true);
  assertGeneration(value.controllerGeneration, 'controller generation');
}

function validateOperationInput(value: SqliteWorkspaceControllerOperationInput): void {
  assertSessionId(value.sessionId);
  assertRequestId(value.requestId);
  assertDigest(value.requestDigest, 'request digest');
}

function assertEffectInput(value: SqliteWorkspaceEffectPreparationInput): void {
  assertSessionId(value.sessionId);
  assertEffectId(value.effectId);
  assertOwnerId(value.ownerId);
  assertClientIdentity(value.invocationId);
  assertClientIdentity(value.attemptId);
  assertDigest(value.requestDigest, 'effect request digest');
  if (value.capabilityDigest !== undefined)
    assertDigest(value.capabilityDigest, 'capability digest');
  assertControllerLeaseInput(value.controllerLease, value.sessionId);
}

function assertEffectTerminalInput(value: SqliteWorkspaceEffectTerminalInput): void {
  assertSessionId(value.sessionId);
  assertEffectId(value.effectId);
  assertOwnerId(value.ownerId);
  assertClientIdentity(value.invocationId);
  assertClientIdentity(value.attemptId);
  assertDigest(value.requestDigest, 'effect request digest');
  assertDigest(value.terminalDigest, 'effect terminal digest');
  if (value.terminalCode !== undefined) assertClientIdentity(value.terminalCode);
  if (value.observedAtMs !== undefined)
    assertGeneration(value.observedAtMs, 'effect terminal time');
  assertControllerLeaseInput(value.controllerLease, value.sessionId);
}

function assertResourceInput(value: SqliteWorkspaceResourceLeaseInput): void {
  assertSessionId(value.sessionId);
  assertResourceId(value.resourceId);
  assertOwnerId(value.ownerId);
  assertClientIdentity(value.attemptId);
  assertDigest(value.requestDigest, 'resource request digest');
  if (value.leaseRevision !== undefined)
    assertGeneration(value.leaseRevision, 'resource lease revision');
  assertControllerLeaseInput(value.controllerLease, value.sessionId);
}

function assertResourceAcquiredInput(value: {
  readonly sessionId: string;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly leaseRevision: number;
  readonly expiresAtMs: number;
  readonly externalLeaseDigest: string;
  readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
}): void {
  assertResourceInput(value);
  assertGeneration(value.leaseRevision, 'resource lease revision');
  assertDigest(value.externalLeaseDigest, 'external lease digest');
}

function assertControllerLeaseInput(
  value: SqliteWorkspaceControllerLeaseBinding,
  sessionId: string,
): void {
  if (value.sessionId !== sessionId) {
    throw new SqliteWorkspaceAuthorityError(
      'ownership_mismatch',
      'Controller lease session does not match the Workspace effect.',
    );
  }
  assertClientIdentity(value.clientId);
  assertGeneration(value.connectionGeneration, 'connection generation', true);
  assertGeneration(value.controllerGeneration, 'controller generation', true);
  assertWorkerIdentity(value.workerInstanceId);
}

function assertResourceReleasedInput(value: {
  readonly sessionId: string;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly leaseRevision: number;
  readonly externalLeaseDigest: string;
  readonly controllerLease: SqliteWorkspaceControllerLeaseBinding;
}): void {
  assertResourceAcquiredInput({ ...value, expiresAtMs: Number.MAX_SAFE_INTEGER });
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isNonEmptyText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
  );
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isNonEmptyText(value);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || isHash(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNullableNonNegativeSafeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function isControllerStatus(value: unknown): value is SqliteWorkspaceControllerStatus {
  return value === 'idle' || value === 'active' || value === 'detached';
}

function isRecoveryStatus(value: unknown): value is SqliteWorkspaceRecoveryStatus {
  return value === 'normal' || value === 'detached' || value === 'recovery_required';
}

function isControllerOperation(value: unknown): value is SqliteWorkspaceControllerOperation {
  return (
    value === 'request_control' ||
    value === 'release_control' ||
    value === 'detach_controller' ||
    value === 'issue_resume_capability' ||
    value === 'resume_controller' ||
    value === 'mint_detached_recovery_capability' ||
    value === 'abandon_detached_controller'
  );
}

function isControllerOperationCode(
  value: unknown,
): value is SqliteWorkspaceControllerOperationCode {
  return (
    value === 'acquired' ||
    value === 'released' ||
    value === 'detached' ||
    value === 'resume_capability_issued' ||
    value === 'resumed' ||
    value === 'detached_recovery_capability_issued' ||
    value === 'abandoned' ||
    value === 'controller_busy' ||
    value === 'detached_requires_recovery' ||
    value === 'stale_lease' ||
    value === 'capability_invalid' ||
    value === 'capability_expired' ||
    value === 'capability_consumed' ||
    value === 'recovery_generation_mismatch'
  );
}

/**
 * Store-private half of the compound create transaction.  The caller must
 * already hold the database's BEGIN IMMEDIATE lock; this function never
 * starts or commits a transaction on its own.  It is intentionally not
 * re-exported from the package root: only the SQLite adapter may bind it to
 * the Runtime transaction port.
 */
export function createSqliteWorkspaceInitialControllerTransaction(input: {
  readonly db: Database;
  readonly binding: SqliteRuntimeWorkspaceBinding;
  readonly request: SqliteWorkspaceInitialControllerInput;
  readonly mode: 'create' | 'replay';
  readonly nowMs?: () => number;
  readonly assertConnection?: (
    database: Database,
    binding: SqliteRuntimeWorkspaceBinding,
  ) => unknown;
  readonly ensureSession?: (sessionId: string) => void;
  readonly metadataKey?: (key: string) => string;
  readonly readMetadata?: (key: string) => unknown | undefined;
  readonly writeMetadata?: (key: string, value: unknown) => void;
}): SqliteWorkspaceControllerOperationResult {
  assertSqliteRuntimeWorkspaceBinding(input.binding);
  (input.assertConnection ?? assertWorkspaceSqliteRuntimeStoreConnection)(input.db, input.binding);
  const request = input.request;
  assertClientIdentity(request.clientId);
  assertGeneration(request.connectionGeneration, 'connection generation', true);
  assertWorkerIdentity(request.workerInstanceId);
  assertSecret(request.resumeSecret);
  const timestamp = input.nowMs?.() ?? Date.now();
  if (!isNonNegativeSafeInteger(timestamp)) {
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Authority clock is invalid.');
  }
  assertFutureTimestamp(request.resumeExpiresAtMs, timestamp);

  if (input.ensureSession) {
    input.ensureSession(request.sessionId);
  } else {
    const session = input.db
      .query<{ worker_scope_id: string; workspace_identity_digest: string }, [string]>(
        'SELECT worker_scope_id, workspace_identity_digest FROM runtime_sessions WHERE session_id = ? LIMIT 1',
      )
      .get(request.sessionId);
    if (
      !session ||
      session.worker_scope_id !== input.binding.workerScopeId ||
      session.workspace_identity_digest !== input.binding.workspaceIdentityDigest
    ) {
      throw new SqliteWorkspaceAuthorityError(
        'ownership_mismatch',
        'Workspace authority Session ownership is invalid.',
      );
    }
  }

  const metadataKey = input.metadataKey ?? ((key: string): string => key);
  const readMetadata = input.readMetadata ?? ((key: string) => readJson(input.db, key));
  const writeMetadata =
    input.writeMetadata ?? ((key: string, value: unknown) => writeJson(input.db, key, value));
  const stateKey = metadataKey(authorityKey('controller', request.sessionId));
  const recoveryKey = metadataKey(authorityKey('recovery', request.sessionId));
  const operationKey = metadataKey(authorityKey('operation', request.sessionId, request.requestId));
  const operationValue = readMetadata(operationKey);
  const subjectDigest = digestJson({
    clientId: request.clientId,
    connectionGeneration: request.connectionGeneration,
    workerInstanceId: request.workerInstanceId,
    resumeSecretHash: hashSecret(request.resumeSecret),
    resumeExpiresAtMs: request.resumeExpiresAtMs,
  });
  const readState = (): PersistedControllerState => {
    const value = readMetadata(stateKey);
    return value === undefined
      ? defaultInitialControllerState(input.binding, request.sessionId)
      : parseControllerState(value, input.binding, request.sessionId);
  };

  if (input.mode === 'replay') {
    if (operationValue === undefined) {
      throw new SqliteWorkspaceAuthorityError(
        'unknown_result',
        'Initial Controller Runtime receipt has no matching authority receipt.',
      );
    }
    const existing = parseOperationReceipt(
      operationValue,
      input.binding,
      request.sessionId,
      request.requestId,
    );
    if (
      existing.operation !== 'request_control' ||
      existing.requestDigest !== request.requestDigest ||
      existing.subjectDigest !== subjectDigest
    ) {
      throw new SqliteWorkspaceAuthorityError(
        'idempotency_conflict',
        'Initial Controller operation identity conflicts with its durable receipt.',
      );
    }
    const replay = operationResult(existing, readState(), true);
    if (replay.status === 'rejected') {
      throw new SqliteWorkspaceAuthorityError(
        'unknown_result',
        'Initial Controller replay has a rejected durable receipt.',
      );
    }
    return replay;
  }

  if (operationValue !== undefined || readMetadata(stateKey) !== undefined) {
    throw new SqliteWorkspaceAuthorityError(
      'idempotency_conflict',
      'Initial Controller target already has authority state.',
    );
  }
  if (readMetadata(recoveryKey) !== undefined) {
    throw new SqliteWorkspaceAuthorityError(
      'idempotency_conflict',
      'Initial Controller target already has recovery state.',
    );
  }

  const current = defaultInitialControllerState(input.binding, request.sessionId);
  const next: PersistedControllerState = {
    ...current,
    status: 'active',
    controllerGeneration: 1,
    connectionGeneration: request.connectionGeneration,
    clientId: request.clientId,
    workerInstanceId: request.workerInstanceId,
    resumeCapabilityHash: hashSecret(request.resumeSecret),
    resumeCapabilityExpiresAtMs: request.resumeExpiresAtMs,
    updatedAt: timestamp,
  };
  writeMetadata(stateKey, next);
  writeMetadata(recoveryKey, {
    schema: SQLITE_WORKSPACE_RECOVERY_STATE_SCHEMA,
    sessionId: request.sessionId,
    layoutGeneration: input.binding.layoutGeneration,
    workerScopeId: input.binding.workerScopeId,
    workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
    status: 'normal',
    controllerGeneration: next.controllerGeneration,
    interactionGeneration: next.interactionGeneration,
    updatedAt: timestamp,
  } satisfies PersistedRecoveryState);
  const receipt: PersistedOperationReceipt = {
    schema: SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA,
    sessionId: request.sessionId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    operation: 'request_control',
    status: 'applied',
    code: 'acquired',
    controllerGeneration: next.controllerGeneration,
    connectionGeneration: next.connectionGeneration,
    interactionGeneration: next.interactionGeneration,
    clientId: next.clientId,
    workerInstanceId: next.workerInstanceId,
    completedAt: timestamp,
    subjectDigest,
    layoutGeneration: input.binding.layoutGeneration,
    workerScopeId: input.binding.workerScopeId,
    workspaceIdentityDigest: input.binding.workspaceIdentityDigest,
  };
  writeMetadata(operationKey, receipt);
  return operationResult(receipt, next, false);
}

function defaultInitialControllerState(
  binding: SqliteRuntimeWorkspaceBinding,
  sessionId: string,
): PersistedControllerState {
  return {
    schema: SQLITE_WORKSPACE_AUTHORITY_SCHEMA,
    sessionId,
    layoutGeneration: binding.layoutGeneration,
    workerScopeId: binding.workerScopeId,
    workspaceIdentityDigest: binding.workspaceIdentityDigest,
    status: 'idle',
    controllerGeneration: 0,
    connectionGeneration: 0,
    interactionGeneration: 0,
    clientId: null,
    workerInstanceId: null,
    resumeCapabilityHash: null,
    resumeCapabilityExpiresAtMs: null,
    updatedAt: 0,
  };
}

function isNullableOutcome(value: unknown): value is 'succeeded' | 'failed' | 'unknown' | null {
  return value === null || value === 'succeeded' || value === 'failed' || value === 'unknown';
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new SqliteWorkspaceAuthorityError('invalid_input', 'Authority generation exhausted.');
  }
  return value + 1;
}
