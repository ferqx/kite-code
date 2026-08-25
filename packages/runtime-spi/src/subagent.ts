import type { SubagentRole } from './subagent-provider';

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

/**
 * Durable identity facts for the approval interaction that suspended a child.
 *
 * These facts are intentionally separate from the transient UI interaction.
 * A resumed continuation must retain the original route and parent/child
 * identity even when a sibling has since claimed the live approval surface.
 */
export interface SubagentApprovalFacts {
  readonly route: 'auto_review' | 'user';
  readonly generation: number;
  readonly sequence: number;
  readonly bindingDigest: string;
  readonly parentToolCallId: string;
  readonly childToolCallId: string;
  readonly runtimeToolCallId?: string;
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
  role: SubagentRole;
  /** Public display name chosen by the parent model. */
  name: string;
  task: string;
  messages: PersistedSubagentMessage[];
  toolCallCount: number;
  /** Actor-local child model cursor; resume continues at the next ordinal. */
  modelInvocationOrdinal?: number;
  steps: PersistedSubagentStep[];
  executionJournal?: PersistedExecutionJournalEntry[];
  exhaustedFingerprints?: Record<string, true>;
  /** Canonical private Runtime journal encoded as JSON; never projected to diagnostics. */
  toolRecovery: JsonObject;
  /** Exact child tool surface retained across approval suspension. */
  allowedTools?: string[];
  /** Runtime-issued bindings that authorize the retained dynamic MCP surface. */
  mcpBindingIds?: string[];
  /** Original approval route and bounded identity retained across suspension/resume. */
  approvalFacts?: Readonly<SubagentApprovalFacts>;
  blockedTool: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
    toolCallId: string;
    runtimeToolCallId?: string;
    toolName: string;
    args: JsonObject;
    command: string;
    /** Opaque App transport of Kernel governance facts; missing values fail closed. */
    approvalBinding?: JsonObject;
  };
}

/** Path-free content-addressed reference to a private immutable continuation payload. */
export interface SubagentContinuationArtifactRef {
  artifactId: string;
  kind: 'subagent_continuation';
  integrityIdentifier: string;
  byteLength: number;
}

/** Low-information durable projection used by all new suspension writes. */
export interface PrivateSuspendedSubagentRecord {
  storage: 'private_artifact_v1';
  subagentId: string;
  role: SubagentRole;
  continuationId: string;
  modelInvocationOrdinal: number;
  continuationArtifact: SubagentContinuationArtifactRef;
  parentInvocationId: string;
  parentAttempt: number;
  blockedTool: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
    toolCallId: string;
    runtimeToolCallId?: string;
    toolName: string;
  };
}

/** The production cutover epoch persists only low-information private references. */
export type DurableSuspendedSubagent = PrivateSuspendedSubagentRecord;
