import type { KernelEvent } from './events';
import {
  type ClassifiedFailureV1,
  classifyRuntimeFailureV1,
  normalizeTerminalAgentEvent,
  terminalReasonForRuntimeFailureV1,
} from './normalization';
import type { AgentRunTerminalOutcome, AgentTerminalReasonCode } from './state';

export type RuntimeTerminalStatusV1 = AgentRunTerminalOutcome['status'];
export type RunTerminalOutcomeV1 = AgentRunTerminalOutcome;

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
  failure: ClassifiedFailureV1,
  input: {
    knownExternalEffects?: RunTerminalOutcomeV1['knownExternalEffects'];
    pendingVerification?: boolean;
    reasonCode?: AgentTerminalReasonCode;
  } = {},
): RunTerminalOutcomeV1 {
  const reasonCode = input.reasonCode ?? terminalReasonForRuntimeFailureV1(failure.kind);
  const status: RuntimeTerminalStatusV1 =
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

export function normalizeTerminalRuntimeEventV1(event: KernelEvent): KernelEvent {
  if (event.type === 'run.completed' && !event.outcome) {
    return { ...event, outcome: completedTerminalOutcomeV1() };
  }
  if (event.type === 'run.error' && !event.outcome) {
    const failure = event.failure ?? classifyRuntimeFailureV1('unknown', event.message);
    return {
      ...event,
      failure,
      outcome: failedTerminalOutcomeV1(failure, {
        knownExternalEffects: failure.kind === 'unknown' ? 'unknown' : 'known',
      }),
    };
  }
  return normalizeTerminalAgentEvent(event);
}
