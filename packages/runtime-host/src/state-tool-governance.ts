import {
  type AgentAuthorizationState,
  admitToolGovernanceV1,
  authorizationCommandGrantKeyV1,
  authorizeToolGovernanceV1,
  createToolGovernanceCommandDigestV1,
  isValidToolGovernanceFactsV1,
  TOOL_GOVERNANCE_FACTS_SCHEMA_V1,
  type ToolGovernanceAdmissionFactsV1,
  type ToolGovernanceApprovalFactV1,
  type ToolGovernanceAuthorizationDecisionV1,
  type ToolGovernanceContextFactsV1,
  type ToolGovernanceDecisionV1,
  type ToolGovernanceFactsV1,
  type ToolGovernanceInvocationFactV1,
  type ToolGovernanceNestedSkillFactV1,
  type ToolGovernancePolicyFactV1,
  type ToolGovernanceSameCommandGrantFactV1,
} from '@kite/agent-kernel';
import {
  CAPABILITY_POLICY_COMPILATION_SCHEMA_V1,
  type ClassifiedInvocationV1,
  type RuntimeJsonValueV1,
  type ToolPipelineClassifiedIdentityVerificationResultV1,
  type ToolPipelineClassifiedIdentityVerifierV1,
  type ToolPipelineGovernanceDynamicInvocationProjectionV1,
  type ToolPipelineGovernanceNestedSkillProjectionV1,
  type ToolPipelineGovernanceOrdinaryInvocationProjectionV1,
  type ToolPipelineGovernanceProjectionV1,
} from '@kite/runtime-spi';

/** Host-facing aliases keep App composition from depending on Agent Kernel directly. */
export type RuntimeHostStateToolGovernanceFactsV1 = ToolGovernanceFactsV1;
export type RuntimeHostStateToolGovernanceDecisionV1 = ToolGovernanceDecisionV1;

/**
 * State 25 authorization facts supplied by Host around one Builtin-owned
 * classification. Workspace and thread identity are deliberately supplied
 * here: Builtin governance must not manufacture Host session identity.
 */
export interface RuntimeHostStateToolGovernanceAuthorizationInputV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly classified: Readonly<ClassifiedInvocationV1<TArguments>>;
  readonly workspace: string;
  readonly threadId: string;
  readonly context: Readonly<
    Omit<ToolGovernanceContextFactsV1, 'executionMechanism' | 'gates'> & {
      readonly gates: Readonly<ToolGovernanceContextFactsV1['gates']>;
    }
  >;
  readonly approval: Readonly<ToolGovernanceApprovalFactV1>;
  /**
   * A private State 25 authorization lookup. The command is used only to
   * select the exact persisted grant; its digest must already be present in
   * the authentic Builtin governance projection.
   */
  readonly sameCommandGrant?: Readonly<RuntimeHostStateSameCommandGrantInputV1>;
}

/** Full projection input; admission is deliberately supplied only at admit. */
export interface RuntimeHostStateToolGovernanceInputV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> extends RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments> {
  readonly admission: Readonly<ToolGovernanceAdmissionFactsV1>;
}

export interface RuntimeHostStateSameCommandGrantInputV1 {
  readonly authorization: Readonly<AgentAuthorizationState>;
  readonly command: string;
}

const AUTHORIZATION_ADMISSION_V1: Readonly<ToolGovernanceAdmissionFactsV1> = Object.freeze({
  freshness: 'current',
  reservationRequired: false,
  reservationIds: [],
});

export type RuntimeHostStateToolGovernanceFailureCodeV1 =
  | 'classified_identity_invalid'
  | 'governance_missing'
  | 'governance_projection_invalid'
  | 'authorization_identity_invalid'
  | 'kernel_facts_invalid';

export interface RuntimeHostStateToolGovernanceFailureV1 {
  readonly code: RuntimeHostStateToolGovernanceFailureCodeV1;
  /** Bounded, secret-free diagnostic. */
  readonly diagnostic: string;
}

export type RuntimeHostStateToolGovernanceResultV1<T> =
  | { readonly ok: true; readonly value: Readonly<T> }
  | {
      readonly ok: false;
      readonly failure: Readonly<RuntimeHostStateToolGovernanceFailureV1>;
    };

export interface RuntimeHostStateToolGovernancePortV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly project: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  ) => RuntimeHostStateToolGovernanceResultV1<ToolGovernanceFactsV1>;
  readonly authorize: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
  ) => RuntimeHostStateToolGovernanceResultV1<ToolGovernanceAuthorizationDecisionV1>;
  readonly admit: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
    authorization: Readonly<ToolGovernanceAuthorizationDecisionV1>,
    admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  ) => RuntimeHostStateToolGovernanceResultV1<ToolGovernanceDecisionV1>;
  readonly decide: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  ) => RuntimeHostStateToolGovernanceResultV1<ToolGovernanceDecisionV1>;
}

/**
 * Build the only Host-to-Kernel State 25 governance bridge for a classified
 * invocation. The injected verifier is the Builtin/SPI identity authority;
 * no raw arguments, domainData, parser, effects compiler, or executor is
 * consulted here.
 */
export function createRuntimeHostStateToolGovernanceV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
>(input: {
  readonly verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifierV1<TArguments>;
}): RuntimeHostStateToolGovernancePortV1<TArguments> {
  const verifyClassifiedIdentity = input.verifyClassifiedIdentity;
  const authorizationAuthority = new WeakMap<
    object,
    Readonly<{
      readonly input: object;
      readonly classified: object;
      readonly facts: Readonly<ToolGovernanceFactsV1>;
    }>
  >();

  const project = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  ): RuntimeHostStateToolGovernanceResultV1<ToolGovernanceFactsV1> => {
    return projectStateFactsV1(governanceInput, admission, verifyClassifiedIdentity);
  };

  const authorize = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
  ): RuntimeHostStateToolGovernanceResultV1<ToolGovernanceAuthorizationDecisionV1> => {
    const projected = project(governanceInput, AUTHORIZATION_ADMISSION_V1);
    if (!projected.ok) return projected;
    const authorization = authorizeToolGovernanceV1(projected.value);
    authorizationAuthority.set(authorization as object, {
      input: governanceInput as object,
      classified: governanceInput.classified as object,
      facts: projected.value,
    });
    return successV1(authorization);
  };

  const admit = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
    authorization: Readonly<ToolGovernanceAuthorizationDecisionV1>,
    admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  ): RuntimeHostStateToolGovernanceResultV1<ToolGovernanceDecisionV1> => {
    const authority = authorizationAuthority.get(authorization as object);
    if (
      !authority ||
      authority.input !== (governanceInput as object) ||
      authority.classified !== (governanceInput.classified as object)
    ) {
      return failureV1(
        'authorization_identity_invalid',
        'Authorization is not bound to this Host governance input.',
      );
    }
    const projected = project(governanceInput, admission);
    if (!projected.ok) return projected;
    if (!sameAuthorizationFactsV1(projected.value, authority.facts)) {
      return failureV1(
        'authorization_identity_invalid',
        'Authorization facts no longer match the projected invocation.',
      );
    }
    return successV1(admitToolGovernanceV1(authorization, projected.value.admission));
  };

  const decide = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  ): RuntimeHostStateToolGovernanceResultV1<ToolGovernanceDecisionV1> => {
    const authorization = authorize(governanceInput);
    if (!authorization.ok) return authorization;
    return admit(governanceInput, authorization.value, admission);
  };

  return Object.freeze({ project, authorize, admit, decide });
}

function projectStateFactsV1<TArguments extends RuntimeJsonValueV1>(
  input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1<TArguments>>,
  admission: Readonly<ToolGovernanceAdmissionFactsV1>,
  verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifierV1<TArguments>,
): RuntimeHostStateToolGovernanceResultV1<ToolGovernanceFactsV1> {
  let verification: boolean | ToolPipelineClassifiedIdentityVerificationResultV1;
  try {
    verification = verifyClassifiedIdentity(input.classified);
  } catch {
    return failureV1('classified_identity_invalid', 'Builtin identity verification failed.');
  }
  if (!classifiedIdentityAcceptedV1(verification)) {
    return failureV1('classified_identity_invalid', 'Builtin classified identity was rejected.');
  }

  const classified = input.classified;
  try {
    const governance = classified.governance;
    if (!governance)
      return failureV1('governance_missing', 'Builtin governance projection is missing.');
    if (!validGovernanceProjectionV1(classified, governance)) {
      return failureV1(
        'governance_projection_invalid',
        'Builtin governance projection identity is inconsistent.',
      );
    }

    const invocation = invocationFactV1(input, governance.invocation);
    const policy = policyFactV1(governance);
    const context = contextFactsV1(input.context, governance.invocation.executionMechanism);
    const sameCommandGrant = sameCommandGrantFactV1(input, invocation, policy);
    const facts: ToolGovernanceFactsV1 = {
      schema: TOOL_GOVERNANCE_FACTS_SCHEMA_V1,
      invocation,
      policy,
      context,
      admission: admissionFactV1(admission),
      approval: approvalFactV1(input.approval),
      ...(sameCommandGrant ? { sameCommandGrant } : {}),
      ...(governance.dynamicMcp ? { dynamicMcp: dynamicMcpFactV1(governance) } : {}),
      ...(governance.nestedSkill ? { nestedSkill: nestedSkillFactV1(governance) } : {}),
    };
    if (!isValidToolGovernanceFactsV1(facts)) {
      return failureV1('kernel_facts_invalid', 'Projected State 25 governance facts are invalid.');
    }
    return successV1(deepFreezeV1(facts));
  } catch {
    return failureV1('kernel_facts_invalid', 'Projected State 25 governance facts are invalid.');
  }
}

function validGovernanceProjectionV1<TArguments extends RuntimeJsonValueV1>(
  classified: Readonly<ClassifiedInvocationV1<TArguments>>,
  governance: Readonly<ToolPipelineGovernanceProjectionV1>,
): boolean {
  if (
    classified.schema !== 'kite.tool-pipeline-stage.v1' ||
    classified.stage !== 'classified' ||
    !Object.is(classified.policyCompilation, governance.policy) ||
    !Object.is(classified.effectiveEffects, governance.effectiveEffects) ||
    classified.effectiveEffectsDigest !== governance.effectiveEffectsDigest ||
    governance.policy.schema !== CAPABILITY_POLICY_COMPILATION_SCHEMA_V1 ||
    governance.policy.operationId !== governance.invocation.operationId ||
    governance.policy.capabilityRevision !== governance.invocation.capabilityRevision ||
    governance.policy.parserRevision !== governance.invocation.parserRevision
  ) {
    return false;
  }

  if (governance.invocation.isDynamicMcp) {
    return validDynamicGovernanceProjectionV1(governance);
  }
  return validOrdinaryGovernanceProjectionV1(governance);
}

function sameAuthorizationFactsV1(
  current: Readonly<ToolGovernanceFactsV1>,
  authorized: Readonly<ToolGovernanceFactsV1>,
): boolean {
  return (
    JSON.stringify({ ...current, admission: undefined }) ===
    JSON.stringify({ ...authorized, admission: undefined })
  );
}

function validOrdinaryGovernanceProjectionV1(
  governance: Readonly<ToolPipelineGovernanceProjectionV1>,
): governance is Readonly<
  ToolPipelineGovernanceProjectionV1 & {
    readonly invocation: Readonly<ToolPipelineGovernanceOrdinaryInvocationProjectionV1>;
  }
> {
  const invocation = governance.invocation;
  if (
    invocation.isDynamicMcp ||
    String(invocation.executionFamily) === 'mcp' ||
    invocation.operationId === 'mcp:dynamic_tool' ||
    invocation.operationId !== invocation.capabilityId ||
    invocation.visibility !== 'model' ||
    invocation.modelVisible !== true ||
    invocation.exposedToolName.length === 0 ||
    invocation.builtinProjectionRevision.length === 0 ||
    invocation.dynamicCatalogRevision !== null ||
    governance.dynamicMcp !== null
  ) {
    return false;
  }
  if (governance.nestedSkill === null) {
    return (
      invocation.nestedCapabilityId === null &&
      invocation.nestedCapabilityRevision === null &&
      invocation.nestedCatalogRevision === null
    );
  }
  return validNestedSkillProjectionV1(invocation, governance.nestedSkill);
}

function validDynamicGovernanceProjectionV1(
  governance: Readonly<ToolPipelineGovernanceProjectionV1>,
): governance is Readonly<
  ToolPipelineGovernanceProjectionV1 & {
    readonly invocation: Readonly<ToolPipelineGovernanceDynamicInvocationProjectionV1>;
  }
> {
  const invocation = governance.invocation;
  const dynamicMcp = governance.dynamicMcp;
  if (
    !invocation.isDynamicMcp ||
    invocation.executionFamily !== 'mcp' ||
    invocation.executionMechanism !== 'mcp' ||
    invocation.operationId !== 'mcp:dynamic_tool' ||
    invocation.visibility !== 'internal' ||
    invocation.modelVisible !== false ||
    invocation.builtinProjectionRevision !== null ||
    invocation.dynamicCatalogRevision.length === 0 ||
    invocation.exposedToolName !== invocation.subject.exposedToolName ||
    invocation.capabilityId !== invocation.subject.capabilityId ||
    invocation.capabilityRevision !== invocation.subject.capabilityRevision ||
    invocation.descriptorRevision !== invocation.subject.descriptorRevision ||
    invocation.providerId !== invocation.subject.providerId ||
    invocation.bindingId !== invocation.subject.bindingId ||
    invocation.dynamicCatalogRevision !== invocation.subject.dynamicCatalogRevision ||
    !dynamicMcp ||
    !Object.is(dynamicMcp.subject, invocation.subject) ||
    !Object.is(dynamicMcp.runtimeWrapper, invocation.runtimeWrapper) ||
    dynamicMcp.isDynamicMcp !== true ||
    governance.nestedSkill !== null
  ) {
    return false;
  }
  return (
    invocation.nestedCapabilityId === null &&
    invocation.nestedCapabilityRevision === null &&
    invocation.nestedCatalogRevision === null
  );
}

function validNestedSkillProjectionV1(
  invocation: Readonly<ToolPipelineGovernanceProjectionV1['invocation']>,
  nestedSkill: Readonly<ToolPipelineGovernanceNestedSkillProjectionV1>,
): boolean {
  return (
    invocation.operationId === 'builtin:activate_skill' &&
    nestedSkill.operationId === invocation.operationId &&
    nestedSkill.capabilityId === invocation.nestedCapabilityId &&
    nestedSkill.capabilityRevision === invocation.nestedCapabilityRevision &&
    nestedSkill.nestedCatalogRevision === invocation.nestedCatalogRevision
  );
}

function invocationFactV1(
  input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1>,
  invocation: Readonly<ToolPipelineGovernanceProjectionV1['invocation']>,
): ToolGovernanceInvocationFactV1 {
  return {
    workspace: input.workspace,
    threadId: input.threadId,
    turnId: invocation.turnId,
    modelMessageId: invocation.modelMessageId,
    toolCallId: invocation.toolCallId,
    exposedToolName: invocation.exposedToolName,
    operationId: invocation.operationId,
    capabilityId: invocation.capabilityId,
    capabilityRevision: invocation.capabilityRevision,
    executorRevision: invocation.executorRevision,
    descriptorRevision: invocation.descriptorRevision,
    parserRevision: invocation.parserRevision,
    schemaDigest: invocation.schemaDigest,
    argumentsDigest: invocation.argumentsDigest,
    effectiveEffectsDigest: invocation.effectiveEffectsDigest,
    bindingId: invocation.bindingId,
    builtinCatalogRevision: invocation.builtinProjectionRevision,
    dynamicCatalogRevision: invocation.dynamicCatalogRevision,
    nestedCapabilityId: invocation.nestedCapabilityId,
    nestedCapabilityRevision: invocation.nestedCapabilityRevision,
    nestedCatalogRevision: invocation.nestedCatalogRevision,
    commandDigest: invocation.commandDigest,
  };
}

function policyFactV1(
  governance: Readonly<ToolPipelineGovernanceProjectionV1>,
): ToolGovernancePolicyFactV1 {
  const policy = governance.policy;
  return {
    operationId: policy.operationId,
    capabilityRevision: policy.capabilityRevision,
    parserRevision: policy.parserRevision,
    effectiveEffectsDigest: governance.effectiveEffectsDigest,
    minimumApproval: policy.minimumApproval,
    fullAccessMayBypassApproval: policy.fullAccessMayBypassApproval,
    sameCommandMayBypassApproval: policy.sameCommandMayBypassApproval,
    decision: policy.decision,
    allowed: policy.allowed,
    requiresApproval: policy.requiresApproval,
    risk: policy.risk,
    ...(policy.effects ? { effects: { ...policy.effects } } : {}),
    reason: policy.reason,
    userVisibleSummary: policy.userVisibleSummary,
    expectedEffects: [...policy.expectedEffects],
    ...(policy.requiresSandbox === undefined ? {} : { requiresSandbox: policy.requiresSandbox }),
    ...(policy.phaseConstraint === undefined ? {} : { phaseConstraint: policy.phaseConstraint }),
  };
}

function contextFactsV1(
  context: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1['context']>,
  executionMechanism: ToolPipelineGovernanceProjectionV1['invocation']['executionMechanism'],
): ToolGovernanceContextFactsV1 {
  const projected: ToolGovernanceContextFactsV1 = {
    phase: context.phase,
    interactionMode: context.interactionMode,
    authorizationMode: context.authorizationMode,
    sandboxAvailable: context.sandboxAvailable,
    circuitBreakerTripped: context.circuitBreakerTripped,
    executionMechanism: executionMechanismV1(executionMechanism),
    gates: {
      recoveryAdmission: context.gates.recoveryAdmission,
      boundedCancellation: context.gates.boundedCancellation,
      executionBoundary: context.gates.executionBoundary,
      skillCapabilityCeiling: context.gates.skillCapabilityCeiling,
    },
    ...(context.authorizationSource === undefined
      ? {}
      : { authorizationSource: context.authorizationSource }),
    ...(context.autoReview === undefined ? {} : { autoReview: context.autoReview }),
    ...(context.loopMode === undefined ? {} : { loopMode: context.loopMode }),
    ...(context.observedAt === undefined ? {} : { observedAt: context.observedAt }),
  };
  return projected;
}

function executionMechanismV1(
  mechanism: ToolPipelineGovernanceProjectionV1['invocation']['executionMechanism'],
): ToolGovernanceContextFactsV1['executionMechanism'] {
  if (mechanism === 'user_input') return 'user_input';
  if (mechanism === 'shell') return 'shell';
  return 'other';
}

function admissionFactV1(
  admission: Readonly<ToolGovernanceAdmissionFactsV1>,
): ToolGovernanceAdmissionFactsV1 {
  return {
    freshness: admission.freshness,
    reservationRequired: admission.reservationRequired,
    reservationIds: [...admission.reservationIds],
  };
}

function approvalFactV1(
  approval: Readonly<ToolGovernanceApprovalFactV1>,
): ToolGovernanceApprovalFactV1 {
  return {
    status: approval.status,
    grant: approval.grant,
    approvedToolCallId: approval.approvedToolCallId,
    approvalBindingDigest: approval.approvalBindingDigest,
  };
}

function dynamicMcpFactV1(
  governance: Readonly<ToolPipelineGovernanceProjectionV1>,
): NonNullable<ToolGovernanceFactsV1['dynamicMcp']> {
  const dynamicMcp = governance.dynamicMcp;
  if (!dynamicMcp) throw new Error('Dynamic MCP governance projection is missing.');
  return {
    minimumApproval: dynamicMcp.minimumApproval,
    readOnly: dynamicMcp.readOnly,
  };
}

function nestedSkillFactV1(
  governance: Readonly<ToolPipelineGovernanceProjectionV1>,
): ToolGovernanceNestedSkillFactV1 {
  const nestedSkill = governance.nestedSkill;
  if (!nestedSkill) throw new Error('Nested Skill governance projection is missing.');
  return {
    decision: nestedSkill.decision,
    minimumApproval: nestedSkill.minimumApproval,
  };
}

function sameCommandGrantFactV1(
  input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInputV1>,
  invocation: Readonly<ToolGovernanceInvocationFactV1>,
  policy: Readonly<ToolGovernancePolicyFactV1>,
): ToolGovernanceSameCommandGrantFactV1 | undefined {
  const candidate = input.sameCommandGrant;
  if (!candidate || !policy.sameCommandMayBypassApproval || !invocation.commandDigest) {
    return undefined;
  }
  if (typeof candidate.command !== 'string') return undefined;
  const command = candidate.command.trim();
  if (!command) return undefined;
  if (createToolGovernanceCommandDigestV1(command) !== invocation.commandDigest) {
    return undefined;
  }
  const authorization = candidate.authorization;
  const commandGrants = authorization?.commandGrants;
  if (!commandGrants || typeof commandGrants !== 'object') return undefined;
  const key = authorizationCommandGrantKeyV1({
    workspace: input.workspace,
    threadId: input.threadId,
    command,
  });
  const keyed = commandGrants[key];
  const matches = Object.values(commandGrants).filter(
    (grant) =>
      grant.workspace === input.workspace &&
      grant.threadId === input.threadId &&
      grant.command === command,
  );
  if (!keyed || matches.length !== 1 || matches[0] !== keyed) return undefined;
  const grantedAt = Date.parse(keyed.grantedAt);
  const expiresAt = keyed.expiresAt === undefined ? undefined : Date.parse(keyed.expiresAt);
  if (
    !Number.isSafeInteger(grantedAt) ||
    grantedAt < 0 ||
    (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= grantedAt))
  ) {
    return undefined;
  }
  return {
    workspace: input.workspace,
    threadId: input.threadId,
    commandDigest: invocation.commandDigest,
    source: keyed.source,
    grantedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function classifiedIdentityAcceptedV1(
  result: boolean | ToolPipelineClassifiedIdentityVerificationResultV1,
): boolean {
  return (
    result === true || (typeof result === 'object' && result !== null && result.valid === true)
  );
}

function successV1<T>(value: T): RuntimeHostStateToolGovernanceResultV1<T> {
  return { ok: true, value };
}

function failureV1(
  code: RuntimeHostStateToolGovernanceFailureCodeV1,
  diagnostic: string,
): RuntimeHostStateToolGovernanceResultV1<never> {
  return { ok: false, failure: { code, diagnostic } };
}

function deepFreezeV1<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeV1(child);
  return Object.freeze(value);
}
