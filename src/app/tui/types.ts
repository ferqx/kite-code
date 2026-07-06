import type {
  AgentPhase,
  AgentPlan,
  AuthorizationMode,
  SubAgentRole,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
} from '@/protocol/events';

/** 合并工具摘要中的单条工具记录 / Single tool entry in a consolidated summary */
export interface ConsolidatedToolEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  elapsedMs?: number;
  status: 'running' | 'done' | 'error' | 'cancelled' | 'timeout' | 'exhausted';
  /** 读取文件时的文件总行数 / Total lines for read_file tool */
  totalLines?: number;
}

export type ThoughtActivity = { kind: 'thinking'; text: string } | { kind: 'tool'; callId: string };

export interface SubAgentStepRecord {
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** 步生命周期状态，渲染层只读此字段决定颜色，不依赖任何布尔组合推断
   *  Step lifecycle status — the single source of truth for color decisions.
   *  pending → awaiting_approval → success | rejected | error */
  status: 'pending' | 'awaiting_approval' | 'success' | 'rejected' | 'error';
  /** 工具执行结果（仅 success / error 时有意义），保留用于日志和调试
   *  Tool execution outcome (meaningful only for success / error status), kept for logging */
  ok?: boolean;
  /** 读取文件时的文件总行数，用于 TUI 行号范围展示 / Total lines in file for read_file, used for TUI line range display */
  totalLines?: number;
}

export type OutputBlock =
  | { id: number; kind: 'user'; content: string }
  | { id: number; kind: 'text'; content: string; streaming?: boolean; isError?: boolean }
  | { id: number; kind: 'reason'; content: string; folded: boolean }
  | {
      id: number;
      kind: 'tool_card';
      callId: string;
      name: string;
      args: Record<string, unknown>;
      status: 'running' | 'done' | 'error' | 'cancelled' | 'timeout' | 'exhausted';
      summary: string;
      preview?: string;
      /** 工具实际开始执行的时间戳（用于 live 计时器），排除审批等待后会被重置 / Wall-clock timestamp when tool actually began executing (for live timer), reset after approval to exclude wait time */
      startedAt?: number;
      elapsedMs?: number;
      detail?: string;
      expanded?: boolean;
      /** 工具运行期间的实时输出（逐行追加，tail-follow 最近 5 行），done/error 后由 summary 替代渲染 */
      liveOutput?: string;
      /** liveOutput 被截断前的总行数，用于展示截断计数 */
      liveTotalLines?: number;
      /** Shell timeout duration parsed from timeout summary / shell 超时时长 */
      timeoutMs?: number;
    }
  | {
      id: number;
      kind: 'tool_summary';
      tools: ConsolidatedToolEntry[];
      totalElapsedMs: number;
      createdAt: number;
      summaryLine: string;
      active: boolean;
      /** 是否有过 reason 思考块 — 用于三态顶行：Thought + tools / 仅 Thought / 仅 tools */
      hasThought: boolean;
      latestActivity?: ThoughtActivity;
      /** 整体结果状态（仅 active=false 时有意义），替代从子 tool 状态推断 / Overall outcome (meaningful when active=false), replaces boolean inference */
      result?: 'done' | 'error' | 'cancelled';
    }
  | { id: number; kind: 'file_change'; changes: FileChangeRecord[] }
  | {
      id: number;
      kind: 'approval';
      approval: ToolApprovalPayload;
      resolved?: { action: string; grant?: string; pattern?: string };
    }
  | {
      id: number;
      kind: 'question';
      question: UserInputPayload;
      resolved?: string | { text: string; answers?: Record<string, string> };
    }
  | {
      id: number;
      kind: 'subagent';
      subagentId: string;
      role: SubAgentRole;
      task: string;
      status: 'running' | 'done' | 'error' | 'cancelled';
      summary: string;
      toolCallCount: number;
      durationMs: number;
      steps: SubAgentStepRecord[];
      /** 子 agent 实际开始执行的时间戳（用于 live 计时器）/ Wall-clock timestamp when sub-agent actually started (for live timer) */
      startedAt?: number;
      error?: string;
      expanded?: boolean;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
      /** 子 agent 正在等待工具审批 / Sub-agent is awaiting tool approval */
      awaitingApproval?: boolean;
      /** 正在等待审批的步骤索引，用于 tool_result 回来后标记 rejected / Step index being approved, used to mark as rejected on tool_result */
      approvingStepIndex?: number;
    };

/** 一次完整的「用户提问 → Agent 回复」往返 */
export interface Turn {
  blocks: OutputBlock[];
}

export interface FileChangeRecord {
  path: string;
  kind: 'add' | 'edit' | 'delete';
  linesAdded?: number;
  linesRemoved?: number;
  preview?: string;
}

export interface TuiState {
  // ── 多会话 ──
  sessions: SessionSnapshot[];
  activeSessionId: string | null;

  // ── 现有字段保留不变 ──
  turns: Turn[];
  nextBlockId: number;
  interrupt: InterruptState | null;
  toolStartTimes?: Record<string, number>;
  status: StatusState;
  exited: boolean;
  running: boolean;
  runCount: number;
  runStartTime?: number;
  runTokenBaseline?: number;
  currentRunReasonId?: number;
  showHelp: boolean;
  showModelSelector: boolean;
  showSessions: boolean;
  showMcp: boolean;
  showRewind: boolean;
  checkpoints: import('@/core/persistence/checkpoint').CheckpointEntry[];
  rewindCounter: number;
  pendingSkills: string[];
  skillManifests: import('@/core/skills/types').SkillManifest[];
  ctrlCPressed: boolean;
  sessionKey: number;
  exitRequested: boolean;
  sessionError: boolean;
  /** 正在从 DB 加载的会话 ID，null 表示未在加载 / ID of the session being loaded from DB, null when not loading */
  loadingSessionId: string | null;
  /** 探索工具 callId → tool_summary block ID 映射，用于 tool_done 精确定位 */
  explorationSummaryIds: Record<string, number>;
  /** 当前未被可见文本或非探索工具打断的 Thought summary block ID */
  currentThoughtSummaryId?: number;
  /** 交互模式：ask（询问审批）/ auto（自动审核）/ full（自主运行） */
  interactionMode: 'ask' | 'auto' | 'full';
}

export type InterruptState =
  | { kind: 'approval'; blockId: number }
  | { kind: 'input'; blockId: number }
  | { kind: 'plan_review'; plan?: import('@/protocol/events').AgentPlan };

export interface RetryState {
  attempt: number;
  maxAttempts: number;
  error: string;
  delayMs: number;
}

export interface StatusState {
  phase: AgentPhase;
  plan: AgentPlan | null;
  /** 待审批的方案（区别于已审批的 plan）/ Pending plan awaiting review (distinct from approved plan) */
  pendingPlan: AgentPlan | null;
  authorization: AuthorizationMode;
  workspaceAccess: WorkspaceAccess;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number;
  totalTokens: number;
  currentNode: string | null;
  modelProvider: string;
  modelName: string;
  thinkingMode: string;
  retryState: RetryState | null;
}

export interface SessionSnapshot {
  threadId: string;
  name: string;
  workspace: string;
  active: boolean;
  running: boolean;
  pendingInterrupt: boolean;
  /** Full interrupt state for session-switch restoration. Set on switch-away, read on switch-back. */
  interrupt: InterruptState | null;
  plan: import('@/protocol/events').AgentPlan | null;
  status: StatusState;
  turns: Turn[];
}
