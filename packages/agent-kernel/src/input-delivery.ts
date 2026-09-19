import type { AgentState } from './state';

export interface KernelInputRevisionFact {
  readonly messageId: string;
  readonly revision: number;
}

/**
 * Count accepted steer inputs that are not part of any prepared primary-model
 * surface yet. Start-command input is appended before `turn.started`, so its
 * durable turn identity remains the preceding Turn and is excluded here.
 */
export function countPendingSteerInputs(
  state: Readonly<AgentState>,
  inputRevisions: readonly KernelInputRevisionFact[],
): number {
  if (state.turn.status !== 'active') return 0;
  const currentTurnInputs = state.transcript.messages.filter(
    (message) => message.kind === 'user' && message.turnId === state.turn.turnId,
  );
  if (currentTurnInputs.length === 0) return 0;

  const revisionByMessageId = new Map<string, number>();
  for (const fact of inputRevisions) {
    if (!Number.isSafeInteger(fact.revision) || fact.revision < 1) {
      throw new Error('Kernel input delivery requires positive persisted revisions.');
    }
    if (revisionByMessageId.has(fact.messageId)) {
      throw new Error('Kernel input delivery requires unique message identities.');
    }
    revisionByMessageId.set(fact.messageId, fact.revision);
  }

  const deliveredThroughRevision = Object.values(state.modelInvocations)
    .filter((invocation) => invocation.purpose === 'primary_agent')
    .reduce((latest, invocation) => Math.max(latest, invocation.preparedStateRevision), 0);

  return currentTurnInputs.filter((message) => {
    const revision = revisionByMessageId.get(message.messageId);
    if (revision === undefined) {
      throw new Error(`Kernel input delivery is missing revision for '${message.messageId}'.`);
    }
    return revision > deliveredThroughRevision;
  }).length;
}
