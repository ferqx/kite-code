import type { KernelEvent } from './events';
import {
  type ClassifiedFailure,
  classifyRuntimeFailure,
  normalizeTerminalAgentEvent,
  terminalReasonForRuntimeFailure,
} from './normalization';
import type { AgentRunTerminalOutcome, AgentTerminalReasonCode } from './state';

export type RuntimeTerminalStatus = AgentRunTerminalOutcome['status'];
export type RunTerminalOutcome = AgentRunTerminalOutcome;

export function completedTerminalOutcome(): RunTerminalOutcome {
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

export function failedTerminalOutcome(
  failure: ClassifiedFailure,
  input: {
    knownExternalEffects?: RunTerminalOutcome['knownExternalEffects'];
    pendingVerification?: boolean;
    reasonCode?: AgentTerminalReasonCode;
  } = {},
): RunTerminalOutcome {
  const reasonCode = input.reasonCode ?? terminalReasonForRuntimeFailure(failure.kind);
  const status: RuntimeTerminalStatus =
    reasonCode === 'budget_exhausted' || reasonCode === 'process_limit_exceeded'
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

export function normalizeTerminalRuntimeEvent(event: KernelEvent): KernelEvent {
  if (event.type === 'run.completed' && !event.outcome) {
    return { ...event, outcome: completedTerminalOutcome() };
  }
  if (event.type === 'run.error' && !event.outcome) {
    const failure = event.failure ?? classifyRuntimeFailure('unknown', event.message);
    return {
      ...event,
      failure,
      outcome: failedTerminalOutcome(failure, {
        knownExternalEffects: failure.kind === 'unknown' ? 'unknown' : 'known',
      }),
    };
  }
  return normalizeTerminalAgentEvent(event);
}
