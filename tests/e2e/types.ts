import type { UserAction } from "../../src/protocol/actions";

export interface Scenario {
  terminalWidth: number;
  steps: Step[];
  stepTimeout?: number;
  freeze?: Array<"timer" | "timestamp" | "cacheHitRate" | "cacheTokenCount">;
}

export type Step =
  | { type: "agent-text"; text: string }
  | { type: "agent-reason"; text: string }
  | { type: "tool-call"; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; output: string }
  | { type: "need-approval"; approval: NeedApprovalPayload }
  | { type: "need-input"; question: NeedInputPayload }
  | { type: "agent-done" }
  | { type: "user-action"; action: UserAction }
  | { type: "user-input"; text: string }
  | { type: "expect-mode"; mode: "approval" | "question" }
  | { type: "assert-snapshot" };

export interface NeedApprovalPayload {
  tool: string;
  command: string;
  risk: "read" | "plan" | "write_file" | "execute_code" | "destructive" | "vcs_mutation";
  summary: string;
}

export interface NeedInputPayload {
  question: string;
  options: { id: string; label: string; description?: string }[];
  allow_free_text?: boolean;
}

export interface Snapshot {
  index: number;
  reason: "approval-wait" | "question-wait" | "terminal" | "explicit";
  ansi: string;
  state: Record<string, unknown>;
}

export interface E2EResult {
  snapshots: Snapshot[];
  pass: boolean;
  error?: string;
}
