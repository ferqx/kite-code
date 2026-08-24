import type {
  CapabilityExecutionMechanism,
  CapabilityToolTerminalResult,
  ClassifiedProviderFailure,
  ExecutionReceipt,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineDispatch,
  ToolPipelinePreparedIdentityVerifier,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from './capability-binding';
import {
  authorizeBuiltinWorkspaceFilesystemTerminalClone,
  bindBuiltinWorkspaceFilesystemClonedTerminal,
} from './filesystem/observation-authority';
import type { BuiltinOperationExecutionValue } from './model/runtime-module';
import type {
  BuiltinInternalOperationCatalogEntry,
  BuiltinModelToolCatalogEntry,
  BuiltinToolCatalogEntry,
  BuiltinToolCatalogProjection,
} from './tool-catalog';
import { BUILTIN_PREPARED_CALL_FACTS_SCHEMA_ } from './tool-pipeline-callbacks';
import { toolExecutionModelContent } from './tool-result-projection';
import { isToolSearchExecutionValue } from './tool-search';

/**
 * The neutral input handed to the App/Host-composed dispatch port.
 *
 * The port receives only the already prepared, canonical request and immutable
 * routing facts. It does not receive a registry, a snapshot, a parser, policy
 * callbacks, or a persistence handle. The App composition owns the concrete
 * mechanism map behind this port.
 */
export interface BuiltinPreparedToolDispatchInput {
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly operationId: string;
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly arguments: RuntimeJsonValue;
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
export interface BuiltinPreparedToolDispatchPort {
  readonly dispatch: (
    input: Readonly<BuiltinPreparedToolDispatchInput>,
  ) => Promise<Readonly<ExecutionReceipt<RuntimeJsonValue>>>;
}

export type BuiltinPreparedToolDispatchFailureCode =
  | 'invalid_prepared_input'
  | 'identity_mismatch'
  | 'unsupported_operation'
  | 'tool_unavailable'
  | 'dispatch_unavailable'
  | 'invalid_result';

/** Bounded, package-local error; no Provider/Host diagnostic crosses it. */
export class BuiltinPreparedToolDispatchError extends Error {
  readonly code: BuiltinPreparedToolDispatchFailureCode;

  constructor(code: BuiltinPreparedToolDispatchFailureCode) {
    super(builtinPreparedToolDispatchMessage(code));
    this.name = 'BuiltinPreparedToolDispatchError';
    this.code = code;
  }
}

export interface CreateBuiltinPreparedToolDispatchAdapterInput {
  /** The exact frozen projection captured by the App composition root. */
  readonly projection: Readonly<BuiltinToolCatalogProjection>;
  /** Must be the verifier supplied by the exact projection callback bundle. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier;
  /** The sole injected mechanism/dispatch port for this adapter instance. */
  readonly port: BuiltinPreparedToolDispatchPort;
}

/**
 * A Host-compatible Builtin dispatch callback bundle.
 *
 * `verifyPreparedIdentity` is returned by reference so the Host coordinator
 * invokes the exact Builtin callback once. The Host owns authenticity,
 * acknowledgement ordering, and exact-once claim; this adapter owns only
 * mechanical projection-entry and operation-boundary checks.
 */
export type BuiltinPreparedToolDispatchAdapter = ToolPipelineDispatch<
  RuntimeJsonValue,
  BuiltinOperationExecutionValue
>;

export function createBuiltinPreparedToolDispatchAdapter(
  input: CreateBuiltinPreparedToolDispatchAdapterInput,
): BuiltinPreparedToolDispatchAdapter {
  assertFrozenProjection(input.projection);
  if (!input.port || typeof input.port.dispatch !== 'function') {
    throw new BuiltinPreparedToolDispatchError('dispatch_unavailable');
  }
  if (typeof input.verifyPreparedIdentity !== 'function') {
    throw new BuiltinPreparedToolDispatchError('invalid_prepared_input');
  }

  const verifyPreparedIdentity = input.verifyPreparedIdentity;

  const dispatch = async (
    prepared: Readonly<PreparedToolInvocation<RuntimeJsonValue, RuntimeJsonValue>>,
  ): Promise<Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>> => {
    if (!isDeepFrozenPrepared(prepared)) {
      throw new BuiltinPreparedToolDispatchError('invalid_prepared_input');
    }

    const entry = exactModelEntryForPrepared(input.projection, prepared);
    assertSupportedEntry(entry);

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
    assertReceiptIdentity(receipt, entry, prepared);
    return projectBuiltinExecutionReceiptTerminalResultForEntry(receipt, entry, prepared);
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
export interface CreateBuiltinPreparedTaskDispatchAdapterInput {
  /** The one frozen Builtin catalog projection captured by App composition. */
  readonly projection: Readonly<BuiltinToolCatalogProjection>;
  /** Retained by reference for the Host coordinator's exact identity check. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier;
  /** The sole supplied port for the already admitted Builtin operation. */
  readonly port: BuiltinPreparedToolDispatchPort;
}

export type BuiltinPreparedTaskDispatchAdapter = ToolPipelineDispatch<
  RuntimeJsonValue,
  BuiltinOperationExecutionValue
>;

/**
 * Build the Builtin-only prepared dispatch callback for `builtin:task`.
 *
 * The operation is a model-visible subagent operation, but this callback only
 * accepts the private runtime parser projection. Public model arguments,
 * missing/invalid task artifacts, the model parser revision, and any drift in
 * the frozen task entry are rejected before the injected port is reached.
 */
export function createBuiltinPreparedTaskDispatchAdapter(
  input: CreateBuiltinPreparedTaskDispatchAdapterInput,
): BuiltinPreparedTaskDispatchAdapter {
  assertFrozenProjection(input.projection);
  if (!input.port || typeof input.port.dispatch !== 'function') {
    throw new BuiltinPreparedToolDispatchError('dispatch_unavailable');
  }
  if (typeof input.verifyPreparedIdentity !== 'function') {
    throw new BuiltinPreparedToolDispatchError('invalid_prepared_input');
  }

  const verifyPreparedIdentity = input.verifyPreparedIdentity;
  const dispatch = async (
    prepared: Readonly<PreparedToolInvocation<RuntimeJsonValue, RuntimeJsonValue>>,
  ): Promise<Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>> => {
    const entry = exactPrivateTaskEntryForPrepared(input.projection, prepared);
    const receipt = await input.port.dispatch(
      Object.freeze({
        prepared,
        operationId: entry.operationId,
        executionMechanism: entry.executionMechanism,
        arguments: prepared.input.arguments,
      }),
    );
    assertReceiptIdentity(receipt, entry, prepared);
    return projectBuiltinExecutionReceiptTerminalResultForEntry(receipt, entry, prepared);
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
export function projectBuiltinOperationTerminalResult(
  value: BuiltinOperationExecutionValue,
): Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>> {
  return projectBuiltinOperationTerminalResultForEntry(value);
}

/**
 * Project a Builtin operation result with the exact kind of the frozen
 * projection entry that produced it. Coordination/runtime-action operations
 * use the existing `rejected` terminal vocabulary for a valid domain value
 * with `ok: false`; the standalone projector above intentionally has no entry
 * context and retains its historical `builtin_operation_failed` behavior.
 */
function projectBuiltinOperationTerminalResultForEntry(
  value: BuiltinOperationExecutionValue,
  entryKind?: BuiltinModelToolCatalogEntry['kind'],
): Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>> {
  if (!isBuiltinOperationResult(value)) {
    throw new BuiltinPreparedToolDispatchError('invalid_result');
  }

  const text = toolExecutionModelContent(value);
  const structuredContent = cloneBuiltinOperationValue(value);
  const subagentResult = isRecordObject(value.subagentResult) ? value.subagentResult : undefined;
  const failedSubagentExecution = subagentResult?.terminalStatus === 'failed';
  const content: readonly RuntimeJsonValue[] =
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
      !failedSubagentExecution &&
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
export function projectBuiltinExecutionReceiptTerminalResult(
  receipt: Readonly<ExecutionReceipt<RuntimeJsonValue>>,
): Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>> {
  return projectBuiltinExecutionReceiptTerminalResultForEntry(receipt);
}

/**
 * Project the confirmed Provider receipt for the private dynamic-MCP wrapper.
 *
 * The operation context is explicit so a generic failed receipt cannot acquire
 * MCP provider semantics. The exact frozen prepared identity and wrapper entry
 * must agree before a canonical provider-failure value is emitted.
 */
export function projectBuiltinDynamicMcpExecutionReceiptTerminalResult(
  receipt: Readonly<ExecutionReceipt<RuntimeJsonValue>>,
  entry: Readonly<BuiltinInternalOperationCatalogEntry>,
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>> {
  assertDynamicMcpProjectionContext(entry, prepared);
  assertReceiptIdentity(receipt, entry, prepared);
  return projectBuiltinExecutionReceiptTerminalResultForEntry(receipt, entry, prepared);
}

function projectBuiltinExecutionReceiptTerminalResultForEntry(
  receipt: Readonly<ExecutionReceipt<RuntimeJsonValue>>,
  entry?: Readonly<BuiltinToolCatalogEntry>,
  prepared?: Readonly<PreparedToolInvocation>,
): Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>> {
  if (receipt.status === 'succeeded') {
    const value = normalizeBuiltinExecutionValue(receipt.value);
    if (!value) {
      throw new BuiltinPreparedToolDispatchError('invalid_result');
    }
    const cloneAuthorization =
      entry && prepared
        ? authorizeBuiltinWorkspaceFilesystemTerminalClone({ prepared, value })
        : null;
    const terminal = projectBuiltinOperationTerminalResultForEntry(value, entry?.kind);
    if (cloneAuthorization && prepared) {
      bindBuiltinWorkspaceFilesystemClonedTerminal({
        authorization: cloneAuthorization,
        prepared,
        terminal,
      });
    }
    return terminal;
  }

  const providerFailure = boundedProviderFailure(receipt.failure, receipt.status);
  const structuredContent = confirmedProviderFailureValue(entry, providerFailure);
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

function confirmedProviderFailureValue(
  entry: Readonly<BuiltinToolCatalogEntry> | undefined,
  failure: Readonly<ClassifiedProviderFailure>,
): BuiltinOperationExecutionValue | undefined {
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
  }) as BuiltinOperationExecutionValue;
}

function assertDynamicMcpProjectionContext(
  entry: Readonly<BuiltinInternalOperationCatalogEntry>,
  prepared: Readonly<PreparedToolInvocation>,
): void {
  if (!Object.isFrozen(entry) || !isDeepFrozenPrepared(prepared)) {
    throw new BuiltinPreparedToolDispatchError('invalid_prepared_input');
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
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }
}

function exactModelEntryForPrepared(
  projection: Readonly<BuiltinToolCatalogProjection>,
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<BuiltinModelToolCatalogEntry> {
  const identity = prepared.identity;
  if (identity.isDynamicMcp || identity.operationId === 'mcp:dynamic_tool') {
    throw new BuiltinPreparedToolDispatchError('unsupported_operation');
  }
  if (identity.builtinProjectionRevision !== projection.revision) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.operationId === identity.operationId,
  );
  if (!entry) throw new BuiltinPreparedToolDispatchError('unsupported_operation');
  if (
    entry.name !== identity.exposedToolName ||
    entry.capabilityId !== identity.capabilityId ||
    entry.providerId !== identity.providerId ||
    entry.revision !== identity.capabilityRevision ||
    entry.executorRevision !== identity.executorRevision ||
    entry.descriptor.revision !== identity.descriptorRevision ||
    !preparedParserRevisionMatches(entry, identity.parserRevision) ||
    entry.executionMechanism !== identity.executionMechanism ||
    !nestedIdentityMatchesEntry(entry, identity)
  ) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }
  return entry;
}

/**
 * Validate the private Task packet without taking ownership of Task runtime
 * semantics. This is deliberately stricter than the ordinary Builtin entry
 * lookup: the ordinary route may recognize the public Task parser, while this
 * route accepts only the runtime parser and a complete private artifact.
 */
function exactPrivateTaskEntryForPrepared(
  projection: Readonly<BuiltinToolCatalogProjection>,
  prepared: Readonly<PreparedToolInvocation>,
): Readonly<BuiltinModelToolCatalogEntry> {
  if (!isDeepFrozenPrepared(prepared)) {
    throw new BuiltinPreparedToolDispatchError('invalid_prepared_input');
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
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.operationId === 'builtin:task',
  );
  if (!entry) {
    throw new BuiltinPreparedToolDispatchError('unsupported_operation');
  }
  if (
    entry.kind !== 'coordination' ||
    entry.executionMechanism !== 'subagent' ||
    entry.availability !== 'available'
  ) {
    throw new BuiltinPreparedToolDispatchError('tool_unavailable');
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
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  const argumentsValue = prepared.input.arguments;
  if (!isPlainRecord(argumentsValue) || !Object.hasOwn(argumentsValue, 'taskArtifact')) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  let canonicalArguments: RuntimeJsonValue;
  let classification: ReturnType<BuiltinModelToolCatalogEntry['classifyEffects']>;
  try {
    const parsed = entry.parse(argumentsValue);
    if (!parsed.success) {
      throw new Error('Builtin Task runtime parser rejected the private artifact.');
    }
    canonicalArguments = entry.parser.canonicalize(parsed.data);
    classification = entry.classifyEffects(canonicalArguments);
  } catch (error) {
    if (error instanceof BuiltinPreparedToolDispatchError) {
      throw new BuiltinPreparedToolDispatchError('identity_mismatch');
    }
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  if (
    !isJsonSafeValue(canonicalArguments, new WeakSet<object>()) ||
    digestCapabilityBindingValue(canonicalArguments) !== identity.argumentsDigest ||
    digestCapabilityBindingValue(classification.effectiveEffects) !==
      identity.effectiveEffectsDigest
  ) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  const expectedIdempotencyArgument = entry.execution?.idempotencyKeyArgument ?? null;
  const expectedIdempotencyKey = expectedIdempotencyArgument
    ? idempotencyKeyFromPreparedTaskArguments(canonicalArguments, expectedIdempotencyArgument)
    : null;
  if (
    identity.idempotencyKeyArgument !== expectedIdempotencyArgument ||
    identity.idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }

  assertPrivateTaskFacts(prepared, canonicalArguments, entry);
  return entry;
}

function assertPrivateTaskFacts(
  prepared: Readonly<PreparedToolInvocation>,
  canonicalArguments: RuntimeJsonValue,
  entry: Readonly<BuiltinModelToolCatalogEntry>,
): void {
  const facts = prepared.input.facts;
  if (!isPlainRecord(facts)) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }
  let approvalSummary: string;
  try {
    approvalSummary = entry.projectApprovalSummary(canonicalArguments);
  } catch {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
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
    facts.schema !== BUILTIN_PREPARED_CALL_FACTS_SCHEMA_ ||
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
      (isPlainRecord(canonicalArguments) ? canonicalArguments.subagent_type : undefined) ||
    facts.approvalSummary !== approvalSummary
  ) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }
}

function idempotencyKeyFromPreparedTaskArguments(
  argumentsValue: RuntimeJsonValue,
  field: string,
): string | null {
  if (!isPlainRecord(argumentsValue)) return null;
  const value = argumentsValue[field];
  return typeof value === 'string' ? value : null;
}

function preparedParserRevisionMatches(
  entry: Readonly<BuiltinModelToolCatalogEntry>,
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

function nestedIdentityMatchesEntry(
  entry: Readonly<BuiltinModelToolCatalogEntry>,
  identity: Readonly<NonDynamicPreparedToolInvocationIdentity>,
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

function assertSupportedEntry(entry: Readonly<BuiltinModelToolCatalogEntry>): void {
  if (entry.availability !== 'available') {
    throw new BuiltinPreparedToolDispatchError('tool_unavailable');
  }
  if (entry.kind === 'interrupt' || entry.executionMechanism === 'user_input') {
    throw new BuiltinPreparedToolDispatchError('unsupported_operation');
  }
  if (entry.executionMechanism === 'subagent') {
    throw new BuiltinPreparedToolDispatchError('unsupported_operation');
  }
}

function assertReceiptIdentity(
  receipt: Readonly<ExecutionReceipt<RuntimeJsonValue>>,
  entry: Readonly<BuiltinToolCatalogEntry>,
  prepared: Readonly<PreparedToolInvocation>,
): void {
  if (!isRecordObject(receipt)) {
    throw new BuiltinPreparedToolDispatchError('invalid_result');
  }
  if (
    receipt.invocationId !== prepared.identity.invocationId ||
    receipt.attemptId !== prepared.identity.attemptId ||
    receipt.providerId !== entry.providerId ||
    receipt.executorRevision !== entry.executorRevision
  ) {
    throw new BuiltinPreparedToolDispatchError('identity_mismatch');
  }
  if (
    receipt.status !== 'succeeded' &&
    receipt.status !== 'failed' &&
    receipt.status !== 'cancelled' &&
    receipt.status !== 'timed_out' &&
    receipt.status !== 'unknown'
  ) {
    throw new BuiltinPreparedToolDispatchError('invalid_result');
  }
  if (typeof receipt.requestDigest !== 'string' || receipt.requestDigest.length === 0) {
    throw new BuiltinPreparedToolDispatchError('invalid_result');
  }
}

function normalizeBuiltinExecutionValue(
  value: RuntimeJsonValue | undefined,
): BuiltinOperationExecutionValue | null {
  if (isBuiltinOperationResult(value)) return value;
  if (!isToolSearchExecutionValue(value)) return null;
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

function boundedProviderFailure(
  failure: unknown,
  status: Exclude<ExecutionReceipt['status'], 'succeeded'>,
): Readonly<ClassifiedProviderFailure> {
  const record = isPlainRecord(failure) ? failure : undefined;
  const code = boundedProviderCode(record?.code, status);
  const message = boundedProviderText(record?.message, defaultReceiptFailureMessage(status));
  return Object.freeze({
    code,
    message,
    retryable: record?.retryable === true,
  });
}

function boundedProviderCode(value: unknown, status: string): string {
  if (typeof value !== 'string') return `builtin_${status}`;
  const normalized = value.replace(/[^a-zA-Z0-9_.:-]/gu, '_').slice(0, 128);
  return normalized || `builtin_${status}`;
}

function boundedProviderText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 2048);
  return normalized || fallback;
}

function defaultReceiptFailureMessage(
  status: Exclude<ExecutionReceipt['status'], 'succeeded'>,
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

function isRecordObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainRecord(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isBuiltinOperationResult(value: unknown): value is BuiltinOperationExecutionValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record.schema === 'kite.builtin-operation-result.v1' &&
    typeof record.ok === 'boolean' &&
    typeof record.stdout === 'string' &&
    typeof record.stderr === 'string' &&
    isJsonSafeValue(value, new WeakSet<object>())
  );
}

function cloneBuiltinOperationValue(
  value: BuiltinOperationExecutionValue,
): BuiltinOperationExecutionValue {
  const cloned = cloneJsonValue(value);
  if (!isBuiltinOperationResult(cloned)) {
    throw new BuiltinPreparedToolDispatchError('invalid_result');
  }
  return cloned;
}

function cloneJsonValue(value: unknown): RuntimeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneJsonValue(item)));
  }
  if (!isPlainRecord(value)) {
    throw new BuiltinPreparedToolDispatchError('invalid_result');
  }
  const result: Record<string, RuntimeJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneJsonValue(item);
  }
  return Object.freeze(result);
}

function isJsonSafeValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonSafeValue(value[index], seen)) return false;
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
      if (!isJsonSafeValue(descriptor.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function assertFrozenProjection(projection: Readonly<BuiltinToolCatalogProjection>): void {
  if (
    !projection ||
    typeof projection !== 'object' ||
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.entries) ||
    !Object.isFrozen(projection.toolSet)
  ) {
    throw new BuiltinPreparedToolDispatchError('invalid_prepared_input');
  }
}

function isDeepFrozenPrepared(
  prepared: Readonly<PreparedToolInvocation> | null | undefined,
): prepared is Readonly<PreparedToolInvocation> {
  return (
    prepared !== null &&
    typeof prepared === 'object' &&
    isDeepFrozenValue(prepared, new WeakSet<object>())
  );
}

function isDeepFrozenValue(value: unknown, seen: WeakSet<object>): boolean {
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
        !isDeepFrozenValue(descriptor.value, seen)
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
    if (!isDeepFrozenValue(descriptor.value, seen)) return false;
  }
  return true;
}

function builtinPreparedToolDispatchMessage(code: BuiltinPreparedToolDispatchFailureCode): string {
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
