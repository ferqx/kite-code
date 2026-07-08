// ── Agent Runtime Kernel 运行时事件类型 / Runtime event types ──
// Phase 1: 工具生命周期 + 交互事件
// 所有状态变更通过类型化事件表示，供 runtime 内部及各层消费者使用

import type {
  AgentPlan,
  AuthorizationMode,
  ShellApprovalGrant,
  ToolApprovalPayload,
  UserInputPayload,
} from '@/protocol/events.js';

// ── 工具生命周期事件 / Tool lifecycle events ──

/** 工具调用已入队，等待执行 */
export interface ToolQueuedEvent {
  type: 'tool.queued';
  toolCallId: string;
  name: string;
  args: unknown;
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
  result: {
    ok: boolean;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
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
  executionMode: 'manual' | 'auto';
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
}

/** 执行阶段变更 / Execution phase changed */
export interface PhaseChangedEvent {
  type: 'phase.changed';
  phase: 'planning' | 'building';
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
  | PhaseChangedEvent;
