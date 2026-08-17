import type { SubAgentRole } from './events';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface PersistedSubagentToolCall {
  id?: string;
  name: string;
  args: JsonObject;
}

interface PersistedSubagentMessageBase {
  id?: string;
  name?: string;
  content: JsonValue;
  responseMetadata?: JsonObject;
}

export interface PersistedSystemMessage extends PersistedSubagentMessageBase {
  type: 'system';
}

export interface PersistedHumanMessage extends PersistedSubagentMessageBase {
  type: 'human';
}

export interface PersistedAIMessage extends PersistedSubagentMessageBase {
  type: 'ai';
  toolCalls: PersistedSubagentToolCall[];
  additionalKwargs: JsonObject;
  invalidToolCalls?: JsonObject[];
  usageMetadata?: JsonObject;
}

export interface PersistedToolMessage extends PersistedSubagentMessageBase {
  type: 'tool';
  toolCallId: string;
  status?: 'success' | 'error' | 'exhausted';
  artifact?: JsonValue;
  metadata?: JsonObject;
}

export type PersistedSubagentMessage =
  | PersistedSystemMessage
  | PersistedHumanMessage
  | PersistedAIMessage
  | PersistedToolMessage;

export interface PersistedSubagentStep {
  toolName: string;
  toolArgs: JsonObject;
  status: 'pending' | 'awaiting_approval' | 'success' | 'rejected' | 'error';
  ok?: boolean;
  totalLines?: number;
}

export interface PersistedExecutionJournalEntry {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'applied' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
  fingerprint?: string;
  stderrDigest?: string;
}

export interface SuspendedSubagentSnapshot {
  subagentId: string;
  role: SubAgentRole;
  task: string;
  messages: PersistedSubagentMessage[];
  toolCallCount: number;
  steps: PersistedSubagentStep[];
  executionJournal?: PersistedExecutionJournalEntry[];
  exhaustedFingerprints?: Record<string, true>;
  /** Canonical private Runtime journal encoded as JSON; never projected to diagnostics. */
  toolRecovery: JsonObject;
  /** Exact child tool surface retained across approval suspension. */
  allowedTools?: string[];
  /** Runtime-issued bindings that authorize the retained dynamic MCP surface. */
  mcpBindingIds?: string[];
  blockedTool: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
    toolCallId: string;
    runtimeToolCallId?: string;
    toolName: string;
    args: JsonObject;
    command: string;
  };
}
