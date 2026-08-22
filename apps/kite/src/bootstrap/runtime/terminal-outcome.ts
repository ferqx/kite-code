import {
  runtimeHostState26CompletedTerminalOutcomeV1,
  runtimeHostState26FailedTerminalOutcomeV1,
  runtimeHostState26NormalizeTerminalRuntimeEventV1,
  type State26RunTerminalOutcomeV1,
  type State26RuntimeTerminalStatusV1,
} from '@kite/runtime-host';

export type RuntimeTerminalStatusV1 = State26RuntimeTerminalStatusV1;
export type RunTerminalOutcomeV1 = State26RunTerminalOutcomeV1;

export interface TerminalOutcomePresentationV1 {
  label: string;
  severity: 'success' | 'warning' | 'error';
  complete: boolean;
  safeRetry: boolean;
  recoveryEntry: RunTerminalOutcomeV1['recoveryEntry'];
}

export const completedTerminalOutcomeV1 = runtimeHostState26CompletedTerminalOutcomeV1;
export const failedTerminalOutcomeV1 = runtimeHostState26FailedTerminalOutcomeV1;
export const normalizeTerminalRuntimeEventV1 = runtimeHostState26NormalizeTerminalRuntimeEventV1;

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
