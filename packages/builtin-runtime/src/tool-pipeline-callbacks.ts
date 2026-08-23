import type {
  CapabilityAvailabilityContext,
  CapabilityBinding,
  CapabilityEffects,
  CapabilityExecutionTraits,
  CapabilityParseIssue,
  CapabilityParser,
  CapabilityPolicyCompilation,
  CapabilityToolKind,
  ClassifiedInvocation,
  NonDynamicOperationId,
  NonDynamicToolTarget,
  PreparedToolInvocation,
  ResolvedInvocation,
  RuntimeJsonValue,
  ToolArgumentOrigin,
  ToolCallSnapshot,
  ToolClassificationResult,
  ToolExecutionFamily,
  ToolPipelineCapabilityDescriptor,
  ToolPipelineClassifiedIdentityVerificationResult,
  ToolPipelineClassifiedIdentityVerifier,
  ToolPipelineClassifyFailureCode,
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
import { digestCapabilityBindingValue } from './capability-binding';
import type { BuiltinModelToolCatalogEntry, BuiltinToolCatalogProjection } from './tool-catalog';

export const BUILTIN_PREPARED_CALL_FACTS_SCHEMA_ =
  'kite.builtin-runtime.non-dynamic-prepared-call-facts.v1' as const;
const SHA256_HEX_ = /^[0-9a-f]{64}$/u;

/**
 * Package-only callbacks for the model-visible Builtin part of Tool Pipeline.
 *
 * This surface owns neither dispatch nor Kernel governance.  It only projects
 * the exact immutable Builtin catalog facts into the neutral SPI DTOs.
 */
export interface BuiltinToolPipelineCallbacks {
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
 * Build the single Builtin-owned callback surface from one frozen catalog
 * projection.  No registry, snapshot, executor, fallback parser, or second
 * schema/effects authority is created here.
 */
export function createBuiltinToolPipelineCallbacks(
  projection: Readonly<BuiltinToolCatalogProjection>,
): BuiltinToolPipelineCallbacks {
  assertFrozenProjection(projection);
  const classifiedAuthenticity = new WeakSet<object>();

  const resolve = (
    call: Readonly<ToolCallSnapshot>,
    context: Readonly<ToolPipelineResolutionContext>,
  ): ToolResolutionResult => resolveBuiltin(projection, call, context);

  const validate = (resolved: Readonly<ResolvedInvocation>): ToolValidationResult =>
    validateBuiltin(projection, resolved);

  const classify = (validated: Readonly<ValidatedInvocation>): ToolClassificationResult =>
    classifyBuiltin(projection, classifiedAuthenticity, validated);

  const verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier = (prepared) =>
    verifyPreparedBuiltinIdentity(projection, prepared);

  const verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifier = (classified) =>
    verifyClassifiedBuiltinIdentity(projection, classifiedAuthenticity, classified);

  return Object.freeze({
    resolve,
    validate,
    classify,
    verifyPreparedIdentity,
    verifyClassifiedIdentity,
  });
}

function resolveBuiltin(
  projection: Readonly<BuiltinToolCatalogProjection>,
  call: Readonly<ToolCallSnapshot>,
  context: Readonly<ToolPipelineResolutionContext>,
): ToolResolutionResult {
  if (call.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ || call.stage !== 'snapshot') {
    return resolveFailure('invalid_stage_input', null, null);
  }
  if (!validResolutionContext(context, projection)) {
    return resolveFailure('resolution_context_invalid', call.toolCallId, call.name);
  }
  if (call.createdAtTurnId !== context.currentTurnId) {
    return resolveFailure('call_turn_mismatch', call.toolCallId, call.name);
  }
  if (call.bindingId !== null || call.capabilityId !== null || call.capabilityRevision !== null) {
    return resolveFailure('unexpected_binding', call.toolCallId, call.name);
  }

  const entry = modelEntryByName(projection, call.name);
  if (!entry) return resolveFailure('unknown_tool', call.toolCallId, call.name);
  // `toolSet` intentionally contains only available model entries.  A
  // degraded/hidden entry therefore remains unavailable to the model surface.
  if (entry.availability !== 'available' || !Object.hasOwn(projection.toolSet, entry.name)) {
    return resolveFailure('tool_unavailable', call.toolCallId, call.name);
  }
  if (entry.kind === 'internal_runtime') {
    return resolveFailure('unknown_tool', call.toolCallId, call.name);
  }
  if (entry.operationId === 'mcp:dynamic_tool') {
    return resolveFailure('unknown_tool', call.toolCallId, call.name);
  }

  const operationId = entry.operationId as NonDynamicOperationId;
  const executionFamily = executionFamilyForBuiltin(entry.executionMechanism);
  const target: NonDynamicToolTarget = Object.freeze({
    executionFamily,
    executionMechanism: entry.executionMechanism,
    operationId,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    providerId: entry.providerId,
    executorRevision: entry.executorRevision,
    toolKind: entry.kind as CapabilityToolKind,
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

  return success({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_,
    stage: 'resolved',
    call,
    target,
    availabilityContext: freezeAvailabilityContext(context.availabilityContext),
    builtinProjectionRevision: projection.revision,
    dynamicCatalogRevision: context.dynamicCatalogRevision,
    disclosedCapabilities: freezeJsonArray(context.descriptors),
    disclosures: freezeJsonArray(context.disclosures ?? []),
  });
}

function validateBuiltin(
  projection: Readonly<BuiltinToolCatalogProjection>,
  resolved: Readonly<ResolvedInvocation>,
): ToolValidationResult {
  if (resolved.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ || resolved.stage !== 'resolved') {
    return validationFailure('invalid_stage_input', null, null);
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
    return validationFailure('stage_identity_drift', resolved.call.toolCallId, resolved.call.name);
  }
  if (resolved.builtinProjectionRevision !== projection.revision) {
    return validationFailure('stage_identity_drift', resolved.call.toolCallId, resolved.call.name);
  }
  const entry = exactEntryForResolved(projection, resolved);
  if (entry?.availability !== 'available') {
    return validationFailure('stage_identity_drift', resolved.call.toolCallId, resolved.call.name);
  }

  const argumentAuthority = argumentAuthorityForEntry(
    entry,
    resolved.call.argumentOrigin,
    resolved.call.rawArguments,
  );
  if (argumentAuthority === null) {
    return validationFailure(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      'Builtin argument origin does not match the operation input contract.',
    );
  }
  const privateTaskProjection = argumentAuthority === 'runtime_private';
  const parserAuthority = parserAuthorityForEntry(entry, privateTaskProjection);
  let observed: ReturnType<CapabilityParser['observeUnknownFields']>;
  let parsed: ReturnType<CapabilityParser['parse']>;
  try {
    // Both calls deliberately use the selected parser authority from this
    // exact entry. Unknown fields are observed for bounded diagnostics; their
    // values never cross this boundary.
    observed = parserAuthority.observeUnknownFields(resolved.call.rawArguments);
    parsed = parserAuthority.parse(resolved.call.rawArguments);
  } catch {
    return validationFailure(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      'Builtin arguments failed parser validation.',
    );
  }
  void observed;
  if (!parsed.success) {
    return validationFailure(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      boundedParseDiagnostic(parsed.issues[0]),
    );
  }

  let canonical: RuntimeJsonValue;
  try {
    canonical = freezeJson(parserAuthority.canonicalize(parsed.data));
  } catch {
    return validationFailure(
      'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
      'Builtin arguments failed canonicalization.',
    );
  }
  if (!isJsonRecord(canonical)) {
    return validationFailure(
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }

  const schemaDigest = parserAuthority.schemaDigest;
  if (!schemaDigest) {
    return validationFailure('schema_missing', resolved.call.toolCallId, resolved.call.name);
  }
  const approvalSummary = boundedSummary(entry.projectApprovalSummary(canonical));
  const request = Object.freeze({
    source: 'builtin' as const,
    operationId: target.operationId,
    name: entry.name,
    arguments: canonical,
    argumentsDigest: digestCapabilityBindingValue(canonical),
    schemaDigest,
    approvalSummary,
  });
  const subagentRole = resolveSubagentRole(target.executionMechanism, canonical);
  const nested = validateNestedCapability(entry, resolved, canonical);
  if (!nested.ok) return nested;
  return success({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_,
    stage: 'validated',
    resolved,
    request,
    nestedCapability: nested.value,
    domainData: freezeJson({
      schema: BUILTIN_PREPARED_CALL_FACTS_SCHEMA_,
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
        ? nestedSkillFacts(
            resolved,
            nested.value.descriptor,
            nested.value.disclosure,
            approvalSummary,
          )
        : null,
    }),
  });
}

function classifyBuiltin(
  projection: Readonly<BuiltinToolCatalogProjection>,
  classifiedAuthenticity: WeakSet<object>,
  validated: Readonly<ValidatedInvocation>,
): ToolClassificationResult {
  if (validated.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ || validated.stage !== 'validated') {
    return classifyFailure('invalid_stage_input', null, null);
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
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const entry = exactEntryForResolved(projection, resolved);
  if (entry === undefined) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const argumentAuthority = argumentAuthorityForEntry(
    entry,
    resolved.call.argumentOrigin,
    validated.request.arguments,
  );
  if (argumentAuthority === null) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const privateTaskProjection = argumentAuthority === 'runtime_private';
  const parserAuthority = parserAuthorityForEntry(entry, privateTaskProjection);
  if (
    entry.availability !== 'available' ||
    validated.request.name !== entry.name ||
    validated.request.operationId !== target.operationId ||
    validated.request.schemaDigest !== parserAuthority.schemaDigest ||
    validated.request.argumentsDigest !== digestCapabilityBindingValue(validated.request.arguments)
  ) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const canonical = validated.request.arguments;
  let classification: ReturnType<BuiltinModelToolCatalogEntry['classifyEffects']>;
  let policyCompilation: CapabilityPolicyCompilation;
  let executionTraits: CapabilityExecutionTraits;
  try {
    // These entry methods close over the exact turn context that produced the
    // frozen projection. Transported resolution facts must never re-select a
    // Builtin parser, classifier, policy compiler, or trait projector.
    classification = entry.classifyEffects(canonical);
    policyCompilation = entry.compilePolicy(canonical);
    executionTraits = entry.projectExecutionTraits(canonical);
  } catch {
    return classifyFailure(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const nested = validated.nestedCapability;
  if (nested && !validNestedCapability(entry, resolved, nested)) {
    return classifyFailure(
      'stage_identity_drift',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const governingDescriptor = nested?.descriptor ?? entry.descriptor;
  const capability = nested
    ? capabilityFromEffects(governingDescriptor.effectiveEffects)
    : {
        effectClass: classification.effectClass,
        sideEffect: classification.sideEffect,
        classificationReason: classification.classificationReason,
      };
  const effectiveEffects = freezeEffects(
    nested ? governingDescriptor.effectiveEffects : classification.effectiveEffects,
  );
  const effectiveEffectsDigest = digestCapabilityBindingValue(effectiveEffects);
  const schemaDigest = parserAuthority.schemaDigest;
  if (
    !schemaDigest ||
    policyCompilation.schema !== CAPABILITY_POLICY_COMPILATION_SCHEMA_ ||
    policyCompilation.operationId !== target.operationId ||
    policyCompilation.capabilityRevision !== target.capabilityRevision ||
    policyCompilation.parserRevision !== entry.parser.parserRevision ||
    policyCompilation.minimumApproval !== entry.minimumApproval ||
    (!nested &&
      digestCapabilityBindingValue(policyCompilation.effectiveEffects) !== effectiveEffectsDigest)
  ) {
    return classifyFailure(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const sideEffect = capability.sideEffect || hasMutationOrUnknownEffect(effectiveEffects);
  const requirements = invocationRequirements(
    target.toolKind,
    capability,
    effectiveEffects,
    governingDescriptor,
  );
  const frozenPolicyCompilation = freezePolicyCompilation(policyCompilation);
  const governance = createBuiltinGovernanceProjection(
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
    return classifyFailure(
      'classification_unavailable',
      resolved.call.toolCallId,
      validated.request.name,
    );
  }
  const classified: ClassifiedInvocation = {
    schema: TOOL_PIPELINE_STAGE_SCHEMA_,
    stage: 'classified',
    validated,
    descriptor: governingDescriptor,
    policyCompilation: frozenPolicyCompilation,
    governance,
    effectClass: capability.effectClass,
    effectiveEffects,
    effectiveEffectsDigest,
    risk: nested ? riskForEffects(capability.effectClass, effectiveEffects) : classification.risk,
    sideEffect,
    minimumApproval: governingDescriptor.policy.minimumApproval,
    executionTraits: nested ? null : freezeExecutionTraits(executionTraits),
    requirements,
  };
  classifiedAuthenticity.add(classified);
  return success(classified);
}

function createBuiltinGovernanceProjection(
  projection: Readonly<BuiltinToolCatalogProjection>,
  entry: BuiltinModelToolCatalogEntry,
  resolved: Readonly<ResolvedInvocation>,
  validated: Readonly<ValidatedInvocation>,
  parserAuthority: BuiltinParserAuthority,
  policyCompilation: Readonly<CapabilityPolicyCompilation>,
  effectiveEffects: Readonly<CapabilityEffects>,
  effectiveEffectsDigest: string,
  nested: Readonly<ValidatedInvocation['nestedCapability']>,
): Readonly<ToolPipelineGovernanceProjection> | null {
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
    commandDigest: commandDigestForBuiltin(target.executionMechanism, validated.request.arguments),
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
        decision: nestedSkillDecision(nested.descriptor),
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

function commandDigestForBuiltin(
  mechanism: BuiltinModelToolCatalogEntry['executionMechanism'],
  argumentsValue: RuntimeJsonValue,
): string | null {
  if (mechanism !== 'shell' || !isJsonRecord(argumentsValue)) return null;
  const command = argumentsValue.command;
  if (typeof command !== 'string') return null;
  const canonicalCommand = command.trim();
  return canonicalCommand.length > 0 ? digestCapabilityBindingValue(canonicalCommand) : null;
}

function nestedSkillDecision(
  descriptor: ToolPipelineCapabilityDescriptor,
): CapabilityPolicyCompilation['decision'] {
  if (descriptor.policy.minimumApproval === 'none') return 'allow';
  return descriptor.availability === 'available' ? 'ask' : 'deny';
}

function verifyClassifiedBuiltinIdentity(
  projection: Readonly<BuiltinToolCatalogProjection>,
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
  const target = resolved?.target;
  if (
    classified.schema !== TOOL_PIPELINE_STAGE_SCHEMA_ ||
    classified.stage !== 'classified' ||
    !governance ||
    !validated ||
    !resolved ||
    !target ||
    target.isDynamicMcp ||
    governance.invocation.isDynamicMcp !== false
  ) {
    return invalidClassifiedIdentity('invocation_mismatch');
  }
  const entry = exactEntryForResolved(projection, resolved);
  if (entry === undefined) return invalidClassifiedIdentity('invocation_mismatch');
  const argumentAuthority = argumentAuthorityForEntry(
    entry,
    resolved.call.argumentOrigin,
    validated.request.arguments,
  );
  if (argumentAuthority === null) return invalidClassifiedIdentity('invocation_mismatch');
  const parserAuthority = parserAuthorityForEntry(entry, argumentAuthority === 'runtime_private');
  const invocation = governance.invocation;
  const nested = validated.nestedCapability;
  const expectedNestedCatalogRevision = nested ? resolved.dynamicCatalogRevision : null;
  const expectedCommandDigest = commandDigestForBuiltin(
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
    return invalidClassifiedIdentity('invocation_mismatch');
  }
  if (
    governance.policy !== classified.policyCompilation ||
    governance.effectiveEffects !== classified.effectiveEffects ||
    governance.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    governance.dynamicMcp !== null
  ) {
    return invalidClassifiedIdentity('effects_mismatch');
  }
  if (nested) {
    if (
      entry.operationId !== 'builtin:activate_skill' ||
      !governance.nestedSkill ||
      governance.nestedSkill.operationId !== 'builtin:activate_skill' ||
      governance.nestedSkill.capabilityId !== nested.descriptor.capabilityId ||
      governance.nestedSkill.capabilityRevision !== nested.descriptor.revision ||
      governance.nestedSkill.nestedCatalogRevision !== resolved.dynamicCatalogRevision ||
      governance.nestedSkill.decision !== nestedSkillDecision(nested.descriptor) ||
      governance.nestedSkill.minimumApproval !== nested.descriptor.policy.minimumApproval
    ) {
      return invalidClassifiedIdentity('nested_skill_mismatch');
    }
  } else if (governance.nestedSkill !== null) {
    return invalidClassifiedIdentity('nested_skill_mismatch');
  }
  if (
    !Object.isFrozen(governance) ||
    !Object.isFrozen(governance.invocation) ||
    !Object.isFrozen(governance.effectiveEffects) ||
    !Object.isFrozen(governance.policy) ||
    (governance.nestedSkill !== null && !Object.isFrozen(governance.nestedSkill))
  ) {
    return invalidClassifiedIdentity('governance_missing');
  }
  return Object.freeze({ valid: true });
}

function verifyPreparedBuiltinIdentity(
  projection: Readonly<BuiltinToolCatalogProjection>,
  prepared: Readonly<PreparedToolInvocation>,
): ToolPipelinePreparedIdentityVerificationResult {
  // This is identity-only. Authorization, admission, and Kernel governance
  // remain owned by the separate Kernel governance seam; no policy decision
  // or executor/dispatch callback is reachable from this verifier.
  const identity = prepared?.identity;
  const input = prepared?.input;
  if (!identity || !input || typeof identity !== 'object' || typeof input !== 'object') {
    return invalidIdentity('identity_mismatch');
  }
  if (
    identity.isDynamicMcp === true ||
    String(identity.executionFamily) === 'mcp' ||
    identity.operationId === 'mcp:dynamic_tool' ||
    identity.builtinProjectionRevision === null
  ) {
    return invalidIdentity('identity_mismatch');
  }
  if (
    identity.isDynamicMcp !== false ||
    identity.visibility !== 'model' ||
    identity.modelVisible !== true ||
    typeof identity.exposedToolName !== 'string' ||
    identity.exposedToolName.length === 0
  ) {
    return invalidIdentity('visibility_mismatch');
  }
  if (identity.builtinProjectionRevision !== projection.revision) {
    return invalidIdentity('revision_mismatch');
  }
  if (identity.dynamicCatalogRevision !== null) {
    return invalidIdentity('revision_mismatch');
  }

  const entry = modelEntryByName(projection, identity.exposedToolName);
  if (entry?.availability !== 'available') {
    return invalidIdentity('revision_mismatch');
  }
  if (entry.kind === 'interrupt' || entry.executionMechanism === 'user_input') {
    return invalidIdentity('visibility_mismatch');
  }
  const argumentAuthority = argumentAuthorityForEntry(
    entry,
    identity.argumentOrigin,
    input.arguments,
  );
  if (argumentAuthority === null) return invalidIdentity('identity_mismatch');
  const privateTaskProjection = argumentAuthority === 'runtime_private';
  const parserAuthority = parserAuthorityForEntry(entry, privateTaskProjection);
  const schemaDigest = parserAuthority.schemaDigest;
  if (!schemaDigest) return invalidIdentity('schema_mismatch');
  if (
    entry.operationId === 'mcp:dynamic_tool' ||
    identity.operationId !== entry.operationId ||
    identity.executionFamily !== executionFamilyForBuiltin(entry.executionMechanism) ||
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
    return invalidIdentity('identity_mismatch');
  }
  if (
    input.invocationId !== identity.invocationId ||
    input.attemptId !== identity.attemptId ||
    input.toolCallId !== identity.toolCallId
  ) {
    return invalidIdentity('identity_mismatch');
  }
  const outerFacts =
    isJsonRecordOptional(input.facts) && input.facts.schema === BUILTIN_PREPARED_CALL_FACTS_SCHEMA_
      ? input.facts
      : undefined;
  if (!outerFacts) return invalidIdentity('identity_mismatch');
  const callFacts = preparedCallFacts(outerFacts);
  if (
    !callFacts ||
    callFacts.toolCallId !== identity.toolCallId ||
    callFacts.callCreatedAtTurnId !== identity.turnId ||
    callFacts.modelMessageId !== identity.modelMessageId ||
    callFacts.argumentOrigin !== identity.argumentOrigin ||
    callFacts.argumentOrigin !== argumentAuthority ||
    callFacts.dynamicCatalogRevision !== null
  ) {
    return invalidIdentity('identity_mismatch');
  }
  if (!bindingMatchesEntry(input.binding, identity.bindingId, entry, schemaDigest)) {
    return invalidIdentity('identity_mismatch');
  }

  let canonical: RuntimeJsonValue;
  let classification: ReturnType<BuiltinModelToolCatalogEntry['classifyEffects']>;
  let parsed: ReturnType<CapabilityParser['parse']>;
  if (factsProvideParserContext(outerFacts)) {
    return invalidIdentity('identity_mismatch');
  }
  try {
    parserAuthority.observeUnknownFields(input.arguments);
    parsed = parserAuthority.parse(input.arguments);
    if (!parsed.success) return invalidIdentity('schema_mismatch');
    canonical = freezeJson(parserAuthority.canonicalize(parsed.data));
    if (!isJsonRecord(canonical)) return invalidIdentity('schema_mismatch');
    classification = entry.classifyEffects(canonical);
  } catch {
    return invalidIdentity('schema_mismatch');
  }
  if (identity.argumentsDigest !== digestCapabilityBindingValue(canonical)) {
    return invalidIdentity('identity_mismatch');
  }
  let approvalSummary: string;
  try {
    approvalSummary = boundedSummary(entry.projectApprovalSummary(canonical));
  } catch {
    return invalidIdentity('identity_mismatch');
  }
  if (callFacts.approvalSummary !== approvalSummary) {
    return invalidIdentity('identity_mismatch');
  }
  if (entry.operationId === 'builtin:activate_skill') {
    let nestedFacts: PreparedNestedSkillFacts | null;
    try {
      nestedFacts = preparedNestedSkillFacts(outerFacts.nestedSkill);
      if (!nestedFacts || !preparedNestedSkillFactsMatch(nestedFacts, canonical, identity)) {
        return invalidIdentity('identity_mismatch');
      }
    } catch {
      return invalidIdentity('identity_mismatch');
    }
  } else if (
    identity.nestedCapabilityId !== null ||
    identity.nestedCapabilityRevision !== null ||
    identity.nestedCatalogRevision !== null ||
    identity.effectiveEffectsDigest !==
      digestCapabilityBindingValue(classification.effectiveEffects)
  ) {
    return invalidIdentity('identity_mismatch');
  }

  const configuredIdempotencyArgument = entry.execution?.idempotencyKeyArgument ?? null;
  const expectedIdempotencyKey = configuredIdempotencyArgument
    ? idempotencyKeyFromArguments(canonical, configuredIdempotencyArgument)
    : null;
  if (
    identity.idempotencyKeyArgument !== configuredIdempotencyArgument ||
    identity.idempotencyKey !== expectedIdempotencyKey
  ) {
    return invalidIdentity('identity_mismatch');
  }
  return Object.freeze({ valid: true });
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

function validResolutionContext(
  context: Readonly<ToolPipelineResolutionContext>,
  projection: Readonly<BuiltinToolCatalogProjection>,
): boolean {
  return (
    Boolean(context) &&
    typeof context.currentTurnId === 'string' &&
    context.currentTurnId.length > 0 &&
    context.builtinProjectionRevision === projection.revision &&
    (context.dynamicCatalogRevision === null || SHA256_HEX_.test(context.dynamicCatalogRevision)) &&
    Boolean(context.availabilityContext) &&
    typeof context.availabilityContext.workspace === 'string' &&
    Array.isArray(context.bindings) &&
    Array.isArray(context.descriptors) &&
    Array.isArray(context.disclosures ?? [])
  );
}

function modelEntryByName(
  projection: Readonly<BuiltinToolCatalogProjection>,
  name: string,
): BuiltinModelToolCatalogEntry | undefined {
  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.name === name,
  );
  return entry;
}

function exactEntryForResolved(
  projection: Readonly<BuiltinToolCatalogProjection>,
  resolved: Readonly<ResolvedInvocation>,
): BuiltinModelToolCatalogEntry | undefined {
  const target = resolved.target;
  const entry = modelEntryByName(projection, target.exposedToolName ?? resolved.call.name);
  if (
    !entry ||
    entry.name !== resolved.call.name ||
    entry.operationId !== target.operationId ||
    entry.capabilityId !== target.capabilityId ||
    entry.revision !== target.capabilityRevision ||
    entry.providerId !== target.providerId ||
    entry.executorRevision !== target.executorRevision ||
    entry.executionMechanism !== target.executionMechanism ||
    target.executionFamily !== executionFamilyForBuiltin(entry.executionMechanism) ||
    target.isDynamicMcp !== false ||
    target.dynamicCatalogRevision !== null ||
    entry.descriptor.revision !== target.descriptorRevision ||
    target.descriptor !== entry.descriptor
  ) {
    return undefined;
  }
  return entry;
}

function executionFamilyForBuiltin(
  mechanism: BuiltinModelToolCatalogEntry['executionMechanism'],
): Exclude<ToolExecutionFamily, 'mcp'> {
  if (mechanism === 'subagent') return 'subagent';
  if (mechanism === 'skill') return 'skill';
  return 'builtin';
}

function resolveSubagentRole(
  mechanism: BuiltinModelToolCatalogEntry['executionMechanism'],
  argumentsValue: Readonly<Record<string, RuntimeJsonValue>>,
): 'explore' | 'plan' | 'code' | 'review' | null {
  if (mechanism !== 'subagent') return null;
  const role = argumentsValue.subagent_type;
  return role === 'explore' || role === 'plan' || role === 'code' || role === 'review'
    ? role
    : null;
}

function validateNestedCapability(
  entry: BuiltinModelToolCatalogEntry,
  resolved: Readonly<ResolvedInvocation>,
  argumentsValue: Readonly<Record<string, RuntimeJsonValue>>,
):
  | { readonly ok: true; readonly value: Readonly<ValidatedInvocation['nestedCapability']> }
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
    return nestedValidationFailure('nested_capability_invalid', resolved);
  }
  const descriptors = resolved.disclosedCapabilities.filter(
    (candidate) => candidate.capabilityId === skillId,
  );
  if (descriptors.length === 0) {
    return nestedValidationFailure('nested_capability_missing', resolved);
  }
  if (descriptors.length !== 1) {
    return nestedValidationFailure('nested_capability_invalid', resolved);
  }
  const descriptor = descriptors[0]!;
  if (
    descriptor.kind !== 'skill' ||
    descriptor.availability !== 'available' ||
    !descriptorRevisionMatches(descriptor)
  ) {
    return nestedValidationFailure('nested_capability_invalid', resolved);
  }
  const disclosures = resolved.disclosures.filter(
    (candidate) => candidate.capabilityId === skillId,
  );
  if (disclosures.length === 0) {
    return nestedValidationFailure('disclosure_missing', resolved);
  }
  if (disclosures.length !== 1) {
    return nestedValidationFailure('nested_capability_invalid', resolved);
  }
  const disclosure = disclosures[0]!;
  if (
    disclosure.issuedForTurnId !== resolved.call.createdAtTurnId ||
    disclosure.capabilityRevision !== descriptor.revision
  ) {
    return nestedValidationFailure('disclosure_stale', resolved);
  }
  return {
    ok: true,
    value: Object.freeze({ descriptor, disclosure }),
  };
}

function validNestedCapability(
  entry: BuiltinModelToolCatalogEntry,
  resolved: Readonly<ResolvedInvocation>,
  nested: NonNullable<ValidatedInvocation['nestedCapability']>,
): boolean {
  if (entry.operationId !== 'builtin:activate_skill') return false;
  if (
    nested.descriptor.kind !== 'skill' ||
    nested.descriptor.availability !== 'available' ||
    !descriptorRevisionMatches(nested.descriptor)
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

function nestedValidationFailure(
  code:
    | 'nested_capability_missing'
    | 'nested_capability_invalid'
    | 'disclosure_missing'
    | 'disclosure_stale',
  resolved: Readonly<ResolvedInvocation>,
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

function descriptorRevisionMatches(descriptor: ToolPipelineCapabilityDescriptor): boolean {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.revision !== 'string') {
    return false;
  }
  const { revision, ...withoutRevision } = descriptor as Record<string, unknown>;
  return digestCapabilityBindingValue(withoutRevision) === revision;
}

function capabilityFromEffects(effects: CapabilityEffects) {
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

function riskForEffects(
  effectClass: 'read_only' | 'plan_only' | 'workspace_write' | 'external_side_effect' | 'unknown',
  effects: CapabilityEffects,
): ClassifiedInvocation['risk'] {
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

interface BuiltinParserAuthority {
  readonly parser: CapabilityParser;
  readonly schemaDigest: string | null;
  readonly parse: (value: unknown) => ReturnType<CapabilityParser['parse']>;
  readonly canonicalize: (value: unknown) => RuntimeJsonValue;
  readonly observeUnknownFields: (
    value: unknown,
  ) => ReturnType<CapabilityParser['observeUnknownFields']>;
}

function argumentAuthorityForEntry(
  entry: BuiltinModelToolCatalogEntry,
  argumentOrigin: ToolArgumentOrigin,
  value: unknown,
): ToolArgumentOrigin | null {
  if (argumentOrigin === 'model_public') return 'model_public';
  if (
    argumentOrigin !== 'runtime_private' ||
    entry.operationId !== 'builtin:task' ||
    entry.executionMechanism !== 'subagent' ||
    !isRecordUnknown(value) ||
    !('taskArtifact' in value)
  ) {
    return null;
  }
  // The explicit private origin is necessary but insufficient: the exact
  // frozen runtime parser must also accept the complete taskArtifact envelope.
  return entry.parse(value).success ? 'runtime_private' : null;
}

/** Select exactly the parser/schema pair that owns the model or private input. */
function parserAuthorityForEntry(
  entry: BuiltinModelToolCatalogEntry,
  privateTaskProjection: boolean,
): BuiltinParserAuthority {
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
    schemaDigest: schema ? digestCapabilityBindingValue(schema) : (parser.schemaDigest ?? null),
    parse,
    canonicalize,
    observeUnknownFields,
  });
}

function nestedSkillFacts(
  resolved: Readonly<ResolvedInvocation>,
  descriptor: ToolPipelineCapabilityDescriptor,
  disclosure: import('@kite/runtime-spi').ToolPipelineCapabilityDisclosure,
  approvalSummary: string,
): RuntimeJsonValue {
  const effectiveEffects = freezeEffects(descriptor.effectiveEffects);
  return freezeJson({
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
    descriptor: descriptor as unknown as RuntimeJsonValue,
    disclosure: disclosure as unknown as RuntimeJsonValue,
    effectiveEffects,
    effectiveEffectsDigest: digestCapabilityBindingValue(effectiveEffects),
    minimumApproval: descriptor.policy.minimumApproval,
  });
}

interface PreparedNestedSkillFacts {
  readonly descriptor: ToolPipelineCapabilityDescriptor;
  readonly disclosure: import('@kite/runtime-spi').ToolPipelineCapabilityDisclosure;
  readonly effectiveEffects: CapabilityEffects;
  readonly effectiveEffectsDigest: string;
  readonly minimumApproval: 'none' | 'auto_review' | 'user';
  readonly toolCallId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly dynamicCatalogRevision: null;
  readonly approvalSummary: string;
  readonly nestedCatalogRevision: string;
}

function preparedNestedSkillFacts(
  value: RuntimeJsonValue | undefined,
): PreparedNestedSkillFacts | null {
  if (!isJsonRecordOptional(value)) return null;
  if (value.schema !== 'kite.builtin-tool-pipeline-nested-skill-facts.v1') return null;
  const descriptor = value.descriptor;
  const disclosure = value.disclosure;
  const effects = value.effectiveEffects;
  if (!isJsonRecordOptional(descriptor) || !isJsonRecordOptional(disclosure)) return null;
  if (!isJsonRecordOptional(effects)) return null;
  if (
    typeof value.toolCallId !== 'string' ||
    typeof value.callCreatedAtTurnId !== 'string' ||
    typeof value.modelMessageId !== 'string' ||
    (value.argumentOrigin !== 'model_public' && value.argumentOrigin !== 'runtime_private') ||
    value.dynamicCatalogRevision !== null ||
    !isBoundedSummary(value.approvalSummary) ||
    typeof value.nestedCatalogRevision !== 'string' ||
    !SHA256_HEX_.test(value.nestedCatalogRevision) ||
    typeof value.effectiveEffectsDigest !== 'string' ||
    !isApproval(value.minimumApproval) ||
    !isEffectLevel(effects.filesystem) ||
    !isEffectLevel(effects.network) ||
    !isEffectLevel(effects.externalState)
  ) {
    return null;
  }
  return {
    descriptor: descriptor as unknown as ToolPipelineCapabilityDescriptor,
    disclosure:
      disclosure as unknown as import('@kite/runtime-spi').ToolPipelineCapabilityDisclosure,
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

function preparedNestedSkillFactsMatch(
  facts: PreparedNestedSkillFacts,
  argumentsValue: Readonly<Record<string, RuntimeJsonValue>>,
  identity: Readonly<PreparedToolInvocation['identity']>,
): boolean {
  const skillId = argumentsValue.skill_id;
  const descriptor = facts.descriptor;
  const disclosure = facts.disclosure;
  if (
    typeof skillId !== 'string' ||
    descriptor.kind !== 'skill' ||
    descriptor.availability !== 'available' ||
    descriptor.capabilityId !== skillId ||
    !descriptorRevisionMatches(descriptor) ||
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
    digestCapabilityBindingValue(facts.effectiveEffects) !== facts.effectiveEffectsDigest ||
    digestCapabilityBindingValue(descriptor.effectiveEffects) !== facts.effectiveEffectsDigest ||
    identity.effectiveEffectsDigest !== facts.effectiveEffectsDigest
  ) {
    return false;
  }
  return true;
}

function bindingMatchesEntry(
  binding: CapabilityBinding | null,
  bindingId: string | null,
  entry: BuiltinModelToolCatalogEntry,
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
    digestCapabilityBindingValue({
      capabilityId: binding.capabilityId,
      revision: binding.capabilityRevision,
      exposedToolName: binding.exposedToolName,
      schemaDigest: binding.schemaDigest,
      turnId: binding.issuedForTurnId,
    })
  );
}

function invocationRequirements(
  toolKind: ClassifiedInvocation['validated']['resolved']['target']['toolKind'],
  classification: Pick<
    ReturnType<BuiltinModelToolCatalogEntry['classifyEffects']>,
    'effectClass' | 'sideEffect'
  >,
  effects: CapabilityEffects,
  descriptor: ToolPipelineCapabilityDescriptor,
) {
  const receipt =
    toolKind === 'runtime_action'
      ? ('control_receipt' as const)
      : classification.sideEffect || hasMutationOrUnknownEffect(effects)
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

function hasMutationOrUnknownEffect(effects: CapabilityEffects): boolean {
  return Object.values(effects).some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function idempotencyKeyFromArguments(
  argumentsValue: Readonly<Record<string, RuntimeJsonValue>>,
  field: string,
): string | null {
  const value = argumentsValue[field];
  return typeof value === 'string' ? value : null;
}

function freezePolicyCompilation(
  value: CapabilityPolicyCompilation,
): Readonly<CapabilityPolicyCompilation> {
  return Object.freeze({
    ...value,
    ...(value.effects ? { effects: Object.freeze({ ...value.effects }) } : {}),
    ...(value.recovery ? { recovery: Object.freeze({ ...value.recovery }) } : {}),
    effectiveEffects: freezeEffects(value.effectiveEffects),
    expectedEffects: Object.freeze([...value.expectedEffects]),
  });
}

function freezeEffects(value: CapabilityEffects): Readonly<CapabilityEffects> {
  return Object.freeze({
    filesystem: value.filesystem,
    network: value.network,
    externalState: value.externalState,
  });
}

function freezeExecutionTraits(
  value: CapabilityExecutionTraits,
): Readonly<CapabilityExecutionTraits> {
  return Object.freeze({
    ...value,
    resourceScopes: Object.freeze(value.resourceScopes.map((scope) => Object.freeze({ ...scope }))),
    conflictKeys: Object.freeze([...value.conflictKeys]),
  });
}

function freezeAvailabilityContext(
  value: Readonly<CapabilityAvailabilityContext>,
): Readonly<CapabilityAvailabilityContext> {
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

function isJsonRecord(
  value: RuntimeJsonValue,
): value is Readonly<Record<string, RuntimeJsonValue>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJsonRecordOptional(
  value: RuntimeJsonValue | undefined,
): value is Readonly<Record<string, RuntimeJsonValue>> {
  return value !== undefined && isJsonRecord(value);
}

function factsProvideParserContext(facts: RuntimeJsonValue | undefined): boolean {
  return isJsonRecordOptional(facts) && Object.hasOwn(facts, 'parserContext');
}

interface PreparedCallFacts {
  readonly toolCallId: string;
  readonly callCreatedAtTurnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly dynamicCatalogRevision: string | null;
  readonly approvalSummary: string;
}

function preparedCallFacts(facts: RuntimeJsonValue | undefined): PreparedCallFacts | null {
  if (!isJsonRecordOptional(facts)) return null;
  if (facts.schema !== BUILTIN_PREPARED_CALL_FACTS_SCHEMA_) {
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
    !isBoundedSummary(facts.approvalSummary) ||
    (facts.dynamicCatalogRevision !== null &&
      (typeof facts.dynamicCatalogRevision !== 'string' ||
        !SHA256_HEX_.test(facts.dynamicCatalogRevision)))
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

function isApproval(value: RuntimeJsonValue | undefined): value is 'none' | 'auto_review' | 'user' {
  return value === 'none' || value === 'auto_review' || value === 'user';
}

function isEffectLevel(
  value: RuntimeJsonValue | undefined,
): value is 'none' | 'read' | 'write' | 'destructive' | 'unknown' {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isRecordUnknown(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedParseDiagnostic(issue: CapabilityParseIssue | undefined): string {
  if (!issue) return 'Builtin arguments failed parser validation.';
  const path = issue.path
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .map((part) => String(part).slice(0, 64))
    .join('.');
  const code = issue.code.slice(0, 64);
  return `${path ? `${path}: ` : ''}${code || 'invalid_arguments'}`.slice(0, 256);
}

function boundedSummary(value: string): string {
  return typeof value === 'string' ? value.slice(0, 1024) : 'Builtin tool invocation.';
}

function isBoundedSummary(value: RuntimeJsonValue | undefined): value is string {
  return typeof value === 'string' && value.length <= 1024;
}

function invalidIdentity(
  code: 'identity_mismatch' | 'revision_mismatch' | 'schema_mismatch' | 'visibility_mismatch',
): ToolPipelinePreparedIdentityVerificationResult {
  return Object.freeze({ valid: false, code });
}

function invalidClassifiedIdentity(
  code: Extract<
    ToolPipelineClassifiedIdentityVerificationResult,
    { readonly valid: false }
  >['code'],
): ToolPipelineClassifiedIdentityVerificationResult {
  return Object.freeze({ valid: false, code });
}

function success<T>(value: T): { readonly ok: true; readonly value: Readonly<T> } {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function resolveFailure(
  code: ToolPipelineResolveFailureCode,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolResolutionResult {
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

function validationFailure(
  code: ToolPipelineValidateFailureCode,
  toolCallId: string | null,
  toolName: string | null,
  diagnostic?: string,
): ToolValidationResult {
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

function classifyFailure(
  code: ToolPipelineClassifyFailureCode,
  toolCallId: string | null,
  toolName: string | null,
): ToolClassificationResult {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({ stage: 'classify' as const, code, toolCallId, toolName }),
  });
}
