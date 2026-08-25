import type {
  WorkspaceFilesystemIntentRecord,
  WorkspaceFilesystemMutationReadyRecord,
} from '@kite-ai/runtime-contract';
import type {
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelinePreparedIdentityVerifier,
  WorkspaceFilesystemEditObservationPort,
  WorkspaceFilesystemEditObservationQueryResult,
  WorkspaceFilesystemMutationDurableEvidencePort,
  WorkspaceFilesystemMutationOperation,
  WorkspaceFilesystemMutationPipelineOperation,
  WorkspaceFilesystemOperation,
  WorkspaceFilesystemPersistedMutationIntent,
  WorkspaceFilesystemPersistedMutationReady,
  WorkspaceFilesystemPreparedMutation,
  WorkspaceFilesystemPreparedMutationEvidence,
  WorkspaceFilesystemProtectedBoundary,
  WorkspaceFilesystemProvider,
  WorkspaceFilesystemProviderFailure,
} from '@kite-ai/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ } from '@kite-ai/runtime-spi';
import { readBoundCapabilityArtifact } from '../capability-artifacts';
import { digestCapabilityBindingValue } from '../capability-binding';
import type { ProtectedPathEvaluator } from '../sandbox/protected-path';
import {
  validateWorkspaceFilesystemIntentRecord,
  validateWorkspaceFilesystemMutationReadyRecord,
  workspaceFilesystemIntentDigest,
  workspaceFilesystemMutationReadyDigest,
} from './evidence';
import {
  validateWorkspaceFilesystemOperation,
  workspaceFilesystemOperationDigest,
  workspaceFilesystemProtectedBoundaryDigest,
  workspaceFilesystemStringDigest,
  workspaceFilesystemTargetEvidence,
} from './grant-authority';
import { issueBuiltinWorkspaceFilesystemMutationObservation } from './observation-authority';
import type {
  BuiltinWorkspaceFilesystemInvocationDispatcher,
  BuiltinWorkspaceFilesystemPipelineResult,
  BuiltinWorkspaceFilesystemRuntime,
} from './runtime-composition';

const DEFAULT_GRANT_TTL_MS_ = 30_000;
const WRITE_EFFECTS_DIGEST_ = digestCapabilityBindingValue({
  filesystem: 'write',
  network: 'none',
  externalState: 'none',
});

export interface CreateBuiltinWorkspaceFilesystemMutationDispatcherInput {
  readonly prepared: Readonly<PreparedToolInvocation>;
  /** Exact verifier from the same frozen Builtin callback bundle. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier;
  readonly runtime: Readonly<BuiltinWorkspaceFilesystemRuntime>;
  readonly durableEvidence: WorkspaceFilesystemMutationDurableEvidencePort;
  /** App queries only same-actor, same-lexical latest read evidence. */
  readonly editObservation: WorkspaceFilesystemEditObservationPort;
  readonly protectedPathEvaluator: ProtectedPathEvaluator;
  readonly protectedPathRevision: string;
  readonly actorIdentity: Readonly<{ readonly threadId: string; readonly actorId: string }>;
  /** App-owned legacy rewind projection; never authorizes prepare, ready, or commit. */
  readonly rewindProjection?: Readonly<BuiltinWorkspaceFilesystemRewindProjection>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface BuiltinWorkspaceFilesystemRewindProjection {
  readonly recordPreimage: (path: string, content: string | null, existed: boolean) => void;
  readonly recordPostimage?: (path: string, content: string | null, existed: boolean) => void;
}

export type BuiltinWorkspaceFilesystemMutationDispatchErrorCode =
  | 'invalid_composition'
  | 'prepared_identity_invalid'
  | 'unsupported_operation'
  | 'operation_identity_mismatch'
  | 'protected_boundary_invalid'
  | 'intent_persistence_failed'
  | 'intent_verification_failed'
  | 'ready_persistence_failed'
  | 'ready_verification_failed'
  | 'edit_observation_failed';

export class BuiltinWorkspaceFilesystemMutationDispatchError extends Error {
  readonly code: BuiltinWorkspaceFilesystemMutationDispatchErrorCode;

  constructor(code: BuiltinWorkspaceFilesystemMutationDispatchErrorCode) {
    super(`Builtin Workspace filesystem mutation dispatcher rejected '${code}'.`);
    this.name = 'BuiltinWorkspaceFilesystemMutationDispatchError';
    this.code = code;
  }
}

/** A Provider commit crossed its atomic boundary but did not return certainty. */
export class BuiltinWorkspaceFilesystemMutationCommitUnknownError extends Error {
  readonly code = 'commit_unknown' as const;
  readonly causeValue: unknown;

  constructor(causeValue: unknown) {
    super('Builtin Workspace filesystem Provider did not return commit certainty.');
    this.name = 'BuiltinWorkspaceFilesystemMutationCommitUnknownError';
    this.causeValue = causeValue;
  }
}

/**
 * Builtin-only mutation mechanism. App persistence and edit evidence are
 * injected neutral ports; the full Provider prepared mutation never crosses
 * either port.
 */
export function createBuiltinWorkspaceFilesystemMutationDispatcher(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
): BuiltinWorkspaceFilesystemInvocationDispatcher {
  assertComposition(input);
  return Object.freeze({
    dispatch: (operation: WorkspaceFilesystemOperation) => dispatchMutation(input, operation),
  });
}

async function dispatchMutation(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
  operation: WorkspaceFilesystemOperation,
): Promise<BuiltinWorkspaceFilesystemPipelineResult> {
  assertPreparedIdentity(input.prepared, input.verifyPreparedIdentity);
  const validated = mutationOperationForPrepared(
    input.prepared,
    operation,
    input.protectedPathEvaluator,
  );
  const boundary = protectedBoundary(input);
  const intent = intentRecord(input, validated, boundary);
  const pipelineOperation = evidenceOperation(input.prepared, validated);
  const draft = deepFreeze({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    prepared: input.prepared,
    operation: pipelineOperation,
    record: intent,
  });

  let persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>;
  try {
    persisted = await input.durableEvidence.persistIntent(draft);
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('intent_persistence_failed');
  }
  if (!persistedIntentValid(input, persisted, pipelineOperation, intent)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('intent_verification_failed');
  }

  const binding = grantBinding(input, persisted, boundary);
  const prepareGrant = input.runtime.grants.issuePrepareGrant({
    binding,
    operation: validated,
    protectedBoundary: boundary,
    ttlMs: input.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS_,
  });
  const preparedResult = await input.runtime.provider.prepareMutation({
    grant: prepareGrant,
    signal: input.signal,
  });
  if (!preparedResult.ok) return Object.freeze({ ok: false, failure: preparedResult.failure });
  const preparedMutation = preparedResult.observation;
  assertPreparedMutation(preparedMutation, validated);
  const preparedEvidence = preparedMutationEvidence(preparedMutation);

  if (validated.kind === 'edit_file') {
    const priorFailure = await verifyPriorRead(input, validated, preparedEvidence);
    if (priorFailure) return Object.freeze({ ok: false, failure: priorFailure });
  }

  let preimageArtifact: ReturnType<BuiltinWorkspaceFilesystemRuntime['preimageArtifacts']['write']>;
  try {
    preimageArtifact = deepFreeze(
      input.runtime.preimageArtifacts.write({
        invocationId: input.prepared.identity.invocationId,
        operationDigest: preparedMutation.operationDigest,
        targetIdentityDigest: preparedMutation.targetIdentityDigest,
        preimage: preparedMutation.preimage,
      }),
    );
  } catch {
    return failure('operation_failed', 'Filesystem preimage Artifact could not be persisted.');
  }
  try {
    input.rewindProjection?.recordPreimage(
      validated.path,
      preparedMutation.preimage.content,
      preparedMutation.preimage.existed,
    );
  } catch {
    // Compatibility projection only; immutable Artifact + ready remain authoritative.
  }

  const ready = readyRecord(
    persisted.record,
    preparedMutation,
    preimageArtifact,
    input.now?.() ?? new Date(),
  );
  const readyDraft = deepFreeze({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    intent: persisted,
    preparedEvidence,
    // The Builtin validator canonicalizes the Artifact reference while
    // constructing the ready record. Carry that exact frozen reference into
    // the durable draft so Host can enforce process-local identity without
    // reinterpreting Artifact fields.
    preimageArtifact: ready.preimageArtifact,
    record: ready,
  });
  let persistedReady: Readonly<WorkspaceFilesystemPersistedMutationReady>;
  try {
    persistedReady = await input.durableEvidence.persistMutationReady(readyDraft);
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('ready_persistence_failed');
  }
  if (!persistedReadyValid(input, persistedReady, persisted, ready.preimageArtifact, ready)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('ready_verification_failed');
  }

  const readyAuthorization = input.runtime.grants.acknowledgeMutationReady({
    binding,
    operation: validated,
    protectedBoundary: boundary,
    prepared: preparedMutation,
    ready,
  });
  const commitGrant = input.runtime.grants.issueCommitGrant({
    authorization: readyAuthorization,
    ttlMs: input.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS_,
  });
  let committedResult: Awaited<ReturnType<WorkspaceFilesystemProvider['commitMutation']>>;
  try {
    committedResult = await input.runtime.provider.commitMutation({
      grant: commitGrant,
      signal: input.signal,
    });
  } catch (error) {
    throw new BuiltinWorkspaceFilesystemMutationCommitUnknownError(error);
  }
  if (!committedResult.ok) return Object.freeze({ ok: false, failure: committedResult.failure });

  const committed = committedResult.observation;
  try {
    input.rewindProjection?.recordPostimage?.(validated.path, committed.content, true);
  } catch {
    // Compatibility projection only; Provider evidence remains authoritative.
  }
  const filesystemObservation = Object.freeze({
    actorIdentityDigest: actorIdentityDigest(input),
    lexicalTargetDigest: committed.targetEvidence.lexicalTargetDigest,
    canonicalTargetDigest: committed.targetEvidence.canonicalTargetDigest,
    targetIdentityDigest: committed.targetEvidence.targetIdentityDigest,
    contentDigest: committed.afterContentDigest,
  });
  try {
    issueBuiltinWorkspaceFilesystemMutationObservation({
      prepared: input.prepared,
      persisted,
      mutationReady: ready,
      providerObservation: committed,
      observation: filesystemObservation,
    });
  } catch (error) {
    throw new BuiltinWorkspaceFilesystemMutationCommitUnknownError(error);
  }
  return Object.freeze({
    ok: true,
    observation: committed,
    filesystemObservation,
    preimage: preparedMutation.preimage,
  });
}

function assertComposition(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
): void {
  if (
    !input ||
    typeof input.verifyPreparedIdentity !== 'function' ||
    typeof input.durableEvidence?.persistIntent !== 'function' ||
    typeof input.durableEvidence?.verifyPersistedIntent !== 'function' ||
    typeof input.durableEvidence?.persistMutationReady !== 'function' ||
    typeof input.durableEvidence?.verifyPersistedMutationReady !== 'function' ||
    typeof input.editObservation?.findLatestAuthenticRead !== 'function' ||
    typeof input.editObservation?.verifyLatestAuthenticRead !== 'function' ||
    typeof input.runtime?.provider?.prepareMutation !== 'function' ||
    typeof input.runtime?.provider?.commitMutation !== 'function' ||
    typeof input.runtime?.grants?.issuePrepareGrant !== 'function' ||
    typeof input.runtime?.grants?.acknowledgeMutationReady !== 'function' ||
    typeof input.runtime?.grants?.issueCommitGrant !== 'function' ||
    typeof input.runtime?.preimageArtifacts?.write !== 'function' ||
    typeof input.protectedPathEvaluator?.evaluate !== 'function' ||
    typeof input.protectedPathEvaluator?.projectFilesystemBoundary !== 'function' ||
    !nonEmpty(input.protectedPathRevision) ||
    !nonEmpty(input.actorIdentity?.threadId) ||
    !nonEmpty(input.actorIdentity?.actorId) ||
    !sameWorkspace(input.runtime.canonicalWorkspace, input.protectedPathEvaluator.workspaceRoot)
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('invalid_composition');
  }
}

function assertPreparedIdentity(
  prepared: Readonly<PreparedToolInvocation>,
  verifier: ToolPipelinePreparedIdentityVerifier,
): void {
  let valid = false;
  try {
    const result = verifier(prepared);
    valid = result === true || (typeof result === 'object' && result.valid === true);
  } catch {
    valid = false;
  }
  const identity = prepared.identity;
  if (
    !valid ||
    identity.isDynamicMcp ||
    identity.executionFamily !== 'builtin' ||
    identity.executionMechanism !== 'filesystem' ||
    identity.visibility !== 'model' ||
    !identity.modelVisible ||
    identity.dynamicCatalogRevision !== null ||
    identity.admissionDigest === null ||
    identity.effectiveEffectsDigest !== WRITE_EFFECTS_DIGEST_ ||
    (identity.operationId !== 'builtin:write_file' && identity.operationId !== 'builtin:edit_file')
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('prepared_identity_invalid');
  }
}

function mutationOperationForPrepared(
  prepared: Readonly<PreparedToolInvocation>,
  operation: Readonly<WorkspaceFilesystemOperation>,
  evaluator: ProtectedPathEvaluator,
): Readonly<WorkspaceFilesystemMutationOperation> {
  if (!isMutationOperation(operation)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('unsupported_operation');
  }
  let validated: Readonly<WorkspaceFilesystemOperation>;
  try {
    validated = validateWorkspaceFilesystemOperation(operation, 'mutation');
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('operation_identity_mismatch');
  }
  if (!isMutationOperation(validated)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('unsupported_operation');
  }
  const identity = prepared.identity;
  if (
    identity.operationId !== `builtin:${validated.kind}` ||
    !argumentsMatchOperation(jsonRecord(prepared.input.arguments), validated)
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('operation_identity_mismatch');
  }
  const decision = evaluator.evaluate({ path: validated.path, operation: 'write' });
  if (decision.outcome === 'deny') {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('protected_boundary_invalid');
  }
  if (decision.relativePath === null) {
    if (
      validated.pathScope !== 'approved_external' ||
      identity.authorizationDigest === null ||
      identity.admissionDigest === null
    ) {
      throw new BuiltinWorkspaceFilesystemMutationDispatchError('protected_boundary_invalid');
    }
  } else if (validated.pathScope !== 'workspace_only') {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('protected_boundary_invalid');
  }
  return validated;
}

function protectedBoundary(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
): Readonly<WorkspaceFilesystemProtectedBoundary> {
  try {
    const projection = input.protectedPathEvaluator.projectFilesystemBoundary();
    if (
      !sameWorkspace(projection.canonicalWorkspace, input.runtime.canonicalWorkspace) ||
      !sameWorkspace(input.protectedPathEvaluator.workspaceRoot, input.runtime.canonicalWorkspace)
    ) {
      throw new Error('workspace mismatch');
    }
    const unsigned = deepFreeze({
      schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
      ...structuredClone(projection),
    });
    return deepFreeze({
      ...unsigned,
      boundaryDigest: workspaceFilesystemProtectedBoundaryDigest(unsigned),
    });
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('protected_boundary_invalid');
  }
}

function intentRecord(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
  operation: Readonly<WorkspaceFilesystemMutationOperation>,
  boundary: Readonly<WorkspaceFilesystemProtectedBoundary>,
): Readonly<WorkspaceFilesystemIntentRecord> {
  const identity = input.prepared.identity;
  const recordedAt = timestamp(input.now?.() ?? new Date());
  const unsigned = {
    attempt: attempt(identity.invocationId, identity.attemptId),
    capabilityRevision: identity.capabilityRevision,
    argumentsDigest: identity.argumentsDigest,
    admissionDigest: required(identity.admissionDigest),
    operationDigest: workspaceFilesystemOperationDigest(operation),
    searchBoundaryDigest: boundary.boundaryDigest,
    lexicalTargetDigest: workspaceFilesystemStringDigest(operation.path),
    canonicalWorkspaceDigest: workspaceFilesystemStringDigest(boundary.canonicalWorkspace),
    protectedPathRevision: input.protectedPathRevision,
    approvalSummaryDigest: workspaceFilesystemStringDigest(approvalSummary(input.prepared)),
    effectiveEffectsDigest: identity.effectiveEffectsDigest,
    recordedAt,
  } satisfies Omit<WorkspaceFilesystemIntentRecord, 'intentDigest'>;
  return validateWorkspaceFilesystemIntentRecord({
    ...unsigned,
    intentDigest: workspaceFilesystemIntentDigest(unsigned),
  });
}

function evidenceOperation(
  prepared: Readonly<PreparedToolInvocation>,
  operation: Readonly<WorkspaceFilesystemMutationOperation>,
): Readonly<WorkspaceFilesystemMutationPipelineOperation> {
  const operationId = prepared.identity.operationId;
  if (operationId === 'builtin:write_file' && operation.kind === 'write_file') {
    return Object.freeze({ ...operation, operationId: 'builtin:write_file' as const });
  }
  if (operationId === 'builtin:edit_file' && operation.kind === 'edit_file') {
    return Object.freeze({ ...operation, operationId: 'builtin:edit_file' as const });
  }
  throw new BuiltinWorkspaceFilesystemMutationDispatchError('operation_identity_mismatch');
}

function grantBinding(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
  boundary: Readonly<WorkspaceFilesystemProtectedBoundary>,
) {
  return Object.freeze({
    threadId: input.actorIdentity.threadId,
    turnId: persisted.acknowledgement.attempt.turnId,
    toolCallId: persisted.acknowledgement.attempt.toolCallId,
    invocationId: persisted.acknowledgement.attempt.invocationId,
    attempt: persisted.acknowledgement.attempt.attempt,
    intentDigest: persisted.record.intentDigest,
    searchBoundaryDigest: persisted.record.searchBoundaryDigest,
    capabilityRevision: persisted.acknowledgement.attempt.capabilityRevision,
    effectDigest: persisted.acknowledgement.attempt.effectiveEffectsDigest,
    canonicalWorkspace: boundary.canonicalWorkspace,
    protectedPathRevision: input.protectedPathRevision,
    approvalSummary: approvalSummary(input.prepared),
  });
}

function preparedMutationEvidence(
  prepared: Readonly<{
    operationKind: 'write_file' | 'edit_file';
    operationDigest: string;
    targetEvidence: Readonly<{
      lexicalTargetDigest: string;
      canonicalTargetDigest: string;
      targetIdentityDigest: string;
    }>;
    targetIdentityDigest: string;
    preimage: Readonly<{
      contentDigest: string | null;
      existed: boolean;
      byteLength: number;
    }>;
  }>,
): Readonly<WorkspaceFilesystemPreparedMutationEvidence> {
  return deepFreeze({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    operationKind: prepared.operationKind,
    operationDigest: prepared.operationDigest,
    lexicalTargetDigest: prepared.targetEvidence.lexicalTargetDigest,
    canonicalTargetDigest: prepared.targetEvidence.canonicalTargetDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimage.contentDigest,
    preimageExisted: prepared.preimage.existed,
    preimageByteLength: prepared.preimage.byteLength,
  });
}

function assertPreparedMutation(
  prepared: Readonly<WorkspaceFilesystemPreparedMutation>,
  operation: Readonly<WorkspaceFilesystemMutationOperation>,
): void {
  const expectedEvidence = workspaceFilesystemTargetEvidence(prepared.target);
  if (
    prepared.kind !== 'prepared_mutation' ||
    prepared.operationKind !== operation.kind ||
    prepared.operationDigest !== workspaceFilesystemOperationDigest(operation) ||
    prepared.target.lexicalPath !== operation.path ||
    prepared.targetIdentityDigest !== expectedEvidence.targetIdentityDigest ||
    prepared.targetEvidence.lexicalTargetDigest !== expectedEvidence.lexicalTargetDigest ||
    prepared.targetEvidence.canonicalTargetDigest !== expectedEvidence.canonicalTargetDigest ||
    prepared.targetEvidence.targetIdentityDigest !== expectedEvidence.targetIdentityDigest ||
    prepared.preimage.existed !== prepared.target.exists ||
    (prepared.preimage.existed &&
      (prepared.preimage.content === null ||
        prepared.preimage.contentDigest !==
          workspaceFilesystemStringDigest(prepared.preimage.content) ||
        prepared.preimage.byteLength !== Buffer.byteLength(prepared.preimage.content))) ||
    (!prepared.preimage.existed &&
      (prepared.preimage.content !== null ||
        prepared.preimage.contentDigest !== null ||
        prepared.preimage.byteLength !== 0))
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('operation_identity_mismatch');
  }
}

async function verifyPriorRead(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
  operation: Readonly<Extract<WorkspaceFilesystemMutationOperation, { kind: 'edit_file' }>>,
  prepared: Readonly<WorkspaceFilesystemPreparedMutationEvidence>,
): Promise<Readonly<WorkspaceFilesystemProviderFailure> | null> {
  const query = deepFreeze({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_,
    actorIdentityDigest: actorIdentityDigest(input),
    lexicalTargetDigest: prepared.lexicalTargetDigest,
  });
  let result: Readonly<WorkspaceFilesystemEditObservationQueryResult>;
  try {
    result = await input.editObservation.findLatestAuthenticRead(query);
  } catch {
    return failureValue('operation_failed', 'Latest read evidence is unavailable.');
  }
  let valid = false;
  try {
    valid = input.editObservation.verifyLatestAuthenticRead(result).valid;
  } catch {
    valid = false;
  }
  if (!valid || result.query !== query) {
    return failureValue('operation_failed', 'Latest read evidence authority rejected the query.');
  }
  if (result.status === 'missing') {
    return failureValue(
      'read_required',
      `File must be read before edit_file can commit: ${operation.path}.`,
    );
  }
  if (!input.runtime.capabilityArtifacts) {
    return failureValue('read_required', 'Committed read Artifact evidence is unavailable.');
  }
  try {
    const artifactResult = readBoundCapabilityArtifact(
      input.runtime.capabilityArtifacts,
      result.artifact,
      {
        invocationId: result.invocationId,
        resultDigest: result.resultDigest,
        evidenceDigest: result.evidenceDigest,
        filesystemObservation: result.observation,
      },
    );
    if (
      artifactResult.status !== 'success' ||
      !isRecord(artifactResult.structuredContent) ||
      artifactResult.structuredContent.path !== operation.path
    ) {
      return failureValue('read_required', 'Committed read Artifact is not a successful read.');
    }
  } catch {
    return failureValue('read_required', 'Committed read Artifact evidence is invalid.');
  }
  if (
    result.observation.actorIdentityDigest !== query.actorIdentityDigest ||
    result.observation.lexicalTargetDigest !== query.lexicalTargetDigest
  ) {
    return failureValue('operation_failed', 'Committed read actor or lexical identity mismatched.');
  }
  if (
    result.observation.canonicalTargetDigest !== prepared.canonicalTargetDigest ||
    result.observation.targetIdentityDigest !== prepared.targetIdentityDigest ||
    result.observation.contentDigest !== prepared.preimageDigest
  ) {
    return failureValue(
      'stale_read',
      `File has changed since the latest committed read: ${operation.path}.`,
    );
  }
  return null;
}

function readyRecord(
  intent: Readonly<WorkspaceFilesystemIntentRecord>,
  prepared: Readonly<{
    operationDigest: string;
    targetIdentityDigest: string;
    preimage: Readonly<{ contentDigest: string | null }>;
  }>,
  preimageArtifact: Readonly<
    ReturnType<BuiltinWorkspaceFilesystemRuntime['preimageArtifacts']['write']>
  >,
  now: Date,
): Readonly<WorkspaceFilesystemMutationReadyRecord> {
  const unsigned = {
    attempt: intent.attempt,
    intentDigest: intent.intentDigest,
    operationDigest: prepared.operationDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimage.contentDigest,
    preimageArtifact,
    readyAt: timestamp(now),
  } satisfies Omit<WorkspaceFilesystemMutationReadyRecord, 'readyDigest'>;
  return deepFreeze(
    validateWorkspaceFilesystemMutationReadyRecord({
      ...unsigned,
      readyDigest: workspaceFilesystemMutationReadyDigest(unsigned),
    }),
  );
}

function persistedIntentValid(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
  operation: Readonly<WorkspaceFilesystemMutationPipelineOperation>,
  record: Readonly<WorkspaceFilesystemIntentRecord>,
): boolean {
  try {
    if (!input.durableEvidence.verifyPersistedIntent(persisted).valid) return false;
    const acknowledged = persisted.acknowledgement.attempt;
    const identity = input.prepared.identity;
    return (
      persisted.schema === WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ &&
      persisted.status === 'durably_persisted' &&
      persisted.prepared === input.prepared &&
      persisted.operation === operation &&
      persisted.record === record &&
      workspaceFilesystemOperationDigest(providerOperation(operation)) === record.operationDigest &&
      workspaceFilesystemStringDigest(operation.path) === record.lexicalTargetDigest &&
      acknowledged.invocationId === identity.invocationId &&
      acknowledged.attemptId === identity.attemptId &&
      acknowledged.attempt === record.attempt &&
      acknowledged.toolCallId === identity.toolCallId &&
      acknowledged.turnId === identity.turnId &&
      acknowledged.modelMessageId === identity.modelMessageId &&
      acknowledged.operationId === identity.operationId &&
      acknowledged.capabilityId === identity.capabilityId &&
      acknowledged.capabilityRevision === identity.capabilityRevision &&
      acknowledged.descriptorRevision === identity.descriptorRevision &&
      acknowledged.parserRevision === identity.parserRevision &&
      acknowledged.executorRevision === identity.executorRevision &&
      acknowledged.argumentsDigest === identity.argumentsDigest &&
      acknowledged.schemaDigest === identity.schemaDigest &&
      acknowledged.effectiveEffectsDigest === identity.effectiveEffectsDigest &&
      acknowledged.builtinProjectionRevision === identity.builtinProjectionRevision &&
      acknowledged.dynamicCatalogRevision === null &&
      acknowledged.policyDigest === identity.policyDigest &&
      acknowledged.authorizationDigest === identity.authorizationDigest &&
      acknowledged.admissionDigest === identity.admissionDigest &&
      acknowledged.idempotencyKey === identity.idempotencyKey
    );
  } catch {
    return false;
  }
}

function persistedReadyValid(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationReady>,
  intent: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
  artifact: Readonly<ReturnType<BuiltinWorkspaceFilesystemRuntime['preimageArtifacts']['write']>>,
  record: Readonly<WorkspaceFilesystemMutationReadyRecord>,
): boolean {
  try {
    return (
      input.durableEvidence.verifyPersistedMutationReady(persisted).valid &&
      persisted.schema === WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ &&
      persisted.status === 'durably_persisted' &&
      persisted.intent === intent &&
      persisted.preimageArtifact === artifact &&
      persisted.record === record
    );
  } catch {
    return false;
  }
}

function providerOperation(
  operation: Readonly<WorkspaceFilesystemMutationPipelineOperation>,
): Readonly<WorkspaceFilesystemMutationOperation> {
  const { operationId: _operationId, ...providerOperation } = operation;
  return providerOperation;
}

function argumentsMatchOperation(
  args: Readonly<Record<string, RuntimeJsonValue>>,
  operation: Readonly<WorkspaceFilesystemMutationOperation>,
): boolean {
  if (operation.kind === 'write_file') {
    return operation.path === args.path && operation.content === args.content;
  }
  return (
    operation.path === args.path &&
    operation.oldString === args.old_string &&
    operation.newString === args.new_string &&
    operation.replaceAll === args.replace_all
  );
}

function approvalSummary(prepared: Readonly<PreparedToolInvocation>): string {
  const facts = jsonRecord(prepared.input.facts);
  const summary = facts.approvalSummary;
  if (typeof summary !== 'string' || summary.length > 1024) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('prepared_identity_invalid');
  }
  return summary;
}

function actorIdentityDigest(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInput>,
): string {
  return digestCapabilityBindingValue({
    schema: 'kite.workspace-filesystem-actor.v1',
    threadId: input.actorIdentity.threadId,
    actorIdentity: input.actorIdentity.actorId,
  });
}

function failure(
  code: WorkspaceFilesystemProviderFailure['code'],
  message: string,
): BuiltinWorkspaceFilesystemPipelineResult {
  return Object.freeze({ ok: false, failure: failureValue(code, message) });
}

function failureValue(
  code: WorkspaceFilesystemProviderFailure['code'],
  message: string,
): Readonly<WorkspaceFilesystemProviderFailure> {
  return Object.freeze({ code, message });
}

function attempt(invocationId: string, attemptId: string): number {
  const prefix = `${invocationId}:attempt:`;
  const suffix = attemptId.startsWith(prefix) ? attemptId.slice(prefix.length) : '';
  const attempt = Number(suffix);
  if (!/^[1-9]\d*$/u.test(suffix) || !Number.isSafeInteger(attempt)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('prepared_identity_invalid');
  }
  return attempt;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('invalid_composition');
  }
  return value.toISOString();
}

function jsonRecord(
  value: RuntimeJsonValue | undefined,
): Readonly<Record<string, RuntimeJsonValue>> {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('prepared_identity_invalid');
  }
  return value as Readonly<Record<string, RuntimeJsonValue>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, RuntimeJsonValue>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isMutationOperation(
  operation: Readonly<WorkspaceFilesystemOperation>,
): operation is Readonly<WorkspaceFilesystemMutationOperation> {
  return operation.kind === 'write_file' || operation.kind === 'edit_file';
}

function sameWorkspace(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function required(value: string | null): string {
  if (!nonEmpty(value)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchError('prepared_identity_invalid');
  }
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
