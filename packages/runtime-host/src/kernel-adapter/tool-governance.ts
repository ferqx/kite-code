import {
  type AgentAuthorizationState,
  admitToolGovernance,
  authorizationCommandGrantKey,
  authorizeToolGovernance,
  createToolGovernanceCommandDigest,
  TOOL_GOVERNANCE_FACTS_SCHEMA_,
  type ToolGovernanceAdmissionFacts,
  type ToolGovernanceApprovalFact,
  type ToolGovernanceAuthorizationDecision,
  type ToolGovernanceContextFacts,
  type ToolGovernanceDecision,
  type ToolGovernanceFacts,
  type ToolGovernanceInvocationFact,
  type ToolGovernanceNestedSkillFact,
  type ToolGovernancePolicyFact,
  type ToolGovernanceSameCommandGrantFact,
  toolGovernanceFactsInvalidReason,
} from '@kite/agent-kernel';
import {
  CAPABILITY_POLICY_COMPILATION_SCHEMA_,
  type ClassifiedInvocation,
  type RuntimeJsonValue,
  type ToolPipelineClassifiedIdentityVerificationResult,
  type ToolPipelineClassifiedIdentityVerifier,
  type ToolPipelineGovernanceDynamicInvocationProjection,
  type ToolPipelineGovernanceNestedSkillProjection,
  type ToolPipelineGovernanceOrdinaryInvocationProjection,
  type ToolPipelineGovernanceProjection,
} from '@kite/runtime-spi';

/** Host-facing aliases keep App composition from depending on Agent Kernel directly. */
export type RuntimeHostStateToolGovernanceFacts = ToolGovernanceFacts;
export type RuntimeHostStateToolGovernanceDecision = ToolGovernanceDecision;

/**
 * State 25 authorization facts supplied by Host around one Builtin-owned
 * classification. Workspace and thread identity are deliberately supplied
 * here: Builtin governance must not manufacture Host session identity.
 */
export interface RuntimeHostStateToolGovernanceAuthorizationInput<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly classified: Readonly<ClassifiedInvocation<TArguments>>;
  readonly workspace: string;
  readonly threadId: string;
  readonly context: Readonly<
    Omit<ToolGovernanceContextFacts, 'executionMechanism' | 'gates'> & {
      readonly gates: Readonly<ToolGovernanceContextFacts['gates']>;
    }
  >;
  readonly approval: Readonly<ToolGovernanceApprovalFact>;
  /**
   * A private State 25 authorization lookup. The command is used only to
   * select the exact persisted grant; its digest must already be present in
   * the authentic Builtin governance projection.
   */
  readonly sameCommandGrant?: Readonly<RuntimeHostStateSameCommandGrantInput>;
}

/** Full projection input; admission is deliberately supplied only at admit. */
export interface RuntimeHostStateToolGovernanceInput<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> extends RuntimeHostStateToolGovernanceAuthorizationInput<TArguments> {
  readonly admission: Readonly<ToolGovernanceAdmissionFacts>;
}

export interface RuntimeHostStateSameCommandGrantInput {
  readonly authorization: Readonly<AgentAuthorizationState>;
  readonly command: string;
}

const AUTHORIZATION_ADMISSION_: Readonly<ToolGovernanceAdmissionFacts> = Object.freeze({
  freshness: 'current',
  reservationRequired: false,
  reservationIds: [],
});

export type RuntimeHostStateToolGovernanceFailureCode =
  | 'classified_identity_invalid'
  | 'governance_missing'
  | 'governance_projection_invalid'
  | 'authorization_identity_invalid'
  | 'kernel_facts_invalid';

export interface RuntimeHostStateToolGovernanceFailure {
  readonly code: RuntimeHostStateToolGovernanceFailureCode;
  /** Bounded, secret-free diagnostic. */
  readonly diagnostic: string;
}

export type RuntimeHostStateToolGovernanceResult<T> =
  | { readonly ok: true; readonly value: Readonly<T> }
  | {
      readonly ok: false;
      readonly failure: Readonly<RuntimeHostStateToolGovernanceFailure>;
    };

export interface RuntimeHostStateToolGovernancePort<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly project: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFacts>,
  ) => RuntimeHostStateToolGovernanceResult<ToolGovernanceFacts>;
  readonly authorize: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
  ) => RuntimeHostStateToolGovernanceResult<ToolGovernanceAuthorizationDecision>;
  readonly admit: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
    authorization: Readonly<ToolGovernanceAuthorizationDecision>,
    admission: Readonly<ToolGovernanceAdmissionFacts>,
  ) => RuntimeHostStateToolGovernanceResult<ToolGovernanceDecision>;
  readonly decide: (
    input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFacts>,
  ) => RuntimeHostStateToolGovernanceResult<ToolGovernanceDecision>;
}

/**
 * Build the only Host-to-Kernel State 25 governance bridge for a classified
 * invocation. The injected verifier is the Builtin/SPI identity authority;
 * no raw arguments, domainData, parser, effects compiler, or executor is
 * consulted here.
 */
export function createRuntimeHostStateToolGovernance<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
>(input: {
  readonly verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifier<TArguments>;
}): RuntimeHostStateToolGovernancePort<TArguments> {
  const verifyClassifiedIdentity = input.verifyClassifiedIdentity;
  const authorizationAuthority = new WeakMap<
    object,
    Readonly<{
      readonly input: object;
      readonly classified: object;
      readonly facts: Readonly<ToolGovernanceFacts>;
    }>
  >();

  const project = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFacts>,
  ): RuntimeHostStateToolGovernanceResult<ToolGovernanceFacts> => {
    return projectStateFacts(governanceInput, admission, verifyClassifiedIdentity);
  };

  const authorize = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
  ): RuntimeHostStateToolGovernanceResult<ToolGovernanceAuthorizationDecision> => {
    const projected = project(governanceInput, AUTHORIZATION_ADMISSION_);
    if (!projected.ok) return projected;
    const authorization = authorizeToolGovernance(projected.value);
    authorizationAuthority.set(authorization as object, {
      input: governanceInput as object,
      classified: governanceInput.classified as object,
      facts: projected.value,
    });
    return success(authorization);
  };

  const admit = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
    authorization: Readonly<ToolGovernanceAuthorizationDecision>,
    admission: Readonly<ToolGovernanceAdmissionFacts>,
  ): RuntimeHostStateToolGovernanceResult<ToolGovernanceDecision> => {
    const authority = authorizationAuthority.get(authorization as object);
    if (
      !authority ||
      authority.input !== (governanceInput as object) ||
      authority.classified !== (governanceInput.classified as object)
    ) {
      return failure(
        'authorization_identity_invalid',
        'Authorization is not bound to this Host governance input.',
      );
    }
    const projected = project(governanceInput, admission);
    if (!projected.ok) return projected;
    if (!sameAuthorizationFacts(projected.value, authority.facts)) {
      return failure(
        'authorization_identity_invalid',
        'Authorization facts no longer match the projected invocation.',
      );
    }
    return success(admitToolGovernance(authorization, projected.value.admission));
  };

  const decide = (
    governanceInput: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
    admission: Readonly<ToolGovernanceAdmissionFacts>,
  ): RuntimeHostStateToolGovernanceResult<ToolGovernanceDecision> => {
    const authorization = authorize(governanceInput);
    if (!authorization.ok) return authorization;
    return admit(governanceInput, authorization.value, admission);
  };

  return Object.freeze({ project, authorize, admit, decide });
}

function projectStateFacts<TArguments extends RuntimeJsonValue>(
  input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput<TArguments>>,
  admission: Readonly<ToolGovernanceAdmissionFacts>,
  verifyClassifiedIdentity: ToolPipelineClassifiedIdentityVerifier<TArguments>,
): RuntimeHostStateToolGovernanceResult<ToolGovernanceFacts> {
  let verification: boolean | ToolPipelineClassifiedIdentityVerificationResult;
  try {
    verification = verifyClassifiedIdentity(input.classified);
  } catch {
    return failure('classified_identity_invalid', 'Builtin identity verification failed.');
  }
  if (!classifiedIdentityAccepted(verification)) {
    return failure('classified_identity_invalid', 'Builtin classified identity was rejected.');
  }

  const classified = input.classified;
  try {
    const governance = classified.governance;
    if (!governance)
      return failure('governance_missing', 'Builtin governance projection is missing.');
    if (!validGovernanceProjection(classified, governance)) {
      return failure(
        'governance_projection_invalid',
        'Builtin governance projection identity is inconsistent.',
      );
    }

    const invocation = invocationFact(input, governance.invocation);
    const policy = policyFact(governance);
    const context = contextFacts(input.context, governance.invocation.executionMechanism);
    const sameCommandGrant = sameCommandGrantFact(input, invocation, policy);
    const facts: ToolGovernanceFacts = {
      schema: TOOL_GOVERNANCE_FACTS_SCHEMA_,
      invocation,
      policy,
      context,
      admission: admissionFact(admission),
      approval: approvalFact(input.approval),
      ...(sameCommandGrant ? { sameCommandGrant } : {}),
      ...(governance.dynamicMcp ? { dynamicMcp: dynamicMcpFact(governance) } : {}),
      ...(governance.nestedSkill ? { nestedSkill: nestedSkillFact(governance) } : {}),
    };
    const invalidReason = toolGovernanceFactsInvalidReason(facts);
    if (invalidReason !== undefined) {
      return failure(
        'kernel_facts_invalid',
        `Projected State 25 governance facts are invalid: ${invalidReason}.`,
      );
    }
    return success(deepFreeze(facts));
  } catch {
    return failure('kernel_facts_invalid', 'Projected State 25 governance facts are invalid.');
  }
}

function validGovernanceProjection<TArguments extends RuntimeJsonValue>(
  classified: Readonly<ClassifiedInvocation<TArguments>>,
  governance: Readonly<ToolPipelineGovernanceProjection>,
): boolean {
  if (
    classified.schema !== 'kite.tool-pipeline-stage.v1' ||
    classified.stage !== 'classified' ||
    !Object.is(classified.policyCompilation, governance.policy) ||
    !Object.is(classified.effectiveEffects, governance.effectiveEffects) ||
    classified.effectiveEffectsDigest !== governance.effectiveEffectsDigest ||
    governance.policy.schema !== CAPABILITY_POLICY_COMPILATION_SCHEMA_ ||
    governance.policy.operationId !== governance.invocation.operationId ||
    governance.policy.capabilityRevision !== governance.invocation.capabilityRevision ||
    governance.policy.parserRevision !== governance.invocation.parserRevision
  ) {
    return false;
  }

  if (governance.invocation.isDynamicMcp) {
    return validDynamicGovernanceProjection(governance);
  }
  return validOrdinaryGovernanceProjection(governance);
}

function sameAuthorizationFacts(
  current: Readonly<ToolGovernanceFacts>,
  authorized: Readonly<ToolGovernanceFacts>,
): boolean {
  return (
    JSON.stringify({ ...current, admission: undefined }) ===
    JSON.stringify({ ...authorized, admission: undefined })
  );
}

function validOrdinaryGovernanceProjection(
  governance: Readonly<ToolPipelineGovernanceProjection>,
): governance is Readonly<
  ToolPipelineGovernanceProjection & {
    readonly invocation: Readonly<ToolPipelineGovernanceOrdinaryInvocationProjection>;
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
  return validNestedSkillProjection(invocation, governance.nestedSkill);
}

function validDynamicGovernanceProjection(
  governance: Readonly<ToolPipelineGovernanceProjection>,
): governance is Readonly<
  ToolPipelineGovernanceProjection & {
    readonly invocation: Readonly<ToolPipelineGovernanceDynamicInvocationProjection>;
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

function validNestedSkillProjection(
  invocation: Readonly<ToolPipelineGovernanceProjection['invocation']>,
  nestedSkill: Readonly<ToolPipelineGovernanceNestedSkillProjection>,
): boolean {
  return (
    invocation.operationId === 'builtin:activate_skill' &&
    nestedSkill.operationId === invocation.operationId &&
    nestedSkill.capabilityId === invocation.nestedCapabilityId &&
    nestedSkill.capabilityRevision === invocation.nestedCapabilityRevision &&
    nestedSkill.nestedCatalogRevision === invocation.nestedCatalogRevision
  );
}

function invocationFact(
  input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput>,
  invocation: Readonly<ToolPipelineGovernanceProjection['invocation']>,
): ToolGovernanceInvocationFact {
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

function policyFact(
  governance: Readonly<ToolPipelineGovernanceProjection>,
): ToolGovernancePolicyFact {
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
    expectedEffects: [...policy.expectedEffects],
    ...(policy.requiresSandbox === undefined ? {} : { requiresSandbox: policy.requiresSandbox }),
    ...(policy.phaseConstraint === undefined ? {} : { phaseConstraint: policy.phaseConstraint }),
  };
}

function contextFacts(
  context: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput['context']>,
  executionMechanism: ToolPipelineGovernanceProjection['invocation']['executionMechanism'],
): ToolGovernanceContextFacts {
  const projected: ToolGovernanceContextFacts = {
    phase: context.phase,
    interactionMode: context.interactionMode,
    authorizationMode: context.authorizationMode,
    sandboxAvailable: context.sandboxAvailable,
    circuitBreakerTripped: context.circuitBreakerTripped,
    executionMechanism: projectExecutionMechanism(executionMechanism),
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

function projectExecutionMechanism(
  mechanism: ToolPipelineGovernanceProjection['invocation']['executionMechanism'],
): ToolGovernanceContextFacts['executionMechanism'] {
  if (mechanism === 'user_input') return 'user_input';
  if (mechanism === 'shell') return 'shell';
  return 'other';
}

function admissionFact(
  admission: Readonly<ToolGovernanceAdmissionFacts>,
): ToolGovernanceAdmissionFacts {
  return {
    freshness: admission.freshness,
    reservationRequired: admission.reservationRequired,
    reservationIds: [...admission.reservationIds],
  };
}

function approvalFact(approval: Readonly<ToolGovernanceApprovalFact>): ToolGovernanceApprovalFact {
  return {
    status: approval.status,
    grant: approval.grant,
    approvedToolCallId: approval.approvedToolCallId,
    approvalBindingDigest: approval.approvalBindingDigest,
  };
}

function dynamicMcpFact(
  governance: Readonly<ToolPipelineGovernanceProjection>,
): NonNullable<ToolGovernanceFacts['dynamicMcp']> {
  const dynamicMcp = governance.dynamicMcp;
  if (!dynamicMcp) throw new Error('Dynamic MCP governance projection is missing.');
  return {
    minimumApproval: dynamicMcp.minimumApproval,
    readOnly: dynamicMcp.readOnly,
  };
}

function nestedSkillFact(
  governance: Readonly<ToolPipelineGovernanceProjection>,
): ToolGovernanceNestedSkillFact {
  const nestedSkill = governance.nestedSkill;
  if (!nestedSkill) throw new Error('Nested Skill governance projection is missing.');
  return {
    decision: nestedSkill.decision,
    minimumApproval: nestedSkill.minimumApproval,
  };
}

function sameCommandGrantFact(
  input: Readonly<RuntimeHostStateToolGovernanceAuthorizationInput>,
  invocation: Readonly<ToolGovernanceInvocationFact>,
  policy: Readonly<ToolGovernancePolicyFact>,
): ToolGovernanceSameCommandGrantFact | undefined {
  const candidate = input.sameCommandGrant;
  if (!candidate || !policy.sameCommandMayBypassApproval || !invocation.commandDigest) {
    return undefined;
  }
  if (typeof candidate.command !== 'string') return undefined;
  const command = candidate.command.trim();
  if (!command) return undefined;
  if (createToolGovernanceCommandDigest(command) !== invocation.commandDigest) {
    return undefined;
  }
  const authorization = candidate.authorization;
  const commandGrants = authorization?.commandGrants;
  if (!commandGrants || typeof commandGrants !== 'object') return undefined;
  const key = authorizationCommandGrantKey({
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

function classifiedIdentityAccepted(
  result: boolean | ToolPipelineClassifiedIdentityVerificationResult,
): boolean {
  return (
    result === true || (typeof result === 'object' && result !== null && result.valid === true)
  );
}

function success<T>(value: T): RuntimeHostStateToolGovernanceResult<T> {
  return { ok: true, value };
}

function failure(
  code: RuntimeHostStateToolGovernanceFailureCode,
  diagnostic: string,
): RuntimeHostStateToolGovernanceResult<never> {
  return { ok: false, failure: { code, diagnostic } };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
