import type {
  Command,
  RecoverSessionRequest,
  ResumeJobReportRequest,
  ResumeRunRequest,
  Run,
} from '@kite-ai/client';
import { validateRequest } from '@kite-ai/client';

export type TuiRecoveryIntent =
  | { kind: 'interrupt'; sessionId: string; request: RecoverSessionRequest }
  | { kind: 'run'; sessionId: string; request: ResumeRunRequest }
  | { kind: 'report'; sessionId: string; reportCommandId: string; request: ResumeJobReportRequest };
export function parseTuiRecoveryIntent(value: unknown): TuiRecoveryIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('recovery_restore_invalid');
  const raw = value as Record<string, unknown>,
    keys =
      raw.kind === 'report'
        ? ['kind', 'sessionId', 'request', 'reportCommandId']
        : ['kind', 'sessionId', 'request'];
  if (
    !['run', 'report', 'interrupt'].includes(String(raw.kind)) ||
    Object.keys(raw).sort().join(',') !== keys.sort().join(',') ||
    typeof raw.sessionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.sessionId) ||
    (raw.kind === 'report' &&
      (typeof raw.reportCommandId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(raw.reportCommandId)))
  )
    throw Error('recovery_restore_invalid');
  validateRequest(
    raw.kind === 'run'
      ? 'ResumeRunRequest'
      : raw.kind === 'report'
        ? 'ResumeJobReportRequest'
        : 'RecoverSessionRequest',
    raw.request,
  );
  return structuredClone(raw as TuiRecoveryIntent);
}
export interface TuiRecoveryOutcome {
  intent: TuiRecoveryIntent;
  status:
    | 'submitting'
    | 'accepted'
    | 'resumed'
    | 'interrupted'
    | 'suppressed'
    | 'failed'
    | 'outcome_unknown';
  command?: Command;
  run?: Run;
  error?: string;
}
export interface TuiRecoveryPort {
  restore?(): Promise<readonly TuiRecoveryOutcome[]>;
  submit(intent: TuiRecoveryIntent, signal: AbortSignal): Promise<TuiRecoveryOutcome>;
  lookup(intent: TuiRecoveryIntent, signal: AbortSignal): Promise<TuiRecoveryOutcome>;
}
