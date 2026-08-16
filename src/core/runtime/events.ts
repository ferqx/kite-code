// ── Agent Runtime Kernel 运行时事件类型 / Runtime event types ──
// Phase 1: 工具生命周期 + 交互事件
// 所有状态变更通过类型化事件表示，供 runtime 内部及各层消费者使用

import type { RemoteMcpEgressReceiptV1 } from '@/core/mcp/egress-permit';
import type { ContextTokenEstimate } from '@/core/model/context-budget';
import type { NetworkDecisionReceiptV1 } from '@/core/sandbox/network-enforcer';
import type { ToolGrant } from '@/core/types';
import type {
  CapabilityArtifactRef,
  CapabilityBinding,
  CapabilityDisclosure,
  CapabilitySearchResult,
  EffectProfile,
  LoadedCapability,
} from '@/protocol/capabilities';
import type {
  AgentPlan,
  AuthorizationMode,
  PlanArtifactRef,
  PlanIdentity,
  ShellApprovalGrant,
  SubAgentCacheMetricsPayload,
  SubAgentDonePayload,
  SubAgentErrorPayload,
  SubAgentStartPayload,
  SubAgentStepPayload,
  SubAgentToolResultPayload,
  ToolApprovalPayload,
  UserInputPayload,
  UserInputResult,
} from '@/protocol/events.js';
import type {
  ModelFinishReasonV1,
  ModelInvocationEnvelopeV1,
  ModelInvocationPurposeV1,
  PrivateArtifactRefV1,
  Sha256DigestV1,
} from '@/protocol/model-surface';
import type { SuspendedSubagentSnapshot } from '@/protocol/subagent.js';
import type {
  VerificationCheckResult,
  VerificationMode,
  VerificationOutcome,
  VerificationSpecV1,
} from '@/protocol/verification';
import type {
  ContextCompactionCheckpoint,
  ContextCompactionErrorKind,
  ContextCompactionReason,
  ContextHardBlockReason,
} from './context-compaction';
import type { ClassifiedFailure } from './failures';
import type {
  ResourceBudgetConfiguredEvent,
  ResourceBudgetDispatchStartedEvent,
  ResourceBudgetReconciledEvent,
  ResourceBudgetReleasedEvent,
  ResourceBudgetReservedEvent,
  ResourceBudgetUnknownEvent,
  ResourceBudgetWaiterCancelledEvent,
  ResourceBudgetWaiterEnqueuedEvent,
  ResourceBudgetWaiterPromotedEvent,
  ResourceBudgetWaiterTimedOutEvent,
} from './resource-budget';
import type { SkillActivation } from './state';
import type { RunTerminalOutcomeV1 } from './terminal-outcome';
import type { ToolOutcomeV1, UnknownToolFieldsObservationV1 } from './tool-outcome';

/** Runtime event metadata used for idempotency, tracing and stale-result checks. */
export interface RuntimeEventEnvelope {
  eventId: string;
  threadId: string;
  revision: number;
  causationId?: string;
  occurredAt: string;
  payload: RuntimeEvent;
}

export type RuntimeEventInput = RuntimeEvent | RuntimeEventEnvelope;

export function isRuntimeEventEnvelope(value: RuntimeEventInput): value is RuntimeEventEnvelope {
  return 'payload' in value && typeof value.eventId === 'string';
}

export type { UserInputResult } from '@/protocol/events.js';

// ── Context compaction lifecycle ──

export interface ContextCompactionRequestedEvent {
  type: 'context.compaction_requested';
  compactionId: string;
  reason: ContextCompactionReason;
  requestedAtRevision: number;
  requestedAtTurnId: string;
  /** Reserved compatibility field; all current requests use false. */
  force: boolean;
  estimate: ContextTokenEstimate;
  /** Optional user-supplied instructions for the summary model. */
  customInstructions?: string;
}

export interface ContextCompactionCompletedEvent {
  type: 'context.compaction_completed';
  compactionId: string;
  sourceRevision: number;
  checkpoint: ContextCompactionCheckpoint;
  /** End-to-end compaction effect duration. Optional for restored legacy events. */
  durationMs?: number;
}

export interface ContextCompactionFailedEvent {
  type: 'context.compaction_failed';
  compactionId: string;
  sourceRevision: number;
  errorKind: ContextCompactionErrorKind;
  message: string;
  retryable: boolean;
  /** Turn whose normal model call must not run after an automatic failure. */
  requestedAtTurnId?: string;
  /** End-to-end compaction effect duration. Optional for restored legacy events. */
  durationMs?: number;
}

export interface ContextCompactionResetEvent {
  type: 'context.compaction_reset';
  checkpointId: string;
  reason: 'manual';
}

/** Durable hard-block event reserved for proven Runtime correctness failures. */
export interface ContextHardBlockedEvent {
  type: 'context.hard_blocked';
  reason: ContextHardBlockReason;
  sourceDigest: string;
  message: string;
  createdAtTurnId: string;
}

/** Clears only the exact correctness failure that a deterministic recovery repaired. */
export interface ContextHardBlockClearedEvent {
  type: 'context.hard_block_cleared';
  reason: ContextHardBlockReason;
  sourceDigest: string;
}

// ── 工具生命周期事件 / Tool lifecycle events ──

/** 工具调用已入队，等待执行 */
export interface ToolQueuedEvent {
  type: 'tool.queued';
  toolCallId: string;
  /** Model invocation whose committed response created this call. */
  modelInvocationId?: string;
  /** Top-level task that owns this call, when one is active. */
  taskId?: string;
  name: string;
  args: unknown;
  /** 触发该工具调用的模型消息 ID / Model message ID that triggered this tool call */
  modelMessageId?: string;
  /** 该工具调用在模型消息中的序号（0-based）/ Ordinal position of this tool call in the model message */
  ordinal?: number;
  /** Classification captured before execution. */
  effectClass?: import('@/core/policies/tool-capabilities').ToolEffectClass;
  /** Whether this call crosses the task side-effect boundary. */
  sideEffect?: boolean;
  /** Human-readable reason retained for diagnostics. */
  classificationReason?: string;
  /** Dynamic MCP calls can execute only through a Runtime-issued binding. */
  bindingId?: string;
  capabilityId?: string;
  capabilityRevision?: string;
  /** Canonical private-store identity; never project to diagnostic/session telemetry. */
  invocationFingerprint?: string;
  /** Runtime-derived recovery lineage; model input is never trusted for this field. */
  recoveryOf?: string;
  recoveryMode?: import('./tool-recovery-journal').ToolRecoveryAttemptModeV1;
  unknownFields?: UnknownToolFieldsObservationV1;
  createdAt?: string;
}

/** Bindings are durable before a model can return a dynamic MCP call. */
export interface CapabilityBindingsIssuedEvent {
  type: 'capability.bindings_issued';
  catalogRevision: string;
  bindings: CapabilityBinding[];
  disclosures?: CapabilityDisclosure[];
  /** Complete revision-checked MCP schema set retained by this session. */
  loadedCapabilities?: LoadedCapability[];
  /** When present, consumes exactly one persisted search result. */
  searchId?: string;
}

/** Search discovers metadata only; it does not authorize or bind a capability. */
export interface CapabilitySearchCompletedEvent {
  type: 'capability.search_completed';
  result: CapabilitySearchResult;
}

/** The immutable Skill catalog observed by the Runtime for activation validation. */
export interface SkillCatalogRefreshedEvent {
  type: 'skill.catalog_refreshed';
  catalogRevision: string;
}

/** A validated Workflow Contract activation creates a durable Runtime frame. */
export interface SkillActivationStartedEvent {
  type: 'skill.activation_started';
  activation: SkillActivation;
}

/** A frame is closed once its work is terminal, or invalidated after catalog drift. */
export interface SkillFrameClosedEvent {
  type: 'skill.frame_closed';
  activationId: string;
  status: 'closed' | 'invalidated';
  reason: string;
  closedAt: string;
  output?: Record<string, unknown>;
}

/** A side-effecting capability has a durable intent before provider execution begins. */
export interface CapabilityInvocationRecordedEvent {
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
  effectiveEffectsDigest: string;
  effectiveEffects: EffectProfile;
  recordedAt: string;
  idempotencyKey?: string;
}

export interface CapabilityExecutionStartedEvent {
  type: 'capability.execution_started';
  invocationId: string;
  startedAt: string;
}

export interface CapabilityExecutionSucceededEvent {
  type: 'capability.execution_succeeded';
  invocationId: string;
  resultDigest: string;
  evidenceDigest: string;
  finishedAt: string;
  artifact?: CapabilityArtifactRef;
  externalReferences?: string[];
}

export interface CapabilityExecutionFailedEvent {
  type: 'capability.execution_failed';
  invocationId: string;
  error: string;
  finishedAt: string;
}

/** Recovery found a request whose provider outcome was never durably recorded. */
export interface CapabilityExecutionUnknownEvent {
  type: 'capability.execution_unknown';
  invocationId: string;
  reason: string;
  finishedAt: string;
}

/** A user- or provider-backed reconciliation resolves an unknown external outcome. */
export interface CapabilityReconciliationResolvedEvent {
  type: 'capability.reconciliation_resolved';
  invocationId: string;
  decision: 'confirmed_success' | 'confirmed_failure' | 'waived';
  reconciledAt: string;
  reason?: string;
}

export interface VerificationRequestedEvent {
  type: 'verification.requested';
  verificationId: string;
  taskId?: string;
  mode: VerificationMode;
  spec: VerificationSpecV1;
  requestedAt: string;
}

export interface VerificationStartedEvent {
  type: 'verification.started';
  verificationId: string;
  attempt: number;
  startedAt: string;
}

export interface VerificationCheckCompletedEvent {
  type: 'verification.check_completed';
  verificationId: string;
  result: VerificationCheckResult;
}

export interface VerificationCompletedEvent {
  type: 'verification.completed';
  verificationId: string;
  outcome: VerificationOutcome;
  completedAt: string;
}

export interface VerificationRepairRequestedEvent {
  type: 'verification.repair_requested';
  verificationId: string;
  repairAttempt: number;
  instruction: string;
  requestedAt: string;
}

export interface VerificationReplanRequestedEvent {
  type: 'verification.replan_requested';
  verificationId: string;
  instruction: string;
  requestedAt: string;
}

export interface VerificationWaivedEvent {
  type: 'verification.waived';
  verificationId: string;
  actor: 'user';
  reason: string;
  waivedAt: string;
}

export interface VerificationCompensationRequestedEvent {
  type: 'verification.compensation_requested';
  verificationId: string;
  requestedAt: string;
}

export interface VerificationCompensationCompletedEvent {
  type: 'verification.compensation_completed';
  verificationId: string;
  outcome: VerificationOutcome;
  summary: string;
  completedAt: string;
}

/** 工具调用开始执行 */
export interface ToolStartedEvent {
  type: 'tool.started';
  toolCallId: string;
  createdAt?: string;
}

/** 工具执行过程中的瞬态展示数据；可按 stream 合并多行，不属于可恢复事实。 */
export interface ToolProgressEvent {
  type: 'tool.progress';
  toolCallId: string;
  chunk: string;
  stream: 'stdout' | 'stderr';
  /** Logical lines represented by this bounded batch, including omitted lines. */
  lineCount?: number;
}

/** Durable allow/deny fact persisted before an admitted network socket opens. */
export interface NetworkAdmissionDecidedEvent {
  type: 'network.admission_decided';
  toolCallId: string;
  decision: NetworkDecisionReceiptV1;
}

/** Durable remote-content decision persisted before an admitted MCP request. */
export interface RemoteMcpEgressDecidedEvent {
  type: 'mcp.egress_decided';
  toolCallId: string;
  decision: RemoteMcpEgressReceiptV1;
}

/** 工具调用成功完成 */
export interface ToolFinishedEvent {
  type: 'tool.finished';
  toolCallId: string;
  createdAt?: string;
  /** 工具名称（用于 TUI 渲染 tool_done 时匹配 tool_card） */
  name: string;
  result: {
    ok: boolean;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    /** 执行层状态（success/error/exhausted），映射到 tool_done.status */
    status?: 'success' | 'error' | 'exhausted';
    /** 文件读取行数（read_file 工具） */
    totalLines?: number;
    /** 工具输出的 token 数 */
    toolTokenCount?: number;
    /** Structured ask_user result for UI consumers; stdout remains the model transcript. */
    userInput?: UserInputResult;
    /** Structured process termination cause; stderr text is never classification authority. */
    terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
    /** Provider-neutral structured facts; stdout remains model-facing content only. */
    resultMeta?: import('./state').ToolResultMeta;
  };
  /** Kernel canonicalization fills this before persistence and reducer consumption. */
  outcomeV1?: ToolOutcomeV1;
  classifierAdviceV1?: import('./tool-outcome').ToolOutcomeClassifierAdviceV1;
  classifierDiagnostic?: 'classifier_threw';
}

/** 工具调用执行失败 */
export type ToolFailedEvent = {
  type: 'tool.failed';
  toolCallId: string;
  createdAt?: string;
  /** Kernel canonicalization fills this before persistence and reducer consumption. */
  outcomeV1?: ToolOutcomeV1;
  failure: ClassifiedFailure;
};

/** 工具调用被安全策略驳回 */
export interface ToolRejectedEvent {
  type: 'tool.rejected';
  toolCallId: string;
  reason: string;
  failure?: ClassifiedFailure;
  createdAt?: string;
  /** Kernel canonicalization fills this before persistence and reducer consumption. */
  outcomeV1?: ToolOutcomeV1;
}

/** Tool call cancelled because an earlier sibling opened a user interaction. */
export interface ToolCancelledEvent {
  type: 'tool.cancelled';
  toolCallId: string;
  reason: string;
  createdAt?: string;
  /** Kernel canonicalization fills this before persistence and reducer consumption. */
  outcomeV1?: ToolOutcomeV1;
}

/** Durable non-terminal record written before one Runtime-owned safe automatic replay. */
export interface ToolRetryRecordedEvent {
  type: 'tool.retry_recorded';
  toolCallId: string;
  failure: ClassifiedFailure;
  outcomeV1: import('./tool-outcome').ToolOutcomeV1;
  recoveryOf: string;
  retryAttempt: 1;
}

// ── 用户输入交互事件 / User input interaction events ──

/** 系统向用户发起输入请求 */
export interface UserInputRequestedEvent {
  type: 'user_input.requested';
  interactionId: string;
  toolCallId: string;
  request: UserInputPayload;
}

/** 用户完成输入回复 */
export interface UserInputAnsweredEvent {
  type: 'user_input.answered';
  interactionId: string;
  toolCallId: string;
  answer: string;
  answers?: Record<string, string>;
}

/** 用户取消输入交互；这是用户真实操作产生的 durable 终态。 */
export interface UserInputCancelledEvent {
  type: 'user_input.cancelled';
  interactionId: string;
  toolCallId: string;
  reason: string;
}

// ── 方案审核交互事件 / Plan review interaction events ──

/** 系统请求用户审核执行方案 */
export interface PlanReviewRequestedEvent {
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
}

/** 用户批准方案 */
export interface PlanApprovedEvent {
  type: 'plan.approved';
  interactionId: string;
  toolCallId: string;
  planId: string;
  version: number;
  structuralDigest: string;
  /** 执行模式: accept_edits=接受编辑, auto=自动执行 */
  executionMode: 'accept_edits' | 'auto';
}

/** 用户要求修改方案 */
export interface PlanRevisionRequestedEvent {
  type: 'plan.revision_requested';
  interactionId: string;
  toolCallId: string;
  planId: string;
  version: number;
  structuralDigest: string;
  feedback: string;
}

/** A review was cancelled, but the active planning task remains in draft mode. */
export interface PlanReviewCancelledEvent {
  type: 'plan.review_cancelled';
  interactionId: string;
  toolCallId: string;
  planId: string;
  version: number;
  structuralDigest: string;
  reason: string;
}

/** A structural replan was requested while an approved plan was executing. */
export interface PlanReplanRequestedEvent {
  type: 'plan.replan_requested';
  toolCallId: string;
  reason: string;
  supersedesPlanVersion: number;
}

/** A top-level task lifecycle event. */
export interface TaskStartedEvent {
  type: 'task.started';
  taskId: string;
  userGoal: string;
  turnId: string;
}

export interface PlanningEnteredEvent {
  type: 'planning.entered';
  taskId: string;
  source: 'user_command' | 'model_request';
}

export interface PlanningExitedEvent {
  type: 'planning.exited';
  taskId: string;
  reason?: string;
}

export interface TaskCompletedEvent {
  type: 'task.completed';
  taskId: string;
  turnId: string;
}

export interface TaskCancelledEvent {
  type: 'task.cancelled';
  taskId: string;
  reason: string;
}

// ── 工具审批交互事件 / Approval interaction events ──

/** 系统请求用户审批工具调用 */
export interface ApprovalRequestedEvent {
  type: 'approval.requested';
  interactionId: string;
  toolCallId: string;
  approval: ToolApprovalPayload;
  createdAt?: string;
}

/** 用户批准工具调用 */
export interface ApprovalGrantedEvent {
  type: 'approval.granted';
  interactionId: string;
  toolCallId: string;
  grant: ShellApprovalGrant;
  createdAt?: string;
}

/** 用户拒绝工具调用 */
export interface ApprovalRejectedEvent {
  type: 'approval.rejected';
  interactionId: string;
  toolCallId: string;
  reason: string;
  failure?: ClassifiedFailure;
  createdAt?: string;
  /** Canonical rejection projection; optional only for persisted historical events. */
  outcomeV1?: ToolOutcomeV1;
}

// ── MCP Provider recovery interaction events ──

/** A terminal MCP Tool Call requires an out-of-band provider recovery action. */
export interface ProviderActionRequiredEvent {
  type: 'provider.action_required';
  interactionId: string;
  providerId: string;
  action: import('@/core/mcp/provider-errors').McpProviderRecoveryAction;
  originatingToolCallId: string;
}

/** The App shell accepted responsibility for the requested provider action. */
export interface ProviderActionStartedEvent {
  type: 'provider.action_started';
  interactionId: string;
}

/** Provider recovery completed; any subsequent capability use requires a new turn. */
export interface ProviderActionCompletedEvent {
  type: 'provider.action_completed';
  interactionId: string;
  originatingToolCallId: string;
  providerDirectoryRevision?: string;
}

/** The user deferred provider recovery without changing provider state. */
export interface ProviderActionDeferredEvent {
  type: 'provider.action_deferred';
  interactionId: string;
  originatingToolCallId: string;
}

/** The App shell attempted recovery but could not complete it. */
export interface ProviderActionFailedEvent {
  type: 'provider.action_failed';
  interactionId: string;
  originatingToolCallId: string;
  failureCode: 'authentication_failed' | 'approval_denied' | 'provider_unavailable' | 'unknown';
}

// ── Required MCP Provider admission events ──

export interface ProviderAdmissionRequiredEvent {
  type: 'provider.admission_required';
  interactionId: string;
  providerId: string;
  source: import('@/core/mcp/runtime-provider').McpProviderDirectoryEntry['source'];
  providerStatus: import('@/core/mcp/runtime-provider').McpProviderDirectoryStatus;
  diagnosticCode?: import('@/core/mcp/runtime-provider').McpProviderDirectoryEntry['diagnosticCode'];
  retryable: boolean;
}

export interface ProviderAdmissionRetryRequestedEvent {
  type: 'provider.admission_retry_requested';
  interactionId: string;
}

export interface ProviderAdmissionRetryFailedEvent {
  type: 'provider.admission_retry_failed';
  interactionId: string;
  providerStatus: import('@/core/mcp/runtime-provider').McpProviderDirectoryStatus;
  diagnosticCode?: import('@/core/mcp/runtime-provider').McpProviderDirectoryEntry['diagnosticCode'];
}

export interface ProviderAdmissionSatisfiedEvent {
  type: 'provider.admission_satisfied';
  interactionId: string;
  providerDirectoryRevision: string;
}

export interface ProviderAdmissionWaivedEvent {
  type: 'provider.admission_waived';
  interactionId: string;
  providerId: string;
  source: import('@/core/mcp/runtime-provider').McpProviderDirectoryEntry['source'];
  reason: 'user_session_waiver';
  waivedAt: string;
}

export interface ProviderAdmissionCancelledEvent {
  type: 'provider.admission_cancelled';
  interactionId: string;
  providerId: string;
}

// ── 运行时环境事件 / Runtime environment events ──

/** 授权模式变更 / Authorization mode changed */
export interface AuthorizationChangedEvent {
  type: 'authorization.changed';
  mode: AuthorizationMode;
  /** Persisted exact-command grants.  Carry the full set because this event is
   * the runtime-state handoff for a graph-side authorization decision. */
  commandGrants?: Record<string, ToolGrant>;
  modeSource?: import('@/core/types').AuthorizationSource;
  modeGrantedAt?: string;
}

/** User-selected interaction mode changed while a Runtime may still be active. */
export interface InteractionModeChangedEvent {
  type: 'interaction_mode.changed';
  mode: import('@/protocol/events').InteractionMode;
  /** This control event is only emitted after an explicit TUI selection. */
  source: 'user';
  /** ISO-8601 timestamp for authorization provenance. */
  changedAt: string;
}

// ── Auto-review 事件 / Auto-review events ──

/** 自动审查请求 / Auto-review requested */
export interface AutoReviewRequestedEvent {
  type: 'auto_review.requested';
  reviewId: string;
  toolCallId: string;
  /** 工具名称 / Tool name */
  toolName: string;
  /** auto-review 原因 / Reason for auto-review */
  reason: string;
  /** 工具审批负载 / Tool approval payload */
  approval: import('@/protocol/events').ToolApprovalPayload;
  createdAt?: string;
}

export type AutoReviewFailureType = 'technical' | 'invalid_response';

/** 自动审查完成 / Auto-review completed */
export interface AutoReviewCompletedEvent {
  type: 'auto_review.completed';
  reviewId: string;
  toolCallId: string;
  /** Committed reviewer invocation that produced this decision. */
  modelInvocationId?: string;
  /**
   * `ok: true` is an actual reviewer decision; only that path can approve or
   * escalate a tool. `ok: false` is a technical failure and must also be
   * escalated to the normal user-approval interaction.
   */
  result:
    | {
        ok: true;
        approved: boolean;
        /** A risk decision is non-terminal when it has been handed to the user. */
        escalatedToUser?: true;
        grant?: string;
        reason?: string;
        reviewerModelName: string;
        durationMs: number;
      }
    | {
        ok: false;
        approved: false;
        failureType: AutoReviewFailureType;
        reason?: string;
        reviewerModelName: string;
        durationMs: number;
      };
  /** Present on a current rejection terminal; absent on non-terminals and historical records. */
  outcomeV1?: ToolOutcomeV1;
  createdAt?: string;
}

// ── Turn 生命周期事件 / Turn lifecycle events ──

/** Turn 开始 — 每个用户输入启动一个新 turn */
export interface TurnStartedEvent {
  type: 'turn.started';
  turnId: string;
}

/** Turn 正常完成 / Turn completed normally */
export interface TurnCompletedEvent {
  type: 'turn.completed';
  turnId: string;
}

/** Turn 异常中止 / Turn aborted */
export interface TurnAbortedEvent {
  type: 'turn.aborted';
  turnId: string;
  reason: string;
  /** Distinguishes an explicit user stop from an unexpected runtime failure. */
  cause?: 'user' | 'error';
}

// ── 用户消息事件 / User message events ──

/** 用户消息追加到转录 / User message appended to transcript */
export interface UserMessageAppendedEvent {
  type: 'user.message_appended';
  messageId: string;
  content: string;
  /** Current user-authored goal before App-owned/project context is appended. */
  userGoal?: string;
  createdAt?: string;
}

/** 用户执行了不进入模型 transcript 的本地命令 / User invoked a local command. */
export interface UserCommandInvokedEvent {
  type: 'user.command_invoked';
  commandId: string;
  command: string;
}

// ── 模型交互事件 / Model interaction events ──

/** 向模型发起请求 / Model request initiated */
export interface ModelRequestedEvent {
  type: 'model.requested';
  requestId: string;
  /** New Gateway emissions bind transcript presentation to durable invocation evidence. */
  invocationId?: string;
}

/** Frozen Surface and admission/resource facts acknowledged before any Provider attempt. */
export interface ModelInvocationPreparedEvent {
  type: 'model.invocation_prepared';
  invocationId: string;
  purpose: ModelInvocationPurposeV1;
  surfaceArtifact: PrivateArtifactRefV1 & { kind: 'model_surface' };
  surfaceIntegrityIdentifier: string;
  routeFingerprint: Sha256DigestV1;
  admission: ModelInvocationEnvelopeV1['admission'];
  budget: ModelInvocationEnvelopeV1['resource']['budget'];
  limits: ModelInvocationEnvelopeV1['resource']['limits'];
  preparedStateRevision: number;
  parentInvocationId: string | null;
  parentToolCallId: string | null;
}

/** One acknowledged external attempt intent. Dispatch is forbidden before this event commits. */
export interface ModelInvocationAttemptStartedEvent {
  type: 'model.invocation_attempt_started';
  invocationId: string;
  attempt: number;
  maxAttempts: number;
}

/** Private response receipt acknowledged before its normalized response may be consumed. */
export interface ModelInvocationCompletedEvent {
  type: 'model.invocation_completed';
  invocationId: string;
  responseArtifact: PrivateArtifactRefV1 & { kind: 'model_response' };
  finishReason: ModelFinishReasonV1;
}

/** Recovery terminal for an invocation without an acknowledged completion receipt. */
export interface ModelInvocationInterruptedEvent {
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
}

/** Completed transcript remains valid while strict model replay is disabled. */
export interface ModelInvocationEvidenceUnavailableEvent {
  type: 'model.invocation_evidence_unavailable';
  invocationId: string;
  reasonCode: 'artifact_missing' | 'artifact_corrupt' | 'key_unavailable';
}

/** Ephemeral cumulative reasoning text for live consumers; never persisted. */
export interface ModelReasoningDeltaEvent {
  type: 'model.reasoning_delta';
  /** Stable within one reasoning segment; absent on legacy producers. */
  segmentId?: string;
  text: string;
}

/** Ephemeral boundary for one complete reasoning segment; never persisted. */
export interface ModelReasoningCompletedEvent {
  type: 'model.reasoning_completed';
  segmentId: string;
  text: string;
}

/** Ephemeral cumulative answer text for live consumers; never persisted. */
export interface ModelTextDeltaEvent {
  type: 'model.text_delta';
  text: string;
}

/** 模型响应返回（含可选的 tool_calls 和文本）/ Model response returned */
export interface ModelRespondedEvent {
  type: 'model.responded';
  messageId: string;
  /** New Gateway emissions bind transcript presentation to durable invocation evidence. */
  invocationId?: string;
  createdAt?: string;
  /** 本次模型调用耗时（ms）——思考+响应生成时长，不含工具执行。
   *  TUI 用它作为 "Thinking · Xs" 的计时（对齐 Claude Code：思考指示器
   *  只计模型调用时长）。可选：旧事件日志无此字段，TUI 回退创建→settle 墙钟。
   *  Duration of this model call (ms) — thinking + response generation,
   *  excluding tool execution. The TUI uses it as the "Thinking · Xs"
   *  elapsed (Claude Code parity). Optional: absent in old event logs. */
  durationMs?: number;
  /** 模型生成的工具调用（如有）/ Tool calls generated by the model (if any) */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: unknown;
    /** Canonical-private identity for pre-parse failures; never project to Provider context. */
    canonicalInvocationFingerprint?: string;
  }>;
  /** 模型生成的推理/思考内容（如有）/ Reasoning content generated by the model (if any) */
  reasoningText?: string;
  /** 模型生成的文本（如有）/ Text generated by the model (if any) */
  text?: string;
  /** Provider-reported usage used for cumulative run-budget reconciliation. */
  inputTokens?: number;
  outputTokens?: number;
}

/** A retry observed while invoking the model. */
export interface ModelRetryEvent {
  type: 'model.retry';
  attempt: number;
  maxAttempts: number;
  error: string;
  delayMs: number;
}

/** Prompt cache metrics observed after a model call. */
export interface ModelCacheMetricsEvent {
  type: 'model.cache_metrics';
  inputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRate: number;
}

/** Estimated full-request utilization observed before a model call. */
export interface ModelContextMetricsEvent {
  type: 'model.context_metrics';
  modelName: string;
  contextWindowTokens?: number;
  contextWindowSource?: import('@/core/model/model-capabilities').ModelCapabilitySource;
  tokenizerSource?: import('@/core/model/model-capabilities').ModelCapabilitySource;
  usableInputTokens?: number;
  reservedOutputTokens?: number;
  providerSafetyMarginTokens?: number;
  totalInputTokens: number;
  utilization?: number;
  status: import('@/core/model/context-budget').ContextPressure;
  estimate: import('@/core/model/context-budget').ContextTokenEstimate;
}

/** Durable terminal output.  Consumers do not infer completion from graph state. */
export interface RunCompletedEvent {
  type: 'run.completed';
  turnId: string;
  output: string;
  /** New emissions bind the accepted CompletionGuard decision version. */
  completionGuardVersion?: import('./completion-guard').CompletionGuardVersion;
  /** Required for new V2 emissions; absent on legacy V1 completion events. */
  planIdentity?: PlanIdentity;
  outcome?: RunTerminalOutcomeV1;
}

/** A final-text candidate was rejected before it could become durable completion truth. */
export interface CompletionBlockedEvent {
  type: 'completion.blocked';
  turnId: string;
  guardVersion: import('./completion-guard').CompletionGuardVersion;
  code: import('./completion-guard').CompletionBlockerCode;
  nextAction: import('./completion-guard').CompletionNextAction;
  planning: import('@/protocol/events').PlanningState['kind'];
  correctionAttempt: number;
  /** Full strict identity for CompletionGuard V2; absent for V1 replay. */
  planIdentity?: PlanIdentity;
}

/** A recoverable or terminal runtime failure exposed on the public protocol. */
export interface RunErrorEvent {
  type: 'run.error';
  message: string;
  recoverable: boolean;
  failure?: ClassifiedFailure;
  effectId?: string;
  turnId?: string;
  outcome?: RunTerminalOutcomeV1;
}

/** Internal telemetry for an action that lost a race with another interaction. */
export interface RuntimeActionIgnoredEvent {
  type: 'runtime.action_ignored';
  interactionId?: string;
  reason: string;
}

/** Late process cleanup diagnostics never rewrite an already terminal tool/turn. */
export interface RuntimeCancellationDiagnosticEvent {
  type: 'runtime.cancellation_diagnostic';
  toolCallId: string;
  failure: ClassifiedFailure;
  unconfirmedDescendantCount: number;
}

/** Safe release-policy readiness projection; contains no endpoint or payload content. */
export interface ProviderDataPolicyStatusEvent {
  type: 'provider.data_policy_status';
  status: 'ready' | 'blocked';
  reason: import('@/core/config/provider-data-admission').ProviderDataAdmissionReasonV1;
  registryDigest?: string;
  policyRevision?: string;
}

// ── Plan 生命周期补充事件 / Additional plan lifecycle events ──

/** Plan 草案已生成 / Plan draft has been generated */
export interface PlanDraftedEvent {
  type: 'plan.drafted';
  toolCallId: string;
  taskId: string;
  plan: AgentPlan;
  structuralHash: string;
  /** Plan ID generated by the tool-controller — stable across revisions / 方案 ID，跨修订版本稳定 */
  planId: string;
  /** Version number as of this write_plan call / 本次 write_plan 调用后的版本号 */
  version: number;
  /** Current pre-release Plan schema. */
  planSchemaVersion: 2;
  supersedesPlanVersion?: number;
  replanReason?: string;
  artifact: PlanArtifactRef;
}

/** Plan 进度更新（仅 status 变化，不触发 review）/ Plan progress updated (status-only change) */
export interface PlanProgressUpdatedEvent {
  type: 'plan.progress_updated';
  toolCallId: string;
  taskId: string;
  plan: AgentPlan;
  planId: string;
  version: number;
  structuralDigest: string;
  completionEvidence: import('@/protocol/events').PlanCompletionEvidenceV1;
}

/** Plan 执行完成 / Plan execution completed */
export interface PlanCompletedEvent {
  type: 'plan.completed';
  toolCallId: string;
  taskId: string;
  plan: AgentPlan;
  planId: string;
  version: number;
  structuralDigest: string;
  completionEvidence: import('@/protocol/events').PlanCompletionEvidenceV1;
}

// ── Approval 补充事件 / Additional approval events ──

/** 用户替换审批中的命令 / User replaced the command in an approval */
export interface ApprovalCommandReplacedEvent {
  type: 'approval.command_replaced';
  interactionId: string;
  command: string;
}

// ── 工具副作用事件 / Tool side-effect events ──

/** 工具执行导致文件变更 / Tool execution caused file changes */
export interface ToolFileChangeEvent {
  type: 'tool.file_change';
  toolCallId: string;
  path: string;
  kind: 'add' | 'edit' | 'delete';
  linesAdded?: number;
  linesRemoved?: number;
  preview?: string;
}

// ── Subagent lifecycle events ──

/** A delegated subagent started work. */
export interface SubagentStartedEvent {
  type: 'subagent.started';
  subagent: SubAgentStartPayload;
}

/** A delegated subagent started a tool step. */
export interface SubagentStepEvent {
  type: 'subagent.step';
  subagent: SubAgentStepPayload;
}

/** A delegated subagent finished a tool step. */
export interface SubagentToolResultEvent {
  type: 'subagent.tool_result';
  subagent: SubAgentToolResultPayload;
}

/** A delegated subagent completed normally. */
export interface SubagentCompletedEvent {
  type: 'subagent.completed';
  subagent: SubAgentDonePayload;
}

/** A delegated subagent stopped with an error. */
export interface SubagentFailedEvent {
  type: 'subagent.failed';
  subagent: SubAgentErrorPayload;
}

/** Cache usage reported by a delegated subagent. */
export interface SubagentCacheMetricsEvent {
  type: 'subagent.cache_metrics';
  subagent: SubAgentCacheMetricsPayload;
}

/** A delegated subagent is paused pending approval and can be resumed from this snapshot. */
export interface SubagentSuspendedEvent {
  type: 'subagent.suspended';
  toolCallId: string;
  snapshot: SuspendedSubagentSnapshot;
}

/** A concurrently suspended sibling waits until the current child approval settles. */
export interface SubagentApprovalDeferredEvent {
  type: 'subagent.approval_deferred';
  toolCallId: string;
}

/** Private canonical child journal merge; omitted by all diagnostic projections. */
export interface SubagentRecoveryJournalMergedEvent {
  type: 'subagent.recovery_journal_merged';
  toolCallId: string;
  journal: import('./tool-recovery-journal').ToolRecoveryJournalV1;
}

// ── 运行时事件联合类型 / Runtime event discriminated union ──

/** 运行时事件 — 所有状态变更的统一类型表示 */
export type RuntimeEvent =
  | ResourceBudgetConfiguredEvent
  | ResourceBudgetReservedEvent
  | ResourceBudgetDispatchStartedEvent
  | ResourceBudgetReconciledEvent
  | ResourceBudgetReleasedEvent
  | ResourceBudgetUnknownEvent
  | ResourceBudgetWaiterEnqueuedEvent
  | ResourceBudgetWaiterPromotedEvent
  | ResourceBudgetWaiterCancelledEvent
  | ResourceBudgetWaiterTimedOutEvent
  | ContextCompactionRequestedEvent
  | ContextCompactionCompletedEvent
  | ContextCompactionFailedEvent
  | ContextCompactionResetEvent
  | ContextHardBlockedEvent
  | ContextHardBlockClearedEvent
  | CapabilityBindingsIssuedEvent
  | CapabilitySearchCompletedEvent
  | SkillCatalogRefreshedEvent
  | SkillActivationStartedEvent
  | SkillFrameClosedEvent
  | CapabilityInvocationRecordedEvent
  | CapabilityExecutionStartedEvent
  | CapabilityExecutionSucceededEvent
  | CapabilityExecutionFailedEvent
  | CapabilityExecutionUnknownEvent
  | CapabilityReconciliationResolvedEvent
  | VerificationRequestedEvent
  | VerificationStartedEvent
  | VerificationCheckCompletedEvent
  | VerificationCompletedEvent
  | VerificationRepairRequestedEvent
  | VerificationReplanRequestedEvent
  | VerificationWaivedEvent
  | VerificationCompensationRequestedEvent
  | VerificationCompensationCompletedEvent
  | ToolQueuedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | NetworkAdmissionDecidedEvent
  | RemoteMcpEgressDecidedEvent
  | ToolFinishedEvent
  | ToolFailedEvent
  | ToolRejectedEvent
  | ToolCancelledEvent
  | ToolRetryRecordedEvent
  | UserInputRequestedEvent
  | UserInputAnsweredEvent
  | UserInputCancelledEvent
  | PlanReviewRequestedEvent
  | PlanApprovedEvent
  | PlanRevisionRequestedEvent
  | PlanReviewCancelledEvent
  | PlanReplanRequestedEvent
  | TaskStartedEvent
  | PlanningEnteredEvent
  | PlanningExitedEvent
  | TaskCompletedEvent
  | TaskCancelledEvent
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent
  | ApprovalRejectedEvent
  | ProviderActionRequiredEvent
  | ProviderActionStartedEvent
  | ProviderActionCompletedEvent
  | ProviderActionDeferredEvent
  | ProviderActionFailedEvent
  | ProviderAdmissionRequiredEvent
  | ProviderAdmissionRetryRequestedEvent
  | ProviderAdmissionRetryFailedEvent
  | ProviderAdmissionSatisfiedEvent
  | ProviderAdmissionWaivedEvent
  | ProviderAdmissionCancelledEvent
  | AuthorizationChangedEvent
  | InteractionModeChangedEvent
  | AutoReviewRequestedEvent
  | AutoReviewCompletedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnAbortedEvent
  | UserMessageAppendedEvent
  | UserCommandInvokedEvent
  | ModelRequestedEvent
  | ModelInvocationPreparedEvent
  | ModelInvocationAttemptStartedEvent
  | ModelInvocationCompletedEvent
  | ModelInvocationInterruptedEvent
  | ModelInvocationEvidenceUnavailableEvent
  | ModelReasoningDeltaEvent
  | ModelReasoningCompletedEvent
  | ModelTextDeltaEvent
  | ModelRespondedEvent
  | ModelRetryEvent
  | ModelCacheMetricsEvent
  | ModelContextMetricsEvent
  | RunCompletedEvent
  | CompletionBlockedEvent
  | RunErrorEvent
  | RuntimeActionIgnoredEvent
  | RuntimeCancellationDiagnosticEvent
  | ProviderDataPolicyStatusEvent
  | PlanDraftedEvent
  | PlanProgressUpdatedEvent
  | PlanCompletedEvent
  | ApprovalCommandReplacedEvent
  | ToolFileChangeEvent
  | SubagentStartedEvent
  | SubagentStepEvent
  | SubagentToolResultEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | SubagentCacheMetricsEvent
  | SubagentSuspendedEvent
  | SubagentApprovalDeferredEvent
  | SubagentRecoveryJournalMergedEvent;
