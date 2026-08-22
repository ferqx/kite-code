import {
  type AgentState,
  admitRecoveryAttemptV1,
  advanceToolRecoveryResponseV1,
  createToolRecoveryJournalV1,
  decideAutoReviewV1,
  isToolRecoveryJournalInvalidV1,
  type KernelEvent,
  normalizeToolRecoveryJournalV1,
  projectState26RestartRecoveryEventsV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  type State26RestartRecoveryFactsV1,
  state26RestartRecoveryCapabilityInvocationIdsV1,
  type ToolRecoveryJournalV1,
  toolFailureInstanceIdV1,
  toolInvocationFingerprintV1,
} from '@kite/agent-kernel';

export const runtimeHostState26AdvanceToolRecoveryResponseV1 = advanceToolRecoveryResponseV1;
export const runtimeHostState26AdmitRecoveryAttemptV1 = admitRecoveryAttemptV1;
export const runtimeHostState26CreateToolRecoveryJournalV1 = createToolRecoveryJournalV1;
export const runtimeHostState26DecideAutoReviewV1 = decideAutoReviewV1;
export const runtimeHostState26ToolRecoveryJournalInvalidV1 = isToolRecoveryJournalInvalidV1;
export const runtimeHostState26NormalizeToolRecoveryJournalV1 = normalizeToolRecoveryJournalV1;
export const runtimeHostState26RecordRecoveryFailureV1 = recordRecoveryFailureV1;
export const runtimeHostState26RecordRecoveryInvocationV1 = recordRecoveryInvocationV1;
export const runtimeHostState26RecordToolOwnedProgressV1 = recordToolOwnedProgressV1;
export const runtimeHostState26ToolFailureInstanceIdV1 = toolFailureInstanceIdV1;
export const runtimeHostState26ToolInvocationFingerprintV1 = toolInvocationFingerprintV1;

export type RuntimeHostState26RestartRecoveryFactsV1 = State26RestartRecoveryFactsV1;
export type State26ToolRecoveryJournalV1 = ToolRecoveryJournalV1;

/** Host-facing projection of the Kernel-owned State26 restart policy. */
export function runtimeHostState26RestartRecoveryCapabilityInvocationIdsV1(
  state: Readonly<AgentState>,
): readonly string[] {
  return state26RestartRecoveryCapabilityInvocationIdsV1(state);
}

/** Host-facing projection of deterministic restart receipts; performs no I/O. */
export function projectRuntimeHostState26RestartRecoveryEventsV1(
  state: Readonly<AgentState>,
  facts: RuntimeHostState26RestartRecoveryFactsV1,
): readonly KernelEvent[] {
  return projectState26RestartRecoveryEventsV1(state, facts);
}

/** Fail closed before App execution when the durable State26 journal is invalid. */
export function isRuntimeHostState26ToolRecoveryInvalidV1(state: Readonly<AgentState>): boolean {
  return isToolRecoveryJournalInvalidV1(state.toolRecovery);
}
