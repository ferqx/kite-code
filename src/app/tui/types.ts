import type { ToolCallPayload, ToolApprovalPayload, UserInputPayload, AgentPhase, AgentPlan, AuthorizationMode, WorkspaceAccess, SubAgentRole } from "@/protocol/events";

export interface SubAgentStepRecord {
  toolName: string;
  toolArgs: Record<string, unknown>;
  ok?: boolean;
}

export type OutputBlock =
  | { id: number; kind: "user"; content: string }
  | { id: number; kind: "text"; content: string; streaming?: boolean; isError?: boolean }
  | { id: number; kind: "reason"; content: string; folded: boolean }
  | { id: number; kind: "tool_card"; callId: string; name: string; args: Record<string, unknown>; status: "running" | "done" | "error"; summary: string; preview?: string; elapsedMs?: number; detail?: string; expanded?: boolean }
  | { id: number; kind: "plan_card"; name: string; description: string; planStatus: import("@/protocol/events").PlanStatus; steps: import("@/protocol/events").AgentPlanStep[]; folded: boolean; callId: string }
  | { id: number; kind: "file_change"; changes: FileChangeRecord[] }
  | { id: number; kind: "approval"; approval: ToolApprovalPayload; resolved?: { action: string; grant?: string; pattern?: string } }
  | { id: number; kind: "question"; question: UserInputPayload; resolved?: string }
  | { id: number; kind: "subagent"; subagentId: string; role: SubAgentRole; task: string; status: "running" | "done" | "error"; summary: string; toolCallCount: number; durationMs: number; steps: SubAgentStepRecord[]; error?: string; expanded?: boolean };

/** 一次完整的「用户提问 → Agent 回复」往返 */
export interface Turn {
  blocks: OutputBlock[];
}

export interface FileChangeRecord {
  path: string;
  kind: "add" | "edit" | "delete";
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
  /** callId / subagentId → blockId 索引，用于 O(1) 查找 */
  blockIndex: Record<string, number>;
  status: StatusState;
  exited: boolean;
  running: boolean;
  compacting: boolean;
  runCount: number;
  runStartTime?: number;
  thinkingVisible: boolean;
  currentRunReasonId?: number;
  showHelp: boolean;
  showModelSelector: boolean;
  showSessions: boolean;
  showMcp: boolean;
  showRewind: boolean;
  checkpoints: import("@/core/persistence/checkpoint").CheckpointEntry[];
  rewindCounter: number;
  pendingSkills: string[];
  skillManifests: import("@/core/skills/types").SkillManifest[];
  ctrlCPressed: boolean;
  sessionKey: number;
  exitRequested: boolean;
  editorRequested: boolean;
  sessionError: boolean;
  loadingSession: boolean;
}

export interface InterruptState {
  kind: "approval" | "input";
  blockId: number;
}

export interface StatusState {
  phase: AgentPhase;
  plan: AgentPlan | null;
  authorization: AuthorizationMode;
  workspaceAccess: WorkspaceAccess;
  cacheHitRate: number;
  totalTokens: number;
  currentNode: string | null;
  modelProvider: string;
  modelName: string;
  thinkingMode: string;
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
  plan: import("@/protocol/events").AgentPlan | null;
  status: StatusState;
  turns: Turn[];
}
