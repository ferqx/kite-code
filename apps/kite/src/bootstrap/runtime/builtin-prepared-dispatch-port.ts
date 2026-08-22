import {
  type BuiltinInternalOperationCatalogEntryV1,
  type BuiltinMechanismRecordV1,
  type BuiltinModelToolCatalogEntryV1,
  type BuiltinOperationExecutionValueV1,
  type BuiltinPreparedToolDispatchInputV1,
  type BuiltinPreparedToolDispatchPortV1,
  type BuiltinToolCatalogProjectionV1,
  createCapabilityBindingV1,
  digestCapabilityValueV1,
  mergeBuiltinMechanismBundleV1,
  projectBuiltinDynamicMcpExecutionReceiptTerminalResultV1,
} from '#builtin-runtime';
import type {
  CapabilityBindingV1,
  CapabilityExecutionInvocationV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutionPortV1,
  CapabilityToolTerminalResultV1,
  DynamicMcpPreparedToolInvocationIdentityV1,
  ExecutionEnvironmentRefV1,
  ExecutionGrantV1,
  ExecutionReceiptV1,
  ExecutionRequestV1,
  NonDynamicPreparedToolInvocationIdentityV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineDispatchV1,
  ToolPipelinePreparedIdentityVerifierV1,
} from '#runtime-spi';
import {
  APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1,
  type AppPreparedToolInvocationPacketV1,
  type AppToolPipelinePreparedRequestV1,
} from './tool-pipeline-prepared';

type AppBuiltinPreparedPacketV1 = Readonly<AppPreparedToolInvocationPacketV1<RuntimeJsonValueV1>>;

export const APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_V1 =
  'kite.app.builtin-prepared-dispatch-port.v1' as const;

export interface AppBuiltinPreparedMechanismResolverInputV1 {
  readonly prepared: Readonly<PreparedToolInvocationV1>;
  readonly operationId: string;
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly signal: AbortSignal;
}

/**
 * The App supplies exactly one already-composed mechanism map. This resolver
 * never owns a registry, executor, or Host execution port.
 */
export type AppBuiltinPreparedMechanismResolverV1 = (
  input: Readonly<AppBuiltinPreparedMechanismResolverInputV1>,
) => BuiltinMechanismRecordV1;

export interface CreateAppBuiltinPreparedDispatchPortInputV1 {
  /** The same frozen turn projection that produced the prepared identity. */
  readonly projection: Readonly<BuiltinToolCatalogProjectionV1>;
  /** The one supplied Host registry execution port. */
  readonly capabilityExecution: CapabilityExecutionPortV1;
  /** One App-composed mechanism resolver for this bridge. */
  readonly resolveMechanisms: AppBuiltinPreparedMechanismResolverV1;
  /** The invocation-scoped cancellation signal. */
  readonly signal: AbortSignal;
}

export interface CreateAppDynamicMcpPreparedDispatchAdapterInputV1
  extends CreateAppBuiltinPreparedDispatchPortInputV1 {
  /** The verifier from the same Builtin callback bundle as the projection. */
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1;
}

export interface AppBuiltinPreparedDispatchPortV1 extends BuiltinPreparedToolDispatchPortV1 {
  readonly schema: typeof APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_V1;
}

/**
 * App-side dynamic-MCP adapter.  The Builtin package deliberately rejects
 * dynamic identities from its model-visible adapter; this bridge handles the
 * private `mcp:dynamic_tool` wrapper while preserving the real subject binding
 * and dynamic catalog revision in the prepared identity.  It enters the
 * frozen projection exactly once and only through the supplied Host port.
 */
export function createAppDynamicMcpPreparedDispatchAdapterV1(
  input: CreateAppDynamicMcpPreparedDispatchAdapterInputV1,
): ToolPipelineDispatchV1<RuntimeJsonValueV1, BuiltinOperationExecutionValueV1> {
  assertCompositionInputV1(input);
  assertFrozenProjectionV1(input.projection);
  const verifyPreparedIdentity = input.verifyPreparedIdentity;
  const dispatch = async (
    prepared: Readonly<PreparedToolInvocationV1<RuntimeJsonValueV1, RuntimeJsonValueV1>>,
  ): Promise<Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>> => {
    assertDeepFrozenPreparedV1(prepared);
    const identity = prepared.identity;
    if (!isDynamicIdentityV1(identity)) {
      throw new AppBuiltinPreparedDispatchPortErrorV1('unsupported_operation');
    }
    const entry = exactDynamicWrapperEntryV1(input.projection, identity);
    const binding = dynamicWrapperBindingV1(entry, identity.turnId);
    const mechanisms = input.resolveMechanisms({
      prepared,
      operationId: entry.operationId,
      executionMechanism: entry.executionMechanism,
      signal: input.signal,
    });
    const invocation = createDynamicInvocationV1(
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
    assertDynamicReceiptIdentityV1(receipt, entry, prepared);
    return projectBuiltinDynamicMcpExecutionReceiptTerminalResultV1(receipt, entry, prepared);
  };
  return Object.freeze({ verifyPreparedIdentity, dispatch });
}

export type AppBuiltinPreparedDispatchFailureCodeV1 =
  | 'invalid_prepared_input'
  | 'projection_identity_mismatch'
  | 'request_envelope_invalid'
  | 'binding_mismatch'
  | 'unsupported_operation'
  | 'mechanism_unavailable'
  | 'execution_port_unavailable';

export class AppBuiltinPreparedDispatchPortErrorV1 extends Error {
  readonly code: AppBuiltinPreparedDispatchFailureCodeV1;

  constructor(code: AppBuiltinPreparedDispatchFailureCodeV1) {
    super(appBuiltinPreparedDispatchPortMessageV1(code));
    this.name = 'AppBuiltinPreparedDispatchPortErrorV1';
    this.code = code;
  }
}

/**
 * Compose the only ordinary Builtin bridge. The returned callback constructs
 * one invocation envelope and enters the Builtin projection exactly once;
 * it never calls the supplied Host port directly or selects a fallback.
 */
export function createAppBuiltinPreparedDispatchPortV1(
  input: CreateAppBuiltinPreparedDispatchPortInputV1,
): AppBuiltinPreparedDispatchPortV1 {
  assertCompositionInputV1(input);
  assertFrozenProjectionV1(input.projection);

  const dispatch = async (
    dispatchInput: Readonly<BuiltinPreparedToolDispatchInputV1>,
  ): Promise<Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>> => {
    const prepared = dispatchInput.prepared;
    assertDeepFrozenPreparedV1(prepared);
    if (
      dispatchInput.operationId !== prepared.identity.operationId ||
      dispatchInput.executionMechanism !== prepared.identity.executionMechanism ||
      dispatchInput.arguments !== prepared.input.arguments
    ) {
      throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
    }
    if (!isAppBuiltinPreparedPacketV1(prepared)) {
      throw new AppBuiltinPreparedDispatchPortErrorV1('request_envelope_invalid');
    }
    const request = prepared.input.request;
    assertRequestEnvelopeV1(request);

    const entry = exactOrdinaryEntryV1(input.projection, prepared);
    if (!isOrdinaryIdentityV1(prepared.identity)) {
      throw new AppBuiltinPreparedDispatchPortErrorV1('unsupported_operation');
    }
    const binding = exactBindingV1(entry, prepared);
    const executionFacts = executionRequestFactsV1(
      prepared.identity.toolCallId,
      request.capabilityRequestFacts,
    );
    const mechanisms = resolveExactMechanismsV1(input, prepared, entry);
    const authority = grantAuthorityV1(entry, prepared.identity, request);
    const invocation = createInvocationV1(
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
    if (!isBuiltinExecutionReceiptV1(receipt)) {
      throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
    }
    return receipt;
  };

  return Object.freeze({
    schema: APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_V1,
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
export function createAppBuiltinPreparedTaskDispatchPortV1(
  input: CreateAppBuiltinPreparedDispatchPortInputV1,
): AppBuiltinPreparedDispatchPortV1 {
  assertCompositionInputV1(input);
  assertFrozenProjectionV1(input.projection);

  const dispatch = async (
    dispatchInput: Readonly<BuiltinPreparedToolDispatchInputV1>,
  ): Promise<Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>> => {
    const prepared = dispatchInput.prepared;
    assertDeepFrozenPreparedV1(prepared);
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
      throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
    }
    const entry = input.projection.entries.find(
      (candidate): candidate is BuiltinModelToolCatalogEntryV1 =>
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
      throw new AppBuiltinPreparedDispatchPortErrorV1(
        entry?.availability !== 'available'
          ? 'unsupported_operation'
          : 'projection_identity_mismatch',
      );
    }
    assertRequestEnvelopeV1(prepared.input.request as Readonly<AppToolPipelinePreparedRequestV1>);
    const binding = exactBindingV1(entry, prepared as AppBuiltinPreparedPacketV1);
    const request = prepared.input.request as Readonly<AppToolPipelinePreparedRequestV1>;
    const executionFacts = executionRequestFactsV1(
      identity.toolCallId,
      request.capabilityRequestFacts,
    );
    const mechanisms = resolveExactMechanismsV1(
      input,
      prepared as AppBuiltinPreparedPacketV1,
      entry,
    );
    const authority = grantAuthorityV1(entry, identity, request);
    const invocation = createInvocationV1(
      prepared as AppBuiltinPreparedPacketV1,
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
    if (!isBuiltinExecutionReceiptV1(receipt)) {
      throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
    }
    return receipt;
  };

  return Object.freeze({
    schema: APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_V1,
    dispatch,
  });
}

function exactDynamicWrapperEntryV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentityV1>,
): Readonly<BuiltinInternalOperationCatalogEntryV1> {
  if (identity.runtimeWrapper.builtinProjectionRevision !== projection.revision) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
  }
  const matches = projection.entries.filter(
    (entry): entry is BuiltinInternalOperationCatalogEntryV1 =>
      entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool',
  );
  if (matches.length !== 1) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('unsupported_operation');
  }
  const entry = matches[0]!;
  const expectedSchemaDigest = digestCapabilityValueV1(entry.inputSchema ?? {});
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
    throw new AppBuiltinPreparedDispatchPortErrorV1(
      entry.availability !== 'available' ? 'unsupported_operation' : 'projection_identity_mismatch',
    );
  }
  return entry;
}

function dynamicWrapperBindingV1(
  entry: Readonly<BuiltinInternalOperationCatalogEntryV1>,
  turnId: string,
): CapabilityBindingV1 {
  if (!entry.inputSchema) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('binding_mismatch');
  }
  return createCapabilityBindingV1({
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    exposedToolName: entry.operationId,
    inputSchema: entry.inputSchema,
    turnId,
  });
}

function createDynamicInvocationV1(
  prepared: Readonly<PreparedToolInvocationV1>,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentityV1>,
  entry: Readonly<BuiltinInternalOperationCatalogEntryV1>,
  binding: CapabilityBindingV1,
  mechanisms: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): CapabilityExecutionInvocationV1 {
  if (!isPlainRecordV1(prepared.input.arguments)) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('request_envelope_invalid');
  }
  if (
    !identity.subject.capabilityId ||
    !identity.subject.capabilityRevision ||
    identity.subject.exposedToolName.length <= 'mcp__'.length
  ) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
  }
  const request = isRequestEnvelopeShapeV1(prepared.input.request)
    ? prepared.input.request
    : undefined;
  if (!request) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('request_envelope_invalid');
  }
  const authority = dynamicGrantAuthorityV1(identity, entry, request);
  const generatedIdempotencyKey =
    identity.idempotencyKeyArgument && identity.idempotencyKey === null
      ? digestCapabilityValueV1({
          schema: 'kite.tool-idempotency-key.v1',
          invocationId: identity.invocationId,
          capabilityId: identity.subject.capabilityId,
        })
      : identity.idempotencyKey;
  const subjectArguments =
    identity.idempotencyKeyArgument && generatedIdempotencyKey
      ? Object.freeze({
          ...(prepared.input.arguments as Readonly<Record<string, RuntimeJsonValueV1>>),
          [identity.idempotencyKeyArgument]: generatedIdempotencyKey,
        })
      : prepared.input.arguments;
  const wrapperArguments = Object.freeze({
    capability_id: identity.subject.capabilityId,
    capability_revision: identity.subject.capabilityRevision,
    arguments: subjectArguments,
  }) as RuntimeJsonValueV1;
  const executionRequest: ExecutionRequestV1 = Object.freeze({
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
  const grant: ExecutionGrantV1 = Object.freeze({
    grantId: digestCapabilityValueV1({
      schema: 'kite.app.dynamic-mcp-prepared-grant.v1',
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      authority,
    }),
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    authority,
  });
  const environment: ExecutionEnvironmentRefV1 = Object.freeze({
    environmentId: digestCapabilityValueV1({
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

function dynamicGrantAuthorityV1(
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentityV1>,
  entry: Readonly<BuiltinInternalOperationCatalogEntryV1>,
  request: Readonly<AppToolPipelinePreparedRequestV1> | undefined,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  if (
    identity.policyDigest === null ||
    identity.authorizationDigest === null ||
    identity.admissionDigest === null
  ) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
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

function isDynamicIdentityV1(
  identity: Readonly<PreparedToolInvocationV1['identity']>,
): identity is Readonly<DynamicMcpPreparedToolInvocationIdentityV1> {
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

function assertDynamicReceiptIdentityV1(
  receipt: Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>>,
  entry: Readonly<BuiltinInternalOperationCatalogEntryV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): void {
  if (
    receipt.invocationId !== prepared.identity.invocationId ||
    receipt.attemptId !== prepared.identity.attemptId ||
    receipt.providerId !== entry.providerId ||
    receipt.executorRevision !== entry.executorRevision ||
    typeof receipt.requestDigest !== 'string' ||
    receipt.requestDigest !== prepared.identity.argumentsDigest
  ) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
  }
}

function exactOrdinaryEntryV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  prepared: AppBuiltinPreparedPacketV1,
): Readonly<BuiltinModelToolCatalogEntryV1> {
  const identity = prepared.identity;
  if (!isOrdinaryIdentityV1(identity)) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('unsupported_operation');
  }
  if (identity.builtinProjectionRevision !== projection.revision) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
  }

  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntryV1 =>
      candidate.visibility === 'model' && candidate.operationId === identity.operationId,
  );
  if (!entry) throw new AppBuiltinPreparedDispatchPortErrorV1('unsupported_operation');
  if (
    entry.name !== identity.exposedToolName ||
    entry.capabilityId !== identity.capabilityId ||
    entry.providerId !== identity.providerId ||
    entry.revision !== identity.capabilityRevision ||
    entry.executorRevision !== identity.executorRevision ||
    entry.descriptor.revision !== identity.descriptorRevision ||
    !preparedParserRevisionMatchesV1(entry, identity.parserRevision) ||
    entry.executionMechanism !== identity.executionMechanism ||
    entry.kind === 'interrupt' ||
    entry.executionMechanism === 'user_input' ||
    entry.executionMechanism === 'subagent' ||
    entry.availability !== 'available' ||
    identity.dynamicCatalogRevision !== null ||
    !nestedIdentityMatchesEntryV1(entry, identity)
  ) {
    throw new AppBuiltinPreparedDispatchPortErrorV1(
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

function exactBindingV1(
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
  prepared: AppBuiltinPreparedPacketV1,
): CapabilityBindingV1 {
  if (!entry.inputSchema) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('binding_mismatch');
  }
  const expected = createCapabilityBindingV1({
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
    throw new AppBuiltinPreparedDispatchPortErrorV1('binding_mismatch');
  }
  return expected;
}

function resolveExactMechanismsV1(
  input: CreateAppBuiltinPreparedDispatchPortInputV1,
  prepared: AppBuiltinPreparedPacketV1,
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
): Readonly<Record<string, unknown>> {
  let supplied: BuiltinMechanismRecordV1;
  try {
    supplied = input.resolveMechanisms({
      prepared,
      operationId: entry.operationId,
      executionMechanism: entry.executionMechanism,
      signal: input.signal,
    });
    return mergeBuiltinMechanismBundleV1({
      executionMechanism: entry.executionMechanism,
      prepared: supplied,
    });
  } catch {
    throw new AppBuiltinPreparedDispatchPortErrorV1('mechanism_unavailable');
  }
}

function grantAuthorityV1(
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
  identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>,
  request: Readonly<AppToolPipelinePreparedRequestV1>,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  if (
    identity.policyDigest === null ||
    identity.authorizationDigest === null ||
    identity.admissionDigest === null
  ) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
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
    ...nestedIdentityFactsV1(identity),
  });
  return authority;
}

function nestedIdentityFactsV1(
  identity: Readonly<NonDynamicPreparedToolInvocationIdentityV1>,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  return Object.freeze({
    nestedCapabilityId: identity.nestedCapabilityId,
    nestedCapabilityRevision: identity.nestedCapabilityRevision,
    nestedCatalogRevision: identity.nestedCatalogRevision,
  });
}

function createInvocationV1(
  prepared: AppBuiltinPreparedPacketV1,
  entry: Readonly<BuiltinModelToolCatalogEntryV1>,
  binding: CapabilityBindingV1,
  executionFacts: Readonly<Record<string, RuntimeJsonValueV1>>,
  authority: Readonly<Record<string, RuntimeJsonValueV1>>,
  mechanisms: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): CapabilityExecutionInvocationV1 {
  const identity = prepared.identity;
  const grant: ExecutionGrantV1 = Object.freeze({
    grantId: digestCapabilityValueV1({
      schema: 'kite.app.builtin-prepared-grant.v1',
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      authority,
    }),
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    authority,
  });
  const executionRequest: ExecutionRequestV1 = Object.freeze({
    invocationId: identity.invocationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    input: prepared.input.arguments,
    facts: executionFacts,
  });
  const environment: ExecutionEnvironmentRefV1 = Object.freeze({
    environmentId: digestCapabilityValueV1({
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

function executionRequestFactsV1(
  toolCallId: string,
  supplied: RuntimeJsonValueV1 | null,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  if (supplied === null) return Object.freeze({ toolCallId });
  if (!isPlainRecordV1(supplied)) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('request_envelope_invalid');
  }
  if (Object.hasOwn(supplied, 'toolCallId') && supplied.toolCallId !== toolCallId) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
  }
  return Object.freeze({ ...supplied, toolCallId });
}

function assertCompositionInputV1(input: CreateAppBuiltinPreparedDispatchPortInputV1): void {
  if (!input || typeof input !== 'object') {
    throw new AppBuiltinPreparedDispatchPortErrorV1('invalid_prepared_input');
  }
  if (!input.capabilityExecution || typeof input.capabilityExecution.invoke !== 'function') {
    throw new AppBuiltinPreparedDispatchPortErrorV1('execution_port_unavailable');
  }
  if (typeof input.resolveMechanisms !== 'function') {
    throw new AppBuiltinPreparedDispatchPortErrorV1('mechanism_unavailable');
  }
  if (!input.signal || typeof input.signal.aborted !== 'boolean') {
    throw new AppBuiltinPreparedDispatchPortErrorV1('invalid_prepared_input');
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
    throw new AppBuiltinPreparedDispatchPortErrorV1('invalid_prepared_input');
  }
}

function assertRequestEnvelopeV1(request: Readonly<AppToolPipelinePreparedRequestV1>): void {
  if (!isRequestEnvelopeShapeV1(request)) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('request_envelope_invalid');
  }
}

function isRequestEnvelopeShapeV1(
  value: unknown,
): value is Readonly<AppToolPipelinePreparedRequestV1> {
  if (!isPlainRecordV1(value)) return false;
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
    request.schema === APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1 &&
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
    isPolicyEffectsV1(request.policyEffects) &&
    typeof request.receiptRequirement === 'string' &&
    ['observation_receipt', 'effect_receipt', 'control_receipt', 'not_applicable'].includes(
      request.receiptRequirement,
    ) &&
    typeof request.retryEligibility === 'string' &&
    ['none', 'safe_read_candidate', 'idempotency_key_candidate'].includes(
      request.retryEligibility,
    ) &&
    isCapabilityEffectsV1(request.effectiveEffects) &&
    (request.taskId === null || isNonEmptyStringV1(request.taskId)) &&
    (request.planId === null || isNonEmptyStringV1(request.planId)) &&
    (request.planStepId === null || isNonEmptyStringV1(request.planStepId)) &&
    isRuntimeJsonValueV1(request.capabilityRequestFacts)
  );
}

function isPolicyEffectsV1(value: unknown): boolean {
  if (!isPlainRecordV1(value)) return false;
  const allowed = new Set(['network', 'externalRead', 'externalWrite', 'uncertainEffects']);
  return Object.entries(value).every(([key, item]) => allowed.has(key) && item === true);
}

function isCapabilityEffectsV1(value: unknown): boolean {
  if (!isPlainRecordV1(value)) return false;
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

function isNonEmptyStringV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOrdinaryIdentityV1(
  identity: Readonly<PreparedToolInvocationV1['identity']>,
): identity is Readonly<NonDynamicPreparedToolInvocationIdentityV1> {
  return (
    identity.isDynamicMcp === false &&
    identity.modelVisible === true &&
    identity.visibility === 'model' &&
    identity.exposedToolName.length > 0 &&
    identity.operationId !== 'mcp:dynamic_tool'
  );
}

function assertDeepFrozenPreparedV1(prepared: Readonly<PreparedToolInvocationV1>): void {
  if (!isDeepFrozenValueV1(prepared, new WeakSet<object>())) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('invalid_prepared_input');
  }
  if (
    prepared.input.invocationId !== prepared.identity.invocationId ||
    prepared.input.attemptId !== prepared.identity.attemptId ||
    prepared.input.toolCallId !== prepared.identity.toolCallId
  ) {
    throw new AppBuiltinPreparedDispatchPortErrorV1('projection_identity_mismatch');
  }
}

function isAppBuiltinPreparedPacketV1(
  prepared: Readonly<PreparedToolInvocationV1>,
): prepared is AppBuiltinPreparedPacketV1 {
  return isRequestEnvelopeShapeV1(prepared.input.request);
}

function isBuiltinExecutionReceiptV1(
  receipt: Readonly<ExecutionReceiptV1>,
): receipt is Readonly<ExecutionReceiptV1<RuntimeJsonValueV1>> {
  return receipt.value === undefined || isRuntimeJsonValueV1(receipt.value);
}

function isPlainRecordV1(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
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

function isRuntimeJsonValueV1(value: unknown, active = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isRuntimeJsonValueV1(value[index], active)) {
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
      if (!isRuntimeJsonValueV1(descriptor.value, active)) return false;
    }
    return true;
  } finally {
    active.delete(value);
  }
}

function appBuiltinPreparedDispatchPortMessageV1(
  code: AppBuiltinPreparedDispatchFailureCodeV1,
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
