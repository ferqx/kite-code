import { digestCapabilityValueV1 } from '@kite/builtin-runtime';
import type {
  RuntimeHostStateToolGovernanceDecisionV1,
  RuntimeHostStateToolGovernanceFactsV1,
} from '@kite/runtime-host';
import { runtimeHostStateCreateApprovalBindingDigestV1 } from '@kite/runtime-host';
import type {
  CapabilityEffectsV1,
  CapabilityPolicyEffectsV1,
  ClassifiedInvocationV1,
  DynamicMcpPreparedToolInvocationIdentityV1,
  DynamicMcpToolTargetV1,
  NonDynamicPreparedToolInvocationIdentityV1,
  NonDynamicToolTargetV1,
  PreparedToolInvocationIdentityV1,
  PreparedToolInvocationInputV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineCapabilityBindingV1,
  ToolPipelineGovernanceInvocationProjectionV1,
  ToolPipelineReceiptRequirementV1,
  ToolPipelineRetryEligibilityV1,
} from '@kite/runtime-spi';

export const APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1 =
  'kite.tool-pipeline-prepared-request.v1' as const;

export type AppToolPipelinePreparedAuthorizationKindV1 = 'policy_allow' | 'approved_call';
export type AppToolPipelinePreparedGrantUsedV1 =
  | 'none'
  | 'approve_once'
  | 'same_command'
  | 'full_access';

/**
 * The request facts persisted alongside a prepared attempt.  It is a neutral
 * JSON envelope: task/plan identifiers are optional facts, while effects and
 * receipt/retry requirements are copied from the already-classified Builtin
 * projection and never inferred here.
 */
export interface AppToolPipelinePreparedRequestV1 {
  readonly schema: typeof APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1;
  /** Exact authorization kind returned by the Kernel allow decision. */
  readonly authorizationKind: AppToolPipelinePreparedAuthorizationKindV1;
  /** The narrowed State 25 grant carried by the Kernel allow decision. */
  readonly grantUsed: AppToolPipelinePreparedGrantUsedV1;
  /** Builtin policy effects; `{}` is required when the compilation omits effects. */
  readonly policyEffects: Readonly<CapabilityPolicyEffectsV1>;
  readonly effectiveEffects: Readonly<CapabilityEffectsV1>;
  readonly receiptRequirement: ToolPipelineReceiptRequirementV1;
  readonly retryEligibility: ToolPipelineRetryEligibilityV1;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly planStepId: string | null;
  readonly capabilityRequestFacts: RuntimeJsonValueV1 | null;
}

export type AppToolPipelineGovernanceFactsV1 = RuntimeHostStateToolGovernanceFactsV1;
export type AppToolPipelineGovernanceDecisionV1 = RuntimeHostStateToolGovernanceDecisionV1;

type AppPreparedToolInvocationInputV1<TArguments extends RuntimeJsonValueV1> = Omit<
  PreparedToolInvocationInputV1<TArguments, RuntimeJsonValueV1>,
  'request'
> & {
  readonly request: Readonly<AppToolPipelinePreparedRequestV1>;
};

export type AppPreparedToolInvocationPacketV1<TArguments extends RuntimeJsonValueV1> = Omit<
  PreparedToolInvocationV1<TArguments, RuntimeJsonValueV1>,
  'input'
> & {
  readonly input: Readonly<AppPreparedToolInvocationInputV1<TArguments>>;
};

/**
 * The App composition root supplies all values in this input.  This builder
 * does not discover a registry, parse arguments, compile policy, or select an
 * executor; it only binds already-authentic facts into the neutral Host
 * prepared-invocation packet.
 */
export interface AppPreparedToolInvocationBuilderInputV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly classified: Readonly<ClassifiedInvocationV1<TArguments>>;
  readonly governance: Readonly<AppToolPipelineGovernanceFactsV1>;
  readonly decision: Readonly<AppToolPipelineGovernanceDecisionV1>;
  readonly threadId: string;
  readonly attempt: number;
  /** Canonical arguments after any caller-owned, explicit preparation. */
  readonly preparedArguments: TArguments;
  /** Exact canonical request DTO; this builder does not invent one. */
  readonly request: Readonly<AppToolPipelinePreparedRequestV1>;
  /** The exact target binding, or null for an unbound ordinary Builtin. */
  readonly binding: ToolPipelineCapabilityBindingV1 | null;
}

/**
 * Attempt metadata remains alongside the prepared packet until the injected
 * persistence owner records it.  The packet itself is assignable to the SPI
 * PreparedToolInvocationV1 type.
 */
export interface AppPreparedToolInvocationBuildV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly prepared: Readonly<AppPreparedToolInvocationPacketV1<TArguments>>;
  readonly attempt: number;
}

/**
 * Bind State 25 governance facts and one Kernel allow decision to an immutable
 * SPI prepared invocation.  All identity fields are copied from the existing
 * Builtin/SPI projection; no App policy or execution authority is introduced.
 */
export function createAppPreparedToolInvocationV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
>(
  input: Readonly<AppPreparedToolInvocationBuilderInputV1<TArguments>>,
): Readonly<AppPreparedToolInvocationBuildV1<TArguments>> {
  assertBuilderEnvelopeV1(input);

  const classified = input.classified;
  const validated = classified.validated;
  const resolved = validated.resolved;
  const target = resolved.target;
  const governance = input.governance;
  const classifiedGovernance = classified.governance;
  const decision = allowDecisionV1(input.decision);
  const domainData = validated.domainData;
  if (domainData === undefined) failV1('Prepared builder requires classified domain facts.');

  assertClassifiedAndGovernanceMatchV1(input, classifiedGovernance);
  assertDecisionAndAdmissionMatchV1(input);
  assertApprovedCallFactsV1(input);
  assertPreparedArgumentsV1(validated.request.arguments, input.preparedArguments, classified);
  assertBindingMatchesTargetV1(input.binding, target.binding);

  const policyDigest = runtimeHostStateCreateApprovalBindingDigestV1(
    governance.invocation,
    governance.policy,
  );
  const authorizationDigest = digestCapabilityValueV1({
    policyDigest,
    authorizationKind: decision.authorizationKind,
    grantUsed: decision.grantUsed,
    authorizationMode: governance.context.authorizationMode,
  });
  const admissionDigest = digestCapabilityValueV1({
    authorizationDigest,
    reservationIds: governance.admission.reservationIds,
    freshness: governance.admission.freshness,
  });

  const originalArgumentsDigest = validated.request.argumentsDigest;
  const subjectCapabilityId = target.capabilityId;
  const subjectCapabilityRevision = target.capabilityRevision;
  const invocationId = digestCapabilityValueV1({
    schema: 'kite.tool-invocation-identity.v1',
    threadId: input.threadId,
    toolCallId: resolved.call.toolCallId,
    capabilityId: subjectCapabilityId,
    capabilityRevision: subjectCapabilityRevision,
    argumentsDigest: originalArgumentsDigest,
    authorizationDigest,
    admissionDigest,
  });
  const attemptId = `${invocationId}:attempt:${input.attempt}`;

  const idempotencyKeyArgument = classified.requirements.idempotencyKeyArgument;
  const idempotencyKey = idempotencyKeyFromPreparedArgumentsV1(
    input.preparedArguments,
    idempotencyKeyArgument,
    target.isDynamicMcp,
  );
  const preparedArgumentsDigest = digestCapabilityValueV1(input.preparedArguments);
  const identity = createPreparedIdentityV1(
    target,
    classifiedGovernance.invocation,
    resolved.call.argumentOrigin,
    resolved.call.toolCallId,
    resolved.call.createdAtTurnId,
    resolved.call.modelMessageId,
    invocationId,
    attemptId,
    preparedArgumentsDigest,
    validated.request.schemaDigest,
    classified.effectiveEffectsDigest,
    idempotencyKeyArgument,
    idempotencyKey,
    policyDigest,
    authorizationDigest,
    admissionDigest,
  );

  const preparedInput: AppPreparedToolInvocationInputV1<TArguments> = {
    invocationId,
    attemptId,
    toolCallId: resolved.call.toolCallId,
    arguments: cloneAndDeepFreezeJsonV1(input.preparedArguments),
    request: cloneAndDeepFreezePreparedRequestV1(input.request),
    binding: cloneAndDeepFreezeBindingV1(input.binding),
    facts: cloneAndDeepFreezeJsonV1(domainData),
  };
  const prepared = deepFreezeV1({
    identity,
    input: preparedInput,
  });
  return deepFreezeV1({
    prepared,
    attempt: input.attempt,
  });
}

function assertBuilderEnvelopeV1<TArguments extends RuntimeJsonValueV1>(
  input: Readonly<AppPreparedToolInvocationBuilderInputV1<TArguments>>,
): void {
  if (!input || typeof input !== 'object') failV1('Prepared builder input is unavailable.');
  if (input.classified?.stage !== 'classified') {
    failV1('Prepared builder requires a classified invocation.');
  }
  if (input.governance?.schema !== 'kite.tool-governance-facts.v1') {
    failV1('Prepared builder requires State 25 governance facts.');
  }
  if (input.decision.kind !== 'allow') {
    failV1('Prepared builder requires a Kernel allow decision.');
  }
  if (!nonEmptyStringV1(input.threadId)) failV1('Prepared builder thread identity is invalid.');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    failV1('Prepared builder attempt is invalid.');
  }
  assertRuntimeJsonV1(input.preparedArguments, 'prepared arguments');
  if (input.request === undefined) failV1('Prepared builder requires request facts.');
  assertRuntimeJsonV1(input.request, 'prepared request');
  assertPreparedRequestV1(input.request, input.classified, input.decision);
  if (input.binding !== null) assertBindingV1(input.binding);
  if (input.classified.validated.domainData === undefined) {
    failV1('Prepared builder requires classified domain facts.');
  }
  assertRuntimeJsonV1(input.classified.validated.domainData, 'classified domain facts');
}

function assertClassifiedAndGovernanceMatchV1<TArguments extends RuntimeJsonValueV1>(
  input: Readonly<AppPreparedToolInvocationBuilderInputV1<TArguments>>,
  classifiedGovernance: Readonly<ClassifiedInvocationV1<TArguments>['governance']>,
): void {
  const classified = input.classified;
  const validated = classified.validated;
  const resolved = validated.resolved;
  const target = resolved.target;
  const projection = classifiedGovernance.invocation;
  const facts = input.governance;
  const factInvocation = facts.invocation;

  if (
    classified.policyCompilation !== classifiedGovernance.policy &&
    digestCapabilityValueV1(classified.policyCompilation) !==
      digestCapabilityValueV1(classifiedGovernance.policy)
  ) {
    failV1('Prepared builder policy projection is inconsistent.');
  }
  if (
    classifiedGovernance.effectiveEffects !== classified.effectiveEffects ||
    classifiedGovernance.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    digestCapabilityValueV1(classifiedGovernance.effectiveEffects) !==
      classified.effectiveEffectsDigest
  ) {
    failV1('Prepared builder effects projection is inconsistent.');
  }
  if (validated.request.argumentsDigest !== digestCapabilityValueV1(validated.request.arguments)) {
    failV1('Prepared builder validated argument digest is inconsistent.');
  }
  if (
    facts.invocation.threadId !== input.threadId ||
    factInvocation.turnId !== resolved.call.createdAtTurnId ||
    factInvocation.modelMessageId !== resolved.call.modelMessageId ||
    factInvocation.toolCallId !== resolved.call.toolCallId ||
    factInvocation.operationId !== target.operationId ||
    factInvocation.capabilityId !== target.capabilityId ||
    factInvocation.capabilityRevision !== target.capabilityRevision ||
    factInvocation.executorRevision !== target.executorRevision ||
    factInvocation.descriptorRevision !== target.descriptorRevision ||
    factInvocation.parserRevision !== projection.parserRevision ||
    factInvocation.schemaDigest !== validated.request.schemaDigest ||
    factInvocation.argumentsDigest !== validated.request.argumentsDigest ||
    factInvocation.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    factInvocation.bindingId !== (target.binding?.bindingId ?? null) ||
    factInvocation.nestedCapabilityId !== projection.nestedCapabilityId ||
    factInvocation.nestedCapabilityRevision !== projection.nestedCapabilityRevision ||
    factInvocation.nestedCatalogRevision !== projection.nestedCatalogRevision ||
    factInvocation.builtinCatalogRevision !== target.builtinProjectionRevision ||
    factInvocation.dynamicCatalogRevision !== target.dynamicCatalogRevision ||
    factInvocation.exposedToolName !== projection.exposedToolName
  ) {
    failV1('Prepared builder governance invocation does not match classified facts.');
  }
  if (
    projection.argumentOrigin !== resolved.call.argumentOrigin ||
    projection.executionFamily !== target.executionFamily ||
    projection.executionMechanism !== target.executionMechanism ||
    projection.providerId !== target.providerId
  ) {
    failV1('Prepared builder classified invocation projection is stale.');
  }
  if (facts.policy.operationId !== classified.policyCompilation.operationId) {
    failV1('Prepared builder governance policy does not match classified facts.');
  }
  if (
    !policyFactsMatchV1(
      facts.policy,
      classifiedGovernance.policy,
      classified.effectiveEffectsDigest,
    )
  ) {
    failV1('Prepared builder State 25 policy facts are stale.');
  }
  if (
    facts.context.executionMechanism !==
    executionMechanismForGovernanceV1(target.executionMechanism)
  ) {
    failV1('Prepared builder governance mechanism is stale.');
  }
  if (target.isDynamicMcp) {
    assertDynamicProjectionMatchV1(target, projection, classifiedGovernance.dynamicMcp, facts);
  } else {
    assertOrdinaryProjectionMatchV1(target, projection, facts);
  }
}

function assertPreparedRequestV1<TArguments extends RuntimeJsonValueV1>(
  request: Readonly<AppToolPipelinePreparedRequestV1>,
  classified: Readonly<ClassifiedInvocationV1<TArguments>>,
  decision: Readonly<AppToolPipelineGovernanceDecisionV1>,
): void {
  if (decision.kind !== 'allow') failV1('Prepared request requires a Kernel allow decision.');
  const expectedKeys = new Set([
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
  ]);
  if (
    Reflect.ownKeys(request).some((key) => typeof key !== 'string' || !expectedKeys.has(key)) ||
    expectedKeys.size !== Reflect.ownKeys(request).length
  ) {
    failV1('Prepared request contains unexpected or missing fields.');
  }
  if (
    request.schema !== APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1 ||
    digestCapabilityValueV1(request.effectiveEffects) !==
      digestCapabilityValueV1(classified.effectiveEffects) ||
    request.receiptRequirement !== classified.requirements.receipt ||
    request.retryEligibility !== classified.requirements.retry
  ) {
    failV1('Prepared request facts do not match classified facts.');
  }
  if (
    !isPreparedAuthorizationKindV1(decision.authorizationKind) ||
    request.authorizationKind !== decision.authorizationKind ||
    !isPreparedGrantUsedV1(decision.grantUsed) ||
    request.grantUsed !== decision.grantUsed
  ) {
    failV1('Prepared request authorization facts do not match the Kernel allow decision.');
  }
  assertPolicyEffectsV1(request.policyEffects, 'prepared policy effects');
  const expectedPolicyEffects = classified.policyCompilation.effects ?? {};
  assertPolicyEffectsV1(expectedPolicyEffects, 'classified policy effects');
  if (
    digestCapabilityValueV1(request.policyEffects) !==
    digestCapabilityValueV1(expectedPolicyEffects)
  ) {
    failV1('Prepared request policy effects do not match classified policy facts.');
  }
  for (const value of [request.taskId, request.planId, request.planStepId]) {
    if (value !== null && !nonEmptyStringV1(value)) {
      failV1('Prepared request identifier is invalid.');
    }
  }
  if (request.capabilityRequestFacts !== null) {
    assertRuntimeJsonV1(request.capabilityRequestFacts, 'prepared capability request facts');
  }
}

function isPreparedAuthorizationKindV1(
  value: unknown,
): value is AppToolPipelinePreparedAuthorizationKindV1 {
  return value === 'policy_allow' || value === 'approved_call';
}

function isPreparedGrantUsedV1(value: unknown): value is AppToolPipelinePreparedGrantUsedV1 {
  return (
    value === 'none' ||
    value === 'approve_once' ||
    value === 'same_command' ||
    value === 'full_access'
  );
}

function assertPolicyEffectsV1(
  value: unknown,
  label: string,
): asserts value is Readonly<CapabilityPolicyEffectsV1> {
  assertRuntimeJsonV1(value, label);
  if (!isJsonRecordV1(value)) failV1(`${label} must be a JSON object.`);
  const allowedKeys = new Set(['network', 'externalRead', 'externalWrite', 'uncertainEffects']);
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key) || item !== true) failV1(`${label} is invalid.`);
  }
}

function policyFactsMatchV1(
  facts: Readonly<AppToolPipelineGovernanceFactsV1['policy']>,
  policy: Readonly<ClassifiedInvocationV1['policyCompilation']>,
  effectiveEffectsDigest: string,
): boolean {
  return (
    digestCapabilityValueV1(facts) ===
    digestCapabilityValueV1({
      operationId: policy.operationId,
      capabilityRevision: policy.capabilityRevision,
      parserRevision: policy.parserRevision,
      effectiveEffectsDigest,
      minimumApproval: policy.minimumApproval,
      fullAccessMayBypassApproval: policy.fullAccessMayBypassApproval,
      sameCommandMayBypassApproval: policy.sameCommandMayBypassApproval,
      decision: policy.decision,
      allowed: policy.allowed,
      requiresApproval: policy.requiresApproval,
      risk: policy.risk,
      ...(policy.effects ? { effects: policy.effects } : {}),
      reason: policy.reason,
      userVisibleSummary: policy.userVisibleSummary,
      expectedEffects: policy.expectedEffects,
      ...(policy.requiresSandbox === undefined ? {} : { requiresSandbox: policy.requiresSandbox }),
      ...(policy.phaseConstraint === undefined ? {} : { phaseConstraint: policy.phaseConstraint }),
    })
  );
}

function assertDynamicProjectionMatchV1(
  target: Readonly<DynamicMcpToolTargetV1>,
  projection: Readonly<ToolPipelineGovernanceInvocationProjectionV1>,
  classifiedDynamicMcp: Readonly<ClassifiedInvocationV1['governance']['dynamicMcp']>,
  facts: Readonly<AppToolPipelineGovernanceFactsV1>,
): void {
  if (
    !projection.isDynamicMcp ||
    projection.operationId !== 'mcp:dynamic_tool' ||
    projection.executionFamily !== 'mcp' ||
    projection.executionMechanism !== 'mcp' ||
    projection.argumentOrigin !== 'model_public' ||
    projection.visibility !== 'internal' ||
    projection.modelVisible !== false ||
    projection.exposedToolName !== target.subject.exposedToolName ||
    projection.builtinProjectionRevision !== null ||
    projection.dynamicCatalogRevision !== target.dynamicCatalogRevision ||
    digestCapabilityValueV1(projection.subject) !== digestCapabilityValueV1(target.subject) ||
    digestCapabilityValueV1(projection.runtimeWrapper) !==
      digestCapabilityValueV1(target.runtimeWrapper) ||
    !facts.dynamicMcp ||
    !classifiedDynamicMcp ||
    digestCapabilityValueV1(facts.dynamicMcp) !==
      digestCapabilityValueV1({
        minimumApproval: classifiedDynamicMcp.minimumApproval,
        readOnly: classifiedDynamicMcp.readOnly,
      })
  ) {
    failV1('Prepared builder dynamic MCP identity is inconsistent.');
  }
}

function assertOrdinaryProjectionMatchV1(
  target: Readonly<NonDynamicToolTargetV1>,
  projection: Readonly<ToolPipelineGovernanceInvocationProjectionV1>,
  facts: Readonly<AppToolPipelineGovernanceFactsV1>,
): void {
  if (
    projection.isDynamicMcp ||
    projection.visibility !== 'model' ||
    projection.modelVisible !== true ||
    target.executionMechanism === 'user_input' ||
    projection.operationId !== target.operationId ||
    projection.exposedToolName !== target.exposedToolName ||
    projection.builtinProjectionRevision !== target.builtinProjectionRevision ||
    projection.dynamicCatalogRevision !== target.dynamicCatalogRevision ||
    facts.dynamicMcp !== undefined
  ) {
    failV1('Prepared builder ordinary identity is inconsistent.');
  }
}

function assertDecisionAndAdmissionMatchV1<TArguments extends RuntimeJsonValueV1>(
  input: Readonly<AppPreparedToolInvocationBuilderInputV1<TArguments>>,
): void {
  const decision = input.decision;
  const facts = input.governance;
  if (decision.kind !== 'allow' || facts.policy.allowed !== true) {
    failV1('Prepared builder admission is not allowed.');
  }
  if (facts.admission.freshness !== 'current') {
    failV1('Prepared builder admission is stale.');
  }
  if (
    digestCapabilityValueV1(decision.reservationIds) !==
      digestCapabilityValueV1(facts.admission.reservationIds) ||
    decision.reservationIds.some((value) => typeof value !== 'string')
  ) {
    failV1('Prepared builder reservation identity is inconsistent.');
  }
}

/**
 * A Kernel approved-call decision is only consumable when the projected
 * approval is bound to this exact invocation and policy.  In particular,
 * `approve_once` is a transient per-call grant: it must never be accepted
 * from a policy-allow decision, an unapproved envelope, or a copied digest.
 */
function assertApprovedCallFactsV1<TArguments extends RuntimeJsonValueV1>(
  input: Readonly<AppPreparedToolInvocationBuilderInputV1<TArguments>>,
): void {
  const decision = input.decision;
  const approval = input.governance.approval;
  if (decision.kind !== 'allow') failV1('Prepared builder requires a Kernel allow decision.');

  if (approval.status === 'queued') {
    if (
      approval.grant !== 'none' ||
      approval.approvedToolCallId !== null ||
      approval.approvalBindingDigest !== null
    ) {
      failV1('Prepared builder queued approval facts are malformed.');
    }
  } else if (
    approval.status !== 'approved' ||
    approval.grant === 'none' ||
    approval.approvedToolCallId === null ||
    approval.approvalBindingDigest === null
  ) {
    failV1('Prepared builder approval facts are malformed.');
  }

  if (decision.authorizationKind === 'policy_allow') {
    if (decision.grantUsed !== 'none' || approval.status !== 'queued') {
      failV1('Policy-allow decisions cannot carry an approval grant.');
    }
    return;
  }

  if (decision.authorizationKind !== 'approved_call') {
    failV1('Prepared builder authorization kind is unknown.');
  }
  if (decision.grantUsed === 'none') {
    failV1('Prepared builder approved-call facts are not bound to the Kernel decision.');
  }
  const exactApproval =
    approval.status === 'approved' &&
    approval.grant === decision.grantUsed &&
    approval.approvedToolCallId === input.governance.invocation.toolCallId &&
    approval.approvalBindingDigest !== null &&
    approval.approvalBindingDigest ===
      runtimeHostStateCreateApprovalBindingDigestV1(
        input.governance.invocation,
        input.governance.policy,
      );
  if (exactApproval) return;
  if (approval.status !== 'queued') {
    failV1('Prepared builder approved-call facts are not bound to the Kernel decision.');
  }
  if (decision.grantUsed === 'same_command' && sameCommandGrantMatchesV1(input.governance)) {
    return;
  }
  if (decision.grantUsed === 'full_access' && fullAccessBypassMatchesV1(input.governance)) {
    return;
  }
  failV1('Prepared builder approved-call facts are not bound to the Kernel decision.');
}

function sameCommandGrantMatchesV1(facts: Readonly<AppToolPipelineGovernanceFactsV1>): boolean {
  const grant = facts.sameCommandGrant;
  const invocation = facts.invocation;
  const observedAt = facts.context.observedAt;
  return (
    grant !== undefined &&
    facts.policy.sameCommandMayBypassApproval &&
    invocation.commandDigest !== null &&
    grant.workspace === invocation.workspace &&
    grant.threadId === invocation.threadId &&
    grant.commandDigest === invocation.commandDigest &&
    observedAt !== undefined &&
    observedAt >= grant.grantedAt &&
    (grant.expiresAt === undefined || observedAt < grant.expiresAt)
  );
}

function fullAccessBypassMatchesV1(facts: Readonly<AppToolPipelineGovernanceFactsV1>): boolean {
  const nested = facts.nestedSkill;
  const dynamic = facts.dynamicMcp;
  const forceManual =
    (facts.invocation.operationId === 'builtin:activate_skill' &&
      facts.policy.minimumApproval === 'user') ||
    (facts.invocation.operationId === 'builtin:activate_skill' &&
      (nested?.decision === 'ask' || nested?.minimumApproval === 'user')) ||
    dynamic?.minimumApproval === 'user';
  const forceAutoReview =
    (facts.invocation.operationId === 'builtin:activate_skill' &&
      nested?.minimumApproval === 'auto_review') ||
    dynamic?.minimumApproval === 'auto_review';
  return (
    !forceManual &&
    !forceAutoReview &&
    facts.context.authorizationMode === 'full_access' &&
    facts.policy.fullAccessMayBypassApproval
  );
}

function allowDecisionV1(
  decision: Readonly<AppToolPipelineGovernanceDecisionV1>,
): Extract<AppToolPipelineGovernanceDecisionV1, { readonly kind: 'allow' }> {
  if (decision.kind !== 'allow') failV1('Prepared builder requires a Kernel allow decision.');
  return decision;
}

function assertPreparedArgumentsV1<TArguments extends RuntimeJsonValueV1>(
  validatedArguments: TArguments,
  preparedArguments: TArguments,
  classified: Readonly<ClassifiedInvocationV1<TArguments>>,
): void {
  const key = classified.requirements.idempotencyKeyArgument;
  if (key !== null && !nonEmptyStringV1(key)) {
    failV1('Prepared builder idempotency argument is invalid.');
  }
  const validatedDigest = digestCapabilityValueV1(validatedArguments);
  const preparedDigest = digestCapabilityValueV1(preparedArguments);
  if (validatedDigest === preparedDigest) return;
  if (key === null) failV1('Prepared arguments differ from validated arguments.');
  if (!isJsonRecordV1(validatedArguments) || !isJsonRecordV1(preparedArguments)) {
    failV1('Prepared idempotency arguments must be JSON objects.');
  }
  const preparedKey = preparedArguments[key];
  if (typeof preparedKey !== 'string') {
    failV1('Prepared idempotency argument must be a string.');
  }
  const validatedKey = validatedArguments[key];
  if (validatedKey !== undefined && validatedKey !== preparedKey) {
    failV1('Prepared idempotency argument does not match validated facts.');
  }
  const validatedRest = withoutKeyV1(validatedArguments, key);
  const preparedRest = withoutKeyV1(preparedArguments, key);
  if (digestCapabilityValueV1(validatedRest) !== digestCapabilityValueV1(preparedRest)) {
    failV1('Prepared arguments changed outside the idempotency field.');
  }
}

function idempotencyKeyFromPreparedArgumentsV1(
  preparedArguments: RuntimeJsonValueV1,
  key: string | null,
  allowMissing: boolean,
): string | null {
  if (key === null) return null;
  if (!isJsonRecordV1(preparedArguments)) {
    failV1('Prepared idempotency argument must be a string.');
  }
  if (preparedArguments[key] === undefined && allowMissing) return null;
  if (typeof preparedArguments[key] !== 'string') {
    failV1('Prepared idempotency argument must be a string.');
  }
  return preparedArguments[key] as string;
}

function createPreparedIdentityV1(
  target: Readonly<DynamicMcpToolTargetV1 | NonDynamicToolTargetV1>,
  projection: Readonly<ToolPipelineGovernanceInvocationProjectionV1>,
  argumentOrigin: 'model_public' | 'runtime_private',
  toolCallId: string,
  turnId: string,
  modelMessageId: string,
  invocationId: string,
  attemptId: string,
  argumentsDigest: string,
  schemaDigest: string,
  effectiveEffectsDigest: string,
  idempotencyKeyArgument: string | null,
  idempotencyKey: string | null,
  policyDigest: string,
  authorizationDigest: string,
  admissionDigest: string,
): Readonly<PreparedToolInvocationIdentityV1> {
  const common = {
    invocationId,
    attemptId,
    toolCallId,
    turnId,
    modelMessageId,
    providerId: target.providerId,
    capabilityId: target.capabilityId,
    capabilityRevision: target.capabilityRevision,
    descriptorRevision: target.descriptorRevision,
    parserRevision: projection.parserRevision,
    executorRevision: target.executorRevision,
    argumentsDigest,
    schemaDigest,
    effectiveEffectsDigest,
    policyDigest,
    authorizationDigest,
    admissionDigest,
    idempotencyKeyArgument,
    idempotencyKey,
    bindingId: target.binding?.bindingId ?? null,
  } as const;
  if (target.isDynamicMcp) {
    const identity: DynamicMcpPreparedToolInvocationIdentityV1 = {
      ...common,
      argumentOrigin: 'model_public',
      executionFamily: 'mcp',
      executionMechanism: 'mcp',
      operationId: 'mcp:dynamic_tool',
      visibility: 'internal',
      modelVisible: false,
      exposedToolName: null,
      isDynamicMcp: true,
      executorRevision: null,
      builtinProjectionRevision: null,
      dynamicCatalogRevision: target.dynamicCatalogRevision,
      subject: cloneAndDeepFreezeJsonV1(
        target.subject,
      ) as DynamicMcpPreparedToolInvocationIdentityV1['subject'],
      runtimeWrapper: cloneAndDeepFreezeJsonV1(
        target.runtimeWrapper,
      ) as DynamicMcpPreparedToolInvocationIdentityV1['runtimeWrapper'],
    };
    return deepFreezeV1(identity);
  }
  const identity: NonDynamicPreparedToolInvocationIdentityV1 = {
    ...common,
    argumentOrigin,
    executionFamily: target.executionFamily,
    executionMechanism: target.executionMechanism,
    operationId: target.operationId,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: target.exposedToolName,
    isDynamicMcp: false,
    builtinProjectionRevision: target.builtinProjectionRevision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: projection.nestedCapabilityId,
    nestedCapabilityRevision: projection.nestedCapabilityRevision,
    nestedCatalogRevision: projection.nestedCatalogRevision,
    toolKind: target.toolKind,
  };
  return deepFreezeV1(identity);
}

function assertBindingMatchesTargetV1(
  supplied: ToolPipelineCapabilityBindingV1 | null,
  target: ToolPipelineCapabilityBindingV1 | null,
): void {
  if (supplied === null || target === null) {
    if (supplied !== target) failV1('Prepared binding does not match target identity.');
    return;
  }
  assertBindingV1(supplied);
  assertBindingV1(target);
  if (digestCapabilityValueV1(supplied) !== digestCapabilityValueV1(target)) {
    failV1('Prepared binding does not match target identity.');
  }
}

function assertBindingV1(value: ToolPipelineCapabilityBindingV1): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !nonEmptyStringV1(value.bindingId) ||
    !nonEmptyStringV1(value.capabilityId) ||
    !nonEmptyStringV1(value.capabilityRevision) ||
    !nonEmptyStringV1(value.exposedToolName) ||
    !nonEmptyStringV1(value.schemaDigest) ||
    !nonEmptyStringV1(value.issuedForTurnId)
  ) {
    failV1('Prepared binding is invalid.');
  }
}

function assertRuntimeJsonV1(value: unknown, label: string): asserts value is RuntimeJsonValueV1 {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) failV1(`${label} is not canonical JSON.`);
      return;
    }
    if (typeof candidate !== 'object') failV1(`${label} is not canonical JSON.`);
    if (seen.has(candidate)) failV1(`${label} is not canonical JSON.`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        failV1(`${label} is not canonical JSON.`);
      }
      for (const [key, item] of Object.entries(candidate)) {
        if (typeof key !== 'string') failV1(`${label} is not canonical JSON.`);
        visit(item);
      }
    }
    seen.delete(candidate);
  };
  visit(value);
}

function isJsonRecordV1(
  value: RuntimeJsonValueV1,
): value is { readonly [key: string]: RuntimeJsonValueV1 } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function withoutKeyV1(
  value: { readonly [key: string]: RuntimeJsonValueV1 },
  key: string,
): Record<string, RuntimeJsonValueV1> {
  const result: Record<string, RuntimeJsonValueV1> = {};
  for (const [candidate, item] of Object.entries(value)) {
    if (candidate !== key) result[candidate] = item;
  }
  return result;
}

function cloneAndDeepFreezeJsonV1<T extends RuntimeJsonValueV1>(value: T): T {
  const clone = cloneJsonV1(value);
  return deepFreezeV1(clone) as T;
}

function cloneAndDeepFreezePreparedRequestV1(
  request: Readonly<AppToolPipelinePreparedRequestV1>,
): Readonly<AppToolPipelinePreparedRequestV1> {
  const clone: AppToolPipelinePreparedRequestV1 = {
    schema: request.schema,
    authorizationKind: request.authorizationKind,
    grantUsed: request.grantUsed,
    policyEffects: cloneAndDeepFreezePolicyEffectsV1(request.policyEffects),
    effectiveEffects: cloneAndDeepFreezeCapabilityEffectsV1(request.effectiveEffects),
    receiptRequirement: request.receiptRequirement,
    retryEligibility: request.retryEligibility,
    taskId: request.taskId,
    planId: request.planId,
    planStepId: request.planStepId,
    capabilityRequestFacts:
      request.capabilityRequestFacts === null
        ? null
        : cloneAndDeepFreezeJsonV1(request.capabilityRequestFacts),
  };
  return deepFreezeV1(clone);
}

function cloneAndDeepFreezePolicyEffectsV1(
  value: Readonly<CapabilityPolicyEffectsV1>,
): Readonly<CapabilityPolicyEffectsV1> {
  const clone: CapabilityPolicyEffectsV1 = {
    ...(value.network === true ? { network: true } : {}),
    ...(value.externalRead === true ? { externalRead: true } : {}),
    ...(value.externalWrite === true ? { externalWrite: true } : {}),
    ...(value.uncertainEffects === true ? { uncertainEffects: true } : {}),
  };
  return deepFreezeV1(clone);
}

function cloneAndDeepFreezeCapabilityEffectsV1(
  value: Readonly<CapabilityEffectsV1>,
): Readonly<CapabilityEffectsV1> {
  return deepFreezeV1({
    filesystem: value.filesystem,
    network: value.network,
    externalState: value.externalState,
  });
}

function cloneJsonV1(value: RuntimeJsonValueV1): RuntimeJsonValueV1 {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonV1(item));
  const result: Record<string, RuntimeJsonValueV1> = {};
  for (const [key, item] of Object.entries(value)) result[key] = cloneJsonV1(item);
  return result;
}

function cloneAndDeepFreezeBindingV1(
  value: ToolPipelineCapabilityBindingV1 | null,
): ToolPipelineCapabilityBindingV1 | null {
  if (value === null) return null;
  return cloneAndDeepFreezeJsonV1(
    value as unknown as RuntimeJsonValueV1,
  ) as unknown as ToolPipelineCapabilityBindingV1;
}

function deepFreezeV1<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeV1(child);
  return Object.freeze(value);
}

function executionMechanismForGovernanceV1(mechanism: string): 'user_input' | 'shell' | 'other' {
  if (mechanism === 'user_input') return 'user_input';
  if (mechanism === 'shell') return 'shell';
  return 'other';
}

function nonEmptyStringV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function failV1(message: string): never {
  throw new Error(message);
}
