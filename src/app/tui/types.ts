import type {
  AgentPhase,
  AgentPlan,
  AuthorizationMode,
  SubAgentRole,
  ToolApprovalPayload,
  UserInputPayload,
  UserInputResult,
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
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout' | 'exhausted';
  /** 读取文件时的文件总行数 / Total lines for read_file tool */
  totalLines?: number;
  /** 自动审批失败原因。工具执行成功但审批失败时展示 / Auto-review failure reason. Shown when tool ok but review failed. */
  reviewFailure?: string;
}

export type ThoughtActivity = { kind: 'thinking'; text: string } | { kind: 'tool'; callId: string };

/** Thought 时间线条目：记录思考/工具事件的先后顺序，渲染时按序交错 */
export interface ThoughtTimelineEntry {
  seq: number;
  kind: 'thinking' | 'tool';
  text?: string; // thinking 时的 reason 文本
  callId?: string; // tool 时的 callId
}

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
  | {
      id: number;
      kind: 'text';
      content: string;
      streaming?: boolean;
      /** Compatibility marker for mutable text that cannot enter Static yet. */
      responsePending?: boolean;
      isError?: boolean;
      /** Model invocation that owns this live/reconnected response segment. */
      modelRequestId?: string;
      /** Recognized structural component whose shell is visible while complete
       * child rows are appended. The hidden source retains the unfinished row. */
      streamingComponent?: 'code' | 'table';
      streamingSource?: string;
      /** 被文本关闭的纯思考块并入的时长（ms，ADR-0026）。存在时在文本块顶部
       *  渲染暗色 "Thought for Xs" 题头行；独立思考块已删除，时长全量转移。
       *  Elapsed (ms) of a pure-thinking block merged in when text closed it
       *  (ADR-0026). Renders a dim "Thought for Xs" header above the content;
       *  the standalone block was removed with its elapsed fully transferred. */
      thoughtElapsedMs?: number;
      /** Complete reasoning revealed only after model.responded, merged with the Thought header. */
      thoughtContent?: string;
    }
  | { id: number; kind: 'reason'; content: string; folded: boolean }
  | {
      id: number;
      kind: 'tool_card';
      callId: string;
      name: string;
      args: Record<string, unknown>;
      status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout' | 'exhausted';
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
      /** 自动审批失败原因。工具卡状态为 done(绿) 时，单独以红色展示此警告 / Auto-review failure reason. Shown in red alongside green done status. */
      reviewFailure?: string;
      /** Structured answer returned by ask_user, independent of the truncated summary. */
      userInput?: UserInputResult;
      /** The durable Plan body was materialized by plan.review_requested. */
      reviewedPlanBody?: boolean;
    }
  | {
      id: number;
      kind: 'tool_summary';
      tools: ConsolidatedToolEntry[];
      totalElapsedMs: number;
      createdAt: number;
      /** 该轮模型调用累计耗时（ms，来自 model.responded.durationMs，不含工具执行）。
       *  存在时 totalElapsedMs 以此为准（对齐 Claude Code "Thought for Xs" 计时语义）；
       *  旧事件日志无此字段，回退创建→settle 墙钟。
       *  Accumulated model-call duration (ms, from model.responded.durationMs,
       *  excluding tool execution). When present, totalElapsedMs follows it
       *  (Claude Code "Thought for Xs" semantics); absent in old logs → wall clock. */
      modelMs?: number;
      summaryLine: string;
      active: boolean;
      /** Keep a just-closed streamed Thought dynamic until model.responded
       *  removes its transient reasoning preview. */
      responsePending?: boolean;
      /** Model invocation that most recently contributed reasoning to this phase. */
      modelRequestId?: string;
      /** 是否有过 reason 思考块 — 用于三态顶行：Thought + tools / 仅 Thought / 仅 tools */
      hasThought: boolean;
      latestActivity?: ThoughtActivity;
      /** 本 Thought 生命周期内是否出现过思考（reason 事件）。
       *  用于渲染时区分 "Thought for 3s · read 2 files"（有思考）vs "read 2 files"（仅工具统计）。
       *  Whether any reasoning (reason events) occurred during this Thought's lifetime.
       *  Controls the summary label: with thinking → "Thought for Xs · <tool stats>", without → just tool counts. */
      hasThinking?: boolean;
      /** 事件时间线：记录 reason / tool_call 的先后顺序，渲染时按序交错思考行与工具步骤。
       *  Event timeline: records reason/tool_call ordering so the render layer
       *  can interleave thinking lines with tool steps chronologically. */
      timeline?: ThoughtTimelineEntry[];
      /** 时间线序列号 / Monotonic sequence counter for timeline entries */
      nextTimelineSeq?: number;
      /** 整体结果状态（仅 active=false 时有意义），替代从子 tool 状态推断 / Overall outcome (meaningful when active=false), replaces boolean inference */
      result?: 'done' | 'error' | 'cancelled';
      /** ADR-0030 / 规则 24：阶段内已确认的旁白文本（被随后的只读工具确认），
       *  渲染于块顶部。多段按时间顺序累积。
       *  Confirmed narration texts (confirmed by a subsequent read-only tool),
       *  rendered at the top of the phase block in chronological order. */
      captions?: string[];
      /** ADR-0030 / 规则 24：待确认的旁白文本——文本在阶段块活跃时先吸收于此，
       *  随后到来只读工具则确认进 captions；阶段结束时仍未确认则脱离为独立
       *  文本块（最终回答）。纯思考块被文本关闭时并入该文本块题头（ADR-0026）。
       *  Pending narration: absorbed while the phase block is active; confirmed
       *  into captions when a read-only tool arrives, or detached as a standalone
       *  text block (final answer) when the phase ends unconfirmed. */
      pendingCaption?: string;
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
      /** Runtime tool identity that opened this input interaction. */
      toolCallId?: string;
      resolved?: string | { text: string; answers?: Record<string, string> };
    }
  | {
      id: number;
      kind: 'subagent';
      subagentId: string;
      role: SubAgentRole;
      task: string;
      status: 'running' | 'suspended' | 'done' | 'error' | 'cancelled';
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
      /** Runtime approval phase for a suspended child. This distinguishes a
       * deferred sibling from an active automatic review and a human prompt. */
      approvalState?: 'queued' | 'auto_reviewing' | 'awaiting_user';
      /** Parent task tool call that owns the persisted child continuation. */
      parentToolCallId?: string;
      /** 子 agent 正在等待工具审批 / Sub-agent is awaiting tool approval */
      awaitingApproval?: boolean;
      /** 正在等待审批的步骤索引，用于 tool_result 回来后标记 rejected / Step index being approved, used to mark as rejected on tool_result */
      approvingStepIndex?: number;
      /** TUI-only identity for children that started as one concurrent sibling batch. */
      concurrencyGroupId?: string;
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
  showPermissionSelector: boolean;
  showEffortSelector: boolean;
  showThemeSelector: boolean;
  showSessions: boolean;
  showMcp: boolean;
  showRewind: boolean;
  checkpoints: import('@/core/runtime/store').RuntimeSnapshotEntry[];
  skillManifests: import('@/core/skills/types').SkillManifest[];
  ctrlCPressed: boolean;
  sessionKey: number;
  exitRequested: boolean;
  sessionError: boolean;
  /** 正在从 DB 加载的会话 ID，null 表示未在加载 / ID of the session being loaded from DB, null when not loading */
  loadingSessionId: string | null;
  /** 历史会话服务不可用时阻塞新工作，仅保留 /sessions 重试。 */
  sessionServiceUnavailable: boolean;
  /** 探索工具 callId → tool_summary block ID 映射，用于 tool_done 精确定位 */
  explorationSummaryIds: Record<string, number>;
  /**
   * Runtime queue metadata is retained off-screen until execution reaches the
   * call or it fails terminally. Approval targets remain in the Footer only.
   */
  pendingToolCalls: Record<string, { name: string; args: Record<string, unknown> }>;
  /** 当前未被可见文本或非探索工具打断的 Thought summary block ID */
  currentThoughtSummaryId?: number;
  /** Explicit Thought lifecycle. `awaiting_terminal` is visually settled but
   *  still owns the current model invocation's terminal duration. */
  thoughtPhaseStatus?: 'running' | 'awaiting_terminal';
  /** Current model invocation, used to scope streamed terminal reconciliation. */
  currentModelRequestId?: string;
  /** Whether the current model invocation has emitted at least one reasoning delta. */
  currentModelReasoningStreamed?: boolean;
  /** Latest cumulative reasoning segment, cached off-screen between boundaries. */
  currentModelReasoningText?: string;
  /** 交互模式：ask（询问审批）/ auto（自动审核）/ full（自主运行） */
  interactionMode: 'accept_edits' | 'auto' | 'full';
  /** Deduplicates durable terminal compaction notices during replay. */
  terminalCompactionNotices?: Record<string, 'completed' | 'failed' | 'cancelled'>;
  /** Ephemeral presentation for the active context compaction. */
  compactionProgress?: {
    phase: import('@/core/model/context-compaction-presentation').ContextCompactionProgressPhase;
    source: 'manual' | 'automatic';
  };
}

export type RewindScope = 'code_and_conversation' | 'conversation_only' | 'code_only';

export type InterruptState =
  | {
      kind: 'approval';
      /** Durable Runtime interaction identity, when projected from RuntimeEvent replay. */
      interactionId?: string;
      /** Runtime tool call that owns the approval interaction. */
      toolCallId?: string;
      /** Active Footer payload; absent only in legacy restored UI snapshots. */
      approval?: ToolApprovalPayload;
      /** Compatibility pointer for sessions created before approvals moved off-screen. */
      blockId?: number;
    }
  | { kind: 'input'; blockId: number; interactionId?: string; toolCallId?: string }
  | {
      kind: 'plan_review';
      /** Durable Runtime interaction identity, when projected from RuntimeEvent replay. */
      interactionId?: string;
      /** Tool call that owns the plan review, when available from Runtime replay. */
      toolCallId?: string;
      planId?: string;
      version?: number;
      structuralDigest?: string;
      plan?: import('@/protocol/events').AgentPlan;
      artifact?: import('@/protocol/events').PlanArtifactRef;
    };

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
  /** Hidden only when the selected model configuration explicitly sets `reasoning: false`. */
  reasoningEnabled?: boolean;
  retryState: RetryState | null;
  contextSnapshot?: import('@/core/model/context-status').ContextStatusSnapshot;
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
  /** Off-screen queued tool metadata owned by this TUI session projection. */
  pendingToolCalls?: TuiState['pendingToolCalls'];
}
