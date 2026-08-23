export interface AgentKernelBoundaryV1 {
  readonly deterministic: true;
  readonly externalIo: false;
  readonly revision: 'rmv1-07';
}

export const AGENT_KERNEL_BOUNDARY_V1: AgentKernelBoundaryV1 = Object.freeze({
  deterministic: true,
  externalIo: false,
  revision: 'rmv1-07',
});

export type {
  ApprovalGrantV1,
  AuthorizationElevationFactsV1,
  AuthorizationSourceV1,
} from './authorization';
export {
  applyApprovalGrantV1,
  assertAuthorizationElevation,
  authorizationCommandGrantKeyV1,
} from './authorization';

export type {
  AutoReviewAcceptedDecisionV1,
  AutoReviewDecisionV1,
  AutoReviewFactsV1,
  AutoReviewFailureTypeV1,
  AutoReviewGrantV1,
  AutoReviewRejectionEntryV1,
  AutoReviewUserApprovalDecisionV1,
  CircuitBreakerConfigV1,
  CircuitBreakerResultV1,
} from './auto-review';
export {
  DEFAULT_AUTO_REVIEW_STATE_V1,
  DEFAULT_CIRCUIT_BREAKER_CONFIG_V1,
  decideAutoReviewV1,
  evaluateAutoReviewCircuitBreakerV1,
  isValidAutoReviewFactsV1,
} from './auto-review';
export {
  assertCurrentRuntimeEvent,
  decodeCurrentRuntimeEventJson,
  encodeCurrentRuntimeEventJson,
} from './codec';
export type {
  CompletionBlockerCode,
  CompletionGuardAccepted,
  CompletionGuardAcceptedV1,
  CompletionGuardAcceptedV2,
  CompletionGuardBlocked,
  CompletionGuardBlockedV1,
  CompletionGuardBlockedV2,
  CompletionGuardDecision,
  CompletionGuardDecisionV1,
  CompletionGuardDecisionV2,
  CompletionGuardVersion,
  CompletionNextAction,
  PlanCompletionBlocker,
  PlanIdentityV1,
} from './completion';
export {
  COMPLETION_BLOCKER_CODES,
  COMPLETION_GUARD_V1,
  COMPLETION_GUARD_V2,
  decideCompletion,
  decideCompletionV1,
  decideCompletionV2,
  emptyPlanCompletionEvidenceV1,
  isCompletionBlockerCode,
  planCompletionBlocker,
  planCompletionEvidenceMatchesRuntime,
  projectPlanCompletionEvidenceV1,
} from './completion';
export type {
  AutoCompactionGuard,
  ContextCompactionHistoryEntry,
  ContextCorrectnessFailure,
  ContextRuntimeState,
  MutableContextCompactionCheckpoint,
} from './context-normalization';
export {
  createContextCorrectnessBlock,
  isContextHardBlockReason,
  normalizeContextCompactionReason,
  normalizeContextRuntimeState,
} from './context-normalization';
export type {
  KernelDoomLoopCheckV1,
  KernelDoomLoopRequestV1,
  KernelDoomLoopTrackerEntryV1,
} from './doom-loop';
export {
  kernelCheckDoomLoopFingerprintV1,
  kernelToolDoomLoopFingerprintV1,
  kernelUpdateDoomLoopTrackerV1,
} from './doom-loop';
export type {
  AgentEffectLeaseIdentityV1,
  SuspendedCapabilityTerminalRequirementV1,
} from './effect-admission';
export {
  assertCapabilityToolTerminalBatchV1,
  attachSuspendedCapabilityTerminalsV1,
  hasLateTerminalEventForCancelledToolV1,
  isConcurrentShellEffectBatchCurrentV1,
  isConcurrentShellEffectEventCurrentV1,
  suspendedCapabilityTerminalRequirementsV1,
} from './effect-admission';
export type { PendingEffect, RuntimeEffect } from './effects';
export { isInterruptEffect, isTerminalEffect } from './effects';
export type { StateReducerOwner } from './event-coverage';
export { STATE26_EVENT_REDUCER_COVERAGE } from './event-coverage';
export type {
  ContextCompactionCompletedEvent,
  ContextCompactionFailedEvent,
  ContextCompactionRequestedEvent,
  ContextCompactionResetEvent,
  KernelEvent,
  KernelEventEnvelope,
  RuntimeEvent,
  RuntimeEventType,
} from './events';
export {
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  CURRENT_RUNTIME_EVENT_TYPE_COUNT,
  STATE26_DIAGNOSTIC_EVENT_TYPES,
  STATE26_LEGACY_DEFAULT_EVENT_TYPES,
} from './events';
export type {
  ExecutionTraitsV1,
  ResourceScopeV1,
  SchedulableEffectV1,
} from './execution-traits';
export {
  executionTraitsMayOverlapV1,
  selectSchedulableEffectBatchV1,
} from './execution-traits';
export type {
  FailureModeContextV1,
  FailureModeDispositionV1,
  FailureModeDurableStateV1,
  FailureModeFallbackV1,
  FailureModeResolutionV1,
  RuntimeFailureModeV1,
} from './failure-mode-conformance';
export {
  RUNTIME_FAILURE_MODES_V1,
  resolveFailureModeV1,
} from './failure-mode-conformance';
export type { PlanReviewSiblingCancellationDecisionV1 } from './interaction-governance';
export {
  decidePlanReviewSiblingCancellationsV1,
  PLAN_REVIEW_SIBLING_CANCELLATION_REASON_V1,
} from './interaction-governance';
export { AgentInvariantError, assertAgentStateInvariants } from './invariants';
export type {
  AuthorizedEffect,
  DecisionEventFact,
  DecisionFacts,
  KernelDecision,
  KernelInput,
} from './kernel';
export {
  authorizeEffect,
  decide,
  reduce,
  selectPendingEffects,
  taskIdentityAllocationKeyV1,
} from './kernel';
export type {
  ClassifiedFailureV1,
  FailureKindV1,
  FailureStrategyV1,
  TerminalReasonCodeV1,
  ToolDispatchStateV1,
  ToolExternalEffectsV1,
  ToolOutcomeAuthorityV1,
  ToolOutcomeClassificationInputV1,
  ToolOutcomeClassifierAdviceV1,
  ToolOutcomeClassifierDiagnosticV1,
  ToolOutcomeDetailCodeV1,
  ToolOutcomeStatusV1,
  ToolOutcomeTimingV1,
  ToolOutcomeV1,
  ToolParseFailureCodeV1,
  ToolRecoveryDispositionV1,
  ToolRecoveryV1,
  ToolReplaySafetyV1,
  UnknownToolFieldsObservationV1,
} from './normalization';
export {
  assertCanonicalToolOutcomeEvent,
  classifyRuntimeFailureV1,
  classifyToolOutcomeV1,
  failureKindForToolParseFailureV1,
  isRuntimeFailureKindV1,
  isToolFailureKindV1,
  isToolOutcomeDetailCodeV1,
  isToolOutcomeV1,
  isToolParseFailureCodeV1,
  normalizeAgentToolOutcomeEvent,
  normalizeTerminalAgentEvent,
  TOOL_OUTCOME_DETAIL_CODES_V1,
  TOOL_OUTCOME_FAILURE_KINDS_V1,
  TOOL_OUTCOME_NEVER_RECOVERY_V1,
  TOOL_OUTCOME_SCHEMA_VERSION,
  terminalReasonForRuntimeFailureV1,
  toolOutcomeMetricStatusV1,
  toolOutcomeProtocolStatusV1,
  toolOutcomeSucceededV1,
  trustedToolTimingV1,
} from './normalization';
export type {
  KernelObservabilityEventEnvelopeV1,
  KernelObservabilityFailureKindV1,
  KernelObservabilityReasonV1,
  KernelObservabilityRuntimeFactV1,
  KernelObservabilityToolOutcomeFactV1,
  KernelObservabilityToolStatusV1,
} from './observability';
export {
  assertObservabilityEventCoverageV1,
  OBSERVABILITY_HANDLED_RUNTIME_EVENT_TYPES_V1,
  OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_V1,
  OBSERVABILITY_RUNTIME_FACT_SCHEMA_V1,
  projectRuntimeEventToObservabilityFactV1,
} from './observability';
export type {
  PlanCommandPhaseV1,
  PlanCommandStateFactsV1,
  PlanCompletionBlockerV1,
  PlanDecisionAcceptedV1,
  PlanDecisionCodeV1,
  PlanDecisionRejectedV1,
  PlanDecisionV1,
  PlanIdentityInputV1,
  ReadPlanCommandV1,
  ReadPlanDecisionV1,
  UpdatePlanCommandV1,
  UpdatePlanDecisionV1,
  WritePlanCommandV1,
  WritePlanDecisionModeV1,
  WritePlanDecisionV1,
} from './plan-command';
export {
  decideReadPlanCommandV1,
  decideUpdatePlanCommandV1,
  decideWritePlanCommandV1,
  planCommandPhaseV1,
} from './plan-command';
export type {
  RecoveryAdmissionV1,
  ToolOwnedProgressV1,
  ToolRecoveryAttemptModeV1,
  ToolRecoveryFailureV1,
  ToolRecoveryJournalV1,
  ToolRecoveryResolutionV1,
} from './recovery';
export {
  admitRecoveryAttemptV1,
  advanceToolRecoveryResponseV1,
  closeToolRecoveryScopeV1,
  createToolRecoveryJournalV1,
  hasActiveUnresolvedToolFailuresV1,
  hasUnresolvedToolFailuresV1,
  isToolRecoveryJournalInvalidV1,
  isToolRecoveryQualityBlockedV1,
  isToolRecoveryResolutionV1,
  mergeToolRecoveryJournalsV1,
  normalizeToolRecoveryJournalV1,
  recordRecoveryExhaustionV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  TOOL_RECOVERY_JOURNAL_SCHEMA_VERSION,
  TOOL_RECOVERY_QUALITY_FAILURE_LIMIT,
  TOOL_RECOVERY_RESOLUTIONS_V1,
  toolFailureInstanceIdV1,
  toolInvocationFingerprintV1,
} from './recovery';
export type { AgentReducerFactsV1 } from './reducer';
export {
  digestAgentEvent,
  FIXED_AGENT_STATE_REDUCERS,
  finalizeAgentEvent,
  normalizeAgentEvent,
  reduceAgentState,
} from './reducer';
export type {
  StateModelEvidenceFailureV1,
  StateRestartRecoveryFactsV1,
} from './restart-recovery';
export {
  projectStateRestartRecoveryEventsV1,
  stateRestartRecoveryCapabilityInvocationIdsV1,
} from './restart-recovery';
export type { RuntimeSchedulingPolicyV1 } from './runtime-scheduling-policy';
export {
  computeRuntimeSchedulingPolicyDigestV1,
  createRuntimeSchedulingPolicyV1,
} from './runtime-scheduling-policy';
export type { SchedulerFactsV1 } from './scheduler';
export {
  decideNextEffect,
  isValidSchedulerFactsV1,
  MAX_PARALLEL_READ_TOOLS,
  MAX_PARALLEL_SUBAGENTS,
  selectPendingEffects as selectScheduledEffects,
} from './scheduler';
export type {
  AgentAuthorizationState,
  AgentAutoReviewRejectionEntry,
  AgentAutoReviewState,
  AgentCapabilityArtifactRef,
  AgentCapabilityBindingState,
  AgentCapabilityDisclosureState,
  AgentCapabilityInvocationState,
  AgentCapabilityRuntimeState,
  AgentCapabilitySearchCandidate,
  AgentCapabilitySearchResult,
  AgentCompletionGuardState,
  AgentContextState,
  AgentFailureKind,
  AgentFailureState,
  AgentFilesystemPreimageArtifactRef,
  AgentGitFailureCode,
  AgentGitInvocationReceipt,
  AgentInteractionState,
  AgentLoadedCapabilityState,
  AgentModelAdmissionState,
  AgentModelBudgetState,
  AgentModelInvocationState,
  AgentModelLimitsState,
  AgentNetworkAdmissionReceipt,
  AgentNetworkDecisionReceipt,
  AgentNetworkDenialReceipt,
  AgentPlan,
  AgentPlanStep,
  AgentPrivateArtifactRef,
  AgentRecoveryState,
  AgentResourceBudgetActiveState,
  AgentResourceBudgetState,
  AgentResourceBudgetUnconfiguredState,
  AgentRunTerminalOutcome,
  AgentSandboxAbandonmentState,
  AgentSandboxDisposalState,
  AgentSandboxExecutionDispatchState,
  AgentSandboxPreparationArtifactRef,
  AgentSandboxPreparationIntentState,
  AgentSandboxPreparationReadyState,
  AgentSessionState,
  AgentShellApprovalGrant,
  AgentSkillRuntimeState,
  AgentState,
  AgentSubagentHandleArtifactRef,
  AgentSubagentTaskArtifactRef,
  AgentSuspendedSubagentState,
  AgentTaskState,
  AgentTerminalOutcomeState,
  AgentTerminalReasonCode,
  AgentToolApprovalPayload,
  AgentToolCallState,
  AgentToolGrant,
  AgentToolResultMeta,
  AgentToolResultState,
  AgentToolsState,
  AgentTranscriptMessage,
  AgentTranscriptMessageMeta,
  AgentTranscriptState,
  AgentTranscriptToolCall,
  AgentTurnState,
  AgentUnknownToolFieldsObservation,
  AgentUserInputOption,
  AgentUserInputPayload,
  AgentUserInputQuestion,
  AgentVerificationCheck,
  AgentVerificationCheckResult,
  AgentVerificationMode,
  AgentVerificationOutcome,
  AgentVerificationRecord,
  AgentVerificationRuntimeState,
  AgentVerificationSpec,
  AgentVerificationStatus,
  AuthorizationMode,
  ContextAutoGuardEntry,
  ContextCompactionCheckpoint,
  ContextCompactionErrorKind,
  ContextCompactionFailure,
  ContextCompactionReason,
  ContextHardBlock,
  ContextHardBlockReason,
  ContextHistoryEntry,
  ContextTokenEstimate,
  CreateAgentStateInput,
  InteractionMode,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  PlanArtifactRef,
  PlanCompletionEvidenceV1,
  PlanDocument,
  PlanningState,
  PlanStatus,
  PlanStep,
  ResourceBudgetV1,
  ResourceReservationState,
  ResourceReservationV1,
  ResourceUsageV1,
  ResourceWaiterV1,
  RuntimeState,
  StateAgentState,
  StateSessionState,
  WorkspaceAccess,
} from './state';
export {
  APPLIED_EVENT_ID_TAIL_LIMIT,
  createInitialAgentState,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
} from './state';
export {
  canForkAgentState,
  decodeCurrentAgentStateJson,
  encodeCurrentAgentStateJson,
  hasPendingSandboxCleanupAuthority,
  hasPendingSubagentCleanupAuthority,
  isCurrentAgentStateSnapshot,
  isCurrentPendingInteractionRequest,
  rebindForkAgentState,
} from './state-codec';
export type { RunTerminalOutcomeV1, RuntimeTerminalStatusV1 } from './terminal-outcome';
export {
  completedTerminalOutcomeV1,
  failedTerminalOutcomeV1,
  normalizeTerminalRuntimeEventV1,
} from './terminal-outcome';
export type {
  ToolApprovalBindingFactsV1,
  ToolGovernanceAdmissionFactsV1,
  ToolGovernanceApprovalFactV1,
  ToolGovernanceAuthorizationDecisionV1,
  ToolGovernanceAuthorizationModeV1,
  ToolGovernanceAuthorizationSourceV1,
  ToolGovernanceCallStatusV1,
  ToolGovernanceContextFactsV1,
  ToolGovernanceDecisionV1,
  ToolGovernanceDynamicMcpFactV1,
  ToolGovernanceEffectsV1,
  ToolGovernanceExecutionMechanismV1,
  ToolGovernanceFactsV1,
  ToolGovernanceGateFactsV1,
  ToolGovernanceGrantV1,
  ToolGovernanceInteractionModeV1,
  ToolGovernanceInvocationFactV1,
  ToolGovernanceMcpFactV1,
  ToolGovernanceMinimumApprovalV1,
  ToolGovernanceNestedSkillFactV1,
  ToolGovernancePhaseV1,
  ToolGovernancePolicyFactV1,
  ToolGovernanceRejectCodeV1,
  ToolGovernanceRejectDecisionV1,
  ToolGovernanceRejectFailureV1,
  ToolGovernanceRiskV1,
  ToolGovernanceSameCommandGrantFactV1,
} from './tool-governance';
export {
  admitToolGovernanceV1,
  authorizeToolGovernanceV1,
  createToolApprovalBindingDigestV1,
  createToolGovernanceCommandDigestV1,
  decideToolGovernanceV1,
  isValidToolApprovalBindingFactsV1,
  isValidToolGovernanceFactsV1,
  TOOL_GOVERNANCE_FACTS_SCHEMA_V1,
} from './tool-governance';
export type {
  KernelVerificationEffectsV1,
  KernelVerificationModeV1,
  KernelVerificationPolicyFactsV1,
} from './verification-policy';
export {
  kernelEffectsRequireVerificationV1,
  resolveKernelVerificationModeV1,
} from './verification-policy';
export type { VerificationSchemaAdmissionFactV1 } from './verification-schema-facts';
export { verificationSchemaAdmissionDigestV1 } from './verification-schema-facts';
export {
  activeSkillFramesForCurrentWorkV1,
  findStrandedInteractionToolV1,
  hasCurrentSuspendedSubagentV1,
  interactionBelongsToCurrentWorkV1,
  interactionToolCallV1,
  toolCallBelongsToCurrentWorkV1,
} from './work-scope';
