import type { UserAction } from "../../src/protocol/actions";
import type { OutputBlock } from "../../src/app/tui/types";

export interface Scenario {
  terminalWidth: number;
  steps: Step[];
  stepTimeout?: number;
  freeze?: Array<"timer" | "timestamp" | "cacheHitRate" | "cacheTokenCount" | "toolElapsed">;
}

export type Step =
  | { type: "agent-text"; text: string }
  | { type: "agent-reason"; text: string }
  | { type: "tool-call"; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; output: string }
  | { type: "tool-error"; output: string }
  | { type: "need-approval"; approval: NeedApprovalPayload }
  | { type: "need-input"; question: NeedInputPayload }
  | { type: "agent-done" }
  | { type: "user-action"; action: UserAction }
  | { type: "user-input"; text: string }
  | { type: "expect-mode"; mode: "approval" | "question" }
  | { type: "assert-snapshot" }
  | { type: "error"; message: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "model-retry"; attempt: number; error: string; delayMs: number }
  | { type: "file-change"; path: string; kind: "add" | "edit" | "delete"; linesAdded?: number; linesRemoved?: number; preview?: string }
  | { type: "state-change"; phase?: "planning" | "building"; authorization?: "default" | "full_access"; plan?: { name: string; description: string; steps: { step: string; status: "pending" | "in_progress" | "completed" }[] } | null }
  | { type: "cache-metrics"; hitRate: number; inputTokens: number; outputTokens: number }
  | { type: "compact"; reason: string; summary: string }
  | { type: "simulate-input"; text: string }
  | { type: "simulate-key"; key: string }
  | { type: "dispatch"; actionType: string; payload?: Record<string, unknown> };

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

// ── Content assertions for verifying rendered ANSI output ──

export type AnsiAssertion =
  | { type: "contains"; text: string; description?: string }
  | { type: "not-contains"; text: string; description?: string }
  | { type: "matches"; pattern: string; description?: string }
  | { type: "contains-all"; texts: string[]; description?: string }
  | { type: "contains-in-order"; texts: string[]; description?: string }
  | { type: "contains-each"; texts: string[]; description?: string };

export type StateAssertion =
  | { type: "blocks-min"; count: number; description?: string }
  | { type: "blocks-max"; count: number; description?: string }
  | { type: "blocks-equal"; count: number; description?: string }
  | { type: "has-block-kind"; kind: OutputBlock["kind"]; description?: string }
  | { type: "no-block-kind"; kind: OutputBlock["kind"]; description?: string }
  | { type: "blocks-of-kind-count"; kind: OutputBlock["kind"]; count: number; description?: string }
  | { type: "block-kinds-in-order"; kinds: OutputBlock["kind"][]; description?: string }
  | { type: "interrupt-kind"; kind: "approval" | "input" | null; description?: string }
  | { type: "last-block-kind"; kind: OutputBlock["kind"]; description?: string }
  | { type: "running-is"; value: boolean; description?: string }
  | { type: "show-sessions-is"; value: boolean; description?: string }
  | { type: "all-blocks-non-streaming"; description?: string };

export interface SnapshotExpectation {
  reason: "approval-wait" | "question-wait" | "terminal" | "explicit";
  ansi?: AnsiAssertion[];
  state?: StateAssertion[];
}

// ── Real agent e2e scenario ──

export interface RealAgentScenario {
  terminalWidth?: number;
  stepTimeout?: number;
  freeze?: Array<"timer" | "timestamp" | "cacheHitRate" | "cacheTokenCount" | "toolElapsed">;
  task: string;
  modelResponses: Array<{
    message?: { content: string; tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
    delay?: number;
    error?: string;
  }>;
  /** Auto-approve tool calls during agent run */
  autoApprove?: boolean;
  /** Files to create in temp workspace before running agent */
  workspaceFiles?: Record<string, string>;
  expectations: SnapshotExpectation[];
}
