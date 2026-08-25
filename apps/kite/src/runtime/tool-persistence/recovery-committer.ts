import type { StateRuntimeEvent, StateRuntimeState } from '@kite-ai/runtime-host';
import type { ToolPipelineUnknownOutcome } from '@kite-ai/runtime-spi';
import { AppStateToolPipelinePersistenceError } from './contracts';

export function includesAcknowledgedRevision(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
): boolean {
  return after.revision >= before.revision + eventCount;
}

export async function persistExact(
  persist: (events: StateRuntimeEvent[]) => Promise<boolean>,
  events: StateRuntimeEvent[],
  acknowledgement:
    | 'attempt_start'
    | 'terminal_recovery'
    | 'retry_evidence'
    | 'receipt_evidence'
    | 'suspension_evidence'
    | 'filesystem_intent'
    | 'filesystem_mutation_ready',
): Promise<void> {
  let persisted: boolean;
  try {
    persisted = await persist(events);
  } catch (error) {
    throw new AppStateToolPipelinePersistenceError(
      errorCode(acknowledgement, false),
      error instanceof Error ? error.message : `${acknowledgement} persistence failed.`,
    );
  }
  if (!persisted) {
    throw new AppStateToolPipelinePersistenceError(errorCode(acknowledgement, true));
  }
}

export function stateTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new AppStateToolPipelinePersistenceError('persistence_unavailable');
  }
  return value;
}

export function boundedUnknownReason(code: ToolPipelineUnknownOutcome['code']): string {
  const reason = {
    dispatch_failed: 'Tool dispatch failed after the attempt was acknowledged.',
    dispatch_timed_out: 'Tool dispatch timed out after the attempt was acknowledged.',
    dispatch_result_invalid: 'Tool dispatch returned an invalid terminal result.',
    retryable_commit_failed: 'Tool safe-read retry evidence could not be committed.',
    terminal_commit_failed: 'Tool terminal receipt could not be committed.',
    suspension_commit_failed: 'Tool suspension evidence could not be committed.',
  }[code];
  return reason.slice(0, 256);
}

function errorCode(
  acknowledgement:
    | 'attempt_start'
    | 'terminal_recovery'
    | 'retry_evidence'
    | 'receipt_evidence'
    | 'suspension_evidence'
    | 'filesystem_intent'
    | 'filesystem_mutation_ready',
  stale: boolean,
) {
  if (acknowledgement === 'receipt_evidence') return 'terminal_commit_failed' as const;
  if (acknowledgement === 'retry_evidence') return 'retryable_commit_failed' as const;
  if (acknowledgement === 'suspension_evidence') return 'suspension_commit_failed' as const;
  if (acknowledgement === 'filesystem_intent') return 'filesystem_intent_commit_failed' as const;
  if (acknowledgement === 'filesystem_mutation_ready') {
    return 'filesystem_mutation_ready_commit_failed' as const;
  }
  return stale ? ('persistence_stale' as const) : ('persistence_unavailable' as const);
}
