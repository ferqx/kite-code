import { createHash } from 'node:crypto';
import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import type { StateRuntimeSession } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

export type RewindSessionCommand = Extract<RuntimeCommand, { readonly type: 'rewind_session' }>;
export type RewindRequestedEvent = Extract<
  RuntimeEvent,
  { readonly type: 'session.rewind_requested' }
>;

/**
 * The complete durable identity of a rewind post-commit effect. It is derived
 * solely from the admitted command and source State; private fork recovery
 * identity is intentionally allocated later, inside the effect.
 */
export interface PrecommittedRewindDescriptor {
  readonly kind: 'precommitted_rewind';
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly rewindId: string;
  readonly commandId: string;
  readonly checkpointId: string;
  readonly scope: RewindSessionCommand['scope'];
  readonly committedRevision: number;
}

export interface CommittedRewindCommand {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly [RewindRequestedEvent];
  readonly descriptor: PrecommittedRewindDescriptor;
}

/**
 * Build, but do not persist or execute, a rewind request. The caller must
 * validate checkpoint availability before invoking this function; the effect
 * independently revalidates it so restart recovery fails durably if it was
 * removed or corrupted after command admission.
 */
export function planRewindCommand(
  state: Readonly<RuntimeState>,
  command: RewindSessionCommand,
): {
  readonly events: readonly [RewindRequestedEvent];
  readonly descriptor: PrecommittedRewindDescriptor;
} {
  if (command.sessionId !== state.session.threadId || command.expectedRevision !== state.revision) {
    throw new Error('Runtime rewind command session or revision does not match current State.');
  }
  const rewindId = commandDerivedRewindId(command.sessionId, command.commandId, 'rewind');
  const targetSessionId =
    command.scope === 'code_only'
      ? command.sessionId
      : commandDerivedRewindId(command.sessionId, command.commandId, 'target');
  const requested = Object.freeze({
    type: 'session.rewind_requested' as const,
    rewindId,
    commandId: command.commandId,
    sourceSessionId: command.sessionId,
    targetSessionId,
    checkpointId: command.checkpointId,
    scope: command.scope,
  });
  const events = [requested] as const;
  return Object.freeze({
    events,
    descriptor: Object.freeze({
      kind: 'precommitted_rewind',
      sourceSessionId: command.sessionId,
      targetSessionId,
      rewindId,
      commandId: command.commandId,
      checkpointId: command.checkpointId,
      scope: command.scope,
      committedRevision: state.revision + 1,
    }),
  });
}

/** Commit only the request event and the original source-session receipt. */
export function commitRewindCommand(
  session: StateRuntimeSession,
  command: RewindSessionCommand,
  evidence: RuntimeCommandCommitEvidence,
): CommittedRewindCommand {
  const state = session.getState() as RuntimeState;
  if (
    session.sessionId !== command.sessionId ||
    evidence.scopeSessionId !== command.sessionId ||
    // The receipt represents command admission on the source session. The
    // fork target is outcome evidence and must never change receipt scope.
    evidence.targetSessionId !== command.sessionId
  ) {
    throw new Error('Runtime rewind command receipt target must remain the source session.');
  }
  const planned = planRewindCommand(state, command);
  const committed = session.commitCommandBatch(planned.events, evidence);
  const event = committed.events[0] as RewindRequestedEvent | undefined;
  if (event?.type !== 'session.rewind_requested') {
    throw new Error('Runtime rewind command did not commit its request event.');
  }
  return Object.freeze({
    receipt: committed.receipt,
    events: [event] as const,
    descriptor: Object.freeze({
      ...planned.descriptor,
      committedRevision: committed.receipt.committedRevision,
    }),
  });
}

export function assertPrecommittedRewind(
  state: Readonly<RuntimeState>,
  descriptor: PrecommittedRewindDescriptor,
): RewindRequestedEvent {
  if (
    descriptor.kind !== 'precommitted_rewind' ||
    state.session.threadId !== descriptor.sourceSessionId ||
    state.revision !== descriptor.committedRevision
  ) {
    throw new Error('Runtime rewind descriptor does not match current State.');
  }
  return {
    type: 'session.rewind_requested',
    rewindId: descriptor.rewindId,
    commandId: descriptor.commandId,
    sourceSessionId: descriptor.sourceSessionId,
    targetSessionId: descriptor.targetSessionId,
    checkpointId: descriptor.checkpointId,
    scope: descriptor.scope,
  };
}

function commandDerivedRewindId(
  sourceSessionId: string,
  commandId: string,
  domain: 'rewind' | 'target',
): string {
  const digest = createHash('sha256')
    .update(`kite.runtime.rewind.v1\0${domain}\0${sourceSessionId}\0${commandId}`)
    .digest('hex');
  return `${domain === 'rewind' ? 'rewind' : 'rewind_session'}_${digest.slice(0, 32)}`;
}
