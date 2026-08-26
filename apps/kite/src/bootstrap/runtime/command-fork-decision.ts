import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import type { StateRuntimeSession } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { StateRuntimeStorage } from './state-runtime';

export type ForkSessionCommand = Extract<RuntimeCommand, { readonly type: 'fork_session' }>;

export type CommittedForkSessionCommand =
  | {
      readonly status: 'applied';
      readonly receipt: RuntimeStoredCommandReceipt;
      readonly targetSessionId: string;
    }
  | { readonly status: 'unavailable'; readonly targetSessionId: string };

/** Delegate the exact clone + receipt transaction to the one Store owner. */
export function commitForkSessionCommand(
  session: StateRuntimeSession,
  store: StateRuntimeStorage,
  command: ForkSessionCommand,
  targetSessionId: string,
  targetRecoveryIdentityKey: string,
  evidence: RuntimeCommandCommitEvidence,
): CommittedForkSessionCommand {
  const state = session.getState();
  if (
    command.sourceSessionId !== session.sessionId ||
    state.session.threadId !== command.sourceSessionId ||
    command.sourceRevision !== state.revision ||
    evidence.scopeSessionId !== command.sourceSessionId ||
    evidence.targetSessionId !== targetSessionId ||
    !isIdentifier(targetSessionId) ||
    !/^[a-f0-9]{64}$/u.test(targetRecoveryIdentityKey)
  ) {
    throw new Error('Runtime fork command identity or revision is invalid.');
  }
  const result = store.checkpoints.forkSessionForCommand({
    sourceSessionId: command.sourceSessionId,
    snapshotId: command.checkpointId ?? '__runtime_current__',
    targetSessionId,
    targetRecoveryIdentityKey,
    commandEvidence: evidence,
  });
  return result.status === 'applied'
    ? { status: 'applied', receipt: result.receipt, targetSessionId }
    : { status: 'unavailable', targetSessionId };
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
