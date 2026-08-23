import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  FilesystemCommitGrant,
  FilesystemObserveGrant,
  FilesystemPreimageArtifactRef,
  FilesystemPrepareGrant,
  WorkspaceFilesystemGrantBinding,
  WorkspaceFilesystemGrantVerifier,
  WorkspaceFilesystemMutationOperation,
  WorkspaceFilesystemMutationReadyRecord,
  WorkspaceFilesystemObserveOperation,
  WorkspaceFilesystemOperation,
  WorkspaceFilesystemPreparedMutation,
  WorkspaceFilesystemProtectedBoundary,
  WorkspaceFilesystemProviderFailureCode,
  WorkspaceFilesystemTargetEvidence,
  WorkspaceFilesystemTargetIdentity,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_ } from '@kite/runtime-spi';
import { validateWorkspaceFilesystemMutationReadyRecord } from './evidence';

export type { WorkspaceFilesystemGrantVerifier } from '@kite/runtime-spi';

export {
  validateWorkspaceFilesystemIntentRecord,
  validateWorkspaceFilesystemMutationReadyRecord,
  validateWorkspaceFilesystemObservationRecord,
  workspaceFilesystemIntentDigest,
  workspaceFilesystemMutationReadyDigest,
} from './evidence';

const MAX_GRANT_TTL_MS = 5 * 60_000;
const MAX_PATH_CHARS = 16_384;
const MAX_OPERATION_STRING_CHARS = 16 * 1024 * 1024;
const MAX_IDENTITY_CHARS = 4_096;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class WorkspaceFilesystemGrantError extends Error {
  readonly code: Extract<
    WorkspaceFilesystemProviderFailureCode,
    'invalid_grant' | 'expired_grant' | 'consumed_grant'
  >;

  constructor(
    code: WorkspaceFilesystemGrantError['code'],
    message = 'Workspace filesystem grant was rejected.',
  ) {
    super(message);
    this.name = 'WorkspaceFilesystemGrantError';
    this.code = code;
  }
}

export interface WorkspaceFilesystemGrantAuthorityOptions {
  readonly now?: () => number;
  readonly idSource?: () => string;
  readonly maximumTtlMs?: number;
}

/** Opaque authority-owned proof that Pipeline confirmed an exact durable ready record. */
export interface WorkspaceFilesystemMutationReadyAuthorization {
  readonly schema: 'kite.workspace-filesystem-ready-authorization.v1';
}

export class WorkspaceFilesystemGrantAuthority {
  readonly #now: () => number;
  readonly #idSource: () => string;
  readonly #maximumTtlMs: number;
  readonly #consumedCommitGrantIds = new Set<string>();
  readonly #readyAuthorizations = new WeakMap<
    object,
    {
      binding: WorkspaceFilesystemGrantBinding;
      operation: WorkspaceFilesystemMutationOperation;
      protectedBoundary: WorkspaceFilesystemProtectedBoundary;
      prepared: WorkspaceFilesystemPreparedMutation;
      ready: WorkspaceFilesystemMutationReadyRecord;
    }
  >();
  readonly #verifier: WorkspaceFilesystemGrantVerifier;

  constructor(options: WorkspaceFilesystemGrantAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#idSource = options.idSource ?? randomUUID;
    this.#maximumTtlMs = positiveInteger(options.maximumTtlMs ?? MAX_GRANT_TTL_MS, 'maximumTtlMs');
    this.#verifier = Object.freeze({
      verifyObserve: (grant: FilesystemObserveGrant) => this.#verify(grant, 'observe'),
      verifyPrepare: (grant: FilesystemPrepareGrant) => this.#verify(grant, 'prepare_mutation'),
      verifyAndConsumeCommit: (grant: FilesystemCommitGrant) => {
        const verified = this.#verify(grant, 'commit_mutation');
        if (this.#consumedCommitGrantIds.has(verified.grantId)) {
          throw new WorkspaceFilesystemGrantError(
            'consumed_grant',
            'Workspace filesystem commit grant was already consumed.',
          );
        }
        this.#consumedCommitGrantIds.add(verified.grantId);
        return verified;
      },
    });
  }

  verifier(): WorkspaceFilesystemGrantVerifier {
    return this.#verifier;
  }

  issueObserveGrant(input: {
    readonly binding: WorkspaceFilesystemGrantBinding;
    readonly operation: WorkspaceFilesystemObserveOperation;
    readonly protectedBoundary: WorkspaceFilesystemProtectedBoundary;
    readonly ttlMs: number;
  }): Readonly<FilesystemObserveGrant> {
    return this.#issue(
      'observe',
      input.binding,
      input.operation,
      input.ttlMs,
      input.protectedBoundary,
    ) as Readonly<FilesystemObserveGrant>;
  }

  issuePrepareGrant(input: {
    readonly binding: WorkspaceFilesystemGrantBinding;
    readonly operation: WorkspaceFilesystemMutationOperation;
    readonly protectedBoundary: WorkspaceFilesystemProtectedBoundary;
    readonly ttlMs: number;
  }): Readonly<FilesystemPrepareGrant> {
    return this.#issue(
      'prepare_mutation',
      input.binding,
      input.operation,
      input.ttlMs,
      input.protectedBoundary,
    ) as Readonly<FilesystemPrepareGrant>;
  }

  acknowledgeMutationReady(input: {
    readonly binding: WorkspaceFilesystemGrantBinding;
    readonly operation: WorkspaceFilesystemMutationOperation;
    readonly protectedBoundary: WorkspaceFilesystemProtectedBoundary;
    readonly prepared: WorkspaceFilesystemPreparedMutation;
    readonly ready: WorkspaceFilesystemMutationReadyRecord;
  }): Readonly<WorkspaceFilesystemMutationReadyAuthorization> {
    const binding = validatedBinding(input.binding);
    const operation = validatedOperation(input.operation, 'mutation');
    const protectedBoundary = validatedProtectedBoundary(input.protectedBoundary);
    assertProtectedBoundaryBinding(binding, protectedBoundary);
    const operationDigest = workspaceFilesystemOperationDigest(operation);
    const prepared = validatedPreparedMutation(input.prepared);
    if (
      prepared.operationKind !== operation.kind ||
      prepared.operationDigest !== operationDigest ||
      prepared.target.lexicalPath !== operation.path
    ) {
      throw new WorkspaceFilesystemGrantError(
        'invalid_grant',
        'Prepared filesystem mutation does not match the commit operation.',
      );
    }
    const ready = validatedMutationReadyRecord(input.ready);
    if (
      ready.attempt !== binding.attempt ||
      ready.intentDigest !== binding.intentDigest ||
      ready.operationDigest !== operationDigest ||
      ready.targetIdentityDigest !== prepared.targetIdentityDigest ||
      ready.preimageDigest !== prepared.preimageDigest
    ) {
      throw new WorkspaceFilesystemGrantError(
        'invalid_grant',
        'Mutation-ready record does not match the prepared filesystem mutation.',
      );
    }
    const token = Object.freeze({
      schema: 'kite.workspace-filesystem-ready-authorization.v1' as const,
    });
    this.#readyAuthorizations.set(token, {
      binding: frozenClone(binding),
      operation: frozenClone(operation),
      protectedBoundary: frozenClone(protectedBoundary),
      prepared: frozenClone(input.prepared),
      ready: frozenClone(ready),
    });
    return token;
  }

  issueCommitGrant(input: {
    readonly authorization: WorkspaceFilesystemMutationReadyAuthorization;
    readonly ttlMs: number;
  }): Readonly<FilesystemCommitGrant> {
    const acknowledged = this.#readyAuthorizations.get(input.authorization);
    if (!acknowledged) {
      throw new WorkspaceFilesystemGrantError(
        'invalid_grant',
        'Mutation-ready authorization was not issued by this grant authority.',
      );
    }
    this.#readyAuthorizations.delete(input.authorization);
    const binding = validatedBinding(acknowledged.binding);
    const operation = validatedOperation(
      acknowledged.operation,
      'mutation',
    ) as WorkspaceFilesystemMutationOperation;
    const operationDigest = workspaceFilesystemOperationDigest(operation);
    const prepared = validatedPreparedMutation(acknowledged.prepared);
    const ready = validatedMutationReadyRecord(acknowledged.ready);
    const timing = this.#timing(input.ttlMs);
    const unsigned = {
      schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_,
      purpose: 'commit_mutation' as const,
      grantId: requiredString(this.#idSource(), 'grantId', MAX_IDENTITY_CHARS),
      ...binding,
      operation,
      operationDigest,
      protectedBoundary: acknowledged.protectedBoundary,
      preparedTargetIdentity: prepared.target,
      preparedTargetIdentityDigest: prepared.targetIdentityDigest,
      preimageDigest: prepared.preimageDigest,
      preimageArtifact: ready.preimageArtifact,
      mutationReady: ready,
      mutationReadyDigest: ready.readyDigest,
      ...timing,
    };
    return frozenClone({ ...unsigned, seal: this.#seal(unsigned) });
  }

  #issue(
    purpose: 'observe' | 'prepare_mutation',
    binding: WorkspaceFilesystemGrantBinding,
    operation: WorkspaceFilesystemOperation,
    ttlMs: number,
    protectedBoundary: WorkspaceFilesystemProtectedBoundary,
  ): Readonly<FilesystemObserveGrant | FilesystemPrepareGrant> {
    const validated = validatedOperation(operation, purpose === 'observe' ? 'observe' : 'mutation');
    const validatedBindingValue = validatedBinding(binding);
    const boundary = validatedProtectedBoundary(protectedBoundary);
    assertProtectedBoundaryBinding(validatedBindingValue, boundary);
    const timing = this.#timing(ttlMs);
    const unsigned = {
      schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_,
      purpose,
      grantId: requiredString(this.#idSource(), 'grantId', MAX_IDENTITY_CHARS),
      ...validatedBindingValue,
      operation: validated,
      operationDigest: workspaceFilesystemOperationDigest(validated),
      protectedBoundary: boundary,
      ...timing,
    };
    return frozenClone({ ...unsigned, seal: this.#seal(unsigned) }) as Readonly<
      FilesystemObserveGrant | FilesystemPrepareGrant
    >;
  }

  #timing(ttlMs: number): { issuedAtMs: number; expiresAtMs: number } {
    const ttl = positiveInteger(ttlMs, 'ttlMs');
    if (ttl > this.#maximumTtlMs) throw new Error('Workspace filesystem grant TTL is too large.');
    const issuedAtMs = safeTimestamp(this.#now(), 'issuedAtMs');
    const expiresAtMs = issuedAtMs + ttl;
    if (!Number.isSafeInteger(expiresAtMs))
      throw new Error('Workspace filesystem grant TTL overflow.');
    return { issuedAtMs, expiresAtMs };
  }

  #seal(unsigned: object): string {
    return `sha256:${createHash('sha256')
      .update('kite.workspace-filesystem-grant.v1\0')
      .update(canonicalJson(unsigned))
      .digest('hex')}`;
  }

  #verify<Grant extends FilesystemObserveGrant | FilesystemPrepareGrant | FilesystemCommitGrant>(
    value: Grant,
    expectedPurpose: Grant['purpose'],
  ): Readonly<Grant> {
    try {
      assertGrantShape(value, expectedPurpose);
      const { seal, ...unsigned } = value;
      const expected = this.#seal(unsigned);
      if (!safeEqual(seal, expected)) throw new Error('seal mismatch');
      const now = safeTimestamp(this.#now(), 'now');
      if (now >= value.expiresAtMs) {
        throw new WorkspaceFilesystemGrantError(
          'expired_grant',
          'Workspace filesystem grant expired before Provider I/O.',
        );
      }
      if (value.issuedAtMs > now || value.expiresAtMs - value.issuedAtMs > this.#maximumTtlMs) {
        throw new Error('invalid timing');
      }
      return frozenClone(value);
    } catch (error) {
      if (error instanceof WorkspaceFilesystemGrantError) throw error;
      throw new WorkspaceFilesystemGrantError(
        'invalid_grant',
        'Workspace filesystem grant failed structural or integrity validation.',
      );
    }
  }
}

function validatedPreparedMutation(value: unknown): {
  operationKind: WorkspaceFilesystemMutationOperation['kind'];
  operationDigest: string;
  target: WorkspaceFilesystemTargetIdentity;
  targetIdentityDigest: string;
  preimageDigest: string | null;
} {
  const prepared = plainRecord(value, 'prepared mutation');
  exactKeys(
    prepared,
    [
      'kind',
      'operationKind',
      'operationDigest',
      'target',
      'targetEvidence',
      'targetIdentityDigest',
      'preimage',
    ],
    'prepared mutation',
  );
  if (prepared.kind !== 'prepared_mutation') throw new Error('prepared mutation kind');
  if (prepared.operationKind !== 'write_file' && prepared.operationKind !== 'edit_file') {
    throw new Error('prepared mutation operation kind');
  }
  const operationDigest = requiredString(prepared.operationDigest, 'operationDigest', 256);
  const target = validatedTargetIdentity(prepared.target);
  const targetIdentityDigest = requiredString(
    prepared.targetIdentityDigest,
    'targetIdentityDigest',
    256,
  );
  if (targetIdentityDigest !== workspaceFilesystemTargetIdentityDigest(target)) {
    throw new Error('prepared target digest mismatch');
  }
  const evidence = plainRecord(prepared.targetEvidence, 'target evidence');
  exactKeys(
    evidence,
    ['lexicalTargetDigest', 'canonicalTargetDigest', 'targetIdentityDigest'],
    'target evidence',
  );
  const expectedEvidence = workspaceFilesystemTargetEvidence(target);
  if (
    evidence.lexicalTargetDigest !== expectedEvidence.lexicalTargetDigest ||
    evidence.canonicalTargetDigest !== expectedEvidence.canonicalTargetDigest ||
    evidence.targetIdentityDigest !== expectedEvidence.targetIdentityDigest
  ) {
    throw new Error('prepared target evidence mismatch');
  }
  const preimage = plainRecord(prepared.preimage, 'preimage');
  exactKeys(preimage, ['existed', 'content', 'contentDigest', 'byteLength'], 'preimage');
  if (typeof preimage.existed !== 'boolean') throw new Error('preimage existed');
  const byteLength = nonNegativeInteger(preimage.byteLength, 'preimage byteLength');
  let preimageDigest: string | null;
  if (preimage.existed) {
    const content = requiredString(
      preimage.content,
      'preimage content',
      MAX_OPERATION_STRING_CHARS,
      true,
    );
    preimageDigest = requiredString(preimage.contentDigest, 'preimage digest', 256);
    if (
      preimageDigest !== workspaceFilesystemStringDigest(content) ||
      byteLength !== Buffer.byteLength(content)
    ) {
      throw new Error('preimage integrity mismatch');
    }
  } else {
    if (preimage.content !== null || preimage.contentDigest !== null || byteLength !== 0) {
      throw new Error('absent preimage mismatch');
    }
    preimageDigest = null;
  }
  return {
    operationKind: prepared.operationKind,
    operationDigest,
    target,
    targetIdentityDigest,
    preimageDigest,
  };
}

function validatedPreimageArtifact(value: unknown): FilesystemPreimageArtifactRef {
  const artifact = plainRecord(value, 'preimage Artifact');
  exactKeys(
    artifact,
    ['artifactId', 'kind', 'integrityIdentifier', 'byteLength'],
    'preimage Artifact',
  );
  if (artifact.kind !== 'filesystem_preimage') throw new Error('preimage Artifact kind');
  const artifactId = requiredString(artifact.artifactId, 'artifactId', MAX_IDENTITY_CHARS);
  const integrityIdentifier = requiredString(
    artifact.integrityIdentifier,
    'integrityIdentifier',
    MAX_IDENTITY_CHARS,
  );
  if (!/^pa_[a-f0-9]{64}$/u.test(artifactId)) throw new Error('preimage Artifact id');
  if (!/^sha256:[a-f0-9]{64}$/u.test(integrityIdentifier)) {
    throw new Error('preimage Artifact integrity identifier');
  }
  return {
    artifactId,
    kind: 'filesystem_preimage',
    integrityIdentifier,
    byteLength: nonNegativeInteger(artifact.byteLength, 'Artifact byteLength'),
  };
}

function validatedProtectedBoundary(value: unknown): WorkspaceFilesystemProtectedBoundary {
  const boundary = plainRecord(value, 'protected boundary');
  exactKeys(
    boundary,
    [
      'schema',
      'canonicalWorkspace',
      'policyMode',
      'excludedSubtrees',
      'excludedFiles',
      'excludedFilePrefixes',
      'additionalDeniedCanonicalPaths',
      'allowedCanonicalPaths',
      'boundaryDigest',
    ],
    'protected boundary',
  );
  if (boundary.schema !== 'kite.workspace-filesystem-protected-boundary.v1') {
    throw new Error('protected boundary schema');
  }
  if (boundary.policyMode !== 'deny' && boundary.policyMode !== 'prompt') {
    throw new Error('protected boundary policy mode');
  }
  const canonicalWorkspace = requiredString(
    boundary.canonicalWorkspace,
    'protected boundary workspace',
    MAX_PATH_CHARS,
  );
  if (!isAbsolute(canonicalWorkspace)) throw new Error('protected boundary workspace');
  const result = {
    schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
    canonicalWorkspace,
    policyMode: boundary.policyMode,
    excludedSubtrees: validatedRelativePathList(boundary.excludedSubtrees, 'excludedSubtrees'),
    excludedFiles: validatedRelativePathList(boundary.excludedFiles, 'excludedFiles'),
    excludedFilePrefixes: validatedRelativePathList(
      boundary.excludedFilePrefixes,
      'excludedFilePrefixes',
    ),
    additionalDeniedCanonicalPaths: validatedAbsolutePathList(
      boundary.additionalDeniedCanonicalPaths,
      'additionalDeniedCanonicalPaths',
    ),
    allowedCanonicalPaths: validatedAbsolutePathList(
      boundary.allowedCanonicalPaths,
      'allowedCanonicalPaths',
    ),
    boundaryDigest: requiredString(boundary.boundaryDigest, 'boundaryDigest', 256),
  } satisfies WorkspaceFilesystemProtectedBoundary;
  const { boundaryDigest, ...unsigned } = result;
  if (boundaryDigest !== workspaceFilesystemProtectedBoundaryDigest(unsigned)) {
    throw new Error('protected boundary digest mismatch');
  }
  return result;
}

function validatedRelativePathList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(name);
  const result = value.map((item) => {
    const path = requiredString(item, name, MAX_PATH_CHARS);
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      path === '.' ||
      path === '..' ||
      path.startsWith('../') ||
      path.includes('/../') ||
      path.endsWith('/..') ||
      path.startsWith('./') ||
      path.includes('//')
    ) {
      throw new Error(name);
    }
    return path;
  });
  if (new Set(result).size !== result.length) throw new Error(name);
  return result;
}

function validatedAbsolutePathList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(name);
  const result = value.map((item) => {
    const path = requiredString(item, name, MAX_PATH_CHARS);
    if (!isAbsolute(path)) throw new Error(name);
    return path;
  });
  if (new Set(result).size !== result.length) throw new Error(name);
  return result;
}

const validatedMutationReadyRecord = validateWorkspaceFilesystemMutationReadyRecord;

export function workspaceFilesystemOperationDigest(
  operation: WorkspaceFilesystemOperation,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(operation)).digest('hex')}`;
}

export function validateWorkspaceFilesystemOperation(
  operation: WorkspaceFilesystemOperation,
  family: 'observe' | 'mutation',
): Readonly<WorkspaceFilesystemOperation> {
  return frozenClone(validatedOperation(operation, family));
}

export function workspaceFilesystemProtectedBoundaryDigest(
  boundary: Omit<WorkspaceFilesystemProtectedBoundary, 'boundaryDigest'>,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(boundary)).digest('hex')}`;
}

export function workspaceFilesystemTargetIdentityDigest(
  target: WorkspaceFilesystemTargetIdentity,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(target)).digest('hex')}`;
}

export function workspaceFilesystemStringDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Stable postimage compatibility hash for normalized Workspace file content. */
export function workspaceFilesystemContentHash(value: string): string {
  return workspaceFilesystemStringDigest(value).slice('sha256:'.length);
}

export function workspaceFilesystemTargetEvidence(
  target: WorkspaceFilesystemTargetIdentity,
): Readonly<WorkspaceFilesystemTargetEvidence> {
  return deepFreeze({
    lexicalTargetDigest: workspaceFilesystemStringDigest(target.lexicalPath),
    canonicalTargetDigest: workspaceFilesystemStringDigest(target.canonicalPath),
    targetIdentityDigest: workspaceFilesystemTargetIdentityDigest(target),
  });
}

function assertGrantShape(
  value: unknown,
  expectedPurpose: 'observe' | 'prepare_mutation' | 'commit_mutation',
): asserts value is FilesystemObserveGrant | FilesystemPrepareGrant | FilesystemCommitGrant {
  const grant = plainRecord(value, 'grant');
  const baseKeys = [
    'schema',
    'purpose',
    'grantId',
    'threadId',
    'turnId',
    'toolCallId',
    'invocationId',
    'attempt',
    'intentDigest',
    'searchBoundaryDigest',
    'capabilityRevision',
    'effectDigest',
    'canonicalWorkspace',
    'protectedPathRevision',
    'approvalSummary',
    'operation',
    'operationDigest',
    'protectedBoundary',
    'issuedAtMs',
    'expiresAtMs',
    'seal',
  ];
  const expectedKeys =
    expectedPurpose === 'commit_mutation'
      ? [
          ...baseKeys,
          'preparedTargetIdentity',
          'preparedTargetIdentityDigest',
          'preimageDigest',
          'preimageArtifact',
          'mutationReady',
          'mutationReadyDigest',
        ]
      : baseKeys;
  exactKeys(grant, expectedKeys, 'grant');
  if (grant.schema !== WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_ || grant.purpose !== expectedPurpose) {
    throw new Error('purpose mismatch');
  }
  validatedBinding({
    threadId: grant.threadId as string,
    turnId: grant.turnId as string,
    toolCallId: grant.toolCallId as string,
    invocationId: grant.invocationId as string,
    attempt: grant.attempt as number,
    intentDigest: grant.intentDigest as string,
    searchBoundaryDigest: grant.searchBoundaryDigest as string | null,
    capabilityRevision: grant.capabilityRevision as string,
    effectDigest: grant.effectDigest as string,
    canonicalWorkspace: grant.canonicalWorkspace as string,
    protectedPathRevision: grant.protectedPathRevision as string,
    approvalSummary: grant.approvalSummary as string,
  });
  requiredString(grant.grantId, 'grantId', MAX_IDENTITY_CHARS);
  const operation = validatedOperation(
    grant.operation,
    expectedPurpose === 'observe' ? 'observe' : 'mutation',
  );
  if (grant.operationDigest !== workspaceFilesystemOperationDigest(operation)) {
    throw new Error('operation digest mismatch');
  }
  const protectedBoundary = validatedProtectedBoundary(grant.protectedBoundary);
  if (
    protectedBoundary.boundaryDigest !== grant.searchBoundaryDigest ||
    !sameCanonicalWorkspaceIdentity(
      protectedBoundary.canonicalWorkspace,
      grant.canonicalWorkspace as string,
    )
  ) {
    throw new Error('protected boundary mismatch');
  }
  safeTimestamp(grant.issuedAtMs, 'issuedAtMs');
  safeTimestamp(grant.expiresAtMs, 'expiresAtMs');
  requiredString(grant.seal, 'seal', 256);
  if (expectedPurpose === 'commit_mutation') {
    const target = validatedTargetIdentity(grant.preparedTargetIdentity);
    if (grant.preparedTargetIdentityDigest !== workspaceFilesystemTargetIdentityDigest(target)) {
      throw new Error('target digest mismatch');
    }
    if (grant.preimageDigest !== null) requiredString(grant.preimageDigest, 'preimageDigest', 256);
    const artifact = validatedPreimageArtifact(grant.preimageArtifact);
    const ready = validatedMutationReadyRecord(grant.mutationReady);
    if (
      grant.mutationReadyDigest !== ready.readyDigest ||
      ready.preimageArtifact.artifactId !== artifact.artifactId ||
      ready.preimageArtifact.integrityIdentifier !== artifact.integrityIdentifier ||
      ready.preimageArtifact.byteLength !== artifact.byteLength ||
      ready.attempt !== grant.attempt ||
      ready.intentDigest !== grant.intentDigest ||
      ready.operationDigest !== grant.operationDigest ||
      ready.targetIdentityDigest !== grant.preparedTargetIdentityDigest ||
      ready.preimageDigest !== grant.preimageDigest
    ) {
      throw new Error('commit ready binding mismatch');
    }
  }
}

function assertProtectedBoundaryBinding(
  binding: WorkspaceFilesystemGrantBinding,
  boundary: WorkspaceFilesystemProtectedBoundary,
): void {
  if (
    binding.searchBoundaryDigest !== boundary.boundaryDigest ||
    !sameCanonicalWorkspaceIdentity(binding.canonicalWorkspace, boundary.canonicalWorkspace)
  ) {
    throw new WorkspaceFilesystemGrantError(
      'invalid_grant',
      'Filesystem protected boundary does not match the admitted grant binding.',
    );
  }
}

/** Windows canonical filesystem identities are case-insensitive even when one
 * native API preserves a display-case spelling and another normalizes it. */
function sameCanonicalWorkspaceIdentity(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validatedBinding(value: WorkspaceFilesystemGrantBinding): WorkspaceFilesystemGrantBinding {
  const binding = plainRecord(value, 'binding');
  exactKeys(
    binding,
    [
      'threadId',
      'turnId',
      'toolCallId',
      'invocationId',
      'attempt',
      'intentDigest',
      'searchBoundaryDigest',
      'capabilityRevision',
      'effectDigest',
      'canonicalWorkspace',
      'protectedPathRevision',
      'approvalSummary',
    ],
    'binding',
  );
  const canonicalWorkspace = requiredString(
    binding.canonicalWorkspace,
    'canonicalWorkspace',
    MAX_PATH_CHARS,
  );
  if (!isAbsolute(canonicalWorkspace)) throw new Error('canonicalWorkspace must be absolute');
  return {
    threadId: requiredString(binding.threadId, 'threadId', MAX_IDENTITY_CHARS),
    turnId: requiredString(binding.turnId, 'turnId', MAX_IDENTITY_CHARS),
    toolCallId: requiredString(binding.toolCallId, 'toolCallId', MAX_IDENTITY_CHARS),
    invocationId: requiredString(binding.invocationId, 'invocationId', MAX_IDENTITY_CHARS),
    attempt: positiveInteger(binding.attempt, 'attempt'),
    intentDigest: requiredString(binding.intentDigest, 'intentDigest', 256),
    searchBoundaryDigest:
      binding.searchBoundaryDigest === null
        ? null
        : requiredString(binding.searchBoundaryDigest, 'searchBoundaryDigest', 256),
    capabilityRevision: requiredString(
      binding.capabilityRevision,
      'capabilityRevision',
      MAX_IDENTITY_CHARS,
    ),
    effectDigest: requiredString(binding.effectDigest, 'effectDigest', MAX_IDENTITY_CHARS),
    canonicalWorkspace,
    protectedPathRevision: requiredString(
      binding.protectedPathRevision,
      'protectedPathRevision',
      MAX_IDENTITY_CHARS,
    ),
    approvalSummary: requiredString(binding.approvalSummary, 'approvalSummary', MAX_IDENTITY_CHARS),
  };
}

function validatedOperation(
  value: unknown,
  family: 'observe' | 'mutation',
): WorkspaceFilesystemOperation {
  const operation = plainRecord(value, 'operation');
  const kind = operation.kind;
  const common = () => {
    const path = requiredString(operation.path, 'operation.path', MAX_PATH_CHARS, true);
    if (
      operation.pathScope !== 'workspace_only' &&
      operation.pathScope !== 'external_read' &&
      operation.pathScope !== 'approved_external'
    ) {
      throw new Error('invalid pathScope');
    }
    return { path, pathScope: operation.pathScope } as const;
  };
  if (family === 'observe' && kind === 'read_file') {
    exactKeys(operation, ['kind', 'path', 'pathScope', 'offset', 'limit'], 'read_file', [
      'offset',
      'limit',
    ]);
    return {
      kind,
      ...common(),
      ...(operation.offset === undefined
        ? {}
        : { offset: positiveInteger(operation.offset, 'offset') }),
      ...(operation.limit === undefined
        ? {}
        : { limit: positiveInteger(operation.limit, 'limit') }),
    };
  }
  if (family === 'observe' && kind === 'search_files') {
    exactKeys(operation, ['kind', 'path', 'pathScope', 'pattern'], 'search_files');
    return {
      kind,
      ...common(),
      pattern: requiredString(operation.pattern, 'pattern', MAX_IDENTITY_CHARS, true),
    };
  }
  if (family === 'observe' && kind === 'search_content') {
    exactKeys(operation, ['kind', 'path', 'pathScope', 'pattern', 'glob'], 'search_content', [
      'glob',
    ]);
    return {
      kind,
      ...common(),
      pattern: requiredString(operation.pattern, 'pattern', MAX_IDENTITY_CHARS, true),
      ...(operation.glob === undefined
        ? {}
        : { glob: requiredString(operation.glob, 'glob', MAX_IDENTITY_CHARS, true) }),
    };
  }
  if (family === 'mutation' && kind === 'write_file') {
    exactKeys(operation, ['kind', 'path', 'pathScope', 'content'], 'write_file');
    return {
      kind,
      ...common(),
      content: requiredString(operation.content, 'content', MAX_OPERATION_STRING_CHARS, true),
    };
  }
  if (family === 'mutation' && kind === 'edit_file') {
    exactKeys(
      operation,
      ['kind', 'path', 'pathScope', 'oldString', 'newString', 'replaceAll'],
      'edit_file',
      ['replaceAll'],
    );
    if (operation.replaceAll !== undefined && typeof operation.replaceAll !== 'boolean') {
      throw new Error('invalid replaceAll');
    }
    return {
      kind,
      ...common(),
      oldString: requiredString(operation.oldString, 'oldString', MAX_OPERATION_STRING_CHARS, true),
      newString: requiredString(operation.newString, 'newString', MAX_OPERATION_STRING_CHARS, true),
      ...(operation.replaceAll === undefined ? {} : { replaceAll: operation.replaceAll }),
    };
  }
  throw new Error('operation purpose mismatch');
}

function validatedTargetIdentity(value: unknown): WorkspaceFilesystemTargetIdentity {
  const target = plainRecord(value, 'target identity');
  exactKeys(
    target,
    [
      'schema',
      'lexicalPath',
      'resolvedPath',
      'canonicalPath',
      'exists',
      'noFollow',
      'followed',
      'nearestExistingCanonicalPath',
      'nearestExistingNoFollow',
    ],
    'target identity',
  );
  if (target.schema !== WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_) throw new Error('target schema');
  if (typeof target.exists !== 'boolean') throw new Error('target exists');
  const result: WorkspaceFilesystemTargetIdentity = {
    schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_,
    lexicalPath: requiredString(target.lexicalPath, 'lexicalPath', MAX_PATH_CHARS, true),
    resolvedPath: requiredString(target.resolvedPath, 'resolvedPath', MAX_PATH_CHARS),
    canonicalPath: requiredString(target.canonicalPath, 'canonicalPath', MAX_PATH_CHARS),
    exists: target.exists,
    noFollow: target.noFollow === null ? null : validatedStatIdentity(target.noFollow),
    followed: target.followed === null ? null : validatedStatIdentity(target.followed),
    nearestExistingCanonicalPath: requiredString(
      target.nearestExistingCanonicalPath,
      'nearestExistingCanonicalPath',
      MAX_PATH_CHARS,
    ),
    nearestExistingNoFollow: validatedStatIdentity(target.nearestExistingNoFollow),
  };
  if (result.exists !== Boolean(result.noFollow && result.followed))
    throw new Error('target identity');
  return result;
}

function validatedStatIdentity(
  value: unknown,
): WorkspaceFilesystemTargetIdentity['nearestExistingNoFollow'] {
  const stat = plainRecord(value, 'stat identity');
  exactKeys(stat, ['device', 'inode', 'mode', 'size', 'modifiedAtMs', 'type'], 'stat identity');
  if (!['file', 'directory', 'symlink', 'other'].includes(String(stat.type))) {
    throw new Error('stat type');
  }
  return {
    device: requiredString(stat.device, 'device', 128),
    inode: requiredString(stat.inode, 'inode', 128),
    mode: nonNegativeInteger(stat.mode, 'mode'),
    size: nonNegativeInteger(stat.size, 'size'),
    modifiedAtMs: finiteNumber(stat.modifiedAtMs, 'modifiedAtMs'),
    type: stat.type as 'file' | 'directory' | 'symlink' | 'other',
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value, '$'));
}

function toCanonicalJson(value: unknown, path: string, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}.`);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`Non-JSON value at ${path}.`);
  if (seen.has(value)) throw new Error(`Cyclic JSON value at ${path}.`);
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) => toCanonicalJson(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  const record = plainRecord(value, path);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    result[key] = toCanonicalJson(record[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${name} has symbol keys.`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new Error(`${name} has hidden or accessor fields.`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new Error(`${name}.${key}`);
  const optionalKeys = new Set(optional);
  const required = keys.filter((key) => !optionalKeys.has(key));
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${name}.${key}`);
}

function requiredString(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Invalid ${name}.`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${name}.`);
  return Number(value);
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function safeTimestamp(value: unknown, name: string): number {
  return nonNegativeInteger(value, name);
}

function safeEqual(left: string, right: string): boolean {
  return left === right;
}

function frozenClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
