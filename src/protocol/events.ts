// ── 核心事件类型 / Core event types ──
export type AgentEvent =
  | { type: "step_begin"; data: { node: string } }
  | { type: "step_end"; data: { node: string } }
  | { type: "reason"; data: { text: string } }
  | { type: "text"; data: { text: string } }
  | { type: "tool_call"; data: ToolCallPayload }
  | { type: "tool_done"; data: ToolResultPayload }
  | { type: "need_approval"; data: ToolApprovalPayload }
  | { type: "need_input"; data: UserInputPayload }
  | { type: "state_change"; data: StateChangePayload }
  | { type: "file_change"; data: { path: string; kind: "add" | "edit" | "delete"; linesAdded?: number; linesRemoved?: number; preview?: string } }
  | { type: "compact_begin"; data: { reason: string } }
  | { type: "compact_end"; data: { summary: string } }
  | { type: "cache_metrics"; data: CacheMetricsPayload }
  | { type: "error"; data: { message: string; recoverable: boolean } }
  /** LangGraph interrupt — payload depends on the interrupted node's resume type, consumed by TUI/CLI for user interaction resolution */
  | { type: "interrupt"; data: unknown }
  /** Raw LangGraph state update chunk — opaque passthrough for checkpoint/state tracking consumers */
  | { type: "update"; data: unknown }
  | { type: "model_retry"; data: { attempt: number; error: string; delayMs: number } }
  | { type: "final"; data: string }
  | { type: "subagent_start"; data: SubAgentStartPayload }
  | { type: "subagent_step"; data: SubAgentStepPayload }
  | { type: "subagent_tool_result"; data: SubAgentToolResultPayload }
  | { type: "subagent_done"; data: SubAgentDonePayload }
  | { type: "subagent_error"; data: SubAgentErrorPayload };

// ── 基础类型 / Base types ──
export type WorkspaceAccess = "read-only" | "write";
export type AgentPhase = "planning" | "building";
export type WorkspaceAccessRequest = "auto" | WorkspaceAccess | "plan" | "builder";
export type AuthorizationMode = "default" | "full_access";
export type ShellApprovalGrant = "approve_once" | "same_command" | "full_access";
export type ShellGrantUsed = "none" | ShellApprovalGrant;
export type PlanStatus = "pending" | "in_progress" | "completed";

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
}

// ── Payload 类型 / Payload types ──
export interface ToolCallPayload {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultPayload {
  call_id: string;
  name: string;
  ok: boolean;
  summary: string;
}

export interface UserInputPayload {
  question: string;
  options: UserInputOption[];
  allow_free_text: boolean;
  context?: string;
}

export interface StateChangePayload {
  workspaceAccess?: WorkspaceAccess;
  phase?: AgentPhase;
  plan?: AgentPlan | null;
  authorization?: { mode: AuthorizationMode };
}

export interface CacheMetricsPayload {
  workspaceAccess: WorkspaceAccess;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens?: number;
  hitRate?: number;
  standard: Record<string, unknown>;
}

export interface ToolApprovalPayload {
  scope: "once";
  cwd: string;
  threadId: string;
  tool: string;
  command: string;
  risk: "read" | "plan" | "write_file" | "execute_code" | "destructive" | "network" | "vcs_mutation" | "unknown";
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
}

// ── 子 Agent 事件 / Sub-agent events ──
export type SubAgentRole = "explore" | "code" | "review";

export interface SubAgentStartPayload {
  id: string;
  role: SubAgentRole;
  task: string;
}

export interface SubAgentStepPayload {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export interface SubAgentToolResultPayload {
  id: string;
  toolName: string;
  ok: boolean;
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
}
