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
  /** This exact external access needs mode-aware Full/Auto/user authorization. */
  readonly sensitiveExternalAccess?: true;
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
