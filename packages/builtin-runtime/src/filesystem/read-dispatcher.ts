import type {
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelinePreparedIdentityVerifier,
  WorkspaceFilesystemDurableEvidencePort,
  WorkspaceFilesystemIntentDraft,
  WorkspaceFilesystemIntentRecord,
  WorkspaceFilesystemObserveOperation,
  WorkspaceFilesystemOperation,
  WorkspaceFilesystemProtectedBoundary,
  WorkspaceFilesystemReadOperation,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ } from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';
import type { ProtectedPathEvaluator } from '../sandbox/protected-path';
import {
  validateWorkspaceFilesystemIntentRecord,
  workspaceFilesystemIntentDigest,
} from './evidence';
import {
  validateWorkspaceFilesystemOperation,
  workspaceFilesystemOperationDigest,
  workspaceFilesystemProtectedBoundaryDigest,
  workspaceFilesystemStringDigest,
} from './grant-authority';
import { issueBuiltinWorkspaceFilesystemReadObservation } from './observation-authority';
import type {
  BuiltinWorkspaceFilesystemInvocationDispatcher,
  BuiltinWorkspaceFilesystemPipelineResult,
  BuiltinWorkspaceFilesystemRuntime,
} from './runtime-composition';

const DEFAULT_GRANT_TTL_MS_ = 30_000;
const READ_EFFECTS_DIGEST_ = digestCapabilityBindingValue({
  filesystem: 'read',
  network: 'none',
  externalState: 'none',
});

export interface BuiltinWorkspaceFilesystemActorIdentity {
  readonly threadId: string;
  readonly actorId: string;
}

export interface CreateBuiltinWorkspaceFilesystemReadDispatcherInput {
  readonly prepared: Readonly<PreparedToolInvocation>;
  /** Exact verifier from the same frozen Builtin callback bundle. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier;
  readonly runtime: Readonly<BuiltinWorkspaceFilesystemRuntime>;
  readonly durableEvidence: WorkspaceFilesystemDurableEvidencePort;
  readonly protectedPathEvaluator: ProtectedPathEvaluator;
  readonly protectedPathRevision: string;
  readonly actorIdentity: Readonly<BuiltinWorkspaceFilesystemActorIdentity>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export type BuiltinWorkspaceFilesystemReadDispatchErrorCode =
  | 'invalid_composition'
  | 'prepared_identity_invalid'
  | 'unsupported_operation'
  | 'operation_identity_mismatch'
  | 'protected_boundary_invalid'
  | 'intent_persistence_failed'
  | 'intent_verification_failed'
  | 'provider_observation_invalid';

export class BuiltinWorkspaceFilesystemReadDispatchError extends Error {
  readonly code: BuiltinWorkspaceFilesystemReadDispatchErrorCode;

  constructor(code: BuiltinWorkspaceFilesystemReadDispatchErrorCode) {
    super(`Builtin Workspace filesystem read dispatcher rejected '${code}'.`);
    this.name = 'BuiltinWorkspaceFilesystemReadDispatchError';
    this.code = code;
  }
}

/**
 * Read-only Workspace filesystem mechanism for the RM-16 FSR tranche.
 * State persistence and Host attempt ownership stay behind the injected
 * durable-evidence port; this dispatcher owns only Builtin filesystem
 * semantics and the existing grant/Provider route.
 */
export function createBuiltinWorkspaceFilesystemReadDispatcher(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInput>,
): BuiltinWorkspaceFilesystemInvocationDispatcher {
  assertComposition(input);
  return Object.freeze({
    dispatch: (operation: WorkspaceFilesystemOperation) => dispatchRead(input, operation),
  });
}

async function dispatchRead(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInput>,
  operation: WorkspaceFilesystemOperation,
): Promise<BuiltinWorkspaceFilesystemPipelineResult> {
  assertPreparedIdentity(input.prepared, input.verifyPreparedIdentity);
  const validated = readOperationForPrepared(
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
  } satisfies WorkspaceFilesystemIntentDraft);

  let persisted: Awaited<ReturnType<WorkspaceFilesystemDurableEvidencePort['persistIntent']>>;
  try {
    persisted = await input.durableEvidence.persistIntent(draft);
  } catch {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('intent_persistence_failed');
  }
  let verified = false;
  try {
    verified = input.durableEvidence.verifyPersistedIntent(persisted).valid;
  } catch {
    verified = false;
  }
  if (!verified || !persistedIntentMatches(input.prepared, pipelineOperation, intent, persisted)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('intent_verification_failed');
  }

  const grant = input.runtime.grants.issueObserveGrant({
    binding: Object.freeze({
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
    }),
    operation: validated,
    protectedBoundary: boundary,
    ttlMs: input.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS_,
  });
  const result = await input.runtime.provider.observe({ grant, signal: input.signal });
  if (!result.ok) {
    return Object.freeze({ ok: false, failure: Object.freeze({ ...result.failure }) });
  }
  if (result.observation.kind !== validated.kind) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('provider_observation_invalid');
  }
  if (validated.kind !== 'read_file') {
    return Object.freeze({ ok: true, observation: result.observation });
  }
  if (result.observation.kind !== 'read_file') {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('provider_observation_invalid');
  }
  const providerEvidence = result.observation.targetEvidence;
  const filesystemObservation = issueBuiltinWorkspaceFilesystemReadObservation({
    prepared: input.prepared,
    persisted,
    providerObservation: result.observation,
    observation: Object.freeze({
      actorIdentityDigest: digestCapabilityBindingValue({
        schema: 'kite.workspace-filesystem-actor.v1',
        threadId: input.actorIdentity.threadId,
        actorIdentity: input.actorIdentity.actorId,
      }),
      lexicalTargetDigest: providerEvidence.lexicalTargetDigest,
      canonicalTargetDigest: providerEvidence.canonicalTargetDigest,
      targetIdentityDigest: providerEvidence.targetIdentityDigest,
      contentDigest: result.observation.contentDigest,
    }),
  });
  return Object.freeze({
    ok: true,
    observation: result.observation,
    filesystemObservation,
  });
}

function assertComposition(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInput>,
): void {
  if (
    !input ||
    typeof input.verifyPreparedIdentity !== 'function' ||
    typeof input.durableEvidence?.persistIntent !== 'function' ||
    typeof input.durableEvidence?.verifyPersistedIntent !== 'function' ||
    typeof input.runtime?.provider?.observe !== 'function' ||
    typeof input.runtime?.grants?.issueObserveGrant !== 'function' ||
    typeof input.protectedPathEvaluator?.evaluate !== 'function' ||
    typeof input.protectedPathEvaluator?.projectFilesystemBoundary !== 'function' ||
    !nonEmpty(input.protectedPathRevision) ||
    !nonEmpty(input.actorIdentity?.threadId) ||
    !nonEmpty(input.actorIdentity?.actorId) ||
    !sameWorkspace(input.runtime.canonicalWorkspace, input.protectedPathEvaluator.workspaceRoot)
  ) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('invalid_composition');
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
    identity.effectiveEffectsDigest !== READ_EFFECTS_DIGEST_ ||
    !isReadOperationId(identity.operationId)
  ) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('prepared_identity_invalid');
  }
}

function readOperationForPrepared(
  prepared: Readonly<PreparedToolInvocation>,
  operation: WorkspaceFilesystemOperation,
  evaluator: ProtectedPathEvaluator,
): Readonly<WorkspaceFilesystemObserveOperation> {
  if (!isReadOperation(operation)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('unsupported_operation');
  }
  let validated: Readonly<WorkspaceFilesystemOperation>;
  try {
    validated = validateWorkspaceFilesystemOperation(operation, 'observe');
  } catch {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('operation_identity_mismatch');
  }
  if (!isReadOperation(validated)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('unsupported_operation');
  }
  const identity = prepared.identity;
  if (identity.isDynamicMcp || identity.operationId !== `builtin:${validated.kind}`) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('operation_identity_mismatch');
  }
  const args = jsonRecord(prepared.input.arguments);
  if (!argumentsMatchOperation(args, validated)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('operation_identity_mismatch');
  }
  const decision = evaluator.evaluate({ path: validated.path, operation: 'read' });
  const expectedScope = decision.relativePath === null ? 'external_read' : 'workspace_only';
  if (decision.outcome !== 'allow' || validated.pathScope !== expectedScope) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('protected_boundary_invalid');
  }
  return validated;
}

function protectedBoundary(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInput>,
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
    throw new BuiltinWorkspaceFilesystemReadDispatchError('protected_boundary_invalid');
  }
}

function intentRecord(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInput>,
  operation: Readonly<WorkspaceFilesystemObserveOperation>,
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
  operation: Readonly<WorkspaceFilesystemObserveOperation>,
): Readonly<WorkspaceFilesystemReadOperation> {
  const operationId = prepared.identity.operationId;
  if (operation.kind === 'read_file' && operationId === 'builtin:read_file') {
    return Object.freeze({ ...operation, operationId: 'builtin:read_file' as const });
  }
  if (operation.kind === 'search_files' && operationId === 'builtin:search_files') {
    return Object.freeze({ ...operation, operationId: 'builtin:search_files' as const });
  }
  if (operation.kind === 'search_content' && operationId === 'builtin:search_content') {
    return Object.freeze({ ...operation, operationId: 'builtin:search_content' as const });
  }
  throw new BuiltinWorkspaceFilesystemReadDispatchError('operation_identity_mismatch');
}

function persistedIntentMatches(
  prepared: Readonly<PreparedToolInvocation>,
  operation: Readonly<WorkspaceFilesystemReadOperation>,
  record: Readonly<WorkspaceFilesystemIntentRecord>,
  persisted: Awaited<ReturnType<WorkspaceFilesystemDurableEvidencePort['persistIntent']>>,
): boolean {
  const acknowledged = persisted.acknowledgement?.attempt;
  const identity = prepared.identity;
  try {
    return (
      persisted.schema === WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_ &&
      persisted.status === 'durably_persisted' &&
      persisted.prepared === prepared &&
      persisted.operation === operation &&
      persisted.record === record &&
      digestCapabilityBindingValue(persisted.operation) ===
        digestCapabilityBindingValue(operation) &&
      digestCapabilityBindingValue(persisted.record) === digestCapabilityBindingValue(record) &&
      acknowledged.invocationId === identity.invocationId &&
      acknowledged.attemptId === identity.attemptId &&
      acknowledged.attempt === record.attempt &&
      acknowledged.toolCallId === identity.toolCallId &&
      acknowledged.turnId === identity.turnId &&
      acknowledged.modelMessageId === identity.modelMessageId &&
      acknowledged.argumentOrigin === identity.argumentOrigin &&
      acknowledged.providerId === identity.providerId &&
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

function argumentsMatchOperation(
  args: Readonly<Record<string, RuntimeJsonValue>>,
  operation: Readonly<WorkspaceFilesystemObserveOperation>,
): boolean {
  if (operation.kind === 'read_file') {
    return (
      operation.path === args.path &&
      operation.offset === args.offset &&
      operation.limit === args.limit
    );
  }
  if (operation.kind === 'search_files') {
    return operation.path === (args.path ?? '.') && operation.pattern === args.pattern;
  }
  return (
    operation.path === (args.path ?? '.') &&
    operation.pattern === args.pattern &&
    operation.glob === args.glob
  );
}

function approvalSummary(prepared: Readonly<PreparedToolInvocation>): string {
  const facts = jsonRecord(prepared.input.facts);
  const summary = facts.approvalSummary;
  if (typeof summary !== 'string' || summary.length > 1024) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('prepared_identity_invalid');
  }
  return summary;
}

function attempt(invocationId: string, attemptId: string): number {
  const prefix = `${invocationId}:attempt:`;
  const suffix = attemptId.startsWith(prefix) ? attemptId.slice(prefix.length) : '';
  const attempt = Number(suffix);
  if (!/^[1-9]\d*$/u.test(suffix) || !Number.isSafeInteger(attempt)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('prepared_identity_invalid');
  }
  return attempt;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('invalid_composition');
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
    throw new BuiltinWorkspaceFilesystemReadDispatchError('prepared_identity_invalid');
  }
  return value as Readonly<Record<string, RuntimeJsonValue>>;
}

function isReadOperationId(value: string): boolean {
  return (
    value === 'builtin:read_file' ||
    value === 'builtin:search_files' ||
    value === 'builtin:search_content'
  );
}

function isReadOperation(
  operation: Readonly<WorkspaceFilesystemOperation>,
): operation is Readonly<WorkspaceFilesystemObserveOperation> {
  return (
    operation.kind === 'read_file' ||
    operation.kind === 'search_files' ||
    operation.kind === 'search_content'
  );
}

function sameWorkspace(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function required(value: string | null): string {
  if (!nonEmpty(value)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchError('prepared_identity_invalid');
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
