// ── 核心事件类型 / Core event types ──
export type AgentEvent =
  | { type: 'step_begin'; data: { node: string; spanId: string; internal?: boolean } }
  | { type: 'step_end'; data: { node: string; spanId: string } }
  | { type: 'reason'; data: { text: string } }
  | { type: 'text'; data: { text: string } }
  | { type: 'tool_call'; data: ToolCallPayload }
  | { type: 'tool_started'; data: ToolStartedPayload }
  | { type: 'tool_done'; data: ToolResultPayload }
  | { type: 'need_approval'; data: ToolApprovalPayload }
  | { type: 'need_input'; data: UserInputPayload }
  | { type: 'need_plan_review'; data: NeedPlanReviewPayload }
  | { type: 'state_change'; data: StateChangePayload }
  | {
      type: 'file_change';
      data: {
        path: string;
        kind: 'add' | 'edit' | 'delete';
        linesAdded?: number;
        linesRemoved?: number;
        preview?: string;
      };
    }
  | { type: 'cache_metrics'; data: CacheMetricsPayload }
  | { type: 'error'; data: { message: string; recoverable: boolean } }
  /** LangGraph interrupt — payload depends on the interrupted node's resume type, consumed by TUI/CLI for user interaction resolution */
  | { type: 'interrupt'; data: unknown }
  /** Raw LangGraph state update chunk — opaque passthrough for checkpoint/state tracking consumers */
  | { type: 'update'; data: unknown }
  | {
      type: 'model_retry';
      data: { attempt: number; maxAttempts: number; error: string; delayMs: number };
    }
  | { type: 'final'; data: string }
  | { type: 'subagent_start'; data: SubAgentStartPayload }
  | { type: 'subagent_step'; data: SubAgentStepPayload }
  | { type: 'subagent_tool_result'; data: SubAgentToolResultPayload }
  | { type: 'subagent_done'; data: SubAgentDonePayload }
  | { type: 'subagent_error'; data: SubAgentErrorPayload }
  | { type: 'subagent_cache_metrics'; data: SubAgentCacheMetricsPayload }
  /** Shell 工具实时输出 — 进程运行期间逐行推送 stdout/stderr，使 TUI 实时展示执行进度 */
  | { type: 'tool_progress'; data: ToolProgressPayload }
  // ── 会话/对话边界 / Conversation turn boundaries ──
  | { type: 'turn_begin'; data: { index: number; spanId: string } }
  | { type: 'turn_end'; data: { index: number } }
  | { type: 'user_message'; data: UserMessagePayload };

// ── 基础类型 / Base types ──
export type WorkspaceAccess = 'write';
export type AgentPhase = 'planning' | 'building';
/** 工作区访问请求模式（CLI --mode 参数），已废弃 read-only/plan / Workspace access request mode (CLI --mode), read-only/plan deprecated */
export type WorkspaceAccessRequest = 'auto' | WorkspaceAccess | 'builder';
export type AuthorizationMode = 'default' | 'full_access';
export const InteractionMode = {
  AcceptEdits: 'accept_edits',
  Auto: 'auto',
  Full: 'full',
} as const;
export type InteractionMode = (typeof InteractionMode)[keyof typeof InteractionMode];

export type ShellApprovalGrant = 'approve_once' | 'same_command' | 'full_access';
export type ShellGrantUsed = 'none' | ShellApprovalGrant;

/** 判断是否为全自动放行模式（目前只有 full） */
export function isFullAccessMode(mode: InteractionMode): boolean {
  return mode === InteractionMode.Full;
}
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface AgentPlanStep {
  step: string;
  status: PlanStatus;
  /** Stable v2 identity retained while legacy renderers consume `step`. */
  id?: string;
  note?: string;
}

export interface AgentPlan {
  name: string;
  description: string;
  status: PlanStatus;
  steps: AgentPlanStep[];
}

// ── Plan Mode v2: PlanDocument + PlanningState (replaces AgentPlan) ──

/** 执行步骤 — ID 稳定，title 一行描述 / Execution step with stable ID and one-line title */
export interface PlanStep {
  /** 稳定 ID，如 "inspect-runtime" / Stable ID, e.g. "inspect-runtime" */
  id: string;
  /** 一行描述，最多 160 字符 / One-line description, max 160 chars */
  title: string;
  /** 执行状态 / Execution status */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** 可选备注 / Optional note */
  note?: string;
}

/** Metadata-only Runtime evidence attached to a V2 PlanDocument. */
export interface PlanCompletionEvidenceV1 {
  schemaVersion: 1;
  verification: Array<{ verificationId: string; outcome: 'passed' | 'waived' }>;
  execution: Array<{ toolCallId: string; outcome: 'succeeded' }>;
  skipped: Array<{ stepId: string; reasonCode: string }>;
  unresolved: Array<{ kind: 'failure' | 'approval'; referenceId: string }>;
}

/** Strict identity shared by Plan transitions and completion decisions. */
export interface PlanIdentity {
  planId: string;
  version: number;
  structuralDigest: string;
}

/** 方案文档 — 用户审核的主内容 / Plan document — primary content for user review */
export interface PlanDocument {
  /** Present and fixed for newly written plans; absent legacy documents are read/replay only. */
  planSchemaVersion?: 2;
  /** 方案唯一标识 / Unique plan identifier */
  planId: string;
  /** 方案版本号，每次结构修改递增 / Version, incremented on each structural change */
  version: number;
  /** 一行标题，最多 120 字符 / One-line title, max 120 chars */
  title: string;
  /** 用户审核的主内容 / Main content for user review */
  bodyMarkdown: string;
  /** 结构稳定的执行步骤 / Structurally stable execution steps */
  steps: PlanStep[];
  /** SHA-256，仅对 title/body/step id+title 计算 / SHA-256 of title, body, step ids+title only */
  structuralDigest: string;
  /** 创建该版本的 turn ID / Turn ID when this version was created */
  createdAtTurnId: string;
  /** 最后更新该版本的 turn ID / Turn ID when this version was last updated */
  updatedAtTurnId: string;
  /** Version replaced by a structural replan, when applicable. */
  supersedesPlanVersion?: number;
  /** Why the structural replan was requested. */
  replanReason?: string;
  /** Runtime-derived references only; never accepts model-authored execution content. */
  completionEvidence?: PlanCompletionEvidenceV1;
  /** Durable user-level Markdown Artifact for this version. */
  artifact?: PlanArtifactRef;
}

/** Durable reference to a user-level immutable Plan Artifact. */
export interface PlanArtifactRef {
  artifactId: string;
  taskId: string;
  planId: string;
  version: number;
  fileName: string;
  /** Path relative to the user-level Kite Code directory. */
  relativePath: string;
  /** Resolved path for local UI/CLI display and controlled reads. */
  displayPath: string;
  structuralDigest: string;
  byteLength: number;
}

/**
 * 方案生命周期状态 — discriminated union 替代独立的 phase + plan。
 * Plan lifecycle state — discriminated union replacing independent phase + plan.
 *
 * Phase 通过 selector `getAgentPhase()` 推导，不再独立持久化。
 * Phase is derived via `getAgentPhase()` selector, no longer independently persisted.
 */
export type PlanningState =
  | { kind: 'building_without_plan' }
  | { kind: 'planning_empty' }
  | {
      kind: 'planning_draft';
      document: PlanDocument;
      /** 用户修订反馈（仅在 revision_requested 后设置）/ User revision feedback (set after revision_requested) */
      revisionFeedback?: string;
    }
  | {
      kind: 'replanning_draft';
      document: PlanDocument;
      supersedesPlanVersion: number;
      replanReason: string;
      revisionFeedback?: string;
    }
  | {
      kind: 'awaiting_review';
      document: PlanDocument;
      /** 交互标识，关联 plan_review 中断 / Interaction id linking to the plan_review interrupt */
      interactionId: string;
      /** 触发该审核的 write_plan 工具调用 ID / write_plan tool call id that triggered this review */
      exitToolCallId: string;
    }
  | {
      kind: 'executing';
      document: PlanDocument;
      /** 执行模式：ask=每次确认，accept_edits=自动接受工作区编辑，auto=自动执行 / Execution mode */
      executionMode: 'accept_edits' | 'auto';
      /** 方案审批通过的 turn ID / Turn id when plan was approved */
      approvedAtTurnId: string;
    }
  | {
      kind: 'completed';
      document: PlanDocument;
      /** 方案完成的 turn ID / Turn id when plan was completed */
      completedAtTurnId: string;
    }
  | {
      kind: 'cancelled';
      /** 取消时可能没有方案 / May not have a document when cancelled */
      document?: PlanDocument;
      /** 取消原因 / Reason for cancellation */
      reason: string;
      /** 取消发生的 turn ID / Turn id when cancelled */
      cancelledAtTurnId: string;
    };

/**
 * 从 PlanningState 推导当前执行阶段。
 * Derives the current execution phase from PlanningState.
 *
 * planning_empty / planning_draft / awaiting_review → 'planning'
 * 所有其他状态 → 'building'
 */
export function getAgentPhase(planning: PlanningState): AgentPhase {
  switch (planning.kind) {
    case 'planning_empty':
    case 'planning_draft':
    case 'replanning_draft':
    case 'awaiting_review':
      return 'planning';
    default:
      return 'building';
  }
}

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputRequest {
  question: string;
  options: UserInputOption[];
  allow_free_text: boolean;
  context?: string;
  /** 推荐的选项 id / Recommended option id */
  recommended?: string;
  /** 多问题模式：一次 ask_user 携带多个问题，TUI 用分步 wizard 渲染 / Multi-question mode */
  questions?: UserInputQuestion[];
}

// ── Payload 类型 / Payload types ──
export interface ToolCallPayload {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  /** queued when graph has enqueued the call; omitted means legacy running */
  status?: 'queued' | 'running';
}

export interface ToolStartedPayload {
  call_id: string;
}

/** Structured answer returned by an ask_user tool call. */
export interface UserInputResult {
  answer: string;
  answers?: Record<string, string>;
}

/** Shell 工具实时输出负载 — 进程运行期间按展示帧批量推送 / Batched progress payload emitted during shell execution */
export interface ToolProgressPayload {
  call_id: string;
  name: string;
  /** 一条或多条完整行；批内以 LF 连接 / One or more complete lines joined by LF */
  chunk: string;
  /** 批次代表的逻辑行总数，可能大于 chunk 中保留的尾部行数 */
  line_count?: number;
  /** 来源流 / Source stream */
  stream: 'stdout' | 'stderr';
}

export interface ToolResultPayload {
  call_id: string;
  name: string;
  ok: boolean;
  summary: string;
  /** Shell/process exit code when available / 可用时的进程退出码 */
  exitCode?: number;
  /** 读取文件时的文件总行数，用于 TUI 行号范围展示 / Total lines in file for read_file, used for TUI line range display */
  totalLines?: number;
  /** 工具输出的 token 数，用于独立于 provider 的累计统计 / Token count of the tool output for provider-agnostic cumulative tracking */
  toolTokenCount?: number;
  /** 执行层工具状态。'exhausted' 表示连续失败达上限，系统已阻断该路径。
   *  / Execution-layer tool status. 'exhausted' means consecutive failures hit the cap
   *  and the system has blocked this path. */
  status?: 'success' | 'error' | 'cancelled' | 'timeout' | 'exhausted';
  /** 自动审批失败时 reviewFailure 携带原因。工具执行成功+审批失败=工具绿色✓+审批警告红色⚠。
   *  When auto-review fails, reviewFailure carries the reason. Tool ok + reviewFailure = green ✓ + red ⚠. */
  reviewFailure?: string;
  /** Structured ask_user result, retained separately from the display summary. */
  userInput?: UserInputResult;
}

export interface UserInputQuestion {
  id?: string;
  question: string;
  options: UserInputOption[];
  /** 推荐的选项 id（对应 options 中某一项的 id），TUI 渲染时展示 ⭐ 推荐标记 */
  recommended?: string;
  allow_free_text?: boolean;
}

export interface UserInputPayload {
  question: string;
  options: UserInputOption[];
  allow_free_text: boolean;
  context?: string;
  /** 推荐的选项 id / Recommended option id */
  recommended?: string;
  /** 多问题模式：一次 ask_user 携带多个问题，TUI 用分步 wizard 渲染 / Multi-question mode: ask multiple at once, TUI renders as step wizard */
  questions?: UserInputQuestion[];
}

export interface NeedPlanReviewPayload {
  plan: AgentPlan;
  /** Durable user-level Markdown Artifact for this plan version. */
  artifact?: PlanArtifactRef;
}

/** 用户输入消息负载 / User message payload */
export interface UserMessagePayload {
  text: string;
  kind: 'task' | 'answer' | 'resume_context';
  /** 关联的 interrupt 类型，仅 answer 时有值 */
  interruptType?: 'approval' | 'input';
}

export interface StateChangePayload {
  workspaceAccess?: WorkspaceAccess;
  phase?: AgentPhase;
  plan?: AgentPlan | null;
  authorization?: { mode: AuthorizationMode };
  interactionMode?: InteractionMode;
  modelProvider?: string;
  modelName?: string;
}

/** 提示缓存命中指标 / Prompt cache hit metrics */
export interface PromptCacheMetrics {
  /** 输入 token 数 / Input token count */
  inputTokens: number;
  /** 缓存命中 token 数 / Cache hit token count */
  cacheHitTokens: number;
  /** 缓存未命中 token 数 / Cache miss token count */
  cacheMissTokens: number;
  /** 缓存命中率 / Cache hit rate (0-1) */
  hitRate: number;
}

/** prompt cache 标准汇总 / Prompt cache standard summary */
export interface PromptCacheStandardSummary extends PromptCacheMetrics {
  /** 已观察到的缓存指标调用数 / Observed metric call count */
  totalCalls: number;
  /** 被视为 warmup 的调用数 / Calls treated as warmup */
  warmupCalls: number;
  /** 计入标准判断的调用数 / Calls included in standard evaluation */
  measuredCalls: number;
  /** 目标命中率 / Target hit rate */
  targetHitRate: number;
  /** 最小有效计入输入 token 数 / Minimum measured input tokens before judging */
  minimumMeasuredInputTokens: number;
  /** 当前样本量是否足够判断 / Whether measured token volume is enough to judge */
  hasEnoughMeasuredTokens: boolean;
  /** 是否达到目标；无计入调用时为 null / Whether target is met; null when no measured calls exist */
  meetsTarget: boolean | null;
}

/** 单次 cache_metrics 事件上的标准评估 / Standard evaluation attached to one cache_metrics event */
export interface PromptCacheStandardEvaluation {
  /** 当前缓存指标调用序号，从 1 开始 / Current metric call index, starting from 1 */
  callIndex: number;
  /** 当前调用是否为 warmup / Whether current call is warmup */
  isWarmup: boolean;
  /** 当前调用是否计入标准判断 / Whether current call is included in standard evaluation */
  includedInStandard: boolean;
  /** 目标命中率 / Target hit rate */
  targetHitRate: number;
  /** 最小有效计入输入 token 数 / Minimum measured input tokens before judging */
  minimumMeasuredInputTokens: number;
  /** 当前 run 的累计标准汇总 / Accumulated standard summary for current run */
  summary: PromptCacheStandardSummary;
}

export interface CacheMetricsPayload {
  workspaceAccess: WorkspaceAccess;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens?: number;
  hitRate?: number;
  standard: PromptCacheStandardEvaluation;
}

export interface ToolApprovalPayload {
  scope: 'once';
  /** Tool call id this approval belongs to. */
  callId?: string;
  cwd: string;
  threadId: string;
  tool: string;
  command: string;
  risk:
    | 'read'
    | 'plan'
    | 'write_file'
    | 'execute_code'
    | 'destructive'
    | 'network'
    | 'vcs_mutation'
    | 'unknown';
  approvalHash: string;
  summary: string;
  reason: string;
  expectedEffects: string[];
  grantOptions: ShellApprovalGrant[];
  recommendedGrant: ShellApprovalGrant;
  /** update_plan 的方案数据（审批时嵌入） */
  plan?: AgentPlan;
  /** 子 agent ID，当审批来自子 agent 的工具调用时填充 / Sub-agent ID when approval originates from a sub-agent's tool call */
  subagentId?: string;
  /** Auto-review failure/rejection reason shown on the pending tool card. */
  reviewFailure?: string;
}

// ── 子 Agent 事件 / Sub-agent events ──
export type SubAgentRole = 'explore' | 'plan' | 'code' | 'review';

export interface SubAgentStartPayload {
  id: string;
  role: SubAgentRole;
  task: string;
  /** Runtime dispatch identity shared only by siblings admitted in one parallel batch. */
  concurrencyGroupId?: string;
}

export interface SubAgentStepPayload {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** 工具耗时（ms，result 回填）/ Duration filled in retroactively by result event */
  durationMs?: number;
}

export interface SubAgentToolResultPayload {
  id: string;
  toolName: string;
  ok: boolean;
  /** 工具输出摘要（截断），用于日志记录 / Tool output summary (truncated) for log recording */
  summary?: string;
  /** 读取文件时的文件总行数，用于 TUI 行号范围展示 / Total lines in file for read_file, used for TUI line range display */
  totalLines?: number;
  /** 工具输出的 token 数，用于独立于 provider 的累计统计 / Token count of the tool output for provider-agnostic cumulative tracking */
  toolTokenCount?: number;
  /** 工具执行耗时（ms）/ Tool execution duration */
  durationMs?: number;
  /** 失败原因（结构化枚举）/ Structured failure reason */
  failureReason?: string;
}

export interface SubAgentDonePayload {
  id: string;
  summary: string;
  toolCallCount: number;
  durationMs: number;
}

export interface SubAgentErrorPayload {
  id: string;
  error: string;
  summary?: string;
  toolCallCount?: number;
  durationMs?: number;
}

export interface SubAgentCacheMetricsPayload {
  subagentId: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  inputTokens: number;
}
