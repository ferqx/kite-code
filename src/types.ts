export interface ApplyPatchInput {
  workspace: string;
  path: string;
  content: string;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

export interface ApplyPatchResult {
  ok: boolean;
  path: string;
  message: string;
}

export interface ShellInput {
  workspace: string;
  command: string;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  step: string;
  status: PlanItemStatus;
}

export interface AgentPlan {
  explanation?: string;
  items: PlanItem[];
}

export interface AgentEvent {
  type: string;
  data: unknown;
}
