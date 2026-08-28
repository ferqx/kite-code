import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import type {
  RuntimeHostStateToolGovernanceDecision,
  RuntimeHostStateToolGovernanceFacts,
} from '@kite-ai/runtime-host/kernel-adapter';
import { runtimeHostStateCreateApprovalBindingDigest } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  CapabilityEffects,
  CapabilityPolicyEffects,
  CapabilitySandboxScopeFact,
  ClassifiedInvocation,
  DynamicMcpPreparedToolInvocationIdentity,
  DynamicMcpToolTarget,
  NonDynamicPreparedToolInvocationIdentity,
  NonDynamicToolTarget,
  PreparedToolInvocation,
  PreparedToolInvocationIdentity,
  PreparedToolInvocationInput,
  RuntimeJsonValue,
  ToolPipelineCapabilityBinding,
  ToolPipelineGovernanceInvocationProjection,
  ToolPipelineReceiptRequirement,
  ToolPipelineRetryEligibility,
} from '@kite-ai/runtime-spi';

export const APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_ =
  'kite.tool-pipeline-prepared-request.v1' as const;

export type AppToolPipelinePreparedAuthorizationKind = 'policy_allow' | 'approved_call';
export type AppToolPipelinePreparedGrantUsed = 'none' | 'approve_once' | 'same_command';

/**
 * The request facts persisted alongside a prepared attempt.  It is a neutral
 * JSON envelope: task/plan identifiers are optional facts, while effects and
 * receipt/retry requirements are copied from the already-classified Builtin
 * projection and never inferred here.
 */
export interface AppToolPipelinePreparedRequest {
  readonly schema: typeof APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_;
  /** Exact authorization kind returned by the Kernel allow decision. */
  readonly authorizationKind: AppToolPipelinePreparedAuthorizationKind;
  /** The narrowed State 27 grant carried by the Kernel allow decision. */
  readonly grantUsed: AppToolPipelinePreparedGrantUsed;
  /** Live mode that produced the authorization digest; Full is not a grant. */
  readonly interactionMode: 'auto' | 'accept_edits' | 'full';
  /** Exact compiler-selected sandbox lane, or null for non-sandbox tools. */
  readonly sandboxScope: Readonly<CapabilitySandboxScopeFact> | null;
  /** Builtin policy effects; `{}` is required when the compilation omits effects. */
  readonly policyEffects: Readonly<CapabilityPolicyEffects>;
  readonly effectiveEffects: Readonly<CapabilityEffects>;
  readonly receiptRequirement: ToolPipelineReceiptRequirement;
  readonly retryEligibility: ToolPipelineRetryEligibility;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly planStepId: string | null;
  readonly capabilityRequestFacts: RuntimeJsonValue | null;
}

export type AppToolPipelineGovernanceFacts = RuntimeHostStateToolGovernanceFacts;
export type AppToolPipelineGovernanceDecision = RuntimeHostStateToolGovernanceDecision;

type AppPreparedToolInvocationInput<TArguments extends RuntimeJsonValue> = Omit<
  PreparedToolInvocationInput<TArguments, RuntimeJsonValue>,
  'request'
> & {
  readonly request: Readonly<AppToolPipelinePreparedRequest>;
};

export type AppPreparedToolInvocationPacket<TArguments extends RuntimeJsonValue> = Omit<
  PreparedToolInvocation<TArguments, RuntimeJsonValue>,
  'input'
> & {
  readonly input: Readonly<AppPreparedToolInvocationInput<TArguments>>;
};

/**
 * The App composition root supplies all values in this input.  This builder
 * does not discover a registry, parse arguments, compile policy, or select an
 * executor; it only binds already-authentic facts into the neutral Host
 * prepared-invocation packet.
 */
export interface AppPreparedToolInvocationBuilderInput<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly classified: Readonly<ClassifiedInvocation<TArguments>>;
  readonly governance: Readonly<AppToolPipelineGovernanceFacts>;
  readonly decision: Readonly<AppToolPipelineGovernanceDecision>;
  readonly threadId: string;
  readonly attempt: number;
  /** Canonical arguments after any caller-owned, explicit preparation. */
  readonly preparedArguments: TArguments;
  /** Exact canonical request DTO; this builder does not invent one. */
  readonly request: Readonly<AppToolPipelinePreparedRequest>;
  /** The exact target binding, or null for an unbound ordinary Builtin. */
  readonly binding: ToolPipelineCapabilityBinding | null;
}

/**
 * Attempt metadata remains alongside the prepared packet until the injected
 * persistence owner records it.  The packet itself is assignable to the SPI
 * PreparedToolInvocation type.
 */
export interface AppPreparedToolInvocationBuild<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly prepared: Readonly<AppPreparedToolInvocationPacket<TArguments>>;
  readonly attempt: number;
}

/**
 * Bind State 27 governance facts and one Kernel allow decision to an immutable
 * SPI prepared invocation.  All identity fields are copied from the existing
 * Builtin/SPI projection; no App policy or execution authority is introduced.
 */
export function createAppPreparedToolInvocation<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
>(
  input: Readonly<AppPreparedToolInvocationBuilderInput<TArguments>>,
): Readonly<AppPreparedToolInvocationBuild<TArguments>> {
  assertBuilderEnvelope(input);

  const classified = input.classified;
  const validated = classified.validated;
  const resolved = validated.resolved;
  const target = resolved.target;
  const governance = input.governance;
  const classifiedGovernance = classified.governance;
  const decision = allowDecision(input.decision);
  const domainData = validated.domainData;
  if (domainData === undefined) fail('Prepared builder requires classified domain facts.');

  assertClassifiedAndGovernanceMatch(input, classifiedGovernance);
  assertDecisionAndAdmissionMatch(input);
  assertApprovedCallFacts(input);
  assertPreparedArguments(validated.request.arguments, input.preparedArguments, classified);
  assertBindingMatchesTarget(input.binding, target.binding);

  const policyDigest = runtimeHostStateCreateApprovalBindingDigest(
    governance.invocation,
    governance.policy,
  );
  const authorizationDigest = digestCapabilityValue({
    policyDigest,
    authorizationKind: decision.authorizationKind,
    grantUsed: decision.grantUsed,
    interactionMode: governance.context.interactionMode,
    sandboxScope: classified.policyCompilation.sandboxScope ?? null,
  });
  const admissionDigest = digestCapabilityValue({
    authorizationDigest,
    reservationIds: governance.admission.reservationIds,
    freshness: governance.admission.freshness,
  });

  const originalArgumentsDigest = validated.request.argumentsDigest;
  const subjectCapabilityId = target.capabilityId;
  const subjectCapabilityRevision = target.capabilityRevision;
  const invocationId = digestCapabilityValue({
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
  const idempotencyKey = idempotencyKeyFromPreparedArguments(
    input.preparedArguments,
    idempotencyKeyArgument,
    target.isDynamicMcp,
  );
  const preparedArgumentsDigest = digestCapabilityValue(input.preparedArguments);
  const identity = createPreparedIdentity(
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

  const preparedInput: AppPreparedToolInvocationInput<TArguments> = {
    invocationId,
    attemptId,
    toolCallId: resolved.call.toolCallId,
    arguments: cloneAndDeepFreezeJson(input.preparedArguments),
    request: cloneAndDeepFreezePreparedRequest(input.request),
    binding: cloneAndDeepFreezeBinding(input.binding),
    facts: cloneAndDeepFreezeJson(domainData),
  };
  const prepared = deepFreeze({
    identity,
    input: preparedInput,
  });
  return deepFreeze({
    prepared,
    attempt: input.attempt,
  });
}

function assertBuilderEnvelope<TArguments extends RuntimeJsonValue>(
  input: Readonly<AppPreparedToolInvocationBuilderInput<TArguments>>,
): void {
  if (!input || typeof input !== 'object') fail('Prepared builder input is unavailable.');
  if (input.classified?.stage !== 'classified') {
    fail('Prepared builder requires a classified invocation.');
  }
  if (input.governance?.schema !== 'kite.tool-governance-facts.v1') {
    fail('Prepared builder requires State 27 governance facts.');
  }
  if (input.decision.kind !== 'allow') {
    fail('Prepared builder requires a Kernel allow decision.');
  }
  if (!nonEmptyString(input.threadId)) fail('Prepared builder thread identity is invalid.');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    fail('Prepared builder attempt is invalid.');
  }
  assertRuntimeJson(input.preparedArguments, 'prepared arguments');
  if (input.request === undefined) fail('Prepared builder requires request facts.');
  assertRuntimeJson(input.request, 'prepared request');
  assertPreparedRequest(
    input.request,
    input.classified,
    input.decision,
    input.governance.context.interactionMode,
  );
  if (input.binding !== null) assertBinding(input.binding);
  if (input.classified.validated.domainData === undefined) {
    fail('Prepared builder requires classified domain facts.');
  }
  assertRuntimeJson(input.classified.validated.domainData, 'classified domain facts');
}

function assertClassifiedAndGovernanceMatch<TArguments extends RuntimeJsonValue>(
  input: Readonly<AppPreparedToolInvocationBuilderInput<TArguments>>,
  classifiedGovernance: Readonly<ClassifiedInvocation<TArguments>['governance']>,
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
    digestCapabilityValue(classified.policyCompilation) !==
      digestCapabilityValue(classifiedGovernance.policy)
  ) {
    fail('Prepared builder policy projection is inconsistent.');
  }
  if (
    classifiedGovernance.effectiveEffects !== classified.effectiveEffects ||
    classifiedGovernance.effectiveEffectsDigest !== classified.effectiveEffectsDigest ||
    digestCapabilityValue(classifiedGovernance.effectiveEffects) !==
      classified.effectiveEffectsDigest
  ) {
    fail('Prepared builder effects projection is inconsistent.');
  }
  if (validated.request.argumentsDigest !== digestCapabilityValue(validated.request.arguments)) {
    fail('Prepared builder validated argument digest is inconsistent.');
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
    fail('Prepared builder governance invocation does not match classified facts.');
  }
  if (
    projection.argumentOrigin !== resolved.call.argumentOrigin ||
    projection.executionFamily !== target.executionFamily ||
    projection.executionMechanism !== target.executionMechanism ||
    projection.providerId !== target.providerId
  ) {
    fail('Prepared builder classified invocation projection is stale.');
  }
  if (facts.policy.operationId !== classified.policyCompilation.operationId) {
    fail('Prepared builder governance policy does not match classified facts.');
  }
  if (
    !policyFactsMatch(facts.policy, classifiedGovernance.policy, classified.effectiveEffectsDigest)
  ) {
    fail('Prepared builder State 27 policy facts are stale.');
  }
  if (
    facts.context.executionMechanism !== executionMechanismForGovernance(target.executionMechanism)
  ) {
    fail('Prepared builder governance mechanism is stale.');
  }
  if (target.isDynamicMcp) {
    assertDynamicProjectionMatch(target, projection, classifiedGovernance.dynamicMcp, facts);
  } else {
    assertOrdinaryProjectionMatch(target, projection, facts);
  }
}

function assertPreparedRequest<TArguments extends RuntimeJsonValue>(
  request: Readonly<AppToolPipelinePreparedRequest>,
  classified: Readonly<ClassifiedInvocation<TArguments>>,
  decision: Readonly<AppToolPipelineGovernanceDecision>,
  interactionMode: AppToolPipelinePreparedRequest['interactionMode'],
): void {
  if (decision.kind !== 'allow') fail('Prepared request requires a Kernel allow decision.');
  const expectedKeys = new Set([
    'schema',
    'authorizationKind',
    'grantUsed',
    'interactionMode',
    'sandboxScope',
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
    fail('Prepared request contains unexpected or missing fields.');
  }
  if (
    request.schema !== APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_ ||
    request.interactionMode !== interactionMode ||
    digestCapabilityValue(request.sandboxScope) !==
      digestCapabilityValue(classified.policyCompilation.sandboxScope ?? null) ||
    digestCapabilityValue(request.effectiveEffects) !==
      digestCapabilityValue(classified.effectiveEffects) ||
    request.receiptRequirement !== classified.requirements.receipt ||
    request.retryEligibility !== classified.requirements.retry
  ) {
    fail('Prepared request facts do not match classified facts.');
  }
  if (
    !isPreparedAuthorizationKind(decision.authorizationKind) ||
    request.authorizationKind !== decision.authorizationKind ||
    !isPreparedGrantUsed(decision.grantUsed) ||
    request.grantUsed !== decision.grantUsed
  ) {
    fail('Prepared request authorization facts do not match the Kernel allow decision.');
  }
  assertPolicyEffects(request.policyEffects, 'prepared policy effects');
  const expectedPolicyEffects = classified.policyCompilation.effects ?? {};
  assertPolicyEffects(expectedPolicyEffects, 'classified policy effects');
  if (
    digestCapabilityValue(request.policyEffects) !== digestCapabilityValue(expectedPolicyEffects)
  ) {
    fail('Prepared request policy effects do not match classified policy facts.');
  }
  for (const value of [request.taskId, request.planId, request.planStepId]) {
    if (value !== null && !nonEmptyString(value)) {
      fail('Prepared request identifier is invalid.');
    }
  }
  if (request.capabilityRequestFacts !== null) {
    assertRuntimeJson(request.capabilityRequestFacts, 'prepared capability request facts');
  }
}

function isPreparedAuthorizationKind(
  value: unknown,
): value is AppToolPipelinePreparedAuthorizationKind {
  return value === 'policy_allow' || value === 'approved_call';
}

function isPreparedGrantUsed(value: unknown): value is AppToolPipelinePreparedGrantUsed {
  return value === 'none' || value === 'approve_once' || value === 'same_command';
}

function assertPolicyEffects(
  value: unknown,
  label: string,
): asserts value is Readonly<CapabilityPolicyEffects> {
  assertRuntimeJson(value, label);
  if (!isJsonRecord(value)) fail(`${label} must be a JSON object.`);
  const allowedKeys = new Set([
    'network',
    'externalRead',
    'externalWrite',
    'uncertainEffects',
    'sensitiveExternalAccess',
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key) || item !== true) fail(`${label} is invalid.`);
  }
}

function policyFactsMatch(
  facts: Readonly<AppToolPipelineGovernanceFacts['policy']>,
  policy: Readonly<ClassifiedInvocation['policyCompilation']>,
  effectiveEffectsDigest: string,
): boolean {
  return (
    digestCapabilityValue(facts) ===
    digestCapabilityValue({
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
      expectedEffects: policy.expectedEffects,
      ...(policy.requiresSandbox === undefined ? {} : { requiresSandbox: policy.requiresSandbox }),
      ...(policy.phaseConstraint === undefined ? {} : { phaseConstraint: policy.phaseConstraint }),
    })
  );
}

function assertDynamicProjectionMatch(
  target: Readonly<DynamicMcpToolTarget>,
  projection: Readonly<ToolPipelineGovernanceInvocationProjection>,
  classifiedDynamicMcp: Readonly<ClassifiedInvocation['governance']['dynamicMcp']>,
  facts: Readonly<AppToolPipelineGovernanceFacts>,
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
    digestCapabilityValue(projection.subject) !== digestCapabilityValue(target.subject) ||
    digestCapabilityValue(projection.runtimeWrapper) !==
      digestCapabilityValue(target.runtimeWrapper) ||
    !facts.dynamicMcp ||
    !classifiedDynamicMcp ||
    digestCapabilityValue(facts.dynamicMcp) !==
      digestCapabilityValue({
        minimumApproval: classifiedDynamicMcp.minimumApproval,
        readOnly: classifiedDynamicMcp.readOnly,
      })
  ) {
    fail('Prepared builder dynamic MCP identity is inconsistent.');
  }
}

function assertOrdinaryProjectionMatch(
  target: Readonly<NonDynamicToolTarget>,
  projection: Readonly<ToolPipelineGovernanceInvocationProjection>,
  facts: Readonly<AppToolPipelineGovernanceFacts>,
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
    fail('Prepared builder ordinary identity is inconsistent.');
  }
}

function assertDecisionAndAdmissionMatch<TArguments extends RuntimeJsonValue>(
  input: Readonly<AppPreparedToolInvocationBuilderInput<TArguments>>,
): void {
  const decision = input.decision;
  const facts = input.governance;
  if (decision.kind !== 'allow' || facts.policy.allowed !== true) {
    fail('Prepared builder admission is not allowed.');
  }
  if (facts.admission.freshness !== 'current') {
    fail('Prepared builder admission is stale.');
  }
  if (
    digestCapabilityValue(decision.reservationIds) !==
      digestCapabilityValue(facts.admission.reservationIds) ||
    decision.reservationIds.some((value) => typeof value !== 'string')
  ) {
    fail('Prepared builder reservation identity is inconsistent.');
  }
}

/**
 * A Kernel approved-call decision is only consumable when the projected
 * approval is bound to this exact invocation and policy.  In particular,
 * `approve_once` is a transient per-call grant: it must never be accepted
 * from a policy-allow decision, an unapproved envelope, or a copied digest.
 */
function assertApprovedCallFacts<TArguments extends RuntimeJsonValue>(
  input: Readonly<AppPreparedToolInvocationBuilderInput<TArguments>>,
): void {
  const decision = input.decision;
  const approval = input.governance.approval;
  if (decision.kind !== 'allow') fail('Prepared builder requires a Kernel allow decision.');

  if (approval.status === 'queued') {
    if (
      approval.grant !== 'none' ||
      approval.approvedToolCallId !== null ||
      approval.approvalBindingDigest !== null
    ) {
      fail('Prepared builder queued approval facts are malformed.');
    }
  } else if (
    approval.status !== 'approved' ||
    approval.grant === 'none' ||
    approval.approvedToolCallId === null ||
    approval.approvalBindingDigest === null
  ) {
    fail('Prepared builder approval facts are malformed.');
  }

  if (decision.authorizationKind === 'policy_allow') {
    if (decision.grantUsed !== 'none' || approval.status !== 'queued') {
      fail('Policy-allow decisions cannot carry an approval grant.');
    }
    return;
  }

  if (decision.authorizationKind !== 'approved_call') {
    fail('Prepared builder authorization kind is unknown.');
  }
  if (decision.grantUsed === 'none') {
    fail('Prepared builder approved-call facts are not bound to the Kernel decision.');
  }
  const exactApproval =
    approval.status === 'approved' &&
    approval.grant === decision.grantUsed &&
    approval.approvedToolCallId === input.governance.invocation.toolCallId &&
    approval.approvalBindingDigest !== null &&
    approval.approvalBindingDigest ===
      runtimeHostStateCreateApprovalBindingDigest(
        input.governance.invocation,
        input.governance.policy,
      );
  if (exactApproval) return;
  if (approval.status !== 'queued') {
    fail('Prepared builder approved-call facts are not bound to the Kernel decision.');
  }
  if (decision.grantUsed === 'same_command' && sameCommandGrantMatches(input.governance)) {
    return;
  }
  fail('Prepared builder approved-call facts are not bound to the Kernel decision.');
}

function sameCommandGrantMatches(facts: Readonly<AppToolPipelineGovernanceFacts>): boolean {
  const grant = facts.sameCommandGrant;
  const invocation = facts.invocation;
  const observedAt = facts.context.observedAt;
  return (
    grant !== undefined &&
    facts.policy.sameCommandMayBypassApproval &&
    invocation.commandDigest !== null &&
    grant.workspace === invocation.workspace &&
    grant.threadId === invocation.threadId &&
    grant.canonicalWorkspaceIdentity === invocation.canonicalWorkspaceIdentity &&
    grant.cwd === invocation.cwd &&
    grant.executor === invocation.executor &&
    grant.environmentDigest === invocation.environmentDigest &&
    grant.scopeDigest === invocation.scopeDigest &&
    grant.effectsDigest === invocation.effectiveEffectsDigest &&
    grant.parserRevision === invocation.parserRevision &&
    grant.executorRevision === invocation.executorRevision &&
    grant.commandDigest === invocation.commandDigest &&
    observedAt !== undefined &&
    observedAt >= grant.grantedAt &&
    (grant.expiresAt === undefined || observedAt < grant.expiresAt)
  );
}

function allowDecision(
  decision: Readonly<AppToolPipelineGovernanceDecision>,
): Extract<AppToolPipelineGovernanceDecision, { readonly kind: 'allow' }> {
  if (decision.kind !== 'allow') fail('Prepared builder requires a Kernel allow decision.');
  return decision;
}

function assertPreparedArguments<TArguments extends RuntimeJsonValue>(
  validatedArguments: TArguments,
  preparedArguments: TArguments,
  classified: Readonly<ClassifiedInvocation<TArguments>>,
): void {
  const key = classified.requirements.idempotencyKeyArgument;
  if (key !== null && !nonEmptyString(key)) {
    fail('Prepared builder idempotency argument is invalid.');
  }
  const validatedDigest = digestCapabilityValue(validatedArguments);
  const preparedDigest = digestCapabilityValue(preparedArguments);
  if (validatedDigest === preparedDigest) return;
  if (key === null) fail('Prepared arguments differ from validated arguments.');
  if (!isJsonRecord(validatedArguments) || !isJsonRecord(preparedArguments)) {
    fail('Prepared idempotency arguments must be JSON objects.');
  }
  const preparedKey = preparedArguments[key];
  if (typeof preparedKey !== 'string') {
    fail('Prepared idempotency argument must be a string.');
  }
  const validatedKey = validatedArguments[key];
  if (validatedKey !== undefined && validatedKey !== preparedKey) {
    fail('Prepared idempotency argument does not match validated facts.');
  }
  const validatedRest = withoutKey(validatedArguments, key);
  const preparedRest = withoutKey(preparedArguments, key);
  if (digestCapabilityValue(validatedRest) !== digestCapabilityValue(preparedRest)) {
    fail('Prepared arguments changed outside the idempotency field.');
  }
}

function idempotencyKeyFromPreparedArguments(
  preparedArguments: RuntimeJsonValue,
  key: string | null,
  allowMissing: boolean,
): string | null {
  if (key === null) return null;
  if (!isJsonRecord(preparedArguments)) {
    fail('Prepared idempotency argument must be a string.');
  }
  if (preparedArguments[key] === undefined && allowMissing) return null;
  if (typeof preparedArguments[key] !== 'string') {
    fail('Prepared idempotency argument must be a string.');
  }
  return preparedArguments[key] as string;
}

function createPreparedIdentity(
  target: Readonly<DynamicMcpToolTarget | NonDynamicToolTarget>,
  projection: Readonly<ToolPipelineGovernanceInvocationProjection>,
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
): Readonly<PreparedToolInvocationIdentity> {
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
    const identity: DynamicMcpPreparedToolInvocationIdentity = {
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
      subject: cloneAndDeepFreezeJson(
        target.subject,
      ) as DynamicMcpPreparedToolInvocationIdentity['subject'],
      runtimeWrapper: cloneAndDeepFreezeJson(
        target.runtimeWrapper,
      ) as DynamicMcpPreparedToolInvocationIdentity['runtimeWrapper'],
    };
    return deepFreeze(identity);
  }
  const identity: NonDynamicPreparedToolInvocationIdentity = {
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
  return deepFreeze(identity);
}

function assertBindingMatchesTarget(
  supplied: ToolPipelineCapabilityBinding | null,
  target: ToolPipelineCapabilityBinding | null,
): void {
  if (supplied === null || target === null) {
    if (supplied !== target) fail('Prepared binding does not match target identity.');
    return;
  }
  assertBinding(supplied);
  assertBinding(target);
  if (digestCapabilityValue(supplied) !== digestCapabilityValue(target)) {
    fail('Prepared binding does not match target identity.');
  }
}

function assertBinding(value: ToolPipelineCapabilityBinding): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !nonEmptyString(value.bindingId) ||
    !nonEmptyString(value.capabilityId) ||
    !nonEmptyString(value.capabilityRevision) ||
    !nonEmptyString(value.exposedToolName) ||
    !nonEmptyString(value.schemaDigest) ||
    !nonEmptyString(value.issuedForTurnId)
  ) {
    fail('Prepared binding is invalid.');
  }
}

function assertRuntimeJson(value: unknown, label: string): asserts value is RuntimeJsonValue {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) fail(`${label} is not canonical JSON.`);
      return;
    }
    if (typeof candidate !== 'object') fail(`${label} is not canonical JSON.`);
    if (seen.has(candidate)) fail(`${label} is not canonical JSON.`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        fail(`${label} is not canonical JSON.`);
      }
      for (const [key, item] of Object.entries(candidate)) {
        if (typeof key !== 'string') fail(`${label} is not canonical JSON.`);
        visit(item);
      }
    }
    seen.delete(candidate);
  };
  visit(value);
}

function isJsonRecord(
  value: RuntimeJsonValue,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function withoutKey(
  value: { readonly [key: string]: RuntimeJsonValue },
  key: string,
): Record<string, RuntimeJsonValue> {
  const result: Record<string, RuntimeJsonValue> = {};
  for (const [candidate, item] of Object.entries(value)) {
    if (candidate !== key) result[candidate] = item;
  }
  return result;
}

function cloneAndDeepFreezeJson<T extends RuntimeJsonValue>(value: T): T {
  const clone = cloneJson(value);
  return deepFreeze(clone) as T;
}

function cloneAndDeepFreezePreparedRequest(
  request: Readonly<AppToolPipelinePreparedRequest>,
): Readonly<AppToolPipelinePreparedRequest> {
  const clone: AppToolPipelinePreparedRequest = {
    schema: request.schema,
    authorizationKind: request.authorizationKind,
    grantUsed: request.grantUsed,
    interactionMode: request.interactionMode,
    sandboxScope: request.sandboxScope === null ? null : Object.freeze({ ...request.sandboxScope }),
    policyEffects: cloneAndDeepFreezePolicyEffects(request.policyEffects),
    effectiveEffects: cloneAndDeepFreezeCapabilityEffects(request.effectiveEffects),
    receiptRequirement: request.receiptRequirement,
    retryEligibility: request.retryEligibility,
    taskId: request.taskId,
    planId: request.planId,
    planStepId: request.planStepId,
    capabilityRequestFacts:
      request.capabilityRequestFacts === null
        ? null
        : cloneAndDeepFreezeJson(request.capabilityRequestFacts),
  };
  return deepFreeze(clone);
}

function cloneAndDeepFreezePolicyEffects(
  value: Readonly<CapabilityPolicyEffects>,
): Readonly<CapabilityPolicyEffects> {
  const clone: CapabilityPolicyEffects = {
    ...(value.network === true ? { network: true } : {}),
    ...(value.externalRead === true ? { externalRead: true } : {}),
    ...(value.externalWrite === true ? { externalWrite: true } : {}),
    ...(value.uncertainEffects === true ? { uncertainEffects: true } : {}),
    ...(value.sensitiveExternalAccess === true ? { sensitiveExternalAccess: true } : {}),
  };
  return deepFreeze(clone);
}

function cloneAndDeepFreezeCapabilityEffects(
  value: Readonly<CapabilityEffects>,
): Readonly<CapabilityEffects> {
  return deepFreeze({
    filesystem: value.filesystem,
    network: value.network,
    externalState: value.externalState,
  });
}

function cloneJson(value: RuntimeJsonValue): RuntimeJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  const result: Record<string, RuntimeJsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = cloneJson(item);
  return result;
}

function cloneAndDeepFreezeBinding(
  value: ToolPipelineCapabilityBinding | null,
): ToolPipelineCapabilityBinding | null {
  if (value === null) return null;
  return cloneAndDeepFreezeJson(
    value as unknown as RuntimeJsonValue,
  ) as unknown as ToolPipelineCapabilityBinding;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function executionMechanismForGovernance(mechanism: string): 'user_input' | 'shell' | 'other' {
  if (mechanism === 'user_input') return 'user_input';
  if (mechanism === 'shell') return 'shell';
  return 'other';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function fail(message: string): never {
  throw new Error(message);
}
