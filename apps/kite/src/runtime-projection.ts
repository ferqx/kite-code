export interface ClientTerminalOutcome {
  readonly status:
    | 'completed'
    | 'aborted'
    | 'blocked'
    | 'unknown'
    | 'budget_exhausted'
    | 'resource_saturated';
  readonly reasonCode: string;
  readonly safeRetry: boolean;
  readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
}

export interface ClientTerminalOutcomePresentation {
  readonly label: string;
  readonly severity: 'success' | 'warning' | 'error';
  readonly complete: boolean;
  readonly safeRetry: boolean;
  readonly recoveryEntry: ClientTerminalOutcome['recoveryEntry'];
}

export function projectTerminalOutcome(
  outcome: ClientTerminalOutcome,
): ClientTerminalOutcomePresentation {
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

export interface ClientToolOutcome {
  readonly status:
    | 'success'
    | 'failed'
    | 'rejected'
    | 'cancelled'
    | 'timed_out'
    | 'exhausted'
    | 'unknown';
}

export function toolOutcomeSucceeded(outcome: ClientToolOutcome): boolean {
  return outcome.status === 'success';
}

export function toolOutcomeProtocolStatus(
  outcome: ClientToolOutcome,
): 'success' | 'error' | 'cancelled' | 'timeout' | 'exhausted' {
  switch (outcome.status) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timeout';
    case 'exhausted':
      return 'exhausted';
    default:
      return 'error';
  }
}

export function canonicalToolOutcome(event: {
  readonly type: string;
  readonly outcome?: ClientToolOutcome;
}): ClientToolOutcome {
  if (!event.outcome) {
    throw new Error(`${event.type} requires a canonical ToolOutcome.`);
  }
  return event.outcome;
}
