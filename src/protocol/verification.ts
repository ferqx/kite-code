import type { CapabilityResult, ExecutionReceipt } from './capabilities';

export type VerificationMode = 'not_required' | 'best_effort' | 'required';
export type VerificationOutcome = 'passed' | 'failed' | 'inconclusive';

interface VerificationCheckBase {
  checkId: string;
  description: string;
}

export type VerificationCheck =
  | (VerificationCheckBase & {
      type: 'file_assertion';
      path: string;
      assertion: 'exists' | 'not_exists' | 'sha256_equals';
      expectedDigest?: string;
    })
  | (VerificationCheckBase & {
      type: 'command';
      command: string;
      cwd?: string;
      timeoutMs?: number;
      expectedExitCode?: number;
    })
  | (VerificationCheckBase & {
      type: 'schema';
      subject:
        | { kind: 'literal'; value: unknown }
        | { kind: 'skill_output'; activationId: string }
        | { kind: 'capability_artifact'; invocationId: string };
      schema: Record<string, unknown>;
    })
  | (VerificationCheckBase & {
      type: 'mcp_read_after_write';
      invocationId: string;
      capabilityId: string;
      capabilityRevision: string;
      arguments: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    })
  | (VerificationCheckBase & {
      type: 'external_reference';
      invocationId: string;
      uri?: string;
    })
  | (VerificationCheckBase & {
      type: 'reviewer';
      invocationIds?: string[];
      activationIds?: string[];
      instructions: string;
    });

export interface VerificationSpecV1 {
  schemaVersion: 1;
  verificationId: string;
  taskId?: string;
  subject: string;
  checks: VerificationCheck[];
  repair: { maxAttempts: number };
  compensation?: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  };
}

export interface VerificationCheckResult {
  checkId: string;
  /** Independent reviewer invocation, when this check used the model Gateway. */
  modelInvocationId?: string;
  outcome: VerificationOutcome;
  summary: string;
  evidenceDigest?: string;
  startedAt: string;
  finishedAt: string;
}

/** The reviewer receives source receipts and immutable artifact payloads, never a main-model verdict. */
export interface VerificationReviewerInput {
  instructions: string;
  receipts: ExecutionReceipt[];
  artifacts: Array<{ invocationId: string; result: CapabilityResult }>;
  skillOutputs: Array<{ activationId: string; output: Record<string, unknown> }>;
}

export interface VerificationReviewerResult {
  outcome: VerificationOutcome;
  summary: string;
  modelInvocationId?: string;
}
