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

export type AgentMode = "plan" | "builder";

export type AgentRunMode = "auto" | AgentMode;

export interface ContextBudget {
  maxMessages: number;
  maxToolOutputChars: number;
}

export interface AgentEvidence {
  commands: string[];
  files: string[];
  verification: string[];
}

export interface AgentHeartbeat {
  goal: string;
  findings: string[];
  nextAction: string;
  blockers: string[];
  verification: string[];
}

export interface AgentProgressLedger {
  toolCallCount: number;
  stagnantStepCount: number;
  repeatedCallCount: number;
  lastToolSignature: string;
  recentOutputSignatures: string[];
  heartbeat: AgentHeartbeat;
}

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

export interface AgentEvent {
  type: string;
  data: unknown;
}
