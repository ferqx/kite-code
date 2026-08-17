import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateWorkspaceFilesystemMutationReadyRecordV1 } from '@/core/capabilities/workspace-filesystem-evidence';
import type { WorkspaceFilesystemMutationReadyRecordV1 } from '@/protocol/capabilities';
import type {
  FilesystemCommitGrantV1,
  FilesystemObserveGrantV1,
  FilesystemPreimageArtifactRefV1,
  FilesystemPrepareGrantV1,
  WorkspaceFilesystemGrantBindingV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemPreparedMutationV1,
  WorkspaceFilesystemProtectedBoundaryV1,
  WorkspaceFilesystemProviderFailureCodeV1,
  WorkspaceFilesystemTargetEvidenceV1,
  WorkspaceFilesystemTargetIdentityV1,
} from '@/protocol/workspace-filesystem-provider';
import { WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1 } from '@/protocol/workspace-filesystem-provider';

export {
  validateWorkspaceFilesystemIntentRecordV1,
  validateWorkspaceFilesystemMutationReadyRecordV1,
  validateWorkspaceFilesystemObservationRecordV1,
  workspaceFilesystemIntentDigestV1,
  workspaceFilesystemMutationReadyDigestV1,
} from '@/core/capabilities/workspace-filesystem-evidence';

const MAX_GRANT_TTL_MS = 5 * 60_000;
const MAX_PATH_CHARS = 16_384;
const MAX_OPERATION_STRING_CHARS = 16 * 1024 * 1024;
const MAX_IDENTITY_CHARS = 4_096;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class WorkspaceFilesystemGrantErrorV1 extends Error {
  readonly code: Extract<
    WorkspaceFilesystemProviderFailureCodeV1,
    'invalid_grant' | 'expired_grant' | 'consumed_grant'
  >;

  constructor(
    code: WorkspaceFilesystemGrantErrorV1['code'],
    message = 'Workspace filesystem grant was rejected.',
  ) {
    super(message);
    this.name = 'WorkspaceFilesystemGrantErrorV1';
    this.code = code;
  }
}

export interface WorkspaceFilesystemGrantVerifierV1 {
  verifyObserve(grant: FilesystemObserveGrantV1): Readonly<FilesystemObserveGrantV1>;
  verifyPrepare(grant: FilesystemPrepareGrantV1): Readonly<FilesystemPrepareGrantV1>;
  /** A successfully verified commit grant is consumed before Provider I/O begins. */
  verifyAndConsumeCommit(grant: FilesystemCommitGrantV1): Readonly<FilesystemCommitGrantV1>;
}

export interface WorkspaceFilesystemGrantAuthorityOptionsV1 {
  readonly integrityKey?: Uint8Array;
  readonly now?: () => number;
  readonly idSource?: () => string;
  readonly maximumTtlMs?: number;
}

/** Opaque authority-owned proof that Pipeline confirmed an exact durable ready record. */
export interface WorkspaceFilesystemMutationReadyAuthorizationV1 {
  readonly schema: 'kite.workspace-filesystem-ready-authorization.v1';
}

export class WorkspaceFilesystemGrantAuthorityV1 {
  readonly #integrityKey: Uint8Array;
  readonly #now: () => number;
  readonly #idSource: () => string;
  readonly #maximumTtlMs: number;
  readonly #consumedCommitGrantIds = new Set<string>();
  readonly #readyAuthorizations = new WeakMap<
    object,
    {
      binding: WorkspaceFilesystemGrantBindingV1;
      operation: WorkspaceFilesystemMutationOperationV1;
      protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
      prepared: WorkspaceFilesystemPreparedMutationV1;
      ready: WorkspaceFilesystemMutationReadyRecordV1;
    }
  >();
  readonly #verifier: WorkspaceFilesystemGrantVerifierV1;

  constructor(options: WorkspaceFilesystemGrantAuthorityOptionsV1 = {}) {
    const key = options.integrityKey ? new Uint8Array(options.integrityKey) : randomBytes(32);
    if (key.byteLength < 32) throw new Error('Workspace filesystem integrity key is too short.');
    this.#integrityKey = key;
    this.#now = options.now ?? Date.now;
    this.#idSource = options.idSource ?? randomUUID;
    this.#maximumTtlMs = positiveInteger(options.maximumTtlMs ?? MAX_GRANT_TTL_MS, 'maximumTtlMs');
    this.#verifier = Object.freeze({
      verifyObserve: (grant: FilesystemObserveGrantV1) => this.#verify(grant, 'observe'),
      verifyPrepare: (grant: FilesystemPrepareGrantV1) => this.#verify(grant, 'prepare_mutation'),
      verifyAndConsumeCommit: (grant: FilesystemCommitGrantV1) => {
        const verified = this.#verify(grant, 'commit_mutation');
        if (this.#consumedCommitGrantIds.has(verified.grantId)) {
          throw new WorkspaceFilesystemGrantErrorV1(
            'consumed_grant',
            'Workspace filesystem commit grant was already consumed.',
          );
        }
        this.#consumedCommitGrantIds.add(verified.grantId);
        return verified;
      },
    });
  }

  verifier(): WorkspaceFilesystemGrantVerifierV1 {
    return this.#verifier;
  }

  issueObserveGrant(input: {
    readonly binding: WorkspaceFilesystemGrantBindingV1;
    readonly operation: WorkspaceFilesystemObserveOperationV1;
    readonly protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
    readonly ttlMs: number;
  }): Readonly<FilesystemObserveGrantV1> {
    return this.#issue(
      'observe',
      input.binding,
      input.operation,
      input.ttlMs,
      input.protectedBoundary,
    ) as Readonly<FilesystemObserveGrantV1>;
  }

  issuePrepareGrant(input: {
    readonly binding: WorkspaceFilesystemGrantBindingV1;
    readonly operation: WorkspaceFilesystemMutationOperationV1;
    readonly protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
    readonly ttlMs: number;
  }): Readonly<FilesystemPrepareGrantV1> {
    return this.#issue(
      'prepare_mutation',
      input.binding,
      input.operation,
      input.ttlMs,
      input.protectedBoundary,
    ) as Readonly<FilesystemPrepareGrantV1>;
  }

  acknowledgeMutationReady(input: {
    readonly binding: WorkspaceFilesystemGrantBindingV1;
    readonly operation: WorkspaceFilesystemMutationOperationV1;
    readonly protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1;
    readonly prepared: WorkspaceFilesystemPreparedMutationV1;
    readonly ready: WorkspaceFilesystemMutationReadyRecordV1;
  }): Readonly<WorkspaceFilesystemMutationReadyAuthorizationV1> {
    const binding = validatedBinding(input.binding);
    const operation = validatedOperation(input.operation, 'mutation');
    const protectedBoundary = validatedProtectedBoundaryV1(input.protectedBoundary);
    assertProtectedBoundaryBinding(binding, protectedBoundary);
    const operationDigest = workspaceFilesystemOperationDigestV1(operation);
    const prepared = validatedPreparedMutation(input.prepared);
    if (
      prepared.operationKind !== operation.kind ||
      prepared.operationDigest !== operationDigest ||
      prepared.target.lexicalPath !== operation.path
    ) {
      throw new WorkspaceFilesystemGrantErrorV1(
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
      throw new WorkspaceFilesystemGrantErrorV1(
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
    readonly authorization: WorkspaceFilesystemMutationReadyAuthorizationV1;
    readonly ttlMs: number;
  }): Readonly<FilesystemCommitGrantV1> {
    const acknowledged = this.#readyAuthorizations.get(input.authorization);
    if (!acknowledged) {
      throw new WorkspaceFilesystemGrantErrorV1(
        'invalid_grant',
        'Mutation-ready authorization was not issued by this grant authority.',
      );
    }
    this.#readyAuthorizations.delete(input.authorization);
    const binding = validatedBinding(acknowledged.binding);
    const operation = validatedOperation(
      acknowledged.operation,
      'mutation',
    ) as WorkspaceFilesystemMutationOperationV1;
    const operationDigest = workspaceFilesystemOperationDigestV1(operation);
    const prepared = validatedPreparedMutation(acknowledged.prepared);
    const ready = validatedMutationReadyRecord(acknowledged.ready);
    const timing = this.#timing(input.ttlMs);
    const unsigned = {
      schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1,
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
    binding: WorkspaceFilesystemGrantBindingV1,
    operation: WorkspaceFilesystemOperationV1,
    ttlMs: number,
    protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1,
  ): Readonly<FilesystemObserveGrantV1 | FilesystemPrepareGrantV1> {
    const validated = validatedOperation(operation, purpose === 'observe' ? 'observe' : 'mutation');
    const validatedBindingValue = validatedBinding(binding);
    const boundary = validatedProtectedBoundaryV1(protectedBoundary);
    assertProtectedBoundaryBinding(validatedBindingValue, boundary);
    const timing = this.#timing(ttlMs);
    const unsigned = {
      schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1,
      purpose,
      grantId: requiredString(this.#idSource(), 'grantId', MAX_IDENTITY_CHARS),
      ...validatedBindingValue,
      operation: validated,
      operationDigest: workspaceFilesystemOperationDigestV1(validated),
      protectedBoundary: boundary,
      ...timing,
    };
    return frozenClone({ ...unsigned, seal: this.#seal(unsigned) }) as Readonly<
      FilesystemObserveGrantV1 | FilesystemPrepareGrantV1
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
    return `hmac-sha256:${createHmac('sha256', this.#integrityKey)
      .update(canonicalJson(unsigned))
      .digest('hex')}`;
  }

  #verify<
    Grant extends FilesystemObserveGrantV1 | FilesystemPrepareGrantV1 | FilesystemCommitGrantV1,
  >(value: Grant, expectedPurpose: Grant['purpose']): Readonly<Grant> {
    try {
      assertGrantShape(value, expectedPurpose);
      const { seal, ...unsigned } = value;
      const expected = this.#seal(unsigned);
      if (!safeEqual(seal, expected)) throw new Error('seal mismatch');
      const now = safeTimestamp(this.#now(), 'now');
      if (now >= value.expiresAtMs) {
        throw new WorkspaceFilesystemGrantErrorV1(
          'expired_grant',
          'Workspace filesystem grant expired before Provider I/O.',
        );
      }
      if (value.issuedAtMs > now || value.expiresAtMs - value.issuedAtMs > this.#maximumTtlMs) {
        throw new Error('invalid timing');
      }
      return frozenClone(value);
    } catch (error) {
      if (error instanceof WorkspaceFilesystemGrantErrorV1) throw error;
      throw new WorkspaceFilesystemGrantErrorV1(
        'invalid_grant',
        'Workspace filesystem grant failed structural or integrity validation.',
      );
    }
  }
}

function validatedPreparedMutation(value: unknown): {
  operationKind: WorkspaceFilesystemMutationOperationV1['kind'];
  operationDigest: string;
  target: WorkspaceFilesystemTargetIdentityV1;
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
  if (targetIdentityDigest !== workspaceFilesystemTargetIdentityDigestV1(target)) {
    throw new Error('prepared target digest mismatch');
  }
  const evidence = plainRecord(prepared.targetEvidence, 'target evidence');
  exactKeys(
    evidence,
    ['lexicalTargetDigest', 'canonicalTargetDigest', 'targetIdentityDigest'],
    'target evidence',
  );
  const expectedEvidence = workspaceFilesystemTargetEvidenceV1(target);
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
      preimageDigest !== workspaceFilesystemStringDigestV1(content) ||
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

function validatedPreimageArtifact(value: unknown): FilesystemPreimageArtifactRefV1 {
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
  if (!/^hmac-sha256:[a-f0-9]{64}$/u.test(integrityIdentifier)) {
    throw new Error('preimage Artifact integrity identifier');
  }
  return {
    artifactId,
    kind: 'filesystem_preimage',
    integrityIdentifier,
    byteLength: nonNegativeInteger(artifact.byteLength, 'Artifact byteLength'),
  };
}

function validatedProtectedBoundaryV1(value: unknown): WorkspaceFilesystemProtectedBoundaryV1 {
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
  } satisfies WorkspaceFilesystemProtectedBoundaryV1;
  const { boundaryDigest, ...unsigned } = result;
  if (boundaryDigest !== workspaceFilesystemProtectedBoundaryDigestV1(unsigned)) {
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

const validatedMutationReadyRecord = validateWorkspaceFilesystemMutationReadyRecordV1;

export function workspaceFilesystemOperationDigestV1(
  operation: WorkspaceFilesystemOperationV1,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(operation)).digest('hex')}`;
}

export function validateWorkspaceFilesystemOperationV1(
  operation: WorkspaceFilesystemOperationV1,
  family: 'observe' | 'mutation',
): Readonly<WorkspaceFilesystemOperationV1> {
  return frozenClone(validatedOperation(operation, family));
}

export function workspaceFilesystemProtectedBoundaryDigestV1(
  boundary: Omit<WorkspaceFilesystemProtectedBoundaryV1, 'boundaryDigest'>,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(boundary)).digest('hex')}`;
}

export function workspaceFilesystemTargetIdentityDigestV1(
  target: WorkspaceFilesystemTargetIdentityV1,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(target)).digest('hex')}`;
}

export function workspaceFilesystemStringDigestV1(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function workspaceFilesystemTargetEvidenceV1(
  target: WorkspaceFilesystemTargetIdentityV1,
): Readonly<WorkspaceFilesystemTargetEvidenceV1> {
  return deepFreeze({
    lexicalTargetDigest: workspaceFilesystemStringDigestV1(target.lexicalPath),
    canonicalTargetDigest: workspaceFilesystemStringDigestV1(target.canonicalPath),
    targetIdentityDigest: workspaceFilesystemTargetIdentityDigestV1(target),
  });
}

function assertGrantShape(
  value: unknown,
  expectedPurpose: 'observe' | 'prepare_mutation' | 'commit_mutation',
): asserts value is FilesystemObserveGrantV1 | FilesystemPrepareGrantV1 | FilesystemCommitGrantV1 {
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
  if (
    grant.schema !== WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1 ||
    grant.purpose !== expectedPurpose
  ) {
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
  if (grant.operationDigest !== workspaceFilesystemOperationDigestV1(operation)) {
    throw new Error('operation digest mismatch');
  }
  const protectedBoundary = validatedProtectedBoundaryV1(grant.protectedBoundary);
  if (
    protectedBoundary.boundaryDigest !== grant.searchBoundaryDigest ||
    protectedBoundary.canonicalWorkspace !== grant.canonicalWorkspace
  ) {
    throw new Error('protected boundary mismatch');
  }
  safeTimestamp(grant.issuedAtMs, 'issuedAtMs');
  safeTimestamp(grant.expiresAtMs, 'expiresAtMs');
  requiredString(grant.seal, 'seal', 256);
  if (expectedPurpose === 'commit_mutation') {
    const target = validatedTargetIdentity(grant.preparedTargetIdentity);
    if (grant.preparedTargetIdentityDigest !== workspaceFilesystemTargetIdentityDigestV1(target)) {
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
  binding: WorkspaceFilesystemGrantBindingV1,
  boundary: WorkspaceFilesystemProtectedBoundaryV1,
): void {
  if (
    binding.searchBoundaryDigest !== boundary.boundaryDigest ||
    binding.canonicalWorkspace !== boundary.canonicalWorkspace
  ) {
    throw new WorkspaceFilesystemGrantErrorV1(
      'invalid_grant',
      'Filesystem protected boundary does not match the admitted grant binding.',
    );
  }
}

function validatedBinding(
  value: WorkspaceFilesystemGrantBindingV1,
): WorkspaceFilesystemGrantBindingV1 {
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
): WorkspaceFilesystemOperationV1 {
  const operation = plainRecord(value, 'operation');
  const kind = operation.kind;
  const common = () => {
    const path = requiredString(operation.path, 'operation.path', MAX_PATH_CHARS, true);
    if (operation.pathScope !== 'workspace_only' && operation.pathScope !== 'approved_external') {
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

function validatedTargetIdentity(value: unknown): WorkspaceFilesystemTargetIdentityV1 {
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
  if (target.schema !== WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1) throw new Error('target schema');
  if (typeof target.exists !== 'boolean') throw new Error('target exists');
  const result: WorkspaceFilesystemTargetIdentityV1 = {
    schema: WORKSPACE_FILESYSTEM_PROVIDER_SCHEMA_V1,
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
): WorkspaceFilesystemTargetIdentityV1['nearestExistingNoFollow'] {
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
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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
