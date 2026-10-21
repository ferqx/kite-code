import type { EnsureOperationInput, RecordScope, WriteContext } from './port';
import type { OperationRef } from './types';

export type AgentState = 'queued' | 'running' | 'waiting' | 'idle';
export interface CollaborationSource {
  /** Full original text is carried by the Tool's verified Artifact body, not an executable ref. */
  content: string;
}
export interface StableAgentSummary {
  agentId: string;
  seq: string;
  taskName: string | null;
  assignmentSummary: string;
  assignmentSource: CollaborationSource;
  currentWorkSummary: string;
  currentWorkSource: CollaborationSource;
  workRelation: 'same_work' | 'other_work' | 'unknown';
  state: AgentState;
  lastOutcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' | null;
  lastResultSource: CollaborationSource | null;
  /** Trusted host metadata; never copied into the Model directory. */
  ref: OperationRef;
  runId: string | null;
  contextSelectionId: string;
  configurationId: string;
}
export interface StableAgentPage {
  items: StableAgentSummary[];
  upperSeq: string;
  nextAfterSeq: string | null;
}
export type ListStableAgentsInput = WriteContext &
  RecordScope & {
    subjectId: string;
    callerRootWorkCommandId?: string;
    callerRootWorkSeq?: string;
    agentIds?: string[];
    afterSeq?: string;
    upperSeq?: string;
    limit?: number;
  };
export interface ApplyAgentCommandInput extends EnsureOperationInput {
  commandId: string;
  agentId: string;
  kind: 'follow_up' | 'interrupt';
  content?: string;
}
export interface AgentCommandReceipt {
  accepted: true;
  agentId: string;
  state: AgentState;
  mode?: 'steer' | 'new_turn';
  outcome?: 'cancel_requested' | 'idle';
  ref: OperationRef;
}
export interface AgentMailboxEvent {
  seq: string;
  agentId: string;
  kind: 'message' | 'completed';
  outcome?: string;
  summary: string;
}
export type ListAgentEventsInput = WriteContext &
  RecordScope & {
    subjectId: string;
    afterSeq?: string;
    limit?: number;
  };
export interface AgentEventPage {
  events: AgentMailboxEvent[];
  nextSeq: string;
  highWaterSeq: string;
}
export type CollaborationCommandResult = { receipt: AgentCommandReceipt; start: boolean };
