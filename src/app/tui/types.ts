import type { ToolCallPayload, ToolApprovalPayload, UserInputPayload, AgentPhase, AgentPlan, AuthorizationMode, WorkspaceAccess } from "../../protocol/events";

export interface TuiState {
  output: OutputLine[];
  tools: ToolCardState[];
  fileChanges: FileChangeRecord[];
  interrupt: InterruptState | null;
  status: StatusState;
  exited: boolean;
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

export interface FileChangeRecord {
  path: string;
  kind: "add" | "edit" | "delete";
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
}
