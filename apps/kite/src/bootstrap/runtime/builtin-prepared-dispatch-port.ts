import {
  type BuiltinInternalOperationCatalogEntry,
  type BuiltinMechanismRecord,
  type BuiltinModelToolCatalogEntry,
  type BuiltinOperationExecutionValue,
  type BuiltinPreparedToolDispatchInput,
  type BuiltinPreparedToolDispatchPort,
  type BuiltinToolCatalogProjection,
  createCapabilityBinding,
  digestCapabilityValue,
  mergeBuiltinMechanismBundle,
  projectBuiltinDynamicMcpExecutionReceiptTerminalResult,
} from '#builtin-runtime';
import type {
  CapabilityBinding,
  CapabilityExecutionInvocation,
  CapabilityExecutionMechanism,
  CapabilityExecutionPort,
  CapabilityToolTerminalResult,
  DynamicMcpPreparedToolInvocationIdentity,
  ExecutionEnvironmentRef,
  ExecutionGrant,
  ExecutionReceipt,
  ExecutionRequest,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineDispatch,
  ToolPipelinePreparedIdentityVerifier,
} from '#runtime-spi';
import {
  APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
  type AppPreparedToolInvocationPacket,
  type AppToolPipelinePreparedRequest,
} from './tool-pipeline-prepared';

type AppBuiltinPreparedPacket = Readonly<AppPreparedToolInvocationPacket<RuntimeJsonValue>>;

export const APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_ =
  'kite.app.builtin-prepared-dispatch-port.v1' as const;

export interface AppBuiltinPreparedMechanismResolverInput {
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly operationId: string;
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly signal: AbortSignal;
}

/**
 * The App supplies exactly one already-composed mechanism map. This resolver
 * never owns a registry, executor, or Host execution port.
 */
export type AppBuiltinPreparedMechanismResolver = (
  input: Readonly<AppBuiltinPreparedMechanismResolverInput>,
) => BuiltinMechanismRecord;

export interface CreateAppBuiltinPreparedDispatchPortInput {
  /** The same frozen turn projection that produced the prepared identity. */
  readonly projection: Readonly<BuiltinToolCatalogProjection>;
  /** The one supplied Host registry execution port. */
  readonly capabilityExecution: CapabilityExecutionPort;
  /** One App-composed mechanism resolver for this bridge. */
  readonly resolveMechanisms: AppBuiltinPreparedMechanismResolver;
  /** The invocation-scoped cancellation signal. */
  readonly signal: AbortSignal;
}

export interface CreateAppDynamicMcpPreparedDispatchAdapterInput
  extends CreateAppBuiltinPreparedDispatchPortInput {
  /** The verifier from the same Builtin callback bundle as the projection. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier;
}

export interface AppBuiltinPreparedDispatchPort extends BuiltinPreparedToolDispatchPort {
  readonly schema: typeof APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_;
}

/**
 * App-side dynamic-MCP adapter.  The Builtin package deliberately rejects
 * dynamic identities from its model-visible adapter; this bridge handles the
 * private `mcp:dynamic_tool` wrapper while preserving the real subject binding
 * and dynamic catalog revision in the prepared identity.  It enters the
 * frozen projection exactly once and only through the supplied Host port.
 */
export function createAppDynamicMcpPreparedDispatchAdapter(
  input: CreateAppDynamicMcpPreparedDispatchAdapterInput,
): ToolPipelineDispatch<RuntimeJsonValue, BuiltinOperationExecutionValue> {
  assertCompositionInput(input);
  assertFrozenProjection(input.projection);
  const verifyPreparedIdentity = input.verifyPreparedIdentity;
  const dispatch = async (
    prepared: Readonly<PreparedToolInvocation<RuntimeJsonValue, RuntimeJsonValue>>,
  ): Promise<Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>> => {
    assertDeepFrozenPrepared(prepared);
    const identity = prepared.identity;
    if (!isDynamicIdentity(identity)) {
      throw new AppBuiltinPreparedDispatchPortError('unsupported_operation');
    }
    const entry = exactDynamicWrapperEntry(input.projection, identity);
    const binding = dynamicWrapperBinding(entry, identity.turnId);
    const mechanisms = input.resolveMechanisms({
      prepared,
      operationId: entry.operationId,
      executionMechanism: entry.executionMechanism,
      signal: input.signal,
    });
    const invocation = createDynamicInvocation(
      prepared,
      identity,
      entry,
      binding,
      mechanisms,
      input.signal,
    );
    const receipt = await input.projection.dispatch(
      entry.operationId,
      input.capabilityExecution,
      invocation,
    );
    assertDynamicReceiptIdentity(receipt, entry, prepared);
    return projectBuiltinDynamicMcpExecutionReceiptTerminalResult(receipt, entry, prepared);
  };
  return Object.freeze({ verifyPreparedIdentity, dispatch });
}

export type AppBuiltinPreparedDispatchFailureCode =
  | 'invalid_prepared_input'
  | 'projection_identity_mismatch'
  | 'request_envelope_invalid'
  | 'binding_mismatch'
  | 'unsupported_operation'
  | 'mechanism_unavailable'
  | 'execution_port_unavailable';

export class AppBuiltinPreparedDispatchPortError extends Error {
  readonly code: AppBuiltinPreparedDispatchFailureCode;

  constructor(code: AppBuiltinPreparedDispatchFailureCode) {
    super(appBuiltinPreparedDispatchPortMessage(code));
    this.name = 'AppBuiltinPreparedDispatchPortError';
    this.code = code;
  }
}

/**
 * Compose the only ordinary Builtin bridge. The returned callback constructs
 * one invocation envelope and enters the Builtin projection exactly once;
 * it never calls the supplied Host port directly or selects a fallback.
 */
export function createAppBuiltinPreparedDispatchPort(
  input: CreateAppBuiltinPreparedDispatchPortInput,
): AppBuiltinPreparedDispatchPort {
  assertCompositionInput(input);
  assertFrozenProjection(input.projection);

  const dispatch = async (
    dispatchInput: Readonly<BuiltinPreparedToolDispatchInput>,
  ): Promise<Readonly<ExecutionReceipt<RuntimeJsonValue>>> => {
    const prepared = dispatchInput.prepared;
    assertDeepFrozenPrepared(prepared);
    if (
      dispatchInput.operationId !== prepared.identity.operationId ||
      dispatchInput.executionMechanism !== prepared.identity.executionMechanism ||
      dispatchInput.arguments !== prepared.input.arguments
    ) {
      throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
    }
    if (!isAppBuiltinPreparedPacket(prepared)) {
      throw new AppBuiltinPreparedDispatchPortError('request_envelope_invalid');
    }
    const request = prepared.input.request;
    assertRequestEnvelope(request);

    const entry = exactOrdinaryEntry(input.projection, prepared);
    if (!isOrdinaryIdentity(prepared.identity)) {
      throw new AppBuiltinPreparedDispatchPortError('unsupported_operation');
    }
    const binding = exactBinding(entry, prepared);
    const executionFacts = executionRequestFacts(
      prepared.identity.toolCallId,
      request.capabilityRequestFacts,
    );
    const mechanisms = resolveExactMechanisms(input, prepared, entry);
    const authority = grantAuthority(entry, prepared.identity, request);
    const invocation = createInvocation(
      prepared,
      entry,
      binding,
      executionFacts,
      authority,
      mechanisms,
      input.signal,
    );

    // This is the sole execution entry. The supplied Host port is passed to
    // the frozen Builtin projection; no direct invoke/fallback path exists.
    const receipt = await input.projection.dispatch(
      entry.operationId,
      input.capabilityExecution,
      invocation,
    );
    if (!isBuiltinExecutionReceipt(receipt)) {
      throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
    }
    return receipt;
  };

  return Object.freeze({
    schema: APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_,
    dispatch,
  });
}

/**
 * Compose the dedicated private Task bridge.  Task is intentionally separate
 * from the ordinary adapter: the Builtin adapter has already proved the
 * runtime-private parser/artifact facts, while this App bridge only materializes
 * the exact registry invocation and enters the same frozen projection/Host
 * port.  It does not create a child runtime, continuation, reviewer, or Store.
 */
export function createAppBuiltinPreparedTaskDispatchPort(
  input: CreateAppBuiltinPreparedDispatchPortInput,
): AppBuiltinPreparedDispatchPort {
  assertCompositionInput(input);
  assertFrozenProjection(input.projection);

  const dispatch = async (
    dispatchInput: Readonly<BuiltinPreparedToolDispatchInput>,
  ): Promise<Readonly<ExecutionReceipt<RuntimeJsonValue>>> => {
    const prepared = dispatchInput.prepared;
    assertDeepFrozenPrepared(prepared);
    const identity = prepared.identity;
    if (
      identity.isDynamicMcp ||
      identity.operationId !== 'builtin:task' ||
      identity.executionFamily !== 'subagent' ||
      identity.executionMechanism !== 'subagent' ||
      identity.argumentOrigin !== 'runtime_private' ||
      identity.exposedToolName !== 'task' ||
      identity.builtinProjectionRevision !== input.projection.revision ||
      identity.dynamicCatalogRevision !== null ||
      identity.bindingId !== null ||
      prepared.input.binding !== null ||
      dispatchInput.operationId !== identity.operationId ||
      dispatchInput.executionMechanism !== identity.executionMechanism ||
      dispatchInput.arguments !== prepared.input.arguments ||
      prepared.input.invocationId !== identity.invocationId ||
      prepared.input.attemptId !== identity.attemptId ||
      prepared.input.toolCallId !== identity.toolCallId
    ) {
      throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
    }
    const entry = input.projection.entries.find(
      (candidate): candidate is BuiltinModelToolCatalogEntry =>
        candidate.visibility === 'model' && candidate.operationId === 'builtin:task',
    );
    if (
      entry?.kind !== 'coordination' ||
      entry.executionMechanism !== 'subagent' ||
      entry.availability !== 'available' ||
      identity.capabilityId !== entry.capabilityId ||
      identity.capabilityRevision !== entry.revision ||
      identity.providerId !== entry.providerId ||
      identity.executorRevision !== entry.executorRevision ||
      identity.descriptorRevision !== entry.descriptor.revision ||
      identity.parserRevision !== entry.parser.parserRevision ||
      identity.schemaDigest !== entry.parser.schemaDigest ||
      identity.toolKind !== entry.kind
    ) {
      throw new AppBuiltinPreparedDispatchPortError(
        entry?.availability !== 'available'
          ? 'unsupported_operation'
          : 'projection_identity_mismatch',
      );
    }
    assertRequestEnvelope(prepared.input.request as Readonly<AppToolPipelinePreparedRequest>);
    const binding = exactBinding(entry, prepared as AppBuiltinPreparedPacket);
    const request = prepared.input.request as Readonly<AppToolPipelinePreparedRequest>;
    const executionFacts = executionRequestFacts(
      identity.toolCallId,
      request.capabilityRequestFacts,
    );
    const mechanisms = resolveExactMechanisms(input, prepared as AppBuiltinPreparedPacket, entry);
    const authority = grantAuthority(entry, identity, request);
    const invocation = createInvocation(
      prepared as AppBuiltinPreparedPacket,
      entry,
      binding,
      executionFacts,
      authority,
      mechanisms,
      input.signal,
    );
    const receipt = await input.projection.dispatch(
      entry.operationId,
      input.capabilityExecution,
      invocation,
    );
    if (!isBuiltinExecutionReceipt(receipt)) {
      throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
    }
    return receipt;
  };

  return Object.freeze({
    schema: APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_,
    dispatch,
  });
}

function exactDynamicWrapperEntry(
  projection: Readonly<BuiltinToolCatalogProjection>,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentity>,
): Readonly<BuiltinInternalOperationCatalogEntry> {
  if (identity.runtimeWrapper.builtinProjectionRevision !== projection.revision) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
  const matches = projection.entries.filter(
    (entry): entry is BuiltinInternalOperationCatalogEntry =>
      entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool',
  );
  if (matches.length !== 1) {
    throw new AppBuiltinPreparedDispatchPortError('unsupported_operation');
  }
  const entry = matches[0]!;
  const expectedSchemaDigest = digestCapabilityValue(entry.inputSchema ?? {});
  const wrapper = identity.runtimeWrapper;
  if (
    entry.availability !== 'available' ||
    entry.executionMechanism !== 'mcp' ||
    entry.kind !== 'internal_runtime' ||
    !entry.inputSchema ||
    entry.capabilityId !== 'mcp:dynamic_tool' ||
    entry.providerId !== wrapper.providerId ||
    entry.revision !== wrapper.capabilityRevision ||
    entry.executorRevision !== wrapper.executorRevision ||
    expectedSchemaDigest !== wrapper.schemaDigest ||
    entry.descriptor.revision !== entry.revision ||
    wrapper.operationId !== entry.operationId ||
    wrapper.capabilityId !== entry.capabilityId
  ) {
    throw new AppBuiltinPreparedDispatchPortError(
      entry.availability !== 'available' ? 'unsupported_operation' : 'projection_identity_mismatch',
    );
  }
  return entry;
}

function dynamicWrapperBinding(
  entry: Readonly<BuiltinInternalOperationCatalogEntry>,
  turnId: string,
): CapabilityBinding {
  if (!entry.inputSchema) {
    throw new AppBuiltinPreparedDispatchPortError('binding_mismatch');
  }
  return createCapabilityBinding({
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    exposedToolName: entry.operationId,
    inputSchema: entry.inputSchema,
    turnId,
  });
}

function createDynamicInvocation(
  prepared: Readonly<PreparedToolInvocation>,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentity>,
  entry: Readonly<BuiltinInternalOperationCatalogEntry>,
  binding: CapabilityBinding,
  mechanisms: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): CapabilityExecutionInvocation {
  if (!isPlainRecord(prepared.input.arguments)) {
    throw new AppBuiltinPreparedDispatchPortError('request_envelope_invalid');
  }
  if (
    !identity.subject.capabilityId ||
    !identity.subject.capabilityRevision ||
    identity.subject.exposedToolName.length <= 'mcp__'.length
  ) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
  const request = isRequestEnvelopeShape(prepared.input.request)
    ? prepared.input.request
    : undefined;
  if (!request) {
    throw new AppBuiltinPreparedDispatchPortError('request_envelope_invalid');
  }
  const authority = dynamicGrantAuthority(identity, entry, request);
  const generatedIdempotencyKey =
    identity.idempotencyKeyArgument && identity.idempotencyKey === null
      ? digestCapabilityValue({
          schema: 'kite.tool-idempotency-key.v1',
          invocationId: identity.invocationId,
          capabilityId: identity.subject.capabilityId,
        })
      : identity.idempotencyKey;
  const subjectArguments =
    identity.idempotencyKeyArgument && generatedIdempotencyKey
      ? Object.freeze({
          ...(prepared.input.arguments as Readonly<Record<string, RuntimeJsonValue>>),
          [identity.idempotencyKeyArgument]: generatedIdempotencyKey,
        })
      : prepared.input.arguments;
  const wrapperArguments = Object.freeze({
    capability_id: identity.subject.capabilityId,
    capability_revision: identity.subject.capabilityRevision,
    arguments: subjectArguments,
  }) as RuntimeJsonValue;
  const executionRequest: ExecutionRequest = Object.freeze({
    invocationId: identity.invocationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    input: wrapperArguments,
    facts: Object.freeze({
      toolCallId: identity.toolCallId,
      subjectCapabilityId: identity.subject.capabilityId,
      subjectCapabilityRevision: identity.subject.capabilityRevision,
      subjectBindingId: identity.subject.bindingId,
      dynamicCatalogRevision: identity.dynamicCatalogRevision,
    }),
  });
  const grant: ExecutionGrant = Object.freeze({
    grantId: digestCapabilityValue({
      schema: 'kite.app.dynamic-mcp-prepared-grant.v1',
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      authority,
    }),
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    authority,
  });
  const environment: ExecutionEnvironmentRef = Object.freeze({
    environmentId: digestCapabilityValue({
      schema: 'kite.app.dynamic-mcp-prepared-environment.v1',
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      operationId: entry.operationId,
    }),
    kind: 'kite-builtin-prepared',
    mechanisms,
  });
  return Object.freeze({
    binding,
    request: executionRequest,
    grant,
    // The dynamic callback identity is the subject's canonical argument
    // digest; the internal wrapper envelope is transport-only.
    requestDigest: identity.argumentsDigest,
    environment,
    attempt: Object.freeze({
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
    }),
    signal,
  });
}

function dynamicGrantAuthority(
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentity>,
  entry: Readonly<BuiltinInternalOperationCatalogEntry>,
  request: Readonly<AppToolPipelinePreparedRequest> | undefined,
): Readonly<Record<string, RuntimeJsonValue>> {
  if (
    identity.policyDigest === null ||
    identity.authorizationDigest === null ||
    identity.admissionDigest === null
  ) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
  return Object.freeze({
    schema: 'kite.app.dynamic-mcp-prepared-grant.v1',
    operationId: entry.operationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    providerId: entry.providerId,
    executorRevision: entry.executorRevision,
    policyDigest: identity.policyDigest,
    authorizationDigest: identity.authorizationDigest,
    admissionDigest: identity.admissionDigest,
    authorizationKind: request?.authorizationKind ?? 'policy_allow',
    grantUsed: request?.grantUsed ?? 'none',
    subjectCapabilityId: identity.subject.capabilityId,
    subjectCapabilityRevision: identity.subject.capabilityRevision,
    subjectBindingId: identity.subject.bindingId,
    subjectProviderId: identity.subject.providerId,
    dynamicCatalogRevision: identity.dynamicCatalogRevision,
    subjectEffectsDigest: identity.effectiveEffectsDigest,
  });
}

function isDynamicIdentity(
  identity: Readonly<PreparedToolInvocation['identity']>,
): identity is Readonly<DynamicMcpPreparedToolInvocationIdentity> {
  return (
    identity.isDynamicMcp === true &&
    identity.executionFamily === 'mcp' &&
    identity.executionMechanism === 'mcp' &&
    identity.operationId === 'mcp:dynamic_tool' &&
    identity.visibility === 'internal' &&
    identity.modelVisible === false &&
    identity.exposedToolName === null &&
    identity.builtinProjectionRevision === null &&
    identity.executorRevision === null &&
    identity.dynamicCatalogRevision.length > 0 &&
    identity.subject.exposedToolName.startsWith('mcp__') &&
    identity.runtimeWrapper.operationId === 'mcp:dynamic_tool'
  );
}

function assertDynamicReceiptIdentity(
  receipt: Readonly<ExecutionReceipt<RuntimeJsonValue>>,
  entry: Readonly<BuiltinInternalOperationCatalogEntry>,
  prepared: Readonly<PreparedToolInvocation>,
): void {
  if (
    receipt.invocationId !== prepared.identity.invocationId ||
    receipt.attemptId !== prepared.identity.attemptId ||
    receipt.providerId !== entry.providerId ||
    receipt.executorRevision !== entry.executorRevision ||
    typeof receipt.requestDigest !== 'string' ||
    receipt.requestDigest !== prepared.identity.argumentsDigest
  ) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
}

function exactOrdinaryEntry(
  projection: Readonly<BuiltinToolCatalogProjection>,
  prepared: AppBuiltinPreparedPacket,
): Readonly<BuiltinModelToolCatalogEntry> {
  const identity = prepared.identity;
  if (!isOrdinaryIdentity(identity)) {
    throw new AppBuiltinPreparedDispatchPortError('unsupported_operation');
  }
  if (identity.builtinProjectionRevision !== projection.revision) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }

  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.operationId === identity.operationId,
  );
  if (!entry) throw new AppBuiltinPreparedDispatchPortError('unsupported_operation');
  if (
    entry.name !== identity.exposedToolName ||
    entry.capabilityId !== identity.capabilityId ||
    entry.providerId !== identity.providerId ||
    entry.revision !== identity.capabilityRevision ||
    entry.executorRevision !== identity.executorRevision ||
    entry.descriptor.revision !== identity.descriptorRevision ||
    !preparedParserRevisionMatches(entry, identity.parserRevision) ||
    entry.executionMechanism !== identity.executionMechanism ||
    entry.kind === 'interrupt' ||
    entry.executionMechanism === 'user_input' ||
    entry.executionMechanism === 'subagent' ||
    entry.availability !== 'available' ||
    identity.dynamicCatalogRevision !== null ||
    !nestedIdentityMatchesEntry(entry, identity)
  ) {
    throw new AppBuiltinPreparedDispatchPortError(
      entry.availability !== 'available' ||
        entry.kind === 'interrupt' ||
        entry.executionMechanism === 'user_input' ||
        entry.executionMechanism === 'subagent'
        ? 'unsupported_operation'
        : 'projection_identity_mismatch',
    );
  }
  return entry;
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

function exactBinding(
  entry: Readonly<BuiltinModelToolCatalogEntry>,
  prepared: AppBuiltinPreparedPacket,
): CapabilityBinding {
  if (!entry.inputSchema) {
    throw new AppBuiltinPreparedDispatchPortError('binding_mismatch');
  }
  const expected = createCapabilityBinding({
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    exposedToolName: entry.name,
    inputSchema: entry.inputSchema,
    turnId: prepared.identity.turnId,
  });
  const supplied = prepared.input.binding;
  if (
    prepared.identity.bindingId !== null ||
    supplied !== null ||
    expected.capabilityId !== prepared.identity.capabilityId ||
    expected.capabilityRevision !== prepared.identity.capabilityRevision ||
    expected.exposedToolName !== prepared.identity.exposedToolName ||
    expected.issuedForTurnId !== prepared.identity.turnId
  ) {
    throw new AppBuiltinPreparedDispatchPortError('binding_mismatch');
  }
  return expected;
}

function resolveExactMechanisms(
  input: CreateAppBuiltinPreparedDispatchPortInput,
  prepared: AppBuiltinPreparedPacket,
  entry: Readonly<BuiltinModelToolCatalogEntry>,
): Readonly<Record<string, unknown>> {
  let supplied: BuiltinMechanismRecord;
  try {
    supplied = input.resolveMechanisms({
      prepared,
      operationId: entry.operationId,
      executionMechanism: entry.executionMechanism,
      signal: input.signal,
    });
    return mergeBuiltinMechanismBundle({
      executionMechanism: entry.executionMechanism,
      prepared: supplied,
    });
  } catch {
    throw new AppBuiltinPreparedDispatchPortError('mechanism_unavailable');
  }
}

function grantAuthority(
  entry: Readonly<BuiltinModelToolCatalogEntry>,
  identity: Readonly<NonDynamicPreparedToolInvocationIdentity>,
  request: Readonly<AppToolPipelinePreparedRequest>,
): Readonly<Record<string, RuntimeJsonValue>> {
  if (
    identity.policyDigest === null ||
    identity.authorizationDigest === null ||
    identity.admissionDigest === null
  ) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
  const authority = Object.freeze({
    schema: 'kite.app.builtin-prepared-grant.v1',
    operationId: entry.operationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    providerId: entry.providerId,
    executorRevision: entry.executorRevision,
    policyDigest: identity.policyDigest,
    authorizationDigest: identity.authorizationDigest,
    admissionDigest: identity.admissionDigest,
    authorizationKind: request.authorizationKind,
    grantUsed: request.grantUsed,
    policyEffects: request.policyEffects,
    effectiveEffects: request.effectiveEffects,
    receiptRequirement: request.receiptRequirement,
    retryEligibility: request.retryEligibility,
    ...nestedIdentityFacts(identity),
  });
  return authority;
}

function nestedIdentityFacts(
  identity: Readonly<NonDynamicPreparedToolInvocationIdentity>,
): Readonly<Record<string, RuntimeJsonValue>> {
  return Object.freeze({
    nestedCapabilityId: identity.nestedCapabilityId,
    nestedCapabilityRevision: identity.nestedCapabilityRevision,
    nestedCatalogRevision: identity.nestedCatalogRevision,
  });
}

function createInvocation(
  prepared: AppBuiltinPreparedPacket,
  entry: Readonly<BuiltinModelToolCatalogEntry>,
  binding: CapabilityBinding,
  executionFacts: Readonly<Record<string, RuntimeJsonValue>>,
  authority: Readonly<Record<string, RuntimeJsonValue>>,
  mechanisms: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): CapabilityExecutionInvocation {
  const identity = prepared.identity;
  const grant: ExecutionGrant = Object.freeze({
    grantId: digestCapabilityValue({
      schema: 'kite.app.builtin-prepared-grant.v1',
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      authority,
    }),
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    authority,
  });
  const executionRequest: ExecutionRequest = Object.freeze({
    invocationId: identity.invocationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    input: prepared.input.arguments,
    facts: executionFacts,
  });
  const environment: ExecutionEnvironmentRef = Object.freeze({
    environmentId: digestCapabilityValue({
      schema: 'kite.app.builtin-prepared-environment.v1',
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      operationId: entry.operationId,
    }),
    kind: 'kite-builtin-prepared',
    mechanisms,
  });
  return Object.freeze({
    binding,
    request: executionRequest,
    grant,
    requestDigest: identity.argumentsDigest,
    environment,
    attempt: Object.freeze({
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
    }),
    signal,
  });
}

function executionRequestFacts(
  toolCallId: string,
  supplied: RuntimeJsonValue | null,
): Readonly<Record<string, RuntimeJsonValue>> {
  if (supplied === null) return Object.freeze({ toolCallId });
  if (!isPlainRecord(supplied)) {
    throw new AppBuiltinPreparedDispatchPortError('request_envelope_invalid');
  }
  if (Object.hasOwn(supplied, 'toolCallId') && supplied.toolCallId !== toolCallId) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
  return Object.freeze({ ...supplied, toolCallId });
}

function assertCompositionInput(input: CreateAppBuiltinPreparedDispatchPortInput): void {
  if (!input || typeof input !== 'object') {
    throw new AppBuiltinPreparedDispatchPortError('invalid_prepared_input');
  }
  if (!input.capabilityExecution || typeof input.capabilityExecution.invoke !== 'function') {
    throw new AppBuiltinPreparedDispatchPortError('execution_port_unavailable');
  }
  if (typeof input.resolveMechanisms !== 'function') {
    throw new AppBuiltinPreparedDispatchPortError('mechanism_unavailable');
  }
  if (!input.signal || typeof input.signal.aborted !== 'boolean') {
    throw new AppBuiltinPreparedDispatchPortError('invalid_prepared_input');
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
    throw new AppBuiltinPreparedDispatchPortError('invalid_prepared_input');
  }
}

function assertRequestEnvelope(request: Readonly<AppToolPipelinePreparedRequest>): void {
  if (!isRequestEnvelopeShape(request)) {
    throw new AppBuiltinPreparedDispatchPortError('request_envelope_invalid');
  }
}

function isRequestEnvelopeShape(value: unknown): value is Readonly<AppToolPipelinePreparedRequest> {
  if (!isPlainRecord(value)) return false;
  const request = value;
  const expectedKeys = [
    'schema',
    'authorizationKind',
    'grantUsed',
    'policyEffects',
    'effectiveEffects',
    'receiptRequirement',
    'retryEligibility',
    'taskId',
    'planId',
    'planStepId',
    'capabilityRequestFacts',
  ];
  return (
    request.schema === APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_ &&
    Object.isFrozen(request) &&
    !Reflect.ownKeys(request).some(
      (key) => typeof key !== 'string' || !expectedKeys.includes(key),
    ) &&
    expectedKeys.every((key) => Object.hasOwn(request, key)) &&
    (request.authorizationKind === 'policy_allow' ||
      request.authorizationKind === 'approved_call') &&
    (request.grantUsed === 'none' ||
      request.grantUsed === 'approve_once' ||
      request.grantUsed === 'same_command' ||
      request.grantUsed === 'full_access') &&
    (request.grantUsed !== 'approve_once' || request.authorizationKind === 'approved_call') &&
    isPolicyEffects(request.policyEffects) &&
    typeof request.receiptRequirement === 'string' &&
    ['observation_receipt', 'effect_receipt', 'control_receipt', 'not_applicable'].includes(
      request.receiptRequirement,
    ) &&
    typeof request.retryEligibility === 'string' &&
    ['none', 'safe_read_candidate', 'idempotency_key_candidate'].includes(
      request.retryEligibility,
    ) &&
    isCapabilityEffects(request.effectiveEffects) &&
    (request.taskId === null || isNonEmptyString(request.taskId)) &&
    (request.planId === null || isNonEmptyString(request.planId)) &&
    (request.planStepId === null || isNonEmptyString(request.planStepId)) &&
    isRuntimeJsonValue(request.capabilityRequestFacts)
  );
}

function isPolicyEffects(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(['network', 'externalRead', 'externalWrite', 'uncertainEffects']);
  return Object.entries(value).every(([key, item]) => allowed.has(key) && item === true);
}

function isCapabilityEffects(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = ['filesystem', 'network', 'externalState'];
  const levels = new Set(['none', 'read', 'write', 'destructive', 'unknown']);
  return (
    Object.keys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) && typeof value[key] === 'string' && levels.has(value[key]),
    )
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOrdinaryIdentity(
  identity: Readonly<PreparedToolInvocation['identity']>,
): identity is Readonly<NonDynamicPreparedToolInvocationIdentity> {
  return (
    identity.isDynamicMcp === false &&
    identity.modelVisible === true &&
    identity.visibility === 'model' &&
    identity.exposedToolName.length > 0 &&
    identity.operationId !== 'mcp:dynamic_tool'
  );
}

function assertDeepFrozenPrepared(prepared: Readonly<PreparedToolInvocation>): void {
  if (!isDeepFrozenValue(prepared, new WeakSet<object>())) {
    throw new AppBuiltinPreparedDispatchPortError('invalid_prepared_input');
  }
  if (
    prepared.input.invocationId !== prepared.identity.invocationId ||
    prepared.input.attemptId !== prepared.identity.attemptId ||
    prepared.input.toolCallId !== prepared.identity.toolCallId
  ) {
    throw new AppBuiltinPreparedDispatchPortError('projection_identity_mismatch');
  }
}

function isAppBuiltinPreparedPacket(
  prepared: Readonly<PreparedToolInvocation>,
): prepared is AppBuiltinPreparedPacket {
  return isRequestEnvelopeShape(prepared.input.request);
}

function isBuiltinExecutionReceipt(
  receipt: Readonly<ExecutionReceipt>,
): receipt is Readonly<ExecutionReceipt<RuntimeJsonValue>> {
  return receipt.value === undefined || isRuntimeJsonValue(receipt.value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
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

function isRuntimeJsonValue(value: unknown, active = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isRuntimeJsonValue(value[index], active)) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isRuntimeJsonValue(descriptor.value, active)) return false;
    }
    return true;
  } finally {
    active.delete(value);
  }
}

function appBuiltinPreparedDispatchPortMessage(
  code: AppBuiltinPreparedDispatchFailureCode,
): string {
  switch (code) {
    case 'invalid_prepared_input':
      return 'App Builtin prepared dispatch input is invalid.';
    case 'projection_identity_mismatch':
      return 'App Builtin prepared identity does not match the frozen projection.';
    case 'request_envelope_invalid':
      return 'App Builtin prepared request envelope is invalid.';
    case 'binding_mismatch':
      return 'App Builtin prepared binding does not match its catalog entry.';
    case 'unsupported_operation':
      return 'App Builtin operation is outside the ordinary dispatch bridge.';
    case 'mechanism_unavailable':
      return 'App Builtin execution mechanism is unavailable or not exact.';
    case 'execution_port_unavailable':
      return 'App Host capability execution port is unavailable.';
  }
}
