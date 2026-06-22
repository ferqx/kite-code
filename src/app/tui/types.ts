import type {
  AgentPhase,
  AgentPlan,
  AuthorizationMode,
  SubAgentRole,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
} from '@/protocol/events';

export interface SubAgentStepRecord {
  toolName: string;
  toolArgs: Record<string, unknown>;
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
      status: 'running' | 'done' | 'error';
      summary: string;
      preview?: string;
      elapsedMs?: number;
      detail?: string;
      expanded?: boolean;
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
      status: 'running' | 'done' | 'error';
      summary: string;
      toolCallCount: number;
      durationMs: number;
      steps: SubAgentStepRecord[];
      error?: string;
      expanded?: boolean;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
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
  editorRequested: boolean;
  sessionError: boolean;
  /** 正在从 DB 加载的会话 ID，null 表示未在加载 / ID of the session being loaded from DB, null when not loading */
  loadingSessionId: string | null;
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
