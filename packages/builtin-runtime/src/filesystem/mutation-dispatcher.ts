import type {
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelinePreparedIdentityVerifierV1,
  WorkspaceFilesystemEditObservationPortV1,
  WorkspaceFilesystemEditObservationQueryResultV1,
  WorkspaceFilesystemIntentRecordV1,
  WorkspaceFilesystemMutationDurableEvidencePortV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemMutationPipelineOperationV1,
  WorkspaceFilesystemMutationReadyRecordV1,
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemPersistedMutationIntentV1,
  WorkspaceFilesystemPersistedMutationReadyV1,
  WorkspaceFilesystemPreparedMutationEvidenceV1,
  WorkspaceFilesystemPreparedMutationV1,
  WorkspaceFilesystemProtectedBoundaryV1,
  WorkspaceFilesystemProviderFailureV1,
  WorkspaceFilesystemProviderV1,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 } from '@kite/runtime-spi';
import { readBoundCapabilityArtifactV1 } from '../capability-artifacts';
import { digestCapabilityBindingValueV1 } from '../capability-binding';
import type { ProtectedPathEvaluatorV1 } from '../sandbox/protected-path';
import {
  validateWorkspaceFilesystemIntentRecordV1,
  validateWorkspaceFilesystemMutationReadyRecordV1,
  workspaceFilesystemIntentDigestV1,
  workspaceFilesystemMutationReadyDigestV1,
} from './evidence';
import {
  validateWorkspaceFilesystemOperationV1,
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
  workspaceFilesystemStringDigestV1,
  workspaceFilesystemTargetEvidenceV1,
} from './grant-authority';
import { issueBuiltinWorkspaceFilesystemMutationObservationV1 } from './observation-authority';
import type {
  BuiltinWorkspaceFilesystemInvocationDispatcherV1,
  BuiltinWorkspaceFilesystemPipelineResultV1,
  BuiltinWorkspaceFilesystemRuntimeV1,
} from './runtime-composition';

const DEFAULT_GRANT_TTL_MS_V1 = 30_000;
const WRITE_EFFECTS_DIGEST_V1 = digestCapabilityBindingValueV1({
  filesystem: 'write',
  network: 'none',
  externalState: 'none',
});

export interface CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1 {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  /** Exact verifier from the same frozen Builtin callback bundle. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1;
  readonly runtime: Readonly<BuiltinWorkspaceFilesystemRuntimeV1>;
  readonly durableEvidence: WorkspaceFilesystemMutationDurableEvidencePortV1;
  /** App queries only same-actor, same-lexical latest read evidence. */
  readonly editObservation: WorkspaceFilesystemEditObservationPortV1;
  readonly protectedPathEvaluator: ProtectedPathEvaluatorV1;
  readonly protectedPathRevision: string;
  readonly actorIdentity: Readonly<{ readonly threadId: string; readonly actorId: string }>;
  /** App-owned legacy rewind projection; never authorizes prepare, ready, or commit. */
  readonly checkpointProjection?: Readonly<BuiltinWorkspaceFilesystemCheckpointProjectionV1>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface BuiltinWorkspaceFilesystemCheckpointProjectionV1 {
  readonly recordPreimage: (path: string, content: string | null, existed: boolean) => void;
  readonly recordPostimage?: (path: string, content: string | null, existed: boolean) => void;
}

export type BuiltinWorkspaceFilesystemMutationDispatchErrorCodeV1 =
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

export class BuiltinWorkspaceFilesystemMutationDispatchErrorV1 extends Error {
  readonly code: BuiltinWorkspaceFilesystemMutationDispatchErrorCodeV1;

  constructor(code: BuiltinWorkspaceFilesystemMutationDispatchErrorCodeV1) {
    super(`Builtin Workspace filesystem mutation dispatcher rejected '${code}'.`);
    this.name = 'BuiltinWorkspaceFilesystemMutationDispatchErrorV1';
    this.code = code;
  }
}

/** A Provider commit crossed its atomic boundary but did not return certainty. */
export class BuiltinWorkspaceFilesystemMutationCommitUnknownErrorV1 extends Error {
  readonly code = 'commit_unknown' as const;
  readonly causeValue: unknown;

  constructor(causeValue: unknown) {
    super('Builtin Workspace filesystem Provider did not return commit certainty.');
    this.name = 'BuiltinWorkspaceFilesystemMutationCommitUnknownErrorV1';
    this.causeValue = causeValue;
  }
}

/**
 * Builtin-only mutation mechanism. App persistence and edit evidence are
 * injected neutral ports; the full Provider prepared mutation never crosses
 * either port.
 */
export function createBuiltinWorkspaceFilesystemMutationDispatcherV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
): BuiltinWorkspaceFilesystemInvocationDispatcherV1 {
  assertCompositionV1(input);
  return Object.freeze({
    dispatch: (operation: WorkspaceFilesystemOperationV1) => dispatchMutationV1(input, operation),
  });
}

async function dispatchMutationV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
  operation: WorkspaceFilesystemOperationV1,
): Promise<BuiltinWorkspaceFilesystemPipelineResultV1> {
  assertPreparedIdentityV1(input.prepared, input.verifyPreparedIdentity);
  const validated = mutationOperationForPreparedV1(
    input.prepared,
    operation,
    input.protectedPathEvaluator,
  );
  const protectedBoundary = protectedBoundaryV1(input);
  const intent = intentRecordV1(input, validated, protectedBoundary);
  const evidenceOperation = evidenceOperationV1(input.prepared, validated);
  const draft = deepFreezeV1({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
    prepared: input.prepared,
    operation: evidenceOperation,
    record: intent,
  });

  let persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>;
  try {
    persisted = await input.durableEvidence.persistIntent(draft);
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('intent_persistence_failed');
  }
  if (!persistedIntentValidV1(input, persisted, evidenceOperation, intent)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('intent_verification_failed');
  }

  const binding = grantBindingV1(input, persisted, protectedBoundary);
  const prepareGrant = input.runtime.grants.issuePrepareGrant({
    binding,
    operation: validated,
    protectedBoundary,
    ttlMs: input.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS_V1,
  });
  const preparedResult = await input.runtime.provider.prepareMutation({
    grant: prepareGrant,
    signal: input.signal,
  });
  if (!preparedResult.ok) return Object.freeze({ ok: false, failure: preparedResult.failure });
  const preparedMutation = preparedResult.observation;
  assertPreparedMutationV1(preparedMutation, validated);
  const preparedEvidence = preparedMutationEvidenceV1(preparedMutation);

  if (validated.kind === 'edit_file') {
    const priorFailure = await verifyPriorReadV1(input, validated, preparedEvidence);
    if (priorFailure) return Object.freeze({ ok: false, failure: priorFailure });
  }

  let preimageArtifact: ReturnType<
    BuiltinWorkspaceFilesystemRuntimeV1['preimageArtifacts']['write']
  >;
  try {
    preimageArtifact = deepFreezeV1(
      input.runtime.preimageArtifacts.write({
        invocationId: input.prepared.identity.invocationId,
        operationDigest: preparedMutation.operationDigest,
        targetIdentityDigest: preparedMutation.targetIdentityDigest,
        preimage: preparedMutation.preimage,
      }),
    );
  } catch {
    return failureV1('operation_failed', 'Filesystem preimage Artifact could not be persisted.');
  }
  try {
    input.checkpointProjection?.recordPreimage(
      validated.path,
      preparedMutation.preimage.content,
      preparedMutation.preimage.existed,
    );
  } catch {
    // Compatibility projection only; immutable Artifact + ready remain authoritative.
  }

  const ready = readyRecordV1(
    persisted.record,
    preparedMutation,
    preimageArtifact,
    input.now?.() ?? new Date(),
  );
  const readyDraft = deepFreezeV1({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
    intent: persisted,
    preparedEvidence,
    // The Builtin validator canonicalizes the Artifact reference while
    // constructing the ready record. Carry that exact frozen reference into
    // the durable draft so Host can enforce process-local identity without
    // reinterpreting Artifact fields.
    preimageArtifact: ready.preimageArtifact,
    record: ready,
  });
  let persistedReady: Readonly<WorkspaceFilesystemPersistedMutationReadyV1>;
  try {
    persistedReady = await input.durableEvidence.persistMutationReady(readyDraft);
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('ready_persistence_failed');
  }
  if (!persistedReadyValidV1(input, persistedReady, persisted, ready.preimageArtifact, ready)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('ready_verification_failed');
  }

  const readyAuthorization = input.runtime.grants.acknowledgeMutationReady({
    binding,
    operation: validated,
    protectedBoundary,
    prepared: preparedMutation,
    ready,
  });
  const commitGrant = input.runtime.grants.issueCommitGrant({
    authorization: readyAuthorization,
    ttlMs: input.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS_V1,
  });
  let committedResult: Awaited<ReturnType<WorkspaceFilesystemProviderV1['commitMutation']>>;
  try {
    committedResult = await input.runtime.provider.commitMutation({
      grant: commitGrant,
      signal: input.signal,
    });
  } catch (error) {
    throw new BuiltinWorkspaceFilesystemMutationCommitUnknownErrorV1(error);
  }
  if (!committedResult.ok) return Object.freeze({ ok: false, failure: committedResult.failure });

  const committed = committedResult.observation;
  try {
    input.checkpointProjection?.recordPostimage?.(validated.path, committed.content, true);
  } catch {
    // Compatibility projection only; Provider evidence remains authoritative.
  }
  const filesystemObservation = Object.freeze({
    actorIdentityDigest: actorIdentityDigestV1(input),
    lexicalTargetDigest: committed.targetEvidence.lexicalTargetDigest,
    canonicalTargetDigest: committed.targetEvidence.canonicalTargetDigest,
    targetIdentityDigest: committed.targetEvidence.targetIdentityDigest,
    contentDigest: committed.afterContentDigest,
  });
  try {
    issueBuiltinWorkspaceFilesystemMutationObservationV1({
      prepared: input.prepared,
      persisted,
      mutationReady: ready,
      providerObservation: committed,
      observation: filesystemObservation,
    });
  } catch (error) {
    throw new BuiltinWorkspaceFilesystemMutationCommitUnknownErrorV1(error);
  }
  return Object.freeze({
    ok: true,
    observation: committed,
    filesystemObservation,
    preimage: preparedMutation.preimage,
  });
}

function assertCompositionV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
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
    !nonEmptyV1(input.protectedPathRevision) ||
    !nonEmptyV1(input.actorIdentity?.threadId) ||
    !nonEmptyV1(input.actorIdentity?.actorId) ||
    !sameWorkspaceV1(input.runtime.canonicalWorkspace, input.protectedPathEvaluator.workspaceRoot)
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('invalid_composition');
  }
}

function assertPreparedIdentityV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  verifier: ToolPipelinePreparedIdentityVerifierV1,
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
    identity.effectiveEffectsDigest !== WRITE_EFFECTS_DIGEST_V1 ||
    (identity.operationId !== 'builtin:write_file' && identity.operationId !== 'builtin:edit_file')
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('prepared_identity_invalid');
  }
}

function mutationOperationForPreparedV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  operation: Readonly<WorkspaceFilesystemOperationV1>,
  evaluator: ProtectedPathEvaluatorV1,
): Readonly<WorkspaceFilesystemMutationOperationV1> {
  if (!isMutationOperationV1(operation)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('unsupported_operation');
  }
  let validated: Readonly<WorkspaceFilesystemOperationV1>;
  try {
    validated = validateWorkspaceFilesystemOperationV1(operation, 'mutation');
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('operation_identity_mismatch');
  }
  if (!isMutationOperationV1(validated)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('unsupported_operation');
  }
  const identity = prepared.identity;
  if (
    identity.operationId !== `builtin:${validated.kind}` ||
    !argumentsMatchOperationV1(jsonRecordV1(prepared.input.arguments), validated)
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('operation_identity_mismatch');
  }
  const decision = evaluator.evaluate({ path: validated.path, operation: 'write' });
  if (decision.outcome === 'deny') {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('protected_boundary_invalid');
  }
  if (decision.relativePath === null) {
    if (
      validated.pathScope !== 'approved_external' ||
      identity.authorizationDigest === null ||
      identity.admissionDigest === null
    ) {
      throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('protected_boundary_invalid');
    }
  } else if (validated.pathScope !== 'workspace_only') {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('protected_boundary_invalid');
  }
  return validated;
}

function protectedBoundaryV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
): Readonly<WorkspaceFilesystemProtectedBoundaryV1> {
  try {
    const projection = input.protectedPathEvaluator.projectFilesystemBoundary();
    if (
      !sameWorkspaceV1(projection.canonicalWorkspace, input.runtime.canonicalWorkspace) ||
      !sameWorkspaceV1(input.protectedPathEvaluator.workspaceRoot, input.runtime.canonicalWorkspace)
    ) {
      throw new Error('workspace mismatch');
    }
    const unsigned = deepFreezeV1({
      schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
      ...structuredClone(projection),
    });
    return deepFreezeV1({
      ...unsigned,
      boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsigned),
    });
  } catch {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('protected_boundary_invalid');
  }
}

function intentRecordV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
  operation: Readonly<WorkspaceFilesystemMutationOperationV1>,
  boundary: Readonly<WorkspaceFilesystemProtectedBoundaryV1>,
): Readonly<WorkspaceFilesystemIntentRecordV1> {
  const identity = input.prepared.identity;
  const recordedAt = timestampV1(input.now?.() ?? new Date());
  const unsigned = {
    attempt: attemptV1(identity.invocationId, identity.attemptId),
    capabilityRevision: identity.capabilityRevision,
    argumentsDigest: identity.argumentsDigest,
    admissionDigest: requiredV1(identity.admissionDigest),
    operationDigest: workspaceFilesystemOperationDigestV1(operation),
    searchBoundaryDigest: boundary.boundaryDigest,
    lexicalTargetDigest: workspaceFilesystemStringDigestV1(operation.path),
    canonicalWorkspaceDigest: workspaceFilesystemStringDigestV1(boundary.canonicalWorkspace),
    protectedPathRevision: input.protectedPathRevision,
    approvalSummaryDigest: workspaceFilesystemStringDigestV1(approvalSummaryV1(input.prepared)),
    effectiveEffectsDigest: identity.effectiveEffectsDigest,
    recordedAt,
  } satisfies Omit<WorkspaceFilesystemIntentRecordV1, 'intentDigest'>;
  return validateWorkspaceFilesystemIntentRecordV1({
    ...unsigned,
    intentDigest: workspaceFilesystemIntentDigestV1(unsigned),
  });
}

function evidenceOperationV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  operation: Readonly<WorkspaceFilesystemMutationOperationV1>,
): Readonly<WorkspaceFilesystemMutationPipelineOperationV1> {
  const operationId = prepared.identity.operationId;
  if (operationId === 'builtin:write_file' && operation.kind === 'write_file') {
    return Object.freeze({ ...operation, operationId: 'builtin:write_file' as const });
  }
  if (operationId === 'builtin:edit_file' && operation.kind === 'edit_file') {
    return Object.freeze({ ...operation, operationId: 'builtin:edit_file' as const });
  }
  throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('operation_identity_mismatch');
}

function grantBindingV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
  boundary: Readonly<WorkspaceFilesystemProtectedBoundaryV1>,
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
    approvalSummary: approvalSummaryV1(input.prepared),
  });
}

function preparedMutationEvidenceV1(
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
): Readonly<WorkspaceFilesystemPreparedMutationEvidenceV1> {
  return deepFreezeV1({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
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

function assertPreparedMutationV1(
  prepared: Readonly<WorkspaceFilesystemPreparedMutationV1>,
  operation: Readonly<WorkspaceFilesystemMutationOperationV1>,
): void {
  const expectedEvidence = workspaceFilesystemTargetEvidenceV1(prepared.target);
  if (
    prepared.kind !== 'prepared_mutation' ||
    prepared.operationKind !== operation.kind ||
    prepared.operationDigest !== workspaceFilesystemOperationDigestV1(operation) ||
    prepared.target.lexicalPath !== operation.path ||
    prepared.targetIdentityDigest !== expectedEvidence.targetIdentityDigest ||
    prepared.targetEvidence.lexicalTargetDigest !== expectedEvidence.lexicalTargetDigest ||
    prepared.targetEvidence.canonicalTargetDigest !== expectedEvidence.canonicalTargetDigest ||
    prepared.targetEvidence.targetIdentityDigest !== expectedEvidence.targetIdentityDigest ||
    prepared.preimage.existed !== prepared.target.exists ||
    (prepared.preimage.existed &&
      (prepared.preimage.content === null ||
        prepared.preimage.contentDigest !==
          workspaceFilesystemStringDigestV1(prepared.preimage.content) ||
        prepared.preimage.byteLength !== Buffer.byteLength(prepared.preimage.content))) ||
    (!prepared.preimage.existed &&
      (prepared.preimage.content !== null ||
        prepared.preimage.contentDigest !== null ||
        prepared.preimage.byteLength !== 0))
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('operation_identity_mismatch');
  }
}

async function verifyPriorReadV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
  operation: Readonly<Extract<WorkspaceFilesystemMutationOperationV1, { kind: 'edit_file' }>>,
  prepared: Readonly<WorkspaceFilesystemPreparedMutationEvidenceV1>,
): Promise<Readonly<WorkspaceFilesystemProviderFailureV1> | null> {
  const query = deepFreezeV1({
    schema: WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1,
    actorIdentityDigest: actorIdentityDigestV1(input),
    lexicalTargetDigest: prepared.lexicalTargetDigest,
  });
  let result: Readonly<WorkspaceFilesystemEditObservationQueryResultV1>;
  try {
    result = await input.editObservation.findLatestAuthenticRead(query);
  } catch {
    return failureValueV1('operation_failed', 'Latest read evidence is unavailable.');
  }
  let valid = false;
  try {
    valid = input.editObservation.verifyLatestAuthenticRead(result).valid;
  } catch {
    valid = false;
  }
  if (!valid || result.query !== query) {
    return failureValueV1('operation_failed', 'Latest read evidence authority rejected the query.');
  }
  if (result.status === 'missing') {
    return failureValueV1(
      'read_required',
      `File must be read before edit_file can commit: ${operation.path}.`,
    );
  }
  if (!input.runtime.capabilityArtifacts) {
    return failureValueV1('read_required', 'Committed read Artifact evidence is unavailable.');
  }
  try {
    const artifactResult = readBoundCapabilityArtifactV1(
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
      !isRecordV1(artifactResult.structuredContent) ||
      artifactResult.structuredContent.path !== operation.path
    ) {
      return failureValueV1('read_required', 'Committed read Artifact is not a successful read.');
    }
  } catch {
    return failureValueV1('read_required', 'Committed read Artifact evidence is invalid.');
  }
  if (
    result.observation.actorIdentityDigest !== query.actorIdentityDigest ||
    result.observation.lexicalTargetDigest !== query.lexicalTargetDigest
  ) {
    return failureValueV1(
      'operation_failed',
      'Committed read actor or lexical identity mismatched.',
    );
  }
  if (
    result.observation.canonicalTargetDigest !== prepared.canonicalTargetDigest ||
    result.observation.targetIdentityDigest !== prepared.targetIdentityDigest ||
    result.observation.contentDigest !== prepared.preimageDigest
  ) {
    return failureValueV1(
      'stale_read',
      `File has changed since the latest committed read: ${operation.path}.`,
    );
  }
  return null;
}

function readyRecordV1(
  intent: Readonly<WorkspaceFilesystemIntentRecordV1>,
  prepared: Readonly<{
    operationDigest: string;
    targetIdentityDigest: string;
    preimage: Readonly<{ contentDigest: string | null }>;
  }>,
  preimageArtifact: Readonly<
    ReturnType<BuiltinWorkspaceFilesystemRuntimeV1['preimageArtifacts']['write']>
  >,
  now: Date,
): Readonly<WorkspaceFilesystemMutationReadyRecordV1> {
  const unsigned = {
    attempt: intent.attempt,
    intentDigest: intent.intentDigest,
    operationDigest: prepared.operationDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimage.contentDigest,
    preimageArtifact,
    readyAt: timestampV1(now),
  } satisfies Omit<WorkspaceFilesystemMutationReadyRecordV1, 'readyDigest'>;
  return deepFreezeV1(
    validateWorkspaceFilesystemMutationReadyRecordV1({
      ...unsigned,
      readyDigest: workspaceFilesystemMutationReadyDigestV1(unsigned),
    }),
  );
}

function persistedIntentValidV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
  operation: Readonly<WorkspaceFilesystemMutationPipelineOperationV1>,
  record: Readonly<WorkspaceFilesystemIntentRecordV1>,
): boolean {
  try {
    if (!input.durableEvidence.verifyPersistedIntent(persisted).valid) return false;
    const acknowledged = persisted.acknowledgement.attempt;
    const identity = input.prepared.identity;
    return (
      persisted.schema === WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 &&
      persisted.status === 'durably_persisted' &&
      persisted.prepared === input.prepared &&
      persisted.operation === operation &&
      persisted.record === record &&
      workspaceFilesystemOperationDigestV1(providerOperationV1(operation)) ===
        record.operationDigest &&
      workspaceFilesystemStringDigestV1(operation.path) === record.lexicalTargetDigest &&
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

function persistedReadyValidV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationReadyV1>,
  intent: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
  artifact: Readonly<ReturnType<BuiltinWorkspaceFilesystemRuntimeV1['preimageArtifacts']['write']>>,
  record: Readonly<WorkspaceFilesystemMutationReadyRecordV1>,
): boolean {
  try {
    return (
      input.durableEvidence.verifyPersistedMutationReady(persisted).valid &&
      persisted.schema === WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 &&
      persisted.status === 'durably_persisted' &&
      persisted.intent === intent &&
      persisted.preimageArtifact === artifact &&
      persisted.record === record
    );
  } catch {
    return false;
  }
}

function providerOperationV1(
  operation: Readonly<WorkspaceFilesystemMutationPipelineOperationV1>,
): Readonly<WorkspaceFilesystemMutationOperationV1> {
  const { operationId: _operationId, ...providerOperation } = operation;
  return providerOperation;
}

function argumentsMatchOperationV1(
  args: Readonly<Record<string, RuntimeJsonValueV1>>,
  operation: Readonly<WorkspaceFilesystemMutationOperationV1>,
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

function approvalSummaryV1(prepared: Readonly<PreparedToolInvocationV1>): string {
  const facts = jsonRecordV1(prepared.input.facts);
  const summary = facts.approvalSummary;
  if (typeof summary !== 'string' || summary.length > 1024) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('prepared_identity_invalid');
  }
  return summary;
}

function actorIdentityDigestV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemMutationDispatcherInputV1>,
): string {
  return digestCapabilityBindingValueV1({
    schema: 'kite.workspace-filesystem-actor.v1',
    threadId: input.actorIdentity.threadId,
    actorIdentity: input.actorIdentity.actorId,
  });
}

function failureV1(
  code: WorkspaceFilesystemProviderFailureV1['code'],
  message: string,
): BuiltinWorkspaceFilesystemPipelineResultV1 {
  return Object.freeze({ ok: false, failure: failureValueV1(code, message) });
}

function failureValueV1(
  code: WorkspaceFilesystemProviderFailureV1['code'],
  message: string,
): Readonly<WorkspaceFilesystemProviderFailureV1> {
  return Object.freeze({ code, message });
}

function attemptV1(invocationId: string, attemptId: string): number {
  const prefix = `${invocationId}:attempt:`;
  const suffix = attemptId.startsWith(prefix) ? attemptId.slice(prefix.length) : '';
  const attempt = Number(suffix);
  if (!/^[1-9]\d*$/u.test(suffix) || !Number.isSafeInteger(attempt)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('prepared_identity_invalid');
  }
  return attempt;
}

function timestampV1(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('invalid_composition');
  }
  return value.toISOString();
}

function jsonRecordV1(
  value: RuntimeJsonValueV1 | undefined,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('prepared_identity_invalid');
  }
  return value as Readonly<Record<string, RuntimeJsonValueV1>>;
}

function isRecordV1(value: unknown): value is Readonly<Record<string, RuntimeJsonValueV1>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isMutationOperationV1(
  operation: Readonly<WorkspaceFilesystemOperationV1>,
): operation is Readonly<WorkspaceFilesystemMutationOperationV1> {
  return operation.kind === 'write_file' || operation.kind === 'edit_file';
}

function sameWorkspaceV1(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function requiredV1(value: string | null): string {
  if (!nonEmptyV1(value)) {
    throw new BuiltinWorkspaceFilesystemMutationDispatchErrorV1('prepared_identity_invalid');
  }
  return value;
}

function nonEmptyV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function deepFreezeV1<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeV1(nested);
  }
  return value;
}
