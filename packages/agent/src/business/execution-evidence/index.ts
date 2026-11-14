// Host-only receipt types for persisted history. No model-callable extension is registered.
import type { PublicExecution } from '../../extensions';

export interface ExecutionEvidenceReadRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly callerExecutionId: string;
  readonly executionId?: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}
export interface ExecutionEvidenceRecord {
  readonly execution: PublicExecution;
  /** Host-verified original Tool Run or Job ancestor Run, never inferred from result text. */
  readonly taskRunId: string;
  /** Recorded targets only; their presence does not prove publication or exclusive ownership. */
  readonly paths?: readonly {
    readonly path: string;
    readonly source: 'files_input' | 'files_checkpoint';
  }[];
  readonly shellId?: string;
  readonly checkpoint?: { readonly id: string; readonly state: string };
}
export interface ExecutionEvidencePage {
  readonly items: readonly ExecutionEvidenceRecord[];
  /** Host-owned scoped keyset cursor. Null is the only end-of-list assertion. */
  readonly nextCursor: string | null;
}
export const executionEvidenceToolId = 'execution_evidence.read';
