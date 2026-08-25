export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export interface AgentPlanStep {
  readonly step: string;
  readonly status: PlanStatus;
  readonly id?: string;
  readonly note?: string;
}
export interface AgentPlan {
  readonly name: string;
  readonly description: string;
  readonly status: PlanStatus;
  readonly steps: readonly AgentPlanStep[];
}
export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: PlanStatus;
  readonly note?: string;
}
export interface PlanCompletionEvidence {
  readonly schemaVersion: 1;
  readonly verification: readonly {
    readonly verificationId: string;
    readonly outcome: 'passed' | 'waived';
  }[];
  readonly execution: readonly { readonly toolCallId: string; readonly outcome: 'succeeded' }[];
  readonly skipped: readonly { readonly stepId: string; readonly reasonCode: string }[];
  readonly unresolved: readonly {
    readonly kind: 'failure' | 'approval';
    readonly referenceId: string;
  }[];
}
export interface PlanArtifactRef {
  readonly artifactId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly version: number;
  readonly fileName: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly structuralDigest: string;
  readonly byteLength: number;
}

export interface AgentUserInputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}
export interface AgentUserInputQuestion {
  readonly id?: string;
  readonly question: string;
  readonly options: readonly AgentUserInputOption[];
  readonly recommended?: string;
  readonly allow_free_text?: boolean;
}
export interface AgentUserInputPayload {
  readonly question: string;
  readonly options: readonly AgentUserInputOption[];
  readonly allow_free_text: boolean;
  readonly context?: string;
  readonly recommended?: string;
  readonly questions?: readonly AgentUserInputQuestion[];
}
export type AgentShellApprovalGrant = 'approve_once' | 'same_command';
export interface AgentToolApprovalPayload {
  readonly scope: 'once';
  readonly callId?: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly tool: string;
  readonly command: string;
  readonly risk:
    | 'read'
    | 'plan'
    | 'write_file'
    | 'execute_code'
    | 'destructive'
    | 'network'
    | 'vcs_mutation'
    | 'mcp'
    | 'unknown';
  readonly approvalHash: string;
  readonly summary: string;
  readonly reason: string;
  readonly expectedEffects: readonly string[];
  readonly grantOptions: readonly AgentShellApprovalGrant[];
  readonly recommendedGrant: AgentShellApprovalGrant;
  readonly plan?: AgentPlan;
  readonly subagentId?: string;
  readonly reviewFailure?: string;
}
export interface PlanDocument {
  readonly planSchemaVersion: 2;
  readonly planId: string;
  readonly version: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly steps: readonly PlanStep[];
  readonly structuralDigest: string;
  readonly createdAtTurnId: string;
  readonly updatedAtTurnId: string;
  readonly supersedesPlanVersion?: number;
  readonly replanReason?: string;
  readonly completionEvidence: PlanCompletionEvidence;
  readonly artifact?: PlanArtifactRef;
}
export type PlanningState =
  | { readonly kind: 'building_without_plan' }
  | { readonly kind: 'planning_empty' }
  | {
      readonly kind: 'planning_draft';
      readonly document: PlanDocument;
      readonly revisionFeedback?: string;
    }
  | {
      readonly kind: 'replanning_draft';
      readonly document: PlanDocument;
      readonly supersedesPlanVersion: number;
      readonly replanReason: string;
      readonly revisionFeedback?: string;
    }
  | {
      readonly kind: 'awaiting_review';
      readonly document: PlanDocument;
      readonly interactionId: string;
      readonly exitToolCallId: string;
    }
  | {
      readonly kind: 'executing';
      readonly document: PlanDocument;
      readonly executionMode: 'accept_edits' | 'auto';
      readonly approvedAtTurnId: string;
    }
  | {
      readonly kind: 'completed';
      readonly document: PlanDocument;
      readonly completedAtTurnId: string;
    }
  | {
      readonly kind: 'cancelled';
      readonly document?: PlanDocument;
      readonly reason: string;
      readonly cancelledAtTurnId: string;
    };
