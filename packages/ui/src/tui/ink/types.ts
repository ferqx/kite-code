/** Read-only renderer models. Host projections supply facts; these types own no execution authority. */
export type SubAgentRole = 'explore' | 'plan' | 'code' | 'review' | (string & {});
export interface UserInputResult {
  answer: string;
  answers?: Record<string, string>;
}
export interface SubAgentFailureDiagnostic {
  code: string;
  stage: string;
}
export type PlanStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'blocked'
  | 'compensated';
export interface AgentPlan {
  title?: string;
  steps: Array<{ step: string; status: PlanStatus }>;
}
export type ContextCompactionProgressPhase = 'preparing' | 'summarizing' | 'validating';
export interface FileChangeRecord {
  path: string;
  kind: 'add' | 'edit' | 'delete';
  linesAdded?: number;
  linesRemoved?: number;
  preview?: string;
}
export type ToolDisplayStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'rejected'
  | 'cancelled'
  | 'timeout'
  | 'exhausted';
export interface ConsolidatedToolEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  elapsedMs?: number;
  status: ToolDisplayStatus;
  totalLines?: number;
  reviewFailure?: string;
}
export type ThoughtActivity = { kind: 'thinking'; text: string } | { kind: 'tool'; callId: string };
export interface SubAgentStepRecord {
  fileNotice?: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: 'pending' | 'awaiting_approval' | 'success' | 'rejected' | 'error' | 'cancelled';
  totalLines?: number;
  summary?: string;
  durationMs?: number;
}
export type OutputBlock =
  | {
      id: number;
      kind: 'tool_card';
      /** Qualified original file-mutation receipt; never inferred from text or arguments alone. */
      fileAction?: 'Create' | 'Write';
      fileNotice?: string;
      resourceReferences?: readonly string[];
      callId: string;
      name: string;
      args: Record<string, unknown>;
      status: ToolDisplayStatus;
      summary: string;
      preview?: string;
      /** Only an observed actual dispatch start may animate elapsed time. */
      startedAt?: number;
      elapsedMs?: number;
      detail?: string;
      expanded?: boolean;
      liveOutput?: string;
      liveTotalLines?: number;
      timeoutMs?: number;
      reviewFailure?: string;
      userInput?: UserInputResult;
    }
  | {
      id: number;
      kind: 'tool_summary';
      tools: ConsolidatedToolEntry[];
      /** Only source-confirmed phase durations are supplied; missing remains missing. */
      totalElapsedMs?: number;
      createdAt: number;
      liveModelStartedAt?: number;
      summaryLine: string;
      active: boolean;
      hasThought: boolean;
      hasThinking?: boolean;
      latestActivity?: ThoughtActivity;
      result?: 'done' | 'error' | 'cancelled';
    }
  | {
      id: number;
      kind: 'subagent';
      subagentId: string;
      role: SubAgentRole;
      task: string;
      status: 'creating' | 'running' | 'suspended' | 'done' | 'error' | 'interrupted' | 'cancelled';
      summary: string;
      toolCallCount: number;
      durationMs?: number;
      steps: SubAgentStepRecord[];
      startedAt?: number;
      error?: string;
      expanded?: boolean;
      failureDiagnostic?: SubAgentFailureDiagnostic;
      approvalState?:
        | 'queued'
        | 'queued_auto_review'
        | 'queued_user_approval'
        | 'auto_reviewing'
        | 'awaiting_user'
        | 'authorized_queued';
      awaitingApproval?: boolean;
      concurrencyGroupId?: string;
    };
