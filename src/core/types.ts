import type { AuthorizationMode, ShellApprovalGrant, ShellGrantUsed, WorkspaceAccess } from "@/protocol/events";

export interface ShellInput {
  workspace: string;
  command: string;
  /** 中止信号，取消时 kill 子进程 / Abort signal to kill child process on cancellation */
  signal?: AbortSignal;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellIntent = "inspect" | "verify" | "build" | "test" | "git" | "other";

export interface ShellActionEnvelope {
  command: string;
  description?: string;
  intent?: ShellIntent;
  objective?: string;
  justification?: string;
  expected_observation?: string;
  failure_strategy?: string;
  prefix_rule?: string[];
  grant_request?: ShellApprovalGrant;
}

export interface ThreadAuthorizationState {
  mode: "default" | "full_access";
  commandGrants: Record<string, { workspace: string; threadId: string; command: string }>;
}

export interface AuthorizationOverride {
  current: AuthorizationMode;
}

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

export type ToolApprovalResumeValue =
  | boolean
  | {
      approved?: boolean;
      grant?: ShellApprovalGrant;
      approvalHash?: string;
      replacementCommand?: string;
      reason?: string;
    };

export type UserInputResumeValue =
  | string
  | { answer?: string; choice?: string; option_id?: string; optionId?: string; free_text?: string; freeText?: string; text?: string };

export type AgentResumeValue = ToolApprovalResumeValue | UserInputResumeValue;

export interface ContextBudget {}

export interface ModelRetryEvent {
  attempt: number;
  maxAttempts: number;
  error: string;
  delayMs: number;
}
