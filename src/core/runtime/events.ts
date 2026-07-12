// ── Agent Runtime Kernel 运行时事件类型 / Runtime event types ──
// Phase 1: 工具生命周期 + 交互事件
// 所有状态变更通过类型化事件表示，供 runtime 内部及各层消费者使用

import type {
  AgentPlan,
  AuthorizationMode,
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
import type { SuspendedSubagentSnapshot } from '@/protocol/subagent.js';

export type { UserInputResult } from '@/protocol/events.js';

// ── 工具生命周期事件 / Tool lifecycle events ──

/** 工具调用已入队，等待执行 */
export interface ToolQueuedEvent {
  type: 'tool.queued';
  toolCallId: string;
  name: string;
  args: unknown;
  /** 触发该工具调用的模型消息 ID / Model message ID that triggered this tool call */
  modelMessageId?: string;
  /** 该工具调用在模型消息中的序号（0-based）/ Ordinal position of this tool call in the model message */
  ordinal?: number;
}

/** 工具调用开始执行 */
export interface ToolStartedEvent {
  type: 'tool.started';
  toolCallId: string;
}

/** 工具执行过程中产生进度数据（如 shell 逐行输出） */
export interface ToolProgressEvent {
  type: 'tool.progress';
  toolCallId: string;
  chunk: string;
  stream: 'stdout' | 'stderr';
}

/** 工具调用成功完成 */
export interface ToolFinishedEvent {
  type: 'tool.finished';
  toolCallId: string;
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
  };
}

/** 工具调用执行失败 */
export interface ToolFailedEvent {
  type: 'tool.failed';
  toolCallId: string;
  error: string;
}

/** 工具调用被安全策略驳回 */
export interface ToolRejectedEvent {
  type: 'tool.rejected';
  toolCallId: string;
  reason: string;
}

/** Tool call cancelled because an earlier sibling opened a user interaction. */
export interface ToolCancelledEvent {
  type: 'tool.cancelled';
  toolCallId: string;
  reason: string;
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
  answer: string;
  answers?: Record<string, string>;
}

// ── 方案审核交互事件 / Plan review interaction events ──

/** 系统请求用户审核执行方案 */
export interface PlanReviewRequestedEvent {
  type: 'plan.review_requested';
  interactionId: string;
  toolCallId: string;
  plan: AgentPlan;
  planSummary: string;
}

/** 用户批准方案 */
export interface PlanApprovedEvent {
  type: 'plan.approved';
  interactionId: string;
  /** 执行模式: accept_edits=接受编辑, auto=自动执行 */
  executionMode: 'accept_edits' | 'auto';
}

/** 用户要求修改方案 */
export interface PlanRevisionRequestedEvent {
  type: 'plan.revision_requested';
  interactionId: string;
  feedback: string;
}

/** 用户拒绝方案 */
export interface PlanRejectedEvent {
  type: 'plan.rejected';
  interactionId: string;
  reason: string;
}

// ── 工具审批交互事件 / Approval interaction events ──

/** 系统请求用户审批工具调用 */
export interface ApprovalRequestedEvent {
  type: 'approval.requested';
  interactionId: string;
  toolCallId: string;
  approval: ToolApprovalPayload;
}

/** 用户批准工具调用 */
export interface ApprovalGrantedEvent {
  type: 'approval.granted';
  interactionId: string;
  grant: ShellApprovalGrant;
}

/** 用户拒绝工具调用 */
export interface ApprovalRejectedEvent {
  type: 'approval.rejected';
  interactionId: string;
  reason: string;
}

// ── 运行时环境事件 / Runtime environment events ──

/** 授权模式变更 / Authorization mode changed */
export interface AuthorizationChangedEvent {
  type: 'authorization.changed';
  mode: AuthorizationMode;
  /** Persisted exact-command grants.  Carry the full set because this event is
   * the runtime-state handoff for a graph-side authorization decision. */
  commandGrants?: Record<string, { workspace: string; threadId: string; command: string }>;
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
}

/** 自动审查完成 / Auto-review completed */
export interface AutoReviewCompletedEvent {
  type: 'auto_review.completed';
  reviewId: string;
  toolCallId: string;
  result: {
    ok: boolean;
    approved: boolean;
    grant?: string;
    reason?: string;
    reviewerModelName: string;
    durationMs: number;
  };
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
}

// ── 用户消息事件 / User message events ──

/** 用户消息追加到转录 / User message appended to transcript */
export interface UserMessageAppendedEvent {
  type: 'user.message_appended';
  messageId: string;
  content: string;
}

// ── 模型交互事件 / Model interaction events ──

/** 向模型发起请求 / Model request initiated */
export interface ModelRequestedEvent {
  type: 'model.requested';
  requestId: string;
}

/** 模型响应返回（含可选的 tool_calls 和文本）/ Model response returned */
export interface ModelRespondedEvent {
  type: 'model.responded';
  messageId: string;
  /** 模型生成的工具调用（如有）/ Tool calls generated by the model (if any) */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** 模型生成的推理/思考内容（如有）/ Reasoning content generated by the model (if any) */
  reasoningText?: string;
  /** 模型生成的文本（如有）/ Text generated by the model (if any) */
  text?: string;
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

/** Durable terminal output.  Consumers do not infer completion from graph state. */
export interface RunCompletedEvent {
  type: 'run.completed';
  turnId: string;
  output: string;
}

/** A recoverable or terminal runtime failure exposed on the public protocol. */
export interface RunErrorEvent {
  type: 'run.error';
  message: string;
  recoverable: boolean;
}

// ── Plan 生命周期补充事件 / Additional plan lifecycle events ──

/** Plan 草案已生成 / Plan draft has been generated */
export interface PlanDraftedEvent {
  type: 'plan.drafted';
  toolCallId: string;
  plan: AgentPlan;
  structuralHash: string;
  /** Plan ID generated by the tool-controller — stable across revisions / 方案 ID，跨修订版本稳定 */
  planId: string;
  /** Version number as of this write_plan call / 本次 write_plan 调用后的版本号 */
  version: number;
}

/** Plan 进度更新（仅 status 变化，不触发 review）/ Plan progress updated (status-only change) */
export interface PlanProgressUpdatedEvent {
  type: 'plan.progress_updated';
  toolCallId: string;
  plan: AgentPlan;
}

/** Plan 执行完成 / Plan execution completed */
export interface PlanCompletedEvent {
  type: 'plan.completed';
  toolCallId: string;
  plan: AgentPlan;
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

// ── 运行时事件联合类型 / Runtime event discriminated union ──

/** 运行时事件 — 所有状态变更的统一类型表示 */
export type RuntimeEvent =
  | ToolQueuedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolFinishedEvent
  | ToolFailedEvent
  | ToolRejectedEvent
  | ToolCancelledEvent
  | UserInputRequestedEvent
  | UserInputAnsweredEvent
  | PlanReviewRequestedEvent
  | PlanApprovedEvent
  | PlanRevisionRequestedEvent
  | PlanRejectedEvent
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent
  | ApprovalRejectedEvent
  | AuthorizationChangedEvent
  | AutoReviewRequestedEvent
  | AutoReviewCompletedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnAbortedEvent
  | UserMessageAppendedEvent
  | ModelRequestedEvent
  | ModelRespondedEvent
  | ModelRetryEvent
  | ModelCacheMetricsEvent
  | RunCompletedEvent
  | RunErrorEvent
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
  | SubagentSuspendedEvent;
