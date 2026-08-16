import type { ApprovalDecision } from '@/core/policies/approval-policy';
import type { ToolCapability, ToolEffectClass } from '@/core/policies/tool-capabilities';
import type { ToolAvailabilityContext, ToolKind } from '@/core/tools/registry/spec';
import type { ThreadAuthorizationState } from '@/core/types';
import type {
  CapabilityBinding,
  CapabilityDescriptor,
  CapabilityDisclosure,
  EffectProfile,
} from '@/protocol/capabilities';
import type { AgentPhase, InteractionMode, PlanningState } from '@/protocol/events';

export const TOOL_PIPELINE_STAGE_SCHEMA_V1 = 'kite.tool-pipeline-stage.v1' as const;

export type CanonicalToolArgumentValueV1 =
  | null
  | boolean
  | number
  | string
  | CanonicalToolArgumentValueV1[]
  | { [key: string]: CanonicalToolArgumentValueV1 };

export interface ToolCallSnapshotV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'snapshot';
  readonly toolCallId: string;
  readonly name: string;
  readonly rawArguments: CanonicalToolArgumentValueV1;
  readonly createdAtTurnId: string;
  readonly bindingId: string | null;
  readonly capabilityId: string | null;
  readonly capabilityRevision: string | null;
}

/**
 * All dynamic facts are captured before the pure stages begin. No Provider,
 * Runtime Store, Policy, approval, or adapter handle may enter this object.
 */
export interface ToolPipelineResolutionContextV1 {
  readonly currentTurnId: string;
  readonly catalogRevision: string;
  readonly availabilityContext: Readonly<ToolAvailabilityContext>;
  readonly bindings: readonly Readonly<CapabilityBinding>[];
  readonly descriptors: readonly Readonly<CapabilityDescriptor>[];
  readonly disclosures?: readonly Readonly<CapabilityDisclosure>[];
}

export type ToolExecutionFamilyV1 = 'builtin' | 'mcp' | 'skill' | 'subagent';

export interface ResolvedToolTargetV1 {
  readonly executionFamily: ToolExecutionFamilyV1;
  readonly toolKind: ToolKind;
  readonly exposedToolName: string;
  readonly descriptor: Readonly<CapabilityDescriptor>;
  readonly binding: Readonly<CapabilityBinding> | null;
}

export interface ResolvedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'resolved';
  readonly call: Readonly<ToolCallSnapshotV1>;
  readonly target: Readonly<ResolvedToolTargetV1>;
  readonly availabilityContext: Readonly<ToolAvailabilityContext>;
  readonly catalogRevision: string;
  /** Captured only for validation of nested Skill disclosure freshness. */
  readonly disclosedCapabilities: readonly Readonly<CapabilityDescriptor>[];
  readonly disclosures: readonly Readonly<CapabilityDisclosure>[];
}

export interface ValidatedToolRequestV1 {
  readonly source: 'builtin' | 'mcp';
  readonly name: string;
  readonly arguments: Readonly<Record<string, CanonicalToolArgumentValueV1>>;
  readonly argumentsDigest: string;
  readonly schemaDigest: string;
  readonly approvalSummary: string;
}

export interface ValidatedNestedCapabilityV1 {
  readonly descriptor: Readonly<CapabilityDescriptor>;
  readonly disclosure: Readonly<CapabilityDisclosure>;
}

export interface ValidatedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'validated';
  readonly resolved: Readonly<ResolvedInvocationV1>;
  readonly request: Readonly<ValidatedToolRequestV1>;
  readonly nestedCapability: Readonly<ValidatedNestedCapabilityV1> | null;
  readonly subagentRole: 'explore' | 'plan' | 'code' | 'review' | null;
}

export type ToolPipelineRiskClassV1 =
  | 'read'
  | 'plan'
  | 'workspace_write'
  | 'execute'
  | 'network'
  | 'external_state'
  | 'destructive'
  | 'unknown';

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

export interface ClassifiedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'classified';
  readonly validated: Readonly<ValidatedInvocationV1>;
  readonly capability: Readonly<ToolCapability>;
  readonly effectClass: ToolEffectClass;
  readonly effectiveEffects: Readonly<EffectProfile>;
  readonly effectiveEffectsDigest: string;
  readonly risk: ToolPipelineRiskClassV1;
  readonly sideEffect: boolean;
  readonly minimumApproval: CapabilityDescriptor['policy']['minimumApproval'];
  readonly requirements: Readonly<ToolInvocationRequirementsV1>;
}

export interface ToolPipelinePolicyContextV1 {
  readonly phase: AgentPhase;
  readonly workspace: string;
  readonly threadId: string;
  readonly authorization: Readonly<ThreadAuthorizationState>;
  readonly interactionMode: InteractionMode;
  readonly planKind: PlanningState['kind'];
  readonly circuitBreakerTripped: boolean;
  readonly callStatus: 'queued' | 'approved';
  readonly gates: Readonly<{
    recoveryAdmission: 'admitted' | 'blocked';
    boundedCancellation: 'admitted' | 'blocked';
    executionBoundary: 'admitted' | 'blocked';
    skillCapabilityCeiling: 'admitted' | 'blocked';
  }>;
}

export interface PolicyEvaluatedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'policy_evaluated';
  readonly classified: Readonly<ClassifiedInvocationV1>;
  readonly decision: Readonly<ApprovalDecision>;
  readonly policyDigest: string;
}

export interface AuthorizedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'authorized';
  readonly policy: Readonly<PolicyEvaluatedInvocationV1>;
  readonly authorizationKind: 'policy_allow' | 'approved_call';
  readonly authorizationDigest: string;
}

export interface ToolPipelineAdmissionContextV1 {
  readonly reservationRequired: boolean;
  readonly reservationIds: readonly string[];
  readonly freshness: 'current' | 'stale';
}

export interface AdmittedInvocationV1 {
  readonly schema: typeof TOOL_PIPELINE_STAGE_SCHEMA_V1;
  readonly stage: 'admitted';
  readonly authorized: Readonly<AuthorizedInvocationV1>;
  readonly reservationIds: readonly string[];
  readonly admissionDigest: string;
}

export type ToolPipelineEarlyTerminalV1 =
  | {
      readonly kind: 'reject';
      readonly reason: string;
      readonly failureKind:
        | 'loop_exhausted'
        | 'mandatory_policy_unavailable'
        | 'policy_denied'
        | 'phase_deferred'
        | 'phase_denied';
    }
  | { readonly kind: 'request_user_input' }
  | { readonly kind: 'request_approval'; readonly decision: Readonly<ApprovalDecision> }
  | {
      readonly kind: 'request_auto_review';
      readonly decision: Readonly<ApprovalDecision>;
    };

export type ToolPolicyStageOutcomeV1 =
  | { readonly kind: 'continue'; readonly value: Readonly<PolicyEvaluatedInvocationV1> }
  | { readonly kind: 'terminal'; readonly terminal: Readonly<ToolPipelineEarlyTerminalV1> };

export type ToolAuthorizationStageOutcomeV1 =
  | { readonly kind: 'continue'; readonly value: Readonly<AuthorizedInvocationV1> }
  | { readonly kind: 'terminal'; readonly terminal: Readonly<ToolPipelineEarlyTerminalV1> };

export type ToolAdmissionStageOutcomeV1 =
  | { readonly kind: 'continue'; readonly value: Readonly<AdmittedInvocationV1> }
  | { readonly kind: 'terminal'; readonly terminal: Readonly<ToolPipelineEarlyTerminalV1> };

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

export interface ToolPipelineStageFailureV1<
  Stage extends 'snapshot' | 'resolve' | 'validate' | 'classify',
  Code extends string,
> {
  readonly stage: Stage;
  readonly code: Code;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
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

export type ToolValidationResultV1 = ToolPipelineStageResultV1<
  ValidatedInvocationV1,
  ToolPipelineStageFailureV1<'validate', ToolPipelineValidateFailureCodeV1>
>;

export type ToolClassificationResultV1 = ToolPipelineStageResultV1<
  ClassifiedInvocationV1,
  ToolPipelineStageFailureV1<'classify', ToolPipelineClassifyFailureCodeV1>
>;
