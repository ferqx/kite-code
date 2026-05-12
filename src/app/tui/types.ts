import type { ToolCallPayload, ToolApprovalPayload, UserInputPayload, AgentPhase, AgentPlan, AuthorizationMode, WorkspaceAccess } from "../../protocol/events";

export type OutputBlock =
  | { kind: "text"; id: number; content: string }
  | { kind: "reason"; id: number; content: string; folded: boolean }
  | { kind: "tool_card"; callId: string; name: string; args: Record<string, unknown>; status: "running" | "done" | "error"; summary: string; elapsed?: number }
  | { kind: "file_change"; changes: FileChangeRecord[] }
  | { kind: "approval"; approval: ToolApprovalPayload; resolved?: { action: string; grant?: string; pattern?: string } }
  | { kind: "question"; question: UserInputPayload; resolved?: string };

export interface FileChangeRecord {
  path: string;
  kind: "add" | "edit" | "delete";
}

export interface TuiState {
  output: OutputLine[];
  tools: ToolCardState[];
  fileChanges: FileChangeRecord[];
  interrupt: InterruptState | null;
  status: StatusState;
  exited: boolean;
  running: boolean;
  thinkingVisible: boolean;
  leaderPending: boolean;
  showHelp: boolean;
  showModelSelector: boolean;
  ctrlCPressed: boolean;
}

export interface OutputLine {
  id: number;
  type: "text" | "reason";
  content: string;
  folded: boolean;
}

export interface ToolCardState {
  callId: string;
  name: ToolCallPayload["name"];
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  summary: string;
}

export interface InterruptState {
  kind: "approval" | "input";
  approval?: ToolApprovalPayload;
  question?: UserInputPayload;
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
