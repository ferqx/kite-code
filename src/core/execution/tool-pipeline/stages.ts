import { createSnapshot, descriptorRevision, digestCapability } from '@/core/capabilities/catalog';
import { canonicalizeCapabilityArguments } from '@/core/capabilities/schema';
import { evaluateToolApproval, isReadOnlyMcpPolicy } from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import {
  isDestructiveShellCommand,
  isNetworkCommand,
  isVcsMutationCommand,
} from '@/core/policies/shell-classification';
import type { ToolCapability } from '@/core/policies/tool-capabilities';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import type { ToolAvailabilityContext, ToolKind } from '@/core/tools/registry/spec';
import type {
  CapabilityBinding,
  CapabilityDescriptor,
  CapabilityDisclosure,
  EffectProfile,
} from '@/protocol/capabilities';
import {
  type AdmittedInvocationV1,
  type AuthorizedInvocationV1,
  type CanonicalToolArgumentValueV1,
  type ClassifiedInvocationV1,
  type PolicyEvaluatedInvocationV1,
  type ResolvedInvocationV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
  type ToolAdmissionStageOutcomeV1,
  type ToolAuthorizationStageOutcomeV1,
  type ToolCallSnapshotResultV1,
  type ToolCallSnapshotV1,
  type ToolClassificationResultV1,
  type ToolExecutionFamilyV1,
  type ToolInvocationRequirementsV1,
  type ToolPipelineAdmissionContextV1,
  type ToolPipelineClassifyFailureCodeV1,
  type ToolPipelineEarlyTerminalV1,
  type ToolPipelinePolicyContextV1,
  type ToolPipelineReceiptRequirementV1,
  type ToolPipelineResolutionContextV1,
  type ToolPipelineResolveFailureCodeV1,
  type ToolPipelineRiskClassV1,
  type ToolPipelineSnapshotFailureCodeV1,
  type ToolPipelineStageFailureV1,
  type ToolPipelineStageResultV1,
  type ToolPipelineValidateFailureCodeV1,
  type ToolPolicyStageOutcomeV1,
  type ToolResolutionResultV1,
  type ToolValidationResultV1,
  type ValidatedInvocationV1,
} from './types';

const MAX_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;

export function createToolCallSnapshotV1(input: {
  toolCallId: string;
  name: string;
  rawArguments: unknown;
  createdAtTurnId: string;
  bindingId?: string | null;
  capabilityId?: string | null;
  capabilityRevision?: string | null;
}): ToolCallSnapshotResultV1 {
  if (
    !boundedIdentity(input.toolCallId, MAX_ID_LENGTH) ||
    !boundedIdentity(input.name, MAX_TOOL_NAME_LENGTH) ||
    !boundedIdentity(input.createdAtTurnId, MAX_ID_LENGTH) ||
    !optionalBoundedIdentity(input.bindingId, MAX_ID_LENGTH) ||
    !optionalBoundedIdentity(input.capabilityId, MAX_ID_LENGTH) ||
    !optionalBoundedIdentity(input.capabilityRevision, MAX_ID_LENGTH)
  ) {
    return failure('snapshot', 'invalid_identity', null, null);
  }
  const cloned = canonicalToolArguments(input.rawArguments);
  if (!cloned.ok) {
    return failure('snapshot', 'arguments_not_canonical_json', input.toolCallId, input.name);
  }
  return success(
    deepFreeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'snapshot' as const,
      toolCallId: input.toolCallId,
      name: input.name,
      rawArguments: cloned.value,
      createdAtTurnId: input.createdAtTurnId,
      bindingId: input.bindingId ?? null,
      capabilityId: input.capabilityId ?? null,
      capabilityRevision: input.capabilityRevision ?? null,
    }),
  );
}

export function resolveToolInvocationV1(
  call: Readonly<ToolCallSnapshotV1>,
  context: ToolPipelineResolutionContextV1,
): ToolResolutionResultV1 {
  if (call.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || call.stage !== 'snapshot') {
    return failure('resolve', 'invalid_stage_input', null, null);
  }
  const captured = captureResolutionContext(context);
  if (!captured) {
    return failure('resolve', 'resolution_context_invalid', call.toolCallId, call.name);
  }
  if (call.createdAtTurnId !== captured.currentTurnId) {
    return failure('resolve', 'call_turn_mismatch', call.toolCallId, call.name);
  }

  const builtin = builtinToolRegistry.get(call.name);
  if (builtin) {
    if (call.bindingId || call.capabilityId || call.capabilityRevision) {
      return failure('resolve', 'unexpected_binding', call.toolCallId, call.name);
    }
    if (builtin.availability?.(captured.availabilityContext) === false) {
      return failure('resolve', 'tool_unavailable', call.toolCallId, call.name);
    }
    const descriptor = cloneBuiltinCapabilityDescriptor(builtinToolRegistry.descriptorOf(builtin));
    if (!descriptor) {
      return failure('resolve', 'resolution_context_invalid', call.toolCallId, call.name);
    }
    return success(
      deepFreeze({
        schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
        stage: 'resolved' as const,
        call,
        target: {
          executionFamily: executionFamilyForBuiltin(call.name),
          toolKind: builtin.kind,
          exposedToolName: call.name,
          descriptor,
          binding: null,
        },
        availabilityContext: captured.availabilityContext,
        catalogRevision: captured.catalogRevision,
        disclosedCapabilities: captured.descriptors.filter(
          (descriptor) => descriptor.kind === 'skill',
        ),
        disclosures: captured.disclosures,
      }),
    );
  }

  if (!call.name.startsWith('mcp__')) {
    return failure('resolve', 'unknown_tool', call.toolCallId, call.name);
  }
  if (!call.bindingId || !call.capabilityId || !call.capabilityRevision) {
    return failure('resolve', 'binding_missing', call.toolCallId, call.name);
  }
  const binding = uniqueBy(
    captured.bindings,
    (candidate) => candidate.bindingId === call.bindingId,
  );
  if (binding === 'duplicate') {
    return failure('resolve', 'resolution_context_invalid', call.toolCallId, call.name);
  }
  if (!binding) return failure('resolve', 'binding_missing', call.toolCallId, call.name);
  if (
    binding.bindingId !== call.bindingId ||
    binding.capabilityId !== call.capabilityId ||
    binding.capabilityRevision !== call.capabilityRevision
  ) {
    return failure('resolve', 'binding_identity_mismatch', call.toolCallId, call.name);
  }
  if (binding.issuedForTurnId !== call.createdAtTurnId) {
    return failure('resolve', 'binding_turn_mismatch', call.toolCallId, call.name);
  }
  if (binding.exposedToolName !== call.name) {
    return failure('resolve', 'binding_name_mismatch', call.toolCallId, call.name);
  }
  if (
    binding.bindingId !==
    digestCapability({
      capabilityId: binding.capabilityId,
      revision: binding.capabilityRevision,
      exposedToolName: binding.exposedToolName,
      schemaDigest: binding.schemaDigest,
      turnId: binding.issuedForTurnId,
    })
  ) {
    return failure('resolve', 'binding_identity_mismatch', call.toolCallId, call.name);
  }
  const descriptor = uniqueBy(
    captured.descriptors,
    (candidate) => candidate.capabilityId === binding.capabilityId,
  );
  if (descriptor === 'duplicate') {
    return failure('resolve', 'resolution_context_invalid', call.toolCallId, call.name);
  }
  if (!descriptor) return failure('resolve', 'descriptor_missing', call.toolCallId, call.name);
  if (descriptor.revision !== binding.capabilityRevision) {
    return failure('resolve', 'descriptor_revision_mismatch', call.toolCallId, call.name);
  }
  if (!descriptorRevisionIsValid(descriptor)) {
    return failure('resolve', 'descriptor_revision_mismatch', call.toolCallId, call.name);
  }
  if (descriptor.kind !== 'mcp_tool' || descriptor.provider.type !== 'mcp') {
    return failure('resolve', 'descriptor_kind_mismatch', call.toolCallId, call.name);
  }
  if (descriptor.availability !== 'available') {
    return failure('resolve', 'descriptor_unavailable', call.toolCallId, call.name);
  }
  return success(
    deepFreeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'resolved' as const,
      call,
      target: {
        executionFamily: 'mcp' as const,
        toolKind: 'computer' as const,
        exposedToolName: call.name,
        descriptor,
        binding,
      },
      availabilityContext: captured.availabilityContext,
      catalogRevision: captured.catalogRevision,
      disclosedCapabilities: captured.descriptors.filter((candidate) => candidate.kind === 'skill'),
      disclosures: captured.disclosures,
    }),
  );
}

export function validateResolvedToolInvocationV1(
  resolved: Readonly<ResolvedInvocationV1>,
): ToolValidationResultV1 {
  if (resolved.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || resolved.stage !== 'resolved') {
    return failure('validate', 'invalid_stage_input', null, null);
  }
  if (resolved.target.binding) return validateMcpInvocation(resolved);

  const spec = builtinToolRegistry.get(resolved.call.name);
  if (!spec) {
    return failure(
      'validate',
      'stage_identity_drift',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const currentDescriptor = builtinToolRegistry.descriptorOf(spec);
  if (currentDescriptor.revision !== resolved.target.descriptor.revision) {
    return failure(
      'validate',
      'stage_identity_drift',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const call = {
    id: resolved.call.toolCallId,
    name: resolved.call.name,
    args: resolved.call.rawArguments,
  };
  const privateTaskProjection =
    call.name === 'task' &&
    call.args !== null &&
    typeof call.args === 'object' &&
    !Array.isArray(call.args) &&
    'taskArtifact' in call.args;
  const parsed = privateTaskProjection
    ? builtinToolRegistry.parseRuntimeToolCall(call, resolved.availabilityContext)
    : builtinToolRegistry.parseToolCall(call, resolved.availabilityContext);
  if (!parsed.ok) {
    return failure(
      'validate',
      parsed.code === 'invalid_arguments'
        ? 'invalid_arguments'
        : parsed.code === 'tool_unavailable' || parsed.code === 'unknown_tool'
          ? 'stage_identity_drift'
          : 'invalid_arguments',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const argumentsClone = canonicalToolArgumentObject(parsed.args);
  if (!argumentsClone.ok) {
    return failure(
      'validate',
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const nested = validateNestedCapability(resolved, argumentsClone.value);
  if (!nested.ok) return nested;
  const role = subagentRole(resolved.call.name, argumentsClone.value);
  return success(
    deepFreeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'validated' as const,
      resolved,
      request: {
        source: 'builtin' as const,
        name: parsed.name,
        arguments: argumentsClone.value,
        argumentsDigest: digestCapability(argumentsClone.value),
        schemaDigest: digestCapability(resolved.target.descriptor.inputSchema ?? {}),
        approvalSummary: parsed.protectedCommand,
      },
      nestedCapability: nested.value,
      subagentRole: role,
    }),
  );
}

export function classifyValidatedToolInvocationV1(
  validated: Readonly<ValidatedInvocationV1>,
): ToolClassificationResultV1 {
  if (validated.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || validated.stage !== 'validated') {
    return failure('classify', 'invalid_stage_input', null, null);
  }
  let capability: ToolCapability | undefined;
  let governingDescriptor = validated.resolved.target.descriptor;
  if (validated.nestedCapability) {
    governingDescriptor = validated.nestedCapability.descriptor;
    capability = capabilityFromEffects(
      governingDescriptor.effectiveEffects,
      'Resolved Skill capability effects.',
    );
  } else if (validated.resolved.target.binding) {
    capability = capabilityFromEffects(
      governingDescriptor.effectiveEffects,
      'Resolved MCP capability effects.',
    );
  } else {
    const spec = builtinToolRegistry.get(validated.request.name);
    if (
      !spec ||
      builtinToolRegistry.descriptorOf(spec).revision !==
        validated.resolved.target.descriptor.revision
    ) {
      return failure(
        'classify',
        'stage_identity_drift',
        validated.resolved.call.toolCallId,
        validated.request.name,
      );
    }
    capability = builtinToolRegistry.effectsOf(
      validated.request.name,
      validated.request.arguments,
      validated.resolved.availabilityContext,
    );
  }
  if (!capability) {
    return failure(
      'classify',
      'classification_unavailable',
      validated.resolved.call.toolCallId,
      validated.request.name,
    );
  }

  const effectiveEffects = effectiveEffectsForInvocation(
    validated,
    capability,
    governingDescriptor.effectiveEffects,
  );
  const sideEffect = capability.sideEffect || hasMutationOrUnknownEffect(effectiveEffects);
  const requirements = invocationRequirements(
    validated.resolved.target.toolKind,
    capability,
    effectiveEffects,
    governingDescriptor,
  );
  const classified: ClassifiedInvocationV1 = {
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'classified',
    validated,
    capability: cloneToolCapability(capability),
    effectClass: capability.effectClass,
    effectiveEffects,
    effectiveEffectsDigest: digestCapability(effectiveEffects),
    risk: riskForInvocation(validated, capability, effectiveEffects),
    sideEffect,
    minimumApproval: governingDescriptor.policy.minimumApproval,
    requirements,
  };
  return success(deepFreeze(classified));
}

/** Deterministic gate that must run before even local Provider catalog resolution. */
export function evaluateToolPreResolutionPolicyV1(
  call: Readonly<ToolCallSnapshotV1>,
  context: { readonly providerAccess: 'admitted' | 'blocked' },
): Readonly<ToolPipelineEarlyTerminalV1> | null {
  if (
    context.providerAccess === 'blocked' &&
    (call.name.startsWith('mcp__') ||
      call.name === 'tool_search' ||
      call.name === 'list_mcp_resources' ||
      call.name === 'list_mcp_tools' ||
      call.name === 'read_mcp_resource')
  ) {
    return deepFreeze({
      kind: 'reject' as const,
      failureKind: 'mandatory_policy_unavailable' as const,
      reason: 'Provider access is unavailable under the sealed execution boundary.',
    });
  }
  return null;
}

export function evaluateClassifiedToolPolicyV1(
  classified: Readonly<ClassifiedInvocationV1>,
  context: ToolPipelinePolicyContextV1,
): ToolPolicyStageOutcomeV1 {
  if (classified.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || classified.stage !== 'classified') {
    return terminalReject('mandatory_policy_unavailable', 'Invalid classified invocation.');
  }
  if (context.gates.recoveryAdmission !== 'admitted') {
    return terminalReject('loop_exhausted', 'Runtime recovery guard blocked this invocation.');
  }
  if (context.gates.boundedCancellation !== 'admitted') {
    return terminalReject(
      'mandatory_policy_unavailable',
      'Bounded cancellation is required before production writer/child dispatch.',
    );
  }
  if (context.gates.executionBoundary !== 'admitted') {
    return terminalReject(
      'mandatory_policy_unavailable',
      'Provider access is unavailable under the sealed execution boundary.',
    );
  }
  if (context.gates.skillCapabilityCeiling !== 'admitted') {
    return terminalReject('policy_denied', 'Active Skill capability ceiling blocked this tool.');
  }

  const descriptor =
    classified.validated.nestedCapability?.descriptor ??
    classified.validated.resolved.target.descriptor;
  const mcpPolicy =
    classified.validated.resolved.target.executionFamily === 'mcp' ||
    classified.validated.nestedCapability
      ? {
          effects: descriptor.effectiveEffects,
          minimumApproval: descriptor.policy.minimumApproval,
        }
      : undefined;
  const decision = evaluateToolApproval({
    toolName: classified.validated.nestedCapability
      ? 'mcp__skill__activation'
      : classified.validated.request.name,
    toolArgs: classified.validated.request.arguments,
    phase: context.phase,
    workspace: context.workspace,
    threadId: context.threadId,
    authorization: context.authorization,
    ...(mcpPolicy ? { mcpPolicy } : {}),
    capability: classified.capability,
  });
  if (!decision.allowed) {
    const deferred =
      classified.validated.request.name === 'shell_execute' &&
      decision.phaseConstraint === 'planning';
    return terminalReject(
      deferred
        ? 'phase_deferred'
        : decision.phaseConstraint === 'planning'
          ? 'phase_denied'
          : 'policy_denied',
      deferred ? 'Deferred shell_execute until building phase.' : decision.userVisibleSummary,
    );
  }
  return {
    kind: 'continue',
    value: deepFreeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'policy_evaluated' as const,
      classified,
      decision: cloneApprovalDecision(decision),
      policyDigest: digestCapability({
        toolCallId: classified.validated.resolved.call.toolCallId,
        decision: decision.decision,
        risk: decision.risk,
        effects: decision.effects ?? null,
        minimumApproval: classified.minimumApproval,
        phase: context.phase,
        interactionMode: context.interactionMode,
      }),
    } satisfies PolicyEvaluatedInvocationV1),
  };
}

export function authorizePolicyEvaluatedToolV1(
  policy: Readonly<PolicyEvaluatedInvocationV1>,
  context: ToolPipelinePolicyContextV1,
): ToolAuthorizationStageOutcomeV1 {
  if (policy.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || policy.stage !== 'policy_evaluated') {
    return terminalReject('mandatory_policy_unavailable', 'Invalid policy stage input.');
  }
  const request = policy.classified.validated.request;
  if (request.name === 'ask_user') {
    const askDecision = createModePolicy(context.interactionMode).shouldAskUser({
      interactionMode: context.interactionMode,
      phase: context.phase,
      planKind: context.planKind,
      toolName: 'ask_user',
    });
    return askDecision.kind === 'deny'
      ? terminalReject(
          'policy_denied',
          askDecision.reason ?? 'The current interaction mode does not allow asking the user.',
        )
      : { kind: 'terminal', terminal: deepFreeze({ kind: 'request_user_input' as const }) };
  }

  const descriptor =
    policy.classified.validated.nestedCapability?.descriptor ??
    policy.classified.validated.resolved.target.descriptor;
  const mcpPolicy =
    policy.classified.validated.resolved.target.executionFamily === 'mcp' ||
    policy.classified.validated.nestedCapability
      ? {
          effects: descriptor.effectiveEffects,
          minimumApproval: descriptor.policy.minimumApproval,
        }
      : undefined;
  const requiresEffectReview =
    !isReadOnlyMcpPolicy(mcpPolicy) &&
    context.authorization.mode !== 'full_access' &&
    context.interactionMode !== 'full' &&
    Boolean(
      policy.decision.effects?.network ||
        policy.decision.effects?.externalWrite ||
        policy.decision.effects?.uncertainEffects,
    );
  const requiresApproval =
    policy.decision.requiresApproval ||
    requiresEffectReview ||
    mcpPolicy?.minimumApproval === 'user';
  if (!requiresApproval || context.callStatus === 'approved') {
    const authorizationKind =
      context.callStatus === 'approved' ? ('approved_call' as const) : ('policy_allow' as const);
    return {
      kind: 'continue',
      value: deepFreeze({
        schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
        stage: 'authorized' as const,
        policy,
        authorizationKind,
        authorizationDigest: digestCapability({
          policyDigest: policy.policyDigest,
          authorizationKind,
          authorizationMode: context.authorization.mode,
        }),
      } satisfies AuthorizedInvocationV1),
    };
  }
  if (mcpPolicy?.minimumApproval === 'user') {
    return terminalApproval('request_approval', policy.decision);
  }
  const modeDecision = createModePolicy(context.interactionMode).shouldApproveTool({
    interactionMode: context.interactionMode,
    phase: context.phase,
    planKind: context.planKind,
    toolName: request.name,
    toolRisk: policy.decision.risk,
    effects: policy.decision.effects,
    circuitBreakerTripped: context.circuitBreakerTripped,
  });
  if (modeDecision.kind === 'deny') {
    return terminalReject(
      'policy_denied',
      modeDecision.reason ?? policy.decision.userVisibleSummary,
    );
  }
  if (modeDecision.kind === 'allow') {
    return {
      kind: 'continue',
      value: deepFreeze({
        schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
        stage: 'authorized' as const,
        policy,
        authorizationKind: 'policy_allow' as const,
        authorizationDigest: digestCapability({
          policyDigest: policy.policyDigest,
          authorizationKind: 'policy_allow',
          authorizationMode: context.authorization.mode,
        }),
      } satisfies AuthorizedInvocationV1),
    };
  }
  return modeDecision.kind === 'need_auto_review'
    ? terminalApproval('request_auto_review', policy.decision)
    : terminalApproval('request_approval', policy.decision);
}

export function admitAuthorizedToolInvocationV1(
  authorized: Readonly<AuthorizedInvocationV1>,
  context: ToolPipelineAdmissionContextV1,
): ToolAdmissionStageOutcomeV1 {
  if (authorized.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || authorized.stage !== 'authorized') {
    return terminalReject('mandatory_policy_unavailable', 'Invalid authorization stage input.');
  }
  if (context.freshness !== 'current') {
    return terminalReject('mandatory_policy_unavailable', 'Admission facts became stale.');
  }
  const reservationIds = [...new Set(context.reservationIds)].sort();
  if (
    reservationIds.some((reservationId) => !boundedIdentity(reservationId, MAX_ID_LENGTH)) ||
    (context.reservationRequired && reservationIds.length === 0)
  ) {
    return terminalReject(
      'mandatory_policy_unavailable',
      'A current Runtime reservation is required before admission.',
    );
  }
  return {
    kind: 'continue',
    value: deepFreeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'admitted' as const,
      authorized,
      reservationIds,
      admissionDigest: digestCapability({
        authorizationDigest: authorized.authorizationDigest,
        reservationIds,
        freshness: context.freshness,
      }),
    } satisfies AdmittedInvocationV1),
  };
}

function terminalReject(
  failureKind: Extract<ToolPipelineEarlyTerminalV1, { kind: 'reject' }>['failureKind'],
  reason: string,
): { kind: 'terminal'; terminal: Readonly<ToolPipelineEarlyTerminalV1> } {
  return { kind: 'terminal', terminal: deepFreeze({ kind: 'reject', failureKind, reason }) };
}

function terminalApproval(
  kind: 'request_approval' | 'request_auto_review',
  decision: Readonly<import('@/core/policies/approval-policy').ApprovalDecision>,
): { kind: 'terminal'; terminal: Readonly<ToolPipelineEarlyTerminalV1> } {
  return {
    kind: 'terminal',
    terminal: deepFreeze({ kind, decision: cloneApprovalDecision(decision) }),
  };
}

function cloneApprovalDecision(
  decision: Readonly<import('@/core/policies/approval-policy').ApprovalDecision>,
): import('@/core/policies/approval-policy').ApprovalDecision {
  return {
    ...decision,
    ...(decision.effects ? { effects: { ...decision.effects } } : {}),
    expectedEffects: [...decision.expectedEffects],
  };
}

function validateMcpInvocation(resolved: Readonly<ResolvedInvocationV1>): ToolValidationResultV1 {
  const binding = resolved.target.binding;
  const schema = resolved.target.descriptor.inputSchema;
  if (!binding || !schema) {
    return failure('validate', 'schema_missing', resolved.call.toolCallId, resolved.call.name);
  }
  if (digestCapability(schema) !== binding.schemaDigest) {
    return failure(
      'validate',
      'schema_digest_mismatch',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const canonical = canonicalizeCapabilityArguments(schema, resolved.call.rawArguments);
  if (!canonical.ok) {
    return failure('validate', 'invalid_arguments', resolved.call.toolCallId, resolved.call.name);
  }
  const argumentsClone = canonicalToolArgumentObject(canonical.args);
  if (!argumentsClone.ok) {
    return failure(
      'validate',
      'arguments_not_canonical_json',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  return success(
    deepFreeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'validated' as const,
      resolved,
      request: {
        source: 'mcp' as const,
        name: resolved.call.name,
        arguments: argumentsClone.value,
        argumentsDigest: digestCapability(argumentsClone.value),
        schemaDigest: binding.schemaDigest,
        approvalSummary: resolved.call.name,
      },
      nestedCapability: null,
      subagentRole: null,
    }),
  );
}

function validateNestedCapability(
  resolved: Readonly<ResolvedInvocationV1>,
  args: Readonly<Record<string, CanonicalToolArgumentValueV1>>,
):
  | { ok: true; value: ValidatedInvocationV1['nestedCapability'] }
  | {
      ok: false;
      failure: Readonly<ToolPipelineStageFailureV1<'validate', ToolPipelineValidateFailureCodeV1>>;
    } {
  if (resolved.call.name !== 'activate_skill') return { ok: true, value: null };
  const skillId = args.skill_id;
  if (typeof skillId !== 'string') {
    return failure(
      'validate',
      'nested_capability_invalid',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const descriptor = uniqueBy(
    resolved.disclosedCapabilities,
    (candidate) => candidate.capabilityId === skillId,
  );
  if (descriptor === 'duplicate') {
    return failure(
      'validate',
      'nested_capability_invalid',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  if (!descriptor) {
    return failure(
      'validate',
      'nested_capability_missing',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  if (descriptor.kind !== 'skill' || descriptor.availability !== 'available') {
    return failure(
      'validate',
      'nested_capability_invalid',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  if (!descriptorRevisionIsValid(descriptor)) {
    return failure(
      'validate',
      'nested_capability_invalid',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  const disclosure = uniqueBy(
    resolved.disclosures,
    (candidate) => candidate.capabilityId === skillId,
  );
  if (disclosure === 'duplicate') {
    return failure(
      'validate',
      'nested_capability_invalid',
      resolved.call.toolCallId,
      resolved.call.name,
    );
  }
  if (!disclosure) {
    return failure('validate', 'disclosure_missing', resolved.call.toolCallId, resolved.call.name);
  }
  if (
    disclosure.issuedForTurnId !== resolved.call.createdAtTurnId ||
    disclosure.capabilityRevision !== descriptor.revision
  ) {
    return failure('validate', 'disclosure_stale', resolved.call.toolCallId, resolved.call.name);
  }
  return { ok: true, value: deepFreeze({ descriptor, disclosure }) };
}

function invocationRequirements(
  toolKind: ToolKind,
  capability: ToolCapability,
  effects: EffectProfile,
  descriptor: Readonly<CapabilityDescriptor>,
): Readonly<ToolInvocationRequirementsV1> {
  if (toolKind === 'interrupt') {
    return deepFreeze({
      intent: 'not_applicable',
      receipt: 'not_applicable',
      retry: 'none',
      idempotencyKeyArgument: null,
      verification: 'not_required_by_classification',
    });
  }
  const receipt: ToolPipelineReceiptRequirementV1 =
    toolKind === 'runtime_action'
      ? 'control_receipt'
      : capability.sideEffect || hasMutationOrUnknownEffect(effects)
        ? 'effect_receipt'
        : 'observation_receipt';
  const configuredRetry = descriptor.execution?.retry;
  const retry =
    configuredRetry === 'idempotency_key'
      ? ('idempotency_key_candidate' as const)
      : configuredRetry === 'safe_read' || capability.effectClass === 'read_only'
        ? ('safe_read_candidate' as const)
        : ('none' as const);
  return deepFreeze({
    intent: 'required_before_dispatch',
    receipt,
    retry,
    idempotencyKeyArgument: descriptor.execution?.idempotencyKeyArgument ?? null,
    verification:
      receipt === 'effect_receipt' ? 'after_committed_receipt' : 'not_required_by_classification',
  });
}

function riskForInvocation(
  validated: Readonly<ValidatedInvocationV1>,
  capability: ToolCapability,
  effects: EffectProfile,
): ToolPipelineRiskClassV1 {
  if (validated.request.name === 'shell_execute') {
    const command = validated.request.arguments.command;
    if (typeof command !== 'string') return 'unknown';
    if (isDestructiveShellCommand(command)) return 'destructive';
    if (isNetworkCommand(command)) return 'network';
    if (isVcsMutationCommand(command)) return 'external_state';
  }
  if (
    effects.filesystem === 'destructive' ||
    effects.network === 'destructive' ||
    effects.externalState === 'destructive'
  ) {
    return 'destructive';
  }
  if (effects.filesystem === 'write') return 'workspace_write';
  if (effects.network === 'read' || effects.network === 'write') return 'network';
  if (effects.externalState === 'read' || effects.externalState === 'write') {
    return 'external_state';
  }
  if (capability.effectClass === 'read_only') return 'read';
  if (capability.effectClass === 'plan_only') return 'plan';
  if (capability.effectClass === 'workspace_write') return 'workspace_write';
  if (capability.effectClass === 'external_side_effect') return 'execute';
  return 'unknown';
}

function effectiveEffectsForInvocation(
  validated: Readonly<ValidatedInvocationV1>,
  capability: ToolCapability,
  descriptorEffects: EffectProfile,
): Readonly<EffectProfile> {
  if (validated.nestedCapability || validated.resolved.target.binding) {
    return cloneEffectProfile(descriptorEffects);
  }
  if (capability.effectClass === 'read_only') {
    return deepFreeze({
      filesystem: descriptorEffects.filesystem === 'none' ? 'none' : 'read',
      network: descriptorEffects.network === 'none' ? 'none' : 'read',
      externalState: descriptorEffects.externalState === 'none' ? 'none' : 'read',
    });
  }
  if (capability.effectClass === 'plan_only') {
    return deepFreeze({ filesystem: 'none', network: 'none', externalState: 'none' });
  }
  if (capability.effectClass === 'workspace_write') {
    return deepFreeze({
      filesystem: 'write',
      network: descriptorEffects.network,
      externalState: descriptorEffects.externalState,
    });
  }
  return cloneEffectProfile(descriptorEffects);
}

function capabilityFromEffects(effects: EffectProfile, reason: string): ToolCapability {
  const levels = [effects.filesystem, effects.network, effects.externalState];
  if (levels.every((level) => level === 'none' || level === 'read')) {
    return { effectClass: 'read_only', sideEffect: false, classificationReason: reason };
  }
  return {
    effectClass: 'external_side_effect',
    sideEffect: true,
    classificationReason: reason,
  };
}

function hasMutationOrUnknownEffect(effects: EffectProfile): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function executionFamilyForBuiltin(name: string): ToolExecutionFamilyV1 {
  if (name === 'task') return 'subagent';
  if (name === 'activate_skill' || name === 'read_skill_reference' || name === 'complete_skill') {
    return 'skill';
  }
  return 'builtin';
}

function subagentRole(
  name: string,
  args: Readonly<Record<string, CanonicalToolArgumentValueV1>>,
): ValidatedInvocationV1['subagentRole'] {
  if (name !== 'task') return null;
  const role = args.subagent_type;
  return role === 'explore' || role === 'plan' || role === 'code' || role === 'review'
    ? role
    : null;
}

function captureResolutionContext(context: ToolPipelineResolutionContextV1): {
  currentTurnId: string;
  catalogRevision: string;
  availabilityContext: Readonly<ToolAvailabilityContext>;
  bindings: readonly Readonly<CapabilityBinding>[];
  descriptors: readonly Readonly<CapabilityDescriptor>[];
  disclosures: readonly Readonly<CapabilityDisclosure>[];
} | null {
  if (
    !boundedIdentity(context.currentTurnId, MAX_ID_LENGTH) ||
    !boundedIdentity(context.catalogRevision, MAX_ID_LENGTH)
  ) {
    return null;
  }
  try {
    const availabilityContext = normalizeAvailabilityContext(context.availabilityContext);
    const bindings = context.bindings.map((binding) => strictClone(binding));
    const descriptors = context.descriptors.map((descriptor) => strictClone(descriptor));
    const disclosures = (context.disclosures ?? []).map((disclosure) => strictClone(disclosure));
    if (
      hasDuplicate(bindings, (binding) => binding.bindingId) ||
      hasDuplicate(bindings, (binding) => binding.exposedToolName) ||
      hasDuplicate(descriptors, (descriptor) => descriptor.capabilityId) ||
      hasDuplicate(disclosures, (disclosure) => disclosure.capabilityId)
    ) {
      return null;
    }
    if (createSnapshot([...descriptors]).revision !== context.catalogRevision) return null;
    return deepFreeze({
      currentTurnId: context.currentTurnId,
      catalogRevision: context.catalogRevision,
      availabilityContext,
      bindings,
      descriptors,
      disclosures,
    });
  } catch {
    return null;
  }
}

function descriptorRevisionIsValid(descriptor: Readonly<CapabilityDescriptor>): boolean {
  const { revision, ...withoutRevision } = descriptor;
  return descriptorRevision(withoutRevision) === revision;
}

function normalizeAvailabilityContext(
  context: Readonly<ToolAvailabilityContext>,
): Readonly<ToolAvailabilityContext> {
  if (!boundedIdentity(context.workspace, 16_384)) throw new Error('invalid workspace');
  return deepFreeze({
    workspace: context.workspace,
    ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
    ...(context.phase !== undefined ? { phase: context.phase } : {}),
    ...(context.interactionMode !== undefined ? { interactionMode: context.interactionMode } : {}),
    ...(context.featureFlags !== undefined
      ? { featureFlags: strictClone(context.featureFlags) }
      : {}),
    ...(context.brokeredGitFeatureRevision !== undefined
      ? { brokeredGitFeatureRevision: context.brokeredGitFeatureRevision }
      : {}),
    ...(context.hasTaskAdapter !== undefined ? { hasTaskAdapter: context.hasTaskAdapter } : {}),
    ...(context.hasGitBroker !== undefined ? { hasGitBroker: context.hasGitBroker } : {}),
    ...(context.toolSearchEnabled !== undefined
      ? { toolSearchEnabled: context.toolSearchEnabled }
      : {}),
    ...(context.activeSkillFrameIds !== undefined
      ? { activeSkillFrameIds: strictClone(context.activeSkillFrameIds) }
      : {}),
    ...(context.availableSkillIds !== undefined
      ? { availableSkillIds: strictClone(context.availableSkillIds) }
      : {}),
  });
}

function cloneBuiltinCapabilityDescriptor(
  descriptor: CapabilityDescriptor,
): Readonly<CapabilityDescriptor> | null {
  try {
    const inputSchema = descriptor.inputSchema
      ? providerFacingBuiltinSchema(descriptor.inputSchema)
      : undefined;
    return deepFreeze(
      strictClone({
        ...descriptor,
        ...(inputSchema ? { inputSchema } : {}),
      }),
    );
  } catch {
    return null;
  }
}

/** Zod adds one hidden carrier handle; it is not part of the provider-facing schema. */
function providerFacingBuiltinSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(schema);
  const hidden = Object.entries(descriptors).filter(([, value]) => !value.enumerable);
  if (hidden.some(([key]) => key !== '~standard')) {
    throw new Error('unsupported hidden schema metadata');
  }
  return Object.fromEntries(
    Object.entries(descriptors).flatMap(([key, descriptor]) => {
      if (!descriptor.enumerable) return [];
      if (!('value' in descriptor)) throw new Error(`schema accessor: ${key}`);
      return [[key, descriptor.value]];
    }),
  );
}

function cloneEffectProfile(effects: EffectProfile): Readonly<EffectProfile> {
  return deepFreeze({
    filesystem: effects.filesystem,
    network: effects.network,
    externalState: effects.externalState,
  });
}

function cloneToolCapability(capability: ToolCapability): Readonly<ToolCapability> {
  return deepFreeze({
    effectClass: capability.effectClass,
    sideEffect: capability.sideEffect,
    classificationReason: capability.classificationReason,
  });
}

function canonicalToolArgumentObject(
  value: unknown,
): { ok: true; value: Readonly<Record<string, CanonicalToolArgumentValueV1>> } | { ok: false } {
  const cloned = canonicalToolArguments(value);
  if (!cloned.ok || !isPlainObject(cloned.value)) return { ok: false };
  return {
    ok: true,
    value: cloned.value as Readonly<Record<string, CanonicalToolArgumentValueV1>>,
  };
}

function canonicalToolArguments(
  value: unknown,
): { ok: true; value: CanonicalToolArgumentValueV1 } | { ok: false } {
  try {
    return { ok: true, value: deepFreeze(strictClone(value)) as CanonicalToolArgumentValueV1 };
  } catch {
    return { ok: false };
  }
}

function strictClone<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new Error('lone surrogate');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('non-json value');
  if (seen.has(value)) throw new Error('cyclic value');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol key');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const allowedKeys = new Set(['length']);
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable) throw new Error('sparse array');
        if (!('value' in descriptor)) throw new Error('accessor');
        output.push(strictClone(descriptor.value, seen));
      }
      if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
        throw new Error('non-index array property');
      }
      return output as T;
    }
    if (!isPlainObject(value)) throw new Error('non-plain object');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbol key');
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) throw new Error('non-enumerable property');
      if (!('value' in descriptor)) throw new Error('accessor');
      if (hasLoneSurrogate(key)) throw new Error('lone surrogate key');
      output[key] = strictClone(descriptor.value, seen);
    }
    return output as T;
  } finally {
    seen.delete(value);
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueBy<T>(items: readonly T[], predicate: (item: T) => boolean): T | 'duplicate' | null {
  const matches = items.filter(predicate);
  return matches.length > 1 ? 'duplicate' : (matches[0] ?? null);
}

function hasDuplicate<T>(items: readonly T[], key: (item: T) => string): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (!boundedIdentity(value, MAX_ID_LENGTH) || seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

function boundedIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function optionalBoundedIdentity(value: unknown, maxLength: number): boolean {
  return value == null || boundedIdentity(value, maxLength);
}

function success<Value>(
  value: Readonly<Value>,
): ToolPipelineStageResultV1<Value, never> & { readonly ok: true } {
  return deepFreeze({ ok: true as const, value });
}

function failure<
  Stage extends 'snapshot' | 'resolve' | 'validate' | 'classify',
  Code extends
    | ToolPipelineSnapshotFailureCodeV1
    | ToolPipelineResolveFailureCodeV1
    | ToolPipelineValidateFailureCodeV1
    | ToolPipelineClassifyFailureCodeV1,
>(
  stage: Stage,
  code: Code,
  toolCallId: string | null,
  toolName: string | null,
): ToolPipelineStageResultV1<never, ToolPipelineStageFailureV1<Stage, Code>> & {
  readonly ok: false;
} {
  return deepFreeze({
    ok: false as const,
    failure: { stage, code, toolCallId, toolName },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
