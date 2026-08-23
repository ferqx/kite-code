import {
  type AgentState,
  admitRecoveryAttempt,
  advanceToolRecoveryResponse,
  createToolRecoveryJournal,
  decideAutoReview,
  isToolRecoveryJournalInvalid,
  type KernelEvent,
  normalizeToolRecoveryJournal,
  projectStateRestartRecoveryEvents,
  recordRecoveryFailure,
  recordRecoveryInvocation,
  recordToolOwnedProgress,
  type StateRestartRecoveryFacts,
  stateRestartRecoveryCapabilityInvocationIds,
  type ToolRecoveryJournal,
  toolFailureInstanceId,
  toolInvocationFingerprint,
} from '@kite/agent-kernel';

export const runtimeHostStateAdvanceToolRecoveryResponse = advanceToolRecoveryResponse;
export const runtimeHostStateAdmitRecoveryAttempt = admitRecoveryAttempt;
export const runtimeHostStateCreateToolRecoveryJournal = createToolRecoveryJournal;
export const runtimeHostStateDecideAutoReview = decideAutoReview;
export const runtimeHostStateToolRecoveryJournalInvalid = isToolRecoveryJournalInvalid;
export const runtimeHostStateNormalizeToolRecoveryJournal = normalizeToolRecoveryJournal;
export const runtimeHostStateRecordRecoveryFailure = recordRecoveryFailure;
export const runtimeHostStateRecordRecoveryInvocation = recordRecoveryInvocation;
export const runtimeHostStateRecordToolOwnedProgress = recordToolOwnedProgress;
export const runtimeHostStateToolFailureInstanceId = toolFailureInstanceId;
export const runtimeHostStateToolInvocationFingerprint = toolInvocationFingerprint;

export type RuntimeHostStateRestartRecoveryFacts = StateRestartRecoveryFacts;
export type StateToolRecoveryJournal = ToolRecoveryJournal;

/** Host-facing projection of the Kernel-owned State restart policy. */
export function runtimeHostStateRestartRecoveryCapabilityInvocationIds(
  state: Readonly<AgentState>,
): readonly string[] {
  return stateRestartRecoveryCapabilityInvocationIds(state);
}

/** Host-facing projection of deterministic restart receipts; performs no I/O. */
export function projectRuntimeHostStateRestartRecoveryEvents(
  state: Readonly<AgentState>,
  facts: RuntimeHostStateRestartRecoveryFacts,
): readonly KernelEvent[] {
  return projectStateRestartRecoveryEvents(state, facts);
}

/** Fail closed before App execution when the durable State journal is invalid. */
export function isRuntimeHostStateToolRecoveryInvalid(state: Readonly<AgentState>): boolean {
  return isToolRecoveryJournalInvalid(state.toolRecovery);
}
