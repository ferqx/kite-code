/**
 * State 25 persisted shape.
 *
 * The Kernel owns the top-level shape and its format identity. Durable State
 * records use local, provider-neutral DTOs; only opaque artifact/provider
 * payloads remain JSON objects. The Kernel imports no Host, Builtin, or
 * runtime-spi types.
 */

import type { ToolRecoveryJournal } from './recovery';

export type AuthorizationMode = 'default' | 'full_access';
export type InteractionMode = 'accept_edits' | 'auto' | 'full';
export type WorkspaceAccess = 'write';

export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export interface AgentPlanStep {
  readonly step: string;
  readonly status: PlanStatus;
  readonly id?: string;
  readonly note?: string;
}
export interface AgentPlan {
  readonly name: string;
  readonly description: string;
  readonly status: PlanStatus;
  readonly steps: readonly AgentPlanStep[];
}
export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: PlanStatus;
  readonly note?: string;
}
export interface PlanCompletionEvidence {
  readonly schemaVersion: 1;
  readonly verification: readonly {
    readonly verificationId: string;
    readonly outcome: 'passed' | 'waived';
  }[];
  readonly execution: readonly { readonly toolCallId: string; readonly outcome: 'succeeded' }[];
  readonly skipped: readonly { readonly stepId: string; readonly reasonCode: string }[];
  readonly unresolved: readonly {
    readonly kind: 'failure' | 'approval';
    readonly referenceId: string;
  }[];
}
export interface PlanArtifactRef {
  readonly artifactId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly version: number;
  readonly fileName: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly structuralDigest: string;
  readonly byteLength: number;
}

export interface AgentUserInputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}
export interface AgentUserInputQuestion {
  readonly id?: string;
  readonly question: string;
  readonly options: readonly AgentUserInputOption[];
  readonly recommended?: string;
  readonly allow_free_text?: boolean;
}
export interface AgentUserInputPayload {
  readonly question: string;
  readonly options: readonly AgentUserInputOption[];
  readonly allow_free_text: boolean;
  readonly context?: string;
  readonly recommended?: string;
  readonly questions?: readonly AgentUserInputQuestion[];
}
export type AgentShellApprovalGrant = 'approve_once' | 'same_command' | 'full_access';
export interface AgentToolApprovalPayload {
  readonly scope: 'once';
  readonly callId?: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly tool: string;
  readonly command: string;
  readonly risk:
    | 'read'
    | 'plan'
    | 'write_file'
    | 'execute_code'
    | 'destructive'
    | 'network'
    | 'vcs_mutation'
    | 'mcp'
    | 'unknown';
  readonly approvalHash: string;
  readonly summary: string;
  readonly reason: string;
  readonly expectedEffects: readonly string[];
  readonly grantOptions: readonly AgentShellApprovalGrant[];
  readonly recommendedGrant: AgentShellApprovalGrant;
  readonly plan?: AgentPlan;
  readonly subagentId?: string;
  readonly reviewFailure?: string;
}
export interface PlanDocument {
  readonly planSchemaVersion: 2;
  readonly planId: string;
  readonly version: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly steps: readonly PlanStep[];
  readonly structuralDigest: string;
  readonly createdAtTurnId: string;
  readonly updatedAtTurnId: string;
  readonly supersedesPlanVersion?: number;
  readonly replanReason?: string;
  readonly completionEvidence: PlanCompletionEvidence;
  readonly artifact?: PlanArtifactRef;
}
export type PlanningState =
  | { readonly kind: 'building_without_plan' }
  | { readonly kind: 'planning_empty' }
  | {
      readonly kind: 'planning_draft';
      readonly document: PlanDocument;
      readonly revisionFeedback?: string;
    }
  | {
      readonly kind: 'replanning_draft';
      readonly document: PlanDocument;
      readonly supersedesPlanVersion: number;
      readonly replanReason: string;
      readonly revisionFeedback?: string;
    }
  | {
      readonly kind: 'awaiting_review';
      readonly document: PlanDocument;
      readonly interactionId: string;
      readonly exitToolCallId: string;
    }
  | {
      readonly kind: 'executing';
      readonly document: PlanDocument;
      readonly executionMode: 'accept_edits' | 'auto';
      readonly approvedAtTurnId: string;
    }
  | {
      readonly kind: 'completed';
      readonly document: PlanDocument;
      readonly completedAtTurnId: string;
    }
  | {
      readonly kind: 'cancelled';
      readonly document?: PlanDocument;
      readonly reason: string;
      readonly cancelledAtTurnId: string;
    };

/** The only State format emitted by the RA production runtime. */
export const RUNTIME_STATE_SCHEMA_VERSION = 26 as const;
export const RUNTIME_STATE_FORMAT_EPOCH = 'kite-runtime-modularization-v1-2026-08-19' as const;
export const APPLIED_EVENT_ID_TAIL_LIMIT = 4096 as const;

export type JsonPrimitive = string | number | boolean | null;
/** Structural JSON object marker; concrete State DTOs remain assignable. */
export type JsonObject = object;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export type AgentTerminalReasonCode =
  | 'completed'
  | 'artifact_invalid'
  | 'profile_invalid'
  | 'digest_invalid'
  | 'workspace_untrusted'
  | 'sandbox_unavailable'
  | 'network_unavailable'
  | 'worktree_unavailable'
  | 'model_retry_exhausted'
  | 'provider_unavailable'
  | 'mcp_unavailable'
  | 'persistence_unavailable'
  | 'budget_exhausted'
  | 'resource_saturated'
  | 'tool_concurrency_saturated'
  | 'shell_concurrency_saturated'
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'compaction_unqualified'
  | 'compaction_failed'
  | 'verification_failed'
  | 'verification_inconclusive'
  | 'mandatory_policy_unavailable'
  | 'blocked'
  | 'unknown';

export interface AgentRunTerminalOutcome {
  readonly version: 1;
  readonly status:
    | 'completed'
    | 'aborted'
    | 'blocked'
    | 'unknown'
    | 'budget_exhausted'
    | 'resource_saturated';
  readonly reasonCode: AgentTerminalReasonCode;
  readonly knownExternalEffects: 'none' | 'known' | 'unknown';
  readonly safeRetry: boolean;
  readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  readonly pendingVerification: boolean;
}

export interface AgentSessionState {
  readonly threadId: string;
  readonly userId: string;
  readonly workspace: string;
  /** RA project binding for State sessions. */
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
}

export interface AgentTranscriptMessageMeta {
  readonly messageId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly createdAt: string;
}
export interface AgentTranscriptToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly canonicalInvocationFingerprint?: string;
}
export type AgentTranscriptMessage =
  | (AgentTranscriptMessageMeta & { readonly kind: 'user'; readonly content: string })
  | (AgentTranscriptMessageMeta & { readonly kind: 'runtime'; readonly content: string })
  | (AgentTranscriptMessageMeta & {
      readonly kind: 'assistant';
      readonly content?: string;
      readonly reasoningText?: string;
      readonly toolCalls: readonly AgentTranscriptToolCall[];
    })
  | (AgentTranscriptMessageMeta & {
      readonly kind: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly ok: boolean;
      readonly resultMeta?: AgentToolResultMeta;
    });

export interface AgentTurnState {
  readonly turnId: string;
  readonly turnIndex: number;
  readonly status: 'active' | 'completed' | 'aborted';
  readonly abortReason?: string;
  readonly abortCause?: 'user' | 'error';
}

export interface AgentTranscriptState {
  readonly messages: readonly AgentTranscriptMessage[];
  readonly final?: string;
}

export interface ResourceBudget {
  readonly version: 1;
  readonly maxRunDurationMs: number;
  readonly maxTurns: number;
  readonly maxModelRequests: number;
  readonly maxToolInvocations: number;
  readonly maxRunInputTokens: number;
  readonly maxRunOutputTokens: number;
  readonly maxConcurrentSubagents: number;
  readonly maxConcurrentWriters: number;
  readonly maxConcurrentToolInvocations: number;
  readonly maxConcurrentShellInvocations: number;
  readonly maxConcurrencyWaitMs: number;
  readonly maxArtifactBytes: number;
}

export interface ResourceUsage {
  readonly counters: {
    readonly turns: number;
    readonly modelRequests: number;
    readonly toolInvocations: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly artifactBytes: number;
  };
  readonly gauges: {
    readonly elapsedRunMs: number;
    readonly activeSubagents: number;
    readonly activeWriters: number;
    readonly activeToolInvocations: number;
    readonly activeShellInvocations: number;
  };
  readonly source: 'actual' | 'versioned_upper_bound';
  readonly estimatorVersion?: string;
}

export type ResourceReservationState =
  | 'reserved'
  | 'dispatch_started'
  | 'reconciled'
  | 'released'
  | 'unknown';
export interface ResourceReservation {
  readonly version: 1;
  readonly reservationId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly parentReservationId?: string;
  readonly resourceKind:
    | 'model'
    | 'tool'
    | 'mcp'
    | 'skill'
    | 'subagent'
    | 'verification'
    | 'compaction'
    | 'artifact';
  readonly executableUpperBound: ResourceUsage;
  readonly actual?: ResourceUsage;
  readonly state: ResourceReservationState;
}
export interface ResourceWaiter {
  readonly version: 1;
  readonly runId: string;
  readonly invocationId: string;
  readonly requiredPermits: readonly ['tool'] | readonly ['tool', 'shell_invocation'];
  readonly sequence: number;
  readonly enqueuedAt: string;
  readonly deadlineAt: string;
  readonly state: 'waiting' | 'promoted' | 'cancelled' | 'timed_out';
}

export type ContextCompactionReason = 'manual' | 'auto';
export type ContextHardBlockReason =
  | 'unsafe_context_projection'
  | 'corrupted_runtime_state'
  | 'corrupted_event_tail'
  | 'unrecoverable_checkpoint'
  | 'runtime_invariant_violation';
export interface ContextCompactionCheckpoint {
  readonly compactionId: string;
  readonly modelInvocationId?: string;
  readonly version: 1;
  readonly sourceRevision: number;
  readonly sourceDigest: string;
  readonly coveredThroughMessageId: string;
  readonly coveredThroughTurnId: string;
  readonly summary: string;
  readonly inputTokensBefore: number;
  readonly inputTokensAfter: number;
  readonly reason: ContextCompactionReason;
  readonly createdAt: string;
  readonly baseCheckpointId?: string;
}
export interface ContextTokenEstimate {
  readonly systemTokens: number;
  readonly toolSchemaTokens: number;
  readonly transcriptTokens: number;
  readonly summaryTokens: number;
  readonly dynamicRuntimeTokens: number;
  readonly framingTokens: number;
  readonly totalInputTokens: number;
}
export interface PendingContextCompaction {
  readonly compactionId: string;
  readonly reason: ContextCompactionReason;
  readonly requestedAtRevision: number;
  readonly requestedAtTurnId: string;
  readonly force: boolean;
  readonly estimate: ContextTokenEstimate;
  readonly customInstructions?: string;
}
export type ContextCompactionErrorKind =
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
export interface ContextCompactionFailure {
  readonly compactionId: string;
  readonly sourceRevision: number;
  readonly errorKind: ContextCompactionErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly reason?: ContextCompactionReason;
  readonly requestedAtTurnId?: string;
}
export type ContextHistoryEntry =
  | { readonly kind: 'completed'; readonly checkpoint: ContextCompactionCheckpoint }
  | { readonly kind: 'failed'; readonly failure: ContextCompactionFailure }
  | { readonly kind: 'reset'; readonly compactionId: string; readonly reason: 'manual' };
export interface ContextHardBlock {
  readonly reason: ContextHardBlockReason;
  readonly sourceDigest: string;
  readonly message: string;
  readonly createdAtTurnId: string;
}
export interface ContextAutoGuardEntry {
  readonly turnIndex: number;
  readonly reductionRatio: number;
  readonly tokensAfter: number;
}

export interface AgentContextState {
  readonly activeCheckpoint?: ContextCompactionCheckpoint;
  readonly pendingCompaction?: PendingContextCompaction;
  readonly lastFailure?: ContextCompactionFailure;
  readonly history: readonly ContextHistoryEntry[];
  readonly lastCompactionTurnIndex?: number;
  readonly hardBlock?: ContextHardBlock;
  readonly autoGuard: {
    readonly recentAutomaticCompactions: readonly ContextAutoGuardEntry[];
    readonly consecutiveLowGain: number;
    readonly disabledUntilManualAction: boolean;
    readonly recoveryAttempted: boolean;
  };
}

export interface AgentPrivateArtifactRef {
  readonly artifactId: string;
  readonly kind: string;
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}
export interface AgentModelAdmissionState {
  readonly providerAdmissionRevision: string | null;
  readonly routeIdentityDigest: string;
  readonly payloadClassificationDigest: string;
  readonly admitted: boolean;
}
export type AgentModelBudgetState =
  | {
      readonly kind: 'reservation';
      readonly reservationId: string;
      readonly parentReservationId: string | null;
    }
  | { readonly kind: 'no_budget'; readonly reason: 'resource_budget_disabled' };
export interface AgentModelLimitsState {
  readonly maxAttempts: number;
  readonly perAttemptTimeoutMs: number;
  readonly totalTimeBudgetMs: number;
}

export interface AgentModelInvocationState {
  readonly invocationId: string;
  readonly purpose:
    | 'primary_agent'
    | 'context_compaction'
    | 'auto_review'
    | 'verification_review'
    | 'subagent';
  readonly status: 'prepared' | 'dispatching' | 'completed' | 'interrupted';
  readonly surfaceArtifact: AgentPrivateArtifactRef & { readonly kind: 'model_surface' };
  readonly surfaceIntegrityIdentifier: string;
  readonly routeFingerprint: string;
  readonly admission: AgentModelAdmissionState;
  readonly budget: AgentModelBudgetState;
  readonly limits: AgentModelLimitsState;
  readonly preparedStateRevision: number;
  readonly parentInvocationId: string | null;
  readonly parentToolCallId: string | null;
  readonly attempts: number;
  readonly responseArtifact?: AgentPrivateArtifactRef & { readonly kind: 'model_response' };
  readonly finishReason?:
    | 'stop'
    | 'length'
    | 'content_filter'
    | 'tool_calls'
    | 'error'
    | 'other'
    | 'unknown';
  readonly dispatchCertainty?: 'none' | 'attempted' | 'unknown';
  readonly interruptionReason?:
    | 'runtime_restored'
    | 'attempts_exhausted'
    | 'cancelled'
    | 'cancelled_before_dispatch'
    | 'provider_failure'
    | 'surface_identity_changed'
    | 'persistence_unavailable';
  readonly modelEvidenceUnavailable?: 'artifact_missing' | 'artifact_corrupt';
}

export interface AgentProviderReadinessState {
  readonly readinessKey: string;
  readonly lifecycleId: string;
  readonly providerId: string;
  readonly routeRevision: string;
  readonly executionBoundaryDigest: string;
  readonly status: 'prepared' | 'attempted' | 'ready' | 'failed';
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly maxAttempts: number;
  readonly attempts: number;
  readonly waiters: Readonly<Record<string, AgentProviderReadinessWaiterState>>;
  readonly readyAt?: string;
  readonly providerDirectoryRevision?: string;
  readonly failure?: AgentFailureState;
  readonly dispatchCertainty?: 'none' | 'attempted';
}

export interface AgentProviderReadinessWaiterState {
  readonly waiterId: string;
  readonly toolCallId: string;
  readonly registeredAt: string;
}

export interface AgentCompletionGuardState {
  readonly correctionAttempts: number;
  readonly guardVersion?: 'completion_guard_v1' | 'completion_guard_v2';
  readonly planIdentity?: {
    readonly planId: string;
    readonly version: number;
    readonly structuralDigest: string;
  };
}
export interface AgentTerminalOutcomeState {
  readonly version: 1;
  readonly status:
    | 'completed'
    | 'aborted'
    | 'blocked'
    | 'unknown'
    | 'budget_exhausted'
    | 'resource_saturated';
  readonly reasonCode: string;
  readonly knownExternalEffects: 'none' | 'known' | 'unknown';
  readonly safeRetry: boolean;
  readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  readonly pendingVerification: boolean;
}

export type AgentProviderDirectoryStatus =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';
export type AgentProviderDirectorySource =
  | 'project'
  | 'user'
  | 'local'
  | 'project_legacy'
  | 'user_legacy'
  | 'project_kite_code'
  | 'project_mcp_json'
  | 'explicit';
export type AgentProviderDiagnosticCode =
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
export type AgentProviderRecoveryAction = 'login' | 'approve' | 'retry';

export type AgentInteractionState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'awaiting_user_input';
      readonly interactionId: string;
      readonly toolCallId: string;
      readonly request: AgentUserInputPayload;
    }
  | {
      readonly kind: 'awaiting_review';
      readonly interactionId: string;
      readonly toolCallId: string;
      readonly planId: string;
      readonly version: number;
      readonly structuralDigest: string;
      readonly plan: AgentPlan;
      readonly planSummary: string;
      readonly artifact?: PlanArtifactRef;
    }
  | {
      readonly kind: 'awaiting_tool_approval';
      readonly interactionId: string;
      readonly toolCallId: string;
      readonly approval: AgentToolApprovalPayload;
    }
  | {
      readonly kind: 'awaiting_auto_review';
      readonly interactionId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: string;
      readonly approval: AgentToolApprovalPayload;
    }
  | {
      readonly kind: 'awaiting_provider_action';
      readonly interactionId: string;
      readonly providerId: string;
      readonly action: AgentProviderRecoveryAction;
      readonly originatingToolCallId: string;
      readonly status: 'required' | 'started';
    }
  | {
      readonly kind: 'awaiting_provider_admission';
      readonly interactionId: string;
      readonly providerId: string;
      readonly source: AgentProviderDirectorySource;
      readonly providerStatus: AgentProviderDirectoryStatus;
      readonly diagnosticCode?: AgentProviderDiagnosticCode;
      readonly retryable: boolean;
    };

export interface AgentCapabilityBindingState {
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly schemaDigest: string;
  readonly issuedForTurnId: string;
}

export interface AgentCapabilityDisclosureState {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly issuedForTurnId: string;
}

export interface AgentCapabilitySearchCandidate {
  readonly candidateRef: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly kind: 'mcp_tool' | 'skill';
  readonly displayName: string;
  readonly providerType: 'builtin' | 'mcp' | 'skill' | 'subagent';
  readonly providerId: string;
}
export interface AgentCapabilitySearchProviderDiagnostic {
  readonly providerId: string;
  readonly status: Exclude<AgentProviderDirectoryStatus, 'ready'>;
  readonly nextAction: string;
  readonly diagnosticCode?: AgentProviderDiagnosticCode;
}
export interface AgentCapabilitySearchResult {
  readonly searchId: string;
  readonly query: string;
  readonly catalogRevision: string;
  readonly requestedAtTurnId: string;
  readonly candidates: readonly AgentCapabilitySearchCandidate[];
  readonly providers?: readonly AgentCapabilitySearchProviderDiagnostic[];
}

export interface AgentLoadedCapabilityState {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly firstLoadedAtTurnId: string;
}

export interface AgentCapabilityArtifactRef {
  readonly artifactId: string;
  readonly kind: 'capability_result';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}
export interface AgentFilesystemPreimageArtifactRef {
  readonly artifactId: string;
  readonly kind: 'filesystem_preimage';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}
export interface AgentSandboxPreparationArtifactRef {
  readonly artifactId: string;
  readonly kind: 'sandbox_preparation';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}
export interface AgentSubagentTaskArtifactRef {
  readonly artifactId: string;
  readonly kind: 'subagent_task';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}
export interface AgentSubagentHandleArtifactRef {
  readonly artifactId: string;
  readonly kind: 'subagent_handle';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}
export interface AgentFilesystemObservationState {
  readonly actorIdentityDigest: string;
  readonly lexicalTargetDigest: string;
  readonly canonicalTargetDigest: string;
  readonly targetIdentityDigest: string;
  readonly contentDigest: string;
}
export interface AgentFilesystemIntentState {
  readonly attempt: number;
  readonly capabilityRevision: string;
  readonly argumentsDigest: string;
  readonly admissionDigest: string;
  readonly operationDigest: string;
  readonly searchBoundaryDigest: string | null;
  readonly lexicalTargetDigest: string;
  readonly canonicalWorkspaceDigest: string;
  readonly protectedPathRevision: string;
  readonly approvalSummaryDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly intentDigest: string;
  readonly recordedAt: string;
}
export interface AgentFilesystemMutationReadyState {
  readonly attempt: number;
  readonly intentDigest: string;
  readonly operationDigest: string;
  readonly targetIdentityDigest: string;
  readonly preimageDigest: string | null;
  readonly preimageArtifact: AgentFilesystemPreimageArtifactRef;
  readonly readyDigest: string;
  readonly readyAt: string;
}
export interface AgentSandboxPreparationIntentState {
  readonly attempt: number;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly canonicalWorkspace: string;
  readonly effectiveEffectsDigest: string;
  readonly admissionDigest: string;
  readonly preparationDigest: string;
  readonly commandDigest: string;
  readonly executionBoundaryDigest: string;
  readonly resourceSemantics: 'allocating';
  readonly intentDigest: string;
  readonly recordedAt: string;
}
export interface AgentSandboxPreparationReadyState {
  readonly attempt: number;
  readonly intentDigest: string;
  readonly preparationDigest: string;
  readonly commandDigest: string;
  readonly planDigest: string;
  readonly backend: 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';
  readonly backendCapabilitiesDigest: string;
  readonly enforcement: 'full' | 'partial';
  readonly resourceSemantics: 'pure' | 'allocating';
  readonly cleanupDigest: string;
  readonly preparationArtifact: AgentSandboxPreparationArtifactRef;
  readonly readyDigest: string;
  readonly readyAt: string;
}
export interface AgentSandboxExecutionDispatchState {
  readonly attempt: number;
  readonly readyDigest: string;
  readonly planDigest: string;
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
  readonly status: 'intent_recorded' | 'supervisor_started';
  readonly recordedAt: string;
  readonly supervisorPid?: number;
  readonly processGroupId?: number;
  readonly processStartIdentity?: string;
  readonly supervisorStartedAt?: string;
}
export interface AgentSandboxDisposalState {
  readonly attempt: number;
  readonly readyDigest: string;
  readonly lifecycleIntentDigest: string;
  readonly status: 'pending' | 'completed';
  readonly startedAt: string;
  readonly disposedAt?: string;
  readonly attempts: number;
  readonly lastFailureAt?: string;
}
export interface AgentSandboxAbandonmentState {
  readonly attempt: number;
  readonly intentDigest: string;
  readonly lifecycleIntentDigest: string;
  readonly status: 'pending' | 'completed';
  readonly startedAt: string;
  readonly disposedAt?: string;
  readonly attempts: number;
  readonly lastFailureAt?: string;
}
export interface AgentSubagentProviderLifecycleState {
  readonly attempt: number;
  readonly purpose: 'start' | 'resume';
  readonly childInvocationId: string;
  readonly taskArtifact: AgentSubagentTaskArtifactRef;
  readonly dispatchIntentDigest: string;
  readonly status:
    | 'intent_recorded'
    | 'handle_recorded'
    | 'observed'
    | 'cleanup_pending'
    | 'cleanup_completed';
  readonly recordedAt: string;
  readonly handleArtifact?: AgentSubagentHandleArtifactRef;
  readonly handleIntegrityIdentifier?: string;
  readonly handleRecordedAt?: string;
  readonly observationStatus?: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'blocked';
  readonly observedAt?: string;
  readonly cleanupAttempt?: number;
  readonly cleanupKind?: 'undispatched' | 'handle_reconcile';
  readonly cleanupStartedAt?: string;
  readonly cleanupConfirmed?: boolean;
  readonly cleanupCompletedAt?: string;
}

export interface AgentCapabilityInvocationState {
  readonly invocationId: string;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly taskId?: string;
  readonly planId?: string;
  readonly planStepId?: string;
  readonly argumentsDigest: string;
  readonly authorizationDigest: string;
  readonly admissionDigest?: string;
  readonly effectiveEffectsDigest: string;
  readonly status: 'recorded' | 'running' | 'succeeded' | 'failed' | 'unknown';
  readonly recordedAt: string;
  readonly startedAt?: string;
  readonly attemptsStarted?: number;
  readonly finishedAt?: string;
  readonly resultDigest?: string;
  readonly evidenceDigest?: string;
  readonly artifact?: AgentCapabilityArtifactRef;
  readonly filesystemMutationReady?: AgentFilesystemMutationReadyState;
  readonly filesystemIntent?: AgentFilesystemIntentState;
  readonly filesystemObservation?: AgentFilesystemObservationState;
  readonly sandboxPreparationIntent?: AgentSandboxPreparationIntentState;
  readonly sandboxPreparationReady?: AgentSandboxPreparationReadyState;
  readonly sandboxExecutionDispatch?: AgentSandboxExecutionDispatchState;
  readonly sandboxDisposal?: AgentSandboxDisposalState;
  readonly sandboxPreparationAbandonment?: AgentSandboxAbandonmentState;
  readonly subagentProviderLifecycle?: AgentSubagentProviderLifecycleState;
  readonly receiptRequirement?:
    | 'observation_receipt'
    | 'effect_receipt'
    | 'control_receipt'
    | 'not_applicable';
  readonly retryEligibility?: 'none' | 'safe_read_candidate' | 'idempotency_key_candidate';
  readonly externalReferences?: readonly string[];
  readonly error?: string;
  readonly idempotencyKey?: string;
  readonly reconciliation?: 'confirmed_success' | 'confirmed_failure' | 'waived';
  readonly reconciledAt?: string;
}

export interface AgentCapabilityRuntimeState {
  readonly catalogRevision: string;
  readonly bindings: Readonly<Record<string, AgentCapabilityBindingState>>;
  readonly disclosures: Readonly<Record<string, AgentCapabilityDisclosureState>>;
  readonly pendingSearch?: AgentCapabilitySearchResult;
  readonly loadedCapabilities: Readonly<Record<string, AgentLoadedCapabilityState>>;
  readonly invocations: Readonly<Record<string, AgentCapabilityInvocationState>>;
}

export interface AgentSkillActivationState {
  readonly activationId: string;
  readonly skillId: string;
  readonly skillRevision: string;
  readonly taskId: string;
  readonly input: unknown;
  readonly contextMode: 'inline' | 'fork';
  readonly agent: string;
  readonly capabilityCeiling: readonly string[];
  readonly verificationMode: 'not_required' | 'best_effort' | 'required';
  readonly requestedBy: 'user' | 'model';
  readonly activatedAt: string;
}
export interface AgentSkillFrameState extends AgentSkillActivationState {
  readonly status: 'active' | 'closed' | 'invalidated';
  readonly closedAt?: string;
  readonly closeReason?: string;
  readonly output?: Readonly<Record<string, unknown>>;
}
export interface AgentSkillRuntimeState {
  readonly catalogRevision: string;
  readonly frames: Readonly<Record<string, AgentSkillFrameState>>;
}

export type AgentVerificationMode = 'not_required' | 'best_effort' | 'required';
export type AgentVerificationOutcome = 'passed' | 'failed' | 'inconclusive';
export type AgentVerificationStatus =
  | 'pending'
  | 'running'
  | 'repair_pending'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'waived'
  | 'compensating'
  | 'compensated'
  | 'budget_exhausted';
export type AgentVerificationCheck =
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'file_assertion';
      readonly path: string;
      readonly assertion: 'exists' | 'not_exists' | 'sha256_equals';
      readonly expectedDigest?: string;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'command';
      readonly command: string;
      readonly cwd?: string;
      readonly timeoutMs?: number;
      readonly expectedExitCode?: number;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'schema';
      readonly subject:
        | { readonly kind: 'literal'; readonly value: unknown }
        | { readonly kind: 'skill_output'; readonly activationId: string }
        | { readonly kind: 'capability_artifact'; readonly invocationId: string };
      readonly schema: Readonly<Record<string, unknown>>;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'mcp_read_after_write';
      readonly invocationId: string;
      readonly capabilityId: string;
      readonly capabilityRevision: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly outputSchema?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'external_reference';
      readonly invocationId: string;
      readonly uri?: string;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'reviewer';
      readonly invocationIds?: readonly string[];
      readonly activationIds?: readonly string[];
      readonly instructions: string;
    };
export interface AgentVerificationSpec {
  readonly schemaVersion: 1;
  readonly verificationId: string;
  readonly taskId?: string;
  readonly subject: string;
  readonly checks: readonly AgentVerificationCheck[];
  readonly repair: { readonly maxAttempts: number };
  readonly compensation?: {
    readonly command: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
  };
}
export interface AgentVerificationCheckResult {
  readonly checkId: string;
  readonly modelInvocationId?: string;
  readonly outcome: AgentVerificationOutcome;
  readonly summary: string;
  readonly evidenceDigest?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}
export interface AgentVerificationRecord {
  readonly verificationId: string;
  readonly taskId?: string;
  readonly mode: AgentVerificationMode;
  readonly status: AgentVerificationStatus;
  readonly spec: AgentVerificationSpec;
  readonly requestedAt: string;
  readonly attempts: number;
  readonly repairAttempts: number;
  readonly checkResults: Readonly<Record<string, AgentVerificationCheckResult>>;
  readonly completedAt?: string;
  readonly waiver?: { readonly actor: 'user'; readonly reason: string; readonly waivedAt: string };
  readonly compensation?: {
    readonly outcome: AgentVerificationOutcome;
    readonly summary: string;
    readonly completedAt: string;
  };
  readonly diagnostics?: readonly string[];
}
export interface AgentVerificationRuntimeState {
  readonly records: Readonly<Record<string, AgentVerificationRecord>>;
}

export interface AgentProviderAdmissionRecord {
  readonly interactionId: string;
  readonly providerId: string;
  readonly source: AgentProviderDirectorySource;
  readonly providerStatus: AgentProviderDirectoryStatus;
  readonly diagnosticCode?: AgentProviderDiagnosticCode;
  readonly retryable: boolean;
}
export interface AgentProviderWaiver {
  readonly providerId: string;
  readonly source: AgentProviderDirectorySource;
  readonly reason: 'user_session_waiver';
  readonly waivedAt: string;
}
export interface AgentProviderAdmissionState {
  readonly pending: readonly AgentProviderAdmissionRecord[];
  readonly waivers: Readonly<Record<string, AgentProviderWaiver>>;
}

export interface AgentAuthorizationState {
  readonly mode: AuthorizationMode;
  readonly modeSource?: 'user' | 'config' | 'test' | 'system';
  readonly modeGrantedAt?: string;
  readonly commandGrants: Readonly<Record<string, AgentToolGrant>>;
}

export interface AgentToolGrant {
  readonly workspace: string;
  readonly threadId: string;
  readonly command: string;
  readonly source: 'user' | 'config' | 'test' | 'system';
  readonly grantedAt: string;
  readonly expiresAt?: string;
}

export interface AgentSuspendedSubagentState {
  readonly storage: 'private_artifact_v1';
  readonly subagentId: string;
  readonly role: 'explore' | 'plan' | 'code' | 'review';
  readonly continuationId: string;
  readonly modelInvocationOrdinal: number;
  readonly continuationArtifact: {
    readonly artifactId: string;
    readonly kind: 'subagent_continuation';
    readonly integrityIdentifier: string;
    readonly byteLength: number;
  };
  readonly parentInvocationId: string;
  readonly parentAttempt: number;
  readonly blockedTool: {
    readonly reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
    readonly toolCallId: string;
    readonly runtimeToolCallId?: string;
    readonly toolName: string;
  };
}

export interface AgentTaskState {
  readonly taskId: string;
  readonly userGoal: string;
  readonly status: 'active' | 'completed' | 'cancelled';
  readonly startedAtTurnId: string;
  readonly completedAtTurnId?: string;
  readonly sideEffectsStarted: boolean;
  readonly planning: PlanningState;
  readonly executionMode?: 'auto' | 'accept_edits';
  readonly planHistory: readonly PlanDocument[];
}

export interface AgentToolCallState {
  readonly toolCallId: string;
  readonly name: string;
  /** The committed model message and parsed arguments are required State facts. */
  readonly modelMessageId: string;
  readonly args: unknown;
  readonly modelInvocationId?: string;
  readonly ordinal?: number;
  /** Turn identity is captured at queue admission, never inferred during replay. */
  readonly createdAtTurnId: string;
  readonly taskId?: string;
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly approvalRequestedAt?: string;
  readonly approvalWaitMs?: number;
  readonly invocationFingerprint?: string;
  readonly recoveryOf?: string;
  readonly recoveryMode?: 'model_correction' | 'automatic_retry';
  readonly recoveryAdmission?:
    | 'admitted'
    | 'recovery_not_allowed'
    | 'recovery_exhausted'
    | 'no_progress';
  readonly result?: AgentToolResultState;
  readonly error?: string;
  readonly failure?: AgentFailureState;
  readonly outcome?: import('./recovery').ToolOutcome;
  readonly bindingId?: string;
  readonly capabilityId?: string;
  readonly capabilityRevision?: string;
  readonly unknownFields?: AgentUnknownToolFieldsObservation;
  readonly approvalHash?: string;
  readonly approvalGrant?: 'approve_once' | 'same_command' | 'full_access';
  readonly effectClass?:
    | 'read_only'
    | 'plan_only'
    | 'workspace_write'
    | 'external_side_effect'
    | 'unknown';
  readonly sideEffect?: boolean;
  readonly classificationReason?: string;
  readonly networkDecisions?: readonly AgentNetworkDecisionReceipt[];
  readonly status:
    | 'queued'
    | 'awaiting_user_input'
    | 'awaiting_review'
    | 'awaiting_approval'
    | 'awaiting_auto_review'
    | 'approved'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'rejected'
    | 'cancelled'
    | 'exhausted';
}

export type AgentNetworkFailureCode =
  | 'network_off'
  | 'invalid_url'
  | 'protocol_denied'
  | 'credentials_denied'
  | 'host_not_allowlisted'
  | 'ip_literal_denied'
  | 'dns_unavailable'
  | 'private_or_reserved_address'
  | 'endpoint_revision_mismatch'
  | 'redirect_denied'
  | 'request_body_too_large'
  | 'response_body_too_large'
  | 'controller_unavailable';
export interface AgentNetworkAdmissionReceipt {
  readonly version: 1;
  readonly outcome: 'allowed';
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly hop: number;
  readonly policyRevision: string;
  readonly canonicalOrigin: string;
  readonly host: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly endpointRevision: string;
  readonly expectedEndpointRevision?: string;
  readonly receiptDigest: string;
}
export interface AgentNetworkDenialReceipt {
  readonly version: 1;
  readonly outcome: 'denied';
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly hop: number;
  readonly policyRevision: string;
  readonly canonicalOrigin: string;
  readonly host: string;
  readonly failureCode: AgentNetworkFailureCode;
  readonly expectedEndpointRevision?: string;
  readonly receiptDigest: string;
}
export type AgentNetworkDecisionReceipt = AgentNetworkAdmissionReceipt | AgentNetworkDenialReceipt;

export interface AgentUnknownToolFieldsObservation {
  readonly hasUnknown: boolean;
  readonly count: number;
  readonly toolClass:
    | 'builtin_read'
    | 'builtin_write'
    | 'builtin_execute'
    | 'builtin_other'
    | 'mcp_tool';
  readonly schemaRevision: string;
}

export interface AgentToolResultState {
  readonly ok: boolean;
  readonly summary: string;
  readonly exitCode?: number;
  readonly resultMeta?: AgentToolResultMeta;
}

export interface AgentToolResultMeta {
  readonly invocationId?: string;
  readonly capabilityRevision?: string;
  readonly path?: string;
  readonly totalLines?: number;
  readonly command?: string;
  readonly intent?: string;
  readonly matchCount?: number;
  readonly truncated?: boolean;
  readonly contentDigest?: string;
  readonly resourceRevision?: string;
  readonly workspaceMutationScope?: readonly string[];
  readonly rawResultDigest?: string;
  readonly modelContentDigest?: string;
  readonly digestScope?: 'raw' | 'projected' | 'legacy_unknown';
  readonly processCleanupConfirmed?: boolean;
  readonly unconfirmedDescendantCount?: number;
  readonly networkPolicyRevision?: string;
  readonly networkAdmissionDigests?: readonly string[];
  readonly networkFailureCode?: string;
  readonly nextCapability?: 'git_inspect';
  readonly gitFailureCode?: AgentGitFailureCode;
  readonly gitReceipt?: AgentGitInvocationReceipt;
}

export type AgentGitFailureCode =
  | 'sandbox_capability_missing'
  | 'protected_path_denied'
  | 'git_operation_unsupported'
  | 'managed_network_setup_required'
  | 'repository_invalid'
  | 'repository_hostile'
  | 'binary_untrusted'
  | 'lock'
  | 'cancelled'
  | 'timed_out'
  | 'process_failed'
  | 'receipt_invalid';
export interface AgentGitInvocationReceipt {
  readonly featureRevision: 'brokered-git-r1';
  readonly brokerRevision: 'git-broker-v1';
  readonly operationSchemaRevision: 'git-operation-schema-v1';
  readonly repositoryBinding: string;
  readonly executableIdentity: string;
  readonly nativeDenyEvidenceIdentity: string;
  readonly invocationId: string;
  readonly operation: 'status' | 'diff' | 'log' | 'branch_list';
  readonly effect: 'git_inspect';
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly exitCode: number;
}

export interface AgentFailureState {
  readonly kind: AgentFailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly modelFixable: boolean;
  readonly needsUserIntervention: boolean;
  readonly terminatesTurn: boolean;
  readonly journal: boolean;
  readonly parseFailureCode?:
    | 'invalid_json'
    | 'unknown_tool'
    | 'tool_unavailable'
    | 'invalid_arguments';
}

export type AgentFailureKind =
  | 'model_invalid_tool_args'
  | 'model_refused'
  | 'model_timeout'
  | 'model_rate_limited'
  | 'model_server_error'
  | 'policy_denied'
  | 'phase_deferred'
  | 'phase_denied'
  | 'approval_rejected'
  | 'auto_review_rejected'
  | 'plan_revision_requested'
  | 'tool_runtime_error'
  | 'tool_timeout'
  | 'tool_invalid_args'
  | 'tool_not_found'
  | 'provider_auth_required'
  | 'provider_approval_required'
  | 'provider_unavailable'
  | 'provider_capability_changed'
  | 'user_input_cancelled'
  | 'user_input_timeout'
  | 'sandbox_error'
  | 'checkpoint_restore_error'
  | 'transcript_invariant_error'
  | 'loop_exhausted'
  | 'budget_exceeded'
  | 'artifact_invalid'
  | 'profile_invalid'
  | 'digest_invalid'
  | 'workspace_untrusted'
  | 'network_unavailable'
  | 'worktree_unavailable'
  | 'model_retry_exhausted'
  | 'mcp_unavailable'
  | 'persistence_unavailable'
  | 'resource_saturated'
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'compaction_unqualified'
  | 'compaction_failed'
  | 'verification_failed'
  | 'verification_inconclusive'
  | 'mandatory_policy_unavailable'
  | 'unknown';

export interface AgentToolsState {
  readonly calls: Readonly<Record<string, AgentToolCallState>>;
  readonly queue: readonly string[];
  readonly active: readonly string[];
}

export interface AgentResourceBudgetUnconfiguredState {
  readonly status: 'unconfigured';
  readonly reservations: Readonly<Record<string, never>>;
}

export interface AgentResourceBudgetActiveState {
  readonly status: 'active';
  readonly runId: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly budget: ResourceBudget;
  readonly reconciledUsage: ResourceUsage;
  readonly reservations: Readonly<Record<string, ResourceReservation>>;
  readonly waiters: Readonly<Record<string, ResourceWaiter>>;
  readonly nextWaiterSequence: number;
}

export type AgentResourceBudgetState =
  | AgentResourceBudgetUnconfiguredState
  | AgentResourceBudgetActiveState;

export interface AgentToolRecoveryQualityGuard {
  readonly blocked: boolean;
  readonly reasonCode?: 'no_progress' | 'journal_invalid';
  readonly observedFailures: number;
  readonly taskId?: string;
  readonly turnId?: string;
}

export type AgentToolRecoveryState = ToolRecoveryJournal;

export interface AgentAutoReviewRejectionEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly reason: string;
}

export interface AgentAutoReviewState {
  readonly pendingWarnings: Readonly<Record<string, string>>;
  readonly consecutiveRejects: number;
  readonly rejectionHistory: readonly AgentAutoReviewRejectionEntry[];
  readonly circuitBreakerTripped: boolean;
}

export interface AgentDoomLoopRecord {
  readonly count: number;
  readonly lastSeenAt: number;
}

export type AgentRecoveryState =
  | { readonly kind: 'normal' }
  | { readonly kind: 'corrupted'; readonly reason: string }
  | {
      readonly kind: 'incompatible';
      readonly schemaVersion: number | null;
      readonly formatEpoch: string | null;
    };

/**
 * The complete serialized State 25 record.  No State 26 identity or Store 5
 * fields are present here; those are deliberately reserved for RA.
 */
export interface AgentState {
  readonly activeTaskId: string | null;
  readonly tasks: Readonly<Record<string, AgentTaskState>>;
  readonly schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  readonly formatEpoch: typeof RUNTIME_STATE_FORMAT_EPOCH;
  readonly revision: number;
  readonly lastAppliedEventId?: string;
  readonly appliedEventIds: readonly string[];
  readonly recoveryState: AgentRecoveryState;
  readonly session: AgentSessionState;
  readonly turn: AgentTurnState;
  readonly transcript: AgentTranscriptState;
  readonly context: AgentContextState;
  readonly resourceBudget: AgentResourceBudgetState;
  readonly modelInvocations: Readonly<Record<string, AgentModelInvocationState>>;
  readonly providerReadiness: Readonly<Record<string, AgentProviderReadinessState>>;
  readonly terminalOutcome?: AgentRunTerminalOutcome;
  readonly completionGuard: AgentCompletionGuardState;
  readonly interactions: AgentInteractionState;
  readonly tools: AgentToolsState;
  readonly toolRecovery: AgentToolRecoveryState;
  readonly capabilities: AgentCapabilityRuntimeState;
  readonly skills: AgentSkillRuntimeState;
  readonly verification: AgentVerificationRuntimeState;
  readonly providerAdmission: AgentProviderAdmissionState;
  readonly suspendedSubagents: Readonly<Record<string, AgentSuspendedSubagentState>>;
  readonly authorization: AgentAuthorizationState;
  readonly mode: InteractionMode;
  readonly workspaceAccess: WorkspaceAccess;
  readonly autoReview: AgentAutoReviewState;
  readonly doomLoop: Readonly<Record<string, AgentDoomLoopRecord>>;
}

/** Exact persisted State identity-bearing view used by Store. */
export type StateSessionState = AgentSessionState &
  Required<Pick<AgentSessionState, 'projectId' | 'canonicalWorkspaceDigest'>>;
export type StateAgentState = Omit<AgentState, 'session'> & {
  readonly session: StateSessionState;
};

export type RuntimeState = AgentState;

interface ActiveTaskSelectorState<Task> {
  readonly activeTaskId: string | null;
  readonly tasks: Readonly<Record<string, Task>>;
}

/**
 * Return the task selected by State's active-task identity.
 *
 * The selector deliberately does not infer an active task from task status or
 * object order.  A missing or stale identity is represented as `null`, which
 * keeps replay deterministic and matches the pre-cutover State behaviour.
 */
export function getActiveTask(state: RuntimeState): AgentTaskState | null;
export function getActiveTask<Task>(state: ActiveTaskSelectorState<Task>): Task | null;
export function getActiveTask<Task>(state: ActiveTaskSelectorState<Task>): Task | null {
  return state.activeTaskId ? (state.tasks[state.activeTaskId] ?? null) : null;
}

/** Return the planning state owned by the active task, or the empty fallback. */
export function getActivePlanning(state: RuntimeState): PlanningState;
export function getActivePlanning<Planning>(
  state: ActiveTaskSelectorState<{ readonly planning: Planning }>,
): Planning | { kind: 'building_without_plan' };
export function getActivePlanning<Planning>(
  state: ActiveTaskSelectorState<{ readonly planning: Planning }>,
): Planning | { kind: 'building_without_plan' } {
  const active = getActiveTask(state);
  return active?.planning ?? { kind: 'building_without_plan' };
}

/**
 * Resolve the effective interaction mode without consulting any external
 * policy or clock.  A task-level execution mode takes precedence when set;
 * otherwise the State top-level mode remains authoritative.
 */
export function getEffectiveInteractionMode(state: RuntimeState): InteractionMode;
export function getEffectiveInteractionMode<Mode>(
  state: ActiveTaskSelectorState<{ readonly executionMode?: Mode }> & { readonly mode: Mode },
): Mode;
export function getEffectiveInteractionMode<Mode>(
  state: ActiveTaskSelectorState<{ readonly executionMode?: Mode }> & { readonly mode: Mode },
): Mode {
  return getActiveTask(state)?.executionMode ?? state.mode;
}

interface CreateAgentStateInputBase {
  readonly threadId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
  /** IDs are allocated by Host and supplied to the pure Kernel. */
  readonly turnId: string;
  /** Host supplies the per-session private recovery identity. */
  readonly recoveryIdentityKey: string;
  readonly interactionMode?: InteractionMode;
  readonly phase?: 'planning' | 'building';
  readonly workspaceAccess?: WorkspaceAccess;
}
export type CreateAgentStateInput =
  | (CreateAgentStateInputBase & {
      readonly authorizationMode?: 'default';
      readonly authorizationSource?: 'user' | 'config' | 'test' | 'system';
      readonly modeGrantedAt?: never;
    })
  | (CreateAgentStateInputBase & {
      readonly authorizationMode: 'full_access';
      readonly authorizationSource: 'user' | 'config' | 'test' | 'system';
      /** The Host/App materializes this fact without Kernel clock access. */
      readonly modeGrantedAt: string;
    });

/** Construct a deterministic State 26 value without reading clock or random. */
export function createInitialAgentState(input: CreateAgentStateInput): AgentState {
  if (
    input.threadId.length === 0 ||
    input.userId.length === 0 ||
    input.workspace.length === 0 ||
    input.turnId.length === 0
  ) {
    throw new Error('State constructor requires non-empty Host session and turn facts.');
  }
  if (!/^[a-f0-9]{64}$/u.test(input.recoveryIdentityKey)) {
    throw new Error(
      'State tool recovery recoveryIdentityKey must be a 64-character lowercase hex value.',
    );
  }
  if (
    input.authorizationMode === 'full_access' &&
    (input.authorizationSource === undefined ||
      input.modeGrantedAt === undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input.modeGrantedAt))
  ) {
    throw new Error(
      'State full_access initialization requires Host authorizationSource and modeGrantedAt facts.',
    );
  }
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
    revision: 0,
    appliedEventIds: [],
    recoveryState: { kind: 'normal' },
    session: {
      threadId: input.threadId,
      userId: input.userId,
      workspace: input.workspace,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.canonicalWorkspaceDigest
        ? { canonicalWorkspaceDigest: input.canonicalWorkspaceDigest }
        : {}),
    },
    turn: { turnId: input.turnId, turnIndex: 0, status: 'active' },
    transcript: { messages: [] },
    context: {
      history: [],
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    resourceBudget: { status: 'unconfigured', reservations: {} },
    modelInvocations: {},
    providerReadiness: {},
    completionGuard: { correctionAttempts: 0 },
    activeTaskId: null,
    tasks: {},
    interactions: { kind: 'idle' },
    tools: { calls: {}, queue: [], active: [] },
    toolRecovery: {
      schemaVersion: 1,
      identityKey: input.recoveryIdentityKey,
      failures: {},
      order: [],
      progressRevision: 0,
      qualityGuard: { blocked: false, observedFailures: 0 },
    },
    capabilities: {
      catalogRevision: '',
      bindings: {},
      disclosures: {},
      loadedCapabilities: {},
      invocations: {},
    },
    skills: { catalogRevision: '', frames: {} },
    verification: { records: {} },
    providerAdmission: { pending: [], waivers: {} },
    suspendedSubagents: {},
    authorization: {
      mode: input.authorizationMode ?? 'default',
      ...(input.authorizationMode === 'full_access'
        ? {
            modeSource: input.authorizationSource,
            modeGrantedAt: input.modeGrantedAt,
          }
        : {}),
      commandGrants: {},
    },
    mode: input.interactionMode ?? 'accept_edits',
    workspaceAccess: input.workspaceAccess ?? 'write',
    autoReview: {
      pendingWarnings: {},
      consecutiveRejects: 0,
      rejectionHistory: [],
      circuitBreakerTripped: false,
    },
    doomLoop: {},
  };
}
