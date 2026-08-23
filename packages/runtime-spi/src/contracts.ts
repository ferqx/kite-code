import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite/runtime-contract';

export type RuntimeJsonScalar = string | number | boolean | null;
export type RuntimeJsonValue =
  | RuntimeJsonScalar
  | readonly RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };

/**
 * Static effects declared by a capability owner.
 *
 * This is deliberately a small, provider-neutral value object.  Runtime
 * policy may tighten these facts for an invocation, but a model-facing
 * projection must never invent a less conservative effect profile.
 */
export type CapabilityEffectLevel = 'none' | 'read' | 'write' | 'destructive' | 'unknown';

export interface CapabilityEffects {
  readonly filesystem: CapabilityEffectLevel;
  readonly network: CapabilityEffectLevel;
  readonly externalState: CapabilityEffectLevel;
}

export type CapabilityVisibility = 'model' | 'internal';

/**
 * Stable Builtin execution-mechanism metadata.  This is descriptive routing
 * identity only; it never selects an executor or grants execution authority.
 */
export const CAPABILITY_EXECUTION_MECHANISMS_ = Object.freeze([
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

export type CapabilityExecutionMechanism = (typeof CAPABILITY_EXECUTION_MECHANISMS_)[number];

/**
 * Compile-time-neutral resource identity used by the deterministic Kernel
 * scheduler.  The SPI intentionally does not import the Kernel package;
 * composition roots may project this value into the Kernel's equivalent DTO.
 */
export interface CapabilityResourceScope {
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

export interface CapabilityExecutionTraits {
  readonly resourceScopes: readonly CapabilityResourceScope[];
  readonly access: 'read' | 'write' | 'unknown';
  readonly conflictKeys: readonly string[];
  readonly isolation: 'shared' | 'exclusive_workspace' | 'worktree';
  readonly causalGroup: string;
  readonly interactionBarrier: boolean;
  readonly concurrencyGroup?: string;
  readonly leaseFenceRequired: boolean;
}

/** Static declaration facts only; invocation identity/access are projected later. */
export interface CapabilityExecutionTraitsDeclaration {
  readonly resourceScopes: readonly CapabilityResourceScope[];
  readonly conflictKeys?: readonly string[];
  readonly isolation?: 'shared' | 'exclusive_workspace' | 'worktree';
  readonly interactionBarrier: boolean;
  readonly concurrencyGroup?: string;
  readonly leaseFenceRequired: boolean;
}

export type CapabilityExecutionTraitsProjector = (
  input: RuntimeJsonValue,
  context: CapabilityTurnContext,
  effects: CapabilityInvocationEffects,
) => CapabilityExecutionTraits;

export type CapabilityApproval = 'none' | 'auto_review' | 'user';

export type CapabilityKind =
  | 'computer'
  | 'coordination'
  | 'runtime_action'
  | 'interrupt'
  | 'internal_runtime';

export type CapabilityToolKind = Exclude<CapabilityKind, 'internal_runtime'>;

export type CapabilityDescriptorKind = 'builtin_tool';

/** Feature facts consumed by registered Builtin callbacks; unrelated App flags never enter SPI. */
export interface CapabilityFeatureFlags {
  readonly promptContract?: boolean;
  readonly brokeredGit?: boolean;
  readonly skillWorkflow?: boolean;
  readonly skillActivation?: boolean;
}

/** Immutable facts available to a Builtin availability/effects callback. */
export interface CapabilityTurnContext {
  readonly workspace?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly activeTaskId?: string;
  readonly modelMessageId?: string;
  readonly toolCallId?: string;
  readonly phase?: 'planning' | 'building';
  readonly promptContract?: boolean;
  readonly brokeredGitFeatureRevision?: string | null;
  readonly hasTaskAdapter?: boolean;
  readonly hasGitBroker?: boolean;
  readonly toolSearchEnabled?: boolean;
  readonly activeSkillFrameIds?: readonly string[];
  readonly availableSkillIds?: readonly string[];
  readonly workspaceTrust?: 'trusted' | 'untrusted' | 'unknown';
  readonly featureFlags?: Readonly<CapabilityFeatureFlags>;
}

/**
 * Canonical availability context passed through the Core Pipeline.  This is
 * an SPI context projection only: it carries turn facts and never schemas,
 * effects, availability decisions, or executor handles.
 */
export interface CapabilityAvailabilityContext extends CapabilityTurnContext {
  readonly workspace: string;
  readonly interactionMode?: import('@kite/runtime-contract').InteractionMode;
}

export interface CapabilityAvailabilityDecision {
  readonly status: 'available' | 'degraded' | 'unavailable' | 'quarantined' | 'hidden';
  readonly reason?: string;
  readonly diagnostics?: readonly string[];
}

export type CapabilityAvailabilityResolver = (
  context: CapabilityTurnContext,
) => CapabilityAvailabilityDecision;

export type CapabilityEffectClass =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export type CapabilityRiskClass =
  | 'read'
  | 'plan'
  | 'workspace_write'
  | 'execute'
  | 'network'
  | 'external_state'
  | 'destructive'
  | 'unknown';

export interface CapabilityInvocationEffects {
  readonly effectClass: CapabilityEffectClass;
  readonly sideEffect: boolean;
  readonly classificationReason: string;
  readonly risk: CapabilityRiskClass;
  /** Runtime may only tighten these declared facts for one invocation. */
  readonly effectiveEffects: CapabilityEffects;
}

/**
 * The small additive effect facts consumed by the pure Kernel governance
 * decision.  These flags intentionally describe effects in addition to the
 * primary capability effect profile; they are not authorization or grant
 * decisions.
 */
export interface CapabilityPolicyEffects {
  readonly network?: true;
  readonly externalRead?: true;
  readonly externalWrite?: true;
  readonly uncertainEffects?: true;
}

export type CapabilityPolicyRisk =
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
export interface CapabilityPolicyRecovery {
  readonly disposition: 'never' | 'retry' | 'defer' | 'redirect';
  readonly maximumAdditionalCalls: number;
  readonly safeAutomaticRetry: boolean;
  readonly capabilityIntent?: string;
}

export const CAPABILITY_POLICY_COMPILATION_SCHEMA_ =
  'kite.capability-policy-compilation.v1' as const;

/**
 * Tool-specific facts compiled by the Builtin operation owner.  This DTO is
 * deliberately independent of authorization state: `fullAccessMayBypassApproval`
 * and `sameCommandMayBypassApproval` are eligibility facts only.  The Kernel
 * remains the sole owner of mode, grant matching, and authorization decisions.
 */
export interface CapabilityPolicyCompilation {
  readonly schema: typeof CAPABILITY_POLICY_COMPILATION_SCHEMA_;
  readonly operationId: string;
  readonly capabilityRevision: string;
  readonly parserRevision: string;
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly risk: CapabilityPolicyRisk;
  readonly effects?: Readonly<CapabilityPolicyEffects>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly phaseConstraint?: 'planning';
  readonly effectiveEffects: CapabilityEffects;
  readonly minimumApproval: CapabilityApproval;
  readonly fullAccessMayBypassApproval: boolean;
  readonly sameCommandMayBypassApproval: boolean;
  /** Optional sandbox admission fact; Kernel governance may require it. */
  readonly requiresSandbox?: boolean;
  /** Optional neutral recovery guidance owned by the capability policy. */
  readonly recovery?: Readonly<CapabilityPolicyRecovery>;
}

/**
 * Context available to a Builtin policy compiler.  It is a mechanically
 * derived, immutable turn projection; no Host, executor, Kernel, Store, or
 * authorization object crosses this seam.
 */
export interface CapabilityPolicyContext extends CapabilityTurnContext {
  readonly workspace: string;
  readonly phase: 'planning' | 'building';
}

export type CapabilityPolicyCompiler = (
  input: RuntimeJsonValue,
  context: CapabilityPolicyContext,
) => CapabilityPolicyCompilation;

export type CapabilityEffectsClassifier = (
  input: RuntimeJsonValue,
  context: CapabilityTurnContext,
) => CapabilityInvocationEffects;

export type CapabilityApprovalSummaryProjector = (
  input: RuntimeJsonValue,
  context: CapabilityTurnContext,
) => string;

export interface CapabilityParseIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type CapabilityParseResult<TValue extends RuntimeJsonValue = RuntimeJsonValue> =
  | { readonly success: true; readonly data: TValue }
  | {
      readonly success: false;
      readonly issues: readonly CapabilityParseIssue[];
    };

export interface CapabilityUnknownFieldObservation {
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
export interface CapabilityParser {
  readonly parserRevision: string;
  /** Digest of the exact JSON schema consumed by this parser. */
  readonly schemaDigest?: string;
  readonly knownFields: readonly string[];
  parse(value: unknown, context?: CapabilityTurnContext): CapabilityParseResult;
  canonicalize(value: unknown, context?: CapabilityTurnContext): RuntimeJsonValue;
  observeUnknownFields(
    value: unknown,
    context?: CapabilityTurnContext,
  ): CapabilityUnknownFieldObservation;
}

export interface CapabilityExecutionPolicy {
  readonly retry: 'never' | 'safe_read' | 'idempotency_key';
  readonly idempotencyKeyArgument?: string;
}

/** Strict provider-neutral descriptor facts projected by Builtin Runtime. */
export interface CapabilityDescriptor {
  readonly capabilityId: string;
  readonly revision: string;
  readonly kind: CapabilityDescriptorKind;
  /** Explicit Builtin mechanism metadata projected from the same definition. */
  readonly executionMechanism?: CapabilityExecutionMechanism;
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
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  readonly outputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  readonly declaredEffects: CapabilityEffects;
  readonly effectiveEffects: CapabilityEffects;
  readonly policy: Readonly<{
    workspaceTrustRequired: boolean;
    minimumApproval: CapabilityApproval;
    governanceRevision?: string;
  }>;
  readonly execution?: CapabilityExecutionPolicy;
  readonly availability: Exclude<CapabilityAvailabilityDecision['status'], 'hidden'>;
  readonly diagnostics: string[];
}

/** Internal SPI entry metadata; never projected as a persisted model descriptor. */
export interface CapabilityInternalDescriptor extends Omit<CapabilityDescriptor, 'kind'> {
  readonly kind: 'internal_runtime';
}

export interface RuntimeModuleManifest {
  readonly moduleId: string;
  readonly providerId: string;
  readonly revision: string;
  readonly contractRevision: typeof RUNTIME_CONTRACT_BOUNDARY_.revision;
  /** Exact production operations owned by this module at this registry revision. */
  readonly operationIds: readonly string[];
}

export interface RuntimeModule {
  readonly manifest: RuntimeModuleManifest;
  /** Pure, synchronous declaration only. The scoped writer is sealed on return. */
  register(registry: RuntimeModuleRegistryWriter): void;
  /** Readiness must be represented by an execution capability, not module startup. */
  start?(): Promise<void>;
  /** Must settle within the registry lifecycle bound. */
  dispose(): Promise<void>;
}

export interface CapabilityDefinition {
  readonly capabilityId: string;
  readonly revision: string;
  readonly providerId: string;
  readonly title: string;
  /**
   * Strict Builtin mechanism metadata.  Generic SPI capabilities may omit
   * this field for compatibility; Builtin catalog projection rejects an
   * omitted value, so every RM Builtin operation is explicit.
   */
  readonly executionMechanism?: CapabilityExecutionMechanism;
  /** Stable model-facing tool name. Omitted for internal capabilities. */
  readonly toolName?: string;
  /** Stable model-facing description; title remains the required fallback. */
  readonly description?: string;
  /** Whether this capability is eligible for the model-visible projection. */
  readonly visibility?: CapabilityVisibility;
  /** Conservative static effect facts for catalog and scheduler projection. */
  readonly effects?: CapabilityEffects;
  /** Builtin-owned provider-neutral descriptor category. */
  readonly kind?: CapabilityKind;
  /** Prompt-contract-v2 description derived from the same Builtin contract. */
  readonly modelDescription?: string;
  /** Exact Builtin parser/canonicalizer; no caller-supplied schema is accepted. */
  readonly parser?: CapabilityParser;
  /** Model-only parser for phase/visibility-specific input (for example task). */
  readonly modelParser?: CapabilityParser;
  /** Model-only JSON schema; it must not include private runtime branches. */
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  /** Context-selected model schema for planning/public projection differences. */
  readonly modelInputSchemaForContext?: (
    context: CapabilityTurnContext,
  ) => Readonly<Record<string, RuntimeJsonValue>>;
  /** Typed immutable turn gating owned by the Builtin definition. */
  readonly availability?: CapabilityAvailabilityResolver;
  /** Per-invocation classification owned by the Builtin definition. */
  readonly effectsClassifier?: CapabilityEffectsClassifier;
  /** User-visible approval identity projected by the Builtin owner. */
  readonly approvalSummary?: CapabilityApprovalSummaryProjector;
  readonly executionTraitsDeclaration?: CapabilityExecutionTraitsDeclaration;
  readonly executionTraitsProjector?: CapabilityExecutionTraitsProjector;
  readonly minimumApproval?: CapabilityApproval;
  readonly workspaceTrustRequired?: boolean;
  readonly governanceRevision?: string;
  readonly execution?: CapabilityExecutionPolicy;
  /** Strict descriptor projection; its revision may be a content revision distinct from operation revision. */
  readonly descriptor?: CapabilityDescriptor | CapabilityInternalDescriptor;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  readonly outputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  /** Optional exact digest used by the immutable arbitrator. */
  readonly inputSchemaDigest?: string;
  /** Builtin-owned operation policy facts; never contains authorization state. */
  readonly policyCompiler?: CapabilityPolicyCompiler;
}

/** Exact RM/State 25 turn-scoped binding shape. */
export interface CapabilityBinding {
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly schemaDigest: string;
  readonly issuedForTurnId: string;
}

export interface CapabilityDisclosure {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly issuedForTurnId: string;
}

/** A model request remains an untrusted proposal until Policy authorizes it. */
export interface CapabilityRequestProposal<TInput extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly proposalId: string;
  readonly binding: CapabilityBinding;
  readonly input: TInput;
}

export interface CapabilityIntent {
  readonly intentId: string;
  readonly proposalId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly requestDigest: string;
}

/** RM authorization carrier with exact structural identity. */
export interface CapabilityAuthorizedEffect {
  readonly intent: CapabilityIntent;
  readonly grant: ExecutionGrant;
}

export interface ExecutionRequest<TInput extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly input: TInput;
  /** Frozen non-authority facts projected for this exact request. */
  readonly facts?: RuntimeJsonValue;
}

/** RM transport DTO with exact structural identity. */
export interface ExecutionGrant {
  readonly grantId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly authority: Readonly<Record<string, RuntimeJsonValue>>;
}

export interface ExecutionEnvironmentRef {
  readonly environmentId: string;
  readonly kind: string;
  /**
   * Trusted in-process mechanism handles for this selected environment.
   * They are neither persisted authority nor another Runtime Provider.
   */
  readonly mechanisms?: Readonly<Record<string, unknown>>;
}

export interface EffectAttemptIdentity {
  readonly invocationId: string;
  readonly attemptId: string;
}

export interface CapabilityExecutionContext {
  readonly grant: ExecutionGrant;
  readonly requestDigest: string;
  readonly signal: AbortSignal;
  readonly environment: ExecutionEnvironmentRef;
  readonly attempt: EffectAttemptIdentity;
}

export interface ClassifiedProviderFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecutionReceipt<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly executorRevision: string;
  readonly requestDigest: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
  readonly dispatchCertainty: 'none' | 'attempted' | 'unknown';
  readonly cleanupCertainty: 'not_required' | 'confirmed' | 'unknown';
  readonly failure?: ClassifiedProviderFailure;
  readonly value?: TValue;
  readonly diagnostics?: readonly string[];
}

/**
 * Generic in-process invocation accepted by the Host-owned registry port.
 * Policy has already authorized the request; the Host only checks identity,
 * claims the exact attempt once, materializes the execution context, and
 * invokes the registry-selected executor.
 */
export interface CapabilityExecutionInvocation<TInput extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly binding: CapabilityBinding;
  readonly request: ExecutionRequest<TInput>;
  readonly grant: ExecutionGrant;
  readonly requestDigest: string;
  readonly environment: ExecutionEnvironmentRef;
  readonly attempt: EffectAttemptIdentity;
  readonly signal: AbortSignal;
}

export interface CapabilityExecutionPort {
  invoke(invocation: CapabilityExecutionInvocation): Promise<ExecutionReceipt>;
}

export interface CapabilityExecutor<
  TInput extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly providerId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string;
  execute(
    request: ExecutionRequest<TInput>,
    context: CapabilityExecutionContext,
  ): Promise<ExecutionReceipt<TValue>>;
}

export interface ContextSourceRequest {
  readonly sessionId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly committedFacts: Readonly<Record<string, RuntimeJsonValue>>;
}

export interface ContextFragmentCandidate {
  readonly fragmentId: string;
  readonly kind: string;
  readonly authority: 'runtime' | 'project' | 'user' | 'external';
  readonly content: RuntimeJsonValue;
  readonly tokenEstimate: number;
  readonly disclosure: 'always' | 'selected' | 'on_demand';
}

export interface ContextSource {
  readonly sourceId: string;
  readonly revision: string;
  readonly providerId: string;
  collect(request: ContextSourceRequest): readonly ContextFragmentCandidate[];
}

export interface ContextCompilerRequest {
  readonly purpose: string;
  readonly tokenBudget: number;
  readonly candidates: readonly ContextFragmentCandidate[];
}

export interface CompiledContext {
  readonly selectedFragmentIds: readonly string[];
  readonly payload: RuntimeJsonValue;
}

export interface ContextCompilerPort {
  readonly compilerId: string;
  readonly revision: string;
  compile(request: ContextCompilerRequest): Promise<CompiledContext>;
}

export interface RuntimeReceiptNormalizer {
  readonly normalizerId: string;
  readonly revision: string;
  normalize(receipt: ExecutionReceipt): ExecutionReceipt;
}

export interface RuntimeExecutionAdapterRegistration<TContext = unknown, TAdapter = unknown> {
  readonly adapterId: string;
  readonly revision: string;
  create(context: TContext): TAdapter;
}

export interface RuntimeModuleRegistryWriter {
  registerCapability(definition: CapabilityDefinition): void;
  registerExecutor(executor: CapabilityExecutor): void;
  registerContextSource(source: ContextSource): void;
  registerReceiptNormalizer(normalizer: RuntimeReceiptNormalizer): void;
  registerExecutionAdapter<TContext, TAdapter>(
    adapter: RuntimeExecutionAdapterRegistration<TContext, TAdapter>,
  ): void;
}

export function defineRuntimeModule(input: {
  readonly moduleId: string;
  readonly providerId?: string;
  readonly revision: string;
  readonly operationIds?: readonly string[];
  readonly register?: (registry: RuntimeModuleRegistryWriter) => void;
  readonly start?: () => Promise<void>;
  readonly dispose?: () => Promise<void>;
}): RuntimeModule {
  const moduleId = normalizeRuntimeIdentifier('runtime module id', input.moduleId);
  const providerId = normalizeRuntimeIdentifier(
    'runtime provider id',
    input.providerId ?? moduleId,
  );
  const revision = normalizeRuntimeIdentifier('runtime module revision', input.revision);
  const operationIds = Object.freeze(
    (input.operationIds ?? []).map((operationId) =>
      normalizeRuntimeIdentifier('runtime operation id', operationId),
    ),
  );
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error(`duplicate runtime operation in module ${moduleId}`);
  }
  const manifest: RuntimeModuleManifest = Object.freeze({
    moduleId,
    providerId,
    revision,
    contractRevision: RUNTIME_CONTRACT_BOUNDARY_.revision,
    operationIds,
  });
  return Object.freeze({
    manifest,
    register: input.register ?? (() => undefined),
    ...(input.start ? { start: input.start } : {}),
    dispose: input.dispose ?? (() => Promise.resolve()),
  });
}

export function normalizeRuntimeIdentifier(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (normalized !== value) throw new Error(`${label} must be canonical: ${value}`);
  return normalized;
}
