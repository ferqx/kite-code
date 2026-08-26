import { type AgentState, type KernelEvent, reduceAgentState } from '@kite-ai/agent-kernel';
import { projectVerificationSchemaAdmissions } from '#kite-cli/bootstrap/runtime/verification-schema-admission';

export {
  admitRecoveryAttempt,
  decideAutoReview,
  isToolRecoveryJournalInvalid,
  normalizeToolRecoveryJournal,
  recordRecoveryFailure,
  toolFailureInstanceId,
  toolInvocationFingerprint,
} from '@kite-ai/agent-kernel';

/** Test-only adapter for the exact State reducer plus composed schema facts. */
export function reduceRuntimeState<State extends AgentState>(
  state: State,
  event: KernelEvent,
): State {
  const verificationSchemaAdmissions = projectVerificationSchemaAdmissions(event);
  // This test adapter supplies the Host fact that production composition
  // allocates before asking the pure Kernel to reduce a first user message.
  // The identity is deterministic and derived only from the event key; it is
  // never persisted as a new event field or generated inside Agent Kernel.
  const allocatedTaskId =
    event.type === 'user.message_appended' && state.activeTaskId === null
      ? `task-${event.messageId}`
      : undefined;
  return reduceAgentState(
    state,
    event,
    verificationSchemaAdmissions || allocatedTaskId
      ? {
          ...(verificationSchemaAdmissions ? { verificationSchemaAdmissions } : {}),
          ...(allocatedTaskId ? { allocatedTaskId } : {}),
        }
      : undefined,
  ) as State;
}
