import type {
  CapabilityExecutionMechanismV1,
  CapabilityToolTerminalResultV1,
  ClassifiedProviderFailureV1,
  ExecutionReceiptV1,
  NonDynamicPreparedToolInvocationIdentityV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineDispatchV1,
  ToolPipelinePreparedIdentityVerifierV1,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import {
  authorizeBuiltinWorkspaceFilesystemTerminalCloneV1,
  bindBuiltinWorkspaceFilesystemClonedTerminalV1,
} from './filesystem/observation-authority';
import type { BuiltinOperationExecutionValueV1 } from './model-operations';
import type {
  BuiltinInternalOperationCatalogEntryV1,
  BuiltinModelToolCatalogEntryV1,
  BuiltinToolCatalogEntryV1,
  BuiltinToolCatalogProjectionV1,
} from './tool-catalog';
import { BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1 } from './tool-pipeline-callbacks';
import { toolExecutionModelContentV1 } from './tool-result-projection';
import { isToolSearchExecutionValueV1 } from './tool-search';

/**
 * The neutral input handed to the App/Host-composed dispatch port.
 *
 * The port receives only the already prepared, canonical request and immutable
 * routing facts. It does not receive a registry, a snapshot, a parser, policy
 * callbacks, or a persistence handle. The App composition owns the concrete
 * mechanism map behind this port.
 */
export interface BuiltinPreparedToolDispatchInputV1 {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly operationId: string;
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly arguments: RuntimeJsonValueV1;
}

/**
 * One injected neutral port for an already admitted Builtin operation.
 *
 * This is deliberately not the Host registry invocation port: the Host owns
 * that registry boundary. Builtin only supplies the operation result projection
 * after the composition root has selected its mechanism port. The production
 * App implementation must be a thin call to `projection.dispatch` with the
 * supplied Host capability port and exact invocation; it must not be a second
 * executor, registry, handler, or fallback.
 */
export interface BuiltinPreparedToolDispatchPortV1 {
  readonly dispatch: (
    input: Readonly<BuiltinPreparedToolDispatchInputV1>,
  ) => Promise<Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>>;
}

export type BuiltinPreparedToolDispatchFailureCodeV1 =
  | 'invalid_prepared_input'
  | 'identity_mismatch'
  | 'unsupported_operation'
  | 'tool_unavailable'
  | 'dispatch_unavailable'
  | 'invalid_result';

/** Bounded, package-local error; no Provider/Host diagnostic crosses it. */
export class BuiltinPreparedToolDispatchErrorV1 extends Error {
  readonly code: BuiltinPreparedToolDispatchFailureCodeV1;

  constructor(code: BuiltinPreparedToolDispatchFailureCodeV1) {
    super(builtinPreparedToolDispatchMessageV1(code));
    this.name = 'BuiltinPreparedToolDispatchErrorV1';
    this.code = code;
  }
}

export interface CreateBuiltinPreparedToolDispatchAdapterInputV1 {
  /** The exact frozen projection captured by the App composition root. */
  readonly projection: Readonly<BuiltinToolCatalogProjectionV1>;
  /** Must be the verifier supplied by the exact projection callback bundle. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1;
  /** The sole injected mechanism/dispatch port for this adapter instance. */
  readonly port: BuiltinPreparedToolDispatchPortV1;
}

/**
 * A Host-compatible Builtin dispatch callback bundle.
 *
 * `verifyPreparedIdentity` is returned by reference so the Host coordinator
 * invokes the exact Builtin callback once. The Host owns authenticity,
 * acknowledgement ordering, and exact-once claim; this adapter owns only
 * mechanical projection-entry and operation-boundary checks.
 */
export type BuiltinPreparedToolDispatchAdapterV1 = ToolPipelineDispatchV1<
  RuntimeJsonValueV1,
  BuiltinOperationExecutionValueV1
>;

export function createBuiltinPreparedToolDispatchAdapterV1(
  input: CreateBuiltinPreparedToolDispatchAdapterInputV1,
): BuiltinPreparedToolDispatchAdapterV1 {
  assertFrozenProjectionV1(input.projection);
  if (!input.port || typeof input.port.dispatch !== 'function') {
    throw new BuiltinPreparedToolDispatchErrorV1('dispatch_unavailable');
  }
  if (typeof input.verifyPreparedIdentity !== 'function') {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_prepared_input');
  }

  const verifyPreparedIdentity = input.verifyPreparedIdentity;

  const dispatch = async (
    prepared: Readonly<PreparedToolInvocationV1<RuntimeJsonValueV1, RuntimeJsonValueV1>>,
  ): Promise<Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>> => {
    if (!isDeepFrozenPreparedV1(prepared)) {
      throw new BuiltinPreparedToolDispatchErrorV1('invalid_prepared_input');
    }

    const entry = exactModelEntryForPreparedV1(input.projection, prepared);
    assertSupportedEntryV1(entry);

    // Host has already performed the exact verifier and claim before calling
    // this callback. A thrown neutral-port result remains an attempted
    // dispatch; this adapter never retries or selects a fallback.
    const receipt = await input.port.dispatch(
      Object.freeze({
        prepared,
        operationId: entry.operationId,
        executionMechanism: entry.executionMechanism,
        arguments: prepared.input.arguments,
      }),
    );
    assertReceiptIdentityV1(receipt, entry, prepared);
    return projectBuiltinExecutionReceiptTerminalResultForEntryV1(receipt, entry, prepared);
  };

  return Object.freeze({ verifyPreparedIdentity, dispatch });
}

/**
 * Inputs for the dedicated private Task dispatch seam.
 *
 * Task is intentionally not admitted by the ordinary Builtin adapter: its
 * runtime-private artifact and subagent lifecycle are an App-owned route. The
 * adapter below only performs the Builtin-side prepared packet and receipt
 * projection; it never creates a child runtime, persists a continuation, or
 * interprets a suspension.
 */
export interface CreateBuiltinPreparedTaskDispatchAdapterInputV1 {
  /** The one frozen Builtin catalog projection captured by App composition. */
  readonly projection: Readonly<BuiltinToolCatalogProjectionV1>;
  /** Retained by reference for the Host coordinator's exact identity check. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1;
  /** The sole supplied port for the already admitted Builtin operation. */
  readonly port: BuiltinPreparedToolDispatchPortV1;
}

export type BuiltinPreparedTaskDispatchAdapterV1 = ToolPipelineDispatchV1<
  RuntimeJsonValueV1,
  BuiltinOperationExecutionValueV1
>;

/**
 * Build the Builtin-only prepared dispatch callback for `builtin:task`.
 *
 * The operation is a model-visible subagent operation, but this callback only
 * accepts the private runtime parser projection. Public model arguments,
 * missing/invalid task artifacts, the model parser revision, and any drift in
 * the frozen task entry are rejected before the injected port is reached.
 */
export function createBuiltinPreparedTaskDispatchAdapterV1(
  input: CreateBuiltinPreparedTaskDispatchAdapterInputV1,
): BuiltinPreparedTaskDispatchAdapterV1 {
  assertFrozenProjectionV1(input.projection);
  if (!input.port || typeof input.port.dispatch !== 'function') {
    throw new BuiltinPreparedToolDispatchErrorV1('dispatch_unavailable');
  }
  if (typeof input.verifyPreparedIdentity !== 'function') {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_prepared_input');
  }

  const verifyPreparedIdentity = input.verifyPreparedIdentity;
  const dispatch = async (
    prepared: Readonly<PreparedToolInvocationV1<RuntimeJsonValueV1, RuntimeJsonValueV1>>,
  ): Promise<Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>> => {
    const entry = exactPrivateTaskEntryForPreparedV1(input.projection, prepared);
    const receipt = await input.port.dispatch(
      Object.freeze({
        prepared,
        operationId: entry.operationId,
        executionMechanism: entry.executionMechanism,
        arguments: prepared.input.arguments,
      }),
    );
    assertReceiptIdentityV1(receipt, entry, prepared);
    return projectBuiltinExecutionReceiptTerminalResultForEntryV1(receipt, entry, prepared);
  };

  // Preserve the exact callback reference. Host owns the verification call and
  // exact-once claim; this adapter must not invoke a second verifier.
  return Object.freeze({ verifyPreparedIdentity, dispatch });
}

/**
 * Convert the canonical Builtin operation result into the neutral SPI
 * terminal envelope. No parser, schema, effect, policy, or Provider facts are
 * reconstructed here; the operation result already owns those semantics.
 */
export function projectBuiltinOperationTerminalResultV1(
  value: BuiltinOperationExecutionValueV1,
): Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>> {
  return projectBuiltinOperationTerminalResultForEntryV1(value);
}

/**
 * Project a Builtin operation result with the exact kind of the frozen
 * projection entry that produced it. Coordination/runtime-action operations
 * use the existing `rejected` terminal vocabulary for a valid domain value
 * with `ok: false`; the standalone projector above intentionally has no entry
 * context and retains its historical `builtin_operation_failed` behavior.
 */
function projectBuiltinOperationTerminalResultForEntryV1(
  value: BuiltinOperationExecutionValueV1,
  entryKind?: BuiltinModelToolCatalogEntryV1['kind'],
): Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>> {
  if (!isBuiltinOperationResultV1(value)) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
  }

  const text = toolExecutionModelContentV1(value);
  const structuredContent = cloneBuiltinOperationValueV1(value);
  const content: readonly RuntimeJsonValueV1[] =
    text.length === 0 ? Object.freeze([]) : Object.freeze([{ type: 'text' as const, text }]);
  if (value.ok) {
    return Object.freeze({
      status: 'success' as const,
      content,
      structuredContent,
    });
  }

  const failure = Object.freeze({
    code:
      value.terminationReason !== 'cancelled' &&
      (entryKind === 'coordination' || entryKind === 'runtime_action')
        ? 'rejected'
        : 'builtin_operation_failed',
    message: text || 'Builtin operation failed.',
    retryable: false,
    modelFixable: false,
    needsUserIntervention: value.terminationReason === 'sandbox_denied',
    terminatesTurn: false,
    journal: true,
    details: structuredContent,
  });
  return Object.freeze({
    status: value.terminationReason === 'cancelled' ? ('cancelled' as const) : ('error' as const),
    content,
    structuredContent,
    failure,
  });
}

/**
 * Preserve the Host/registry receipt state while projecting Builtin output.
 * Confirmed non-success receipts remain terminal results; they are not
 * converted into Host unknown exceptions merely because no Builtin value is
 * present.
 */
export function projectBuiltinExecutionReceiptTerminalResultV1(
  receipt: Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>,
): Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>> {
  return projectBuiltinExecutionReceiptTerminalResultForEntryV1(receipt);
}

/**
 * Project the confirmed Provider receipt for the private dynamic-MCP wrapper.
 *
 * The operation context is explicit so a generic failed receipt cannot acquire
 * MCP provider semantics. The exact frozen prepared identity and wrapper entry
 * must agree before a canonical provider-failure value is emitted.
 */
export function projectBuiltinDynamicMcpExecutionReceiptTerminalResultV1(
  receipt: Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>,
  entry: Readonly<BuiltinInternalOperationCatalogEntryV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>> {
  assertDynamicMcpProjectionContextV1(entry, prepared);
  assertReceiptIdentityV1(receipt, entry, prepared);
  return projectBuiltinExecutionReceiptTerminalResultForEntryV1(receipt, entry, prepared);
}

function projectBuiltinExecutionReceiptTerminalResultForEntryV1(
  receipt: Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>,
  entry?: Readonly<BuiltinToolCatalogEntryV1>,
  prepared?: Readonly<PreparedToolInvocationV1>,
): Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>> {
  if (receipt.status === 'succeeded') {
    const value = normalizeBuiltinExecutionValueV1(receipt.value);
    if (!value) {
      throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
    }
    const cloneAuthorization =
      entry && prepared
        ? authorizeBuiltinWorkspaceFilesystemTerminalCloneV1({ prepared, value })
        : null;
    const terminal = projectBuiltinOperationTerminalResultForEntryV1(value, entry?.kind);
    if (cloneAuthorization && prepared) {
      bindBuiltinWorkspaceFilesystemClonedTerminalV1({
        authorization: cloneAuthorization,
        prepared,
        terminal,
      });
    }
    return terminal;
  }

  const providerFailure = boundedProviderFailureV1(receipt.failure, receipt.status);
  const structuredContent = confirmedProviderFailureValueV1(entry, providerFailure);
  const status =
    receipt.status === 'cancelled'
      ? ('cancelled' as const)
      : receipt.status === 'unknown'
        ? ('unknown' as const)
        : ('error' as const);
  return Object.freeze({
    status,
    content: Object.freeze([]),
    ...(structuredContent ? { structuredContent } : {}),
    failure: Object.freeze({
      code: providerFailure.code,
      message: providerFailure.message,
      retryable: providerFailure.retryable,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: false,
      journal: true,
      details: Object.freeze({ providerFailure }),
    }),
  });
}

function confirmedProviderFailureValueV1(
  entry: Readonly<BuiltinToolCatalogEntryV1> | undefined,
  failure: Readonly<ClassifiedProviderFailureV1>,
): BuiltinOperationExecutionValueV1 | undefined {
  if (
    (entry?.operationId !== 'builtin:read_mcp_resource' &&
      entry?.operationId !== 'mcp:dynamic_tool') ||
    ![
      'provider_auth_required',
      'provider_approval_required',
      'provider_unavailable',
      'provider_capability_changed',
    ].includes(failure.code)
  ) {
    return undefined;
  }
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1' as const,
    ok: false,
    stdout: '',
    stderr: failure.message,
    resultMeta: Object.freeze({
      providerFailure: Object.freeze({
        code: failure.code,
        retryable: failure.retryable,
      }),
    }),
  }) as BuiltinOperationExecutionValueV1;
}

function assertDynamicMcpProjectionContextV1(
  entry: Readonly<BuiltinInternalOperationCatalogEntryV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): void {
  if (!Object.isFrozen(entry) || !isDeepFrozenPreparedV1(prepared)) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_prepared_input');
  }
  const identity = prepared.identity;
  if (
    !identity.isDynamicMcp ||
    identity.operationId !== 'mcp:dynamic_tool' ||
    identity.executionFamily !== 'mcp' ||
    identity.executionMechanism !== 'mcp' ||
    identity.executorRevision !== null ||
    identity.visibility !== 'internal' ||
    identity.modelVisible !== false ||
    identity.exposedToolName !== null ||
    identity.builtinProjectionRevision !== null ||
    identity.dynamicCatalogRevision.length === 0 ||
    identity.bindingId === null ||
    identity.subject.bindingId !== identity.bindingId ||
    identity.runtimeWrapper.operationId !== 'mcp:dynamic_tool' ||
    identity.runtimeWrapper.capabilityId !== 'mcp:dynamic_tool' ||
    entry.visibility !== 'internal' ||
    entry.operationId !== 'mcp:dynamic_tool' ||
    entry.capabilityId !== 'mcp:dynamic_tool' ||
    entry.executionMechanism !== 'mcp' ||
    entry.availability !== 'available' ||
    entry.providerId !== identity.runtimeWrapper.providerId ||
    entry.revision !== identity.runtimeWrapper.capabilityRevision ||
    entry.executorRevision !== identity.runtimeWrapper.executorRevision ||
    entry.inputSchemaDigest !== identity.runtimeWrapper.schemaDigest
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }
}

function exactModelEntryForPreparedV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<BuiltinModelToolCatalogEntryV1> {
  const identity = prepared.identity;
  if (identity.isDynamicMcp || identity.operationId === 'mcp:dynamic_tool') {
    throw new BuiltinPreparedToolDispatchErrorV1('unsupported_operation');
  }
  if (identity.builtinProjectionRevision !== projection.revision) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntryV1 =>
      candidate.visibility === 'model' && candidate.operationId === identity.operationId,
  );
  if (!entry) throw new BuiltinPreparedToolDispatchErrorV1('unsupported_operation');
  if (
    entry.name !== identity.exposedToolName ||
    entry.capabilityId !== identity.capabilityId ||
    entry.providerId !== identity.providerId ||
    entry.revision !== identity.capabilityRevision ||
    entry.executorRevision !== identity.executorRevision ||
    entry.descriptor.revision !== identity.descriptorRevision ||
    !preparedParserRevisionMatchesV1(entry, identity.parserRevision) ||
    entry.executionMechanism !== identity.executionMechanism ||
    !nestedIdentityMatchesEntryV1(entry, identity)
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }
  return entry;
}

/**
 * Validate the private Task packet without taking ownership of Task runtime
 * semantics. This is deliberately stricter than the ordinary Builtin entry
 * lookup: the ordinary route may recognize the public Task parser, while this
 * route accepts only the runtime parser and a complete private artifact.
 */
function exactPrivateTaskEntryForPreparedV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<BuiltinModelToolCatalogEntryV1> {
  if (!isDeepFrozenPreparedV1(prepared)) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_prepared_input');
  }

  const identity = prepared.identity;
  if (
    identity.isDynamicMcp ||
    identity.operationId !== 'builtin:task' ||
    identity.executionFamily !== 'subagent' ||
    identity.executionMechanism !== 'subagent' ||
    identity.visibility !== 'model' ||
    identity.modelVisible !== true ||
    identity.exposedToolName !== 'task' ||
    identity.argumentOrigin !== 'runtime_private' ||
    identity.builtinProjectionRevision !== projection.revision ||
    identity.dynamicCatalogRevision !== null ||
    identity.isDynamicMcp !== false ||
    identity.nestedCapabilityId !== null ||
    identity.nestedCapabilityRevision !== null ||
    identity.nestedCatalogRevision !== null ||
    identity.bindingId !== null ||
    prepared.input.binding !== null ||
    prepared.input.invocationId !== identity.invocationId ||
    prepared.input.attemptId !== identity.attemptId ||
    prepared.input.toolCallId !== identity.toolCallId
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntryV1 =>
      candidate.visibility === 'model' && candidate.operationId === 'builtin:task',
  );
  if (!entry) {
    throw new BuiltinPreparedToolDispatchErrorV1('unsupported_operation');
  }
  if (
    entry.kind !== 'coordination' ||
    entry.executionMechanism !== 'subagent' ||
    entry.availability !== 'available'
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('tool_unavailable');
  }

  const parserSchemaDigest = entry.parser.schemaDigest;
  if (
    !parserSchemaDigest ||
    !entry.inputSchemaDigest ||
    parserSchemaDigest !== entry.inputSchemaDigest ||
    identity.parserRevision !== entry.parser.parserRevision ||
    identity.schemaDigest !== parserSchemaDigest ||
    identity.operationId !== entry.operationId ||
    identity.toolKind !== entry.kind ||
    identity.capabilityId !== entry.capabilityId ||
    identity.capabilityRevision !== entry.revision ||
    identity.descriptorRevision !== entry.descriptor.revision ||
    identity.providerId !== entry.providerId ||
    identity.executorRevision !== entry.executorRevision ||
    identity.exposedToolName !== entry.name
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  const argumentsValue = prepared.input.arguments;
  if (!isPlainRecordV1(argumentsValue) || !Object.hasOwn(argumentsValue, 'taskArtifact')) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  let canonicalArguments: RuntimeJsonValueV1;
  let classification: ReturnType<BuiltinModelToolCatalogEntryV1['classifyEffects']>;
  try {
    const parsed = entry.parse(argumentsValue);
    if (!parsed.success) {
      throw new Error('Builtin Task runtime parser rejected the private artifact.');
    }
    canonicalArguments = entry.parser.canonicalize(parsed.data);
    classification = entry.classifyEffects(canonicalArguments);
  } catch (error) {
    if (error instanceof BuiltinPreparedToolDispatchErrorV1) {
      throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
    }
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  if (
    !isJsonSafeValueV1(canonicalArguments, new WeakSet<object>()) ||
    digestCapabilityBindingValueV1(canonicalArguments) !== identity.argumentsDigest ||
    digestCapabilityBindingValueV1(classification.effectiveEffects) !==
      identity.effectiveEffectsDigest
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  const expectedIdempotencyArgument = entry.execution?.idempotencyKeyArgument ?? null;
  const expectedIdempotencyKey = expectedIdempotencyArgument
    ? idempotencyKeyFromPreparedTaskArgumentsV1(canonicalArguments, expectedIdempotencyArgument)
    : null;
  if (
    identity.idempotencyKeyArgument !== expectedIdempotencyArgument ||
    identity.idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }

  assertPrivateTaskFactsV1(prepared, canonicalArguments, entry);
  return entry;
}

function assertPrivateTaskFactsV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  canonicalArguments: RuntimeJsonValueV1,
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
): void {
  const facts = prepared.input.facts;
  if (!isPlainRecordV1(facts)) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }
  let approvalSummary: string;
  try {
    approvalSummary = entry.projectApprovalSummary(canonicalArguments);
  } catch {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }
  const allowedKeys = new Set([
    'schema',
    'toolCallId',
    'callCreatedAtTurnId',
    'modelMessageId',
    'argumentOrigin',
    'dynamicCatalogRevision',
    'approvalSummary',
    'privateTaskProjection',
    'subagentRole',
    'nestedCapabilityId',
    'nestedCapabilityRevision',
    'nestedSkill',
  ]);
  if (
    Object.keys(facts).some((key) => !allowedKeys.has(key)) ||
    facts.schema !== BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1 ||
    facts.toolCallId !== prepared.identity.toolCallId ||
    facts.callCreatedAtTurnId !== prepared.identity.turnId ||
    facts.modelMessageId !== prepared.identity.modelMessageId ||
    facts.argumentOrigin !== 'runtime_private' ||
    facts.dynamicCatalogRevision !== null ||
    facts.privateTaskProjection !== true ||
    facts.nestedCapabilityId !== null ||
    facts.nestedCapabilityRevision !== null ||
    facts.nestedSkill !== null ||
    facts.subagentRole !==
      (isPlainRecordV1(canonicalArguments) ? canonicalArguments.subagent_type : undefined) ||
    facts.approvalSummary !== approvalSummary
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }
}

function idempotencyKeyFromPreparedTaskArgumentsV1(
  argumentsValue: RuntimeJsonValueV1,
  field: string,
): string | null {
  if (!isPlainRecordV1(argumentsValue)) return null;
  const value = argumentsValue[field];
  return typeof value === 'string' ? value : null;
}

function preparedParserRevisionMatchesV1(
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
  parserRevision: string | null,
): boolean {
  if (entry.operationId === 'builtin:task') {
    return (
      parserRevision === entry.parser.parserRevision ||
      parserRevision === entry.modelParser?.parserRevision
    );
  }
  return parserRevision === entry.parser.parserRevision;
}

function nestedIdentityMatchesEntryV1(
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
  identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>,
): boolean {
  const populated =
    identity.nestedCapabilityId !== null ||
    identity.nestedCapabilityRevision !== null ||
    identity.nestedCatalogRevision !== null;
  if (entry.operationId === 'builtin:activate_skill') {
    return (
      identity.nestedCapabilityId !== null &&
      identity.nestedCapabilityRevision !== null &&
      identity.nestedCatalogRevision !== null
    );
  }
  return !populated;
}

function assertSupportedEntryV1(entry: Readonly<BuiltinModelToolCatalogEntryV1>): void {
  if (entry.availability !== 'available') {
    throw new BuiltinPreparedToolDispatchErrorV1('tool_unavailable');
  }
  if (entry.kind === 'interrupt' || entry.executionMechanism === 'user_input') {
    throw new BuiltinPreparedToolDispatchErrorV1('unsupported_operation');
  }
  if (entry.executionMechanism === 'subagent') {
    throw new BuiltinPreparedToolDispatchErrorV1('unsupported_operation');
  }
}

function assertReceiptIdentityV1(
  receipt: Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>,
  entry: Readonly<BuiltinToolCatalogEntryV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): void {
  if (!isRecordObjectV1(receipt)) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
  }
  if (
    receipt.invocationId !== prepared.identity.invocationId ||
    receipt.attemptId !== prepared.identity.attemptId ||
    receipt.providerId !== entry.providerId ||
    receipt.executorRevision !== entry.executorRevision
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('identity_mismatch');
  }
  if (
    receipt.status !== 'succeeded' &&
    receipt.status !== 'failed' &&
    receipt.status !== 'cancelled' &&
    receipt.status !== 'timed_out' &&
    receipt.status !== 'unknown'
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
  }
  if (typeof receipt.requestDigest !== 'string' || receipt.requestDigest.length === 0) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
  }
}

function normalizeBuiltinExecutionValueV1(
  value: RuntimeJsonValueV1 | undefined,
): BuiltinOperationExecutionValueV1 | null {
  if (isBuiltinOperationResultV1(value)) return value;
  if (!isToolSearchExecutionValueV1(value)) return null;
  const searchResult = value.searchResult;
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1' as const,
    ok: true,
    stdout: value.stdout,
    stderr: '',
    resultMeta: Object.freeze({}),
    ...(searchResult
      ? {
          runtimeEvents: Object.freeze([
            Object.freeze({
              type: 'capability.search_completed',
              result: searchResult,
            }),
          ]),
        }
      : {}),
  });
}

function boundedProviderFailureV1(
  failure: unknown,
  status: Exclude<ExecutionReceiptV1['status'], 'succeeded'>,
): Readonly<ClassifiedProviderFailureV1> {
  const record = isPlainRecordV1(failure) ? failure : undefined;
  const code = boundedProviderCodeV1(record?.code, status);
  const message = boundedProviderTextV1(record?.message, defaultReceiptFailureMessageV1(status));
  return Object.freeze({
    code,
    message,
    retryable: record?.retryable === true,
  });
}

function boundedProviderCodeV1(value: unknown, status: string): string {
  if (typeof value !== 'string') return `builtin_${status}`;
  const normalized = value.replace(/[^a-zA-Z0-9_.:-]/gu, '_').slice(0, 128);
  return normalized || `builtin_${status}`;
}

function boundedProviderTextV1(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 2048);
  return normalized || fallback;
}

function defaultReceiptFailureMessageV1(
  status: Exclude<ExecutionReceiptV1['status'], 'succeeded'>,
): string {
  switch (status) {
    case 'failed':
      return 'Builtin capability execution failed.';
    case 'cancelled':
      return 'Builtin capability execution was cancelled.';
    case 'timed_out':
      return 'Builtin capability execution timed out.';
    case 'unknown':
      return 'Builtin capability execution outcome is unknown.';
  }
}

function isRecordObjectV1(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainRecordV1(value);
}

function isPlainRecordV1(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isBuiltinOperationResultV1(value: unknown): value is BuiltinOperationExecutionValueV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record.schema === 'kite.builtin-operation-result.v1' &&
    typeof record.ok === 'boolean' &&
    typeof record.stdout === 'string' &&
    typeof record.stderr === 'string' &&
    isJsonSafeValueV1(value, new WeakSet<object>())
  );
}

function cloneBuiltinOperationValueV1(
  value: BuiltinOperationExecutionValueV1,
): BuiltinOperationExecutionValueV1 {
  const cloned = cloneJsonValueV1(value);
  if (!isBuiltinOperationResultV1(cloned)) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
  }
  return cloned;
}

function cloneJsonValueV1(value: unknown): RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneJsonValueV1(item)));
  }
  if (!isPlainRecordV1(value)) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_result');
  }
  const result: Record<string, RuntimeJsonValueV1> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneJsonValueV1(item);
  }
  return Object.freeze(result);
}

function isJsonSafeValueV1(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonSafeValueV1(value[index], seen)) return false;
      }
      return Reflect.ownKeys(value).every(
        (key) =>
          key === 'length' ||
          (typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key) && Number(key) < value.length),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isJsonSafeValueV1(descriptor.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function assertFrozenProjectionV1(projection: Readonly<BuiltinToolCatalogProjectionV1>): void {
  if (
    !projection ||
    typeof projection !== 'object' ||
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.entries) ||
    !Object.isFrozen(projection.toolSet)
  ) {
    throw new BuiltinPreparedToolDispatchErrorV1('invalid_prepared_input');
  }
}

function isDeepFrozenPreparedV1(
  prepared: Readonly<PreparedToolInvocationV1> | null | undefined,
): prepared is Readonly<PreparedToolInvocationV1> {
  return (
    prepared !== null &&
    typeof prepared === 'object' &&
    isDeepFrozenValueV1(prepared, new WeakSet<object>())
  );
}

function isDeepFrozenValueV1(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
    ) {
      return false;
    }
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor?.enumerable ||
        !('value' in descriptor) ||
        !isDeepFrozenValueV1(descriptor.value, seen)
      ) {
        return false;
      }
    }
    return Reflect.ownKeys(value).every(
      (key) =>
        key === 'length' ||
        (typeof key === 'string' &&
          /^(0|[1-9]\d*)$/u.test(key) &&
          Number(key) < lengthDescriptor.value),
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
    if (!isDeepFrozenValueV1(descriptor.value, seen)) return false;
  }
  return true;
}

function builtinPreparedToolDispatchMessageV1(
  code: BuiltinPreparedToolDispatchFailureCodeV1,
): string {
  switch (code) {
    case 'invalid_prepared_input':
      return 'Builtin prepared input is invalid or not deeply frozen.';
    case 'identity_mismatch':
      return 'Builtin prepared identity does not match the frozen projection.';
    case 'unsupported_operation':
      return 'Builtin operation is outside this dispatch adapter boundary.';
    case 'tool_unavailable':
      return 'Builtin operation is unavailable in the frozen projection.';
    case 'dispatch_unavailable':
      return 'Builtin dispatch port is unavailable.';
    case 'invalid_result':
      return 'Builtin dispatch port returned an invalid operation result.';
  }
}
