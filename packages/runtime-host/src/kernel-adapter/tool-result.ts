import type { AgentPlan, AgentToolResultMeta, RuntimeEvent } from '@kite-ai/agent-kernel';
import type {
  CapabilityResult,
  ShellGrantUsed,
  WorkspaceAccess,
  WorkspaceFilesystemObservationRecord,
} from '@kite-ai/runtime-contract';
import type { SandboxExecutionProviderFailureCode } from '@kite-ai/runtime-spi';

/** Generic shell-shaped result carried across Host/App execution seams. */
export interface RuntimeHostShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  sandboxFailure?: {
    code: SandboxExecutionProviderFailureCode;
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
export interface RuntimeHostToolFailure {
  message: 'Tool execution failed.';
  tool: string;
  reason: string;
  guidance: string;
}

/**
 * Generic structural terminal result.  The Host owns only this transport
 * shape; the optional subagent payload remains an opaque caller type.
 */
export type RuntimeHostToolExecutionResult<
  TSubagentResult = unknown,
  TIntent = unknown,
> = RuntimeHostShellResult & {
  runtimeEvents?: RuntimeEvent[];
  classifierAdvice?: import('@kite-ai/agent-kernel').ToolOutcomeClassifierAdvice;
  classifierDiagnostic?: 'classifier_threw';
  resultMeta?: AgentToolResultMeta;
  status?: 'success' | 'error' | 'rejected' | 'exhausted';
  approvalRoute?: 'user' | 'auto_review';
  tool?: string;
  failure?: RuntimeHostToolFailure;
  path?: string;
  action?: {
    intent?: TIntent;
    grantUsed: ShellGrantUsed;
  };
  workspaceAccess?: WorkspaceAccess;
  totalLines?: number;
  subagentResult?: TSubagentResult;
  capabilityResult?: CapabilityResult;
  filesystemObservation?: WorkspaceFilesystemObservationRecord;
};

export interface RuntimeHostToolExecutionSideEffects {
  plan?: AgentPlan;
  workspaceAccess?: WorkspaceAccess;
  pendingSubagentApproval?: unknown;
}
