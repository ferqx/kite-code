export type AgentVerificationMode = 'not_required' | 'best_effort' | 'required';
export type AgentVerificationOutcome = 'passed' | 'failed' | 'inconclusive';
export type AgentVerificationStatus =
  | 'pending'
  | 'running'
  | 'repair_pending'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'waived'
  | 'compensating'
  | 'compensated'
  | 'budget_exhausted';
export type AgentVerificationCheck =
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'file_assertion';
      readonly path: string;
      readonly assertion: 'exists' | 'not_exists' | 'sha256_equals';
      readonly expectedDigest?: string;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'command';
      readonly command: string;
      readonly cwd?: string;
      readonly timeoutMs?: number;
      readonly expectedExitCode?: number;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'schema';
      readonly subject:
        | { readonly kind: 'literal'; readonly value: unknown }
        | { readonly kind: 'skill_output'; readonly activationId: string }
        | { readonly kind: 'capability_artifact'; readonly invocationId: string };
      readonly schema: Readonly<Record<string, unknown>>;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'mcp_read_after_write';
      readonly invocationId: string;
      readonly capabilityId: string;
      readonly capabilityRevision: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly outputSchema?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'external_reference';
      readonly invocationId: string;
      readonly uri?: string;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      readonly type: 'receipt';
      readonly invocationId: string;
    }
  | {
      readonly checkId: string;
      readonly description: string;
      /** Read-only compatibility check. Current planners never create it. */
      readonly type: 'reviewer';
      readonly instructions: string;
    };
export interface AgentVerificationSpec {
  readonly schemaVersion: 1;
  readonly verificationId: string;
  readonly taskId?: string;
  readonly subject: string;
  readonly checks: readonly AgentVerificationCheck[];
  readonly repair: { readonly maxAttempts: number };
  readonly compensation?: {
    readonly command: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
  };
}
export interface AgentVerificationCheckResult {
  readonly checkId: string;
  readonly modelInvocationId?: string;
  readonly outcome: AgentVerificationOutcome;
  readonly summary: string;
  readonly evidenceDigest?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}
export interface AgentVerificationRecord {
  readonly verificationId: string;
  readonly taskId?: string;
  readonly mode: AgentVerificationMode;
  readonly status: AgentVerificationStatus;
  readonly spec: AgentVerificationSpec;
  readonly requestedAt: string;
  readonly attempts: number;
  readonly repairAttempts: number;
  readonly checkResults: Readonly<Record<string, AgentVerificationCheckResult>>;
  readonly completedAt?: string;
  readonly waiver?: { readonly actor: 'user'; readonly reason: string; readonly waivedAt: string };
  readonly compensation?: {
    readonly outcome: AgentVerificationOutcome;
    readonly summary: string;
    readonly completedAt: string;
  };
  readonly diagnostics?: readonly string[];
}
export interface AgentVerificationRuntimeState {
  readonly records: Readonly<Record<string, AgentVerificationRecord>>;
}
