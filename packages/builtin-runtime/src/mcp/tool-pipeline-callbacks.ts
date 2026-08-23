import type { CapabilityDescriptor as RuntimeCapabilityDescriptor } from '@kite/runtime-contract';
import type {
  CapabilityApproval,
  CapabilityBinding,
  CapabilityEffects,
  CapabilityPolicyCompilation,
  ClassifiedInvocation,
  DynamicMcpPreparedToolInvocationIdentity,
  DynamicMcpRuntimeWrapperIdentity,
  DynamicMcpSubjectIdentity,
  DynamicMcpToolTarget,
  PreparedToolInvocation,
  ResolvedInvocation,
  RuntimeJsonValue,
  ToolArgumentOrigin,
  ToolCallSnapshot,
  ToolClassificationResult,
  ToolPipelineCapabilityBinding,
  ToolPipelineCapabilityDescriptor,
  ToolPipelineClassifiedIdentityVerificationResult,
  ToolPipelineClassifiedIdentityVerifier,
  ToolPipelineGovernanceProjection,
  ToolPipelinePreparedIdentityVerificationResult,
  ToolPipelinePreparedIdentityVerifier,
  ToolPipelineResolutionContext,
  ToolPipelineResolveFailureCode,
  ToolPipelineValidateFailureCode,
  ToolResolutionResult,
  ToolValidationResult,
  ValidatedInvocation,
} from '@kite/runtime-spi';
import {
  CAPABILITY_POLICY_COMPILATION_SCHEMA_,
  TOOL_PIPELINE_STAGE_SCHEMA_,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';
import {
  BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
  compileBuiltinDynamicMcpPolicy,
} from '../policy-compiler';
import type {
  BuiltinInternalOperationCatalogEntry,
  BuiltinToolCatalogProjection,
} from '../tool-catalog';
import { canonicalizeCapabilityArguments } from './capability-domain';

/** Stable JSON facts carried from MCP resolution to Host prepared identity. */
export const BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_ =
  'kite.builtin-runtime.dynamic-mcp-subject-facts.v1' as const;
const SHA256_HEX_ = /^[0-9a-f]{64}$/u;

export interface BuiltinDynamicMcpSubjectFacts {
  readonly schema: typeof BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly descriptorDigest: string;
  readonly providerId: string;
  readonly providerType: 'mcp';
  readonly kind: 'mcp_tool';
  readonly exposedToolName: `mcp__${string}`;
  readonly availability: 'available';
  readonly schemaDigest: string;
  readonly effectiveEffects: CapabilityEffects;
  readonly effectiveEffectsDigest: string;
  readonly minimumApproval: CapabilityApproval;
  readonly dynamicCatalogRevision: string;
  readonly bindingId: string;
  readonly issuedForTurnId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: Extract<ToolArgumentOrigin, 'model_public'>;
  readonly descriptor: Readonly<RuntimeCapabilityDescriptor>;
}

export interface BuiltinDynamicMcpSubjectFactsIdentity {
  readonly dynamicCatalogRevision: string;
  readonly bindingId: string;
  readonly issuedForTurnId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: Extract<ToolArgumentOrigin, 'model_public'>;
}

export interface BuiltinDynamicMcpToolPipelineCallbacks {
  readonly resolve: (
    call: Readonly<ToolCallSnapshot>,
    context: Readonly<ToolPipelineResolutionContext>,
  ) => ToolResolutionResult;
  readonly validate: (resolved: Readonly<ResolvedInvocation>) => ToolValidationResult;
  readonly classify: (validated: Readonly<ValidatedInvocation>) => ToolClassificationResult;
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier;
  readonly verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifier;
}

/**
 * Build the package-internal dynamic MCP callback surface from exactly one
 * frozen Builtin projection. The callback owns no MCP runtime, registry,
 * executor, Store, Host, Kernel, or App object.
 */
export function createBuiltinDynamicMcpToolPipelineCallbacks(
  projection: Readonly<BuiltinToolCatalogProjection>,
): BuiltinDynamicMcpToolPipelineCallbacks {
  const wrapper = captureDynamicMcpWrapper(projection);
  const classifiedAuthenticity = new WeakSet<object>();

  const callbacks: BuiltinDynamicMcpToolPipelineCallbacks = {
    resolve: (call, context) => resolveDynamicMcp(projection, wrapper, call, context),
    validate: (resolved) => validateDynamicMcp(projection, wrapper, resolved),
    classify: (validated) =>
      classifyDynamicMcp(projection, wrapper, classifiedAuthenticity, validated),
    verifyPreparedIdentity: (prepared) =>
      verifyPreparedDynamicMcpIdentity(projection, wrapper, prepared),
    verifyClassifiedIdentity: (classified) =>
      verifyClassifiedDynamicMcpIdentity(projection, wrapper, classifiedAuthenticity, classified),
  };
  return Object.freeze(callbacks);
}

function captureDynamicMcpWrapper(
  projection: Readonly<BuiltinToolCatalogProjection>,
): BuiltinInternalOperationCatalogEntry {
  assertFrozenProjection(projection);
  const matches = projection.entries.filter(
    (entry): entry is BuiltinInternalOperationCatalogEntry =>
      entry.visibility === 'internal' && entry.operationId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
  );
  if (matches.length !== 1) {
    throw new Error('Builtin dynamic MCP callback requires one internal wrapper operation.');
  }
  const wrapper = matches[0]!;
  if (
    wrapper.capabilityId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_ ||
    wrapper.executionMechanism !== 'mcp' ||
    wrapper.kind !== 'internal_runtime' ||
    wrapper.executorRevision.length === 0 ||
    !wrapper.inputSchema ||
    !isJsonRecord(wrapper.inputSchema) ||
    wrapper.providerId.length === 0 ||
    wrapper.revision.length === 0 ||
    wrapper.descriptor.kind !== 'internal_runtime' ||
    wrapper.descriptor.provider.type !== 'builtin' ||
    wrapper.availability !== 'available'
  ) {
    throw new Error('Builtin dynamic MCP wrapper identity is invalid.');
  }
  const wrapperSchemaDigest = digestCapabilityBindingValue(wrapper.inputSchema);
  if (wrapper.inputSchemaDigest && wrapper.inputSchemaDigest !== wrapperSchemaDigest) {
    throw new Error('Builtin dynamic MCP wrapper schema identity is invalid.');
  }
  if (wrapper.parser.schemaDigest && wrapper.parser.schemaDigest !== wrapperSchemaDigest) {
    throw new Error('Builtin dynamic MCP wrapper parser schema identity is invalid.');
  }
  if (wrapper.parser.parserRevision.length === 0) {
    throw new Error('Builtin dynamic MCP wrapper parser revision is invalid.');
  }
  return wrapper;
}

function resolveDynamicMcp(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  call: Readonly<ToolCallSnapshot>,
  context: Readonly<ToolPipelineResolutionContext>,
): ToolResolutionResult {
  if (call.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ || call.stage !== 'snapshot') {
    return resolveFailure('invalid_stage_input', null, null);
  }
  if (!validDynamicResolutionContext(projection, context)) {
    return resolveFailure('resolution_context_invalid', call.toolCallId, call.name);
  }
  const dynamicCatalogRevision = context.dynamicCatalogRevision;
  if (typeof dynamicCatalogRevision !== 'string') {
    return resolveFailure('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (call.createdAtTurnId !== context.currentTurnId) {
    return resolveFailure('call_turn_mismatch', call.toolCallId, call.name);
  }
  if (call.argumentOrigin !== 'model_public') {
    return resolveFailure('unknown_tool', call.toolCallId, call.name);
  }
  if (!call.name.startsWith('mcp__') || call.name.length <= 'mcp__'.length) {
    return resolveFailure('unknown_tool', call.toolCallId, call.name);
  }
  if (!call.bindingId || !call.capabilityId || !call.capabilityRevision) {
    return resolveFailure('binding_missing', call.toolCallId, call.name);
  }

  const binding = uniqueMatch(
    context.bindings,
    (candidate) => candidate.bindingId === call.bindingId,
  );
  if (binding === 'duplicate') {
    return resolveFailure('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (!binding) return resolveFailure('binding_missing', call.toolCallId, call.name);
  if (
    binding.bindingId !== call.bindingId ||
    binding.capabilityId !== call.capabilityId ||
    binding.capabilityRevision !== call.capabilityRevision
  ) {
    return resolveFailure('binding_identity_mismatch', call.toolCallId, call.name);
  }
  if (binding.issuedForTurnId !== call.createdAtTurnId) {
    return resolveFailure('binding_turn_mismatch', call.toolCallId, call.name);
  }
  if (binding.exposedToolName !== call.name || !binding.exposedToolName.startsWith('mcp__')) {
    return resolveFailure('binding_name_mismatch', call.toolCallId, call.name);
  }
  if (!validBindingId(binding)) {
    return resolveFailure('binding_identity_mismatch', call.toolCallId, call.name);
  }

  const descriptor = uniqueMatch(
    context.descriptors,
    (candidate) => candidate.capabilityId === binding.capabilityId,
  );
  if (descriptor === 'duplicate') {
    return resolveFailure('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (!descriptor) return resolveFailure('descriptor_missing', call.toolCallId, call.name);
  if (descriptor.revision !== binding.capabilityRevision) {
    return resolveFailure('descriptor_revision_mismatch', call.toolCallId, call.name);
  }
  if (!isDynamicMcpSubjectDescriptor(descriptor)) {
    return resolveFailure('descriptor_kind_mismatch', call.toolCallId, call.name);
  }
  if (descriptor.availability !== 'available') {
    return resolveFailure('descriptor_unavailable', call.toolCallId, call.name);
  }
  if (!descriptor.inputSchema || !isJsonRecord(descriptor.inputSchema)) {
    return resolveFailure('descriptor_revision_mismatch', call.toolCallId, call.name);
  }
  if (digestCapabilityBindingValue(descriptor.inputSchema) !== binding.schemaDigest) {
    return resolveFailure('binding_identity_mismatch', call.toolCallId, call.name);
  }

  const subject = freezeDynamicSubject({
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    descriptorRevision: descriptor.revision,
    providerId: descriptor.provider.id,
    exposedToolName: call.name as `mcp__${string}`,
    dynamicCatalogRevision,
    bindingId: binding.bindingId,
  });
  const runtimeWrapper = freezeRuntimeWrapper(projection, wrapper);
  const target: Readonly<DynamicMcpToolTarget> = Object.freeze({
    executionFamily: 'mcp' as const,
    executionMechanism: 'mcp' as const,
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
    visibility: 'internal' as const,
    modelVisible: false as const,
    exposedToolName: null,
    isDynamicMcp: true as const,
    toolKind: 'computer' as const,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    descriptorRevision: descriptor.revision,
    providerId: descriptor.provider.id,
    executorRevision: null,
    binding: freezeBinding(binding),
    descriptor: freezeRuntimeDescriptor(descriptor),
    builtinProjectionRevision: null,
    dynamicCatalogRevision,
    subject,
    runtimeWrapper,
  });
  return success({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_,
    stage: 'resolved' as const,
    call: freezeToolCall(call),
    target,
    availabilityContext: freezeAvailabilityContext(context.availabilityContext),
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision,
    disclosedCapabilities: freezeJsonArray(context.descriptors),
    disclosures: freezeJsonArray(context.disclosures ?? []),
  });
}

function validateDynamicMcp(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  resolved: Readonly<ResolvedInvocation>,
): ToolValidationResult {
  const target = resolved?.target as Readonly<DynamicMcpToolTarget>;
  if (
    !resolved ||
    resolved.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ ||
    resolved.stage !== 'resolved'
  ) {
    return validationFailure('invalid_stage_input', null, null);
  }
  if (!validResolvedDynamicMcp(projection, wrapper, resolved)) {
    return validationFailure('stage_identity_drift', resolved.call.toolCallId, resolved.call.name);
  }
  const binding = target.binding;
  const descriptor = target.descriptor as unknown as RuntimeCapabilityDescriptor;
  if (!binding || !descriptor.inputSchema || !isJsonRecord(descriptor.inputSchema)) {
    return validationFailure('schema_missing', resolved.call.toolCallId, resolved.call.name);
  }
  const schemaDigest = digestCapabilityBindingValue(descriptor.inputSchema);
  if (binding.schemaDigest !== schemaDigest) {
    return validationFailure(
      'schema_digest_mismatch',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const canonical = canonicalizeCapabilityArguments(
    descriptor.inputSchema,
    resolved.call.rawArguments,
  );
  if (!canonical.ok) {
    return validationFailure(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      boundedDiagnostic(canonical.diagnostic),
    );
  }
  const canonicalValue = canonical.args as unknown as RuntimeJsonValue;
  if (!isJsonValue(canonicalValue)) {
    return validationFailure(
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const argumentsValue = freezeJson(canonicalValue);
  if (!isJsonRecord(argumentsValue)) {
    return validationFailure(
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const subjectFacts = createBuiltinDynamicMcpSubjectFacts(
    descriptor as unknown as RuntimeCapabilityDescriptor,
    resolved.call.name as `mcp__${string}`,
    {
      dynamicCatalogRevision: target.dynamicCatalogRevision,
      bindingId: binding.bindingId,
      issuedForTurnId: binding.issuedForTurnId,
      callCreatedAtTurnId: resolved.call.createdAtTurnId,
      modelMessageId: resolved.call.modelMessageId,
      argumentOrigin: 'model_public' as const,
    },
  );
  const request = Object.freeze({
    source: 'mcp' as const,
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
    name: resolved.call.name,
    arguments: argumentsValue,
    argumentsDigest: digestCapabilityBindingValue(argumentsValue),
    schemaDigest,
    approvalSummary: boundedDiagnostic(resolved.call.name),
  });
  return success({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_,
    stage: 'validated' as const,
    resolved,
    request,
    nestedCapability: null,
    domainData: subjectFacts as unknown as RuntimeJsonValue,
  });
}

function classifyDynamicMcp(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  classifiedAuthenticity: WeakSet<object>,
  validated: Readonly<ValidatedInvocation>,
): ToolClassificationResult {
  if (
    !validated ||
    validated.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ ||
    validated.stage !== 'validated'
  ) {
    return classifyFailure('invalid_stage_input', null, null);
  }
  const resolved = validated.resolved;
  const target = resolved.target as Readonly<DynamicMcpToolTarget>;
  if (
    !validResolvedDynamicMcp(projection, wrapper, resolved) ||
    validated.request.source !== 'mcp' ||
    validated.request.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_ ||
    validated.request.name !== target.subject.exposedToolName ||
    validated.request.schemaDigest !== digestCapabilityBindingValue(target.descriptor.inputSchema)
  ) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const argumentsDigest = digestCapabilityBindingValue(validated.request.arguments);
  if (validated.request.argumentsDigest !== argumentsDigest) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const descriptor = target.descriptor as unknown as RuntimeCapabilityDescriptor;
  if (!descriptor.inputSchema || !isJsonRecord(descriptor.inputSchema)) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const recanonical = canonicalizeCapabilityArguments(
    descriptor.inputSchema,
    validated.request.arguments,
  );
  if (
    !recanonical.ok ||
    !isJsonValue(recanonical.args) ||
    !isJsonRecord(recanonical.args) ||
    digestCapabilityBindingValue(recanonical.args) !== argumentsDigest
  ) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const effects = freezeEffects(descriptor.effectiveEffects);
  let policyCompilation: CapabilityPolicyCompilation;
  try {
    policyCompilation = compileBuiltinDynamicMcpPolicy({
      operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
      capabilityRevision: descriptor.revision,
      parserRevision: validated.request.schemaDigest,
      exposedToolName: target.subject.exposedToolName,
      effectiveEffects: effects,
      minimumApproval: descriptor.policy.minimumApproval,
      phase: resolved.availabilityContext.phase ?? 'building',
      workspace: resolved.availabilityContext.workspace,
    });
  } catch {
    return classifyFailure(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const effectsDigest = digestCapabilityBindingValue(effects);
  if (
    policyCompilation.schema !== CAPABILITY_POLICY_COMPILATION_SCHEMA_ ||
    policyCompilation.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_ ||
    policyCompilation.capabilityRevision !== descriptor.revision ||
    policyCompilation.parserRevision !== validated.request.schemaDigest ||
    policyCompilation.minimumApproval !== descriptor.policy.minimumApproval ||
    digestCapabilityBindingValue(policyCompilation.effectiveEffects) !== effectsDigest
  ) {
    return classifyFailure(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const capability = capabilityFromEffects(effects);
  const sideEffect = capability.sideEffect || hasMutationOrUnknownEffect(effects);
  const effectiveRisk = riskForDynamicEffects(capability.effectClass, effects);
  const requirements = invocationRequirements(descriptor, sideEffect, effects);
  const frozenPolicyCompilation = freezePolicyCompilation(policyCompilation);
  const governance = createDynamicGovernanceProjection(
    projection,
    wrapper,
    resolved,
    validated,
    frozenPolicyCompilation,
    effects,
    effectsDigest,
  );
  if (!governance) {
    return classifyFailure(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const classified: ClassifiedInvocation = {
    schema: TOOL_PIPELINE_STAGE_SCHEMA_,
    stage: 'classified' as const,
    validated,
    descriptor,
    policyCompilation: frozenPolicyCompilation,
    governance,
    effectClass: capability.effectClass,
    effectiveEffects: effects,
    effectiveEffectsDigest: effectsDigest,
    risk: effectiveRisk,
    sideEffect,
    minimumApproval: descriptor.policy.minimumApproval,
    executionTraits: null,
    requirements,
  };
  classifiedAuthenticity.add(classified);
  return success(classified);
}

function createDynamicGovernanceProjection(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  resolved: Readonly<ResolvedInvocation>,
  validated: Readonly<ValidatedInvocation>,
  policyCompilation: Readonly<CapabilityPolicyCompilation>,
  effectiveEffects: Readonly<CapabilityEffects>,
  effectiveEffectsDigest: string,
): Readonly<ToolPipelineGovernanceProjection> | null {
  if (!validResolvedDynamicMcp(projection, wrapper, resolved)) return null;
  const target = resolved.target as Readonly<DynamicMcpToolTarget>;
  const descriptor = target.descriptor as Readonly<RuntimeCapabilityDescriptor>;
  const subject = target.subject;
  const runtimeWrapper = target.runtimeWrapper;
  const invocation = Object.freeze({
    turnId: resolved.call.createdAtTurnId,
    modelMessageId: resolved.call.modelMessageId,
    toolCallId: resolved.call.toolCallId,
    argumentOrigin: resolved.call.argumentOrigin,
    executionFamily: 'mcp' as const,
    executionMechanism: 'mcp' as const,
    exposedToolName: subject.exposedToolName,
    operationId: 'mcp:dynamic_tool' as const,
    capabilityId: subject.capabilityId,
    providerId: subject.providerId,
    capabilityRevision: subject.capabilityRevision,
    executorRevision: null,
    descriptorRevision: subject.descriptorRevision,
    parserRevision: validated.request.schemaDigest,
    schemaDigest: validated.request.schemaDigest,
    argumentsDigest: validated.request.argumentsDigest,
    effectiveEffectsDigest,
    bindingId: target.binding?.bindingId ?? subject.bindingId,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    commandDigest: null,
    isDynamicMcp: true as const,
    visibility: 'internal' as const,
    modelVisible: false as const,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: target.dynamicCatalogRevision,
    subject,
    runtimeWrapper,
  });
  const dynamicMcp = Object.freeze({
    isDynamicMcp: true as const,
    subject,
    runtimeWrapper,
    minimumApproval: descriptor.policy.minimumApproval,
    readOnly: readOnlyPolicy(policyCompilation),
  });
  return Object.freeze({
    invocation,
    policy: policyCompilation,
    effectiveEffects,
    effectiveEffectsDigest,
    dynamicMcp,
    nestedSkill: null,
  });
}

function readOnlyPolicy(policy: Readonly<CapabilityPolicyCompilation>): boolean {
  return policy.decision === 'allow' && policy.risk === 'read';
}

function verifyClassifiedDynamicMcpIdentity(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  classifiedAuthenticity: WeakSet<object>,
  classified: Readonly<ClassifiedInvocation>,
): ToolPipelineClassifiedIdentityVerificationResult {
  if (
    !classified ||
    typeof classified !== 'object' ||
    !classifiedAuthenticity.has(classified as object)
  ) {
    return invalidClassifiedIdentity('governance_missing');
  }
  const governance = classified.governance;
  const validated = classified.validated;
  const resolved = validated?.resolved;
  if (
    classified.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ ||
    classified.stage !== 'classified' ||
    !governance ||
    !validated ||
    !resolved ||
    !resolved.target.isDynamicMcp ||
    governance.invocation.isDynamicMcp !== true ||
    !governance.dynamicMcp
  ) {
    return invalidClassifiedIdentity('invocation_mismatch');
  }
  if (!validResolvedDynamicMcp(projection, wrapper, resolved)) {
    return invalidClassifiedIdentity('invocation_mismatch');
  }
  const target = resolved.target as Readonly<DynamicMcpToolTarget>;
  const descriptor = target.descriptor as Readonly<RuntimeCapabilityDescriptor>;
  const subject = target.subject;
  const invocation = governance.invocation;
  if (
    invocation.turnId !== resolved.call.createdAtTurnId ||
    invocation.modelMessageId !== resolved.call.modelMessageId ||
    invocation.toolCallId !== resolved.call.toolCallId ||
    invocation.argumentOrigin !== resolved.call.argumentOrigin ||
    invocation.executionFamily !== 'mcp' ||
    invocation.executionMechanism !== 'mcp' ||
    invocation.exposedToolName !== subject.exposedToolName ||
    invocation.operationId !== 'mcp:dynamic_tool' ||
    invocation.capabilityId !== subject.capabilityId ||
    invocation.providerId !== subject.providerId ||
    invocation.capabilityRevision !== subject.capabilityRevision ||
    invocation.executorRevision !== null ||
    invocation.descriptorRevision !== subject.descriptorRevision ||
    invocation.parserRevision !== validated.request.schemaDigest ||
    invocation.schemaDigest !== validated.request.schemaDigest ||
    invocation.argumentsDigest !== validated.request.argumentsDigest ||
    invocation.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    invocation.bindingId !== (target.binding?.bindingId ?? subject.bindingId) ||
    invocation.nestedCapabilityId !== null ||
    invocation.nestedCapabilityRevision !== null ||
    invocation.nestedCatalogRevision !== null ||
    invocation.commandDigest !== null ||
    invocation.visibility !== 'internal' ||
    invocation.modelVisible !== false ||
    invocation.builtinProjectionRevision !== null ||
    invocation.dynamicCatalogRevision !== target.dynamicCatalogRevision ||
    invocation.subject !== subject ||
    invocation.runtimeWrapper !== target.runtimeWrapper
  ) {
    return invalidClassifiedIdentity('invocation_mismatch');
  }
  if (
    governance.policy !== classified.policyCompilation ||
    governance.effectiveEffects !== classified.effectiveEffects ||
    governance.effectiveEffectsDigest !== classified.effectiveEffectsDigest
  ) {
    return invalidClassifiedIdentity('effects_mismatch');
  }
  if (
    governance.nestedSkill !== null ||
    governance.dynamicMcp.subject !== subject ||
    governance.dynamicMcp.runtimeWrapper !== target.runtimeWrapper ||
    governance.dynamicMcp.minimumApproval !== descriptor.policy.minimumApproval ||
    governance.dynamicMcp.readOnly !== readOnlyPolicy(classified.policyCompilation) ||
    !Object.isFrozen(governance) ||
    !Object.isFrozen(governance.invocation) ||
    !Object.isFrozen(governance.dynamicMcp) ||
    !Object.isFrozen(governance.effectiveEffects) ||
    !Object.isFrozen(governance.policy)
  ) {
    return invalidClassifiedIdentity('dynamic_subject_mismatch');
  }
  return Object.freeze({ valid: true });
}

function verifyPreparedDynamicMcpIdentity(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  prepared: Readonly<PreparedToolInvocation>,
): ToolPipelinePreparedIdentityVerificationResult {
  const identity = prepared?.identity;
  const input = prepared?.input;
  if (!identity || !input || typeof identity !== 'object' || typeof input !== 'object') {
    return invalidIdentity('identity_mismatch');
  }
  if (!isDynamicIdentityShape(identity)) return invalidIdentity('visibility_mismatch');
  const runtimeWrapper = identity.runtimeWrapper;
  const expectedWrapper = freezeRuntimeWrapper(projection, wrapper);
  if (!sameDynamicWrapper(runtimeWrapper, expectedWrapper)) {
    return invalidIdentity('runtime_wrapper_mismatch');
  }
  const subject = identity.subject;
  if (
    subject.capabilityId !== identity.capabilityId ||
    subject.capabilityRevision !== identity.capabilityRevision ||
    subject.descriptorRevision !== identity.descriptorRevision ||
    subject.providerId !== identity.providerId ||
    subject.dynamicCatalogRevision !== identity.dynamicCatalogRevision ||
    subject.bindingId !== identity.bindingId
  ) {
    return invalidIdentity('subject_mismatch');
  }
  if (
    identity.builtinProjectionRevision !== null ||
    !SHA256_HEX_.test(identity.dynamicCatalogRevision)
  ) {
    return invalidIdentity('revision_mismatch');
  }
  if (
    input.invocationId !== identity.invocationId ||
    input.attemptId !== identity.attemptId ||
    input.toolCallId !== identity.toolCallId
  ) {
    return invalidIdentity('identity_mismatch');
  }
  if (!input.binding || !bindingMatchesDynamicSubject(input.binding, identity)) {
    return invalidIdentity('binding_mismatch');
  }
  const facts = parseDynamicMcpSubjectFacts(input.facts);
  if (!facts || !factsMatchIdentity(facts, identity, input.binding)) {
    return invalidIdentity('subject_mismatch');
  }
  const canonical = canonicalizeCapabilityArguments(facts.descriptor.inputSchema, input.arguments);
  if (!canonical.ok || !isJsonValue(canonical.args) || !isJsonRecord(canonical.args)) {
    return invalidIdentity('schema_mismatch');
  }
  const argumentsDigest = digestCapabilityBindingValue(canonical.args);
  if (identity.argumentsDigest !== argumentsDigest) {
    return invalidIdentity('arguments_mismatch');
  }
  if (
    identity.schemaDigest !== facts.schemaDigest ||
    identity.effectiveEffectsDigest !== facts.effectiveEffectsDigest ||
    identity.parserRevision !== facts.schemaDigest ||
    identity.executorRevision !== null ||
    identity.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_
  ) {
    return invalidIdentity('identity_mismatch');
  }
  if (
    identity.turnId !== facts.callCreatedAtTurnId ||
    identity.turnId !== input.binding.issuedForTurnId ||
    identity.modelMessageId !== facts.modelMessageId
  ) {
    return invalidIdentity('identity_mismatch');
  }
  const idempotencyArgument = facts.descriptor.execution?.idempotencyKeyArgument ?? null;
  const idempotencyKey =
    idempotencyArgument && typeof canonical.args[idempotencyArgument] === 'string'
      ? canonical.args[idempotencyArgument]
      : null;
  if (
    identity.idempotencyKeyArgument !== idempotencyArgument ||
    identity.idempotencyKey !== idempotencyKey
  ) {
    return invalidIdentity('identity_mismatch');
  }
  return Object.freeze({ valid: true });
}

/** Create the exact JSON facts expected in PreparedToolInvocation.input.facts. */
export function createBuiltinDynamicMcpSubjectFacts(
  descriptor: Readonly<RuntimeCapabilityDescriptor>,
  exposedToolName: `mcp__${string}`,
  identity: Readonly<BuiltinDynamicMcpSubjectFactsIdentity>,
): BuiltinDynamicMcpSubjectFacts {
  if (
    !identity.dynamicCatalogRevision ||
    !identity.bindingId ||
    !identity.issuedForTurnId ||
    !identity.callCreatedAtTurnId ||
    !identity.modelMessageId ||
    identity.argumentOrigin !== 'model_public' ||
    !exposedToolName.startsWith('mcp__')
  ) {
    throw new Error('Dynamic MCP subject fact identity is invalid.');
  }
  if (!isDynamicMcpSubjectDescriptor(descriptor) || descriptor.availability !== 'available') {
    throw new Error('Dynamic MCP subject descriptor is invalid.');
  }
  if (!descriptor.inputSchema || !isJsonRecord(descriptor.inputSchema)) {
    throw new Error('Dynamic MCP subject descriptor has no JSON input schema.');
  }
  const frozenDescriptor = freezeRuntimeDescriptor(descriptor);
  const effects = freezeEffects(descriptor.effectiveEffects);
  const schemaDigest = digestCapabilityBindingValue(descriptor.inputSchema);
  return Object.freeze({
    schema: BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    descriptorRevision: descriptor.revision,
    descriptorDigest: digestCapabilityBindingValue(frozenDescriptor),
    providerId: descriptor.provider.id,
    providerType: 'mcp' as const,
    kind: 'mcp_tool' as const,
    exposedToolName,
    availability: 'available' as const,
    schemaDigest,
    effectiveEffects: effects,
    effectiveEffectsDigest: digestCapabilityBindingValue(effects),
    minimumApproval: descriptor.policy.minimumApproval,
    dynamicCatalogRevision: identity.dynamicCatalogRevision,
    bindingId: identity.bindingId,
    issuedForTurnId: identity.issuedForTurnId,
    callCreatedAtTurnId: identity.callCreatedAtTurnId,
    modelMessageId: identity.modelMessageId,
    argumentOrigin: 'model_public' as const,
    descriptor: frozenDescriptor,
  });
}

function validResolvedDynamicMcp(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
  resolved: Readonly<ResolvedInvocation>,
): boolean {
  if (
    !resolved ||
    typeof resolved !== 'object' ||
    !resolved.call ||
    typeof resolved.call !== 'object' ||
    typeof resolved.call.name !== 'string' ||
    resolved.call.argumentOrigin !== 'model_public' ||
    !resolved.target ||
    typeof resolved.target !== 'object'
  ) {
    return false;
  }
  if (
    resolved.builtinProjectionRevision !== projection.revision ||
    typeof resolved.dynamicCatalogRevision !== 'string' ||
    resolved.dynamicCatalogRevision.length === 0
  ) {
    return false;
  }
  const target = resolved.target;
  if (
    target.isDynamicMcp !== true ||
    target.executionFamily !== 'mcp' ||
    target.executionMechanism !== 'mcp' ||
    target.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_ ||
    target.visibility !== 'internal' ||
    target.modelVisible !== false ||
    target.exposedToolName !== null ||
    target.executorRevision !== null ||
    target.builtinProjectionRevision !== null ||
    target.dynamicCatalogRevision !== resolved.dynamicCatalogRevision ||
    target.toolKind !== 'computer'
  ) {
    return false;
  }
  const dynamicTarget = target as Readonly<DynamicMcpToolTarget>;
  if (
    !isDynamicSubjectShape(dynamicTarget.subject) ||
    !isDynamicWrapperShape(dynamicTarget.runtimeWrapper)
  ) {
    return false;
  }
  const descriptor = dynamicTarget.descriptor as unknown as RuntimeCapabilityDescriptor;
  const binding = dynamicTarget.binding;
  if (
    !binding ||
    !isDynamicMcpSubjectDescriptor(descriptor) ||
    descriptor.availability !== 'available' ||
    !descriptor.inputSchema ||
    !isJsonRecord(descriptor.inputSchema) ||
    !validBindingId(binding) ||
    digestCapabilityBindingValue(descriptor.inputSchema) !== binding.schemaDigest
  ) {
    return false;
  }
  const expectedWrapper = freezeRuntimeWrapper(projection, wrapper);
  if (!sameDynamicWrapper(dynamicTarget.runtimeWrapper, expectedWrapper)) return false;
  const subject = dynamicTarget.subject;
  return (
    subject.capabilityId === dynamicTarget.capabilityId &&
    subject.capabilityRevision === dynamicTarget.capabilityRevision &&
    subject.descriptorRevision === dynamicTarget.descriptorRevision &&
    subject.providerId === dynamicTarget.providerId &&
    subject.exposedToolName.startsWith('mcp__') &&
    subject.exposedToolName === resolved.call.name &&
    subject.dynamicCatalogRevision === resolved.dynamicCatalogRevision &&
    subject.bindingId === binding.bindingId &&
    resolved.call.bindingId === binding.bindingId &&
    resolved.call.capabilityId === subject.capabilityId &&
    resolved.call.capabilityRevision === subject.capabilityRevision &&
    binding.exposedToolName === subject.exposedToolName &&
    binding.capabilityId === subject.capabilityId &&
    binding.capabilityRevision === subject.capabilityRevision &&
    binding.issuedForTurnId === resolved.call.createdAtTurnId &&
    descriptor.capabilityId === subject.capabilityId &&
    descriptor.revision === subject.capabilityRevision &&
    descriptor.revision === subject.descriptorRevision &&
    descriptor.provider.id === subject.providerId
  );
}

function isDynamicIdentityShape(
  identity: Readonly<PreparedToolInvocation['identity']>,
): identity is Readonly<DynamicMcpPreparedToolInvocationIdentity> {
  return (
    identity.isDynamicMcp === true &&
    identity.executionFamily === 'mcp' &&
    identity.executionMechanism === 'mcp' &&
    identity.operationId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_ &&
    identity.visibility === 'internal' &&
    identity.modelVisible === false &&
    identity.exposedToolName === null &&
    identity.executorRevision === null &&
    identity.builtinProjectionRevision === null &&
    typeof identity.dynamicCatalogRevision === 'string' &&
    SHA256_HEX_.test(identity.dynamicCatalogRevision) &&
    typeof identity.turnId === 'string' &&
    identity.turnId.length > 0 &&
    typeof identity.modelMessageId === 'string' &&
    identity.modelMessageId.length > 0 &&
    identity.argumentOrigin === 'model_public' &&
    isDynamicSubjectShape(identity.subject) &&
    isDynamicWrapperShape(identity.runtimeWrapper)
  );
}

function isDynamicSubjectShape(value: unknown): value is Readonly<DynamicMcpSubjectIdentity> {
  if (!value || typeof value !== 'object') return false;
  const subject = value as Record<string, unknown>;
  return (
    typeof subject.capabilityId === 'string' &&
    subject.capabilityId.length > 0 &&
    typeof subject.capabilityRevision === 'string' &&
    subject.capabilityRevision.length > 0 &&
    typeof subject.descriptorRevision === 'string' &&
    subject.descriptorRevision.length > 0 &&
    typeof subject.providerId === 'string' &&
    subject.providerId.length > 0 &&
    typeof subject.exposedToolName === 'string' &&
    subject.exposedToolName.startsWith('mcp__') &&
    typeof subject.dynamicCatalogRevision === 'string' &&
    SHA256_HEX_.test(subject.dynamicCatalogRevision) &&
    typeof subject.bindingId === 'string' &&
    subject.bindingId.length > 0
  );
}

function isDynamicWrapperShape(
  value: unknown,
): value is Readonly<DynamicMcpRuntimeWrapperIdentity> {
  if (!value || typeof value !== 'object') return false;
  const wrapper = value as Record<string, unknown>;
  return (
    wrapper.operationId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_ &&
    wrapper.capabilityId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_ &&
    typeof wrapper.providerId === 'string' &&
    wrapper.providerId.length > 0 &&
    typeof wrapper.capabilityRevision === 'string' &&
    wrapper.capabilityRevision.length > 0 &&
    typeof wrapper.executorRevision === 'string' &&
    wrapper.executorRevision.length > 0 &&
    typeof wrapper.schemaDigest === 'string' &&
    wrapper.schemaDigest.length > 0 &&
    typeof wrapper.builtinProjectionRevision === 'string' &&
    wrapper.builtinProjectionRevision.length > 0
  );
}

function sameDynamicWrapper(
  actual: Readonly<DynamicMcpRuntimeWrapperIdentity>,
  expected: Readonly<DynamicMcpRuntimeWrapperIdentity>,
): boolean {
  return (
    actual.operationId === expected.operationId &&
    actual.capabilityId === expected.capabilityId &&
    actual.providerId === expected.providerId &&
    actual.capabilityRevision === expected.capabilityRevision &&
    actual.executorRevision === expected.executorRevision &&
    actual.schemaDigest === expected.schemaDigest &&
    actual.builtinProjectionRevision === expected.builtinProjectionRevision
  );
}

function bindingMatchesDynamicSubject(
  binding: Readonly<CapabilityBinding | import('@kite/runtime-contract').CapabilityBinding>,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentity>,
): boolean {
  return (
    binding.bindingId === identity.bindingId &&
    binding.capabilityId === identity.subject.capabilityId &&
    binding.capabilityRevision === identity.subject.capabilityRevision &&
    binding.exposedToolName === identity.subject.exposedToolName &&
    binding.schemaDigest === identity.schemaDigest &&
    validBindingId(binding)
  );
}

function factsMatchIdentity(
  facts: BuiltinDynamicMcpSubjectFacts,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentity>,
  binding: Readonly<CapabilityBinding | import('@kite/runtime-contract').CapabilityBinding>,
): boolean {
  const descriptor = facts.descriptor;
  const effectsDigest = digestCapabilityBindingValue(descriptor.effectiveEffects);
  if (
    !isDynamicMcpSubjectDescriptor(descriptor) ||
    descriptor.availability !== 'available' ||
    !descriptor.inputSchema ||
    !isJsonRecord(descriptor.inputSchema) ||
    descriptor.kind !== facts.kind ||
    descriptor.provider.type !== facts.providerType ||
    descriptor.provider.id !== facts.providerId ||
    descriptor.policy.minimumApproval !== facts.minimumApproval ||
    effectsDigest !== facts.effectiveEffectsDigest ||
    digestCapabilityBindingValue(facts.effectiveEffects) !== facts.effectiveEffectsDigest ||
    facts.schemaDigest !== digestCapabilityBindingValue(descriptor.inputSchema) ||
    facts.bindingId !== identity.bindingId ||
    facts.dynamicCatalogRevision !== identity.dynamicCatalogRevision ||
    facts.issuedForTurnId !== binding.issuedForTurnId ||
    facts.callCreatedAtTurnId !== binding.issuedForTurnId ||
    facts.callCreatedAtTurnId !== identity.turnId ||
    facts.modelMessageId !== identity.modelMessageId ||
    facts.argumentOrigin !== 'model_public' ||
    identity.argumentOrigin !== 'model_public'
  ) {
    return false;
  }
  return (
    facts.capabilityId === identity.subject.capabilityId &&
    facts.capabilityRevision === identity.subject.capabilityRevision &&
    facts.descriptorRevision === identity.subject.descriptorRevision &&
    facts.providerId === identity.subject.providerId &&
    facts.exposedToolName === identity.subject.exposedToolName &&
    facts.schemaDigest === identity.schemaDigest &&
    facts.effectiveEffectsDigest === identity.effectiveEffectsDigest &&
    descriptor.revision === identity.descriptorRevision &&
    descriptor.capabilityId === identity.capabilityId &&
    descriptor.provider.id === identity.providerId &&
    digestCapabilityBindingValue(descriptor) === facts.descriptorDigest &&
    descriptorRevisionIsValid(descriptor) &&
    facts.bindingId === binding.bindingId &&
    facts.exposedToolName === binding.exposedToolName
  );
}

function parseDynamicMcpSubjectFacts(
  value: RuntimeJsonValue | undefined,
): BuiltinDynamicMcpSubjectFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const factKeys = new Set([
    'schema',
    'capabilityId',
    'capabilityRevision',
    'descriptorRevision',
    'descriptorDigest',
    'providerId',
    'providerType',
    'kind',
    'exposedToolName',
    'availability',
    'schemaDigest',
    'effectiveEffects',
    'effectiveEffectsDigest',
    'minimumApproval',
    'dynamicCatalogRevision',
    'bindingId',
    'issuedForTurnId',
    'callCreatedAtTurnId',
    'modelMessageId',
    'argumentOrigin',
    'descriptor',
  ]);
  if (Object.keys(record).some((key) => !factKeys.has(key))) return null;
  const descriptor = record.descriptor;
  if (
    record.schema !== BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_ ||
    typeof record.capabilityId !== 'string' ||
    typeof record.capabilityRevision !== 'string' ||
    typeof record.descriptorRevision !== 'string' ||
    typeof record.descriptorDigest !== 'string' ||
    typeof record.providerId !== 'string' ||
    record.providerType !== 'mcp' ||
    record.kind !== 'mcp_tool' ||
    typeof record.exposedToolName !== 'string' ||
    !record.exposedToolName.startsWith('mcp__') ||
    record.availability !== 'available' ||
    typeof record.schemaDigest !== 'string' ||
    !isJsonRecordUnknown(record.effectiveEffects) ||
    typeof record.effectiveEffectsDigest !== 'string' ||
    !isApproval(record.minimumApproval) ||
    typeof record.dynamicCatalogRevision !== 'string' ||
    !SHA256_HEX_.test(record.dynamicCatalogRevision) ||
    typeof record.bindingId !== 'string' ||
    record.bindingId.length === 0 ||
    typeof record.issuedForTurnId !== 'string' ||
    record.issuedForTurnId.length === 0 ||
    typeof record.callCreatedAtTurnId !== 'string' ||
    record.callCreatedAtTurnId.length === 0 ||
    typeof record.modelMessageId !== 'string' ||
    record.modelMessageId.length === 0 ||
    record.argumentOrigin !== 'model_public' ||
    !isJsonRecordUnknown(descriptor)
  ) {
    return null;
  }
  if (
    !isEffectLevel(record.effectiveEffects.filesystem) ||
    !isEffectLevel(record.effectiveEffects.network) ||
    !isEffectLevel(record.effectiveEffects.externalState)
  ) {
    return null;
  }
  const candidate = {
    schema: BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_,
    capabilityId: record.capabilityId,
    capabilityRevision: record.capabilityRevision,
    descriptorRevision: record.descriptorRevision,
    descriptorDigest: record.descriptorDigest,
    providerId: record.providerId,
    providerType: 'mcp' as const,
    kind: 'mcp_tool' as const,
    exposedToolName: record.exposedToolName as `mcp__${string}`,
    availability: 'available' as const,
    schemaDigest: record.schemaDigest,
    effectiveEffects: {
      filesystem: record.effectiveEffects.filesystem,
      network: record.effectiveEffects.network,
      externalState: record.effectiveEffects.externalState,
    },
    effectiveEffectsDigest: record.effectiveEffectsDigest,
    minimumApproval: record.minimumApproval,
    dynamicCatalogRevision: record.dynamicCatalogRevision,
    bindingId: record.bindingId,
    issuedForTurnId: record.issuedForTurnId,
    callCreatedAtTurnId: record.callCreatedAtTurnId,
    modelMessageId: record.modelMessageId,
    argumentOrigin: 'model_public' as const,
    descriptor: descriptor as unknown as RuntimeCapabilityDescriptor,
  } satisfies BuiltinDynamicMcpSubjectFacts;
  return candidate;
}

function isDynamicMcpSubjectDescriptor(
  descriptor: Readonly<ToolPipelineCapabilityDescriptor>,
): descriptor is Readonly<RuntimeCapabilityDescriptor> {
  if (!descriptor || typeof descriptor !== 'object') return false;
  const candidate = descriptor as Readonly<RuntimeCapabilityDescriptor>;
  return (
    candidate.kind === 'mcp_tool' &&
    candidate.provider?.type === 'mcp' &&
    typeof candidate.provider.id === 'string' &&
    candidate.provider.id.length > 0 &&
    typeof candidate.capabilityId === 'string' &&
    candidate.capabilityId.length > 0 &&
    typeof candidate.revision === 'string' &&
    candidate.revision.length > 0 &&
    isJsonValue(candidate) &&
    descriptorRevisionIsValid(candidate) &&
    (candidate.inputSchema === undefined || isJsonRecord(candidate.inputSchema))
  );
}

function descriptorRevisionIsValid(descriptor: Readonly<RuntimeCapabilityDescriptor>): boolean {
  const { revision: _revision, ...withoutRevision } = descriptor;
  return digestCapabilityBindingValue(withoutRevision) === descriptor.revision;
}

function validBindingId(
  binding: Readonly<CapabilityBinding | import('@kite/runtime-contract').CapabilityBinding>,
): boolean {
  return (
    typeof binding.bindingId === 'string' &&
    binding.bindingId ===
      digestCapabilityBindingValue({
        capabilityId: binding.capabilityId,
        revision: binding.capabilityRevision,
        exposedToolName: binding.exposedToolName,
        schemaDigest: binding.schemaDigest,
        turnId: binding.issuedForTurnId,
      })
  );
}

function validDynamicResolutionContext(
  projection: Readonly<BuiltinToolCatalogProjection>,
  context: Readonly<ToolPipelineResolutionContext>,
): boolean {
  if (
    !context ||
    typeof context.currentTurnId !== 'string' ||
    context.currentTurnId.length === 0 ||
    context.builtinProjectionRevision !== projection.revision ||
    typeof context.dynamicCatalogRevision !== 'string' ||
    !SHA256_HEX_.test(context.dynamicCatalogRevision) ||
    !context.availabilityContext ||
    typeof context.availabilityContext.workspace !== 'string' ||
    !Array.isArray(context.bindings) ||
    !Array.isArray(context.descriptors) ||
    !Array.isArray(context.disclosures ?? [])
  ) {
    return false;
  }
  return (
    !hasDuplicateKey(context.bindings, (item) => item.bindingId) &&
    !hasDuplicateKey(context.bindings, (item) => item.exposedToolName) &&
    !hasDuplicateKey(context.descriptors, (item) => item.capabilityId)
  );
}

function freezeRuntimeWrapper(
  projection: Readonly<BuiltinToolCatalogProjection>,
  wrapper: BuiltinInternalOperationCatalogEntry,
): Readonly<DynamicMcpRuntimeWrapperIdentity> {
  return Object.freeze({
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
    capabilityId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
    providerId: wrapper.providerId,
    capabilityRevision: wrapper.revision,
    executorRevision: wrapper.executorRevision,
    schemaDigest: digestCapabilityBindingValue(wrapper.inputSchema ?? {}),
    builtinProjectionRevision: projection.revision,
  });
}

function freezeDynamicSubject(
  value: DynamicMcpSubjectIdentity,
): Readonly<DynamicMcpSubjectIdentity> {
  return Object.freeze({ ...value });
}

function freezeRuntimeDescriptor(
  descriptor: Readonly<RuntimeCapabilityDescriptor>,
): Readonly<RuntimeCapabilityDescriptor> {
  return freezeJson(
    descriptor as unknown as RuntimeJsonValue,
  ) as unknown as RuntimeCapabilityDescriptor;
}

function freezeBinding(
  binding: Readonly<ToolPipelineCapabilityBinding>,
): Readonly<ToolPipelineCapabilityBinding> {
  return freezeJson(binding as unknown as RuntimeJsonValue) as ToolPipelineCapabilityBinding;
}

function freezeToolCall(call: Readonly<ToolCallSnapshot>): Readonly<ToolCallSnapshot> {
  return freezeJson(call as unknown as RuntimeJsonValue) as unknown as ToolCallSnapshot;
}

function freezeAvailabilityContext(
  context: Readonly<import('@kite/runtime-spi').CapabilityAvailabilityContext>,
): Readonly<import('@kite/runtime-spi').CapabilityAvailabilityContext> {
  return freezeJson(
    context as unknown as RuntimeJsonValue,
  ) as unknown as import('@kite/runtime-spi').CapabilityAvailabilityContext;
}

function freezeEffects(value: CapabilityEffects): Readonly<CapabilityEffects> {
  return Object.freeze({
    filesystem: value.filesystem,
    network: value.network,
    externalState: value.externalState,
  });
}

function freezePolicyCompilation(
  value: CapabilityPolicyCompilation,
): Readonly<CapabilityPolicyCompilation> {
  return Object.freeze({
    ...value,
    ...(value.effects ? { effects: Object.freeze({ ...value.effects }) } : {}),
    effectiveEffects: freezeEffects(value.effectiveEffects),
    expectedEffects: Object.freeze([...value.expectedEffects]),
  });
}

function freezeJsonArray<T>(value: readonly T[]): readonly T[] {
  return Object.freeze(
    value.map((item) => freezeJson(item as unknown as RuntimeJsonValue)),
  ) as readonly T[];
}

function freezeJson(value: RuntimeJsonValue): RuntimeJsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)));
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJson(item)])),
    ) as RuntimeJsonValue;
  }
  return value;
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, RuntimeJsonValue>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJsonValue(value: unknown): value is RuntimeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
}

function isJsonRecordUnknown(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isEffectLevel(value: unknown): value is CapabilityEffects[keyof CapabilityEffects] {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isApproval(value: unknown): value is CapabilityApproval {
  return value === 'none' || value === 'auto_review' || value === 'user';
}

function uniqueMatch<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | 'duplicate' | null {
  const matches = items.filter(predicate);
  if (matches.length > 1) return 'duplicate';
  return matches[0] ?? null;
}

function hasDuplicateKey<T, K>(items: readonly T[], keyOf: (item: T) => K): boolean {
  const keys = new Set<K>();
  for (const item of items) {
    const key = keyOf(item);
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function capabilityFromEffects(effects: CapabilityEffects) {
  const levels = [effects.filesystem, effects.network, effects.externalState];
  if (levels.every((level) => level === 'none' || level === 'read')) {
    return {
      effectClass: 'read_only' as const,
      sideEffect: false,
      classificationReason: 'Resolved MCP capability effects.',
    };
  }
  return {
    effectClass: 'external_side_effect' as const,
    sideEffect: true,
    classificationReason: 'Resolved MCP capability effects.',
  };
}

function riskForDynamicEffects(
  effectClass: ReturnType<typeof capabilityFromEffects>['effectClass'],
  effects: CapabilityEffects,
): ClassifiedInvocation['risk'] {
  if (Object.values(effects).some((effect) => effect === 'destructive')) return 'destructive';
  if (effects.filesystem === 'write') return 'workspace_write';
  if (effects.network === 'read' || effects.network === 'write') return 'network';
  if (effects.externalState === 'read' || effects.externalState === 'write')
    return 'external_state';
  if (effectClass === 'read_only') return 'read';
  return 'execute';
}

function invocationRequirements(
  descriptor: Readonly<RuntimeCapabilityDescriptor>,
  sideEffect: boolean,
  effects: CapabilityEffects,
) {
  const receipt =
    sideEffect || hasMutationOrUnknownEffect(effects)
      ? ('effect_receipt' as const)
      : ('observation_receipt' as const);
  const retry =
    descriptor.execution?.retry === 'idempotency_key'
      ? ('idempotency_key_candidate' as const)
      : descriptor.execution?.retry === 'safe_read' || receipt === 'observation_receipt'
        ? ('safe_read_candidate' as const)
        : ('none' as const);
  return Object.freeze({
    intent: 'required_before_dispatch' as const,
    receipt,
    retry,
    idempotencyKeyArgument: descriptor.execution?.idempotencyKeyArgument ?? null,
    verification:
      receipt === 'effect_receipt'
        ? ('after_committed_receipt' as const)
        : ('not_required_by_classification' as const),
  });
}

function hasMutationOrUnknownEffect(effects: CapabilityEffects): boolean {
  return Object.values(effects).some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function resolveFailure(
  code: ToolPipelineResolveFailureCode,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolResolutionResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({
      stage: 'resolve' as const,
      code,
      toolCallId,
      toolName,
      ...(diagnostic ? { diagnostic: boundedDiagnostic(diagnostic) } : {}),
    }),
  });
}

function validationFailure(
  code: ToolPipelineValidateFailureCode,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolValidationResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({
      stage: 'validate' as const,
      code,
      toolCallId,
      toolName,
      ...(diagnostic ? { diagnostic: boundedDiagnostic(diagnostic) } : {}),
    }),
  });
}

function classifyFailure(
  code: 'invalid_stage_input' | 'stage_identity_drift' | 'classification_unavailable',
  toolCallId: string | null,
  toolName: string | null,
): ToolClassificationResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ stage: 'classify' as const, code, toolCallId, toolName }),
  });
}

function success<T>(value: T): { readonly ok: true; readonly value: Readonly<T> } {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function invalidIdentity(
  code:
    | 'identity_mismatch'
    | 'revision_mismatch'
    | 'schema_mismatch'
    | 'visibility_mismatch'
    | 'subject_mismatch'
    | 'runtime_wrapper_mismatch'
    | 'arguments_mismatch'
    | 'binding_mismatch',
): ToolPipelinePreparedIdentityVerificationResult {
  return Object.freeze({ valid: false as const, code });
}

function invalidClassifiedIdentity(
  code: Extract<
    ToolPipelineClassifiedIdentityVerificationResult,
    { readonly valid: false }
  >['code'],
): ToolPipelineClassifiedIdentityVerificationResult {
  return Object.freeze({ valid: false as const, code });
}

function boundedDiagnostic(value: string): string {
  return Array.from(value).slice(0, 160).join('');
}

function assertFrozenProjection(projection: Readonly<BuiltinToolCatalogProjection>): void {
  if (
    !projection ||
    typeof projection !== 'object' ||
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.entries) ||
    !Object.isFrozen(projection.toolSet) ||
    typeof projection.revision !== 'string' ||
    projection.revision.length === 0
  ) {
    throw new Error('Dynamic MCP callbacks require a frozen Builtin projection.');
  }
  const operationIds = new Set<string>();
  for (const entry of projection.entries) {
    if (!entry || typeof entry !== 'object' || operationIds.has(entry.operationId)) {
      throw new Error('Builtin projection operation identities are not unique.');
    }
    operationIds.add(entry.operationId);
  }
}
