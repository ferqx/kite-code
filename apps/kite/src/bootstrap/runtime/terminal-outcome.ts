import {
  runtimeHostStateCompletedTerminalOutcomeV1,
  runtimeHostStateFailedTerminalOutcomeV1,
  runtimeHostStateNormalizeTerminalRuntimeEventV1,
  type StateRunTerminalOutcomeV1,
  type StateRuntimeTerminalStatusV1,
} from '@kite/runtime-host';

export type RuntimeTerminalStatusV1 = StateRuntimeTerminalStatusV1;
export type RunTerminalOutcomeV1 = StateRunTerminalOutcomeV1;

export interface TerminalOutcomePresentationV1 {
  label: string;
  severity: 'success' | 'warning' | 'error';
  complete: boolean;
  safeRetry: boolean;
  recoveryEntry: RunTerminalOutcomeV1['recoveryEntry'];
}

export const completedTerminalOutcomeV1 = runtimeHostStateCompletedTerminalOutcomeV1;
export const failedTerminalOutcomeV1 = runtimeHostStateFailedTerminalOutcomeV1;
export const normalizeTerminalRuntimeEventV1 = runtimeHostStateNormalizeTerminalRuntimeEventV1;

/** App presentation projection; durable terminal semantics remain Kernel-owned. */
export function projectTerminalOutcomeV1(
  outcome: RunTerminalOutcomeV1,
): TerminalOutcomePresentationV1 {
  if (outcome.status === 'completed') {
    return {
      label: 'Completed',
      severity: 'success',
      complete: true,
      safeRetry: false,
      recoveryEntry: 'none',
    };
  }
  return {
    label: outcome.reasonCode.replaceAll('_', ' '),
    severity: outcome.status === 'unknown' ? 'warning' : 'error',
    complete: false,
    safeRetry: outcome.safeRetry,
    recoveryEntry: outcome.recoveryEntry,
  };
}
