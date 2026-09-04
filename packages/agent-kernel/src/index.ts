export interface AgentKernelBoundary {
  readonly deterministic: true;
  readonly externalIo: false;
  readonly revision: 'agent-kernel-current';
}

export const AGENT_KERNEL_BOUNDARY_: AgentKernelBoundary = Object.freeze({
  deterministic: true,
  externalIo: false,
  revision: 'agent-kernel-current',
});

export {
  approvalCommandGrantKey,
  chooseApprovalFocus,
  selectPendingApprovals,
  selectSessionCommandGrants,
} from './approval-queue';
export type {
  AutoReviewAcceptedDecision,
  AutoReviewDecision,
  AutoReviewFacts,
  AutoReviewFailureType,
  AutoReviewGrant,
  AutoReviewRejectionEntry,
  AutoReviewUserApprovalDecision,
  CircuitBreakerConfig,
  CircuitBreakerResult,
} from './auto-review';
export {
  DEFAULT_AUTO_REVIEW_STATE_,
  DEFAULT_CIRCUIT_BREAKER_CONFIG_,
  decideAutoReview,
  evaluateAutoReviewCircuitBreaker,
  isValidAutoReviewFacts,
} from './auto-review';
export {
  assertCurrentRuntimeEvent,
  assertCurrentRuntimeEventForWrite,
  decodeCurrentRuntimeEventJson,
  encodeCurrentRuntimeEventJson,
} from './codec';
export type {
  CompletionBlockerCode,
  CompletionGuardAccepted,
  CompletionGuardBlocked,
  CompletionGuardDecision,
  CompletionGuardVersion,
  CompletionNextAction,
  PlanCompletionBlocker,
  PlanIdentity,
  PlannedCompletionGuardAccepted,
  PlannedCompletionGuardBlocked,
  PlannedCompletionGuardDecision,
  UnplannedCompletionGuardAccepted,
  UnplannedCompletionGuardBlocked,
  UnplannedCompletionGuardDecision,
} from './completion';
export {
  COMPLETION_BLOCKER_CODES,
  COMPLETION_GUARD_PLANNED_VERSION,
  COMPLETION_GUARD_UNPLANNED_VERSION,
  decideCompletion,
  decidePlannedCompletion,
  decideUnplannedCompletion,
  emptyPlanCompletionEvidence,
  isCompletionBlockerCode,
  planCompletionBlocker,
  planCompletionEvidenceMatchesRuntime,
  projectPlanCompletionEvidence,
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
  AgentContextState,
  ContextAutoGuardEntry,
  ContextCompactionCheckpoint,
  ContextCompactionErrorKind,
  ContextCompactionFailure,
  ContextCompactionReason,
  ContextHardBlock,
  ContextHardBlockReason,
  ContextHistoryEntry,
  ContextTokenEstimate,
} from './domains/context/state';
export type {
  AgentPlan,
  AgentPlanStep,
  AgentShellApprovalGrant,
  AgentToolApprovalPayload,
  AgentUserInputOption,
  AgentUserInputPayload,
  AgentUserInputQuestion,
  PlanArtifactRef,
  PlanCompletionEvidence,
  PlanDocument,
  PlanningState,
  PlanStatus,
  PlanStep,
} from './domains/planning/state';
export type {
  AgentVerificationCheck,
  AgentVerificationCheckResult,
  AgentVerificationMode,
  AgentVerificationOutcome,
  AgentVerificationRecord,
  AgentVerificationRuntimeState,
  AgentVerificationSpec,
  AgentVerificationStatus,
} from './domains/verification/state';
export type {
  KernelDoomLoopCheck,
  KernelDoomLoopRequest,
  KernelDoomLoopTrackerEntry,
} from './doom-loop';
export {
  kernelCheckDoomLoopFingerprint,
  kernelToolDoomLoopFingerprint,
  kernelUpdateDoomLoopTracker,
} from './doom-loop';
export type {
  AgentEffectLeaseIdentity,
  SuspendedCapabilityTerminalRequirement,
} from './effect-admission';
export {
  assertCapabilityToolTerminalBatch,
  attachSuspendedCapabilityTerminals,
  hasLateTerminalEventForCancelledTool,
  isConcurrentModelEffectBatchCurrent,
  isConcurrentShellEffectBatchCurrent,
  isConcurrentShellEffectEventCurrent,
  suspendedCapabilityTerminalRequirements,
} from './effect-admission';
export type { PendingEffect, RuntimeEffect } from './effects';
export { isInterruptEffect, isTerminalEffect } from './effects';
export type { StateReducerOwner } from './event-coverage';
export { STATE_EVENT_REDUCER_COVERAGE } from './event-coverage';
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
  STATE_DEFAULT_EVENT_TYPES,
  STATE_DIAGNOSTIC_EVENT_TYPES,
} from './events';
export type {
  ExecutionTraits,
  ResourceScope,
  SchedulableEffect,
} from './execution-traits';
export {
  executionTraitsMayOverlap,
  selectSchedulableEffectBatch,
} from './execution-traits';
export type {
  FailureModeContext,
  FailureModeDisposition,
  FailureModeDurableState,
  FailureModeFallback,
  FailureModeResolution,
  RuntimeFailureMode,
} from './failure-mode-conformance';
export {
  RUNTIME_FAILURE_MODES_,
  resolveFailureMode,
} from './failure-mode-conformance';
export type { PlanReviewSiblingCancellationDecision } from './interaction-governance';
export {
  decidePlanReviewSiblingCancellations,
  PLAN_REVIEW_SIBLING_CANCELLATION_REASON_,
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
  taskIdentityAllocationKey,
} from './kernel';
export type {
  ClassifiedFailure,
  FailureKind,
  FailureStrategy,
  TerminalReasonCode,
  ToolDispatchState,
  ToolExternalEffects,
  ToolOutcome,
  ToolOutcomeAuthority,
  ToolOutcomeClassificationInput,
  ToolOutcomeClassifierAdvice,
  ToolOutcomeClassifierDiagnostic,
  ToolOutcomeDetailCode,
  ToolOutcomeStatus,
  ToolOutcomeTiming,
  ToolParseFailureCode,
  ToolRecovery,
  ToolRecoveryDisposition,
  ToolReplaySafety,
  UnknownToolFieldsObservation,
} from './normalization';
export {
  assertCanonicalToolOutcomeEvent,
  classifyRuntimeFailure,
  classifyToolOutcome,
  failureKindForToolParseFailure,
  isRuntimeFailureKind,
  isToolFailureKind,
  isToolOutcome,
  isToolOutcomeDetailCode,
  isToolParseFailureCode,
  normalizeAgentToolOutcomeEvent,
  normalizeTerminalAgentEvent,
  TOOL_OUTCOME_DETAIL_CODES_,
  TOOL_OUTCOME_FAILURE_KINDS_,
  TOOL_OUTCOME_NEVER_RECOVERY_,
  TOOL_OUTCOME_SCHEMA_VERSION,
  terminalReasonForRuntimeFailure,
  toolOutcomeMetricStatus,
  toolOutcomeProtocolStatus,
  toolOutcomeSucceeded,
  trustedToolTiming,
} from './normalization';
export type {
  KernelObservabilityEventEnvelope,
  KernelObservabilityFailureKind,
  KernelObservabilityReason,
  KernelObservabilityRuntimeFact,
  KernelObservabilityToolOutcomeFact,
  KernelObservabilityToolStatus,
} from './observability';
export {
  assertObservabilityEventCoverage,
  OBSERVABILITY_HANDLED_RUNTIME_EVENT_TYPES_,
  OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_,
  OBSERVABILITY_RUNTIME_FACT_SCHEMA_,
  projectRuntimeEventToObservabilityFact,
} from './observability';
export type {
  PlanCommandPhase,
  PlanCommandStateFacts,
  PlanDecision,
  PlanDecisionAccepted,
  PlanDecisionCode,
  PlanDecisionRejected,
  PlanIdentityInput,
  ReadPlanCommand,
  ReadPlanDecision,
  UpdatePlanCommand,
  UpdatePlanDecision,
  WritePlanCommand,
  WritePlanDecision,
  WritePlanDecisionMode,
} from './plan-command';
export {
  decideReadPlanCommand,
  decideUpdatePlanCommand,
  decideWritePlanCommand,
  planCommandPhase,
} from './plan-command';
export type {
  RecoveryAdmission,
  ToolOwnedProgress,
  ToolRecoveryAttemptMode,
  ToolRecoveryFailure,
  ToolRecoveryJournal,
  ToolRecoveryResolution,
} from './recovery';
export {
  admitRecoveryAttempt,
  advanceToolRecoveryResponse,
  closeToolRecoveryScope,
  createToolRecoveryJournal,
  hasActiveUnresolvedToolFailures,
  hasUnresolvedToolFailures,
  isToolRecoveryJournalInvalid,
  isToolRecoveryQualityBlocked,
  isToolRecoveryResolution,
  mergeToolRecoveryJournals,
  normalizeToolRecoveryJournal,
  recordRecoveryExhaustion,
  recordRecoveryFailure,
  recordRecoveryInvocation,
  recordToolOwnedProgress,
  TOOL_RECOVERY_JOURNAL_SCHEMA_VERSION,
  TOOL_RECOVERY_QUALITY_FAILURE_LIMIT,
  TOOL_RECOVERY_RESOLUTIONS_,
  toolFailureInstanceId,
  toolInvocationFingerprint,
} from './recovery';
export type { AgentReducerFacts } from './reducer';
export {
  digestAgentEvent,
  FIXED_AGENT_STATE_REDUCERS,
  finalizeAgentEvent,
  normalizeAgentEvent,
  reduceAgentState,
} from './reducer';
export type {
  StateModelEvidenceFailure,
  StateRestartRecoveryFacts,
} from './restart-recovery';
export {
  projectStateRestartRecoveryEvents,
  stateRestartRecoveryCapabilityInvocationIds,
} from './restart-recovery';
export type { RuntimeSchedulingPolicy } from './runtime-scheduling-policy';
export {
  computeRuntimeSchedulingPolicyDigest,
  createRuntimeSchedulingPolicy,
} from './runtime-scheduling-policy';
export type { SchedulerFacts } from './scheduler';
export {
  decideNextEffect,
  isValidSchedulerFacts,
  MAX_PARALLEL_SUBAGENTS,
  selectPendingEffects as selectScheduledEffects,
} from './scheduler';
export type {
  AgentApprovalCommandIdentity,
  AgentApprovalReceipt,
  AgentApprovalRoute,
  AgentApprovalStatus,
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
  AgentFailureKind,
  AgentFailureState,
  AgentFilesystemPreimageArtifactRef,
  AgentGitFailureCode,
  AgentGitInvocationReceipt,
  AgentInteractionState,
  AgentLoadedCapabilityState,
  AgentModelBudgetState,
  AgentModelInvocationState,
  AgentModelLimitsState,
  AgentNetworkAdmissionReceipt,
  AgentNetworkDecisionReceipt,
  AgentNetworkDenialReceipt,
  AgentPendingApproval,
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
  AgentSessionCommandGrant,
  AgentSessionState,
  AgentSkillRuntimeState,
  AgentState,
  AgentSubagentHandleArtifactRef,
  AgentSubagentTaskArtifactRef,
  AgentSuspendedSubagentState,
  AgentTaskState,
  AgentTerminalOutcomeState,
  AgentTerminalReasonCode,
  AgentToolCallState,
  AgentToolResultMeta,
  AgentToolResultState,
  AgentToolsState,
  AgentTranscriptMessage,
  AgentTranscriptMessageMeta,
  AgentTranscriptState,
  AgentTranscriptToolCall,
  AgentTurnState,
  AgentUnknownToolFieldsObservation,
  CreateAgentStateInput,
  InteractionMode,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ResourceBudget,
  ResourceReservation,
  ResourceReservationState,
  ResourceUsage,
  ResourceWaiter,
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
  decodeAgentStateWithCompatibility,
  decodeCompatibleAgentStateJson,
  decodeCurrentAgentStateJson,
  encodeCurrentAgentStateJson,
  hasPendingSandboxCleanupAuthority,
  hasPendingSubagentCleanupAuthority,
  isCurrentAgentStateSnapshot,
  isCurrentPendingInteractionRequest,
  rebindForkAgentState,
} from './state-codec';
export type {
  LegacyRuntimeEventConversionResult,
  StateFormatClassification,
  StateMigrationFailure,
  StateMigrationResult,
} from './state-migration';
export {
  classifyAgentStateFormat,
  classifyStateFormat,
  convertLegacyRuntimeEvent,
  convertLegacyRuntimeEventJson,
  convertState26RuntimeEvent,
  isLegacyState26Snapshot,
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
  migrateCompatibleAgentState,
  migrateLegacyAgentState,
  migrateState26Event,
  migrateState26To27,
} from './state-migration';
export type { RunTerminalOutcome, RuntimeTerminalStatus } from './terminal-outcome';
export {
  completedTerminalOutcome,
  failedTerminalOutcome,
  normalizeTerminalRuntimeEvent,
} from './terminal-outcome';
export type {
  ToolApprovalBindingFacts,
  ToolGovernanceAdmissionFacts,
  ToolGovernanceApprovalFact,
  ToolGovernanceAuthorizationDecision,
  ToolGovernanceContextFacts,
  ToolGovernanceDecision,
  ToolGovernanceDynamicMcpFact,
  ToolGovernanceEffects,
  ToolGovernanceExecutionMechanism,
  ToolGovernanceFacts,
  ToolGovernanceGateFacts,
  ToolGovernanceGrant,
  ToolGovernanceInteractionMode,
  ToolGovernanceInvocationFact,
  ToolGovernanceMinimumApproval,
  ToolGovernanceNestedSkillFact,
  ToolGovernancePhase,
  ToolGovernancePolicyFact,
  ToolGovernanceRejectCode,
  ToolGovernanceRejectDecision,
  ToolGovernanceRejectFailure,
  ToolGovernanceRisk,
  ToolGovernanceSameCommandGrantFact,
} from './tool-governance';
export {
  admitToolGovernance,
  authorizeToolGovernance,
  canAuthorizeToolGovernanceInFullMode,
  createToolApprovalBindingDigest,
  createToolGovernanceCommandDigest,
  decideToolGovernance,
  isValidToolApprovalBindingFacts,
  isValidToolGovernanceFacts,
  TOOL_GOVERNANCE_FACTS_SCHEMA_,
  toolGovernanceFactsInvalidReason,
} from './tool-governance';
export type {
  KernelVerificationEffects,
  KernelVerificationMode,
  KernelVerificationPolicyFacts,
} from './verification-policy';
export {
  kernelEffectsRequireVerification,
  resolveKernelVerificationMode,
} from './verification-policy';
export type { VerificationSchemaAdmissionFact } from './verification-schema-facts';
export { verificationSchemaAdmissionDigest } from './verification-schema-facts';
export {
  activeSkillFramesForCurrentWork,
  findStrandedInteractionTool,
  hasCurrentSuspendedSubagent,
  interactionBelongsToCurrentWork,
  interactionToolCall,
  toolCallBelongsToCurrentWork,
} from './work-scope';
