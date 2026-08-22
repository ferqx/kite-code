import type {
  CapabilityToolTerminalResultV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelineReceiptCommitV1,
  WorkspaceFilesystemCommittedMutationV1,
  WorkspaceFilesystemMutationReadyRecordV1,
  WorkspaceFilesystemObservationRecordV1,
  WorkspaceFilesystemPersistedIntentV1,
  WorkspaceFilesystemPersistedMutationIntentV1,
  WorkspaceReadFileObservationV1,
} from '@kite/runtime-spi';
import type { BuiltinOperationExecutionValueV1 } from '../rmv1-11-operations';
import { validateWorkspaceFilesystemMutationReadyRecordV1 } from './evidence';
import {
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemStringDigestV1,
  workspaceFilesystemTargetEvidenceV1,
} from './grant-authority';

export type BuiltinWorkspaceFilesystemObservationAuthorityErrorCodeV1 =
  | 'observation_missing'
  | 'observation_not_issued'
  | 'prepared_identity_mismatch'
  | 'persisted_intent_mismatch'
  | 'provider_evidence_mismatch'
  | 'terminal_clone_mismatch';

export class BuiltinWorkspaceFilesystemObservationAuthorityErrorV1 extends Error {
  readonly code: BuiltinWorkspaceFilesystemObservationAuthorityErrorCodeV1;

  constructor(code: BuiltinWorkspaceFilesystemObservationAuthorityErrorCodeV1) {
    super(`Builtin Workspace filesystem observation authority rejected '${code}'.`);
    this.name = 'BuiltinWorkspaceFilesystemObservationAuthorityErrorV1';
    this.code = code;
  }
}

export type BuiltinWorkspaceFilesystemTerminalVerificationResultV1 =
  | {
      readonly valid: true;
      readonly observation: Readonly<WorkspaceFilesystemObservationRecordV1>;
    }
  | {
      readonly valid: false;
      readonly code:
        | 'terminal_not_issued'
        | 'acknowledgement_mismatch'
        | 'terminal_identity_mismatch';
    };

/** App may call this exact SPI-only seam before committing a State26 receipt. */
export type BuiltinWorkspaceFilesystemTerminalVerifierV1 = (
  input: Readonly<ToolPipelineReceiptCommitV1>,
) => Readonly<BuiltinWorkspaceFilesystemTerminalVerificationResultV1>;

interface IssuedObservationV1 {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly observation: Readonly<WorkspaceFilesystemObservationRecordV1>;
  readonly operationId: 'builtin:read_file' | 'builtin:write_file' | 'builtin:edit_file';
  readonly operationPath: string;
}

interface CloneAuthorizationV1 {
  readonly schema: 'kite.builtin-workspace-filesystem-clone-authorization.v1';
}

interface BoundTerminalV1 extends IssuedObservationV1 {
  readonly terminal: Readonly<CapabilityToolTerminalResultV1>;
  readonly clonedObservation: Readonly<WorkspaceFilesystemObservationRecordV1>;
}

const issuedObservationsV1 = new WeakMap<object, IssuedObservationV1>();
const cloneAuthorizationsV1 = new WeakMap<object, IssuedObservationV1>();
const boundTerminalsV1 = new WeakMap<object, BoundTerminalV1>();

/** Package-internal issuer called only after durable intent and Provider evidence checks. */
export function issueBuiltinWorkspaceFilesystemReadObservationV1(input: {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly persisted: Readonly<WorkspaceFilesystemPersistedIntentV1>;
  readonly providerObservation: Readonly<WorkspaceReadFileObservationV1>;
  readonly observation: Readonly<WorkspaceFilesystemObservationRecordV1>;
}): Readonly<WorkspaceFilesystemObservationRecordV1> {
  assertPreparedAndPersistedIntentV1(input.prepared, input.persisted);
  assertProviderReadEvidenceV1(input.persisted, input.providerObservation, input.observation);
  if (!Object.isFrozen(input.observation)) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('provider_evidence_mismatch');
  }
  issuedObservationsV1.set(input.observation, {
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
export function issueBuiltinWorkspaceFilesystemMutationObservationV1(input: {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>;
  readonly mutationReady: Readonly<WorkspaceFilesystemMutationReadyRecordV1>;
  readonly providerObservation: Readonly<WorkspaceFilesystemCommittedMutationV1>;
  readonly observation: Readonly<WorkspaceFilesystemObservationRecordV1>;
}): Readonly<WorkspaceFilesystemObservationRecordV1> {
  assertPreparedAndPersistedMutationIntentV1(input.prepared, input.persisted);
  assertMutationReadyMatchesV1(input.persisted, input.mutationReady);
  assertProviderMutationEvidenceV1(
    input.persisted,
    input.mutationReady,
    input.providerObservation,
    input.observation,
  );
  if (!Object.isFrozen(input.observation)) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('provider_evidence_mismatch');
  }
  const operationId = input.prepared.identity.operationId;
  if (operationId !== 'builtin:write_file' && operationId !== 'builtin:edit_file') {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('persisted_intent_mismatch');
  }
  issuedObservationsV1.set(input.observation, {
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
export function authorizeBuiltinWorkspaceFilesystemTerminalCloneV1(input: {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly value: Readonly<BuiltinOperationExecutionValueV1>;
}): Readonly<CloneAuthorizationV1> | null {
  const filesystemObservation = input.value.filesystemObservation;
  const operationId = input.prepared.identity.operationId;
  const filesystemOperation =
    operationId === 'builtin:read_file' ||
    operationId === 'builtin:write_file' ||
    operationId === 'builtin:edit_file';
  if (filesystemObservation === undefined) {
    if (filesystemOperation && input.value.ok) {
      throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('observation_missing');
    }
    return null;
  }
  if (!filesystemOperation || !input.value.ok || !isObservationRecordV1(filesystemObservation)) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('observation_not_issued');
  }
  const issued = issuedObservationsV1.get(filesystemObservation);
  if (!issued) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('observation_not_issued');
  }
  if (issued.prepared !== input.prepared) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('prepared_identity_mismatch');
  }
  if (issued.operationId !== operationId) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('prepared_identity_mismatch');
  }
  assertObservationRecordMatchesV1(filesystemObservation, issued.observation);
  if (input.value.path !== issued.operationPath) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('provider_evidence_mismatch');
  }
  const authorization = Object.freeze({
    schema: 'kite.builtin-workspace-filesystem-clone-authorization.v1' as const,
  });
  cloneAuthorizationsV1.set(authorization, issued);
  return authorization;
}

/** Bind one source proof to the exact deeply frozen JSON clone returned to Host. */
export function bindBuiltinWorkspaceFilesystemClonedTerminalV1(input: {
  readonly authorization: Readonly<CloneAuthorizationV1>;
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly terminal: Readonly<CapabilityToolTerminalResultV1>;
}): void {
  const issued = cloneAuthorizationsV1.get(input.authorization);
  cloneAuthorizationsV1.delete(input.authorization);
  if (!issued || issued.prepared !== input.prepared) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('prepared_identity_mismatch');
  }
  const structured = input.terminal.structuredContent;
  if (
    input.terminal.status !== 'success' ||
    !Object.isFrozen(input.terminal) ||
    !isRecordV1(structured) ||
    !Object.isFrozen(structured) ||
    structured.path !== issued.operationPath
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('terminal_clone_mismatch');
  }
  const clonedObservation = structured.filesystemObservation;
  if (
    !isObservationRecordV1(clonedObservation) ||
    clonedObservation === issued.observation ||
    !Object.isFrozen(clonedObservation)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('terminal_clone_mismatch');
  }
  assertObservationRecordMatchesV1(clonedObservation, issued.observation);
  boundTerminalsV1.set(input.terminal, {
    ...issued,
    terminal: input.terminal,
    clonedObservation,
  });
}

export const verifyBuiltinWorkspaceFilesystemTerminalV1: BuiltinWorkspaceFilesystemTerminalVerifierV1 =
  (input) => {
    const bound = boundTerminalsV1.get(input.result);
    if (!bound) return Object.freeze({ valid: false, code: 'terminal_not_issued' });
    if (input.acknowledgement !== bound.acknowledgement) {
      return Object.freeze({ valid: false, code: 'acknowledgement_mismatch' });
    }
    const structured = input.result.structuredContent;
    if (
      input.result !== bound.terminal ||
      !Object.isFrozen(input.result) ||
      !isRecordV1(structured) ||
      structured.filesystemObservation !== bound.clonedObservation ||
      !acknowledgementMatchesPreparedV1(
        bound.acknowledgement,
        bound.prepared,
        bound.acknowledgement.attempt.attempt,
      )
    ) {
      return Object.freeze({ valid: false, code: 'terminal_identity_mismatch' });
    }
    try {
      assertObservationRecordMatchesV1(bound.clonedObservation, bound.observation);
    } catch {
      return Object.freeze({ valid: false, code: 'terminal_identity_mismatch' });
    }
    return Object.freeze({ valid: true, observation: bound.clonedObservation });
  };

function assertPreparedAndPersistedIntentV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  persisted: Readonly<WorkspaceFilesystemPersistedIntentV1>,
): void {
  const identity = prepared.identity;
  if (
    identity.isDynamicMcp ||
    identity.operationId !== 'builtin:read_file' ||
    persisted.prepared !== prepared ||
    persisted.operation.operationId !== 'builtin:read_file' ||
    persisted.operation.kind !== 'read_file'
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('persisted_intent_mismatch');
  }
  if (
    persisted.record.operationDigest !==
      workspaceFilesystemOperationDigestV1(providerOperationV1(persisted.operation)) ||
    persisted.record.lexicalTargetDigest !==
      workspaceFilesystemStringDigestV1(persisted.operation.path) ||
    persisted.record.argumentsDigest !== identity.argumentsDigest ||
    persisted.record.admissionDigest !== identity.admissionDigest ||
    persisted.record.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    !acknowledgementMatchesPreparedV1(persisted.acknowledgement, prepared, persisted.record.attempt)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('persisted_intent_mismatch');
  }
}

function assertPreparedAndPersistedMutationIntentV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
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
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('persisted_intent_mismatch');
  }
  if (
    persisted.record.operationDigest !==
      workspaceFilesystemOperationDigestV1(providerOperationV1(persisted.operation)) ||
    persisted.record.lexicalTargetDigest !==
      workspaceFilesystemStringDigestV1(persisted.operation.path) ||
    persisted.record.argumentsDigest !== identity.argumentsDigest ||
    persisted.record.admissionDigest !== identity.admissionDigest ||
    persisted.record.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    !acknowledgementMatchesPreparedV1(persisted.acknowledgement, prepared, persisted.record.attempt)
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('persisted_intent_mismatch');
  }
}

function assertMutationReadyMatchesV1(
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
  ready: Readonly<WorkspaceFilesystemMutationReadyRecordV1>,
): void {
  try {
    validateWorkspaceFilesystemMutationReadyRecordV1(ready);
  } catch {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('provider_evidence_mismatch');
  }
  if (
    !Object.isFrozen(ready) ||
    ready.attempt !== persisted.record.attempt ||
    ready.intentDigest !== persisted.record.intentDigest ||
    ready.operationDigest !== persisted.record.operationDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('persisted_intent_mismatch');
  }
}

function assertProviderMutationEvidenceV1(
  persisted: Readonly<WorkspaceFilesystemPersistedMutationIntentV1>,
  ready: Readonly<WorkspaceFilesystemMutationReadyRecordV1>,
  provider: Readonly<WorkspaceFilesystemCommittedMutationV1>,
  observation: Readonly<WorkspaceFilesystemObservationRecordV1>,
): void {
  const operation = persisted.operation;
  const targetEvidence = workspaceFilesystemTargetEvidenceV1(provider.target);
  if (
    provider.kind !== 'committed_mutation' ||
    provider.operationKind !== operation.kind ||
    provider.operationDigest !==
      workspaceFilesystemOperationDigestV1(providerOperationV1(operation)) ||
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
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('provider_evidence_mismatch');
  }
}

function assertProviderReadEvidenceV1(
  persisted: Readonly<WorkspaceFilesystemPersistedIntentV1>,
  provider: Readonly<WorkspaceReadFileObservationV1>,
  observation: Readonly<WorkspaceFilesystemObservationRecordV1>,
): void {
  const targetEvidence = workspaceFilesystemTargetEvidenceV1(provider.target);
  if (
    provider.kind !== 'read_file' ||
    provider.target.lexicalPath !== persisted.operation.path ||
    provider.targetEvidence.lexicalTargetDigest !== targetEvidence.lexicalTargetDigest ||
    provider.targetEvidence.canonicalTargetDigest !== targetEvidence.canonicalTargetDigest ||
    provider.targetEvidence.targetIdentityDigest !== targetEvidence.targetIdentityDigest ||
    provider.contentDigest !== workspaceFilesystemStringDigestV1(provider.rawContent) ||
    persisted.record.lexicalTargetDigest !== provider.targetEvidence.lexicalTargetDigest ||
    observation.lexicalTargetDigest !== provider.targetEvidence.lexicalTargetDigest ||
    observation.canonicalTargetDigest !== provider.targetEvidence.canonicalTargetDigest ||
    observation.targetIdentityDigest !== provider.targetEvidence.targetIdentityDigest ||
    observation.contentDigest !== provider.contentDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('provider_evidence_mismatch');
  }
}

function acknowledgementMatchesPreparedV1(
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
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

function providerOperationV1(
  operation: Readonly<
    | WorkspaceFilesystemPersistedIntentV1['operation']
    | WorkspaceFilesystemPersistedMutationIntentV1['operation']
  >,
) {
  const { operationId: _operationId, ...providerOperation } = operation;
  return providerOperation;
}

function assertObservationRecordMatchesV1(
  left: Readonly<WorkspaceFilesystemObservationRecordV1>,
  right: Readonly<WorkspaceFilesystemObservationRecordV1>,
): void {
  if (
    left.actorIdentityDigest !== right.actorIdentityDigest ||
    left.lexicalTargetDigest !== right.lexicalTargetDigest ||
    left.canonicalTargetDigest !== right.canonicalTargetDigest ||
    left.targetIdentityDigest !== right.targetIdentityDigest ||
    left.contentDigest !== right.contentDigest
  ) {
    throw new BuiltinWorkspaceFilesystemObservationAuthorityErrorV1('terminal_clone_mismatch');
  }
}

function isObservationRecordV1(
  value: RuntimeJsonValueV1 | undefined,
): value is Readonly<WorkspaceFilesystemObservationRecordV1> {
  return (
    isRecordV1(value) &&
    typeof value.actorIdentityDigest === 'string' &&
    typeof value.lexicalTargetDigest === 'string' &&
    typeof value.canonicalTargetDigest === 'string' &&
    typeof value.targetIdentityDigest === 'string' &&
    typeof value.contentDigest === 'string'
  );
}

function isRecordV1(value: unknown): value is Readonly<Record<string, RuntimeJsonValueV1>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
