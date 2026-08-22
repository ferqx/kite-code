import type { AgentPlan, AgentToolResultMeta, RuntimeEvent } from '@kite/agent-kernel';
import type {
  CapabilityResult,
  ShellGrantUsed,
  WorkspaceAccess,
  WorkspaceFilesystemObservationRecordV1,
} from '@kite/runtime-contract';
import type { SandboxExecutionProviderFailureCodeV1 } from '@kite/runtime-spi';

/** Generic shell-shaped result carried across Host/App execution seams. */
export interface RuntimeHostShellResultV1 {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  sandboxFailure?: {
    code: SandboxExecutionProviderFailureCodeV1;
    stage: 'pre_dispatch' | 'post_dispatch';
    cleanupConfirmed: boolean;
  };
  processCleanup?: {
    confirmedExited: boolean;
    gracefulRequested: boolean;
    forced: boolean;
    unconfirmedDescendantCount: number;
  };
}

/** Structured failure guidance shared by Host/App execution adapters. */
export interface RuntimeHostToolFailureV1 {
  message: 'Tool execution failed.';
  tool: string;
  reason: string;
  guidance: string;
}

/**
 * Generic structural terminal result.  The Host owns only this transport
 * shape; the optional subagent payload remains an opaque caller type.
 */
export type RuntimeHostToolExecutionResultV1<
  TSubagentResult = unknown,
  TIntent = unknown,
> = RuntimeHostShellResultV1 & {
  runtimeEvents?: RuntimeEvent[];
  classifierAdviceV1?: import('@kite/agent-kernel').ToolOutcomeClassifierAdviceV1;
  classifierDiagnostic?: 'classifier_threw';
  resultMeta?: AgentToolResultMeta;
  status?: 'success' | 'error' | 'rejected' | 'exhausted';
  approvalRoute?: 'user' | 'auto_review';
  tool?: string;
  failure?: RuntimeHostToolFailureV1;
  path?: string;
  action?: {
    intent?: TIntent;
    grantUsed: ShellGrantUsed;
  };
  workspaceAccess?: WorkspaceAccess;
  authorization?: import('@kite/agent-kernel').AgentAuthorizationState;
  totalLines?: number;
  subagentResult?: TSubagentResult;
  capabilityResult?: CapabilityResult;
  filesystemObservation?: WorkspaceFilesystemObservationRecordV1;
};

export interface RuntimeHostToolExecutionSideEffectsV1 {
  plan?: AgentPlan;
  workspaceAccess?: WorkspaceAccess;
  authorization?: import('@kite/agent-kernel').AgentAuthorizationState;
  pendingSubagentApproval?: unknown;
}
