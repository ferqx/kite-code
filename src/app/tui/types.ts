import type { ToolCallPayload, ToolApprovalPayload, UserInputPayload, AgentPhase, AgentPlan, AuthorizationMode, WorkspaceAccess } from "@/protocol/events";

export type OutputBlock =
  | { id: number; kind: "user"; content: string }
  | { id: number; kind: "text"; content: string; streaming?: boolean; isError?: boolean }
  | { id: number; kind: "reason"; content: string; folded: boolean }
  | { id: number; kind: "tool_card"; callId: string; name: string; args: Record<string, unknown>; status: "running" | "done" | "error"; summary: string; preview?: string; elapsedMs?: number; detail?: string }
  | { id: number; kind: "file_change"; changes: FileChangeRecord[] }
  | { id: number; kind: "approval"; approval: ToolApprovalPayload; resolved?: { action: string; grant?: string; pattern?: string } }
  | { id: number; kind: "question"; question: UserInputPayload; resolved?: string };

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
  blocks: OutputBlock[];
  nextBlockId: number;
  interrupt: InterruptState | null;
  toolStartTimes?: Map<string, number>;
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
  plan: import("@/protocol/events").AgentPlan | null;
  status: StatusState;
  blocks: OutputBlock[];
}
