import {
  runtimeHostStateCompletedTerminalOutcome,
  runtimeHostStateFailedTerminalOutcome,
  runtimeHostStateNormalizeTerminalRuntimeEvent,
  type StateRunTerminalOutcome,
  type StateRuntimeTerminalStatus,
} from '@kite/runtime-host/kernel-adapter';

export type RuntimeTerminalStatus = StateRuntimeTerminalStatus;
export type RunTerminalOutcome = StateRunTerminalOutcome;

export interface TerminalOutcomePresentation {
  label: string;
  severity: 'success' | 'warning' | 'error';
  complete: boolean;
  safeRetry: boolean;
  recoveryEntry: RunTerminalOutcome['recoveryEntry'];
}

export const completedTerminalOutcome = runtimeHostStateCompletedTerminalOutcome;
export const failedTerminalOutcome = runtimeHostStateFailedTerminalOutcome;
export const normalizeTerminalRuntimeEvent = runtimeHostStateNormalizeTerminalRuntimeEvent;

/** App presentation projection; durable terminal semantics remain Kernel-owned. */
export function projectTerminalOutcome(outcome: RunTerminalOutcome): TerminalOutcomePresentation {
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
