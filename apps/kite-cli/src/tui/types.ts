import type {
  AgentPhase,
  AgentPlan,
  InteractionMode,
  RuntimeToolPresentation,
  SubAgentFailureDiagnostic,
  SubAgentRole,
  ToolApprovalPayload,
  UserInputPayload,
  UserInputResult,
  WorkspaceAccess,
} from '@kite-ai/runtime-contract';

/** 合并工具摘要中的单条工具记录 / Single tool entry in a consolidated summary */
export interface ConsolidatedToolEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  elapsedMs?: number;
  status:
    | 'queued'
    | 'running'
    | 'done'
    | 'error'
    | 'rejected'
    | 'cancelled'
    | 'timeout'
    | 'exhausted';
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
  /** Closed per-step completion summary retained for the child activity log. */
  summary?: string;
  /** Runtime-measured duration for this child tool invocation. */
  durationMs?: number;
}

export type OutputBlock =
  | {
      id: number;
      kind: 'user';
      content: string;
      /**
       * Durable Runtime message identity.  A user prompt entered through the
       * Runtime path is rendered only from its `user.message` projection, so
       * this key is also the reducer's replay/reconnect idempotency boundary.
       * Local-only slash-command echoes intentionally omit it.
       */
      messageId?: string;
      /** Live-only echo shown before the authoritative Runtime user.message arrives. */
      pendingEcho?: boolean;
    }
  | {
      id: number;
      kind: 'text';
      content: string;
      streaming?: boolean;
      /** Hidden ownership buffer while an active Thought awaits model classification. */
      responsePending?: boolean;
      isError?: boolean;
      /** Model invocation that owns this live/reconnected response segment. */
      modelRequestId?: string;
      /** The model terminal reconciled this component; later packets cannot mutate it. */
      modelTerminal?: boolean;
      /** Terminal duration retained off-screen so reasoning that arrives after
       *  model.responded can still attach the one canonical Thinking header. */
      modelDurationMs?: number;
      /** Recognized structural component whose shell is visible while complete
       * child rows are appended. The hidden source retains the unfinished row. */
      streamingComponent?: 'code' | 'table';
      streamingSource?: string;
      /** 被文本关闭的纯思考块并入的时长（ms，ADR-0026）。存在时在文本块顶部
       *  渲染暗色 "Thinking Xs" 题头行；独立思考块已删除，时长全量转移。
       *  Elapsed (ms) of a pure-thinking block merged in when text closed it
       *  (ADR-0026). Renders a dim "Thinking Xs" header above the content;
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
      status:
        | 'queued'
        | 'running'
        | 'done'
        | 'error'
        | 'rejected'
        | 'cancelled'
        | 'timeout'
        | 'exhausted';
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
       *  存在时 totalElapsedMs 以此为准（对齐当前 "Thinking Xs" 计时语义）；
       *  旧事件日志无此字段，回退创建→settle 墙钟。
       *  Accumulated model-call duration (ms, from model.responded.durationMs,
       *  excluding tool execution). When present, totalElapsedMs follows it
       *  (current "Thinking Xs" semantics); absent in old logs → wall clock. */
      modelMs?: number;
      /** Wall-clock start of the currently active model invocation. Cleared by
       * model.responded so tool and interaction waits are never counted. */
      liveModelStartedAt?: number;
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
       *  用于渲染时区分 "Thinking 3s · read 2 files"（有思考）vs "read 2 files"（仅工具统计）。
       *  Whether any reasoning (reason events) occurred during this Thought's lifetime.
       *  Controls the summary label: with thinking → "Thinking Xs · <tool stats>", without → just tool counts. */
      hasThinking?: boolean;
      /** 事件时间线：记录 reason / tool_call 的先后顺序，供归属与回放保留；
       *  活动渲染只消费 latestActivity，不累计整条时间线。
       *  Event timeline retained for ownership/replay; the active renderer
       *  consumes only latestActivity instead of replaying the whole timeline. */
      timeline?: ThoughtTimelineEntry[];
      /** 时间线序列号 / Monotonic sequence counter for timeline entries */
      nextTimelineSeq?: number;
      /** 整体结果状态（仅 active=false 时有意义），替代从子 tool 状态推断 / Overall outcome (meaningful when active=false), replaces boolean inference */
      result?: 'done' | 'error' | 'cancelled';
      /** Legacy in-memory narration residue consumed only by cancellation/settlement cleanup.
       *  Current model-visible text must use ordinary text blocks and never enter this field. */
      captions?: string[];
      /** Transitional tail used by terminal/cancellation settlement. Tool-bearing model-visible
       *  text is published as a normal text block instead of being stored here. */
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
      /** Content-free failure classification safe for the visible diagnostic. */
      failureDiagnostic?: SubAgentFailureDiagnostic;
      /** Runtime approval phase for a suspended child. This distinguishes a
       * deferred sibling from an active automatic review and a human prompt. */
      approvalState?:
        | 'queued'
        | 'queued_auto_review'
        | 'queued_user_approval'
        | 'auto_reviewing'
        | 'awaiting_user'
        | 'authorized_queued';
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

export type TuiApprovalStatus =
  | 'queued_auto'
  | 'auto_reviewing'
  | 'queued_user'
  | 'awaiting_user'
  | 'approving'
  | 'authorized_queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

/** Presentation projection of the Kernel-owned durable approval queue. */
export interface TuiPendingApproval {
  interactionId: string;
  toolCallId: string;
  parentToolCallId?: string;
  childSubagentId?: string;
  route: 'user' | 'auto';
  status: TuiApprovalStatus;
  sequence: number;
  generation: number;
  /**
   * Closed Runtime-facing approval facts. This is the only approval detail
   * rendered by the RuntimeClient reducer; legacy `approval` stays solely for
   * restoring pre-RuntimeServer local snapshots.
   */
  clientInteraction?: Extract<
    import('@kite-ai/runtime-contract').RuntimeClientInteraction,
    { readonly kind: 'approval' }
  >;
  approval?: ToolApprovalPayload;
  approvalHash?: string;
  bindingDigest?: string;
  grant?: 'approve_once' | 'same_command';
  receiptId?: string;
  matchCount?: number;
  result?: 'authorized' | 'rejected' | 'cancelled' | 'succeeded' | 'failed';
  actualSandboxScope?: ToolApprovalPayload['sandboxScope'];
}

export interface TuiSessionCommandGrant {
  grantKey: string;
  command?: string;
  createdAt?: string;
  generation?: number;
  /** Kernel revision expected immediately before the grant batch commit. */
  sessionRevision?: number;
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
  /** False only between local run reservation and the authoritative user.message projection. */
  runPromptPresented?: boolean;
  /** Live-only prompts waiting behind an active Run. They are presentation state, not turns. */
  queuedPrompts?: Array<{ id: number; sessionId: string; text: string }>;
  /** A local cancel command is in flight; durable Runtime terminal facts still own completion. */
  cancellationPending: boolean;
  runCount: number;
  runStartTime?: number;
  runTokenBaseline?: number;
  currentRunReasonId?: number;
  showHelp: boolean;
  showModelSelector: boolean;
  showPermissionSelector: boolean;
  showEffortSelector: boolean;
  showThemeSelector: boolean;
  showLanguageSelector: boolean;
  showSessions: boolean;
  showMcp: boolean;
  showRewind: boolean;
  checkpoints: import('./runtime-presentation').RuntimeCheckpointEntry[];
  skillManifests: import('@kite-ai/runtime-contract').SkillManifest[];
  ctrlCPressed: boolean;
  sessionKey: number;
  exitRequested: boolean;
  sessionError: boolean;
  /** 正在从 DB 加载的会话 ID，null 表示未在加载 / ID of the session being loaded from DB, null when not loading */
  loadingSessionId: string | null;
  /** 历史会话服务不可用时阻塞新工作，仅保留 /resume 重试。 */
  sessionServiceUnavailable: boolean;
  /** 探索工具 callId → tool_summary block ID 映射，用于 tool_done 精确定位 */
  explorationSummaryIds: Record<string, number>;
  /**
   * Runtime queue metadata is retained off-screen until execution reaches the
   * call or it fails terminally. Approval targets remain in the Footer only.
   */
  pendingToolCalls: Record<
    string,
    {
      /** Closed canonical category used for formatting and policy-free rendering rules. */
      name: string;
      /** Bounded App-owned label for a dynamic local tool. */
      displayName?: string;
      args: Record<string, unknown>;
      presentation: RuntimeToolPresentation;
      /** Exact model request resolved from the event's presentation group. */
      modelRequestId?: string;
    }
  >;
  /** 当前未被可见文本或非探索工具打断的 Thought summary block ID */
  currentThoughtSummaryId?: number;
  /** Explicit Thought lifecycle. `awaiting_terminal` is visually settled but
   *  still owns the current model invocation's terminal duration. */
  thoughtPhaseStatus?: 'running' | 'awaiting_terminal';
  /** Current model invocation, used to scope streamed terminal reconciliation. */
  currentModelRequestId?: string;
  /** The current invocation emitted cumulative text deltas. The visible tree
   *  may still be empty while an incomplete paragraph remains buffered. */
  currentModelTextStreamed?: boolean;
  /** Latest accepted cumulative model text. It closes an incomplete ordinary
   *  paragraph when the terminal event legitimately omits its optional summary. */
  currentModelTextSource?: string;
  /** Most recently settled tool-bearing invocation. Delayed cumulative text
   *  remains correlated to its sibling response components without becoming
   *  a Thought caption. */
  toolBearingModelRequestId?: string;
  /** Model message identity paired with toolBearingModelRequestId. */
  toolBearingPresentationGroupId?: string;
  /** Whether the current model invocation has emitted at least one reasoning delta. */
  currentModelReasoningStreamed?: boolean;
  /** Latest cumulative reasoning segment, cached off-screen between boundaries. */
  currentModelReasoningText?: string;
  /** Stable id of the reasoning segment currently accumulated off-screen. */
  currentModelReasoningSegmentId?: string;
  /** Model invocation that owns the cached reasoning segment. */
  currentModelReasoningRequestId?: string;
  /** 交互模式：ask（询问审批）/ auto（自动审核）/ full（自主运行） */
  interactionMode: 'accept_edits' | 'auto' | 'full';
  /** Durable Kernel approval queue projection; optional for legacy snapshots. */
  pendingApprovals?: ReadonlyMap<string, TuiPendingApproval>;
  /** Focused approval interaction identity restored from the durable queue. */
  activeApprovalId?: string | null;
  /** Session-scoped same-command grants shown by /permissions. */
  sessionCommandGrants?: ReadonlyMap<string, TuiSessionCommandGrant>;
  /** Latest durable queue generation that changed the Session grant projection. */
  sessionCommandGrantGeneration?: number;
  /** Latest pre-commit Kernel revision carried by a Session grant event. */
  sessionCommandGrantRevision?: number;
  /** Deduplicates durable terminal compaction notices during replay. */
  terminalCompactionNotices?: Record<string, 'completed' | 'failed' | 'cancelled'>;
  /** Ephemeral presentation for the active context compaction. */
  compactionProgress?: {
    phase: import('@kite-ai/runtime-contract').ContextCompactionProgressPhase;
    source: 'manual' | 'automatic';
  };
}

export type RewindScope = 'code_and_conversation' | 'conversation_only' | 'code_only';

export type InterruptState =
  | {
      kind: 'approval';
      /** Durable Runtime interaction identity, when projected from RuntimeEvent replay. */
      interactionId?: string;
      projectionIdentity?: string;
      /** Runtime tool call that owns the approval interaction. */
      toolCallId?: string;
      /** Active Footer payload; absent only in legacy restored UI snapshots. */
      approval?: ToolApprovalPayload;
      /** Compatibility pointer for sessions created before approvals moved off-screen. */
      blockId?: number;
    }
  | {
      kind: 'input';
      blockId: number;
      interactionId?: string;
      /** Exact client-safe identity excluding the current Session CAS revision. */
      projectionIdentity?: string;
      toolCallId?: string;
    }
  | {
      kind: 'plan_review';
      /** Durable Runtime interaction identity, when projected from RuntimeEvent replay. */
      interactionId?: string;
      /** Exact client-safe identity excluding the current Session CAS revision. */
      projectionIdentity?: string;
      /** Tool call that owns the plan review, when available from Runtime replay. */
      toolCallId?: string;
      planId?: string;
      version?: number;
      structuralDigest?: string;
      plan?: import('@kite-ai/runtime-contract').AgentPlan;
      artifact?: import('@kite-ai/runtime-contract').PlanArtifactRef;
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
  contextSnapshot?: import('@kite-ai/runtime-contract').ContextStatusSnapshot;
}

export interface SessionSnapshot {
  threadId: string;
  name: string;
  workspace: string;
  active: boolean;
  running: boolean;
  /** Whether the active Run's user prompt has reached the visible message owner. */
  runPromptPresented?: boolean;
  /** A cancel command is in flight for this Session. */
  cancellationPending?: boolean;
  pendingInterrupt: boolean;
  /** Full interrupt state for session-switch restoration. Set on switch-away, read on switch-back. */
  interrupt: InterruptState | null;
  plan: import('@kite-ai/runtime-contract').AgentPlan | null;
  /** Last explicit Session interaction mode; Plan execution mode is orthogonal. */
  interactionMode?: InteractionMode;
  status: StatusState;
  turns: Turn[];
  /** Off-screen queued tool metadata owned by this TUI session projection. */
  pendingToolCalls?: TuiState['pendingToolCalls'];
  pendingApprovals?: ReadonlyMap<string, TuiPendingApproval>;
  activeApprovalId?: string | null;
  sessionCommandGrants?: ReadonlyMap<string, TuiSessionCommandGrant>;
  sessionCommandGrantGeneration?: number;
  sessionCommandGrantRevision?: number;
}
