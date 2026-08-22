import type {
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelinePreparedIdentityVerifierV1,
  WorkspaceFilesystemDurableEvidencePortV1,
  WorkspaceFilesystemIntentDraftV1,
  WorkspaceFilesystemIntentRecordV1,
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemProtectedBoundaryV1,
  WorkspaceFilesystemReadOperationV1,
} from '@kite/runtime-spi';
import { WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 } from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from '../capability-binding';
import type { ProtectedPathEvaluatorV1 } from '../sandbox/protected-path';
import {
  validateWorkspaceFilesystemIntentRecordV1,
  workspaceFilesystemIntentDigestV1,
} from './evidence';
import {
  validateWorkspaceFilesystemOperationV1,
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
  workspaceFilesystemStringDigestV1,
} from './grant-authority';
import { issueBuiltinWorkspaceFilesystemReadObservationV1 } from './observation-authority';
import type {
  BuiltinWorkspaceFilesystemInvocationDispatcherV1,
  BuiltinWorkspaceFilesystemPipelineResultV1,
  BuiltinWorkspaceFilesystemRuntimeV1,
} from './runtime-composition';

const DEFAULT_GRANT_TTL_MS_V1 = 30_000;
const READ_EFFECTS_DIGEST_V1 = digestCapabilityBindingValueV1({
  filesystem: 'read',
  network: 'none',
  externalState: 'none',
});

export interface BuiltinWorkspaceFilesystemActorIdentityV1 {
  readonly threadId: string;
  readonly actorId: string;
}

export interface CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1 {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  /** Exact verifier from the same frozen Builtin callback bundle. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1;
  readonly runtime: Readonly<BuiltinWorkspaceFilesystemRuntimeV1>;
  readonly durableEvidence: WorkspaceFilesystemDurableEvidencePortV1;
  readonly protectedPathEvaluator: ProtectedPathEvaluatorV1;
  readonly protectedPathRevision: string;
  readonly actorIdentity: Readonly<BuiltinWorkspaceFilesystemActorIdentityV1>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export type BuiltinWorkspaceFilesystemReadDispatchErrorCodeV1 =
  | 'invalid_composition'
  | 'prepared_identity_invalid'
  | 'unsupported_operation'
  | 'operation_identity_mismatch'
  | 'protected_boundary_invalid'
  | 'intent_persistence_failed'
  | 'intent_verification_failed'
  | 'provider_observation_invalid';

export class BuiltinWorkspaceFilesystemReadDispatchErrorV1 extends Error {
  readonly code: BuiltinWorkspaceFilesystemReadDispatchErrorCodeV1;

  constructor(code: BuiltinWorkspaceFilesystemReadDispatchErrorCodeV1) {
    super(`Builtin Workspace filesystem read dispatcher rejected '${code}'.`);
    this.name = 'BuiltinWorkspaceFilesystemReadDispatchErrorV1';
    this.code = code;
  }
}

/**
 * Read-only Workspace filesystem mechanism for the RMV1-16 FSR tranche.
 * State25 persistence and Host attempt ownership stay behind the injected
 * durable-evidence port; this dispatcher owns only Builtin filesystem
 * semantics and the existing grant/Provider route.
 */
export function createBuiltinWorkspaceFilesystemReadDispatcherV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1>,
): BuiltinWorkspaceFilesystemInvocationDispatcherV1 {
  assertCompositionV1(input);
  return Object.freeze({
    dispatch: (operation: WorkspaceFilesystemOperationV1) => dispatchReadV1(input, operation),
  });
}

async function dispatchReadV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1>,
  operation: WorkspaceFilesystemOperationV1,
): Promise<BuiltinWorkspaceFilesystemPipelineResultV1> {
  assertPreparedIdentityV1(input.prepared, input.verifyPreparedIdentity);
  const validated = readOperationForPreparedV1(
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
  } satisfies WorkspaceFilesystemIntentDraftV1);

  let persisted: Awaited<ReturnType<WorkspaceFilesystemDurableEvidencePortV1['persistIntent']>>;
  try {
    persisted = await input.durableEvidence.persistIntent(draft);
  } catch {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('intent_persistence_failed');
  }
  let verified = false;
  try {
    verified = input.durableEvidence.verifyPersistedIntent(persisted).valid;
  } catch {
    verified = false;
  }
  if (
    !verified ||
    !persistedIntentMatchesV1(input.prepared, evidenceOperation, intent, persisted)
  ) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('intent_verification_failed');
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
      canonicalWorkspace: protectedBoundary.canonicalWorkspace,
      protectedPathRevision: input.protectedPathRevision,
      approvalSummary: approvalSummaryV1(input.prepared),
    }),
    operation: validated,
    protectedBoundary,
    ttlMs: input.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS_V1,
  });
  const result = await input.runtime.provider.observe({ grant, signal: input.signal });
  if (!result.ok) {
    return Object.freeze({ ok: false, failure: Object.freeze({ ...result.failure }) });
  }
  if (result.observation.kind !== validated.kind) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('provider_observation_invalid');
  }
  if (validated.kind !== 'read_file') {
    return Object.freeze({ ok: true, observation: result.observation });
  }
  if (result.observation.kind !== 'read_file') {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('provider_observation_invalid');
  }
  const providerEvidence = result.observation.targetEvidence;
  const filesystemObservation = issueBuiltinWorkspaceFilesystemReadObservationV1({
    prepared: input.prepared,
    persisted,
    providerObservation: result.observation,
    observation: Object.freeze({
      actorIdentityDigest: digestCapabilityBindingValueV1({
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

function assertCompositionV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1>,
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
    !nonEmptyV1(input.protectedPathRevision) ||
    !nonEmptyV1(input.actorIdentity?.threadId) ||
    !nonEmptyV1(input.actorIdentity?.actorId) ||
    !sameWorkspaceV1(input.runtime.canonicalWorkspace, input.protectedPathEvaluator.workspaceRoot)
  ) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('invalid_composition');
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
    identity.effectiveEffectsDigest !== READ_EFFECTS_DIGEST_V1 ||
    !isReadOperationIdV1(identity.operationId)
  ) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('prepared_identity_invalid');
  }
}

function readOperationForPreparedV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  operation: WorkspaceFilesystemOperationV1,
  evaluator: ProtectedPathEvaluatorV1,
): Readonly<WorkspaceFilesystemObserveOperationV1> {
  if (!isReadOperationV1(operation)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('unsupported_operation');
  }
  let validated: Readonly<WorkspaceFilesystemOperationV1>;
  try {
    validated = validateWorkspaceFilesystemOperationV1(operation, 'observe');
  } catch {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('operation_identity_mismatch');
  }
  if (!isReadOperationV1(validated)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('unsupported_operation');
  }
  const identity = prepared.identity;
  if (identity.isDynamicMcp || identity.operationId !== `builtin:${validated.kind}`) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('operation_identity_mismatch');
  }
  const args = jsonRecordV1(prepared.input.arguments);
  if (!argumentsMatchOperationV1(args, validated)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('operation_identity_mismatch');
  }
  const decision = evaluator.evaluate({ path: validated.path, operation: 'read' });
  const expectedScope = decision.relativePath === null ? 'external_read' : 'workspace_only';
  if (decision.outcome !== 'allow' || validated.pathScope !== expectedScope) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('protected_boundary_invalid');
  }
  return validated;
}

function protectedBoundaryV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1>,
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
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('protected_boundary_invalid');
  }
}

function intentRecordV1(
  input: Readonly<CreateBuiltinWorkspaceFilesystemReadDispatcherInputV1>,
  operation: Readonly<WorkspaceFilesystemObserveOperationV1>,
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
  operation: Readonly<WorkspaceFilesystemObserveOperationV1>,
): Readonly<WorkspaceFilesystemReadOperationV1> {
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
  throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('operation_identity_mismatch');
}

function persistedIntentMatchesV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  operation: Readonly<WorkspaceFilesystemReadOperationV1>,
  record: Readonly<WorkspaceFilesystemIntentRecordV1>,
  persisted: Awaited<ReturnType<WorkspaceFilesystemDurableEvidencePortV1['persistIntent']>>,
): boolean {
  const acknowledged = persisted.acknowledgement?.attempt;
  const identity = prepared.identity;
  try {
    return (
      persisted.schema === WORKSPACE_FILESYSTEM_PIPELINE_SCHEMA_V1 &&
      persisted.status === 'durably_persisted' &&
      persisted.prepared === prepared &&
      persisted.operation === operation &&
      persisted.record === record &&
      digestCapabilityBindingValueV1(persisted.operation) ===
        digestCapabilityBindingValueV1(operation) &&
      digestCapabilityBindingValueV1(persisted.record) === digestCapabilityBindingValueV1(record) &&
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

function argumentsMatchOperationV1(
  args: Readonly<Record<string, RuntimeJsonValueV1>>,
  operation: Readonly<WorkspaceFilesystemObserveOperationV1>,
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

function approvalSummaryV1(prepared: Readonly<PreparedToolInvocationV1>): string {
  const facts = jsonRecordV1(prepared.input.facts);
  const summary = facts.approvalSummary;
  if (typeof summary !== 'string' || summary.length > 1024) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('prepared_identity_invalid');
  }
  return summary;
}

function attemptV1(invocationId: string, attemptId: string): number {
  const prefix = `${invocationId}:attempt:`;
  const suffix = attemptId.startsWith(prefix) ? attemptId.slice(prefix.length) : '';
  const attempt = Number(suffix);
  if (!/^[1-9]\d*$/u.test(suffix) || !Number.isSafeInteger(attempt)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('prepared_identity_invalid');
  }
  return attempt;
}

function timestampV1(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('invalid_composition');
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
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('prepared_identity_invalid');
  }
  return value as Readonly<Record<string, RuntimeJsonValueV1>>;
}

function isReadOperationIdV1(value: string): boolean {
  return (
    value === 'builtin:read_file' ||
    value === 'builtin:search_files' ||
    value === 'builtin:search_content'
  );
}

function isReadOperationV1(
  operation: Readonly<WorkspaceFilesystemOperationV1>,
): operation is Readonly<WorkspaceFilesystemObserveOperationV1> {
  return (
    operation.kind === 'read_file' ||
    operation.kind === 'search_files' ||
    operation.kind === 'search_content'
  );
}

function sameWorkspaceV1(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function requiredV1(value: string | null): string {
  if (!nonEmptyV1(value)) {
    throw new BuiltinWorkspaceFilesystemReadDispatchErrorV1('prepared_identity_invalid');
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
