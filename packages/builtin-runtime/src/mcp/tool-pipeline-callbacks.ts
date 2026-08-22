import type { CapabilityDescriptor as RuntimeCapabilityDescriptor } from '@kite/runtime-contract';
import type {
  CapabilityApprovalV1,
  CapabilityBindingV1,
  CapabilityEffectsV1,
  CapabilityPolicyCompilationV1,
  ClassifiedInvocationV1,
  DynamicMcpPreparedToolInvocationIdentityV1,
  DynamicMcpRuntimeWrapperIdentityV1,
  DynamicMcpSubjectIdentityV1,
  DynamicMcpToolTargetV1,
  PreparedToolInvocationV1,
  ResolvedInvocationV1,
  RuntimeJsonValueV1,
  ToolArgumentOriginV1,
  ToolCallSnapshotV1,
  ToolClassificationResultV1,
  ToolPipelineCapabilityBindingV1,
  ToolPipelineCapabilityDescriptorV1,
  ToolPipelineClassifiedIdentityVerificationResultV1,
  ToolPipelineClassifiedIdentityVerifierV1,
  ToolPipelineGovernanceProjectionV1,
  ToolPipelinePreparedIdentityVerificationResultV1,
  ToolPipelinePreparedIdentityVerifierV1,
  ToolPipelineResolutionContextV1,
  ToolPipelineResolveFailureCodeV1,
  ToolPipelineValidateFailureCodeV1,
  ToolResolutionResultV1,
  ToolValidationResultV1,
  ValidatedInvocationV1,
} from '@kite/runtime-spi';
import {
  CAPABILITY_POLICY_COMPILATION_SCHEMA_V1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from '../capability-binding';
import {
  BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
  compileBuiltinDynamicMcpPolicyV1,
} from '../policy-compiler';
import type {
  BuiltinInternalOperationCatalogEntryV1,
  BuiltinToolCatalogProjectionV1,
} from '../tool-catalog';
import { canonicalizeCapabilityArguments as canonicalizeCapabilityArgumentsV1 } from './capability-domain';

/** Stable JSON facts carried from MCP resolution to Host prepared identity. */
export const BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_V1 =
  'kite.builtin-runtime.dynamic-mcp-subject-facts.v1' as const;
const SHA256_HEX_V1 = /^[0-9a-f]{64}$/u;

export interface BuiltinDynamicMcpSubjectFactsV1 {
  readonly schema: typeof BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_V1;
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
  readonly effectiveEffects: CapabilityEffectsV1;
  readonly effectiveEffectsDigest: string;
  readonly minimumApproval: CapabilityApprovalV1;
  readonly dynamicCatalogRevision: string;
  readonly bindingId: string;
  readonly issuedForTurnId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: Extract<ToolArgumentOriginV1, 'model_public'>;
  readonly descriptor: Readonly<RuntimeCapabilityDescriptor>;
}

export interface BuiltinDynamicMcpSubjectFactsIdentityV1 {
  readonly dynamicCatalogRevision: string;
  readonly bindingId: string;
  readonly issuedForTurnId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: Extract<ToolArgumentOriginV1, 'model_public'>;
}

export interface BuiltinDynamicMcpToolPipelineCallbacksV1 {
  readonly resolve: (
    call: Readonly<ToolCallSnapshotV1>,
    context: Readonly<ToolPipelineResolutionContextV1>,
  ) => ToolResolutionResultV1;
  readonly validate: (resolved: Readonly<ResolvedInvocationV1>) => ToolValidationResultV1;
  readonly classify: (validated: Readonly<ValidatedInvocationV1>) => ToolClassificationResultV1;
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1;
  readonly verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifierV1;
}

/**
 * Build the package-internal dynamic MCP callback surface from exactly one
 * frozen Builtin projection. The callback owns no MCP runtime, registry,
 * executor, Store, Host, Kernel, or App object.
 */
export function createBuiltinDynamicMcpToolPipelineCallbacksV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
): BuiltinDynamicMcpToolPipelineCallbacksV1 {
  const wrapper = captureDynamicMcpWrapperV1(projection);
  const classifiedAuthenticityV1 = new WeakSet<object>();

  const callbacks: BuiltinDynamicMcpToolPipelineCallbacksV1 = {
    resolve: (call, context) => resolveDynamicMcpV1(projection, wrapper, call, context),
    validate: (resolved) => validateDynamicMcpV1(projection, wrapper, resolved),
    classify: (validated) =>
      classifyDynamicMcpV1(projection, wrapper, classifiedAuthenticityV1, validated),
    verifyPreparedIdentity: (prepared) =>
      verifyPreparedDynamicMcpIdentityV1(projection, wrapper, prepared),
    verifyClassifiedIdentity: (classified) =>
      verifyClassifiedDynamicMcpIdentityV1(
        projection,
        wrapper,
        classifiedAuthenticityV1,
        classified,
      ),
  };
  return Object.freeze(callbacks);
}

function captureDynamicMcpWrapperV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
): BuiltinInternalOperationCatalogEntryV1 {
  assertFrozenProjectionV1(projection);
  const matches = projection.entries.filter(
    (entry): entry is BuiltinInternalOperationCatalogEntryV1 =>
      entry.visibility === 'internal' && entry.operationId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
  );
  if (matches.length !== 1) {
    throw new Error('Builtin dynamic MCP callback requires one internal wrapper operation.');
  }
  const wrapper = matches[0]!;
  if (
    wrapper.capabilityId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 ||
    wrapper.executionMechanism !== 'mcp' ||
    wrapper.kind !== 'internal_runtime' ||
    wrapper.executorRevision.length === 0 ||
    !wrapper.inputSchema ||
    !isJsonRecordV1(wrapper.inputSchema) ||
    wrapper.providerId.length === 0 ||
    wrapper.revision.length === 0 ||
    wrapper.descriptor.kind !== 'internal_runtime' ||
    wrapper.descriptor.provider.type !== 'builtin' ||
    wrapper.availability !== 'available'
  ) {
    throw new Error('Builtin dynamic MCP wrapper identity is invalid.');
  }
  const wrapperSchemaDigest = digestCapabilityBindingValueV1(wrapper.inputSchema);
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

function resolveDynamicMcpV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  call: Readonly<ToolCallSnapshotV1>,
  context: Readonly<ToolPipelineResolutionContextV1>,
): ToolResolutionResultV1 {
  if (call.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || call.stage !== 'snapshot') {
    return resolveFailureV1('invalid_stage_input', null, null);
  }
  if (!validDynamicResolutionContextV1(projection, context)) {
    return resolveFailureV1('resolution_context_invalid', call.toolCallId, call.name);
  }
  const dynamicCatalogRevision = context.dynamicCatalogRevision;
  if (typeof dynamicCatalogRevision !== 'string') {
    return resolveFailureV1('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (call.createdAtTurnId !== context.currentTurnId) {
    return resolveFailureV1('call_turn_mismatch', call.toolCallId, call.name);
  }
  if (call.argumentOrigin !== 'model_public') {
    return resolveFailureV1('unknown_tool', call.toolCallId, call.name);
  }
  if (!call.name.startsWith('mcp__') || call.name.length <= 'mcp__'.length) {
    return resolveFailureV1('unknown_tool', call.toolCallId, call.name);
  }
  if (!call.bindingId || !call.capabilityId || !call.capabilityRevision) {
    return resolveFailureV1('binding_missing', call.toolCallId, call.name);
  }

  const binding = uniqueMatchV1(
    context.bindings,
    (candidate) => candidate.bindingId === call.bindingId,
  );
  if (binding === 'duplicate') {
    return resolveFailureV1('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (!binding) return resolveFailureV1('binding_missing', call.toolCallId, call.name);
  if (
    binding.bindingId !== call.bindingId ||
    binding.capabilityId !== call.capabilityId ||
    binding.capabilityRevision !== call.capabilityRevision
  ) {
    return resolveFailureV1('binding_identity_mismatch', call.toolCallId, call.name);
  }
  if (binding.issuedForTurnId !== call.createdAtTurnId) {
    return resolveFailureV1('binding_turn_mismatch', call.toolCallId, call.name);
  }
  if (binding.exposedToolName !== call.name || !binding.exposedToolName.startsWith('mcp__')) {
    return resolveFailureV1('binding_name_mismatch', call.toolCallId, call.name);
  }
  if (!validBindingIdV1(binding)) {
    return resolveFailureV1('binding_identity_mismatch', call.toolCallId, call.name);
  }

  const descriptor = uniqueMatchV1(
    context.descriptors,
    (candidate) => candidate.capabilityId === binding.capabilityId,
  );
  if (descriptor === 'duplicate') {
    return resolveFailureV1('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (!descriptor) return resolveFailureV1('descriptor_missing', call.toolCallId, call.name);
  if (descriptor.revision !== binding.capabilityRevision) {
    return resolveFailureV1('descriptor_revision_mismatch', call.toolCallId, call.name);
  }
  if (!isDynamicMcpSubjectDescriptorV1(descriptor)) {
    return resolveFailureV1('descriptor_kind_mismatch', call.toolCallId, call.name);
  }
  if (descriptor.availability !== 'available') {
    return resolveFailureV1('descriptor_unavailable', call.toolCallId, call.name);
  }
  if (!descriptor.inputSchema || !isJsonRecordV1(descriptor.inputSchema)) {
    return resolveFailureV1('descriptor_revision_mismatch', call.toolCallId, call.name);
  }
  if (digestCapabilityBindingValueV1(descriptor.inputSchema) !== binding.schemaDigest) {
    return resolveFailureV1('binding_identity_mismatch', call.toolCallId, call.name);
  }

  const subject = freezeDynamicSubjectV1({
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    descriptorRevision: descriptor.revision,
    providerId: descriptor.provider.id,
    exposedToolName: call.name as `mcp__${string}`,
    dynamicCatalogRevision,
    bindingId: binding.bindingId,
  });
  const runtimeWrapper = freezeRuntimeWrapperV1(projection, wrapper);
  const target: Readonly<DynamicMcpToolTargetV1> = Object.freeze({
    executionFamily: 'mcp' as const,
    executionMechanism: 'mcp' as const,
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
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
    binding: freezeBindingV1(binding),
    descriptor: freezeRuntimeDescriptorV1(descriptor),
    builtinProjectionRevision: null,
    dynamicCatalogRevision,
    subject,
    runtimeWrapper,
  });
  return successV1({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'resolved' as const,
    call: freezeToolCallV1(call),
    target,
    availabilityContext: freezeAvailabilityContextV1(context.availabilityContext),
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision,
    disclosedCapabilities: freezeJsonArrayV1(context.descriptors),
    disclosures: freezeJsonArrayV1(context.disclosures ?? []),
  });
}

function validateDynamicMcpV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  resolved: Readonly<ResolvedInvocationV1>,
): ToolValidationResultV1 {
  const target = resolved?.target as Readonly<DynamicMcpToolTargetV1>;
  if (
    !resolved ||
    resolved.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 ||
    resolved.stage !== 'resolved'
  ) {
    return validationFailureV1('invalid_stage_input', null, null);
  }
  if (!validResolvedDynamicMcpV1(projection, wrapper, resolved)) {
    return validationFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const binding = target.binding;
  const descriptor = target.descriptor as unknown as RuntimeCapabilityDescriptor;
  if (!binding || !descriptor.inputSchema || !isJsonRecordV1(descriptor.inputSchema)) {
    return validationFailureV1('schema_missing', resolved.call.toolCallId, resolved.call.name);
  }
  const schemaDigest = digestCapabilityBindingValueV1(descriptor.inputSchema);
  if (binding.schemaDigest !== schemaDigest) {
    return validationFailureV1(
      'schema_digest_mismatch',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const canonical = canonicalizeCapabilityArgumentsV1(
    descriptor.inputSchema,
    resolved.call.rawArguments,
  );
  if (!canonical.ok) {
    return validationFailureV1(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      boundedDiagnosticV1(canonical.diagnostic),
    );
  }
  const canonicalValue = canonical.args as unknown as RuntimeJsonValueV1;
  if (!isJsonValueV1(canonicalValue)) {
    return validationFailureV1(
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const argumentsValue = freezeJsonV1(canonicalValue);
  if (!isJsonRecordV1(argumentsValue)) {
    return validationFailureV1(
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const subjectFacts = createBuiltinDynamicMcpSubjectFactsV1(
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
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
    name: resolved.call.name,
    arguments: argumentsValue,
    argumentsDigest: digestCapabilityBindingValueV1(argumentsValue),
    schemaDigest,
    approvalSummary: boundedDiagnosticV1(resolved.call.name),
  });
  return successV1({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'validated' as const,
    resolved,
    request,
    nestedCapability: null,
    domainData: subjectFacts as unknown as RuntimeJsonValueV1,
  });
}

function classifyDynamicMcpV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  classifiedAuthenticityV1: WeakSet<object>,
  validated: Readonly<ValidatedInvocationV1>,
): ToolClassificationResultV1 {
  if (
    !validated ||
    validated.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 ||
    validated.stage !== 'validated'
  ) {
    return classifyFailureV1('invalid_stage_input', null, null);
  }
  const resolved = validated.resolved;
  const target = resolved.target as Readonly<DynamicMcpToolTargetV1>;
  if (
    !validResolvedDynamicMcpV1(projection, wrapper, resolved) ||
    validated.request.source !== 'mcp' ||
    validated.request.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 ||
    validated.request.name !== target.subject.exposedToolName ||
    validated.request.schemaDigest !== digestCapabilityBindingValueV1(target.descriptor.inputSchema)
  ) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const argumentsDigest = digestCapabilityBindingValueV1(validated.request.arguments);
  if (validated.request.argumentsDigest !== argumentsDigest) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const descriptor = target.descriptor as unknown as RuntimeCapabilityDescriptor;
  if (!descriptor.inputSchema || !isJsonRecordV1(descriptor.inputSchema)) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const recanonical = canonicalizeCapabilityArgumentsV1(
    descriptor.inputSchema,
    validated.request.arguments,
  );
  if (
    !recanonical.ok ||
    !isJsonValueV1(recanonical.args) ||
    !isJsonRecordV1(recanonical.args) ||
    digestCapabilityBindingValueV1(recanonical.args) !== argumentsDigest
  ) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const effects = freezeEffectsV1(descriptor.effectiveEffects);
  let policyCompilation: CapabilityPolicyCompilationV1;
  try {
    policyCompilation = compileBuiltinDynamicMcpPolicyV1({
      operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
      capabilityRevision: descriptor.revision,
      parserRevision: validated.request.schemaDigest,
      exposedToolName: target.subject.exposedToolName,
      effectiveEffects: effects,
      minimumApproval: descriptor.policy.minimumApproval,
      phase: resolved.availabilityContext.phase ?? 'building',
      workspace: resolved.availabilityContext.workspace,
    });
  } catch {
    return classifyFailureV1(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const effectsDigest = digestCapabilityBindingValueV1(effects);
  if (
    policyCompilation.schema !== CAPABILITY_POLICY_COMPILATION_SCHEMA_V1 ||
    policyCompilation.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 ||
    policyCompilation.capabilityRevision !== descriptor.revision ||
    policyCompilation.parserRevision !== validated.request.schemaDigest ||
    policyCompilation.minimumApproval !== descriptor.policy.minimumApproval ||
    digestCapabilityBindingValueV1(policyCompilation.effectiveEffects) !== effectsDigest
  ) {
    return classifyFailureV1(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const capability = capabilityFromEffectsV1(effects);
  const sideEffect = capability.sideEffect || hasMutationOrUnknownEffectV1(effects);
  const effectiveRisk = riskForDynamicEffectsV1(capability.effectClass, effects);
  const requirements = invocationRequirementsV1(descriptor, sideEffect, effects);
  const frozenPolicyCompilation = freezePolicyCompilationV1(policyCompilation);
  const governance = createDynamicGovernanceProjectionV1(
    projection,
    wrapper,
    resolved,
    validated,
    frozenPolicyCompilation,
    effects,
    effectsDigest,
  );
  if (!governance) {
    return classifyFailureV1(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const classified: ClassifiedInvocationV1 = {
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
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
  classifiedAuthenticityV1.add(classified);
  return successV1(classified);
}

function createDynamicGovernanceProjectionV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  resolved: Readonly<ResolvedInvocationV1>,
  validated: Readonly<ValidatedInvocationV1>,
  policyCompilation: Readonly<CapabilityPolicyCompilationV1>,
  effectiveEffects: Readonly<CapabilityEffectsV1>,
  effectiveEffectsDigest: string,
): Readonly<ToolPipelineGovernanceProjectionV1> | null {
  if (!validResolvedDynamicMcpV1(projection, wrapper, resolved)) return null;
  const target = resolved.target as Readonly<DynamicMcpToolTargetV1>;
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
    readOnly: readOnlyPolicyV1(policyCompilation),
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

function readOnlyPolicyV1(policy: Readonly<CapabilityPolicyCompilationV1>): boolean {
  return policy.decision === 'allow' && policy.risk === 'read';
}

function verifyClassifiedDynamicMcpIdentityV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  classifiedAuthenticityV1: WeakSet<object>,
  classified: Readonly<ClassifiedInvocationV1>,
): ToolPipelineClassifiedIdentityVerificationResultV1 {
  if (
    !classified ||
    typeof classified !== 'object' ||
    !classifiedAuthenticityV1.has(classified as object)
  ) {
    return invalidClassifiedIdentityV1('governance_missing');
  }
  const governance = classified.governance;
  const validated = classified.validated;
  const resolved = validated?.resolved;
  if (
    classified.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 ||
    classified.stage !== 'classified' ||
    !governance ||
    !validated ||
    !resolved ||
    !resolved.target.isDynamicMcp ||
    governance.invocation.isDynamicMcp !== true ||
    !governance.dynamicMcp
  ) {
    return invalidClassifiedIdentityV1('invocation_mismatch');
  }
  if (!validResolvedDynamicMcpV1(projection, wrapper, resolved)) {
    return invalidClassifiedIdentityV1('invocation_mismatch');
  }
  const target = resolved.target as Readonly<DynamicMcpToolTargetV1>;
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
    return invalidClassifiedIdentityV1('invocation_mismatch');
  }
  if (
    governance.policy !== classified.policyCompilation ||
    governance.effectiveEffects !== classified.effectiveEffects ||
    governance.effectiveEffectsDigest !== classified.effectiveEffectsDigest
  ) {
    return invalidClassifiedIdentityV1('effects_mismatch');
  }
  if (
    governance.nestedSkill !== null ||
    governance.dynamicMcp.subject !== subject ||
    governance.dynamicMcp.runtimeWrapper !== target.runtimeWrapper ||
    governance.dynamicMcp.minimumApproval !== descriptor.policy.minimumApproval ||
    governance.dynamicMcp.readOnly !== readOnlyPolicyV1(classified.policyCompilation) ||
    !Object.isFrozen(governance) ||
    !Object.isFrozen(governance.invocation) ||
    !Object.isFrozen(governance.dynamicMcp) ||
    !Object.isFrozen(governance.effectiveEffects) ||
    !Object.isFrozen(governance.policy)
  ) {
    return invalidClassifiedIdentityV1('dynamic_subject_mismatch');
  }
  return Object.freeze({ valid: true });
}

function verifyPreparedDynamicMcpIdentityV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  prepared: Readonly<PreparedToolInvocationV1>,
): ToolPipelinePreparedIdentityVerificationResultV1 {
  const identity = prepared?.identity;
  const input = prepared?.input;
  if (!identity || !input || typeof identity !== 'object' || typeof input !== 'object') {
    return invalidIdentityV1('identity_mismatch');
  }
  if (!isDynamicIdentityShapeV1(identity)) return invalidIdentityV1('visibility_mismatch');
  const runtimeWrapper = identity.runtimeWrapper;
  const expectedWrapper = freezeRuntimeWrapperV1(projection, wrapper);
  if (!sameDynamicWrapperV1(runtimeWrapper, expectedWrapper)) {
    return invalidIdentityV1('runtime_wrapper_mismatch');
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
    return invalidIdentityV1('subject_mismatch');
  }
  if (
    identity.builtinProjectionRevision !== null ||
    !SHA256_HEX_V1.test(identity.dynamicCatalogRevision)
  ) {
    return invalidIdentityV1('revision_mismatch');
  }
  if (
    input.invocationId !== identity.invocationId ||
    input.attemptId !== identity.attemptId ||
    input.toolCallId !== identity.toolCallId
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  if (!input.binding || !bindingMatchesDynamicSubjectV1(input.binding, identity)) {
    return invalidIdentityV1('binding_mismatch');
  }
  const facts = parseDynamicMcpSubjectFactsV1(input.facts);
  if (!facts || !factsMatchIdentityV1(facts, identity, input.binding)) {
    return invalidIdentityV1('subject_mismatch');
  }
  const canonical = canonicalizeCapabilityArgumentsV1(
    facts.descriptor.inputSchema,
    input.arguments,
  );
  if (!canonical.ok || !isJsonValueV1(canonical.args) || !isJsonRecordV1(canonical.args)) {
    return invalidIdentityV1('schema_mismatch');
  }
  const argumentsDigest = digestCapabilityBindingValueV1(canonical.args);
  if (identity.argumentsDigest !== argumentsDigest) {
    return invalidIdentityV1('arguments_mismatch');
  }
  if (
    identity.schemaDigest !== facts.schemaDigest ||
    identity.effectiveEffectsDigest !== facts.effectiveEffectsDigest ||
    identity.parserRevision !== facts.schemaDigest ||
    identity.executorRevision !== null ||
    identity.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  if (
    identity.turnId !== facts.callCreatedAtTurnId ||
    identity.turnId !== input.binding.issuedForTurnId ||
    identity.modelMessageId !== facts.modelMessageId
  ) {
    return invalidIdentityV1('identity_mismatch');
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
    return invalidIdentityV1('identity_mismatch');
  }
  return Object.freeze({ valid: true });
}

/** Create the exact JSON facts expected in PreparedToolInvocation.input.facts. */
export function createBuiltinDynamicMcpSubjectFactsV1(
  descriptor: Readonly<RuntimeCapabilityDescriptor>,
  exposedToolName: `mcp__${string}`,
  identity: Readonly<BuiltinDynamicMcpSubjectFactsIdentityV1>,
): BuiltinDynamicMcpSubjectFactsV1 {
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
  if (!isDynamicMcpSubjectDescriptorV1(descriptor) || descriptor.availability !== 'available') {
    throw new Error('Dynamic MCP subject descriptor is invalid.');
  }
  if (!descriptor.inputSchema || !isJsonRecordV1(descriptor.inputSchema)) {
    throw new Error('Dynamic MCP subject descriptor has no JSON input schema.');
  }
  const frozenDescriptor = freezeRuntimeDescriptorV1(descriptor);
  const effects = freezeEffectsV1(descriptor.effectiveEffects);
  const schemaDigest = digestCapabilityBindingValueV1(descriptor.inputSchema);
  return Object.freeze({
    schema: BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_V1,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    descriptorRevision: descriptor.revision,
    descriptorDigest: digestCapabilityBindingValueV1(frozenDescriptor),
    providerId: descriptor.provider.id,
    providerType: 'mcp' as const,
    kind: 'mcp_tool' as const,
    exposedToolName,
    availability: 'available' as const,
    schemaDigest,
    effectiveEffects: effects,
    effectiveEffectsDigest: digestCapabilityBindingValueV1(effects),
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

function validResolvedDynamicMcpV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
  resolved: Readonly<ResolvedInvocationV1>,
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
    target.operationId !== BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 ||
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
  const dynamicTarget = target as Readonly<DynamicMcpToolTargetV1>;
  if (
    !isDynamicSubjectShapeV1(dynamicTarget.subject) ||
    !isDynamicWrapperShapeV1(dynamicTarget.runtimeWrapper)
  ) {
    return false;
  }
  const descriptor = dynamicTarget.descriptor as unknown as RuntimeCapabilityDescriptor;
  const binding = dynamicTarget.binding;
  if (
    !binding ||
    !isDynamicMcpSubjectDescriptorV1(descriptor) ||
    descriptor.availability !== 'available' ||
    !descriptor.inputSchema ||
    !isJsonRecordV1(descriptor.inputSchema) ||
    !validBindingIdV1(binding) ||
    digestCapabilityBindingValueV1(descriptor.inputSchema) !== binding.schemaDigest
  ) {
    return false;
  }
  const expectedWrapper = freezeRuntimeWrapperV1(projection, wrapper);
  if (!sameDynamicWrapperV1(dynamicTarget.runtimeWrapper, expectedWrapper)) return false;
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

function isDynamicIdentityShapeV1(
  identity: Readonly<PreparedToolInvocationV1['identity']>,
): identity is Readonly<DynamicMcpPreparedToolInvocationIdentityV1> {
  return (
    identity.isDynamicMcp === true &&
    identity.executionFamily === 'mcp' &&
    identity.executionMechanism === 'mcp' &&
    identity.operationId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 &&
    identity.visibility === 'internal' &&
    identity.modelVisible === false &&
    identity.exposedToolName === null &&
    identity.executorRevision === null &&
    identity.builtinProjectionRevision === null &&
    typeof identity.dynamicCatalogRevision === 'string' &&
    SHA256_HEX_V1.test(identity.dynamicCatalogRevision) &&
    typeof identity.turnId === 'string' &&
    identity.turnId.length > 0 &&
    typeof identity.modelMessageId === 'string' &&
    identity.modelMessageId.length > 0 &&
    identity.argumentOrigin === 'model_public' &&
    isDynamicSubjectShapeV1(identity.subject) &&
    isDynamicWrapperShapeV1(identity.runtimeWrapper)
  );
}

function isDynamicSubjectShapeV1(value: unknown): value is Readonly<DynamicMcpSubjectIdentityV1> {
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
    SHA256_HEX_V1.test(subject.dynamicCatalogRevision) &&
    typeof subject.bindingId === 'string' &&
    subject.bindingId.length > 0
  );
}

function isDynamicWrapperShapeV1(
  value: unknown,
): value is Readonly<DynamicMcpRuntimeWrapperIdentityV1> {
  if (!value || typeof value !== 'object') return false;
  const wrapper = value as Record<string, unknown>;
  return (
    wrapper.operationId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 &&
    wrapper.capabilityId === BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1 &&
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

function sameDynamicWrapperV1(
  actual: Readonly<DynamicMcpRuntimeWrapperIdentityV1>,
  expected: Readonly<DynamicMcpRuntimeWrapperIdentityV1>,
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

function bindingMatchesDynamicSubjectV1(
  binding: Readonly<CapabilityBindingV1 | import('@kite/runtime-contract').CapabilityBinding>,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentityV1>,
): boolean {
  return (
    binding.bindingId === identity.bindingId &&
    binding.capabilityId === identity.subject.capabilityId &&
    binding.capabilityRevision === identity.subject.capabilityRevision &&
    binding.exposedToolName === identity.subject.exposedToolName &&
    binding.schemaDigest === identity.schemaDigest &&
    validBindingIdV1(binding)
  );
}

function factsMatchIdentityV1(
  facts: BuiltinDynamicMcpSubjectFactsV1,
  identity: Readonly<DynamicMcpPreparedToolInvocationIdentityV1>,
  binding: Readonly<CapabilityBindingV1 | import('@kite/runtime-contract').CapabilityBinding>,
): boolean {
  const descriptor = facts.descriptor;
  const effectsDigest = digestCapabilityBindingValueV1(descriptor.effectiveEffects);
  if (
    !isDynamicMcpSubjectDescriptorV1(descriptor) ||
    descriptor.availability !== 'available' ||
    !descriptor.inputSchema ||
    !isJsonRecordV1(descriptor.inputSchema) ||
    descriptor.kind !== facts.kind ||
    descriptor.provider.type !== facts.providerType ||
    descriptor.provider.id !== facts.providerId ||
    descriptor.policy.minimumApproval !== facts.minimumApproval ||
    effectsDigest !== facts.effectiveEffectsDigest ||
    digestCapabilityBindingValueV1(facts.effectiveEffects) !== facts.effectiveEffectsDigest ||
    facts.schemaDigest !== digestCapabilityBindingValueV1(descriptor.inputSchema) ||
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
    digestCapabilityBindingValueV1(descriptor) === facts.descriptorDigest &&
    descriptorRevisionIsValidV1(descriptor) &&
    facts.bindingId === binding.bindingId &&
    facts.exposedToolName === binding.exposedToolName
  );
}

function parseDynamicMcpSubjectFactsV1(
  value: RuntimeJsonValueV1 | undefined,
): BuiltinDynamicMcpSubjectFactsV1 | null {
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
    record.schema !== BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_V1 ||
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
    !isJsonRecordUnknownV1(record.effectiveEffects) ||
    typeof record.effectiveEffectsDigest !== 'string' ||
    !isApprovalV1(record.minimumApproval) ||
    typeof record.dynamicCatalogRevision !== 'string' ||
    !SHA256_HEX_V1.test(record.dynamicCatalogRevision) ||
    typeof record.bindingId !== 'string' ||
    record.bindingId.length === 0 ||
    typeof record.issuedForTurnId !== 'string' ||
    record.issuedForTurnId.length === 0 ||
    typeof record.callCreatedAtTurnId !== 'string' ||
    record.callCreatedAtTurnId.length === 0 ||
    typeof record.modelMessageId !== 'string' ||
    record.modelMessageId.length === 0 ||
    record.argumentOrigin !== 'model_public' ||
    !isJsonRecordUnknownV1(descriptor)
  ) {
    return null;
  }
  if (
    !isEffectLevelV1(record.effectiveEffects.filesystem) ||
    !isEffectLevelV1(record.effectiveEffects.network) ||
    !isEffectLevelV1(record.effectiveEffects.externalState)
  ) {
    return null;
  }
  const candidate = {
    schema: BUILTIN_DYNAMIC_MCP_SUBJECT_FACTS_SCHEMA_V1,
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
  } satisfies BuiltinDynamicMcpSubjectFactsV1;
  return candidate;
}

function isDynamicMcpSubjectDescriptorV1(
  descriptor: Readonly<ToolPipelineCapabilityDescriptorV1>,
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
    isJsonValueV1(candidate) &&
    descriptorRevisionIsValidV1(candidate) &&
    (candidate.inputSchema === undefined || isJsonRecordV1(candidate.inputSchema))
  );
}

function descriptorRevisionIsValidV1(descriptor: Readonly<RuntimeCapabilityDescriptor>): boolean {
  const { revision: _revision, ...withoutRevision } = descriptor;
  return digestCapabilityBindingValueV1(withoutRevision) === descriptor.revision;
}

function validBindingIdV1(
  binding: Readonly<CapabilityBindingV1 | import('@kite/runtime-contract').CapabilityBinding>,
): boolean {
  return (
    typeof binding.bindingId === 'string' &&
    binding.bindingId ===
      digestCapabilityBindingValueV1({
        capabilityId: binding.capabilityId,
        revision: binding.capabilityRevision,
        exposedToolName: binding.exposedToolName,
        schemaDigest: binding.schemaDigest,
        turnId: binding.issuedForTurnId,
      })
  );
}

function validDynamicResolutionContextV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  context: Readonly<ToolPipelineResolutionContextV1>,
): boolean {
  if (
    !context ||
    typeof context.currentTurnId !== 'string' ||
    context.currentTurnId.length === 0 ||
    context.builtinProjectionRevision !== projection.revision ||
    typeof context.dynamicCatalogRevision !== 'string' ||
    !SHA256_HEX_V1.test(context.dynamicCatalogRevision) ||
    !context.availabilityContext ||
    typeof context.availabilityContext.workspace !== 'string' ||
    !Array.isArray(context.bindings) ||
    !Array.isArray(context.descriptors) ||
    !Array.isArray(context.disclosures ?? [])
  ) {
    return false;
  }
  return (
    !hasDuplicateKeyV1(context.bindings, (item) => item.bindingId) &&
    !hasDuplicateKeyV1(context.bindings, (item) => item.exposedToolName) &&
    !hasDuplicateKeyV1(context.descriptors, (item) => item.capabilityId)
  );
}

function freezeRuntimeWrapperV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  wrapper: BuiltinInternalOperationCatalogEntryV1,
): Readonly<DynamicMcpRuntimeWrapperIdentityV1> {
  return Object.freeze({
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
    capabilityId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_V1,
    providerId: wrapper.providerId,
    capabilityRevision: wrapper.revision,
    executorRevision: wrapper.executorRevision,
    schemaDigest: digestCapabilityBindingValueV1(wrapper.inputSchema ?? {}),
    builtinProjectionRevision: projection.revision,
  });
}

function freezeDynamicSubjectV1(
  value: DynamicMcpSubjectIdentityV1,
): Readonly<DynamicMcpSubjectIdentityV1> {
  return Object.freeze({ ...value });
}

function freezeRuntimeDescriptorV1(
  descriptor: Readonly<RuntimeCapabilityDescriptor>,
): Readonly<RuntimeCapabilityDescriptor> {
  return freezeJsonV1(
    descriptor as unknown as RuntimeJsonValueV1,
  ) as unknown as RuntimeCapabilityDescriptor;
}

function freezeBindingV1(
  binding: Readonly<ToolPipelineCapabilityBindingV1>,
): Readonly<ToolPipelineCapabilityBindingV1> {
  return freezeJsonV1(binding as unknown as RuntimeJsonValueV1) as ToolPipelineCapabilityBindingV1;
}

function freezeToolCallV1(call: Readonly<ToolCallSnapshotV1>): Readonly<ToolCallSnapshotV1> {
  return freezeJsonV1(call as unknown as RuntimeJsonValueV1) as unknown as ToolCallSnapshotV1;
}

function freezeAvailabilityContextV1(
  context: Readonly<import('@kite/runtime-spi').CapabilityAvailabilityContextV1>,
): Readonly<import('@kite/runtime-spi').CapabilityAvailabilityContextV1> {
  return freezeJsonV1(
    context as unknown as RuntimeJsonValueV1,
  ) as unknown as import('@kite/runtime-spi').CapabilityAvailabilityContextV1;
}

function freezeEffectsV1(value: CapabilityEffectsV1): Readonly<CapabilityEffectsV1> {
  return Object.freeze({
    filesystem: value.filesystem,
    network: value.network,
    externalState: value.externalState,
  });
}

function freezePolicyCompilationV1(
  value: CapabilityPolicyCompilationV1,
): Readonly<CapabilityPolicyCompilationV1> {
  return Object.freeze({
    ...value,
    ...(value.effects ? { effects: Object.freeze({ ...value.effects }) } : {}),
    effectiveEffects: freezeEffectsV1(value.effectiveEffects),
    expectedEffects: Object.freeze([...value.expectedEffects]),
  });
}

function freezeJsonArrayV1<T>(value: readonly T[]): readonly T[] {
  return Object.freeze(
    value.map((item) => freezeJsonV1(item as unknown as RuntimeJsonValueV1)),
  ) as readonly T[];
}

function freezeJsonV1(value: RuntimeJsonValueV1): RuntimeJsonValueV1 {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJsonV1(item)));
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJsonV1(item)])),
    ) as RuntimeJsonValueV1;
  }
  return value;
}

function isJsonRecordV1(value: unknown): value is Readonly<Record<string, RuntimeJsonValueV1>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJsonValueV1(value: unknown): value is RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValueV1(item));
  if (value && typeof value === 'object') {
    return Object.values(value).every((item) => isJsonValueV1(item));
  }
  return false;
}

function isJsonRecordUnknownV1(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isEffectLevelV1(value: unknown): value is CapabilityEffectsV1[keyof CapabilityEffectsV1] {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isApprovalV1(value: unknown): value is CapabilityApprovalV1 {
  return value === 'none' || value === 'auto_review' || value === 'user';
}

function uniqueMatchV1<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | 'duplicate' | null {
  const matches = items.filter(predicate);
  if (matches.length > 1) return 'duplicate';
  return matches[0] ?? null;
}

function hasDuplicateKeyV1<T, K>(items: readonly T[], keyOf: (item: T) => K): boolean {
  const keys = new Set<K>();
  for (const item of items) {
    const key = keyOf(item);
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function capabilityFromEffectsV1(effects: CapabilityEffectsV1) {
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

function riskForDynamicEffectsV1(
  effectClass: ReturnType<typeof capabilityFromEffectsV1>['effectClass'],
  effects: CapabilityEffectsV1,
): ClassifiedInvocationV1['risk'] {
  if (Object.values(effects).some((effect) => effect === 'destructive')) return 'destructive';
  if (effects.filesystem === 'write') return 'workspace_write';
  if (effects.network === 'read' || effects.network === 'write') return 'network';
  if (effects.externalState === 'read' || effects.externalState === 'write')
    return 'external_state';
  if (effectClass === 'read_only') return 'read';
  return 'execute';
}

function invocationRequirementsV1(
  descriptor: Readonly<RuntimeCapabilityDescriptor>,
  sideEffect: boolean,
  effects: CapabilityEffectsV1,
) {
  const receipt =
    sideEffect || hasMutationOrUnknownEffectV1(effects)
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

function hasMutationOrUnknownEffectV1(effects: CapabilityEffectsV1): boolean {
  return Object.values(effects).some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function resolveFailureV1(
  code: ToolPipelineResolveFailureCodeV1,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolResolutionResultV1 {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({
      stage: 'resolve' as const,
      code,
      toolCallId,
      toolName,
      ...(diagnostic ? { diagnostic: boundedDiagnosticV1(diagnostic) } : {}),
    }),
  });
}

function validationFailureV1(
  code: ToolPipelineValidateFailureCodeV1,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolValidationResultV1 {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({
      stage: 'validate' as const,
      code,
      toolCallId,
      toolName,
      ...(diagnostic ? { diagnostic: boundedDiagnosticV1(diagnostic) } : {}),
    }),
  });
}

function classifyFailureV1(
  code: 'invalid_stage_input' | 'stage_identity_drift' | 'classification_unavailable',
  toolCallId: string | null,
  toolName: string | null,
): ToolClassificationResultV1 {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ stage: 'classify' as const, code, toolCallId, toolName }),
  });
}

function successV1<T>(value: T): { readonly ok: true; readonly value: Readonly<T> } {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function invalidIdentityV1(
  code:
    | 'identity_mismatch'
    | 'revision_mismatch'
    | 'schema_mismatch'
    | 'visibility_mismatch'
    | 'subject_mismatch'
    | 'runtime_wrapper_mismatch'
    | 'arguments_mismatch'
    | 'binding_mismatch',
): ToolPipelinePreparedIdentityVerificationResultV1 {
  return Object.freeze({ valid: false as const, code });
}

function invalidClassifiedIdentityV1(
  code: Extract<
    ToolPipelineClassifiedIdentityVerificationResultV1,
    { readonly valid: false }
  >['code'],
): ToolPipelineClassifiedIdentityVerificationResultV1 {
  return Object.freeze({ valid: false as const, code });
}

function boundedDiagnosticV1(value: string): string {
  return Array.from(value).slice(0, 160).join('');
}

function assertFrozenProjectionV1(projection: Readonly<BuiltinToolCatalogProjectionV1>): void {
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
