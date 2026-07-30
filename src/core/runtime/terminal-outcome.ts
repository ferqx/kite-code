import type { RuntimeEvent } from './events';
import type { ClassifiedFailure, TerminalReasonCodeV1 } from './failures';
import { classifyFailure, terminalReasonForFailureV1 } from './failures';

export type RuntimeTerminalStatusV1 =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'unknown'
  | 'budget_exhausted'
  | 'resource_saturated';

export interface RunTerminalOutcomeV1 {
  version: 1;
  status: RuntimeTerminalStatusV1;
  reasonCode: TerminalReasonCodeV1;
  knownExternalEffects: 'none' | 'known' | 'unknown';
  safeRetry: boolean;
  recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  pendingVerification: boolean;
}

export interface TerminalOutcomePresentationV1 {
  label: string;
  severity: 'success' | 'warning' | 'error';
  complete: boolean;
  safeRetry: boolean;
  recoveryEntry: RunTerminalOutcomeV1['recoveryEntry'];
}

export function completedTerminalOutcomeV1(): RunTerminalOutcomeV1 {
  return {
    version: 1,
    status: 'completed',
    reasonCode: 'completed',
    knownExternalEffects: 'known',
    safeRetry: false,
    recoveryEntry: 'none',
    pendingVerification: false,
  };
}

export function failedTerminalOutcomeV1(
  failure: ClassifiedFailure,
  input: {
    knownExternalEffects?: RunTerminalOutcomeV1['knownExternalEffects'];
    pendingVerification?: boolean;
    reasonCode?: TerminalReasonCodeV1;
  } = {},
): RunTerminalOutcomeV1 {
  const reasonCode = input.reasonCode ?? terminalReasonForFailureV1(failure.kind);
  const status: RuntimeTerminalStatusV1 =
    reasonCode === 'budget_exhausted'
      ? 'budget_exhausted'
      : reasonCode === 'resource_saturated' ||
          reasonCode === 'tool_concurrency_saturated' ||
          reasonCode === 'shell_concurrency_saturated'
        ? 'resource_saturated'
        : reasonCode === 'unknown' || input.knownExternalEffects === 'unknown'
          ? 'unknown'
          : failure.needsUserIntervention
            ? 'blocked'
            : 'aborted';
  const knownExternalEffects = input.knownExternalEffects ?? 'known';
  return {
    version: 1,
    status,
    reasonCode,
    knownExternalEffects,
    safeRetry: failure.retryable && knownExternalEffects !== 'unknown',
    recoveryEntry:
      knownExternalEffects === 'unknown'
        ? 'reconcile'
        : failure.retryable
          ? 'retry'
          : failure.needsUserIntervention
            ? 'operator_action'
            : 'new_run',
    pendingVerification: input.pendingVerification ?? false,
  };
}

/** One projection used by terminal/TUI and non-interactive CLI consumers. */
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

/** Materialize the v1 projection before new terminal events enter persistence. */
export function normalizeTerminalRuntimeEventV1(event: RuntimeEvent): RuntimeEvent {
  if (event.type === 'run.completed' && !event.outcome) {
    return { ...event, outcome: completedTerminalOutcomeV1() };
  }
  if (event.type === 'run.error' && !event.outcome) {
    const failure = event.failure ?? classifyFailure('unknown', event.message);
    return {
      ...event,
      failure,
      outcome: failedTerminalOutcomeV1(failure, {
        knownExternalEffects: failure.kind === 'unknown' ? 'unknown' : 'known',
      }),
    };
  }
  return event;
}
