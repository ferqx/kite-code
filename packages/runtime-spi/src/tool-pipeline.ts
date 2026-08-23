import type {
  CapabilityBinding as RuntimeCapabilityBinding,
  CapabilityDescriptor as RuntimeCapabilityDescriptor,
  CapabilityDisclosure as RuntimeCapabilityDisclosure,
  ToolApprovalPayload,
} from '@kite/runtime-contract';
import type {
  CapabilityApproval,
  CapabilityAvailabilityContext,
  CapabilityBinding,
  CapabilityDescriptor,
  CapabilityEffectClass,
  CapabilityEffects,
  CapabilityExecutionMechanism,
  CapabilityExecutionTraits,
  CapabilityInternalDescriptor,
  CapabilityPolicyCompilation,
  CapabilityRiskClass,
  CapabilityToolKind,
  RuntimeJsonValue,
} from './contracts';
import type { PrivateSuspendedSubagentRecord } from './subagent';

/** Stable stage envelope shared by the pure pipeline contract. */
export const TOOL_PIPELINE_STAGE_SCHEMA_ = 'kite.tool-pipeline-stage.v1' as const;

export type ToolPipelineStage = 'snapshot' | 'resolve' | 'validate' | 'classify' | 'recorded';

/** Pipeline arguments are the same canonical, provider-neutral JSON values as SPI. */
export type CanonicalToolArgumentValue = RuntimeJsonValue;

/** Dynamic descriptors and bindings retain their runtime-contract shape. */
export type ToolPipelineCapabilityDescriptor =
  | Readonly<CapabilityDescriptor>
  | Readonly<CapabilityInternalDescriptor>
  | Readonly<RuntimeCapabilityDescriptor>;

export type ToolPipelineCapabilityBinding =
  | Readonly<CapabilityBinding>
  | Readonly<RuntimeCapabilityBinding>;

export type ToolPipelineCapabilityDisclosure =
  | Readonly<import('./contracts').CapabilityDisclosure>
  | Readonly<RuntimeCapabilityDisclosure>;

export type ToolExecutionFamily = 'builtin' | 'mcp' | 'skill' | 'subagent';

/** Explicit provenance prevents private Runtime DTOs from being inferred from fields alone. */
export type ToolArgumentOrigin = 'model_public' | 'runtime_private';

/**
 * Operation identity after the owning resolver has proven it is not the
 * internal dynamic MCP wrapper.  The brand prevents that wrapper literal from
 * being assigned to the non-dynamic target branch without a runtime helper or
 * a second authority in SPI.
 */
declare const nonDynamicOperationIdBrand: unique symbol;
export type NonDynamicOperationId = string & {
  readonly [nonDynamicOperationIdBrand]: 'validated_non_dynamic_operation';
};

/** Model visibility is deliberately a discriminated identity, not a name convention. */
export type ToolPipelineVisibilityIdentity =
  | {
      readonly visibility: 'model';
      readonly modelVisible: true;
      readonly exposedToolName: string;
    }
  | {
      readonly visibility: 'internal';
      readonly modelVisible: false;
      readonly exposedToolName: null;
    };

/** A dynamic MCP subject name is never the internal wrapper operation name. */
export type DynamicMcpExposedToolName = `mcp__${string}`;

/** The real MCP subject carried alongside the internal runtime wrapper. */
export interface DynamicMcpSubjectIdentity {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly providerId: string;
  readonly exposedToolName: DynamicMcpExposedToolName;
  readonly dynamicCatalogRevision: string;
  readonly bindingId: string | null;
}

/**
 * The private runtime operation used to reach an MCP subject.  This carrier is
 * identity data only; it contains no registry, callback, or executor object.
 */
export interface DynamicMcpRuntimeWrapperIdentity {
  readonly operationId: 'mcp:dynamic_tool';
  readonly capabilityId: 'mcp:dynamic_tool';
  readonly providerId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string;
  readonly schemaDigest: string;
  readonly builtinProjectionRevision: string;
}

/** The two catalog identities are intentionally independent fields. */
export interface ToolPipelineCatalogRevisions {
  readonly builtinProjectionRevision: string | null;
  readonly dynamicCatalogRevision: string | null;
}

export interface ToolCallSnapshot {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly stage: 'snapshot';
  readonly toolCallId: string;
  readonly name: string;
  readonly rawArguments: CanonicalToolArgumentValue;
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly createdAtTurnId: string;
  readonly modelMessageId: string;
  readonly bindingId: string | null;
  readonly capabilityId: string | null;
  readonly capabilityRevision: string | null;
}

/**
 * Facts captured before pure resolution.  A Builtin catalog object, provider
 * handle, authorization state, and policy implementation are intentionally
 * absent; only their immutable identities may cross this boundary.
 */
export interface ToolPipelineResolutionContext extends ToolPipelineCatalogRevisions {
  readonly currentTurnId: string;
  readonly availabilityContext: Readonly<CapabilityAvailabilityContext>;
  readonly bindings: readonly ToolPipelineCapabilityBinding[];
  readonly descriptors: readonly ToolPipelineCapabilityDescriptor[];
  readonly disclosures?: readonly ToolPipelineCapabilityDisclosure[];
}

/**
 * For a dynamic MCP target these top-level descriptor fields identify the
 * real MCP subject. The internal Builtin wrapper has its own exact carrier.
 */
type ResolvedToolTargetCommon = {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly providerId: string;
  readonly executorRevision: string | null;
  readonly toolKind: CapabilityToolKind | 'internal_runtime';
  readonly binding: ToolPipelineCapabilityBinding | null;
  readonly descriptor: ToolPipelineCapabilityDescriptor;
};

export type DynamicMcpToolTarget = ResolvedToolTargetCommon & {
  readonly executionFamily: 'mcp';
  readonly executionMechanism: 'mcp';
  readonly operationId: 'mcp:dynamic_tool';
  readonly visibility: 'internal';
  readonly modelVisible: false;
  readonly exposedToolName: null;
  readonly isDynamicMcp: true;
  readonly toolKind: CapabilityToolKind;
  readonly executorRevision: null;
  readonly builtinProjectionRevision: null;
  readonly dynamicCatalogRevision: string;
  readonly subject: Readonly<DynamicMcpSubjectIdentity>;
  readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentity>;
};

export type NonDynamicToolTarget = ResolvedToolTargetCommon & {
  readonly executionFamily: 'builtin' | 'skill' | 'subagent';
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly operationId: NonDynamicOperationId;
  readonly visibility: 'model';
  readonly modelVisible: true;
  readonly exposedToolName: string;
  readonly isDynamicMcp: false;
  readonly toolKind: CapabilityToolKind;
  readonly builtinProjectionRevision: string;
  readonly dynamicCatalogRevision: string | null;
};

export type ResolvedToolTarget = DynamicMcpToolTarget | NonDynamicToolTarget;

export interface ResolvedInvocation {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly stage: 'resolved';
  readonly call: Readonly<ToolCallSnapshot>;
  readonly target: Readonly<ResolvedToolTarget>;
  readonly availabilityContext: Readonly<CapabilityAvailabilityContext>;
  readonly builtinProjectionRevision: string | null;
  readonly dynamicCatalogRevision: string | null;
  readonly disclosedCapabilities: readonly ToolPipelineCapabilityDescriptor[];
  readonly disclosures: readonly ToolPipelineCapabilityDisclosure[];
}

export interface ValidatedToolRequest<TArguments extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly source: ToolExecutionFamily;
  readonly operationId: string;
  readonly name: string;
  readonly arguments: TArguments;
  readonly argumentsDigest: string;
  readonly schemaDigest: string;
  readonly approvalSummary: string;
}

export interface ValidatedNestedCapability {
  readonly descriptor: ToolPipelineCapabilityDescriptor;
  readonly disclosure: ToolPipelineCapabilityDisclosure;
}

export interface ValidatedInvocation<TArguments extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly stage: 'validated';
  readonly resolved: Readonly<ResolvedInvocation>;
  readonly request: Readonly<ValidatedToolRequest<TArguments>>;
  readonly nestedCapability: Readonly<ValidatedNestedCapability> | null;
  /** Domain-specific additions stay JSON data instead of importing a domain owner. */
  readonly domainData?: RuntimeJsonValue;
}

export type ToolPipelineRiskClass = CapabilityRiskClass;

export type ToolPipelineIntentRequirement = 'required_before_dispatch' | 'not_applicable';

export type ToolPipelineReceiptRequirement =
  | 'observation_receipt'
  | 'effect_receipt'
  | 'control_receipt'
  | 'not_applicable';

export type ToolPipelineRetryEligibility =
  | 'none'
  | 'safe_read_candidate'
  | 'idempotency_key_candidate';

export interface ToolInvocationRequirements {
  readonly intent: ToolPipelineIntentRequirement;
  readonly receipt: ToolPipelineReceiptRequirement;
  readonly retry: ToolPipelineRetryEligibility;
  readonly idempotencyKeyArgument: string | null;
  readonly verification: 'after_committed_receipt' | 'not_required_by_classification';
}

/**
 * The policy fact that the Builtin owner compiled for this invocation.  This
 * is intentionally the exact SPI policy compilation type so the Host bridge
 * cannot silently create a second policy schema while mapping facts into the
 * pure Kernel governance DTO.
 */
export type ToolPipelineGovernancePolicyProjection = Readonly<CapabilityPolicyCompilation>;

/**
 * Neutral invocation facts consumed by the State 25 governance bridge.  The
 * fields mirror the Kernel's identity facts without importing that package;
 * the two catalog revisions remain independent throughout the projection.
 */
type ToolPipelineGovernanceInvocationProjectionCommon = {
  readonly turnId: string;
  readonly modelMessageId: string;
  readonly toolCallId: string;
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly executionFamily: ToolExecutionFamily;
  readonly executionMechanism: CapabilityExecutionMechanism;
  /** Model-facing name; dynamic MCP uses its real subject name here. */
  readonly exposedToolName: string;
  /** Dynamic MCP keeps the real subject capability while operation is its wrapper. */
  readonly operationId: string;
  readonly capabilityId: string;
  readonly providerId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string | null;
  readonly descriptorRevision: string;
  readonly parserRevision: string;
  readonly schemaDigest: string;
  readonly argumentsDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly bindingId: string | null;
  readonly nestedCapabilityId: string | null;
  readonly nestedCapabilityRevision: string | null;
  readonly nestedCatalogRevision: string | null;
  readonly commandDigest: string | null;
};

/** Ordinary Builtin/Skill/Subagent invocation facts. */
export type ToolPipelineGovernanceOrdinaryInvocationProjection =
  ToolPipelineGovernanceInvocationProjectionCommon & {
    readonly isDynamicMcp: false;
    readonly executionFamily: 'builtin' | 'skill' | 'subagent';
    readonly operationId: NonDynamicOperationId;
    readonly visibility: 'model';
    readonly modelVisible: true;
    readonly builtinProjectionRevision: string;
    /** Only the nested Skill field may carry the MCP/Skill catalog identity. */
    readonly dynamicCatalogRevision: null;
  };

/** Dynamic MCP governance facts preserve subject and wrapper identity separately. */
export type ToolPipelineGovernanceDynamicInvocationProjection =
  ToolPipelineGovernanceInvocationProjectionCommon & {
    readonly isDynamicMcp: true;
    readonly executionFamily: 'mcp';
    readonly executionMechanism: 'mcp';
    readonly operationId: 'mcp:dynamic_tool';
    readonly visibility: 'internal';
    readonly modelVisible: false;
    readonly exposedToolName: DynamicMcpExposedToolName;
    readonly capabilityId: string;
    readonly executorRevision: null;
    readonly builtinProjectionRevision: null;
    readonly dynamicCatalogRevision: string;
    readonly subject: Readonly<DynamicMcpSubjectIdentity>;
    readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentity>;
  };

/** Discriminated invocation projection accepted by the governance bridge. */
export type ToolPipelineGovernanceInvocationProjection =
  | ToolPipelineGovernanceOrdinaryInvocationProjection
  | ToolPipelineGovernanceDynamicInvocationProjection;

export interface ToolPipelineGovernanceDynamicMcpProjection {
  readonly isDynamicMcp: true;
  /** The real provider capability governed by the Kernel. */
  readonly subject: Readonly<DynamicMcpSubjectIdentity>;
  /** The private Builtin operation used to execute that subject. */
  readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentity>;
  readonly minimumApproval: CapabilityApproval;
  readonly readOnly: boolean;
}

/** Short neutral name for callers that do not need the full prefix. */
export type DynamicMcpProjection = ToolPipelineGovernanceDynamicMcpProjection;

/** Nested Skill facts may only accompany the activate_skill operation. */
export interface ToolPipelineGovernanceNestedSkillProjection {
  readonly operationId: 'builtin:activate_skill';
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly nestedCatalogRevision: string;
  readonly decision: CapabilityPolicyCompilation['decision'];
  readonly minimumApproval: CapabilityApproval;
}

export type NestedSkillProjection = ToolPipelineGovernanceNestedSkillProjection;

/**
 * Complete neutral governance projection.  `policy` is the same typed
 * Builtin compilation carried by ClassifiedInvocation; it is not a second
 * policy result or an authorization decision.
 */
export interface ToolPipelineGovernanceProjection {
  readonly invocation: Readonly<ToolPipelineGovernanceInvocationProjection>;
  readonly policy: Readonly<ToolPipelineGovernancePolicyProjection>;
  readonly effectiveEffects: Readonly<CapabilityEffects>;
  readonly effectiveEffectsDigest: string;
  readonly dynamicMcp: Readonly<ToolPipelineGovernanceDynamicMcpProjection> | null;
  readonly nestedSkill: Readonly<ToolPipelineGovernanceNestedSkillProjection> | null;
}

export type ToolPipelineClassifiedIdentityVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code:
        | 'governance_missing'
        | 'invocation_mismatch'
        | 'policy_mismatch'
        | 'catalog_revision_mismatch'
        | 'dynamic_subject_mismatch'
        | 'runtime_wrapper_mismatch'
        | 'nested_skill_mismatch'
        | 'effects_mismatch';
      readonly diagnostic?: string;
    };

/** SPI declaration only; Host/Builtin supplies the identity verifier. */
export type ToolPipelineClassifiedIdentityVerifier<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> = (
  classified: Readonly<ClassifiedInvocation<TArguments>>,
) => boolean | ToolPipelineClassifiedIdentityVerificationResult;

/** Explicit governance-prefixed aliases for composition seams. */
export type ToolPipelineGovernanceIdentityVerificationResult =
  ToolPipelineClassifiedIdentityVerificationResult;
export type ToolPipelineGovernanceIdentityVerifier<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> = ToolPipelineClassifiedIdentityVerifier<TArguments>;

export interface ClassifiedInvocation<TArguments extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly stage: 'classified';
  readonly validated: Readonly<ValidatedInvocation<TArguments>>;
  readonly descriptor: Readonly<ToolPipelineCapabilityDescriptor>;
  readonly policyCompilation: ToolPipelineGovernancePolicyProjection;
  /** Single neutral projection consumed by the Kernel governance bridge. */
  readonly governance: Readonly<ToolPipelineGovernanceProjection>;
  readonly effectClass: CapabilityEffectClass;
  readonly effectiveEffects: Readonly<CapabilityEffects>;
  readonly effectiveEffectsDigest: string;
  readonly risk: ToolPipelineRiskClass;
  readonly sideEffect: boolean;
  readonly minimumApproval: CapabilityApproval;
  readonly executionTraits: Readonly<CapabilityExecutionTraits> | null;
  readonly requirements: Readonly<ToolInvocationRequirements>;
}

export type ToolPipelineSnapshotFailureCode = 'invalid_identity' | 'arguments_not_canonical_json';

export type ToolPipelineResolveFailureCode =
  | 'invalid_stage_input'
  | 'resolution_context_invalid'
  | 'call_turn_mismatch'
  | 'unknown_tool'
  | 'tool_unavailable'
  | 'unexpected_binding'
  | 'binding_missing'
  | 'binding_identity_mismatch'
  | 'binding_turn_mismatch'
  | 'binding_name_mismatch'
  | 'descriptor_missing'
  | 'descriptor_revision_mismatch'
  | 'descriptor_kind_mismatch'
  | 'descriptor_unavailable';

export type ToolPipelineValidateFailureCode =
  | 'invalid_stage_input'
  | 'stage_identity_drift'
  | 'invalid_arguments'
  | 'arguments_not_canonical_json'
  | 'schema_missing'
  | 'schema_digest_mismatch'
  | 'nested_capability_missing'
  | 'nested_capability_invalid'
  | 'disclosure_missing'
  | 'disclosure_stale';

export type ToolPipelineClassifyFailureCode =
  | 'invalid_stage_input'
  | 'stage_identity_drift'
  | 'classification_unavailable';

export type ToolPipelineRecordFailureCode =
  | 'invalid_stage_input'
  | 'identity_mismatch'
  | 'duplicate_attempt'
  | 'persistence_unavailable';

export type ToolPipelineDispatchFailureCode =
  | 'invalid_prepared_input'
  | 'identity_mismatch'
  | 'dispatch_unavailable'
  | 'dispatch_failed'
  | 'acknowledgement_failed'
  | 'unknown_outcome';

export interface ToolPipelineStageFailure<Stage extends ToolPipelineStage, Code extends string> {
  readonly stage: Stage;
  readonly code: Code;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  /** Bounded owner-provided diagnostic; argument values never cross this seam. */
  readonly diagnostic?: string;
}

export type ToolPipelineStageResult<Value, Failure> =
  | { readonly ok: true; readonly value: Readonly<Value> }
  | { readonly ok: false; readonly failure: Readonly<Failure> };

export type ToolCallSnapshotResult = ToolPipelineStageResult<
  ToolCallSnapshot,
  ToolPipelineStageFailure<'snapshot', ToolPipelineSnapshotFailureCode>
>;

export type ToolResolutionResult = ToolPipelineStageResult<
  ResolvedInvocation,
  ToolPipelineStageFailure<'resolve', ToolPipelineResolveFailureCode>
>;

export type ToolValidationResult<TArguments extends RuntimeJsonValue = RuntimeJsonValue> =
  ToolPipelineStageResult<
    ValidatedInvocation<TArguments>,
    ToolPipelineStageFailure<'validate', ToolPipelineValidateFailureCode>
  >;

export type ToolClassificationResult<TArguments extends RuntimeJsonValue = RuntimeJsonValue> =
  ToolPipelineStageResult<
    ClassifiedInvocation<TArguments>,
    ToolPipelineStageFailure<'classify', ToolPipelineClassifyFailureCode>
  >;

export interface ToolRecordedAttemptIdentity {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly providerId: string;
  readonly operationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly parserRevision: string | null;
  readonly executorRevision: string | null;
  readonly argumentsDigest: string;
  readonly schemaDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly builtinProjectionRevision: string | null;
  readonly dynamicCatalogRevision: string | null;
  readonly runtimeWrapperProviderId: string | null;
  readonly runtimeWrapperCapabilityRevision: string | null;
  readonly runtimeWrapperExecutorRevision: string | null;
  readonly runtimeWrapperSchemaDigest: string | null;
  readonly runtimeWrapperBuiltinProjectionRevision: string | null;
  readonly policyDigest: string | null;
  readonly authorizationDigest: string | null;
  readonly admissionDigest: string | null;
  readonly idempotencyKey: string | null;
  readonly recordedAt: string;
  readonly startedAt: string;
}

export interface RecordedInvocation {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly stage: 'recorded';
  readonly identity: Readonly<ToolRecordedAttemptIdentity>;
}

/** Neutral terminal failure; provider and domain details remain bounded JSON. */
export interface CapabilityToolTerminalFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly modelFixable: boolean;
  readonly needsUserIntervention: boolean;
  readonly terminatesTurn: boolean;
  readonly journal: boolean;
  readonly parseFailureCode?: string;
  readonly details?: RuntimeJsonValue;
}

export type CapabilityToolTerminalStatus =
  | 'success'
  | 'partial'
  | 'error'
  | 'cancelled'
  | 'unknown';

/** Neutral terminal result; callers may carry a JSON-safe typed projection. */
export interface CapabilityToolTerminalResult<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly status: CapabilityToolTerminalStatus;
  readonly content: readonly RuntimeJsonValue[];
  readonly structuredContent?: TValue;
  readonly failure?: Readonly<CapabilityToolTerminalFailure>;
  readonly providerMeta?: RuntimeJsonValue;
}

/**
 * The first suspended-dispatch contract is deliberately a single closed
 * interaction event.  `plan` and `artifact` stay opaque JSON because their
 * domain owners live outside SPI; the event's field set and identity remain
 * fixed here so a caller cannot smuggle a Store, State, or callback handle
 * across this boundary.
 */
export interface ToolPipelinePlanReviewRequestedEvent {
  readonly type: 'plan.review_requested';
  readonly interactionId: string;
  readonly toolCallId: string;
  readonly taskId: string;
  readonly plan: RuntimeJsonValue;
  readonly planSummary: string;
  readonly planId: string;
  readonly version: number;
  readonly structuralDigest: string;
  readonly artifact: RuntimeJsonValue;
}

/** The original plan-review suspension remains a closed, exact event branch. */
export interface ToolPipelinePlanReviewSuspension {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly kind: 'plan_review';
  readonly toolCallId: string;
  readonly event: Readonly<ToolPipelinePlanReviewRequestedEvent>;
}

/** Low-information identity for the child tool that blocked a Skill fork. */
export interface ToolPipelineSkillForkBlockedToolIdentity {
  readonly toolCallId: string;
  readonly runtimeToolCallId: string | null;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly commandDigest: string | null;
}

/** Parent identity is repeated explicitly so Host can bind the suspension to its acknowledgement. */
export interface ToolPipelineSkillForkParentIdentity<TToolCallId extends string = string> {
  readonly toolCallId: TToolCallId;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attempt: number;
}

export interface ToolPipelineSkillForkActivationIdentity {
  readonly activationId: string;
  readonly skillId: string;
  readonly skillRevision: string;
  readonly taskId: string;
  readonly contextMode: 'fork';
}

/** State's exact approval.requested payload; its approval hash binds the blocked child tool. */
export interface ToolPipelineSkillForkApprovalRequestedEvent<TToolCallId extends string = string> {
  readonly type: 'approval.requested';
  readonly interactionId: string;
  readonly toolCallId: TToolCallId;
  readonly approval: Readonly<ToolApprovalPayload>;
  readonly createdAt?: string;
}

/** State's exact auto_review.requested payload; no reviewer or model handle crosses SPI. */
export interface ToolPipelineSkillForkAutoReviewRequestedEvent<
  TToolCallId extends string = string,
> {
  readonly type: 'auto_review.requested';
  readonly reviewId: string;
  readonly toolCallId: TToolCallId;
  readonly toolName: string;
  readonly reason: string;
  readonly approval: Readonly<ToolApprovalPayload>;
  readonly requestFingerprint?: string;
  readonly createdAt?: string;
}

export type ToolPipelineSkillForkSuspensionEvent<TToolCallId extends string = string> =
  | Readonly<ToolPipelineSkillForkApprovalRequestedEvent<TToolCallId>>
  | Readonly<ToolPipelineSkillForkAutoReviewRequestedEvent<TToolCallId>>;

/**
 * Skill-fork suspension is an identity/artifact hand-off only.  The shared SPI
 * subagent record carries the private continuation reference; continuation
 * bytes, Store/State objects, callbacks, registries, and model loops are not
 * representable here.
 */
export interface ToolPipelineSkillForkSuspension<TToolCallId extends string = string> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly kind: 'skill_fork';
  readonly operationId: 'builtin:activate_skill';
  readonly toolCallId: TToolCallId;
  readonly parent: Readonly<ToolPipelineSkillForkParentIdentity<TToolCallId>>;
  readonly activation: Readonly<ToolPipelineSkillForkActivationIdentity>;
  readonly subagent: Readonly<PrivateSuspendedSubagentRecord>;
  readonly blockedTool: Readonly<ToolPipelineSkillForkBlockedToolIdentity>;
  readonly event: Readonly<ToolPipelineSkillForkSuspensionEvent<TToolCallId>>;
}

/** Low-information identity for the child tool that blocked a task subagent. */
export interface ToolPipelineTaskSubagentBlockedToolIdentity {
  readonly toolCallId: string;
  readonly runtimeToolCallId: string | null;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly commandDigest: string | null;
}

/** Parent identity is mandatory for both task start and task resume. */
export interface ToolPipelineTaskSubagentParentIdentity<TToolCallId extends string = string> {
  readonly toolCallId: TToolCallId;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attempt: number;
}

/** State's approval payload for a blocked task child; no live owner crosses SPI. */
export interface ToolPipelineTaskSubagentApprovalRequestedEvent<
  TToolCallId extends string = string,
> {
  readonly type: 'approval.requested';
  readonly interactionId: string;
  readonly toolCallId: TToolCallId;
  readonly approval: Readonly<ToolApprovalPayload>;
  readonly createdAt?: string;
}

/** State's auto-review request for a blocked task child; the reviewer remains outside SPI. */
export interface ToolPipelineTaskSubagentAutoReviewRequestedEvent<
  TToolCallId extends string = string,
> {
  readonly type: 'auto_review.requested';
  readonly reviewId: string;
  readonly toolCallId: TToolCallId;
  readonly toolName: string;
  readonly reason: string;
  readonly approval: Readonly<ToolApprovalPayload>;
  readonly requestFingerprint?: string;
  readonly createdAt?: string;
}

export type ToolPipelineTaskSubagentSuspensionEvent<TToolCallId extends string = string> =
  | Readonly<ToolPipelineTaskSubagentApprovalRequestedEvent<TToolCallId>>
  | Readonly<ToolPipelineTaskSubagentAutoReviewRequestedEvent<TToolCallId>>;

/**
 * Task start/resume is a distinct suspension branch from Skill fork.  It
 * carries only exact parent/child identities, a private artifact reference,
 * and the State interaction event; task runtime, continuation bytes,
 * reviewer, Store, and callbacks are deliberately not representable here.
 */
export interface ToolPipelineTaskSubagentSuspension<TToolCallId extends string = string> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_;
  readonly kind: 'task_subagent';
  readonly operationId: 'builtin:task';
  readonly executionMode: 'start' | 'resume';
  readonly toolCallId: TToolCallId;
  readonly parent: Readonly<ToolPipelineTaskSubagentParentIdentity<TToolCallId>>;
  readonly subagent: Readonly<PrivateSuspendedSubagentRecord>;
  readonly blockedTool: Readonly<ToolPipelineTaskSubagentBlockedToolIdentity>;
  readonly event: Readonly<ToolPipelineTaskSubagentSuspensionEvent<TToolCallId>>;
}

/** Closed suspension union. New interaction kinds require an explicit SPI branch. */
export type ToolPipelineSuspension =
  | ToolPipelinePlanReviewSuspension
  | ToolPipelineSkillForkSuspension
  | ToolPipelineTaskSubagentSuspension;

/**
 * Successful execution evidence retained while the Tool call remains
 * non-terminal.  `structuredContent` is required so the persistence owner can
 * write the same private Capability Artifact and result/evidence digests as a
 * terminal receipt without manufacturing a second domain result.
 */
export interface ToolPipelineSuspendedExecutionResult<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly status: 'success';
  readonly content: readonly RuntimeJsonValue[];
  readonly structuredContent: TValue;
  readonly providerMeta?: RuntimeJsonValue;
}

/**
 * A confirmed safe-read provider failure is neither a terminal receipt nor an
 * unknown effect.  It may cross the neutral seam only as an explicit branch;
 * the persistence/Kernel owner must durably authorize the next attempt.
 */
export interface ToolPipelineRetryableDispatch<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly kind: 'retryable';
  readonly replaySafety: 'safe_read';
  readonly result: Readonly<CapabilityToolTerminalResult<TValue>>;
}

/** A dispatch can commit, suspend, or request one durably governed safe-read retry. */
export type ToolPipelineDispatchOutcome<TValue extends RuntimeJsonValue = RuntimeJsonValue> =
  | {
      readonly kind: 'committed';
      readonly terminal: Readonly<CapabilityToolTerminalResult<TValue>>;
    }
  | {
      readonly kind: 'suspended';
      readonly suspension: Readonly<ToolPipelineSuspension>;
      /** Result evidence is persisted, but must not create a Capability or Tool terminal. */
      readonly result: Readonly<ToolPipelineSuspendedExecutionResult<TValue>>;
    }
  | ToolPipelineRetryableDispatch<TValue>;

/**
 * These common capability/provider/parser fields identify the invoked
 * subject. Dynamic MCP's executable wrapper is always carried separately.
 */
type PreparedToolInvocationIdentityCommon = {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  /** Exact turn/message disclosure scope captured before resolution. */
  readonly turnId: string;
  readonly modelMessageId: string;
  readonly providerId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly parserRevision: string | null;
  readonly executorRevision: string | null;
  /** Digest of the exact canonical arguments frozen in the prepared input. */
  readonly argumentsDigest: string;
  readonly schemaDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly policyDigest: string | null;
  readonly authorizationDigest: string | null;
  readonly admissionDigest: string | null;
  readonly idempotencyKeyArgument: string | null;
  readonly idempotencyKey: string | null;
  readonly bindingId: string | null;
};

export type DynamicMcpPreparedToolInvocationIdentity = PreparedToolInvocationIdentityCommon & {
  readonly argumentOrigin: 'model_public';
  readonly executionFamily: 'mcp';
  readonly executionMechanism: 'mcp';
  readonly operationId: 'mcp:dynamic_tool';
  readonly visibility: 'internal';
  readonly modelVisible: false;
  readonly exposedToolName: null;
  readonly isDynamicMcp: true;
  readonly executorRevision: null;
  readonly builtinProjectionRevision: null;
  readonly dynamicCatalogRevision: string;
  /** The real model-facing MCP subject, separate from the internal wrapper. */
  readonly subject: Readonly<DynamicMcpSubjectIdentity>;
  /** The exact private operation identity used to invoke the subject. */
  readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentity>;
};

export type NonDynamicPreparedToolInvocationIdentity = PreparedToolInvocationIdentityCommon & {
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly executionFamily: 'builtin' | 'skill' | 'subagent';
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly operationId: NonDynamicOperationId;
  readonly visibility: 'model';
  readonly modelVisible: true;
  readonly exposedToolName: string;
  readonly isDynamicMcp: false;
  readonly builtinProjectionRevision: string;
  /** Ordinary operations never borrow the dynamic MCP/Skill catalog identity. */
  readonly dynamicCatalogRevision: null;
  /** Nested Skill identity is explicit and only populated for activate_skill. */
  readonly nestedCapabilityId: string | null;
  readonly nestedCapabilityRevision: string | null;
  readonly nestedCatalogRevision: string | null;
  readonly toolKind: CapabilityToolKind;
};

export type PreparedToolInvocationIdentity =
  | DynamicMcpPreparedToolInvocationIdentity
  | NonDynamicPreparedToolInvocationIdentity;

/** The Host may freeze this transport input; it contains no policy implementation. */
export interface PreparedToolInvocationInput<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly arguments: TArguments;
  readonly request?: TRequest;
  readonly binding: ToolPipelineCapabilityBinding | null;
  readonly facts?: RuntimeJsonValue;
}

export interface PreparedToolInvocation<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly identity: Readonly<PreparedToolInvocationIdentity>;
  readonly input: Readonly<PreparedToolInvocationInput<TArguments, TRequest>>;
}

export type ToolPipelinePreparedIdentityVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code:
        | 'identity_mismatch'
        | 'revision_mismatch'
        | 'schema_mismatch'
        | 'visibility_mismatch'
        | 'subject_mismatch'
        | 'runtime_wrapper_mismatch'
        | 'arguments_mismatch'
        | 'binding_mismatch';
      readonly diagnostic?: string;
    };

/** Builtin supplies this synchronous identity check; Host supplies no identity interpretation. */
export type ToolPipelinePreparedIdentityVerifier<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
> = (
  prepared: Readonly<PreparedToolInvocation<TArguments>>,
) => boolean | ToolPipelinePreparedIdentityVerificationResult;

export interface ToolPipelineReceiptCommit<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly result: Readonly<CapabilityToolTerminalResult<TValue>>;
}

/** The durable hand-off for a non-terminal dispatch outcome. */
export interface ToolPipelineSuspensionCommit<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly suspension: Readonly<ToolPipelineSuspension>;
  readonly result: Readonly<ToolPipelineSuspendedExecutionResult<TValue>>;
}

/** Host/App persistence may implement this callback without exposing Store authority. */
export type ToolPipelineSuspensionCommitCallback<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> = (input: Readonly<ToolPipelineSuspensionCommit<TValue>>) => Promise<void>;

/** Durable hand-off for a confirmed non-terminal safe-read failure. */
export interface ToolPipelineRetryableCommit<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly replaySafety: 'safe_read';
  readonly result: Readonly<CapabilityToolTerminalResult<TValue>>;
}

/** The only durable attempt identity accepted after persistence. */
export interface ToolPipelineAttemptAcknowledgement {
  readonly acknowledged: true;
  readonly attempt: Readonly<ToolRecordedAttemptIdentity>;
}

export type ToolPipelineUnknownOutcomeCode =
  | 'dispatch_failed'
  | 'dispatch_timed_out'
  | 'dispatch_result_invalid'
  | 'retryable_commit_failed'
  | 'terminal_commit_failed'
  | 'suspension_commit_failed';

/** Post-ack uncertainty is an explicit persistence obligation. */
export interface ToolPipelineUnknownOutcome {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly code: ToolPipelineUnknownOutcomeCode;
}

/** Persistence is an injected callback surface, not a Store or event owner. */
export interface ToolPipelinePersistence<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> {
  /** The persistence owner derives the durable attempt identity from prepared facts. */
  readonly recordAttempt: (
    input: Readonly<PreparedToolInvocation<TArguments, TRequest>>,
  ) => Promise<Readonly<ToolPipelineAttemptAcknowledgement>>;
  /** A post-ack dispatch uncertainty cannot be silently dropped. */
  readonly recordUnknown: (input: Readonly<ToolPipelineUnknownOutcome>) => Promise<void>;
  /** A terminal result must be committed through the same acknowledged identity. */
  readonly commitTerminal: (input: Readonly<ToolPipelineReceiptCommit<TValue>>) => Promise<void>;
  /** A suspended result must preserve the same acknowledgement without terminalizing it. */
  readonly commitSuspension: ToolPipelineSuspensionCommitCallback<TValue>;
  /** Optional until a caller admits the explicit retryable dispatch branch. */
  readonly commitRetryable?: (
    input: Readonly<ToolPipelineRetryableCommit<TValue>>,
  ) => Promise<void>;
}

/**
 * Dispatch is an injected callback surface; the selected executor is opaque
 * to SPI. The complete prepared packet is supplied so its Host owner can
 * validate identity before invoking this callback; SPI performs no validation.
 */
export interface ToolPipelineDispatch<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier<TArguments>;
  readonly dispatch: (
    input: Readonly<PreparedToolInvocation<TArguments>>,
  ) => Promise<Readonly<CapabilityToolTerminalResult<TValue>>>;
}

/**
 * Host-facing dispatch shape. App may project an exact Builtin terminal into
 * the one closed suspended outcome before the Host commits either branch.
 */
export interface ToolPipelineOutcomeDispatch<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifier<TArguments>;
  readonly dispatch: (
    input: Readonly<PreparedToolInvocation<TArguments>>,
  ) => Promise<Readonly<ToolPipelineDispatchOutcome<TValue>>>;
}
