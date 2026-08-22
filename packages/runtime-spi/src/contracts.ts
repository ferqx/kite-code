import { RUNTIME_CONTRACT_BOUNDARY_V1 } from '@kite/runtime-contract';

export type RuntimeJsonScalarV1 = string | number | boolean | null;
export type RuntimeJsonValueV1 =
  | RuntimeJsonScalarV1
  | readonly RuntimeJsonValueV1[]
  | { readonly [key: string]: RuntimeJsonValueV1 };

/**
 * Static effects declared by a capability owner.
 *
 * This is deliberately a small, provider-neutral value object.  Runtime
 * policy may tighten these facts for an invocation, but a model-facing
 * projection must never invent a less conservative effect profile.
 */
export type CapabilityEffectLevelV1 = 'none' | 'read' | 'write' | 'destructive' | 'unknown';

export interface CapabilityEffectsV1 {
  readonly filesystem: CapabilityEffectLevelV1;
  readonly network: CapabilityEffectLevelV1;
  readonly externalState: CapabilityEffectLevelV1;
}

export type CapabilityVisibilityV1 = 'model' | 'internal';

/**
 * Stable Builtin execution-mechanism metadata.  This is descriptive routing
 * identity only; it never selects an executor or grants execution authority.
 */
export const CAPABILITY_EXECUTION_MECHANISMS_V1 = Object.freeze([
  'catalog',
  'filesystem',
  'git',
  'shell',
  'web',
  'mcp',
  'skill',
  'planning',
  'subagent',
  'user_input',
  'verification',
  'model',
] as const);

export type CapabilityExecutionMechanismV1 = (typeof CAPABILITY_EXECUTION_MECHANISMS_V1)[number];

/**
 * Compile-time-neutral resource identity used by the deterministic Kernel
 * scheduler.  The SPI intentionally does not import the Kernel package;
 * composition roots may project this value into the Kernel's equivalent DTO.
 */
export interface CapabilityResourceScopeV1 {
  readonly kind:
    | 'runtime'
    | 'workspace'
    | 'process'
    | 'network'
    | 'external_state'
    | 'subagent'
    | 'skill';
  readonly key: string;
}

export interface CapabilityExecutionTraitsV1 {
  readonly resourceScopes: readonly CapabilityResourceScopeV1[];
  readonly access: 'read' | 'write' | 'unknown';
  readonly conflictKeys: readonly string[];
  readonly isolation: 'shared' | 'exclusive_workspace' | 'worktree';
  readonly causalGroup: string;
  readonly interactionBarrier: boolean;
  readonly concurrencyGroup?: string;
  readonly leaseFenceRequired: boolean;
}

/** Static declaration facts only; invocation identity/access are projected later. */
export interface CapabilityExecutionTraitsDeclarationV1 {
  readonly resourceScopes: readonly CapabilityResourceScopeV1[];
  readonly conflictKeys?: readonly string[];
  readonly isolation?: 'shared' | 'exclusive_workspace' | 'worktree';
  readonly interactionBarrier: boolean;
  readonly concurrencyGroup?: string;
  readonly leaseFenceRequired: boolean;
}

export type CapabilityExecutionTraitsProjectorV1 = (
  input: RuntimeJsonValueV1,
  context: CapabilityTurnContextV1,
  effects: CapabilityInvocationEffectsV1,
) => CapabilityExecutionTraitsV1;

export type CapabilityApprovalV1 = 'none' | 'auto_review' | 'user';

export type CapabilityKindV1 =
  | 'computer'
  | 'coordination'
  | 'runtime_action'
  | 'interrupt'
  | 'internal_runtime';

export type CapabilityToolKindV1 = Exclude<CapabilityKindV1, 'internal_runtime'>;

export type CapabilityDescriptorKindV1 = 'builtin_tool';

/** Feature facts consumed by registered Builtin callbacks; unrelated App flags never enter SPI. */
export interface CapabilityFeatureFlagsV1 {
  readonly promptContractV2?: boolean;
  readonly brokeredGitV1?: boolean;
  readonly skillWorkflowV1?: boolean;
  readonly skillActivationV2?: boolean;
}

/** Immutable facts available to a Builtin availability/effects callback. */
export interface CapabilityTurnContextV1 {
  readonly workspace?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly activeTaskId?: string;
  readonly modelMessageId?: string;
  readonly toolCallId?: string;
  readonly phase?: 'planning' | 'building';
  readonly promptContractV2?: boolean;
  readonly brokeredGitFeatureRevision?: string | null;
  readonly hasTaskAdapter?: boolean;
  readonly hasGitBroker?: boolean;
  readonly toolSearchEnabled?: boolean;
  readonly activeSkillFrameIds?: readonly string[];
  readonly availableSkillIds?: readonly string[];
  readonly workspaceTrust?: 'trusted' | 'untrusted' | 'unknown';
  readonly featureFlags?: Readonly<CapabilityFeatureFlagsV1>;
}

/**
 * Canonical availability context passed through the Core Pipeline.  This is
 * an SPI context projection only: it carries turn facts and never schemas,
 * effects, availability decisions, or executor handles.
 */
export interface CapabilityAvailabilityContextV1 extends CapabilityTurnContextV1 {
  readonly workspace: string;
  readonly interactionMode?: import('@kite/runtime-contract').InteractionMode;
}

export interface CapabilityAvailabilityDecisionV1 {
  readonly status: 'available' | 'degraded' | 'unavailable' | 'quarantined' | 'hidden';
  readonly reason?: string;
  readonly diagnostics?: readonly string[];
}

export type CapabilityAvailabilityResolverV1 = (
  context: CapabilityTurnContextV1,
) => CapabilityAvailabilityDecisionV1;

export type CapabilityEffectClassV1 =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export type CapabilityRiskClassV1 =
  | 'read'
  | 'plan'
  | 'workspace_write'
  | 'execute'
  | 'network'
  | 'external_state'
  | 'destructive'
  | 'unknown';

export interface CapabilityInvocationEffectsV1 {
  readonly effectClass: CapabilityEffectClassV1;
  readonly sideEffect: boolean;
  readonly classificationReason: string;
  readonly risk: CapabilityRiskClassV1;
  /** Runtime may only tighten these declared facts for one invocation. */
  readonly effectiveEffects: CapabilityEffectsV1;
}

/**
 * The small additive effect facts consumed by the pure Kernel governance
 * decision.  These flags intentionally describe effects in addition to the
 * primary capability effect profile; they are not authorization or grant
 * decisions.
 */
export interface CapabilityPolicyEffectsV1 {
  readonly network?: true;
  readonly externalRead?: true;
  readonly externalWrite?: true;
  readonly uncertainEffects?: true;
}

export type CapabilityPolicyRiskV1 =
  | 'read'
  | 'plan'
  | 'write_file'
  | 'execute_code'
  | 'destructive'
  | 'network'
  | 'vcs_mutation'
  | 'mcp'
  | 'unknown';

/**
 * Typed, provider-neutral recovery facts emitted by a Builtin policy owner.
 * `capabilityIntent` is an opaque capability identifier; App/Host layers may
 * project it into result metadata without selecting an executor.
 */
export interface CapabilityPolicyRecoveryV1 {
  readonly disposition: 'never' | 'retry' | 'defer' | 'redirect';
  readonly maximumAdditionalCalls: number;
  readonly safeAutomaticRetry: boolean;
  readonly capabilityIntent?: string;
}

export const CAPABILITY_POLICY_COMPILATION_SCHEMA_V1 =
  'kite.capability-policy-compilation.v1' as const;

/**
 * Tool-specific facts compiled by the Builtin operation owner.  This DTO is
 * deliberately independent of authorization state: `fullAccessMayBypassApproval`
 * and `sameCommandMayBypassApproval` are eligibility facts only.  The Kernel
 * remains the sole owner of mode, grant matching, and authorization decisions.
 */
export interface CapabilityPolicyCompilationV1 {
  readonly schema: typeof CAPABILITY_POLICY_COMPILATION_SCHEMA_V1;
  readonly operationId: string;
  readonly capabilityRevision: string;
  readonly parserRevision: string;
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly risk: CapabilityPolicyRiskV1;
  readonly effects?: Readonly<CapabilityPolicyEffectsV1>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly phaseConstraint?: 'planning';
  readonly effectiveEffects: CapabilityEffectsV1;
  readonly minimumApproval: CapabilityApprovalV1;
  readonly fullAccessMayBypassApproval: boolean;
  readonly sameCommandMayBypassApproval: boolean;
  /** Optional sandbox admission fact; Kernel governance may require it. */
  readonly requiresSandbox?: boolean;
  /** Optional neutral recovery guidance owned by the capability policy. */
  readonly recovery?: Readonly<CapabilityPolicyRecoveryV1>;
}

/**
 * Context available to a Builtin policy compiler.  It is a mechanically
 * derived, immutable turn projection; no Host, executor, Kernel, Store, or
 * authorization object crosses this seam.
 */
export interface CapabilityPolicyContextV1 extends CapabilityTurnContextV1 {
  readonly workspace: string;
  readonly phase: 'planning' | 'building';
}

export type CapabilityPolicyCompilerV1 = (
  input: RuntimeJsonValueV1,
  context: CapabilityPolicyContextV1,
) => CapabilityPolicyCompilationV1;

export type CapabilityEffectsClassifierV1 = (
  input: RuntimeJsonValueV1,
  context: CapabilityTurnContextV1,
) => CapabilityInvocationEffectsV1;

export type CapabilityApprovalSummaryProjectorV1 = (
  input: RuntimeJsonValueV1,
  context: CapabilityTurnContextV1,
) => string;

export interface CapabilityParseIssueV1 {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type CapabilityParseResultV1<TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1> =
  | { readonly success: true; readonly data: TValue }
  | {
      readonly success: false;
      readonly issues: readonly CapabilityParseIssueV1[];
    };

export interface CapabilityUnknownFieldObservationV1 {
  readonly schemaRevision: string;
  readonly fields: readonly string[];
  readonly count: number;
}

/**
 * Builtin-owned parser/canonicalizer boundary.  Implementations may use Zod
 * or another exact schema engine internally, but callers only receive JSON
 * values and bounded issue metadata.  Unknown field values never cross this
 * boundary.
 */
export interface CapabilityParserV1 {
  readonly parserRevision: string;
  /** Digest of the exact JSON schema consumed by this parser. */
  readonly schemaDigest?: string;
  readonly knownFields: readonly string[];
  parse(value: unknown, context?: CapabilityTurnContextV1): CapabilityParseResultV1;
  canonicalize(value: unknown, context?: CapabilityTurnContextV1): RuntimeJsonValueV1;
  observeUnknownFields(
    value: unknown,
    context?: CapabilityTurnContextV1,
  ): CapabilityUnknownFieldObservationV1;
}

export interface CapabilityExecutionPolicyV1 {
  readonly retry: 'never' | 'safe_read' | 'idempotency_key';
  readonly idempotencyKeyArgument?: string;
}

/** Strict provider-neutral descriptor facts projected by Builtin Runtime. */
export interface CapabilityDescriptorV1 {
  readonly capabilityId: string;
  readonly revision: string;
  readonly kind: CapabilityDescriptorKindV1;
  /** Explicit Builtin mechanism metadata projected from the same definition. */
  readonly executionMechanism?: CapabilityExecutionMechanismV1;
  readonly displayName: string;
  readonly description: string;
  readonly modelDescription?: string;
  readonly descriptionProvenance: 'builtin';
  readonly provider: Readonly<{
    type: 'builtin';
    id: string;
    version?: string;
    provenance: 'builtin';
  }>;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly outputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly declaredEffects: CapabilityEffectsV1;
  readonly effectiveEffects: CapabilityEffectsV1;
  readonly policy: Readonly<{
    workspaceTrustRequired: boolean;
    minimumApproval: CapabilityApprovalV1;
    governanceRevision?: string;
  }>;
  readonly execution?: CapabilityExecutionPolicyV1;
  readonly availability: Exclude<CapabilityAvailabilityDecisionV1['status'], 'hidden'>;
  readonly diagnostics: string[];
}

/** Internal SPI entry metadata; never projected as a persisted model descriptor. */
export interface CapabilityInternalDescriptorV1 extends Omit<CapabilityDescriptorV1, 'kind'> {
  readonly kind: 'internal_runtime';
}

export interface RuntimeModuleManifestV1 {
  readonly moduleId: string;
  readonly providerId: string;
  readonly revision: string;
  readonly contractRevision: typeof RUNTIME_CONTRACT_BOUNDARY_V1.revision;
  /** Exact production operations owned by this module at this registry revision. */
  readonly operationIds: readonly string[];
}

export interface RuntimeModuleV1 {
  readonly manifest: RuntimeModuleManifestV1;
  /** Pure, synchronous declaration only. The scoped writer is sealed on return. */
  register(registry: RuntimeModuleRegistryWriterV1): void;
  /** Readiness must be represented by an execution capability, not module startup. */
  start?(): Promise<void>;
  /** Must settle within the registry lifecycle bound. */
  dispose(): Promise<void>;
}

export interface CapabilityDefinitionV1 {
  readonly capabilityId: string;
  readonly revision: string;
  readonly providerId: string;
  readonly title: string;
  /**
   * Strict Builtin mechanism metadata.  Generic SPI capabilities may omit
   * this field for compatibility; Builtin catalog projection rejects an
   * omitted value, so every RMV1 Builtin operation is explicit.
   */
  readonly executionMechanism?: CapabilityExecutionMechanismV1;
  /** Stable model-facing tool name. Omitted for internal capabilities. */
  readonly toolName?: string;
  /** Stable model-facing description; title remains the required fallback. */
  readonly description?: string;
  /** Whether this capability is eligible for the model-visible projection. */
  readonly visibility?: CapabilityVisibilityV1;
  /** Conservative static effect facts for catalog and scheduler projection. */
  readonly effects?: CapabilityEffectsV1;
  /** Builtin-owned provider-neutral descriptor category. */
  readonly kind?: CapabilityKindV1;
  /** Prompt-contract-v2 description derived from the same Builtin contract. */
  readonly modelDescription?: string;
  /** Exact Builtin parser/canonicalizer; no caller-supplied schema is accepted. */
  readonly parser?: CapabilityParserV1;
  /** Model-only parser for phase/visibility-specific input (for example task). */
  readonly modelParser?: CapabilityParserV1;
  /** Model-only JSON schema; it must not include private runtime branches. */
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  /** Context-selected model schema for planning/public projection differences. */
  readonly modelInputSchemaForContext?: (
    context: CapabilityTurnContextV1,
  ) => Readonly<Record<string, RuntimeJsonValueV1>>;
  /** Typed immutable turn gating owned by the Builtin definition. */
  readonly availability?: CapabilityAvailabilityResolverV1;
  /** Per-invocation classification owned by the Builtin definition. */
  readonly effectsClassifier?: CapabilityEffectsClassifierV1;
  /** User-visible approval identity projected by the Builtin owner. */
  readonly approvalSummary?: CapabilityApprovalSummaryProjectorV1;
  readonly executionTraitsDeclaration?: CapabilityExecutionTraitsDeclarationV1;
  readonly executionTraitsProjector?: CapabilityExecutionTraitsProjectorV1;
  readonly minimumApproval?: CapabilityApprovalV1;
  readonly workspaceTrustRequired?: boolean;
  readonly governanceRevision?: string;
  readonly execution?: CapabilityExecutionPolicyV1;
  /** Strict descriptor projection; its revision may be a content revision distinct from operation revision. */
  readonly descriptor?: CapabilityDescriptorV1 | CapabilityInternalDescriptorV1;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly outputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  /** Optional exact digest used by the immutable arbitrator. */
  readonly inputSchemaDigest?: string;
  /** Builtin-owned operation policy facts; never contains authorization state. */
  readonly policyCompiler?: CapabilityPolicyCompilerV1;
}

/** Exact RMV1/State 25 turn-scoped binding shape. */
export interface CapabilityBindingV1 {
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly schemaDigest: string;
  readonly issuedForTurnId: string;
}

export interface CapabilityDisclosureV1 {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly issuedForTurnId: string;
}

/** A model request remains an untrusted proposal until Policy authorizes it. */
export interface CapabilityRequestProposalV1<
  TInput extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly proposalId: string;
  readonly binding: CapabilityBindingV1;
  readonly input: TInput;
}

export interface CapabilityIntentV1 {
  readonly intentId: string;
  readonly proposalId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly requestDigest: string;
}

/** RMV1 authorization carrier; cryptographic sealing remains a RAV1 concern. */
export interface CapabilityAuthorizedEffectV1 {
  readonly intent: CapabilityIntentV1;
  readonly grant: ExecutionGrantV1;
}

export interface ExecutionRequestV1<TInput extends RuntimeJsonValueV1 = RuntimeJsonValueV1> {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly input: TInput;
  /** Frozen non-authority facts projected for this exact request. */
  readonly facts?: RuntimeJsonValueV1;
}

/** RMV1 transport DTO. Authority/identity sealing remains deferred to RAV1. */
export interface ExecutionGrantV1 {
  readonly grantId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly authority: Readonly<Record<string, RuntimeJsonValueV1>>;
}

export interface ExecutionEnvironmentRefV1 {
  readonly environmentId: string;
  readonly kind: string;
  /**
   * Trusted in-process mechanism handles for this selected environment.
   * They are neither persisted authority nor another Runtime Provider.
   */
  readonly mechanisms?: Readonly<Record<string, unknown>>;
}

export interface EffectAttemptIdentityV1 {
  readonly invocationId: string;
  readonly attemptId: string;
}

export interface CapabilityExecutionContextV1 {
  readonly grant: ExecutionGrantV1;
  readonly requestDigest: string;
  readonly signal: AbortSignal;
  readonly environment: ExecutionEnvironmentRefV1;
  readonly attempt: EffectAttemptIdentityV1;
}

export interface ClassifiedProviderFailureV1 {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecutionReceiptV1<TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1> {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly executorRevision: string;
  readonly requestDigest: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
  readonly dispatchCertainty: 'none' | 'attempted' | 'unknown';
  readonly cleanupCertainty: 'not_required' | 'confirmed' | 'unknown';
  readonly failure?: ClassifiedProviderFailureV1;
  readonly value?: TValue;
  readonly diagnostics?: readonly string[];
}

/**
 * Generic in-process invocation accepted by the Host-owned registry port.
 * Policy has already authorized the request; the Host only checks identity,
 * claims the exact attempt once, materializes the execution context, and
 * invokes the registry-selected executor.
 */
export interface CapabilityExecutionInvocationV1<
  TInput extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly binding: CapabilityBindingV1;
  readonly request: ExecutionRequestV1<TInput>;
  readonly grant: ExecutionGrantV1;
  readonly requestDigest: string;
  readonly environment: ExecutionEnvironmentRefV1;
  readonly attempt: EffectAttemptIdentityV1;
  readonly signal: AbortSignal;
}

export interface CapabilityExecutionPortV1 {
  invoke(invocation: CapabilityExecutionInvocationV1): Promise<ExecutionReceiptV1>;
}

export interface CapabilityExecutorV1<
  TInput extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly providerId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string;
  execute(
    request: ExecutionRequestV1<TInput>,
    context: CapabilityExecutionContextV1,
  ): Promise<ExecutionReceiptV1<TValue>>;
}

export interface ContextSourceRequestV1 {
  readonly sessionId: string;
  readonly purpose: string;
  readonly committedFacts: Readonly<Record<string, RuntimeJsonValueV1>>;
}

export interface ContextFragmentCandidateV1 {
  readonly fragmentId: string;
  readonly kind: string;
  readonly authority: 'runtime' | 'project' | 'user' | 'external';
  readonly content: RuntimeJsonValueV1;
  readonly tokenEstimate: number;
  readonly disclosure: 'always' | 'selected' | 'on_demand';
}

export interface ContextSourceV1 {
  readonly sourceId: string;
  readonly revision: string;
  readonly providerId: string;
  collect(request: ContextSourceRequestV1): readonly ContextFragmentCandidateV1[];
}

export interface ContextCompilerRequestV1 {
  readonly purpose: string;
  readonly tokenBudget: number;
  readonly candidates: readonly ContextFragmentCandidateV1[];
}

export interface CompiledContextV1 {
  readonly selectedFragmentIds: readonly string[];
  readonly payload: RuntimeJsonValueV1;
}

export interface ContextCompilerPortV1 {
  readonly compilerId: string;
  readonly revision: string;
  compile(request: ContextCompilerRequestV1): Promise<CompiledContextV1>;
}

export interface RuntimeReceiptNormalizerV1 {
  readonly normalizerId: string;
  readonly revision: string;
  normalize(receipt: ExecutionReceiptV1): ExecutionReceiptV1;
}

export interface RuntimeExecutionAdapterRegistrationV1<TContext = unknown, TAdapter = unknown> {
  readonly adapterId: string;
  readonly revision: string;
  create(context: TContext): TAdapter;
}

export interface RuntimeModuleRegistryWriterV1 {
  registerCapability(definition: CapabilityDefinitionV1): void;
  registerExecutor(executor: CapabilityExecutorV1): void;
  registerContextSource(source: ContextSourceV1): void;
  registerReceiptNormalizer(normalizer: RuntimeReceiptNormalizerV1): void;
  registerExecutionAdapter<TContext, TAdapter>(
    adapter: RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter>,
  ): void;
}

export function defineRuntimeModuleV1(input: {
  readonly moduleId: string;
  readonly providerId?: string;
  readonly revision: string;
  readonly operationIds?: readonly string[];
  readonly register?: (registry: RuntimeModuleRegistryWriterV1) => void;
  readonly start?: () => Promise<void>;
  readonly dispose?: () => Promise<void>;
}): RuntimeModuleV1 {
  const moduleId = normalizeRuntimeIdentifierV1('runtime module id', input.moduleId);
  const providerId = normalizeRuntimeIdentifierV1(
    'runtime provider id',
    input.providerId ?? moduleId,
  );
  const revision = normalizeRuntimeIdentifierV1('runtime module revision', input.revision);
  const operationIds = Object.freeze(
    (input.operationIds ?? []).map((operationId) =>
      normalizeRuntimeIdentifierV1('runtime operation id', operationId),
    ),
  );
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error(`duplicate runtime operation in module ${moduleId}`);
  }
  const manifest: RuntimeModuleManifestV1 = Object.freeze({
    moduleId,
    providerId,
    revision,
    contractRevision: RUNTIME_CONTRACT_BOUNDARY_V1.revision,
    operationIds,
  });
  return Object.freeze({
    manifest,
    register: input.register ?? (() => undefined),
    ...(input.start ? { start: input.start } : {}),
    dispose: input.dispose ?? (() => Promise.resolve()),
  });
}

export function normalizeRuntimeIdentifierV1(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (normalized !== value) throw new Error(`${label} must be canonical: ${value}`);
  return normalized;
}
