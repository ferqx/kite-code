import {
  type AgentState,
  admitRecoveryAttemptV1,
  advanceToolRecoveryResponseV1,
  createToolRecoveryJournalV1,
  decideAutoReviewV1,
  isToolRecoveryJournalInvalidV1,
  type KernelEvent,
  normalizeToolRecoveryJournalV1,
  projectStateRestartRecoveryEventsV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  type StateRestartRecoveryFactsV1,
  stateRestartRecoveryCapabilityInvocationIdsV1,
  type ToolRecoveryJournalV1,
  toolFailureInstanceIdV1,
  toolInvocationFingerprintV1,
} from '@kite/agent-kernel';

export const runtimeHostStateAdvanceToolRecoveryResponseV1 = advanceToolRecoveryResponseV1;
export const runtimeHostStateAdmitRecoveryAttemptV1 = admitRecoveryAttemptV1;
export const runtimeHostStateCreateToolRecoveryJournalV1 = createToolRecoveryJournalV1;
export const runtimeHostStateDecideAutoReviewV1 = decideAutoReviewV1;
export const runtimeHostStateToolRecoveryJournalInvalidV1 = isToolRecoveryJournalInvalidV1;
export const runtimeHostStateNormalizeToolRecoveryJournalV1 = normalizeToolRecoveryJournalV1;
export const runtimeHostStateRecordRecoveryFailureV1 = recordRecoveryFailureV1;
export const runtimeHostStateRecordRecoveryInvocationV1 = recordRecoveryInvocationV1;
export const runtimeHostStateRecordToolOwnedProgressV1 = recordToolOwnedProgressV1;
export const runtimeHostStateToolFailureInstanceIdV1 = toolFailureInstanceIdV1;
export const runtimeHostStateToolInvocationFingerprintV1 = toolInvocationFingerprintV1;

export type RuntimeHostStateRestartRecoveryFactsV1 = StateRestartRecoveryFactsV1;
export type StateToolRecoveryJournalV1 = ToolRecoveryJournalV1;

/** Host-facing projection of the Kernel-owned State restart policy. */
export function runtimeHostStateRestartRecoveryCapabilityInvocationIdsV1(
  state: Readonly<AgentState>,
): readonly string[] {
  return stateRestartRecoveryCapabilityInvocationIdsV1(state);
}

/** Host-facing projection of deterministic restart receipts; performs no I/O. */
export function projectRuntimeHostStateRestartRecoveryEventsV1(
  state: Readonly<AgentState>,
  facts: RuntimeHostStateRestartRecoveryFactsV1,
): readonly KernelEvent[] {
  return projectStateRestartRecoveryEventsV1(state, facts);
}

/** Fail closed before App execution when the durable State journal is invalid. */
export function isRuntimeHostStateToolRecoveryInvalidV1(state: Readonly<AgentState>): boolean {
  return isToolRecoveryJournalInvalidV1(state.toolRecovery);
}
