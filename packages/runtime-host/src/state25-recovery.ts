import {
  type AgentState,
  admitRecoveryAttemptV1,
  advanceToolRecoveryResponseV1,
  createToolRecoveryJournalV1,
  decideAutoReviewV1,
  isToolRecoveryJournalInvalidV1,
  type KernelEvent,
  normalizeToolRecoveryJournalV1,
  projectState25RestartRecoveryEventsV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  type State25RestartRecoveryFactsV1,
  state25RestartRecoveryCapabilityInvocationIdsV1,
  type ToolRecoveryJournalV1,
  toolFailureInstanceIdV1,
  toolInvocationFingerprintV1,
} from '@kite/agent-kernel';

export const runtimeHostState25AdvanceToolRecoveryResponseV1 = advanceToolRecoveryResponseV1;
export const runtimeHostState25AdmitRecoveryAttemptV1 = admitRecoveryAttemptV1;
export const runtimeHostState25CreateToolRecoveryJournalV1 = createToolRecoveryJournalV1;
export const runtimeHostState25DecideAutoReviewV1 = decideAutoReviewV1;
export const runtimeHostState25ToolRecoveryJournalInvalidV1 = isToolRecoveryJournalInvalidV1;
export const runtimeHostState25NormalizeToolRecoveryJournalV1 = normalizeToolRecoveryJournalV1;
export const runtimeHostState25RecordRecoveryFailureV1 = recordRecoveryFailureV1;
export const runtimeHostState25RecordRecoveryInvocationV1 = recordRecoveryInvocationV1;
export const runtimeHostState25RecordToolOwnedProgressV1 = recordToolOwnedProgressV1;
export const runtimeHostState25ToolFailureInstanceIdV1 = toolFailureInstanceIdV1;
export const runtimeHostState25ToolInvocationFingerprintV1 = toolInvocationFingerprintV1;

export type RuntimeHostState25RestartRecoveryFactsV1 = State25RestartRecoveryFactsV1;
export type State25ToolRecoveryJournalV1 = ToolRecoveryJournalV1;

/** Host-facing projection of the Kernel-owned State25 restart policy. */
export function runtimeHostState25RestartRecoveryCapabilityInvocationIdsV1(
  state: Readonly<AgentState>,
): readonly string[] {
  return state25RestartRecoveryCapabilityInvocationIdsV1(state);
}

/** Host-facing projection of deterministic restart receipts; performs no I/O. */
export function projectRuntimeHostState25RestartRecoveryEventsV1(
  state: Readonly<AgentState>,
  facts: RuntimeHostState25RestartRecoveryFactsV1,
): readonly KernelEvent[] {
  return projectState25RestartRecoveryEventsV1(state, facts);
}

/** Fail closed before App execution when the durable State25 journal is invalid. */
export function isRuntimeHostState25ToolRecoveryInvalidV1(state: Readonly<AgentState>): boolean {
  return isToolRecoveryJournalInvalidV1(state.toolRecovery);
}
