// ── Agent Runtime Kernel 运行时状态类型定义 / Runtime state type definitions ──
// Phase 2: 统一运行时状态 — 替代分散的 AgentState channel，提供类型安全的 discriminated union
// Phase 2: Unified runtime state — replaces scattered AgentState channels with type-safe discriminated unions

import type { AutoReviewState } from '@/core/execution/circuit-breaker';
import { DEFAULT_AUTO_REVIEW_STATE } from '@/core/execution/circuit-breaker';
import type { ToolEffectClass } from '@/core/policies/tool-capabilities';
import type { AuthorizationSource, ToolGrant } from '@/core/types';
import type {
  AgentPlan,
  AuthorizationMode,
  InteractionMode,
  PlanArtifactRef,
  PlanningState,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
} from '@/protocol/events.js';
import { getAgentPhase } from '@/protocol/events.js';
import type { SuspendedSubagentSnapshot } from '@/protocol/subagent.js';
import type { ClassifiedFailure } from './failures';

// ── Re-export for convenience ──
export { getAgentPhase };

export type TaskStatus = 'active' | 'completed' | 'cancelled';
export type TaskExecutionMode = 'auto' | 'accept_edits';

/** A top-level user task owns its complete planning lifecycle. */
export interface TaskState {
  taskId: string;
  userGoal: string;
  status: TaskStatus;
  startedAtTurnId: string;
  completedAtTurnId?: string;
  sideEffectsStarted: boolean;
  planning: PlanningState;
  executionMode?: TaskExecutionMode;
  /** Structural plan versions retained when a task is replanned. */
  planHistory: import('@/protocol/events').PlanDocument[];
}

export function getActiveTask(state: RuntimeState): TaskState | null {
  return state.activeTaskId ? (state.tasks[state.activeTaskId] ?? null) : null;
}

/** Active Task is authoritative; `planning` is a compatibility mirror for v3 callers. */
export function getActivePlanning(state: RuntimeState): PlanningState {
  const active = getActiveTask(state);
  if (active) return active.planning;
  // Once a Task has ended, its historical plan must not project as the
  // current Thread phase. The legacy mirror is only used for pre-Task
  // snapshots that have no task history at all.
  if (Object.keys(state.tasks).length > 0) return { kind: 'building_without_plan' };
  return state.planning;
}

export function getEffectiveInteractionMode(state: RuntimeState): InteractionMode {
  return getActiveTask(state)?.executionMode ?? state.mode;
}

export function updateActiveTask(
  state: RuntimeState,
  update: (task: TaskState) => TaskState,
): RuntimeState {
  const active = getActiveTask(state);
  if (!active) return state;
  const nextTask = update(active);
  return {
    ...state,
    tasks: { ...state.tasks, [nextTask.taskId]: nextTask },
    planning: nextTask.planning,
  };
}

export function setActivePlanning(state: RuntimeState, planning: PlanningState): RuntimeState {
  const active = getActiveTask(state);
  if (!active) return { ...state, planning };
  return updateActiveTask(state, (task) => ({ ...task, planning }));
}

// ── 交互状态 / Interaction state ──

/**
 * 交互状态 — 用户输入、方案审核、工具审批的统一状态表示。
 * Interaction state — unified representation for user input, plan review, and tool approval.
 */
export type InteractionState =
  | { kind: 'idle' }
  | {
      kind: 'awaiting_user_input';
      /** 交互标识，关联 user_input 中断 / Interaction id linking to the user_input interrupt */
      interactionId: string;
      /** 触发该交互的工具调用 ID / Tool call id that triggered this interaction */
      toolCallId: string;
      /** 用户输入请求负载 / User input request payload */
      request: UserInputPayload;
    }
  | {
      kind: 'awaiting_review';
      /** 交互标识，关联 plan_review 中断 / Interaction id linking to the plan_review interrupt */
      interactionId: string;
      /** 触发该审核的工具调用 ID / Tool call id that triggered this review */
      toolCallId: string;
      /** 方案 ID，用于 action 校验 / Plan ID for action validation */
      planId: string;
      /** 方案版本，用于 action 校验 / Plan version for action validation */
      version: number;
      /** 方案结构化摘要，用于 action 校验 / Structural digest for action validation */
      structuralDigest: string;
      /** 待审核的方案 / Plan awaiting review */
      plan: AgentPlan;
      /** 方案摘要（用于用户展示）/ Plan summary for user display */
      planSummary: string;
      /** Durable file reference used to load the reviewed content. */
      artifact?: PlanArtifactRef;
    }
  | {
      kind: 'awaiting_tool_approval';
      /** 交互标识，关联审批中断 / Interaction id linking to the approval interrupt */
      interactionId: string;
      /** 触发审批的工具调用 ID / Tool call id that triggered this approval */
      toolCallId: string;
      /** 工具审批负载 / Tool approval payload */
      approval: ToolApprovalPayload;
    }
  | {
      kind: 'awaiting_auto_review';
      /** 交互标识，关联 auto-review / Interaction id linking to the auto-review */
      interactionId: string;
      /** 触发 auto-review 的工具调用 ID / Tool call id that triggered this auto-review */
      toolCallId: string;
      /** 工具名称 / Tool name */
      toolName: string;
      /** auto-review 原因 / Reason for auto-review */
      reason: string;
      /** 工具审批负载 / Tool approval payload */
      approval: ToolApprovalPayload;
    };

// ── 工具调用状态 / Tool call status ──

/**
 * 工具调用生命周期状态 — 从入队到最终结果的完整状态机。
 * Tool call lifecycle status — complete state machine from queued to final outcome.
 *
 * - 'queued': 已入队，等待执行 / Queued, waiting to execute
 * - 'awaiting_user_input': 执行中需要用户输入 / Executing, needs user input
 * - 'awaiting_review': 执行中触发方案审核 / Executing, triggered plan review
 * - 'awaiting_approval': 等待用户审批 / Waiting for user approval
 * - 'awaiting_auto_review': 等待自动审查 / Waiting for auto-review
 * - 'approved': 已审批通过，等待执行 / Approved, pending execution
 * - 'running': 正在执行 / Currently running
 * - 'succeeded': 执行成功 / Execution succeeded
 * - 'failed': 执行失败 / Execution failed
 * - 'rejected': 被安全策略或用户拒绝 / Rejected by security policy or user
 * - 'cancelled': 被取消 / Cancelled
 * - 'exhausted': 连续失败达上限，系统已阻断 / Consecutive failures hit cap, system has blocked
 */
export type ToolCallStatus =
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

// ── 工具调用记录 / Tool call record ──

/**
 * 单个工具调用的完整生命周期记录。
 * Complete lifecycle record for a single tool call.
 */
export interface ToolCallRecord {
  /** 工具调用唯一标识 / Unique tool call identifier */
  toolCallId: string;
  /** Top-level task that owns this call, when it was queued. */
  taskId?: string;
  /** 触发该工具调用的模型消息 ID / Model message id that triggered this tool call */
  modelMessageId: string;
  /** Position in the originating model message, used to cancel later siblings. */
  ordinal?: number;
  /** 工具名称 / Tool name */
  name: string;
  /** 工具调用参数 / Tool call arguments */
  args: unknown;
  /** 工具调用当前状态 / Current tool call status */
  status: ToolCallStatus;
  /** 创建该工具调用的 turn ID / Turn id when this tool call was created */
  createdAtTurnId: string;
  /** 审批哈希（用于缓存审批结果）/ Approval hash for caching approval decisions */
  approvalHash?: string;
  /** The one-shot or persisted grant selected for this specific execution. */
  approvalGrant?: import('@/protocol/events').ShellApprovalGrant;
  /** 工具执行结果（成功后填充）/ Tool execution result (populated on success) */
  result?: {
    /** 执行是否成功 / Whether execution was successful */
    ok: boolean;
    /** 结果摘要 / Result summary */
    summary: string;
    /** 进程退出码（shell 工具时可用）/ Process exit code (available for shell tools) */
    exitCode?: number;
  };
  /** 错误信息（失败时填充）/ Error message (populated on failure) */
  error?: string;
  /** Structured failure metadata retained for retry policy and replay. */
  failure?: ClassifiedFailure;
  /** Capability classification captured when the call was queued. */
  effectClass?: ToolEffectClass;
  /** Whether the call has crossed the active task's side-effect boundary. */
  sideEffect?: boolean;
  /** Classification explanation retained for diagnostics. */
  classificationReason?: string;
}

// ── 工具运行时状态 / Tool runtime state ──

/**
 * 工具运行时状态 — 管理所有工具调用的队列和执行状态。
 * Tool runtime state — manages the queue and execution status of all tool calls.
 */
export interface ToolRuntimeState {
  /** 所有工具调用记录，按 toolCallId 索引 / All tool call records, indexed by toolCallId */
  calls: Record<string, ToolCallRecord>;
  /** 工具调用执行队列（toolCallId 顺序列表）/ Tool call execution queue (ordered list of toolCallIds) */
  queue: string[];
  /** 当前正在执行的工具调用 ID 列表 / Currently active tool call ids */
  active: string[];
}

/** JSON-safe transcript.  LangChain message instances are rebuilt only at the
 * model boundary and are never persisted in RuntimeStore. */
export type TranscriptMessage =
  | { kind: 'user'; messageId: string; content: string }
  | {
      kind: 'assistant';
      messageId: string;
      content?: string;
      reasoningText?: string;
      toolCalls: Array<{ id: string; name: string; args: unknown }>;
    }
  | { kind: 'tool'; toolCallId: string; name: string; content: string; ok: boolean };

export interface TranscriptState {
  messages: TranscriptMessage[];
  final?: string;
}

// ── 运行时状态 / Runtime state ──

/** Runtime state schema version for migration compatibility. */
export const RUNTIME_STATE_SCHEMA_VERSION = 5;

export type RuntimeRecoveryState =
  | { kind: 'normal' }
  | { kind: 'corrupted'; reason: string }
  | { kind: 'incompatible'; schemaVersion: number };

/**
 * 统一运行时状态 — runtime kernel 的核心状态对象。
 * Unified runtime state — the core state object for the runtime kernel.
 *
 * 替代原先分散在 LangGraph AgentState 中的多个 channel，
 * 通过 discriminated union 提供类型安全的访问模式。
 * Replaces multiple scattered channels in the LangGraph AgentState,
 * providing type-safe access via discriminated unions.
 */
export interface RuntimeState {
  /** Active top-level task. Only this task is exposed to model execution. */
  activeTaskId: string | null;
  /** Historical and active top-level tasks, keyed by taskId. */
  tasks: Record<string, TaskState>;
  /** 状态 schema 版本，用于迁移兼容 / Schema version for migration compatibility */
  schemaVersion: number;
  /** Monotonic revision incremented after each durable event. */
  revision: number;
  /** Last event identity applied by the kernel. */
  lastAppliedEventId?: string;
  /** Recent event identities used for idempotent replay. */
  appliedEventIds: string[];
  /** Recovery status; non-normal states prevent new effects. */
  recoveryState: RuntimeRecoveryState;
  /** 会话信息 / Session information */
  session: {
    /** LangGraph 线程 ID / LangGraph thread id */
    threadId: string;
    /** 用户 ID / User id */
    userId: string;
    /** 工作目录路径 / Workspace path */
    workspace: string;
  };
  /** 当前对话轮次 / Current conversation turn */
  turn: {
    /** 当前 turn 唯一标识 / Current turn unique id */
    turnId: string;
    /** Turn 序号（从 0 开始递增）/ Turn index (incrementing from 0) */
    turnIndex: number;
  };
  /** Persisted, provider-neutral transcript used to rebuild model context. */
  transcript: TranscriptState;
  /** 方案生命周期状态（v2: PlanningState 取代 PlanLifecycleState）/ Plan lifecycle state */
  planning: PlanningState;
  /** 交互状态（用户输入、方案审核、工具审批）/ Interaction state (user input, plan review, tool approval) */
  interactions: InteractionState;
  /** 工具运行时状态 / Tool runtime state */
  tools: ToolRuntimeState;
  /** Paused subagents keyed by their parent task tool call. */
  suspendedSubagents: Record<string, SuspendedSubagentSnapshot>;
  /** One-shot notice for a legacy subagent approval that cannot be resumed. */
  legacyUnrecoverableSubagentApproval?: {
    toolCallId: string;
    subagentId: string;
    reason: string;
  };
  /** 授权状态 / Authorization state */
  authorization: {
    /** 授权模式 / Authorization mode */
    mode: AuthorizationMode;
    /** full_access 的来源（user / config / test / system）/ Source of full_access elevation */
    modeSource?: AuthorizationSource;
    /** full_access 的授予时间 / Timestamp when full_access was granted */
    modeGrantedAt?: string;
    /** 命令授权记录，key 为 workspace+threadId+command 的组合键 / Command grant records */
    commandGrants: Record<string, ToolGrant>;
  };
  /** 交互模式（ask/auto/full）/ Interaction mode */
  mode: InteractionMode;
  /** 工作区访问权限 / Workspace access level */
  workspaceAccess: WorkspaceAccess;
  /** Auto-review 持久化状态 / Auto-review persistent state */
  autoReview: AutoReviewState;
  /** doom-loop 重复调用追踪 / Doom-loop repeat call tracker */
  doomLoop: Record<string, { count: number; lastSeenAt: number }>;
}

// ── 工厂函数 / Factory functions ──

/** 创建初始运行时状态的输入参数 / Input parameters for creating initial runtime state */
export interface CreateRuntimeStateInput {
  /** 线程 ID / Thread id */
  threadId: string;
  /** 用户 ID / User id */
  userId: string;
  /** 工作目录 / Workspace path */
  workspace: string;
  /** 交互模式，默认 'accept_edits' / Interaction mode, defaults to 'accept_edits' */
  interactionMode?: InteractionMode;
  /** 授权模式，默认 'default' / Authorization mode, defaults to 'default' */
  authorizationMode?: AuthorizationMode;
  authorizationSource?: AuthorizationSource;
  /** 工作区访问权限，默认 'write' / Workspace access, defaults to 'write' */
  workspaceAccess?: WorkspaceAccess;
  /** 初始执行阶段，默认 'building' / Initial phase, defaults to 'building' */
  phase?: 'planning' | 'building';
}

/**
 * 创建初始运行时状态。
 * Creates the initial runtime state for a new session.
 *
 * @param input - 初始化参数 / Initialization parameters
 * @returns 初始运行时状态 / Initial runtime state
 */
export function createInitialRuntimeState(input: CreateRuntimeStateInput): RuntimeState {
  const phase = input.phase ?? 'building';
  const initialPlanning: PlanningState =
    phase === 'planning' ? { kind: 'planning_empty' } : { kind: 'building_without_plan' };
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    revision: 0,
    appliedEventIds: [],
    recoveryState: { kind: 'normal' },
    session: {
      threadId: input.threadId,
      userId: input.userId,
      workspace: input.workspace,
    },
    turn: {
      turnId: crypto.randomUUID(),
      turnIndex: 0,
    },
    transcript: { messages: [] },
    planning: initialPlanning,
    activeTaskId: null,
    tasks: {},
    interactions: { kind: 'idle' },
    tools: {
      calls: {},
      queue: [],
      active: [],
    },
    suspendedSubagents: {},
    authorization: {
      mode: input.authorizationMode ?? 'default',
      ...(input.authorizationMode === 'full_access'
        ? {
            modeSource: input.authorizationSource ?? 'system',
            modeGrantedAt: new Date().toISOString(),
          }
        : {}),
      commandGrants: {},
    },
    mode: input.interactionMode ?? ('accept_edits' as InteractionMode),
    workspaceAccess: input.workspaceAccess ?? 'write',
    autoReview: { ...DEFAULT_AUTO_REVIEW_STATE },
    doomLoop: {},
  };
}

// ── 工具函数 / Utility functions ──

export { computePlanStructuralDigest } from './hashes';
