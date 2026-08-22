export interface ClientTerminalOutcomeV1 {
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

export interface ClientTerminalOutcomePresentationV1 {
  readonly label: string;
  readonly severity: 'success' | 'warning' | 'error';
  readonly complete: boolean;
  readonly safeRetry: boolean;
  readonly recoveryEntry: ClientTerminalOutcomeV1['recoveryEntry'];
}

export function projectTerminalOutcomeV1(
  outcome: ClientTerminalOutcomeV1,
): ClientTerminalOutcomePresentationV1 {
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

export interface ClientToolOutcomeV1 {
  readonly status:
    | 'success'
    | 'failed'
    | 'rejected'
    | 'cancelled'
    | 'timed_out'
    | 'exhausted'
    | 'unknown';
}

export function toolOutcomeSucceededV1(outcome: ClientToolOutcomeV1): boolean {
  return outcome.status === 'success';
}

export function toolOutcomeProtocolStatusV1(
  outcome: ClientToolOutcomeV1,
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

export function canonicalToolOutcomeV1(event: {
  readonly type: string;
  readonly outcomeV1?: ClientToolOutcomeV1;
}): ClientToolOutcomeV1 {
  if (!event.outcomeV1) {
    throw new Error(`${event.type} requires a canonical ToolOutcomeV1.`);
  }
  return event.outcomeV1;
}
