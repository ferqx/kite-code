import type {
  WorkspaceFilesystemMutationReadyRecord,
  WorkspaceFilesystemObservationRecord,
} from '@kite/runtime-contract';
import type {
  CapabilityToolTerminalResult,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineReceiptCommit,
  WorkspaceFilesystemCommittedMutation,
  WorkspaceFilesystemPersistedIntent,
  WorkspaceFilesystemPersistedMutationIntent,
  WorkspaceReadFileObservation,
} from '@kite/runtime-spi';
import type { BuiltinOperationExecutionValue } from '../model/runtime-module';
import { validateWorkspaceFilesystemMutationReadyRecord } from './evidence';
import {
  workspaceFilesystemOperationDigest,
  workspaceFilesystemStringDigest,
  workspaceFilesystemTargetEvidence,
} from './grant-authority';

export type BuiltinWorkspaceFilesystemObservationAuthorityErrorCode =
  | 'observation_missing'
  | 'observation_not_issued'
  | 'prepared_identity_mismatch'
  | 'persisted_intent_mismatch'
  | 'provider_evidence_mismatch'
  | 'terminal_clone_mismatch';

export class BuiltinWorkspaceFilesystemObservationAuthorityError extends Error {
  readonly code: BuiltinWorkspaceFilesystemObservationAuthorityErrorCode;

  constructor(code: BuiltinWorkspaceFilesystemObservationAuthorityErrorCode) {
    super(`Builtin Workspace filesystem observation authority rejected '${code}'.`);
    this.name = 'BuiltinWorkspaceFilesystemObservationAuthorityError';
    this.code = code;
  }
}

export type BuiltinWorkspaceFilesystemTerminalVerificationResult =
  | {
      readonly valid: true;
      readonly observation: Readonly<WorkspaceFilesystemObservationRecord>;
    }
  | {
      readonly valid: false;
      readonly code:
        | 'terminal_not_issued'
        | 'acknowledgement_mismatch'
        | 'terminal_identity_mismatch';
    };

/** App may call this exact SPI-only seam before committing a State receipt. */
export type BuiltinWorkspaceFilesystemTerminalVerifier = (
  input: Readonly<ToolPipelineReceiptCommit>,
) => Readonly<BuiltinWorkspaceFilesystemTerminalVerificationResult>;

interface IssuedObservation {
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly observation: Readonly<WorkspaceFilesystemObservationRecord>;
  readonly operationId: 'builtin:read_file' | 'builtin:write_file' | 'builtin:edit_file';
  readonly operationPath: string;
}

interface CloneAuthorization {
  readonly schema: 'kite.builtin-workspace-filesystem-clone-authorization.v1';
}

interface BoundTerminal extends IssuedObservation {
  readonly terminal: Readonly<CapabilityToolTerminalResult>;
  readonly clonedObservation: Readonly<WorkspaceFilesystemObservationRecord>;
}

const issuedObservations = new WeakMap<object, IssuedObservation>();
const cloneAuthorizations = new WeakMap<object, IssuedObservation>();
const boundTerminals = new WeakMap<object, BoundTerminal>();

/** Package-internal issuer called only after durable intent and Provider evidence checks. */
export function issueBuiltinWorkspaceFilesystemReadObservation(input: {
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly persisted: Readonly<WorkspaceFilesystemPersistedIntent>;
  readonly providerObservation: Readonly<WorkspaceReadFileObservation>;
  readonly observation: Readonly<WorkspaceFilesystemObservationRecord>;
}): Readonly<WorkspaceFilesystemObservationRecord> {
  assertPreparedAndPersistedIntent(input.prepared, input.persisted);
  assertProviderReadEvidence(input.persisted, input.providerObservation, input.observation);
  if (!Object.isFrozen(input.observation)) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('provider_evidence_mismatch');
  }
  issuedObservations.set(input.observation, {
    prepared: input.prepared,
    acknowledgement: input.persisted.acknowledgement,
    observation: input.observation,
    operationId: 'builtin:read_file',
    operationPath: input.providerObservation.target.lexicalPath,
  });
  return input.observation;
}

/**
 * Issue mutation observation authority only after ready durability and the
 * committed Provider evidence have both been verified. The full prepared
 * Provider DTO remains Builtin-private; only this process-local proof crosses
 * into terminal cloning.
 */
export function issueBuiltinWorkspaceFilesystemMutationObservation(input: {
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>;
  readonly mutationReady: Readonly<WorkspaceFilesystemMutationReadyRecord>;
  readonly providerObservation: Readonly<WorkspaceFilesystemCommittedMutation>;
  readonly observation: Readonly<WorkspaceFilesystemObservationRecord>;
}): Readonly<WorkspaceFilesystemObservationRecord> {
  assertPreparedAndPersistedMutationIntent(input.prepared, input.persisted);
  assertMutationReadyMatches(input.persisted, input.mutationReady);
  assertProviderMutationEvidence(
    input.persisted,
    input.mutationReady,
    input.providerObservation,
    input.observation,
  );
  if (!Object.isFrozen(input.observation)) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('provider_evidence_mismatch');
  }
  const operationId = input.prepared.identity.operationId;
  if (operationId !== 'builtin:write_file' && operationId !== 'builtin:edit_file') {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('persisted_intent_mismatch');
  }
  issuedObservations.set(input.observation, {
    prepared: input.prepared,
    acknowledgement: input.persisted.acknowledgement,
    observation: input.observation,
    operationId: operationId as 'builtin:write_file' | 'builtin:edit_file',
    operationPath: input.providerObservation.target.lexicalPath,
  });
  return input.observation;
}

/**
 * Validate the source observation before the adapter performs its JSON clone.
 * The returned token is process-local and can bind exactly one cloned terminal.
 */
export function authorizeBuiltinWorkspaceFilesystemTerminalClone(input: {
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly value: Readonly<BuiltinOperationExecutionValue>;
}): Readonly<CloneAuthorization> | null {
  const filesystemObservation = input.value.filesystemObservation;
  const operationId = input.prepared.identity.operationId;
  const filesystemOperation =
    operationId === 'builtin:read_file' ||
    operationId === 'builtin:write_file' ||
    operationId === 'builtin:edit_file';
  if (filesystemObservation === undefined) {
    if (filesystemOperation && input.value.ok) {
      throw new BuiltinWorkspaceFilesystemObservationAuthorityError('observation_missing');
    }
    return null;
  }
  if (!filesystemOperation || !input.value.ok || !isObservationRecord(filesystemObservation)) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('observation_not_issued');
  }
  const issued = issuedObservations.get(filesystemObservation);
  if (!issued) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('observation_not_issued');
  }
  if (issued.prepared !== input.prepared) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('prepared_identity_mismatch');
  }
  if (issued.operationId !== operationId) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('prepared_identity_mismatch');
  }
  assertObservationRecordMatches(filesystemObservation, issued.observation);
  if (input.value.path !== issued.operationPath) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('provider_evidence_mismatch');
  }
  const authorization = Object.freeze({
    schema: 'kite.builtin-workspace-filesystem-clone-authorization.v1' as const,
  });
  cloneAuthorizations.set(authorization, issued);
  return authorization;
}

/** Bind one source proof to the exact deeply frozen JSON clone returned to Host. */
export function bindBuiltinWorkspaceFilesystemClonedTerminal(input: {
  readonly authorization: Readonly<CloneAuthorization>;
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly terminal: Readonly<CapabilityToolTerminalResult>;
}): void {
  const issued = cloneAuthorizations.get(input.authorization);
  cloneAuthorizations.delete(input.authorization);
  if (!issued || issued.prepared !== input.prepared) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('prepared_identity_mismatch');
  }
  const structured = input.terminal.structuredContent;
  if (
    input.terminal.status !== 'success' ||
    !Object.isFrozen(input.terminal) ||
    !isRecord(structured) ||
    !Object.isFrozen(structured) ||
    structured.path !== issued.operationPath
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('terminal_clone_mismatch');
  }
  const clonedObservation = structured.filesystemObservation;
  if (
    !isObservationRecord(clonedObservation) ||
    clonedObservation === issued.observation ||
    !Object.isFrozen(clonedObservation)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('terminal_clone_mismatch');
  }
  assertObservationRecordMatches(clonedObservation, issued.observation);
  boundTerminals.set(input.terminal, {
    ...issued,
    terminal: input.terminal,
    clonedObservation,
  });
}

export const verifyBuiltinWorkspaceFilesystemTerminal: BuiltinWorkspaceFilesystemTerminalVerifier =
  (input) => {
    const bound = boundTerminals.get(input.result);
    if (!bound) return Object.freeze({ valid: false, code: 'terminal_not_issued' });
    if (input.acknowledgement !== bound.acknowledgement) {
      return Object.freeze({ valid: false, code: 'acknowledgement_mismatch' });
    }
    const structured = input.result.structuredContent;
    if (
      input.result !== bound.terminal ||
      !Object.isFrozen(input.result) ||
      !isRecord(structured) ||
      structured.filesystemObservation !== bound.clonedObservation ||
      !acknowledgementMatchesPrepared(
        bound.acknowledgement,
        bound.prepared,
        bound.acknowledgement.attempt.attempt,
      )
    ) {
      return Object.freeze({ valid: false, code: 'terminal_identity_mismatch' });
    }
    try {
      assertObservationRecordMatches(bound.clonedObservation, bound.observation);
    } catch {
      return Object.freeze({ valid: false, code: 'terminal_identity_mismatch' });
    }
    return Object.freeze({ valid: true, observation: bound.clonedObservation });
  };

function assertPreparedAndPersistedIntent(
  prepared: Readonly<PreparedToolInvocation>,
  persisted: Readonly<WorkspaceFilesystemPersistedIntent>,
): void {
  const identity = prepared.identity;
  if (
    identity.isDynamicMcp ||
    identity.operationId !== 'builtin:read_file' ||
    persisted.prepared !== prepared ||
    persisted.operation.operationId !== 'builtin:read_file' ||
    persisted.operation.kind !== 'read_file'
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('persisted_intent_mismatch');
  }
  if (
    persisted.record.operationDigest !==
      workspaceFilesystemOperationDigest(providerOperation(persisted.operation)) ||
    persisted.record.lexicalTargetDigest !==
      workspaceFilesystemStringDigest(persisted.operation.path) ||
    persisted.record.argumentsDigest !== identity.argumentsDigest ||
    persisted.record.admissionDigest !== identity.admissionDigest ||
    persisted.record.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    !acknowledgementMatchesPrepared(persisted.acknowledgement, prepared, persisted.record.attempt)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('persisted_intent_mismatch');
  }
}

function assertPreparedAndPersistedMutationIntent(
  prepared: Readonly<PreparedToolInvocation>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
): void {
  const identity = prepared.identity;
  const operationId = identity.operationId;
  if (
    identity.isDynamicMcp ||
    (operationId !== 'builtin:write_file' && operationId !== 'builtin:edit_file') ||
    persisted.prepared !== prepared ||
    persisted.operation.operationId !== operationId ||
    persisted.operation.kind !== operationId.slice('builtin:'.length)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('persisted_intent_mismatch');
  }
  if (
    persisted.record.operationDigest !==
      workspaceFilesystemOperationDigest(providerOperation(persisted.operation)) ||
    persisted.record.lexicalTargetDigest !==
      workspaceFilesystemStringDigest(persisted.operation.path) ||
    persisted.record.argumentsDigest !== identity.argumentsDigest ||
    persisted.record.admissionDigest !== identity.admissionDigest ||
    persisted.record.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    !acknowledgementMatchesPrepared(persisted.acknowledgement, prepared, persisted.record.attempt)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('persisted_intent_mismatch');
  }
}

function assertMutationReadyMatches(
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
  ready: Readonly<WorkspaceFilesystemMutationReadyRecord>,
): void {
  try {
    validateWorkspaceFilesystemMutationReadyRecord(ready);
  } catch {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('provider_evidence_mismatch');
  }
  if (
    !Object.isFrozen(ready) ||
    ready.attempt !== persisted.record.attempt ||
    ready.intentDigest !== persisted.record.intentDigest ||
    ready.operationDigest !== persisted.record.operationDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('persisted_intent_mismatch');
  }
}

function assertProviderMutationEvidence(
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntent>,
  ready: Readonly<WorkspaceFilesystemMutationReadyRecord>,
  provider: Readonly<WorkspaceFilesystemCommittedMutation>,
  observation: Readonly<WorkspaceFilesystemObservationRecord>,
): void {
  const operation = persisted.operation;
  const targetEvidence = workspaceFilesystemTargetEvidence(provider.target);
  if (
    provider.kind !== 'committed_mutation' ||
    provider.operationKind !== operation.kind ||
    provider.operationDigest !== workspaceFilesystemOperationDigest(providerOperation(operation)) ||
    provider.target.lexicalPath !== operation.path ||
    provider.targetEvidence.lexicalTargetDigest !== targetEvidence.lexicalTargetDigest ||
    provider.targetEvidence.canonicalTargetDigest !== targetEvidence.canonicalTargetDigest ||
    provider.targetEvidence.targetIdentityDigest !== targetEvidence.targetIdentityDigest ||
    ready.operationDigest !== provider.operationDigest ||
    ready.preimageDigest !== provider.beforeContentDigest ||
    persisted.record.lexicalTargetDigest !== provider.targetEvidence.lexicalTargetDigest ||
    observation.actorIdentityDigest.length === 0 ||
    observation.lexicalTargetDigest !== provider.targetEvidence.lexicalTargetDigest ||
    observation.canonicalTargetDigest !== provider.targetEvidence.canonicalTargetDigest ||
    observation.targetIdentityDigest !== provider.targetEvidence.targetIdentityDigest ||
    observation.contentDigest !== provider.afterContentDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('provider_evidence_mismatch');
  }
}

function assertProviderReadEvidence(
  persisted: Readonly<WorkspaceFilesystemPersistedIntent>,
  provider: Readonly<WorkspaceReadFileObservation>,
  observation: Readonly<WorkspaceFilesystemObservationRecord>,
): void {
  const targetEvidence = workspaceFilesystemTargetEvidence(provider.target);
  if (
    provider.kind !== 'read_file' ||
    provider.target.lexicalPath !== persisted.operation.path ||
    provider.targetEvidence.lexicalTargetDigest !== targetEvidence.lexicalTargetDigest ||
    provider.targetEvidence.canonicalTargetDigest !== targetEvidence.canonicalTargetDigest ||
    provider.targetEvidence.targetIdentityDigest !== targetEvidence.targetIdentityDigest ||
    provider.contentDigest !== workspaceFilesystemStringDigest(provider.rawContent) ||
    persisted.record.lexicalTargetDigest !== provider.targetEvidence.lexicalTargetDigest ||
    observation.lexicalTargetDigest !== provider.targetEvidence.lexicalTargetDigest ||
    observation.canonicalTargetDigest !== provider.targetEvidence.canonicalTargetDigest ||
    observation.targetIdentityDigest !== provider.targetEvidence.targetIdentityDigest ||
    observation.contentDigest !== provider.contentDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('provider_evidence_mismatch');
  }
}

function acknowledgementMatchesPrepared(
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
  prepared: Readonly<PreparedToolInvocation>,
  attempt: number,
): boolean {
  const recorded = acknowledgement.attempt;
  const identity = prepared.identity;
  return (
    acknowledgement.acknowledged === true &&
    recorded.invocationId === identity.invocationId &&
    recorded.attemptId === identity.attemptId &&
    recorded.attempt === attempt &&
    recorded.toolCallId === identity.toolCallId &&
    recorded.turnId === identity.turnId &&
    recorded.modelMessageId === identity.modelMessageId &&
    recorded.argumentOrigin === identity.argumentOrigin &&
    recorded.providerId === identity.providerId &&
    recorded.operationId === identity.operationId &&
    recorded.capabilityId === identity.capabilityId &&
    recorded.capabilityRevision === identity.capabilityRevision &&
    recorded.descriptorRevision === identity.descriptorRevision &&
    recorded.parserRevision === identity.parserRevision &&
    recorded.executorRevision === identity.executorRevision &&
    recorded.argumentsDigest === identity.argumentsDigest &&
    recorded.schemaDigest === identity.schemaDigest &&
    recorded.effectiveEffectsDigest === identity.effectiveEffectsDigest &&
    recorded.builtinProjectionRevision === identity.builtinProjectionRevision &&
    recorded.dynamicCatalogRevision === identity.dynamicCatalogRevision &&
    recorded.policyDigest === identity.policyDigest &&
    recorded.authorizationDigest === identity.authorizationDigest &&
    recorded.admissionDigest === identity.admissionDigest &&
    recorded.idempotencyKey === identity.idempotencyKey
  );
}

function providerOperation(
  operation: Readonly<
    | WorkspaceFilesystemPersistedIntent['operation']
    | WorkspaceFilesystemPersistedMutationIntent['operation']
  >,
) {
  const { operationId: _operationId, ...providerOperation } = operation;
  return providerOperation;
}

function assertObservationRecordMatches(
  left: Readonly<WorkspaceFilesystemObservationRecord>,
  right: Readonly<WorkspaceFilesystemObservationRecord>,
): void {
  if (
    left.actorIdentityDigest !== right.actorIdentityDigest ||
    left.lexicalTargetDigest !== right.lexicalTargetDigest ||
    left.canonicalTargetDigest !== right.canonicalTargetDigest ||
    left.targetIdentityDigest !== right.targetIdentityDigest ||
    left.contentDigest !== right.contentDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityError('terminal_clone_mismatch');
  }
}

function isObservationRecord(
  value: RuntimeJsonValue | undefined,
): value is Readonly<WorkspaceFilesystemObservationRecord> {
  return (
    isRecord(value) &&
    typeof value.actorIdentityDigest === 'string' &&
    typeof value.lexicalTargetDigest === 'string' &&
    typeof value.canonicalTargetDigest === 'string' &&
    typeof value.targetIdentityDigest === 'string' &&
    typeof value.contentDigest === 'string'
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, RuntimeJsonValue>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
