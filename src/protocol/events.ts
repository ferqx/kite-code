// ── 核心事件类型 / Core event types ──
export type AgentEvent =
  | { type: 'step_begin'; data: { node: string; spanId: string; internal?: boolean } }
  | { type: 'step_end'; data: { node: string; spanId: string } }
  | { type: 'reason'; data: { text: string } }
  | { type: 'text'; data: { text: string } }
  | { type: 'tool_call'; data: ToolCallPayload }
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
export type ShellApprovalGrant = 'approve_once' | 'same_command' | 'full_access';
export type ShellGrantUsed = 'none' | ShellApprovalGrant;
export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentPlanStep {
  step: string;
  status: PlanStatus;
}

export interface AgentPlan {
  name: string;
  description: string;
  status: PlanStatus;
  steps: AgentPlanStep[];
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
}

/** Shell 工具实时输出负载 — 进程运行期间逐行推送 / Per-line progress payload emitted during shell execution */
export interface ToolProgressPayload {
  call_id: string;
  name: string;
  /** 单行文本（不含换行符）/ Single line of output (no newline) */
  chunk: string;
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
  modelJustification?: string;
  objective?: string;
  expectedObservation?: string;
  failureStrategy?: string;
  suggestedPrefixRule?: string[];
  /** update_plan 的方案数据（审批时嵌入） */
  plan?: AgentPlan;
  /** 子 agent ID，当审批来自子 agent 的工具调用时填充 / Sub-agent ID when approval originates from a sub-agent's tool call */
  subagentId?: string;
}

// ── 子 Agent 事件 / Sub-agent events ──
export type SubAgentRole = 'explore' | 'plan' | 'code' | 'review';

export interface SubAgentStartPayload {
  id: string;
  role: SubAgentRole;
  task: string;
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
