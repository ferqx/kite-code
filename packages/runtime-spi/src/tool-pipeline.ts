import type {
  CapabilityBinding as RuntimeCapabilityBinding,
  CapabilityDescriptor as RuntimeCapabilityDescriptor,
  CapabilityDisclosure as RuntimeCapabilityDisclosure,
  ToolApprovalPayload,
} from '@kite/runtime-contract';
import type {
  CapabilityApprovalV1,
  CapabilityAvailabilityContextV1,
  CapabilityBindingV1,
  CapabilityDescriptorV1,
  CapabilityEffectClassV1,
  CapabilityEffectsV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutionTraitsV1,
  CapabilityInternalDescriptorV1,
  CapabilityPolicyCompilationV1,
  CapabilityRiskClassV1,
  CapabilityToolKindV1,
  RuntimeJsonValueV1,
} from './contracts';
import type { PrivateSuspendedSubagentRecordV1 } from './subagent';

/** Stable stage envelope shared by the pure pipeline contract. */
export const TOOL_PIPELINE_STAGE_SCHEMA_V1 = 'kite.tool-pipeline-stage.v1' as const;

export type ToolPipelineStageV1 = 'snapshot' | 'resolve' | 'validate' | 'classify' | 'recorded';

/** Pipeline arguments are the same canonical, provider-neutral JSON values as SPI. */
export type CanonicalToolArgumentValueV1 = RuntimeJsonValueV1;

/** Dynamic descriptors and bindings retain their runtime-contract shape. */
export type ToolPipelineCapabilityDescriptorV1 =
  | Readonly<CapabilityDescriptorV1>
  | Readonly<CapabilityInternalDescriptorV1>
  | Readonly<RuntimeCapabilityDescriptor>;

export type ToolPipelineCapabilityBindingV1 =
  | Readonly<CapabilityBindingV1>
  | Readonly<RuntimeCapabilityBinding>;

export type ToolPipelineCapabilityDisclosureV1 =
  | Readonly<import('./contracts').CapabilityDisclosureV1>
  | Readonly<RuntimeCapabilityDisclosure>;

export type ToolExecutionFamilyV1 = 'builtin' | 'mcp' | 'skill' | 'subagent';

/** Explicit provenance prevents private Runtime DTOs from being inferred from fields alone. */
export type ToolArgumentOriginV1 = 'model_public' | 'runtime_private';

/**
 * Operation identity after the owning resolver has proven it is not the
 * internal dynamic MCP wrapper.  The brand prevents that wrapper literal from
 * being assigned to the non-dynamic target branch without a runtime helper or
 * a second authority in SPI.
 */
declare const nonDynamicOperationIdBrandV1: unique symbol;
export type NonDynamicOperationIdV1 = string & {
  readonly [nonDynamicOperationIdBrandV1]: 'validated_non_dynamic_operation';
};

/** Model visibility is deliberately a discriminated identity, not a name convention. */
export type ToolPipelineVisibilityIdentityV1 =
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
export type DynamicMcpExposedToolNameV1 = `mcp__${string}`;

/** The real MCP subject carried alongside the internal runtime wrapper. */
export interface DynamicMcpSubjectIdentityV1 {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly providerId: string;
  readonly exposedToolName: DynamicMcpExposedToolNameV1;
  readonly dynamicCatalogRevision: string;
  readonly bindingId: string | null;
}

/**
 * The private runtime operation used to reach an MCP subject.  This carrier is
 * identity data only; it contains no registry, callback, or executor object.
 */
export interface DynamicMcpRuntimeWrapperIdentityV1 {
  readonly operationId: 'mcp:dynamic_tool';
  readonly capabilityId: 'mcp:dynamic_tool';
  readonly providerId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string;
  readonly schemaDigest: string;
  readonly builtinProjectionRevision: string;
}

/** The two catalog identities are intentionally independent fields. */
export interface ToolPipelineCatalogRevisionsV1 {
  readonly builtinProjectionRevision: string | null;
  readonly dynamicCatalogRevision: string | null;
}

export interface ToolCallSnapshotV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'snapshot';
  readonly toolCallId: string;
  readonly name: string;
  readonly rawArguments: CanonicalToolArgumentValueV1;
  readonly argumentOrigin: ToolArgumentOriginV1;
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
export interface ToolPipelineResolutionContextV1 extends ToolPipelineCatalogRevisionsV1 {
  readonly currentTurnId: string;
  readonly availabilityContext: Readonly<CapabilityAvailabilityContextV1>;
  readonly bindings: readonly ToolPipelineCapabilityBindingV1[];
  readonly descriptors: readonly ToolPipelineCapabilityDescriptorV1[];
  readonly disclosures?: readonly ToolPipelineCapabilityDisclosureV1[];
}

/**
 * For a dynamic MCP target these top-level descriptor fields identify the
 * real MCP subject. The internal Builtin wrapper has its own exact carrier.
 */
type ResolvedToolTargetCommonV1 = {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly descriptorRevision: string;
  readonly providerId: string;
  readonly executorRevision: string | null;
  readonly toolKind: CapabilityToolKindV1 | 'internal_runtime';
  readonly binding: ToolPipelineCapabilityBindingV1 | null;
  readonly descriptor: ToolPipelineCapabilityDescriptorV1;
};

export type DynamicMcpToolTargetV1 = ResolvedToolTargetCommonV1 & {
  readonly executionFamily: 'mcp';
  readonly executionMechanism: 'mcp';
  readonly operationId: 'mcp:dynamic_tool';
  readonly visibility: 'internal';
  readonly modelVisible: false;
  readonly exposedToolName: null;
  readonly isDynamicMcp: true;
  readonly toolKind: CapabilityToolKindV1;
  readonly executorRevision: null;
  readonly builtinProjectionRevision: null;
  readonly dynamicCatalogRevision: string;
  readonly subject: Readonly<DynamicMcpSubjectIdentityV1>;
  readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentityV1>;
};

export type NonDynamicToolTargetV1 = ResolvedToolTargetCommonV1 & {
  readonly executionFamily: 'builtin' | 'skill' | 'subagent';
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly operationId: NonDynamicOperationIdV1;
  readonly visibility: 'model';
  readonly modelVisible: true;
  readonly exposedToolName: string;
  readonly isDynamicMcp: false;
  readonly toolKind: CapabilityToolKindV1;
  readonly builtinProjectionRevision: string;
  readonly dynamicCatalogRevision: string | null;
};

export type ResolvedToolTargetV1 = DynamicMcpToolTargetV1 | NonDynamicToolTargetV1;

export interface ResolvedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'resolved';
  readonly call: Readonly<ToolCallSnapshotV1>;
  readonly target: Readonly<ResolvedToolTargetV1>;
  readonly availabilityContext: Readonly<CapabilityAvailabilityContextV1>;
  readonly builtinProjectionRevision: string | null;
  readonly dynamicCatalogRevision: string | null;
  readonly disclosedCapabilities: readonly ToolPipelineCapabilityDescriptorV1[];
  readonly disclosures: readonly ToolPipelineCapabilityDisclosureV1[];
}

export interface ValidatedToolRequestV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly source: ToolExecutionFamilyV1;
  readonly operationId: string;
  readonly name: string;
  readonly arguments: TArguments;
  readonly argumentsDigest: string;
  readonly schemaDigest: string;
  readonly approvalSummary: string;
}

export interface ValidatedNestedCapabilityV1 {
  readonly descriptor: ToolPipelineCapabilityDescriptorV1;
  readonly disclosure: ToolPipelineCapabilityDisclosureV1;
}

export interface ValidatedInvocationV1<TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'validated';
  readonly resolved: Readonly<ResolvedInvocationV1>;
  readonly request: Readonly<ValidatedToolRequestV1<TArguments>>;
  readonly nestedCapability: Readonly<ValidatedNestedCapabilityV1> | null;
  /** Domain-specific additions stay JSON data instead of importing a domain owner. */
  readonly domainData?: RuntimeJsonValueV1;
}

export type ToolPipelineRiskClassV1 = CapabilityRiskClassV1;

export type ToolPipelineIntentRequirementV1 = 'required_before_dispatch' | 'not_applicable';

export type ToolPipelineReceiptRequirementV1 =
  | 'observation_receipt'
  | 'effect_receipt'
  | 'control_receipt'
  | 'not_applicable';

export type ToolPipelineRetryEligibilityV1 =
  | 'none'
  | 'safe_read_candidate'
  | 'idempotency_key_candidate';

export interface ToolInvocationRequirementsV1 {
  readonly intent: ToolPipelineIntentRequirementV1;
  readonly receipt: ToolPipelineReceiptRequirementV1;
  readonly retry: ToolPipelineRetryEligibilityV1;
  readonly idempotencyKeyArgument: string | null;
  readonly verification: 'after_committed_receipt' | 'not_required_by_classification';
}

/**
 * The policy fact that the Builtin owner compiled for this invocation.  This
 * is intentionally the exact SPI policy compilation type so the Host bridge
 * cannot silently create a second policy schema while mapping facts into the
 * pure Kernel governance DTO.
 */
export type ToolPipelineGovernancePolicyProjectionV1 = Readonly<CapabilityPolicyCompilationV1>;

/**
 * Neutral invocation facts consumed by the State 25 governance bridge.  The
 * fields mirror the Kernel's identity facts without importing that package;
 * the two catalog revisions remain independent throughout the projection.
 */
type ToolPipelineGovernanceInvocationProjectionCommonV1 = {
  readonly turnId: string;
  readonly modelMessageId: string;
  readonly toolCallId: string;
  readonly argumentOrigin: ToolArgumentOriginV1;
  readonly executionFamily: ToolExecutionFamilyV1;
  readonly executionMechanism: CapabilityExecutionMechanismV1;
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
export type ToolPipelineGovernanceOrdinaryInvocationProjectionV1 =
  ToolPipelineGovernanceInvocationProjectionCommonV1 & {
    readonly isDynamicMcp: false;
    readonly executionFamily: 'builtin' | 'skill' | 'subagent';
    readonly operationId: NonDynamicOperationIdV1;
    readonly visibility: 'model';
    readonly modelVisible: true;
    readonly builtinProjectionRevision: string;
    /** Only the nested Skill field may carry the MCP/Skill catalog identity. */
    readonly dynamicCatalogRevision: null;
  };

/** Dynamic MCP governance facts preserve subject and wrapper identity separately. */
export type ToolPipelineGovernanceDynamicInvocationProjectionV1 =
  ToolPipelineGovernanceInvocationProjectionCommonV1 & {
    readonly isDynamicMcp: true;
    readonly executionFamily: 'mcp';
    readonly executionMechanism: 'mcp';
    readonly operationId: 'mcp:dynamic_tool';
    readonly visibility: 'internal';
    readonly modelVisible: false;
    readonly exposedToolName: DynamicMcpExposedToolNameV1;
    readonly capabilityId: string;
    readonly executorRevision: null;
    readonly builtinProjectionRevision: null;
    readonly dynamicCatalogRevision: string;
    readonly subject: Readonly<DynamicMcpSubjectIdentityV1>;
    readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentityV1>;
  };

/** Discriminated invocation projection accepted by the governance bridge. */
export type ToolPipelineGovernanceInvocationProjectionV1 =
  | ToolPipelineGovernanceOrdinaryInvocationProjectionV1
  | ToolPipelineGovernanceDynamicInvocationProjectionV1;

export interface ToolPipelineGovernanceDynamicMcpProjectionV1 {
  readonly isDynamicMcp: true;
  /** The real provider capability governed by the Kernel. */
  readonly subject: Readonly<DynamicMcpSubjectIdentityV1>;
  /** The private Builtin operation used to execute that subject. */
  readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentityV1>;
  readonly minimumApproval: CapabilityApprovalV1;
  readonly readOnly: boolean;
}

/** Short neutral name for callers that do not need the full prefix. */
export type DynamicMcpProjectionV1 = ToolPipelineGovernanceDynamicMcpProjectionV1;

/** Nested Skill facts may only accompany the activate_skill operation. */
export interface ToolPipelineGovernanceNestedSkillProjectionV1 {
  readonly operationId: 'builtin:activate_skill';
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly nestedCatalogRevision: string;
  readonly decision: CapabilityPolicyCompilationV1['decision'];
  readonly minimumApproval: CapabilityApprovalV1;
}

export type NestedSkillProjectionV1 = ToolPipelineGovernanceNestedSkillProjectionV1;

/**
 * Complete neutral governance projection.  `policy` is the same typed
 * Builtin compilation carried by ClassifiedInvocationV1; it is not a second
 * policy result or an authorization decision.
 */
export interface ToolPipelineGovernanceProjectionV1 {
  readonly invocation: Readonly<ToolPipelineGovernanceInvocationProjectionV1>;
  readonly policy: Readonly<ToolPipelineGovernancePolicyProjectionV1>;
  readonly effectiveEffects: Readonly<CapabilityEffectsV1>;
  readonly effectiveEffectsDigest: string;
  readonly dynamicMcp: Readonly<ToolPipelineGovernanceDynamicMcpProjectionV1> | null;
  readonly nestedSkill: Readonly<ToolPipelineGovernanceNestedSkillProjectionV1> | null;
}

export type ToolPipelineClassifiedIdentityVerificationResultV1 =
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
export type ToolPipelineClassifiedIdentityVerifierV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = (
  classified: Readonly<ClassifiedInvocationV1<TArguments>>,
) => boolean | ToolPipelineClassifiedIdentityVerificationResultV1;

/** Explicit governance-prefixed aliases for composition seams. */
export type ToolPipelineGovernanceIdentityVerificationResultV1 =
  ToolPipelineClassifiedIdentityVerificationResultV1;
export type ToolPipelineGovernanceIdentityVerifierV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = ToolPipelineClassifiedIdentityVerifierV1<TArguments>;

export interface ClassifiedInvocationV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'classified';
  readonly validated: Readonly<ValidatedInvocationV1<TArguments>>;
  readonly descriptor: Readonly<ToolPipelineCapabilityDescriptorV1>;
  readonly policyCompilation: ToolPipelineGovernancePolicyProjectionV1;
  /** Single neutral projection consumed by the Kernel governance bridge. */
  readonly governance: Readonly<ToolPipelineGovernanceProjectionV1>;
  readonly effectClass: CapabilityEffectClassV1;
  readonly effectiveEffects: Readonly<CapabilityEffectsV1>;
  readonly effectiveEffectsDigest: string;
  readonly risk: ToolPipelineRiskClassV1;
  readonly sideEffect: boolean;
  readonly minimumApproval: CapabilityApprovalV1;
  readonly executionTraits: Readonly<CapabilityExecutionTraitsV1> | null;
  readonly requirements: Readonly<ToolInvocationRequirementsV1>;
}

export type ToolPipelineSnapshotFailureCodeV1 = 'invalid_identity' | 'arguments_not_canonical_json';

export type ToolPipelineResolveFailureCodeV1 =
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

export type ToolPipelineValidateFailureCodeV1 =
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

export type ToolPipelineClassifyFailureCodeV1 =
  | 'invalid_stage_input'
  | 'stage_identity_drift'
  | 'classification_unavailable';

export type ToolPipelineRecordFailureCodeV1 =
  | 'invalid_stage_input'
  | 'identity_mismatch'
  | 'duplicate_attempt'
  | 'persistence_unavailable';

export type ToolPipelineDispatchFailureCodeV1 =
  | 'invalid_prepared_input'
  | 'identity_mismatch'
  | 'dispatch_unavailable'
  | 'dispatch_failed'
  | 'acknowledgement_failed'
  | 'unknown_outcome';

export interface ToolPipelineStageFailureV1<
  Stage extends ToolPipelineStageV1,
  Code extends string,
> {
  readonly stage: Stage;
  readonly code: Code;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  /** Bounded owner-provided diagnostic; argument values never cross this seam. */
  readonly diagnostic?: string;
}

export type ToolPipelineStageResultV1<Value, Failure> =
  | { readonly ok: true; readonly value: Readonly<Value> }
  | { readonly ok: false; readonly failure: Readonly<Failure> };

export type ToolCallSnapshotResultV1 = ToolPipelineStageResultV1<
  ToolCallSnapshotV1,
  ToolPipelineStageFailureV1<'snapshot', ToolPipelineSnapshotFailureCodeV1>
>;

export type ToolResolutionResultV1 = ToolPipelineStageResultV1<
  ResolvedInvocationV1,
  ToolPipelineStageFailureV1<'resolve', ToolPipelineResolveFailureCodeV1>
>;

export type ToolValidationResultV1<TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1> =
  ToolPipelineStageResultV1<
    ValidatedInvocationV1<TArguments>,
    ToolPipelineStageFailureV1<'validate', ToolPipelineValidateFailureCodeV1>
  >;

export type ToolClassificationResultV1<TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1> =
  ToolPipelineStageResultV1<
    ClassifiedInvocationV1<TArguments>,
    ToolPipelineStageFailureV1<'classify', ToolPipelineClassifyFailureCodeV1>
  >;

export interface ToolRecordedAttemptIdentityV1 {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly modelMessageId: string;
  readonly argumentOrigin: ToolArgumentOriginV1;
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

export interface RecordedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'recorded';
  readonly identity: Readonly<ToolRecordedAttemptIdentityV1>;
}

/** Neutral terminal failure; provider and domain details remain bounded JSON. */
export interface CapabilityToolTerminalFailureV1 {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly modelFixable: boolean;
  readonly needsUserIntervention: boolean;
  readonly terminatesTurn: boolean;
  readonly journal: boolean;
  readonly parseFailureCode?: string;
  readonly details?: RuntimeJsonValueV1;
}

export type CapabilityToolTerminalStatusV1 =
  | 'success'
  | 'partial'
  | 'error'
  | 'cancelled'
  | 'unknown';

/** Neutral terminal result; callers may carry a JSON-safe typed projection. */
export interface CapabilityToolTerminalResultV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly status: CapabilityToolTerminalStatusV1;
  readonly content: readonly RuntimeJsonValueV1[];
  readonly structuredContent?: TValue;
  readonly failure?: Readonly<CapabilityToolTerminalFailureV1>;
  readonly providerMeta?: RuntimeJsonValueV1;
}

/**
 * The first suspended-dispatch contract is deliberately a single closed
 * interaction event.  `plan` and `artifact` stay opaque JSON because their
 * domain owners live outside SPI; the event's field set and identity remain
 * fixed here so a caller cannot smuggle a Store, State, or callback handle
 * across this boundary.
 */
export interface ToolPipelinePlanReviewRequestedEventV1 {
  readonly type: 'plan.review_requested';
  readonly interactionId: string;
  readonly toolCallId: string;
  readonly taskId: string;
  readonly plan: RuntimeJsonValueV1;
  readonly planSummary: string;
  readonly planId: string;
  readonly version: number;
  readonly structuralDigest: string;
  readonly artifact: RuntimeJsonValueV1;
}

/** The original plan-review suspension remains a closed, exact event branch. */
export interface ToolPipelinePlanReviewSuspensionV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly kind: 'plan_review';
  readonly toolCallId: string;
  readonly event: Readonly<ToolPipelinePlanReviewRequestedEventV1>;
}

/** Low-information identity for the child tool that blocked a Skill fork. */
export interface ToolPipelineSkillForkBlockedToolIdentityV1 {
  readonly toolCallId: string;
  readonly runtimeToolCallId: string | null;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly commandDigest: string | null;
}

/** Parent identity is repeated explicitly so Host can bind the suspension to its acknowledgement. */
export interface ToolPipelineSkillForkParentIdentityV1<TToolCallId extends string = string> {
  readonly toolCallId: TToolCallId;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attempt: number;
}

export interface ToolPipelineSkillForkActivationIdentityV1 {
  readonly activationId: string;
  readonly skillId: string;
  readonly skillRevision: string;
  readonly taskId: string;
  readonly contextMode: 'fork';
}

/** State26's exact approval.requested payload; its approval hash binds the blocked child tool. */
export interface ToolPipelineSkillForkApprovalRequestedEventV1<
  TToolCallId extends string = string,
> {
  readonly type: 'approval.requested';
  readonly interactionId: string;
  readonly toolCallId: TToolCallId;
  readonly approval: Readonly<ToolApprovalPayload>;
  readonly createdAt?: string;
}

/** State26's exact auto_review.requested payload; no reviewer or model handle crosses SPI. */
export interface ToolPipelineSkillForkAutoReviewRequestedEventV1<
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

export type ToolPipelineSkillForkSuspensionEventV1<TToolCallId extends string = string> =
  | Readonly<ToolPipelineSkillForkApprovalRequestedEventV1<TToolCallId>>
  | Readonly<ToolPipelineSkillForkAutoReviewRequestedEventV1<TToolCallId>>;

/**
 * Skill-fork suspension is an identity/artifact hand-off only.  The shared SPI
 * subagent record carries the private continuation reference; continuation
 * bytes, Store/State objects, callbacks, registries, and model loops are not
 * representable here.
 */
export interface ToolPipelineSkillForkSuspensionV1<TToolCallId extends string = string> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly kind: 'skill_fork';
  readonly operationId: 'builtin:activate_skill';
  readonly toolCallId: TToolCallId;
  readonly parent: Readonly<ToolPipelineSkillForkParentIdentityV1<TToolCallId>>;
  readonly activation: Readonly<ToolPipelineSkillForkActivationIdentityV1>;
  readonly subagent: Readonly<PrivateSuspendedSubagentRecordV1>;
  readonly blockedTool: Readonly<ToolPipelineSkillForkBlockedToolIdentityV1>;
  readonly event: Readonly<ToolPipelineSkillForkSuspensionEventV1<TToolCallId>>;
}

/** Low-information identity for the child tool that blocked a task subagent. */
export interface ToolPipelineTaskSubagentBlockedToolIdentityV1 {
  readonly toolCallId: string;
  readonly runtimeToolCallId: string | null;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly commandDigest: string | null;
}

/** Parent identity is mandatory for both task start and task resume. */
export interface ToolPipelineTaskSubagentParentIdentityV1<TToolCallId extends string = string> {
  readonly toolCallId: TToolCallId;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attempt: number;
}

/** State26's approval payload for a blocked task child; no live owner crosses SPI. */
export interface ToolPipelineTaskSubagentApprovalRequestedEventV1<
  TToolCallId extends string = string,
> {
  readonly type: 'approval.requested';
  readonly interactionId: string;
  readonly toolCallId: TToolCallId;
  readonly approval: Readonly<ToolApprovalPayload>;
  readonly createdAt?: string;
}

/** State26's auto-review request for a blocked task child; the reviewer remains outside SPI. */
export interface ToolPipelineTaskSubagentAutoReviewRequestedEventV1<
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

export type ToolPipelineTaskSubagentSuspensionEventV1<TToolCallId extends string = string> =
  | Readonly<ToolPipelineTaskSubagentApprovalRequestedEventV1<TToolCallId>>
  | Readonly<ToolPipelineTaskSubagentAutoReviewRequestedEventV1<TToolCallId>>;

/**
 * Task start/resume is a distinct suspension branch from Skill fork.  It
 * carries only exact parent/child identities, a private artifact reference,
 * and the State26 interaction event; task runtime, continuation bytes,
 * reviewer, Store, and callbacks are deliberately not representable here.
 */
export interface ToolPipelineTaskSubagentSuspensionV1<TToolCallId extends string = string> {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly kind: 'task_subagent';
  readonly operationId: 'builtin:task';
  readonly executionMode: 'start' | 'resume';
  readonly toolCallId: TToolCallId;
  readonly parent: Readonly<ToolPipelineTaskSubagentParentIdentityV1<TToolCallId>>;
  readonly subagent: Readonly<PrivateSuspendedSubagentRecordV1>;
  readonly blockedTool: Readonly<ToolPipelineTaskSubagentBlockedToolIdentityV1>;
  readonly event: Readonly<ToolPipelineTaskSubagentSuspensionEventV1<TToolCallId>>;
}

/** Closed suspension union. New interaction kinds require an explicit SPI branch. */
export type ToolPipelineSuspensionV1 =
  | ToolPipelinePlanReviewSuspensionV1
  | ToolPipelineSkillForkSuspensionV1
  | ToolPipelineTaskSubagentSuspensionV1;

/**
 * Successful execution evidence retained while the Tool call remains
 * non-terminal.  `structuredContent` is required so the persistence owner can
 * write the same private Capability Artifact and result/evidence digests as a
 * terminal receipt without manufacturing a second domain result.
 */
export interface ToolPipelineSuspendedExecutionResultV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly status: 'success';
  readonly content: readonly RuntimeJsonValueV1[];
  readonly structuredContent: TValue;
  readonly providerMeta?: RuntimeJsonValueV1;
}

/**
 * A confirmed safe-read provider failure is neither a terminal receipt nor an
 * unknown effect.  It may cross the neutral seam only as an explicit branch;
 * the persistence/Kernel owner must durably authorize the next attempt.
 */
export interface ToolPipelineRetryableDispatchV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly kind: 'retryable';
  readonly replaySafety: 'safe_read';
  readonly result: Readonly<CapabilityToolTerminalResultV1<TValue>>;
}

/** A dispatch can commit, suspend, or request one durably governed safe-read retry. */
export type ToolPipelineDispatchOutcomeV1<TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1> =
  | {
      readonly kind: 'committed';
      readonly terminal: Readonly<CapabilityToolTerminalResultV1<TValue>>;
    }
  | {
      readonly kind: 'suspended';
      readonly suspension: Readonly<ToolPipelineSuspensionV1>;
      /** Result evidence is persisted, but must not create a Capability or Tool terminal. */
      readonly result: Readonly<ToolPipelineSuspendedExecutionResultV1<TValue>>;
    }
  | ToolPipelineRetryableDispatchV1<TValue>;

/**
 * These common capability/provider/parser fields identify the invoked
 * subject. Dynamic MCP's executable wrapper is always carried separately.
 */
type PreparedToolInvocationIdentityCommonV1 = {
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

export type DynamicMcpPreparedToolInvocationIdentityV1 = PreparedToolInvocationIdentityCommonV1 & {
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
  readonly subject: Readonly<DynamicMcpSubjectIdentityV1>;
  /** The exact private operation identity used to invoke the subject. */
  readonly runtimeWrapper: Readonly<DynamicMcpRuntimeWrapperIdentityV1>;
};

export type NonDynamicPreparedToolInvocationIdentityV1 = PreparedToolInvocationIdentityCommonV1 & {
  readonly argumentOrigin: ToolArgumentOriginV1;
  readonly executionFamily: 'builtin' | 'skill' | 'subagent';
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly operationId: NonDynamicOperationIdV1;
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
  readonly toolKind: CapabilityToolKindV1;
};

export type PreparedToolInvocationIdentityV1 =
  | DynamicMcpPreparedToolInvocationIdentityV1
  | NonDynamicPreparedToolInvocationIdentityV1;

/** The Host may freeze this transport input; it contains no policy implementation. */
export interface PreparedToolInvocationInputV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly arguments: TArguments;
  readonly request?: TRequest;
  readonly binding: ToolPipelineCapabilityBindingV1 | null;
  readonly facts?: RuntimeJsonValueV1;
}

export interface PreparedToolInvocationV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly identity: Readonly<PreparedToolInvocationIdentityV1>;
  readonly input: Readonly<PreparedToolInvocationInputV1<TArguments, TRequest>>;
}

export type ToolPipelinePreparedIdentityVerificationResultV1 =
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
export type ToolPipelinePreparedIdentityVerifierV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = (
  prepared: Readonly<PreparedToolInvocationV1<TArguments>>,
) => boolean | ToolPipelinePreparedIdentityVerificationResultV1;

export interface ToolPipelineReceiptCommitV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly result: Readonly<CapabilityToolTerminalResultV1<TValue>>;
}

/** The durable hand-off for a non-terminal dispatch outcome. */
export interface ToolPipelineSuspensionCommitV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly suspension: Readonly<ToolPipelineSuspensionV1>;
  readonly result: Readonly<ToolPipelineSuspendedExecutionResultV1<TValue>>;
}

/** Host/App persistence may implement this callback without exposing Store authority. */
export type ToolPipelineSuspensionCommitCallbackV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = (input: Readonly<ToolPipelineSuspensionCommitV1<TValue>>) => Promise<void>;

/** Durable hand-off for a confirmed non-terminal safe-read failure. */
export interface ToolPipelineRetryableCommitV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly replaySafety: 'safe_read';
  readonly result: Readonly<CapabilityToolTerminalResultV1<TValue>>;
}

/** The only durable attempt identity accepted after persistence. */
export interface ToolPipelineAttemptAcknowledgementV1 {
  readonly acknowledged: true;
  readonly attempt: Readonly<ToolRecordedAttemptIdentityV1>;
}

export type ToolPipelineUnknownOutcomeCodeV1 =
  | 'dispatch_failed'
  | 'dispatch_timed_out'
  | 'dispatch_result_invalid'
  | 'retryable_commit_failed'
  | 'terminal_commit_failed'
  | 'suspension_commit_failed';

/** Post-ack uncertainty is an explicit persistence obligation. */
export interface ToolPipelineUnknownOutcomeV1 {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly code: ToolPipelineUnknownOutcomeCodeV1;
}

/** Persistence is an injected callback surface, not a Store or event owner. */
export interface ToolPipelinePersistenceV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  /** The persistence owner derives the durable attempt identity from prepared facts. */
  readonly recordAttempt: (
    input: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>,
  ) => Promise<Readonly<ToolPipelineAttemptAcknowledgementV1>>;
  /** A post-ack dispatch uncertainty cannot be silently dropped. */
  readonly recordUnknown: (input: Readonly<ToolPipelineUnknownOutcomeV1>) => Promise<void>;
  /** A terminal result must be committed through the same acknowledged identity. */
  readonly commitTerminal: (input: Readonly<ToolPipelineReceiptCommitV1<TValue>>) => Promise<void>;
  /** A suspended result must preserve the same acknowledgement without terminalizing it. */
  readonly commitSuspension: ToolPipelineSuspensionCommitCallbackV1<TValue>;
  /** Optional until a caller admits the explicit retryable dispatch branch. */
  readonly commitRetryable?: (
    input: Readonly<ToolPipelineRetryableCommitV1<TValue>>,
  ) => Promise<void>;
}

/**
 * Dispatch is an injected callback surface; the selected executor is opaque
 * to SPI. The complete prepared packet is supplied so its Host owner can
 * validate identity before invoking this callback; SPI performs no validation.
 */
export interface ToolPipelineDispatchV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1<TArguments>;
  readonly dispatch: (
    input: Readonly<PreparedToolInvocationV1<TArguments>>,
  ) => Promise<Readonly<CapabilityToolTerminalResultV1<TValue>>>;
}

/**
 * Host-facing dispatch shape. App may project an exact Builtin terminal into
 * the one closed suspended outcome before the Host commits either branch.
 */
export interface ToolPipelineOutcomeDispatchV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly verifyPreparedIdentity: ToolPipelinePreparedIdentityVerifierV1<TArguments>;
  readonly dispatch: (
    input: Readonly<PreparedToolInvocationV1<TArguments>>,
  ) => Promise<Readonly<ToolPipelineDispatchOutcomeV1<TValue>>>;
}
