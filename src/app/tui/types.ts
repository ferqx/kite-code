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
  blocks: OutputBlock[];
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
  leaderPending: boolean;
  showHelp: boolean;
  showModelSelector: boolean;
  showSessions: boolean;
  showMcp: boolean;
  ctrlCPressed: boolean;
  sessionKey: number;
  exitRequested: boolean;
  editorRequested: boolean;
  sessionError: boolean;
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
