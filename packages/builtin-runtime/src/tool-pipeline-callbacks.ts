import type {
  CapabilityAvailabilityContextV1,
  CapabilityBindingV1,
  CapabilityEffectsV1,
  CapabilityExecutionTraitsV1,
  CapabilityParseIssueV1,
  CapabilityParserV1,
  CapabilityPolicyCompilationV1,
  CapabilityToolKindV1,
  ClassifiedInvocationV1,
  NonDynamicOperationIdV1,
  NonDynamicToolTargetV1,
  PreparedToolInvocationV1,
  ResolvedInvocationV1,
  RuntimeJsonValueV1,
  ToolArgumentOriginV1,
  ToolCallSnapshotV1,
  ToolClassificationResultV1,
  ToolExecutionFamilyV1,
  ToolPipelineCapabilityDescriptorV1,
  ToolPipelineClassifiedIdentityVerificationResultV1,
  ToolPipelineClassifiedIdentityVerifierV1,
  ToolPipelineClassifyFailureCodeV1,
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
import { digestCapabilityBindingValueV1 } from './capability-binding';
import type {
  BuiltinModelToolCatalogEntryV1,
  BuiltinToolCatalogProjectionV1,
} from './tool-catalog';

export const BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1 =
  'kite.builtin-runtime.non-dynamic-prepared-call-facts.v1' as const;
const SHA256_HEX_V1 = /^[0-9a-f]{64}$/u;

/**
 * Package-only callbacks for the model-visible Builtin part of Tool Pipeline.
 *
 * This surface owns neither dispatch nor Kernel governance.  It only projects
 * the exact immutable Builtin catalog facts into the neutral SPI DTOs.
 */
export interface BuiltinToolPipelineCallbacksV1 {
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
 * Build the single Builtin-owned callback surface from one frozen catalog
 * projection.  No registry, snapshot, executor, fallback parser, or second
 * schema/effects authority is created here.
 */
export function createBuiltinToolPipelineCallbacksV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
): BuiltinToolPipelineCallbacksV1 {
  assertFrozenProjectionV1(projection);
  const classifiedAuthenticityV1 = new WeakSet<object>();

  const resolve = (
    call: Readonly<ToolCallSnapshotV1>,
    context: Readonly<ToolPipelineResolutionContextV1>,
  ): ToolResolutionResultV1 => resolveBuiltinV1(projection, call, context);

  const validate = (resolved: Readonly<ResolvedInvocationV1>): ToolValidationResultV1 =>
    validateBuiltinV1(projection, resolved);

  const classify = (validated: Readonly<ValidatedInvocationV1>): ToolClassificationResultV1 =>
    classifyBuiltinV1(projection, classifiedAuthenticityV1, validated);

  const verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1 = (prepared) =>
    verifyPreparedBuiltinIdentityV1(projection, prepared);

  const verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifierV1 = (classified) =>
    verifyClassifiedBuiltinIdentityV1(projection, classifiedAuthenticityV1, classified);

  return Object.freeze({
    resolve,
    validate,
    classify,
    verifyPreparedIdentity,
    verifyClassifiedIdentity,
  });
}

function resolveBuiltinV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  call: Readonly<ToolCallSnapshotV1>,
  context: Readonly<ToolPipelineResolutionContextV1>,
): ToolResolutionResultV1 {
  if (call.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || call.stage !== 'snapshot') {
    return resolveFailureV1('invalid_stage_input', null, null);
  }
  if (!validResolutionContextV1(context, projection)) {
    return resolveFailureV1('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (call.createdAtTurnId !== context.currentTurnId) {
    return resolveFailureV1('call_turn_mismatch', call.toolCallId, call.name);
  }
  if (call.bindingId !== null || call.capabilityId !== null || call.capabilityRevision !== null) {
    return resolveFailureV1('unexpected_binding', call.toolCallId, call.name);
  }

  const entry = modelEntryByNameV1(projection, call.name);
  if (!entry) return resolveFailureV1('unknown_tool', call.toolCallId, call.name);
  // `toolSet` intentionally contains only available model entries.  A
  // degraded/hidden entry therefore remains unavailable to the model surface.
  if (entry.availability !== 'available' || !Object.hasOwn(projection.toolSet, entry.name)) {
    return resolveFailureV1('tool_unavailable', call.toolCallId, call.name);
  }
  if (entry.kind === 'internal_runtime') {
    return resolveFailureV1('unknown_tool', call.toolCallId, call.name);
  }
  if (entry.operationId === 'mcp:dynamic_tool') {
    return resolveFailureV1('unknown_tool', call.toolCallId, call.name);
  }

  const operationId = entry.operationId as NonDynamicOperationIdV1;
  const executionFamily = executionFamilyForBuiltinV1(entry.executionMechanism);
  const target: NonDynamicToolTargetV1 = Object.freeze({
    executionFamily,
    executionMechanism: entry.executionMechanism,
    operationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    providerId: entry.providerId,
    executorRevision: entry.executorRevision,
    toolKind: entry.kind as CapabilityToolKindV1,
    visibility: 'model' as const,
    modelVisible: true as const,
    exposedToolName: entry.name,
    isDynamicMcp: false as const,
    builtinProjectionRevision: projection.revision,
    // The dynamic catalog never becomes ordinary Builtin operation identity.
    // Nested Skill disclosure carries its own revision below when applicable.
    dynamicCatalogRevision: null,
    binding: null,
    descriptor: entry.descriptor,
  });

  return successV1({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'resolved',
    call,
    target,
    availabilityContext: freezeAvailabilityContextV1(context.availabilityContext),
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: context.dynamicCatalogRevision,
    disclosedCapabilities: freezeJsonArrayV1(context.descriptors),
    disclosures: freezeJsonArrayV1(context.disclosures ?? []),
  });
}

function validateBuiltinV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  resolved: Readonly<ResolvedInvocationV1>,
): ToolValidationResultV1 {
  if (resolved.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || resolved.stage !== 'resolved') {
    return validationFailureV1('invalid_stage_input', null, null);
  }
  const target = resolved.target;
  if (
    target.isDynamicMcp ||
    String(target.executionFamily) === 'mcp' ||
    target.visibility !== 'model' ||
    target.modelVisible !== true ||
    target.exposedToolName === null ||
    target.binding !== null
  ) {
    return validationFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  if (resolved.builtinProjectionRevision !== projection.revision) {
    return validationFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const entry = exactEntryForResolvedV1(projection, resolved);
  if (entry?.availability !== 'available') {
    return validationFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }

  const argumentAuthority = argumentAuthorityForEntryV1(
    entry,
    resolved.call.argumentOrigin,
    resolved.call.rawArguments,
  );
  if (argumentAuthority === null) {
    return validationFailureV1(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      'Builtin argument origin does not match the operation input contract.',
    );
  }
  const privateTaskProjection = argumentAuthority === 'runtime_private';
  const parserAuthority = parserAuthorityForEntryV1(entry, privateTaskProjection);
  let observed: ReturnType<CapabilityParserV1['observeUnknownFields']>;
  let parsed: ReturnType<CapabilityParserV1['parse']>;
  try {
    // Both calls deliberately use the selected parser authority from this
    // exact entry. Unknown fields are observed for bounded diagnostics; their
    // values never cross this boundary.
    observed = parserAuthority.observeUnknownFields(resolved.call.rawArguments);
    parsed = parserAuthority.parse(resolved.call.rawArguments);
  } catch {
    return validationFailureV1(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      'Builtin arguments failed parser validation.',
    );
  }
  void observed;
  if (!parsed.success) {
    return validationFailureV1(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      boundedParseDiagnosticV1(parsed.issues[0]),
    );
  }

  let canonical: RuntimeJsonValueV1;
  try {
    canonical = freezeJsonV1(parserAuthority.canonicalize(parsed.data));
  } catch {
    return validationFailureV1(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      'Builtin arguments failed canonicalization.',
    );
  }
  if (!isJsonRecordV1(canonical)) {
    return validationFailureV1(
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }

  const schemaDigest = parserAuthority.schemaDigest;
  if (!schemaDigest) {
    return validationFailureV1('schema_missing', resolved.call.toolCallId, resolved.call.name);
  }
  const approvalSummary = boundedSummaryV1(entry.projectApprovalSummary(canonical));
  const request = Object.freeze({
    source: 'builtin' as const,
    operationId: target.operationId,
    name: entry.name,
    arguments: canonical,
    argumentsDigest: digestCapabilityBindingValueV1(canonical),
    schemaDigest,
    approvalSummary,
  });
  const subagentRole = subagentRoleV1(target.executionMechanism, canonical);
  const nested = validateNestedCapabilityV1(entry, resolved, canonical);
  if (!nested.ok) return nested;
  return successV1({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'validated',
    resolved,
    request,
    nestedCapability: nested.value,
    domainData: freezeJsonV1({
      schema: BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1,
      toolCallId: resolved.call.toolCallId,
      callCreatedAtTurnId: resolved.call.createdAtTurnId,
      modelMessageId: resolved.call.modelMessageId,
      argumentOrigin: resolved.call.argumentOrigin,
      dynamicCatalogRevision: null,
      approvalSummary,
      privateTaskProjection,
      subagentRole,
      nestedCapabilityId: nested.value?.descriptor.capabilityId ?? null,
      nestedCapabilityRevision: nested.value?.descriptor.revision ?? null,
      nestedSkill: nested.value
        ? nestedSkillFactsV1(
            resolved,
            nested.value.descriptor,
            nested.value.disclosure,
            approvalSummary,
          )
        : null,
    }),
  });
}

function classifyBuiltinV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  classifiedAuthenticityV1: WeakSet<object>,
  validated: Readonly<ValidatedInvocationV1>,
): ToolClassificationResultV1 {
  if (validated.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || validated.stage !== 'validated') {
    return classifyFailureV1('invalid_stage_input', null, null);
  }
  const resolved = validated.resolved;
  const target = resolved.target;
  if (
    target.isDynamicMcp ||
    String(target.executionFamily) === 'mcp' ||
    target.visibility !== 'model' ||
    target.modelVisible !== true ||
    target.exposedToolName === null ||
    target.binding !== null ||
    resolved.builtinProjectionRevision !== projection.revision
  ) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const entry = exactEntryForResolvedV1(projection, resolved);
  if (entry === undefined) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const argumentAuthority = argumentAuthorityForEntryV1(
    entry,
    resolved.call.argumentOrigin,
    validated.request.arguments,
  );
  if (argumentAuthority === null) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const privateTaskProjection = argumentAuthority === 'runtime_private';
  const parserAuthority = parserAuthorityForEntryV1(entry, privateTaskProjection);
  if (
    entry.availability !== 'available' ||
    validated.request.name !== entry.name ||
    validated.request.operationId !== target.operationId ||
    validated.request.schemaDigest !== parserAuthority.schemaDigest ||
    validated.request.argumentsDigest !==
      digestCapabilityBindingValueV1(validated.request.arguments)
  ) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const canonical = validated.request.arguments;
  let classification: ReturnType<BuiltinModelToolCatalogEntryV1['classifyEffects']>;
  let policyCompilation: CapabilityPolicyCompilationV1;
  let executionTraits: CapabilityExecutionTraitsV1;
  try {
    // These entry methods close over the exact turn context that produced the
    // frozen projection. Transported resolution facts must never re-select a
    // Builtin parser, classifier, policy compiler, or trait projector.
    classification = entry.classifyEffects(canonical);
    policyCompilation = entry.compilePolicy(canonical);
    executionTraits = entry.projectExecutionTraits(canonical);
  } catch {
    return classifyFailureV1(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const nested = validated.nestedCapability;
  if (nested && !validNestedCapabilityV1(entry, resolved, nested)) {
    return classifyFailureV1(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const governingDescriptor = nested?.descriptor ?? entry.descriptor;
  const capability = nested
    ? capabilityFromEffectsV1(governingDescriptor.effectiveEffects)
    : {
        effectClass: classification.effectClass,
        sideEffect: classification.sideEffect,
        classificationReason: classification.classificationReason,
      };
  const effectiveEffects = freezeEffectsV1(
    nested ? governingDescriptor.effectiveEffects : classification.effectiveEffects,
  );
  const effectiveEffectsDigest = digestCapabilityBindingValueV1(effectiveEffects);
  const schemaDigest = parserAuthority.schemaDigest;
  if (
    !schemaDigest ||
    policyCompilation.schema !== CAPABILITY_POLICY_COMPILATION_SCHEMA_V1 ||
    policyCompilation.operationId !== target.operationId ||
    policyCompilation.capabilityRevision !== target.capabilityRevision ||
    policyCompilation.parserRevision !== entry.parser.parserRevision ||
    policyCompilation.minimumApproval !== entry.minimumApproval ||
    (!nested &&
      digestCapabilityBindingValueV1(policyCompilation.effectiveEffects) !== effectiveEffectsDigest)
  ) {
    return classifyFailureV1(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const sideEffect = capability.sideEffect || hasMutationOrUnknownEffectV1(effectiveEffects);
  const requirements = invocationRequirementsV1(
    target.toolKind,
    capability,
    effectiveEffects,
    governingDescriptor,
  );
  const frozenPolicyCompilation = freezePolicyCompilationV1(policyCompilation);
  const governance = createBuiltinGovernanceProjectionV1(
    projection,
    entry,
    resolved,
    validated,
    parserAuthority,
    frozenPolicyCompilation,
    effectiveEffects,
    effectiveEffectsDigest,
    nested,
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
    stage: 'classified',
    validated,
    descriptor: governingDescriptor,
    policyCompilation: frozenPolicyCompilation,
    governance,
    effectClass: capability.effectClass,
    effectiveEffects,
    effectiveEffectsDigest,
    risk: nested ? riskForEffectsV1(capability.effectClass, effectiveEffects) : classification.risk,
    sideEffect,
    minimumApproval: governingDescriptor.policy.minimumApproval,
    executionTraits: nested ? null : freezeExecutionTraitsV1(executionTraits),
    requirements,
  };
  classifiedAuthenticityV1.add(classified);
  return successV1(classified);
}

function createBuiltinGovernanceProjectionV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  entry: BuiltinModelToolCatalogEntryV1,
  resolved: Readonly<ResolvedInvocationV1>,
  validated: Readonly<ValidatedInvocationV1>,
  parserAuthority: BuiltinParserAuthorityV1,
  policyCompilation: Readonly<CapabilityPolicyCompilationV1>,
  effectiveEffects: Readonly<CapabilityEffectsV1>,
  effectiveEffectsDigest: string,
  nested: Readonly<ValidatedInvocationV1['nestedCapability']>,
): Readonly<ToolPipelineGovernanceProjectionV1> | null {
  const target = resolved.target;
  if (
    target.isDynamicMcp ||
    target.visibility !== 'model' ||
    target.modelVisible !== true ||
    target.exposedToolName !== entry.name ||
    target.dynamicCatalogRevision !== null
  ) {
    return null;
  }

  const nestedCatalogRevision = nested ? resolved.dynamicCatalogRevision : null;
  if (nested && (entry.operationId !== 'builtin:activate_skill' || !nestedCatalogRevision)) {
    return null;
  }
  if (!nested && entry.operationId === 'builtin:activate_skill') return null;

  const invocation = Object.freeze({
    turnId: resolved.call.createdAtTurnId,
    modelMessageId: resolved.call.modelMessageId,
    toolCallId: resolved.call.toolCallId,
    argumentOrigin: resolved.call.argumentOrigin,
    executionFamily: target.executionFamily,
    executionMechanism: target.executionMechanism,
    exposedToolName: entry.name,
    operationId: target.operationId,
    capabilityId: target.capabilityId,
    providerId: target.providerId,
    capabilityRevision: target.capabilityRevision,
    executorRevision: target.executorRevision,
    descriptorRevision: target.descriptorRevision,
    parserRevision: parserAuthority.parser.parserRevision,
    schemaDigest: validated.request.schemaDigest,
    argumentsDigest: validated.request.argumentsDigest,
    effectiveEffectsDigest,
    bindingId: target.binding?.bindingId ?? null,
    nestedCapabilityId: nested?.descriptor.capabilityId ?? null,
    nestedCapabilityRevision: nested?.descriptor.revision ?? null,
    nestedCatalogRevision,
    commandDigest: commandDigestForBuiltinV1(
      target.executionMechanism,
      validated.request.arguments,
    ),
    isDynamicMcp: false as const,
    visibility: 'model' as const,
    modelVisible: true as const,
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: null,
  });
  const nestedSkill = nested
    ? Object.freeze({
        operationId: 'builtin:activate_skill' as const,
        capabilityId: nested.descriptor.capabilityId,
        capabilityRevision: nested.descriptor.revision,
        nestedCatalogRevision: nestedCatalogRevision as string,
        decision: nestedSkillDecisionV1(nested.descriptor),
        minimumApproval: nested.descriptor.policy.minimumApproval,
      })
    : null;
  return Object.freeze({
    invocation,
    policy: policyCompilation,
    effectiveEffects,
    effectiveEffectsDigest,
    dynamicMcp: null,
    nestedSkill,
  });
}

function commandDigestForBuiltinV1(
  mechanism: BuiltinModelToolCatalogEntryV1['executionMechanism'],
  argumentsValue: RuntimeJsonValueV1,
): string | null {
  if (mechanism !== 'shell' || !isJsonRecordV1(argumentsValue)) return null;
  const command = argumentsValue.command;
  if (typeof command !== 'string') return null;
  const canonicalCommand = command.trim();
  return canonicalCommand.length > 0 ? digestCapabilityBindingValueV1(canonicalCommand) : null;
}

function nestedSkillDecisionV1(
  descriptor: ToolPipelineCapabilityDescriptorV1,
): CapabilityPolicyCompilationV1['decision'] {
  if (descriptor.policy.minimumApproval === 'none') return 'allow';
  return descriptor.availability === 'available' ? 'ask' : 'deny';
}

function verifyClassifiedBuiltinIdentityV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
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
  const target = resolved?.target;
  if (
    classified.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 ||
    classified.stage !== 'classified' ||
    !governance ||
    !validated ||
    !resolved ||
    !target ||
    target.isDynamicMcp ||
    governance.invocation.isDynamicMcp !== false
  ) {
    return invalidClassifiedIdentityV1('invocation_mismatch');
  }
  const entry = exactEntryForResolvedV1(projection, resolved);
  if (entry === undefined) return invalidClassifiedIdentityV1('invocation_mismatch');
  const argumentAuthority = argumentAuthorityForEntryV1(
    entry,
    resolved.call.argumentOrigin,
    validated.request.arguments,
  );
  if (argumentAuthority === null) return invalidClassifiedIdentityV1('invocation_mismatch');
  const parserAuthority = parserAuthorityForEntryV1(entry, argumentAuthority === 'runtime_private');
  const invocation = governance.invocation;
  const nested = validated.nestedCapability;
  const expectedNestedCatalogRevision = nested ? resolved.dynamicCatalogRevision : null;
  const expectedCommandDigest = commandDigestForBuiltinV1(
    target.executionMechanism,
    validated.request.arguments,
  );
  if (
    invocation.turnId !== resolved.call.createdAtTurnId ||
    invocation.modelMessageId !== resolved.call.modelMessageId ||
    invocation.toolCallId !== resolved.call.toolCallId ||
    invocation.argumentOrigin !== resolved.call.argumentOrigin ||
    invocation.executionFamily !== target.executionFamily ||
    invocation.executionMechanism !== target.executionMechanism ||
    invocation.exposedToolName !== entry.name ||
    invocation.operationId !== target.operationId ||
    invocation.capabilityId !== target.capabilityId ||
    invocation.providerId !== target.providerId ||
    invocation.capabilityRevision !== target.capabilityRevision ||
    invocation.executorRevision !== target.executorRevision ||
    invocation.descriptorRevision !== target.descriptorRevision ||
    invocation.parserRevision !== parserAuthority.parser.parserRevision ||
    invocation.schemaDigest !== validated.request.schemaDigest ||
    invocation.argumentsDigest !== validated.request.argumentsDigest ||
    invocation.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    invocation.bindingId !== (target.binding?.bindingId ?? null) ||
    invocation.nestedCapabilityId !== (nested?.descriptor.capabilityId ?? null) ||
    invocation.nestedCapabilityRevision !== (nested?.descriptor.revision ?? null) ||
    invocation.nestedCatalogRevision !== expectedNestedCatalogRevision ||
    invocation.commandDigest !== expectedCommandDigest ||
    invocation.visibility !== 'model' ||
    invocation.modelVisible !== true ||
    invocation.builtinProjectionRevision !== projection.revision ||
    invocation.dynamicCatalogRevision !== null
  ) {
    return invalidClassifiedIdentityV1('invocation_mismatch');
  }
  if (
    governance.policy !== classified.policyCompilation ||
    governance.effectiveEffects !== classified.effectiveEffects ||
    governance.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    governance.dynamicMcp !== null
  ) {
    return invalidClassifiedIdentityV1('effects_mismatch');
  }
  if (nested) {
    if (
      entry.operationId !== 'builtin:activate_skill' ||
      !governance.nestedSkill ||
      governance.nestedSkill.operationId !== 'builtin:activate_skill' ||
      governance.nestedSkill.capabilityId !== nested.descriptor.capabilityId ||
      governance.nestedSkill.capabilityRevision !== nested.descriptor.revision ||
      governance.nestedSkill.nestedCatalogRevision !== resolved.dynamicCatalogRevision ||
      governance.nestedSkill.decision !== nestedSkillDecisionV1(nested.descriptor) ||
      governance.nestedSkill.minimumApproval !== nested.descriptor.policy.minimumApproval
    ) {
      return invalidClassifiedIdentityV1('nested_skill_mismatch');
    }
  } else if (governance.nestedSkill !== null) {
    return invalidClassifiedIdentityV1('nested_skill_mismatch');
  }
  if (
    !Object.isFrozen(governance) ||
    !Object.isFrozen(governance.invocation) ||
    !Object.isFrozen(governance.effectiveEffects) ||
    !Object.isFrozen(governance.policy) ||
    (governance.nestedSkill !== null && !Object.isFrozen(governance.nestedSkill))
  ) {
    return invalidClassifiedIdentityV1('governance_missing');
  }
  return Object.freeze({ valid: true });
}

function verifyPreparedBuiltinIdentityV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  prepared: Readonly<PreparedToolInvocationV1>,
): ToolPipelinePreparedIdentityVerificationResultV1 {
  // This is identity-only. Authorization, admission, and Kernel governance
  // remain owned by the separate Kernel governance seam; no policy decision
  // or executor/dispatch callback is reachable from this verifier.
  const identity = prepared?.identity;
  const input = prepared?.input;
  if (!identity || !input || typeof identity !== 'object' || typeof input !== 'object') {
    return invalidIdentityV1('identity_mismatch');
  }
  if (
    identity.isDynamicMcp === true ||
    String(identity.executionFamily) === 'mcp' ||
    identity.operationId === 'mcp:dynamic_tool' ||
    identity.builtinProjectionRevision === null
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  if (
    identity.isDynamicMcp !== false ||
    identity.visibility !== 'model' ||
    identity.modelVisible !== true ||
    typeof identity.exposedToolName !== 'string' ||
    identity.exposedToolName.length === 0
  ) {
    return invalidIdentityV1('visibility_mismatch');
  }
  if (identity.builtinProjectionRevision !== projection.revision) {
    return invalidIdentityV1('revision_mismatch');
  }
  if (identity.dynamicCatalogRevision !== null) {
    return invalidIdentityV1('revision_mismatch');
  }

  const entry = modelEntryByNameV1(projection, identity.exposedToolName);
  if (entry?.availability !== 'available') {
    return invalidIdentityV1('revision_mismatch');
  }
  if (entry.kind === 'interrupt' || entry.executionMechanism === 'user_input') {
    return invalidIdentityV1('visibility_mismatch');
  }
  const argumentAuthority = argumentAuthorityForEntryV1(
    entry,
    identity.argumentOrigin,
    input.arguments,
  );
  if (argumentAuthority === null) return invalidIdentityV1('identity_mismatch');
  const privateTaskProjection = argumentAuthority === 'runtime_private';
  const parserAuthority = parserAuthorityForEntryV1(entry, privateTaskProjection);
  const schemaDigest = parserAuthority.schemaDigest;
  if (!schemaDigest) return invalidIdentityV1('schema_mismatch');
  if (
    entry.operationId === 'mcp:dynamic_tool' ||
    identity.operationId !== entry.operationId ||
    identity.executionFamily !== executionFamilyForBuiltinV1(entry.executionMechanism) ||
    identity.toolKind !== entry.kind ||
    identity.capabilityId !== entry.capabilityId ||
    identity.capabilityRevision !== entry.revision ||
    identity.descriptorRevision !== entry.descriptor.revision ||
    identity.providerId !== entry.providerId ||
    identity.executorRevision !== entry.executorRevision ||
    identity.parserRevision !== parserAuthority.parser.parserRevision ||
    identity.schemaDigest !== schemaDigest ||
    identity.executionMechanism !== entry.executionMechanism ||
    identity.exposedToolName !== entry.name
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  if (
    input.invocationId !== identity.invocationId ||
    input.attemptId !== identity.attemptId ||
    input.toolCallId !== identity.toolCallId
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  const outerFacts =
    isJsonRecordOptionalV1(input.facts) &&
    input.facts.schema === BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1
      ? input.facts
      : undefined;
  if (!outerFacts) return invalidIdentityV1('identity_mismatch');
  const callFacts = preparedCallFactsV1(outerFacts);
  if (
    !callFacts ||
    callFacts.toolCallId !== identity.toolCallId ||
    callFacts.callCreatedAtTurnId !== identity.turnId ||
    callFacts.modelMessageId !== identity.modelMessageId ||
    callFacts.argumentOrigin !== identity.argumentOrigin ||
    callFacts.argumentOrigin !== argumentAuthority ||
    callFacts.dynamicCatalogRevision !== null
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  if (!bindingMatchesEntryV1(input.binding, identity.bindingId, entry, schemaDigest)) {
    return invalidIdentityV1('identity_mismatch');
  }

  let canonical: RuntimeJsonValueV1;
  let classification: ReturnType<BuiltinModelToolCatalogEntryV1['classifyEffects']>;
  let parsed: ReturnType<CapabilityParserV1['parse']>;
  if (factsProvideParserContextV1(outerFacts)) {
    return invalidIdentityV1('identity_mismatch');
  }
  try {
    parserAuthority.observeUnknownFields(input.arguments);
    parsed = parserAuthority.parse(input.arguments);
    if (!parsed.success) return invalidIdentityV1('schema_mismatch');
    canonical = freezeJsonV1(parserAuthority.canonicalize(parsed.data));
    if (!isJsonRecordV1(canonical)) return invalidIdentityV1('schema_mismatch');
    classification = entry.classifyEffects(canonical);
  } catch {
    return invalidIdentityV1('schema_mismatch');
  }
  if (identity.argumentsDigest !== digestCapabilityBindingValueV1(canonical)) {
    return invalidIdentityV1('identity_mismatch');
  }
  let approvalSummary: string;
  try {
    approvalSummary = boundedSummaryV1(entry.projectApprovalSummary(canonical));
  } catch {
    return invalidIdentityV1('identity_mismatch');
  }
  if (callFacts.approvalSummary !== approvalSummary) {
    return invalidIdentityV1('identity_mismatch');
  }
  if (entry.operationId === 'builtin:activate_skill') {
    let nestedFacts: PreparedNestedSkillFactsV1 | null;
    try {
      nestedFacts = preparedNestedSkillFactsV1(outerFacts.nestedSkill);
      if (!nestedFacts || !preparedNestedSkillFactsMatchV1(nestedFacts, canonical, identity)) {
        return invalidIdentityV1('identity_mismatch');
      }
    } catch {
      return invalidIdentityV1('identity_mismatch');
    }
  } else if (
    identity.nestedCapabilityId !== null ||
    identity.nestedCapabilityRevision !== null ||
    identity.nestedCatalogRevision !== null ||
    identity.effectiveEffectsDigest !==
      digestCapabilityBindingValueV1(classification.effectiveEffects)
  ) {
    return invalidIdentityV1('identity_mismatch');
  }

  const configuredIdempotencyArgument = entry.execution?.idempotencyKeyArgument ?? null;
  const expectedIdempotencyKey = configuredIdempotencyArgument
    ? idempotencyKeyFromArgumentsV1(canonical, configuredIdempotencyArgument)
    : null;
  if (
    identity.idempotencyKeyArgument !== configuredIdempotencyArgument ||
    identity.idempotencyKey !== expectedIdempotencyKey
  ) {
    return invalidIdentityV1('identity_mismatch');
  }
  return Object.freeze({ valid: true });
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
    throw new Error('Builtin Tool Pipeline requires a frozen catalog projection.');
  }
  const operationIds = new Set<string>();
  const names = new Set<string>();
  for (const entry of projection.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !Object.isFrozen(entry) ||
      operationIds.has(entry.operationId)
    ) {
      throw new Error('Builtin Tool Pipeline catalog entries are not exact.');
    }
    operationIds.add(entry.operationId);
    if (entry.visibility === 'model') {
      if (!entry.name || names.has(entry.name)) {
        throw new Error('Builtin Tool Pipeline model tool names are not exact.');
      }
      names.add(entry.name);
    }
  }
}

function validResolutionContextV1(
  context: Readonly<ToolPipelineResolutionContextV1>,
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
): boolean {
  return (
    Boolean(context) &&
    typeof context.currentTurnId === 'string' &&
    context.currentTurnId.length > 0 &&
    context.builtinProjectionRevision === projection.revision &&
    (context.dynamicCatalogRevision === null ||
      SHA256_HEX_V1.test(context.dynamicCatalogRevision)) &&
    Boolean(context.availabilityContext) &&
    typeof context.availabilityContext.workspace === 'string' &&
    Array.isArray(context.bindings) &&
    Array.isArray(context.descriptors) &&
    Array.isArray(context.disclosures ?? [])
  );
}

function modelEntryByNameV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  name: string,
): BuiltinModelToolCatalogEntryV1 | undefined {
  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntryV1 =>
      candidate.visibility === 'model' && candidate.name === name,
  );
  return entry;
}

function exactEntryForResolvedV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
  resolved: Readonly<ResolvedInvocationV1>,
): BuiltinModelToolCatalogEntryV1 | undefined {
  const target = resolved.target;
  const entry = modelEntryByNameV1(projection, target.exposedToolName ?? resolved.call.name);
  if (
    !entry ||
    entry.name !== resolved.call.name ||
    entry.operationId !== target.operationId ||
    entry.capabilityId !== target.capabilityId ||
    entry.revision !== target.capabilityRevision ||
    entry.providerId !== target.providerId ||
    entry.executorRevision !== target.executorRevision ||
    entry.executionMechanism !== target.executionMechanism ||
    target.executionFamily !== executionFamilyForBuiltinV1(entry.executionMechanism) ||
    target.isDynamicMcp !== false ||
    target.dynamicCatalogRevision !== null ||
    entry.descriptor.revision !== target.descriptorRevision ||
    target.descriptor !== entry.descriptor
  ) {
    return undefined;
  }
  return entry;
}

function executionFamilyForBuiltinV1(
  mechanism: BuiltinModelToolCatalogEntryV1['executionMechanism'],
): Exclude<ToolExecutionFamilyV1, 'mcp'> {
  if (mechanism === 'subagent') return 'subagent';
  if (mechanism === 'skill') return 'skill';
  return 'builtin';
}

function subagentRoleV1(
  mechanism: BuiltinModelToolCatalogEntryV1['executionMechanism'],
  argumentsValue: Readonly<Record<string, RuntimeJsonValueV1>>,
): 'explore' | 'plan' | 'code' | 'review' | null {
  if (mechanism !== 'subagent') return null;
  const role = argumentsValue.subagent_type;
  return role === 'explore' || role === 'plan' || role === 'code' || role === 'review'
    ? role
    : null;
}

function validateNestedCapabilityV1(
  entry: BuiltinModelToolCatalogEntryV1,
  resolved: Readonly<ResolvedInvocationV1>,
  argumentsValue: Readonly<Record<string, RuntimeJsonValueV1>>,
):
  | { readonly ok: true; readonly value: Readonly<ValidatedInvocationV1['nestedCapability']> }
  | {
      readonly ok: false;
      readonly failure: Readonly<{
        readonly stage: 'validate';
        readonly code:
          | 'nested_capability_missing'
          | 'nested_capability_invalid'
          | 'disclosure_missing'
          | 'disclosure_stale';
        readonly toolCallId: string | null;
        readonly toolName: string | null;
      }>;
    } {
  if (entry.operationId !== 'builtin:activate_skill') {
    return { ok: true, value: null };
  }
  const skillId = argumentsValue.skill_id;
  if (typeof skillId !== 'string' || skillId.length === 0) {
    return nestedValidationFailureV1('nested_capability_invalid', resolved);
  }
  const descriptors = resolved.disclosedCapabilities.filter(
    (candidate) => candidate.capabilityId === skillId,
  );
  if (descriptors.length === 0) {
    return nestedValidationFailureV1('nested_capability_missing', resolved);
  }
  if (descriptors.length !== 1) {
    return nestedValidationFailureV1('nested_capability_invalid', resolved);
  }
  const descriptor = descriptors[0]!;
  if (
    descriptor.kind !== 'skill' ||
    descriptor.availability !== 'available' ||
    !descriptorRevisionMatchesV1(descriptor)
  ) {
    return nestedValidationFailureV1('nested_capability_invalid', resolved);
  }
  const disclosures = resolved.disclosures.filter(
    (candidate) => candidate.capabilityId === skillId,
  );
  if (disclosures.length === 0) {
    return nestedValidationFailureV1('disclosure_missing', resolved);
  }
  if (disclosures.length !== 1) {
    return nestedValidationFailureV1('nested_capability_invalid', resolved);
  }
  const disclosure = disclosures[0]!;
  if (
    disclosure.issuedForTurnId !== resolved.call.createdAtTurnId ||
    disclosure.capabilityRevision !== descriptor.revision
  ) {
    return nestedValidationFailureV1('disclosure_stale', resolved);
  }
  return {
    ok: true,
    value: Object.freeze({ descriptor, disclosure }),
  };
}

function validNestedCapabilityV1(
  entry: BuiltinModelToolCatalogEntryV1,
  resolved: Readonly<ResolvedInvocationV1>,
  nested: NonNullable<ValidatedInvocationV1['nestedCapability']>,
): boolean {
  if (entry.operationId !== 'builtin:activate_skill') return false;
  if (
    nested.descriptor.kind !== 'skill' ||
    nested.descriptor.availability !== 'available' ||
    !descriptorRevisionMatchesV1(nested.descriptor)
  ) {
    return false;
  }
  return (
    resolved.disclosedCapabilities.includes(nested.descriptor) &&
    resolved.disclosures.includes(nested.disclosure) &&
    nested.disclosure.capabilityId === nested.descriptor.capabilityId &&
    nested.disclosure.capabilityRevision === nested.descriptor.revision &&
    nested.disclosure.issuedForTurnId === resolved.call.createdAtTurnId
  );
}

function nestedValidationFailureV1(
  code:
    | 'nested_capability_missing'
    | 'nested_capability_invalid'
    | 'disclosure_missing'
    | 'disclosure_stale',
  resolved: Readonly<ResolvedInvocationV1>,
) {
  return {
    ok: false as const,
    failure: Object.freeze({
      stage: 'validate' as const,
      code,
      toolCallId: resolved.call.toolCallId,
      toolName: resolved.call.name,
    }),
  };
}

function descriptorRevisionMatchesV1(descriptor: ToolPipelineCapabilityDescriptorV1): boolean {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.revision !== 'string') {
    return false;
  }
  const { revision, ...withoutRevision } = descriptor as Record<string, unknown>;
  return digestCapabilityBindingValueV1(withoutRevision) === revision;
}

function capabilityFromEffectsV1(effects: CapabilityEffectsV1) {
  const levels = [effects.filesystem, effects.network, effects.externalState];
  if (levels.every((level) => level === 'none' || level === 'read')) {
    return {
      effectClass: 'read_only' as const,
      sideEffect: false,
      classificationReason: 'Resolved Skill capability effects.',
    };
  }
  return {
    effectClass: 'external_side_effect' as const,
    sideEffect: true,
    classificationReason: 'Resolved Skill capability effects.',
  };
}

function riskForEffectsV1(
  effectClass: 'read_only' | 'plan_only' | 'workspace_write' | 'external_side_effect' | 'unknown',
  effects: CapabilityEffectsV1,
): ClassifiedInvocationV1['risk'] {
  if (Object.values(effects).some((effect) => effect === 'destructive')) return 'destructive';
  if (effects.filesystem === 'write') return 'workspace_write';
  if (effects.network === 'read' || effects.network === 'write') return 'network';
  if (effects.externalState === 'read' || effects.externalState === 'write')
    return 'external_state';
  if (effectClass === 'read_only') return 'read';
  if (effectClass === 'plan_only') return 'plan';
  if (effectClass === 'workspace_write') return 'workspace_write';
  if (effectClass === 'external_side_effect') return 'execute';
  return 'unknown';
}

interface BuiltinParserAuthorityV1 {
  readonly parser: CapabilityParserV1;
  readonly schemaDigest: string | null;
  readonly parse: (value: unknown) => ReturnType<CapabilityParserV1['parse']>;
  readonly canonicalize: (value: unknown) => RuntimeJsonValueV1;
  readonly observeUnknownFields: (
    value: unknown,
  ) => ReturnType<CapabilityParserV1['observeUnknownFields']>;
}

function argumentAuthorityForEntryV1(
  entry: BuiltinModelToolCatalogEntryV1,
  argumentOrigin: ToolArgumentOriginV1,
  value: unknown,
): ToolArgumentOriginV1 | null {
  if (argumentOrigin === 'model_public') return 'model_public';
  if (
    argumentOrigin !== 'runtime_private' ||
    entry.operationId !== 'builtin:task' ||
    entry.executionMechanism !== 'subagent' ||
    !isRecordUnknownV1(value) ||
    !('taskArtifact' in value)
  ) {
    return null;
  }
  // The explicit private origin is necessary but insufficient: the exact
  // frozen runtime parser must also accept the complete taskArtifact envelope.
  return entry.parse(value).success ? 'runtime_private' : null;
}

/** Select exactly the parser/schema pair that owns the model or private input. */
function parserAuthorityForEntryV1(
  entry: BuiltinModelToolCatalogEntryV1,
  privateTaskProjection: boolean,
): BuiltinParserAuthorityV1 {
  const parser = privateTaskProjection ? entry.parser : (entry.modelParser ?? entry.parser);
  const schema = privateTaskProjection
    ? (entry.inputSchema ?? entry.descriptor.inputSchema)
    : (entry.modelInputSchema ?? entry.inputSchema ?? entry.descriptor.inputSchema);
  // Omitting context is intentional: entry parsing closes over the turn that
  // created this projection, while parser operations receive no caller facts.
  const parse = (value: unknown) =>
    privateTaskProjection ? entry.parse(value) : entry.parseModelInput(value);
  const canonicalize = (value: unknown) => parser.canonicalize(value);
  const observeUnknownFields = (value: unknown) => parser.observeUnknownFields(value);
  return Object.freeze({
    parser,
    // The projected schema is the model ToolSet schema. A contextual model
    // parser may retain a stable parserRevision while its selected schema
    // digest changes with the frozen turn projection.
    schemaDigest: schema ? digestCapabilityBindingValueV1(schema) : (parser.schemaDigest ?? null),
    parse,
    canonicalize,
    observeUnknownFields,
  });
}

function nestedSkillFactsV1(
  resolved: Readonly<ResolvedInvocationV1>,
  descriptor: ToolPipelineCapabilityDescriptorV1,
  disclosure: import('@kite/runtime-spi').ToolPipelineCapabilityDisclosureV1,
  approvalSummary: string,
): RuntimeJsonValueV1 {
  const effectiveEffects = freezeEffectsV1(descriptor.effectiveEffects);
  return freezeJsonV1({
    schema: 'kite.builtin-tool-pipeline-nested-skill-facts.v1',
    toolCallId: resolved.call.toolCallId,
    callCreatedAtTurnId: resolved.call.createdAtTurnId,
    modelMessageId: resolved.call.modelMessageId,
    argumentOrigin: resolved.call.argumentOrigin,
    dynamicCatalogRevision: null,
    approvalSummary,
    nestedCatalogRevision: resolved.dynamicCatalogRevision,
    skillId: descriptor.capabilityId,
    descriptorRevision: descriptor.revision,
    descriptor: descriptor as unknown as RuntimeJsonValueV1,
    disclosure: disclosure as unknown as RuntimeJsonValueV1,
    effectiveEffects,
    effectiveEffectsDigest: digestCapabilityBindingValueV1(effectiveEffects),
    minimumApproval: descriptor.policy.minimumApproval,
  });
}

interface PreparedNestedSkillFactsV1 {
  readonly descriptor: ToolPipelineCapabilityDescriptorV1;
  readonly disclosure: import('@kite/runtime-spi').ToolPipelineCapabilityDisclosureV1;
  readonly effectiveEffects: CapabilityEffectsV1;
  readonly effectiveEffectsDigest: string;
  readonly minimumApproval: 'none' | 'auto_review' | 'user';
  readonly toolCallId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: ToolArgumentOriginV1;
  readonly dynamicCatalogRevision: null;
  readonly approvalSummary: string;
  readonly nestedCatalogRevision: string;
}

function preparedNestedSkillFactsV1(
  value: RuntimeJsonValueV1 | undefined,
): PreparedNestedSkillFactsV1 | null {
  if (!isJsonRecordOptionalV1(value)) return null;
  if (value.schema !== 'kite.builtin-tool-pipeline-nested-skill-facts.v1') return null;
  const descriptor = value.descriptor;
  const disclosure = value.disclosure;
  const effects = value.effectiveEffects;
  if (!isJsonRecordOptionalV1(descriptor) || !isJsonRecordOptionalV1(disclosure)) return null;
  if (!isJsonRecordOptionalV1(effects)) return null;
  if (
    typeof value.toolCallId !== 'string' ||
    typeof value.callCreatedAtTurnId !== 'string' ||
    typeof value.modelMessageId !== 'string' ||
    (value.argumentOrigin !== 'model_public' && value.argumentOrigin !== 'runtime_private') ||
    value.dynamicCatalogRevision !== null ||
    !isBoundedSummaryV1(value.approvalSummary) ||
    typeof value.nestedCatalogRevision !== 'string' ||
    !SHA256_HEX_V1.test(value.nestedCatalogRevision) ||
    typeof value.effectiveEffectsDigest !== 'string' ||
    !isApprovalV1(value.minimumApproval) ||
    !isEffectLevelV1(effects.filesystem) ||
    !isEffectLevelV1(effects.network) ||
    !isEffectLevelV1(effects.externalState)
  ) {
    return null;
  }
  return {
    descriptor: descriptor as unknown as ToolPipelineCapabilityDescriptorV1,
    disclosure:
      disclosure as unknown as import('@kite/runtime-spi').ToolPipelineCapabilityDisclosureV1,
    effectiveEffects: {
      filesystem: effects.filesystem,
      network: effects.network,
      externalState: effects.externalState,
    },
    effectiveEffectsDigest: value.effectiveEffectsDigest,
    minimumApproval: value.minimumApproval,
    toolCallId: value.toolCallId,
    callCreatedAtTurnId: value.callCreatedAtTurnId,
    modelMessageId: value.modelMessageId,
    argumentOrigin: value.argumentOrigin,
    dynamicCatalogRevision: null,
    approvalSummary: value.approvalSummary,
    nestedCatalogRevision: value.nestedCatalogRevision,
  };
}

function preparedNestedSkillFactsMatchV1(
  facts: PreparedNestedSkillFactsV1,
  argumentsValue: Readonly<Record<string, RuntimeJsonValueV1>>,
  identity: Readonly<PreparedToolInvocationV1['identity']>,
): boolean {
  const skillId = argumentsValue.skill_id;
  const descriptor = facts.descriptor;
  const disclosure = facts.disclosure;
  if (
    typeof skillId !== 'string' ||
    descriptor.kind !== 'skill' ||
    descriptor.availability !== 'available' ||
    descriptor.capabilityId !== skillId ||
    !descriptorRevisionMatchesV1(descriptor) ||
    disclosure.capabilityId !== descriptor.capabilityId ||
    disclosure.capabilityRevision !== descriptor.revision ||
    disclosure.issuedForTurnId !== facts.callCreatedAtTurnId ||
    facts.toolCallId !== identity.toolCallId ||
    facts.callCreatedAtTurnId !== identity.turnId ||
    facts.modelMessageId !== identity.modelMessageId ||
    facts.argumentOrigin !== identity.argumentOrigin ||
    identity.dynamicCatalogRevision !== null ||
    identity.nestedCapabilityId !== descriptor.capabilityId ||
    identity.nestedCapabilityRevision !== descriptor.revision ||
    identity.nestedCatalogRevision !== facts.nestedCatalogRevision ||
    descriptor.policy.minimumApproval !== facts.minimumApproval ||
    digestCapabilityBindingValueV1(facts.effectiveEffects) !== facts.effectiveEffectsDigest ||
    digestCapabilityBindingValueV1(descriptor.effectiveEffects) !== facts.effectiveEffectsDigest ||
    identity.effectiveEffectsDigest !== facts.effectiveEffectsDigest
  ) {
    return false;
  }
  return true;
}

function bindingMatchesEntryV1(
  binding: CapabilityBindingV1 | null,
  bindingId: string | null,
  entry: BuiltinModelToolCatalogEntryV1,
  schemaDigest: string,
): boolean {
  if (bindingId === null) return binding === null;
  if (!binding || binding.bindingId !== bindingId) return false;
  if (
    binding.capabilityId !== entry.capabilityId ||
    binding.capabilityRevision !== entry.revision ||
    binding.exposedToolName !== entry.name ||
    binding.schemaDigest !== schemaDigest
  ) {
    return false;
  }
  return (
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

function invocationRequirementsV1(
  toolKind: ClassifiedInvocationV1['validated']['resolved']['target']['toolKind'],
  classification: Pick<
    ReturnType<BuiltinModelToolCatalogEntryV1['classifyEffects']>,
    'effectClass' | 'sideEffect'
  >,
  effects: CapabilityEffectsV1,
  descriptor: ToolPipelineCapabilityDescriptorV1,
) {
  const receipt =
    toolKind === 'runtime_action'
      ? ('control_receipt' as const)
      : classification.sideEffect || hasMutationOrUnknownEffectV1(effects)
        ? ('effect_receipt' as const)
        : ('observation_receipt' as const);
  const retry =
    descriptor.execution?.retry === 'idempotency_key'
      ? ('idempotency_key_candidate' as const)
      : descriptor.execution?.retry === 'safe_read' || classification.effectClass === 'read_only'
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

function idempotencyKeyFromArgumentsV1(
  argumentsValue: Readonly<Record<string, RuntimeJsonValueV1>>,
  field: string,
): string | null {
  const value = argumentsValue[field];
  return typeof value === 'string' ? value : null;
}

function freezePolicyCompilationV1(
  value: CapabilityPolicyCompilationV1,
): Readonly<CapabilityPolicyCompilationV1> {
  return Object.freeze({
    ...value,
    ...(value.effects ? { effects: Object.freeze({ ...value.effects }) } : {}),
    ...(value.recovery ? { recovery: Object.freeze({ ...value.recovery }) } : {}),
    effectiveEffects: freezeEffectsV1(value.effectiveEffects),
    expectedEffects: Object.freeze([...value.expectedEffects]),
  });
}

function freezeEffectsV1(value: CapabilityEffectsV1): Readonly<CapabilityEffectsV1> {
  return Object.freeze({
    filesystem: value.filesystem,
    network: value.network,
    externalState: value.externalState,
  });
}

function freezeExecutionTraitsV1(
  value: CapabilityExecutionTraitsV1,
): Readonly<CapabilityExecutionTraitsV1> {
  return Object.freeze({
    ...value,
    resourceScopes: Object.freeze(value.resourceScopes.map((scope) => Object.freeze({ ...scope }))),
    conflictKeys: Object.freeze([...value.conflictKeys]),
  });
}

function freezeAvailabilityContextV1(
  value: Readonly<CapabilityAvailabilityContextV1>,
): Readonly<CapabilityAvailabilityContextV1> {
  return Object.freeze({
    ...value,
    ...(value.featureFlags ? { featureFlags: Object.freeze({ ...value.featureFlags }) } : {}),
    ...(value.activeSkillFrameIds
      ? { activeSkillFrameIds: Object.freeze([...value.activeSkillFrameIds]) }
      : {}),
    ...(value.availableSkillIds
      ? { availableSkillIds: Object.freeze([...value.availableSkillIds]) }
      : {}),
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

function isJsonRecordV1(
  value: RuntimeJsonValueV1,
): value is Readonly<Record<string, RuntimeJsonValueV1>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJsonRecordOptionalV1(
  value: RuntimeJsonValueV1 | undefined,
): value is Readonly<Record<string, RuntimeJsonValueV1>> {
  return value !== undefined && isJsonRecordV1(value);
}

function factsProvideParserContextV1(facts: RuntimeJsonValueV1 | undefined): boolean {
  return isJsonRecordOptionalV1(facts) && Object.hasOwn(facts, 'parserContext');
}

interface PreparedCallFactsV1 {
  readonly toolCallId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: ToolArgumentOriginV1;
  readonly dynamicCatalogRevision: string | null;
  readonly approvalSummary: string;
}

function preparedCallFactsV1(facts: RuntimeJsonValueV1 | undefined): PreparedCallFactsV1 | null {
  if (!isJsonRecordOptionalV1(facts)) return null;
  if (facts.schema !== BUILTIN_PREPARED_CALL_FACTS_SCHEMA_V1) {
    return null;
  }
  if (
    typeof facts.toolCallId !== 'string' ||
    facts.toolCallId.length === 0 ||
    typeof facts.callCreatedAtTurnId !== 'string' ||
    facts.callCreatedAtTurnId.length === 0 ||
    typeof facts.modelMessageId !== 'string' ||
    facts.modelMessageId.length === 0 ||
    (facts.argumentOrigin !== 'model_public' && facts.argumentOrigin !== 'runtime_private') ||
    !isBoundedSummaryV1(facts.approvalSummary) ||
    (facts.dynamicCatalogRevision !== null &&
      (typeof facts.dynamicCatalogRevision !== 'string' ||
        !SHA256_HEX_V1.test(facts.dynamicCatalogRevision)))
  ) {
    return null;
  }
  return Object.freeze({
    toolCallId: facts.toolCallId,
    callCreatedAtTurnId: facts.callCreatedAtTurnId,
    modelMessageId: facts.modelMessageId,
    argumentOrigin: facts.argumentOrigin,
    dynamicCatalogRevision: facts.dynamicCatalogRevision,
    approvalSummary: facts.approvalSummary,
  });
}

function isApprovalV1(
  value: RuntimeJsonValueV1 | undefined,
): value is 'none' | 'auto_review' | 'user' {
  return value === 'none' || value === 'auto_review' || value === 'user';
}

function isEffectLevelV1(
  value: RuntimeJsonValueV1 | undefined,
): value is 'none' | 'read' | 'write' | 'destructive' | 'unknown' {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isRecordUnknownV1(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedParseDiagnosticV1(issue: CapabilityParseIssueV1 | undefined): string {
  if (!issue) return 'Builtin arguments failed parser validation.';
  const path = issue.path
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .map((part) => String(part).slice(0, 64))
    .join('.');
  const code = issue.code.slice(0, 64);
  return `${path ? `${path}: ` : ''}${code || 'invalid_arguments'}`.slice(0, 256);
}

function boundedSummaryV1(value: string): string {
  return typeof value === 'string' ? value.slice(0, 1024) : 'Builtin tool invocation.';
}

function isBoundedSummaryV1(value: RuntimeJsonValueV1 | undefined): value is string {
  return typeof value === 'string' && value.length <= 1024;
}

function invalidIdentityV1(
  code: 'identity_mismatch' | 'revision_mismatch' | 'schema_mismatch' | 'visibility_mismatch',
): ToolPipelinePreparedIdentityVerificationResultV1 {
  return Object.freeze({ valid: false, code });
}

function invalidClassifiedIdentityV1(
  code: Extract<
    ToolPipelineClassifiedIdentityVerificationResultV1,
    { readonly valid: false }
  >['code'],
): ToolPipelineClassifiedIdentityVerificationResultV1 {
  return Object.freeze({ valid: false, code });
}

function successV1<T>(value: T): { readonly ok: true; readonly value: Readonly<T> } {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function resolveFailureV1(
  code: ToolPipelineResolveFailureCodeV1,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolResolutionResultV1 {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      stage: 'resolve' as const,
      code,
      toolCallId,
      toolName,
      ...(diagnostic ? { diagnostic: diagnostic.slice(0, 256) } : {}),
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
    ok: false as const,
    failure: Object.freeze({
      stage: 'validate' as const,
      code,
      toolCallId,
      toolName,
      ...(diagnostic ? { diagnostic: diagnostic.slice(0, 256) } : {}),
    }),
  });
}

function classifyFailureV1(
  code: ToolPipelineClassifyFailureCodeV1,
  toolCallId: string | null,
  toolName: string | null,
): ToolClassificationResultV1 {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({ stage: 'classify' as const, code, toolCallId, toolName }),
  });
}
