import type {
  CompletionBlockerCode,
  CompletionGuardVersion,
  CompletionNextAction,
  PlanIdentityV1,
} from './completion';
import type {
  ClassifiedFailureV1,
  ToolOutcomeClassifierAdviceV1,
  ToolOutcomeV1,
  UnknownToolFieldsObservationV1,
} from './normalization';
import type { ToolRecoveryAttemptModeV1, ToolRecoveryJournalV1 } from './recovery';
import type {
  AgentPlan as StateAgentPlan,
  AgentCapabilityArtifactRef as StateCapabilityArtifactRef,
  AgentCapabilityBindingState as StateCapabilityBinding,
  AgentCapabilityDisclosureState as StateCapabilityDisclosure,
  AgentCapabilitySearchResult as StateCapabilitySearchResult,
  ContextTokenEstimate as StateContextTokenEstimate,
  AgentFilesystemPreimageArtifactRef as StateFilesystemPreimageArtifactRef,
  AgentLoadedCapabilityState as StateLoadedCapability,
  AgentNetworkDecisionReceipt as StateNetworkDecisionReceipt,
  PlanArtifactRef as StatePlanArtifactRef,
  PlanCompletionEvidenceV1 as StatePlanCompletionEvidence,
  PlanningState as StatePlanningState,
  ResourceBudgetV1 as StateResourceBudget,
  ResourceReservationV1 as StateResourceReservation,
  ResourceUsageV1 as StateResourceUsage,
  ResourceWaiterV1 as StateResourceWaiter,
  AgentRunTerminalOutcome as StateRunTerminalOutcome,
  AgentSandboxPreparationArtifactRef as StateSandboxPreparationArtifactRef,
  AgentSkillActivationState as StateSkillActivation,
  AgentSubagentHandleArtifactRef as StateSubagentHandleArtifactRef,
  AgentSubagentTaskArtifactRef as StateSubagentTaskArtifactRef,
  AgentToolApprovalPayload as StateToolApprovalPayload,
  AgentToolResultMeta as StateToolResultMeta,
  AgentUserInputPayload as StateUserInputPayload,
  AgentVerificationCheckResult as StateVerificationCheckResult,
  AgentVerificationSpec as StateVerificationSpec,
} from './state';

/**
 * Current durable event discriminants.
 *
 * This table is deliberately the source of truth for the Kernel event union:
 * the codec, the generated event-count assertion, and the static reducers all
 * consume it.  Keeping the table in the Kernel package prevents a Host or a
 * provider from extending the persisted format at runtime.
 */
export const CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS = {
  'approval.command_replaced': ['interactionId', 'command'],
  'approval.granted': ['interactionId', 'toolCallId', 'grant'],
  'approval.rejected': ['interactionId', 'toolCallId', 'reason'],
  'approval.requested': ['interactionId', 'toolCallId', 'approval'],
  'authorization.changed': ['mode'],
  'auto_review.completed': ['reviewId', 'toolCallId', 'result'],
  'auto_review.requested': ['reviewId', 'toolCallId', 'toolName', 'reason', 'approval'],
  'capability.bindings_issued': ['catalogRevision', 'bindings'],
  'capability.execution_failed': ['invocationId', 'error', 'finishedAt'],
  'capability.execution_started': ['invocationId', 'startedAt'],
  'capability.execution_result_recorded': [
    'invocationId',
    'resultDigest',
    'evidenceDigest',
    'recordedAt',
    'artifact',
  ],
  'capability.execution_succeeded': [
    'invocationId',
    'resultDigest',
    'evidenceDigest',
    'finishedAt',
  ],
  'capability.execution_unknown': ['invocationId', 'reason', 'finishedAt'],
  'capability.filesystem_mutation_ready': [
    'invocationId',
    'attempt',
    'intentDigest',
    'operationDigest',
    'targetIdentityDigest',
    'preimageDigest',
    'preimageArtifact',
    'readyDigest',
    'readyAt',
  ],
  'capability.filesystem_intent_recorded': [
    'invocationId',
    'attempt',
    'capabilityRevision',
    'argumentsDigest',
    'admissionDigest',
    'operationDigest',
    'searchBoundaryDigest',
    'lexicalTargetDigest',
    'canonicalWorkspaceDigest',
    'protectedPathRevision',
    'approvalSummaryDigest',
    'effectiveEffectsDigest',
    'intentDigest',
    'recordedAt',
  ],
  'capability.sandbox_preparation_intent_recorded': [
    'invocationId',
    'attempt',
    'toolCallId',
    'capabilityId',
    'capabilityRevision',
    'canonicalWorkspace',
    'effectiveEffectsDigest',
    'admissionDigest',
    'preparationDigest',
    'commandDigest',
    'executionBoundaryDigest',
    'resourceSemantics',
    'intentDigest',
    'recordedAt',
  ],
  'capability.sandbox_preparation_ready': [
    'invocationId',
    'attempt',
    'intentDigest',
    'preparationDigest',
    'commandDigest',
    'planDigest',
    'backend',
    'backendCapabilitiesDigest',
    'enforcement',
    'resourceSemantics',
    'cleanupDigest',
    'preparationArtifact',
    'readyDigest',
    'readyAt',
  ],
  'capability.sandbox_execution_dispatch_intent_recorded': [
    'invocationId',
    'attempt',
    'readyDigest',
    'planDigest',
    'dispatchId',
    'supervisorNonce',
    'dispatchIntentDigest',
    'recordedAt',
  ],
  'capability.sandbox_execution_supervisor_started': [
    'invocationId',
    'attempt',
    'dispatchId',
    'dispatchIntentDigest',
    'supervisorPid',
    'processGroupId',
    'processStartIdentity',
    'startedAt',
  ],
  'capability.sandbox_disposal_started': [
    'invocationId',
    'attempt',
    'readyDigest',
    'lifecycleIntentDigest',
    'startedAt',
  ],
  'capability.sandbox_disposal_completed': [
    'invocationId',
    'attempt',
    'readyDigest',
    'lifecycleIntentDigest',
    'cleanupAttempt',
    'disposed',
    'disposedAt',
  ],
  'capability.sandbox_preparation_abandonment_started': [
    'invocationId',
    'attempt',
    'intentDigest',
    'lifecycleIntentDigest',
    'startedAt',
  ],
  'capability.sandbox_preparation_abandonment_completed': [
    'invocationId',
    'attempt',
    'intentDigest',
    'lifecycleIntentDigest',
    'cleanupAttempt',
    'disposed',
    'disposedAt',
  ],
  'capability.subagent_dispatch_intent_recorded': [
    'invocationId',
    'attempt',
    'purpose',
    'childInvocationId',
    'taskArtifact',
    'dispatchIntentDigest',
    'recordedAt',
  ],
  'capability.subagent_handle_recorded': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'handleArtifact',
    'handleIntegrityIdentifier',
    'recordedAt',
  ],
  'capability.subagent_observation_recorded': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'status',
    'observedAt',
  ],
  'capability.subagent_cleanup_started': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'cleanupAttempt',
    'cleanupKind',
    'startedAt',
  ],
  'capability.subagent_cleanup_completed': [
    'invocationId',
    'attempt',
    'dispatchIntentDigest',
    'cleanupAttempt',
    'cleanupKind',
    'cleanupConfirmed',
    'completedAt',
  ],
  'capability.invocation_recorded': [
    'invocationId',
    'toolCallId',
    'capabilityId',
    'capabilityRevision',
    'argumentsDigest',
    'authorizationDigest',
    'effectiveEffectsDigest',
    'effectiveEffects',
    'recordedAt',
  ],
  'capability.reconciliation_resolved': ['invocationId', 'decision', 'reconciledAt'],
  'capability.search_completed': ['result'],
  'completion.blocked': [
    'turnId',
    'guardVersion',
    'code',
    'nextAction',
    'planning',
    'correctionAttempt',
  ],
  'context.compaction_completed': ['compactionId', 'sourceRevision', 'checkpoint'],
  'context.compaction_failed': [
    'compactionId',
    'sourceRevision',
    'errorKind',
    'message',
    'retryable',
  ],
  'context.compaction_requested': [
    'compactionId',
    'reason',
    'requestedAtRevision',
    'requestedAtTurnId',
    'force',
    'estimate',
  ],
  'context.compaction_reset': ['checkpointId', 'reason'],
  'context.hard_block_cleared': ['reason', 'sourceDigest'],
  'context.hard_blocked': ['reason', 'sourceDigest', 'message', 'createdAtTurnId'],
  'interaction_mode.changed': ['mode', 'source', 'changedAt'],
  'model.cache_metrics': ['inputTokens', 'cacheHitTokens', 'cacheMissTokens', 'hitRate'],
  'model.context_metrics': ['modelName', 'totalInputTokens', 'status', 'estimate'],
  'model.invocation_attempt_started': ['invocationId', 'attempt', 'maxAttempts'],
  'model.invocation_completed': ['invocationId', 'responseArtifact', 'finishReason'],
  'model.invocation_evidence_unavailable': ['invocationId', 'reasonCode'],
  'model.invocation_interrupted': ['invocationId', 'dispatchCertainty', 'reasonCode'],
  'model.invocation_prepared': [
    'invocationId',
    'purpose',
    'surfaceArtifact',
    'surfaceIntegrityIdentifier',
    'routeFingerprint',
    'admission',
    'budget',
    'limits',
    'preparedStateRevision',
    'parentInvocationId',
    'parentToolCallId',
  ],
  'model.reasoning_completed': ['segmentId', 'text'],
  'model.reasoning_delta': ['text'],
  'model.requested': ['requestId'],
  'model.responded': ['messageId'],
  'model.retry': ['attempt', 'maxAttempts', 'error', 'delayMs'],
  'model.text_delta': ['text'],
  'network.admission_decided': ['toolCallId', 'decision'],
  'plan.approved': [
    'interactionId',
    'toolCallId',
    'planId',
    'version',
    'structuralDigest',
    'executionMode',
  ],
  'plan.completed': [
    'toolCallId',
    'taskId',
    'plan',
    'planId',
    'version',
    'structuralDigest',
    'completionEvidence',
  ],
  'plan.drafted': [
    'toolCallId',
    'taskId',
    'plan',
    'structuralHash',
    'planId',
    'version',
    'planSchemaVersion',
    'artifact',
  ],
  'plan.progress_updated': [
    'toolCallId',
    'taskId',
    'plan',
    'planId',
    'version',
    'structuralDigest',
    'completionEvidence',
  ],
  'plan.replan_requested': ['toolCallId', 'reason', 'supersedesPlanVersion'],
  'plan.review_cancelled': [
    'interactionId',
    'toolCallId',
    'planId',
    'version',
    'structuralDigest',
    'reason',
  ],
  'plan.review_requested': [
    'interactionId',
    'toolCallId',
    'taskId',
    'plan',
    'planSummary',
    'planId',
    'version',
    'structuralDigest',
    'artifact',
  ],
  'plan.revision_requested': [
    'interactionId',
    'toolCallId',
    'planId',
    'version',
    'structuralDigest',
    'feedback',
  ],
  'planning.entered': ['taskId', 'source'],
  'planning.exited': ['taskId'],
  'provider.action_completed': ['interactionId', 'originatingToolCallId'],
  'provider.action_deferred': ['interactionId', 'originatingToolCallId'],
  'provider.action_failed': ['interactionId', 'originatingToolCallId', 'failureCode'],
  'provider.action_required': ['interactionId', 'providerId', 'action', 'originatingToolCallId'],
  'provider.action_started': ['interactionId'],
  'provider.admission_cancelled': ['interactionId', 'providerId'],
  'provider.admission_required': [
    'interactionId',
    'providerId',
    'source',
    'providerStatus',
    'retryable',
  ],
  'provider.admission_retry_failed': ['interactionId', 'providerStatus'],
  'provider.admission_retry_requested': ['interactionId'],
  'provider.admission_satisfied': ['interactionId', 'providerDirectoryRevision'],
  'provider.admission_waived': ['interactionId', 'providerId', 'source', 'reason', 'waivedAt'],
  'provider.admission_status': ['status', 'reason'],
  'provider.readiness_attempt_started': [
    'readinessKey',
    'lifecycleId',
    'attempt',
    'maxAttempts',
    'startedAt',
  ],
  'provider.readiness_failed': [
    'readinessKey',
    'lifecycleId',
    'failure',
    'dispatchCertainty',
    'failedAt',
  ],
  'provider.readiness_intent_recorded': [
    'readinessKey',
    'lifecycleId',
    'providerId',
    'routeRevision',
    'executionBoundaryDigest',
    'requestedAt',
    'expiresAt',
    'maxAttempts',
  ],
  'provider.readiness_succeeded': [
    'readinessKey',
    'lifecycleId',
    'providerDirectoryRevision',
    'readyAt',
    'expiresAt',
  ],
  'provider.readiness_waiter_registered': [
    'readinessKey',
    'lifecycleId',
    'waiterId',
    'toolCallId',
    'registeredAt',
  ],
  'resource_budget.configured': ['runId', 'startedAt', 'deadlineAt', 'budget'],
  'resource_budget.dispatch_started': ['reservationId'],
  'resource_budget.reconciled': ['reservationId', 'actual'],
  'resource_budget.released': ['reservationId'],
  'resource_budget.reserved': ['reservation'],
  'resource_budget.unknown': ['reservationId'],
  'resource_budget.waiter_cancelled': ['invocationId'],
  'resource_budget.waiter_enqueued': ['waiter'],
  'resource_budget.waiter_promoted': ['invocationId'],
  'resource_budget.waiter_timed_out': ['invocationId'],
  'run.completed': ['turnId', 'output'],
  'run.error': ['message', 'recoverable'],
  'runtime.action_ignored': ['reason'],
  'runtime.cancellation_diagnostic': ['toolCallId', 'failure', 'unconfirmedDescendantCount'],
  'skill.activation_started': ['activation'],
  'skill.catalog_refreshed': ['catalogRevision'],
  'skill.frame_closed': ['activationId', 'status', 'reason', 'closedAt'],
  'subagent.approval_deferred': ['toolCallId'],
  'subagent.cache_metrics': ['subagent'],
  'subagent.completed': ['subagent'],
  'subagent.failed': ['subagent'],
  'subagent.recovery_journal_merged': ['toolCallId', 'journal'],
  'subagent.started': ['subagent'],
  'subagent.step': ['subagent'],
  'subagent.suspended': ['toolCallId', 'snapshot'],
  'subagent.tool_result': ['subagent'],
  'task.cancelled': ['taskId', 'reason'],
  'task.completed': ['taskId', 'turnId'],
  'task.started': ['taskId', 'userGoal', 'turnId'],
  'tool.cancelled': ['toolCallId', 'reason'],
  'tool.failed': ['toolCallId', 'failure'],
  'tool.file_change': ['toolCallId', 'path', 'kind'],
  'tool.finished': ['toolCallId', 'name', 'result'],
  'tool.progress': ['toolCallId', 'chunk', 'stream'],
  'tool.queued': ['toolCallId', 'name', 'args'],
  'tool.rejected': ['toolCallId', 'reason'],
  'tool.retry_recorded': ['toolCallId', 'failure', 'outcomeV1', 'recoveryOf', 'retryAttempt'],
  'tool.started': ['toolCallId'],
  'turn.aborted': ['turnId', 'reason'],
  'turn.completed': ['turnId'],
  'turn.started': ['turnId'],
  'user.command_invoked': ['commandId', 'command'],
  'user.message_appended': ['messageId', 'content'],
  'user_input.answered': ['interactionId', 'toolCallId', 'answer'],
  'user_input.cancelled': ['interactionId', 'toolCallId', 'reason'],
  'user_input.requested': ['interactionId', 'toolCallId', 'request'],
  'verification.check_completed': ['verificationId', 'result'],
  'verification.compensation_completed': ['verificationId', 'outcome', 'summary', 'completedAt'],
  'verification.compensation_requested': ['verificationId', 'requestedAt'],
  'verification.completed': ['verificationId', 'outcome', 'completedAt'],
  'verification.repair_requested': [
    'verificationId',
    'repairAttempt',
    'instruction',
    'requestedAt',
  ],
  'verification.replan_requested': ['verificationId', 'instruction', 'requestedAt'],
  'verification.requested': ['verificationId', 'mode', 'spec', 'requestedAt'],
  'verification.started': ['verificationId', 'attempt', 'startedAt'],
  'verification.waived': ['verificationId', 'actor', 'reason', 'waivedAt'],
} as const;

export type RuntimeEventType = keyof typeof CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS;

/** The current State union has exactly 135 discriminants. */
export const CURRENT_RUNTIME_EVENT_TYPE_COUNT = 135 as const;

/**
 * State diagnostics/projection notifications intentionally left out of the
 * persisted snapshot reducer. Every other discriminant has a state-changing
 * case in one of the fixed domain reducers.
 */
export const STATE26_DIAGNOSTIC_EVENT_TYPES = [
  'approval.command_replaced',
  'model.cache_metrics',
  'model.context_metrics',
  'model.reasoning_completed',
  'model.reasoning_delta',
  'model.requested',
  'model.retry',
  'model.text_delta',
  'planning.exited',
  'provider.admission_retry_requested',
  'provider.admission_status',
  'runtime.action_ignored',
  'runtime.cancellation_diagnostic',
  'subagent.cache_metrics',
  'subagent.completed',
  'subagent.failed',
  'subagent.started',
  'subagent.step',
  'subagent.tool_result',
  'tool.file_change',
  'tool.progress',
  'user.command_invoked',
] as const satisfies readonly RuntimeEventType[];

/** Seven current discriminants absent from the legacy reducer switch. */
export const STATE26_LEGACY_DEFAULT_EVENT_TYPES = [
  'runtime.cancellation_diagnostic',
  'subagent.cache_metrics',
  'subagent.completed',
  'subagent.failed',
  'subagent.started',
  'subagent.step',
  'subagent.tool_result',
] as const satisfies readonly RuntimeEventType[];

if (
  Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS).length !== CURRENT_RUNTIME_EVENT_TYPE_COUNT
) {
  throw new Error('State RuntimeEvent discriminant table must contain exactly 135 entries.');
}

/** Make the package-owned State DTOs structurally match the mutable root
 * event DTOs without importing the root/Core, Contract, SPI, or Builtin
 * packages.  This is a type-only projection; it creates no runtime adapter. */
type Mutable<T> = T extends readonly [...infer Elements]
  ? { -readonly [Key in keyof Elements]: Mutable<Elements[Key]> }
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

type AgentPlan = StateAgentPlan;
type PlanArtifactRef = Mutable<StatePlanArtifactRef>;
type PlanCompletionEvidence = StatePlanCompletionEvidence;
type PlanningStateKind = StatePlanningState['kind'];
type ToolApprovalPayload = StateToolApprovalPayload;
type UserInputPayload = StateUserInputPayload;
type ContextTokenEstimate = Mutable<StateContextTokenEstimate>;
type CapabilityArtifactRef = Mutable<StateCapabilityArtifactRef>;
type FilesystemPreimageArtifactRef = Mutable<StateFilesystemPreimageArtifactRef>;
type SandboxPreparationArtifactRef = Mutable<StateSandboxPreparationArtifactRef>;
type SubagentTaskArtifact = Mutable<StateSubagentTaskArtifactRef>;
type SubagentHandleArtifactRef = Mutable<StateSubagentHandleArtifactRef>;
type CapabilityBinding = Mutable<StateCapabilityBinding>;
type CapabilityDisclosure = Mutable<StateCapabilityDisclosure>;
type LoadedCapability = Mutable<StateLoadedCapability>;
type SkillActivation = StateSkillActivation;
type ToolResultMeta = StateToolResultMeta;
type ToolOutcome = ToolOutcomeV1;
type ToolOutcomeClassifierAdvice = ToolOutcomeClassifierAdviceV1;
type UnknownToolFieldsObservation = Mutable<UnknownToolFieldsObservationV1>;
type ResourceBudget = Mutable<StateResourceBudget>;
type ResourceUsage = Mutable<StateResourceUsage>;
type ResourceReservation = Mutable<StateResourceReservation>;
type ResourceWaiter = StateResourceWaiter;
type NetworkDecisionReceipt = Mutable<StateNetworkDecisionReceipt>;

type CapabilityEffectLevel = 'none' | 'read' | 'write' | 'destructive' | 'unknown';
type EffectProfile = {
  filesystem: CapabilityEffectLevel;
  network: CapabilityEffectLevel;
  externalState: CapabilityEffectLevel;
};

type ClassifiedFailure = ClassifiedFailureV1;

type RunTerminalOutcome = StateRunTerminalOutcome;

type ToolEffectClass =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';
type AuthorizationMode = 'default' | 'full_access';
type AuthorizationSource = 'user' | 'config' | 'test' | 'system';
type InteractionMode = 'accept_edits' | 'auto' | 'full';
type UserInputResult = { answer: string; answers?: Record<string, string> };

type McpProviderDirectoryStatus =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';
type McpProviderDirectorySource =
  | 'project'
  | 'user'
  | 'local'
  | 'project_legacy'
  | 'user_legacy'
  | 'project_kite_code'
  | 'project_mcp_json'
  | 'explicit';
type McpProviderDiagnosticCode =
  | 'auth_required'
  | 'url_invalid'
  | 'command_not_found'
  | 'process_exited'
  | 'connect_timeout'
  | 'discovery_timeout'
  | 'http_4xx'
  | 'http_5xx'
  | 'discovery_failed'
  | 'invalid_schema'
  | 'tool_not_discovered'
  | 'approval_required'
  | 'approval_rejected'
  | 'circuit_open'
  | 'config_conflict'
  | 'config_invalid'
  | 'unknown';
type McpProviderRecoveryAction = 'login' | 'approve' | 'retry';
type ModelCapabilitySource = 'explicit_config' | 'adapter_runtime' | 'compatibility_config';
type ContextPressure = 'unknown' | 'normal' | 'warning' | 'compact_due' | 'hard_limit';
type ProviderDataAdmissionReason =
  | 'admitted'
  | 'mandatory_policy_unavailable'
  | 'provider_content_inspection_unknown'
  | 'provider_secret_denied';

type CapabilitySearchResult = StateCapabilitySearchResult;

type SubAgentRole = 'explore' | 'plan' | 'code' | 'review';
type SubAgentStartPayload = {
  id: string;
  role: SubAgentRole;
  task: string;
  concurrencyGroupId?: string;
};
type SubAgentStepPayload = {
  id: string;
  modelInvocationId?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  durationMs?: number;
};
type SubAgentToolResultPayload = {
  id: string;
  toolName: string;
  ok: boolean;
  summary?: string;
  totalLines?: number;
  toolTokenCount?: number;
  durationMs?: number;
  failureReason?: string;
};
type SubAgentDonePayload = {
  id: string;
  modelInvocationId?: string;
  summary: string;
  toolCallCount: number;
  durationMs: number;
};
type SubAgentErrorPayload = {
  id: string;
  error: string;
  summary?: string;
  toolCallCount?: number;
  durationMs?: number;
};
type SubAgentCacheMetricsPayload = {
  subagentId: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  inputTokens: number;
};

type VerificationMode = 'not_required' | 'best_effort' | 'required';
type VerificationOutcome = 'passed' | 'failed' | 'inconclusive';
type VerificationSpec = StateVerificationSpec;
type VerificationCheckResult = StateVerificationCheckResult;

type ModelInvocationPurpose =
  | 'primary_agent'
  | 'context_compaction'
  | 'auto_review'
  | 'verification_review'
  | 'subagent';
type Sha256Digest = `sha256:${string}`;
type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'error'
  | 'other'
  | 'unknown';
type PrivateArtifactRef = {
  artifactId: string;
  kind: 'model_surface' | 'model_response';
  integrityIdentifier: string;
  byteLength: number;
};
type ModelInvocationAdmission = {
  providerAdmissionRevision: string | null;
  routeIdentityDigest: Sha256Digest;
  payloadClassificationDigest: Sha256Digest;
  admitted: boolean;
};
type ModelInvocationBudget =
  | { kind: 'reservation'; reservationId: string; parentReservationId: string | null }
  | { kind: 'no_budget'; reason: 'resource_budget_disabled' };
type ModelInvocationLimits = {
  maxAttempts: number;
  perAttemptTimeoutMs: number;
  totalTimeBudgetMs: number;
};

type SandboxExecutionBackend = 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';
type SandboxPreparationResourceSemantics = 'pure' | 'allocating';
type SubagentObservationStatus = 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'blocked';

type SubagentObservation = {
  status: SubagentObservationStatus;
};
type PrivateSuspendedSubagent = {
  storage: 'private_artifact_v1';
  subagentId: string;
  role: SubAgentRole;
  continuationId: string;
  modelInvocationOrdinal: number;
  continuationArtifact: {
    artifactId: string;
    kind: 'subagent_continuation';
    integrityIdentifier: string;
    byteLength: number;
  };
  parentInvocationId: string;
  parentAttempt: number;
  blockedTool: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
    toolCallId: string;
    runtimeToolCallId?: string;
    toolName: string;
  };
};

type RunPlanIdentity = Mutable<PlanIdentityV1>;
type WorkspaceFilesystemObservationRecord = {
  actorIdentityDigest: string;
  lexicalTargetDigest: string;
  canonicalTargetDigest: string;
  targetIdentityDigest: string;
  contentDigest: string;
};

type ResourceBudgetEventMap = {
  'resource_budget.configured': {
    type: 'resource_budget.configured';
    runId: string;
    startedAt: string;
    deadlineAt: string;
    budget: ResourceBudget;
  };
  'resource_budget.reserved': {
    type: 'resource_budget.reserved';
    reservation: ResourceReservation;
  };
  'resource_budget.dispatch_started': {
    type: 'resource_budget.dispatch_started';
    reservationId: string;
  };
  'resource_budget.reconciled': {
    type: 'resource_budget.reconciled';
    reservationId: string;
    actual: ResourceUsage;
  };
  'resource_budget.released': {
    type: 'resource_budget.released';
    reservationId: string;
    proof?: 'local_provider_admission_denied';
  };
  'resource_budget.unknown': { type: 'resource_budget.unknown'; reservationId: string };
  'resource_budget.waiter_enqueued': {
    type: 'resource_budget.waiter_enqueued';
    waiter: ResourceWaiter;
  };
  'resource_budget.waiter_promoted': {
    type: 'resource_budget.waiter_promoted';
    invocationId: string;
  };
  'resource_budget.waiter_cancelled': {
    type: 'resource_budget.waiter_cancelled';
    invocationId: string;
  };
  'resource_budget.waiter_timed_out': {
    type: 'resource_budget.waiter_timed_out';
    invocationId: string;
  };
};

type StateEventMap = ResourceBudgetEventMap & {
  'context.compaction_requested': {
    type: 'context.compaction_requested';
    compactionId: string;
    reason: 'manual' | 'auto';
    requestedAtRevision: number;
    requestedAtTurnId: string;
    force: boolean;
    estimate: ContextTokenEstimate;
    customInstructions?: string;
  };
  'context.compaction_completed': {
    type: 'context.compaction_completed';
    compactionId: string;
    sourceRevision: number;
    checkpoint: {
      compactionId: string;
      modelInvocationId?: string;
      version: 1;
      sourceRevision: number;
      sourceDigest: string;
      coveredThroughMessageId: string;
      coveredThroughTurnId: string;
      summary: string;
      inputTokensBefore: number;
      inputTokensAfter: number;
      reason: 'manual' | 'auto';
      createdAt: string;
      baseCheckpointId?: string;
    };
    durationMs?: number;
  };
  'context.compaction_failed': {
    type: 'context.compaction_failed';
    compactionId: string;
    sourceRevision: number;
    errorKind:
      | 'unsafe_boundary'
      | 'oversized_turn'
      | 'summary_model_failed'
      | 'provider_admission_denied'
      | 'summary_aborted'
      | 'empty_summary'
      | 'truncated_summary'
      | 'unexpected_tool_call'
      | 'stale_context'
      | 'invalid_candidate'
      | 'insufficient_reduction';
    message: string;
    retryable: boolean;
    requestedAtTurnId?: string;
    durationMs?: number;
  };
  'context.compaction_reset': {
    type: 'context.compaction_reset';
    checkpointId: string;
    reason: 'manual';
  };
  'context.hard_block_cleared': {
    type: 'context.hard_block_cleared';
    reason:
      | 'unsafe_context_projection'
      | 'corrupted_runtime_state'
      | 'corrupted_event_tail'
      | 'unrecoverable_checkpoint'
      | 'runtime_invariant_violation';
    sourceDigest: string;
  };
  'context.hard_blocked': {
    type: 'context.hard_blocked';
    reason:
      | 'unsafe_context_projection'
      | 'corrupted_runtime_state'
      | 'corrupted_event_tail'
      | 'unrecoverable_checkpoint'
      | 'runtime_invariant_violation';
    sourceDigest: string;
    message: string;
    createdAtTurnId: string;
  };
  'capability.bindings_issued': {
    type: 'capability.bindings_issued';
    catalogRevision: string;
    bindings: CapabilityBinding[];
    disclosures?: CapabilityDisclosure[];
    loadedCapabilities?: LoadedCapability[];
    searchId?: string;
  };
  'capability.search_completed': {
    type: 'capability.search_completed';
    result: CapabilitySearchResult;
  };
  'skill.catalog_refreshed': { type: 'skill.catalog_refreshed'; catalogRevision: string };
  'skill.activation_started': { type: 'skill.activation_started'; activation: SkillActivation };
  'skill.frame_closed': {
    type: 'skill.frame_closed';
    activationId: string;
    status: 'closed' | 'invalidated';
    reason: string;
    closedAt: string;
    output?: Record<string, unknown>;
  };
  'capability.invocation_recorded': {
    type: 'capability.invocation_recorded';
    invocationId: string;
    toolCallId: string;
    capabilityId: string;
    capabilityRevision: string;
    taskId?: string;
    planId?: string;
    planStepId?: string;
    argumentsDigest: string;
    authorizationDigest: string;
    admissionDigest?: string;
    effectiveEffectsDigest: string;
    effectiveEffects: EffectProfile;
    recordedAt: string;
    receiptRequirement?:
      | 'observation_receipt'
      | 'effect_receipt'
      | 'control_receipt'
      | 'not_applicable';
    retryEligibility?: 'none' | 'safe_read_candidate' | 'idempotency_key_candidate';
    idempotencyKey?: string;
  };
  'capability.execution_started': {
    type: 'capability.execution_started';
    invocationId: string;
    startedAt: string;
    attempt?: number;
  };
  'capability.filesystem_mutation_ready': {
    type: 'capability.filesystem_mutation_ready';
    invocationId: string;
    attempt: number;
    intentDigest: string;
    operationDigest: string;
    targetIdentityDigest: string;
    preimageDigest: string | null;
    preimageArtifact: FilesystemPreimageArtifactRef;
    readyDigest: string;
    readyAt: string;
  };
  'capability.filesystem_intent_recorded': {
    type: 'capability.filesystem_intent_recorded';
    invocationId: string;
    attempt: number;
    capabilityRevision: string;
    argumentsDigest: string;
    admissionDigest: string;
    operationDigest: string;
    searchBoundaryDigest: string | null;
    lexicalTargetDigest: string;
    canonicalWorkspaceDigest: string;
    protectedPathRevision: string;
    approvalSummaryDigest: string;
    effectiveEffectsDigest: string;
    intentDigest: string;
    recordedAt: string;
  };
  'capability.sandbox_preparation_intent_recorded': {
    type: 'capability.sandbox_preparation_intent_recorded';
    invocationId: string;
    attempt: number;
    toolCallId: string;
    capabilityId: string;
    capabilityRevision: string;
    canonicalWorkspace: string;
    effectiveEffectsDigest: string;
    admissionDigest: string;
    preparationDigest: string;
    commandDigest: string;
    executionBoundaryDigest: string;
    resourceSemantics: 'allocating';
    intentDigest: string;
    recordedAt: string;
  };
  'capability.sandbox_preparation_ready': {
    type: 'capability.sandbox_preparation_ready';
    invocationId: string;
    attempt: number;
    intentDigest: string;
    preparationDigest: string;
    commandDigest: string;
    planDigest: string;
    backend: SandboxExecutionBackend;
    backendCapabilitiesDigest: string;
    enforcement: 'full' | 'partial';
    resourceSemantics: SandboxPreparationResourceSemantics;
    cleanupDigest: string;
    preparationArtifact: SandboxPreparationArtifactRef;
    readyDigest: string;
    readyAt: string;
  };
  'capability.sandbox_execution_dispatch_intent_recorded': {
    type: 'capability.sandbox_execution_dispatch_intent_recorded';
    invocationId: string;
    attempt: number;
    readyDigest: string;
    planDigest: string;
    dispatchId: string;
    supervisorNonce: string;
    dispatchIntentDigest: string;
    recordedAt: string;
  };
  'capability.sandbox_execution_supervisor_started': {
    type: 'capability.sandbox_execution_supervisor_started';
    invocationId: string;
    attempt: number;
    dispatchId: string;
    dispatchIntentDigest: string;
    supervisorPid: number;
    processGroupId: number;
    processStartIdentity: string;
    startedAt: string;
  };
  'capability.sandbox_disposal_started': {
    type: 'capability.sandbox_disposal_started';
    invocationId: string;
    attempt: number;
    readyDigest: string;
    lifecycleIntentDigest: string;
    startedAt: string;
  };
  'capability.sandbox_disposal_completed': {
    type: 'capability.sandbox_disposal_completed';
    invocationId: string;
    attempt: number;
    readyDigest: string;
    lifecycleIntentDigest: string;
    cleanupAttempt: number;
    disposed: boolean;
    disposedAt: string;
  };
  'capability.sandbox_preparation_abandonment_started': {
    type: 'capability.sandbox_preparation_abandonment_started';
    invocationId: string;
    attempt: number;
    intentDigest: string;
    lifecycleIntentDigest: string;
    startedAt: string;
  };
  'capability.sandbox_preparation_abandonment_completed': {
    type: 'capability.sandbox_preparation_abandonment_completed';
    invocationId: string;
    attempt: number;
    intentDigest: string;
    lifecycleIntentDigest: string;
    cleanupAttempt: number;
    disposed: boolean;
    disposedAt: string;
  };
  'capability.subagent_dispatch_intent_recorded': {
    type: 'capability.subagent_dispatch_intent_recorded';
    invocationId: string;
    attempt: number;
    purpose: 'start' | 'resume';
    childInvocationId: string;
    taskArtifact: SubagentTaskArtifact;
    dispatchIntentDigest: string;
    recordedAt: string;
  };
  'capability.subagent_handle_recorded': {
    type: 'capability.subagent_handle_recorded';
    invocationId: string;
    attempt: number;
    dispatchIntentDigest: string;
    handleArtifact: SubagentHandleArtifactRef;
    handleIntegrityIdentifier: string;
    recordedAt: string;
  };
  'capability.subagent_observation_recorded': {
    type: 'capability.subagent_observation_recorded';
    invocationId: string;
    attempt: number;
    dispatchIntentDigest: string;
    status: SubagentObservation['status'];
    observedAt: string;
  };
  'capability.subagent_cleanup_started': {
    type: 'capability.subagent_cleanup_started';
    invocationId: string;
    attempt: number;
    dispatchIntentDigest: string;
    cleanupAttempt: number;
    cleanupKind: 'undispatched' | 'handle_reconcile';
    startedAt: string;
  };
  'capability.subagent_cleanup_completed': {
    type: 'capability.subagent_cleanup_completed';
    invocationId: string;
    attempt: number;
    dispatchIntentDigest: string;
    cleanupAttempt: number;
    cleanupKind: 'undispatched' | 'handle_reconcile';
    cleanupConfirmed: boolean;
    completedAt: string;
  };
  'capability.execution_result_recorded': {
    type: 'capability.execution_result_recorded';
    invocationId: string;
    resultDigest: string;
    evidenceDigest: string;
    recordedAt: string;
    artifact: CapabilityArtifactRef;
    externalReferences?: readonly string[];
  };
  'capability.execution_succeeded': {
    type: 'capability.execution_succeeded';
    invocationId: string;
    resultDigest: string;
    evidenceDigest: string;
    finishedAt: string;
    artifact?: CapabilityArtifactRef;
    externalReferences?: readonly string[];
    filesystemObservation?: WorkspaceFilesystemObservationRecord;
  };
  'capability.execution_failed': {
    type: 'capability.execution_failed';
    invocationId: string;
    error: string;
    finishedAt: string;
    resultDigest?: string;
    evidenceDigest?: string;
    artifact?: CapabilityArtifactRef;
  };
  'capability.execution_unknown': {
    type: 'capability.execution_unknown';
    invocationId: string;
    reason: string;
    finishedAt: string;
  };
  'capability.reconciliation_resolved': {
    type: 'capability.reconciliation_resolved';
    invocationId: string;
    decision: 'confirmed_success' | 'confirmed_failure' | 'waived';
    reconciledAt: string;
    reason?: string;
  };
  'verification.requested': {
    type: 'verification.requested';
    verificationId: string;
    taskId?: string;
    mode: VerificationMode;
    spec: VerificationSpec;
    requestedAt: string;
  };
  'verification.started': {
    type: 'verification.started';
    verificationId: string;
    attempt: number;
    startedAt: string;
  };
  'verification.check_completed': {
    type: 'verification.check_completed';
    verificationId: string;
    result: VerificationCheckResult;
  };
  'verification.completed': {
    type: 'verification.completed';
    verificationId: string;
    outcome: VerificationOutcome;
    completedAt: string;
  };
  'verification.repair_requested': {
    type: 'verification.repair_requested';
    verificationId: string;
    repairAttempt: number;
    instruction: string;
    requestedAt: string;
  };
  'verification.replan_requested': {
    type: 'verification.replan_requested';
    verificationId: string;
    instruction: string;
    requestedAt: string;
  };
  'verification.waived': {
    type: 'verification.waived';
    verificationId: string;
    actor: 'user';
    reason: string;
    waivedAt: string;
  };
  'verification.compensation_requested': {
    type: 'verification.compensation_requested';
    verificationId: string;
    requestedAt: string;
  };
  'verification.compensation_completed': {
    type: 'verification.compensation_completed';
    verificationId: string;
    outcome: VerificationOutcome;
    summary: string;
    completedAt: string;
  };
  'tool.queued': {
    type: 'tool.queued';
    toolCallId: string;
    modelInvocationId?: string;
    taskId?: string;
    name: string;
    args: unknown;
    modelMessageId?: string;
    ordinal?: number;
    effectClass?: ToolEffectClass;
    sideEffect?: boolean;
    classificationReason?: string;
    bindingId?: string;
    capabilityId?: string;
    capabilityRevision?: string;
    invocationFingerprint?: string;
    recoveryOf?: string;
    recoveryMode?: ToolRecoveryAttemptModeV1;
    unknownFields?: UnknownToolFieldsObservation;
    createdAt?: string;
  };
  'tool.started': { type: 'tool.started'; toolCallId: string; createdAt?: string };
  'tool.progress': {
    type: 'tool.progress';
    toolCallId: string;
    chunk: string;
    stream: 'stdout' | 'stderr';
    lineCount?: number;
  };
  'network.admission_decided': {
    type: 'network.admission_decided';
    toolCallId: string;
    decision: NetworkDecisionReceipt;
  };
  'tool.finished': {
    type: 'tool.finished';
    toolCallId: string;
    createdAt?: string;
    name: string;
    result: {
      ok: boolean;
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      status?: 'success' | 'error' | 'exhausted';
      totalLines?: number;
      toolTokenCount?: number;
      userInput?: UserInputResult;
      terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
      resultMeta?: ToolResultMeta;
    };
    outcomeV1?: ToolOutcome;
    classifierAdviceV1?: ToolOutcomeClassifierAdvice;
    classifierDiagnostic?: 'classifier_threw';
  };
  'tool.failed': {
    type: 'tool.failed';
    toolCallId: string;
    createdAt?: string;
    outcomeV1?: ToolOutcome;
    failure: ClassifiedFailure;
  };
  'tool.rejected': {
    type: 'tool.rejected';
    toolCallId: string;
    reason: string;
    failure?: ClassifiedFailure;
    createdAt?: string;
    outcomeV1?: ToolOutcome;
  };
  'tool.cancelled': {
    type: 'tool.cancelled';
    toolCallId: string;
    reason: string;
    createdAt?: string;
    outcomeV1?: ToolOutcome;
  };
  'tool.retry_recorded': {
    type: 'tool.retry_recorded';
    toolCallId: string;
    failure: ClassifiedFailure;
    outcomeV1: ToolOutcome;
    recoveryOf: string;
    retryAttempt: 1;
  };
  'user_input.requested': {
    type: 'user_input.requested';
    interactionId: string;
    toolCallId: string;
    request: UserInputPayload;
  };
  'user_input.answered': {
    type: 'user_input.answered';
    interactionId: string;
    toolCallId: string;
    answer: string;
    answers?: Record<string, string>;
  };
  'user_input.cancelled': {
    type: 'user_input.cancelled';
    interactionId: string;
    toolCallId: string;
    reason: string;
  };
  'plan.review_requested': {
    type: 'plan.review_requested';
    interactionId: string;
    toolCallId: string;
    taskId: string;
    plan: AgentPlan;
    planSummary: string;
    planId: string;
    version: number;
    structuralDigest: string;
    artifact: PlanArtifactRef;
  };
  'plan.approved': {
    type: 'plan.approved';
    interactionId: string;
    toolCallId: string;
    planId: string;
    version: number;
    structuralDigest: string;
    executionMode: 'accept_edits' | 'auto';
  };
  'plan.revision_requested': {
    type: 'plan.revision_requested';
    interactionId: string;
    toolCallId: string;
    planId: string;
    version: number;
    structuralDigest: string;
    feedback: string;
  };
  'plan.review_cancelled': {
    type: 'plan.review_cancelled';
    interactionId: string;
    toolCallId: string;
    planId: string;
    version: number;
    structuralDigest: string;
    reason: string;
  };
  'plan.replan_requested': {
    type: 'plan.replan_requested';
    toolCallId: string;
    reason: string;
    supersedesPlanVersion: number;
  };
  'task.started': { type: 'task.started'; taskId: string; userGoal: string; turnId: string };
  'planning.entered': {
    type: 'planning.entered';
    taskId: string;
    source: 'user_command' | 'model_request';
  };
  'planning.exited': { type: 'planning.exited'; taskId: string; reason?: string };
  'task.completed': { type: 'task.completed'; taskId: string; turnId: string };
  'task.cancelled': { type: 'task.cancelled'; taskId: string; reason: string };
  'approval.requested': {
    type: 'approval.requested';
    interactionId: string;
    toolCallId: string;
    approval: ToolApprovalPayload;
    createdAt?: string;
  };
  'approval.granted': {
    type: 'approval.granted';
    interactionId: string;
    toolCallId: string;
    grant: 'approve_once' | 'same_command' | 'full_access';
    createdAt?: string;
  };
  'approval.rejected': {
    type: 'approval.rejected';
    interactionId: string;
    toolCallId: string;
    reason: string;
    failure?: ClassifiedFailure;
    createdAt?: string;
    outcomeV1?: ToolOutcome;
  };
  'provider.action_required': {
    type: 'provider.action_required';
    interactionId: string;
    providerId: string;
    action: McpProviderRecoveryAction;
    originatingToolCallId: string;
  };
  'provider.action_started': { type: 'provider.action_started'; interactionId: string };
  'provider.action_completed': {
    type: 'provider.action_completed';
    interactionId: string;
    originatingToolCallId: string;
    providerDirectoryRevision?: string;
  };
  'provider.action_deferred': {
    type: 'provider.action_deferred';
    interactionId: string;
    originatingToolCallId: string;
  };
  'provider.action_failed': {
    type: 'provider.action_failed';
    interactionId: string;
    originatingToolCallId: string;
    failureCode: 'authentication_failed' | 'approval_denied' | 'provider_unavailable' | 'unknown';
  };
  'provider.admission_required': {
    type: 'provider.admission_required';
    interactionId: string;
    providerId: string;
    source: McpProviderDirectorySource;
    providerStatus: McpProviderDirectoryStatus;
    diagnosticCode?: McpProviderDiagnosticCode;
    retryable: boolean;
  };
  'provider.admission_retry_requested': {
    type: 'provider.admission_retry_requested';
    interactionId: string;
  };
  'provider.admission_retry_failed': {
    type: 'provider.admission_retry_failed';
    interactionId: string;
    providerStatus: McpProviderDirectoryStatus;
    diagnosticCode?: McpProviderDiagnosticCode;
  };
  'provider.admission_satisfied': {
    type: 'provider.admission_satisfied';
    interactionId: string;
    providerDirectoryRevision: string;
  };
  'provider.admission_waived': {
    type: 'provider.admission_waived';
    interactionId: string;
    providerId: string;
    source: McpProviderDirectorySource;
    reason: 'user_session_waiver';
    waivedAt: string;
  };
  'provider.admission_cancelled': {
    type: 'provider.admission_cancelled';
    interactionId: string;
    providerId: string;
  };
  'authorization.changed': {
    type: 'authorization.changed';
    mode: AuthorizationMode;
    commandGrants?: Record<
      string,
      {
        workspace: string;
        threadId: string;
        command: string;
        source: AuthorizationSource;
        grantedAt: string;
        expiresAt?: string;
      }
    >;
    modeSource?: AuthorizationSource;
    modeGrantedAt?: string;
  };
  'interaction_mode.changed': {
    type: 'interaction_mode.changed';
    mode: InteractionMode;
    source: 'user';
    changedAt: string;
  };
  'auto_review.requested': {
    type: 'auto_review.requested';
    reviewId: string;
    toolCallId: string;
    toolName: string;
    reason: string;
    approval: ToolApprovalPayload;
    requestFingerprint?: string;
    createdAt?: string;
  };
  'auto_review.completed': {
    type: 'auto_review.completed';
    reviewId: string;
    toolCallId: string;
    modelInvocationId?: string;
    result:
      | {
          ok: true;
          approved: boolean;
          escalatedToUser?: true;
          grant?: string;
          reason?: string;
          reviewerModelName: string;
          durationMs: number;
        }
      | {
          ok: false;
          approved: false;
          failureType: 'technical' | 'invalid_response';
          reason?: string;
          reviewerModelName: string;
          durationMs: number;
        };
    outcomeV1?: ToolOutcome;
    createdAt?: string;
  };
  'turn.started': { type: 'turn.started'; turnId: string };
  'turn.completed': { type: 'turn.completed'; turnId: string };
  'turn.aborted': {
    type: 'turn.aborted';
    turnId: string;
    reason: string;
    cause?: 'user' | 'error';
  };
  'user.message_appended': {
    type: 'user.message_appended';
    messageId: string;
    content: string;
    userGoal?: string;
    createdAt?: string;
  };
  'user.command_invoked': {
    type: 'user.command_invoked';
    commandId: string;
    command: string;
  };
  'model.requested': {
    type: 'model.requested';
    requestId: string;
    invocationId?: string;
  };
  'model.invocation_prepared': {
    type: 'model.invocation_prepared';
    invocationId: string;
    purpose: ModelInvocationPurpose;
    surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' };
    surfaceIntegrityIdentifier: string;
    routeFingerprint: Sha256Digest;
    admission: ModelInvocationAdmission;
    budget: ModelInvocationBudget;
    limits: ModelInvocationLimits;
    preparedStateRevision: number;
    parentInvocationId: string | null;
    parentToolCallId: string | null;
  };
  'model.invocation_attempt_started': {
    type: 'model.invocation_attempt_started';
    invocationId: string;
    attempt: number;
    maxAttempts: number;
  };
  'model.invocation_completed': {
    type: 'model.invocation_completed';
    invocationId: string;
    responseArtifact: PrivateArtifactRef & { kind: 'model_response' };
    finishReason: ModelFinishReason;
  };
  'model.invocation_interrupted': {
    type: 'model.invocation_interrupted';
    invocationId: string;
    dispatchCertainty: 'none' | 'attempted' | 'unknown';
    reasonCode:
      | 'runtime_restored'
      | 'attempts_exhausted'
      | 'cancelled'
      | 'cancelled_before_dispatch'
      | 'provider_failure'
      | 'surface_identity_changed'
      | 'persistence_unavailable';
  };
  'model.invocation_evidence_unavailable': {
    type: 'model.invocation_evidence_unavailable';
    invocationId: string;
    reasonCode: 'artifact_missing' | 'artifact_corrupt';
  };
  'provider.readiness_intent_recorded': {
    type: 'provider.readiness_intent_recorded';
    readinessKey: string;
    lifecycleId: string;
    providerId: string;
    routeRevision: string;
    executionBoundaryDigest: string;
    requestedAt: string;
    expiresAt: string;
    maxAttempts: number;
  };
  'provider.readiness_waiter_registered': {
    type: 'provider.readiness_waiter_registered';
    readinessKey: string;
    lifecycleId: string;
    waiterId: string;
    toolCallId: string;
    registeredAt: string;
  };
  'provider.readiness_attempt_started': {
    type: 'provider.readiness_attempt_started';
    readinessKey: string;
    lifecycleId: string;
    attempt: number;
    maxAttempts: number;
    startedAt: string;
  };
  'provider.readiness_succeeded': {
    type: 'provider.readiness_succeeded';
    readinessKey: string;
    lifecycleId: string;
    providerDirectoryRevision: string;
    readyAt: string;
    expiresAt: string;
  };
  'provider.readiness_failed': {
    type: 'provider.readiness_failed';
    readinessKey: string;
    lifecycleId: string;
    failure: ClassifiedFailure;
    dispatchCertainty: 'none' | 'attempted';
    failedAt: string;
  };
  'model.reasoning_delta': { type: 'model.reasoning_delta'; segmentId?: string; text: string };
  'model.reasoning_completed': {
    type: 'model.reasoning_completed';
    segmentId: string;
    text: string;
  };
  'model.text_delta': { type: 'model.text_delta'; text: string };
  'model.responded': {
    type: 'model.responded';
    messageId: string;
    invocationId?: string;
    createdAt?: string;
    durationMs?: number;
    toolCalls?: Array<{
      id: string;
      name: string;
      args: unknown;
      canonicalInvocationFingerprint?: string;
    }>;
    reasoningText?: string;
    text?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
  'model.retry': {
    type: 'model.retry';
    attempt: number;
    maxAttempts: number;
    error: string;
    delayMs: number;
  };
  'model.cache_metrics': {
    type: 'model.cache_metrics';
    inputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    hitRate: number;
  };
  'model.context_metrics': {
    type: 'model.context_metrics';
    modelName: string;
    contextWindowTokens?: number;
    contextWindowSource?: ModelCapabilitySource;
    tokenizerSource?: ModelCapabilitySource;
    usableInputTokens?: number;
    reservedOutputTokens?: number;
    providerSafetyMarginTokens?: number;
    totalInputTokens: number;
    utilization?: number;
    status: ContextPressure;
    estimate: ContextTokenEstimate;
  };
  'run.completed': {
    type: 'run.completed';
    turnId: string;
    output: string;
    completionGuardVersion?: CompletionGuardVersion;
    planIdentity?: RunPlanIdentity;
    outcome?: RunTerminalOutcome;
  };
  'completion.blocked': {
    type: 'completion.blocked';
    turnId: string;
    guardVersion: CompletionGuardVersion;
    code: CompletionBlockerCode;
    nextAction: CompletionNextAction;
    planning: PlanningStateKind;
    correctionAttempt: number;
    planIdentity?: RunPlanIdentity;
  };
  'run.error': {
    type: 'run.error';
    message: string;
    recoverable: boolean;
    failure?: ClassifiedFailure;
    effectId?: string;
    turnId?: string;
    outcome?: RunTerminalOutcome;
  };
  'runtime.action_ignored': {
    type: 'runtime.action_ignored';
    interactionId?: string;
    reason: string;
  };
  'runtime.cancellation_diagnostic': {
    type: 'runtime.cancellation_diagnostic';
    toolCallId: string;
    failure: ClassifiedFailure;
    unconfirmedDescendantCount: number;
  };
  'provider.admission_status': {
    type: 'provider.admission_status';
    status: 'ready' | 'blocked';
    reason: ProviderDataAdmissionReason;
    admissionRevision?: string;
  };
  'plan.drafted': {
    type: 'plan.drafted';
    toolCallId: string;
    taskId: string;
    plan: AgentPlan;
    structuralHash: string;
    planId: string;
    version: number;
    planSchemaVersion: 2;
    supersedesPlanVersion?: number;
    replanReason?: string;
    artifact: PlanArtifactRef;
  };
  'plan.progress_updated': {
    type: 'plan.progress_updated';
    toolCallId: string;
    taskId: string;
    plan: AgentPlan;
    planId: string;
    version: number;
    structuralDigest: string;
    completionEvidence: PlanCompletionEvidence;
  };
  'plan.completed': {
    type: 'plan.completed';
    toolCallId: string;
    taskId: string;
    plan: AgentPlan;
    planId: string;
    version: number;
    structuralDigest: string;
    completionEvidence: PlanCompletionEvidence;
  };
  'approval.command_replaced': {
    type: 'approval.command_replaced';
    interactionId: string;
    command: string;
  };
  'tool.file_change': {
    type: 'tool.file_change';
    toolCallId: string;
    path: string;
    kind: 'add' | 'edit' | 'delete';
    linesAdded?: number;
    linesRemoved?: number;
    preview?: string;
  };
  'subagent.started': { type: 'subagent.started'; subagent: SubAgentStartPayload };
  'subagent.step': { type: 'subagent.step'; subagent: SubAgentStepPayload };
  'subagent.tool_result': { type: 'subagent.tool_result'; subagent: SubAgentToolResultPayload };
  'subagent.completed': { type: 'subagent.completed'; subagent: SubAgentDonePayload };
  'subagent.failed': { type: 'subagent.failed'; subagent: SubAgentErrorPayload };
  'subagent.cache_metrics': {
    type: 'subagent.cache_metrics';
    subagent: SubAgentCacheMetricsPayload;
  };
  'subagent.suspended': {
    type: 'subagent.suspended';
    toolCallId: string;
    snapshot: PrivateSuspendedSubagent;
  };
  'subagent.approval_deferred': { type: 'subagent.approval_deferred'; toolCallId: string };
  'subagent.recovery_journal_merged': {
    type: 'subagent.recovery_journal_merged';
    toolCallId: string;
    journal: ToolRecoveryJournalV1;
  };
};

// Named State event views remain Kernel-owned aliases.  They are exported
// for callers that need a discriminated event payload without reintroducing a
// Core runtime-events module as a second type authority.
export type ContextCompactionRequestedEvent = StateEventMap['context.compaction_requested'];
export type ContextCompactionCompletedEvent = StateEventMap['context.compaction_completed'];
export type ContextCompactionFailedEvent = StateEventMap['context.compaction_failed'];
export type ContextCompactionResetEvent = StateEventMap['context.compaction_reset'];

type EventForType<EventType extends RuntimeEventType> = StateEventMap[EventType];

/** The State union has one exact object type for each of its 135 discriminants. */
export type KernelEvent = {
  [EventType in RuntimeEventType]: EventForType<EventType>;
}[RuntimeEventType];

export type RuntimeEvent = KernelEvent;

export interface KernelEventEnvelope<Event extends KernelEvent = KernelEvent> {
  readonly eventId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly payload: Event;
}
