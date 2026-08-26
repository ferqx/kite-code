import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateInteractionBelongsToCurrentWork as interactionBelongsToCurrentWork,
  type StateRuntimeSession,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import { eventsForRunCancellation } from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

export interface CommittedControlCommand {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly RuntimeEvent[];
}

export interface CommittedCloseSessionCommand extends CommittedControlCommand {
  readonly wasActive: boolean;
}

export type SetInteractionModeCommand = Extract<
  RuntimeCommand,
  { readonly type: 'set_interaction_mode' }
>;

export type CancelTurnCommand = Extract<RuntimeCommand, { readonly type: 'cancel_turn' }>;
export type CloseSessionCommand = Extract<RuntimeCommand, { readonly type: 'close_session' }>;
export type ClearSessionCommandGrantsCommand = Extract<
  RuntimeCommand,
  { readonly type: 'clear_session_command_grants' }
>;

export function commitInteractionModeCommand(
  session: StateRuntimeSession,
  command: SetInteractionModeCommand,
  evidence: RuntimeCommandCommitEvidence,
): CommittedControlCommand {
  const state = session.getState() as RuntimeState;
  assertCommandSession(state, command.sessionId, command.expectedRevision, evidence);
  if (!isInteractionMode(command.mode) || state.mode === command.mode) {
    throw new Error('Runtime interaction mode command is invalid or a no-op.');
  }
  const changedAt = committedAtIso(evidence.committedAt);
  const committed = session.commitCommandBatch(
    [
      {
        type: 'interaction_mode.changed',
        mode: command.mode,
        source: 'user',
        changedAt,
      },
    ],
    evidence,
  );
  return Object.freeze({
    receipt: committed.receipt,
    events: committed.events as readonly RuntimeEvent[],
  });
}

export function commitCancelTurnCommand(
  session: StateRuntimeSession,
  command: CancelTurnCommand,
  evidence: RuntimeCommandCommitEvidence,
): CommittedControlCommand {
  const state = session.getState() as RuntimeState;
  assertCommandSession(state, command.sessionId, command.expectedRevision, evidence);
  if (state.turn.status !== 'active' || state.turn.turnId !== command.turnId) {
    throw new Error('Runtime cancel command does not match the active turn.');
  }
  const committed = session.commitCommandBatch(
    eventsForRunCancellation(state, 'Cancelled by user.', 'user'),
    evidence,
  );
  return Object.freeze({
    receipt: committed.receipt,
    events: committed.events as readonly RuntimeEvent[],
  });
}

/**
 * Clear grants only through the State session's receipt-bearing transaction.
 * The resulting State event and applied command receipt share one commit.
 */
export function commitClearSessionCommandGrantsCommand(
  session: StateRuntimeSession,
  command: ClearSessionCommandGrantsCommand,
  evidence: RuntimeCommandCommitEvidence,
): CommittedControlCommand {
  const state = session.getState() as RuntimeState;
  assertCommandSession(state, command.sessionId, command.expectedRevision, evidence);
  if (state.sessionCommandGrants.size === 0) {
    return Object.freeze({
      receipt: session.commitCommandSnapshot(evidence),
      events: Object.freeze([]),
    });
  }
  const committed = session.commitCommandBatch(
    [
      {
        type: 'approval.session_grants_cleared',
        sessionId: state.session.threadId,
        sessionRevision: state.revision,
        generation: state.approvalGeneration + 1,
        clearedAt: committedAtIso(evidence.committedAt),
      },
    ],
    evidence,
  );
  return Object.freeze({
    receipt: committed.receipt,
    events: committed.events as readonly RuntimeEvent[],
  });
}

/** Commit active cancellation or an idle snapshot receipt without inventing a close event. */
export function commitCloseSessionCommand(
  session: StateRuntimeSession,
  command: CloseSessionCommand,
  evidence: RuntimeCommandCommitEvidence,
): CommittedCloseSessionCommand {
  const state = session.getState() as RuntimeState;
  assertCommandSession(state, command.sessionId, command.expectedRevision, evidence);
  if (state.turn.status === 'active') {
    if (state.interactions.kind !== 'idle' && !interactionBelongsToCurrentWork(state)) {
      throw new Error('Runtime close command cannot cancel an unrelated active interaction.');
    }
    const committed = session.commitCommandBatch(
      eventsForRunCancellation(state, 'Runtime session closed.', 'user'),
      evidence,
    );
    return Object.freeze({
      receipt: committed.receipt,
      events: committed.events as readonly RuntimeEvent[],
      wasActive: true,
    });
  }
  return Object.freeze({
    receipt: session.commitCommandSnapshot(evidence),
    events: Object.freeze([]),
    wasActive: false,
  });
}

function assertCommandSession(
  state: Readonly<RuntimeState>,
  sessionId: string,
  expectedRevision: number,
  evidence: RuntimeCommandCommitEvidence,
): void {
  if (
    sessionId !== state.session.threadId ||
    evidence.targetSessionId !== sessionId ||
    expectedRevision !== state.revision
  ) {
    throw new Error('Runtime control command session or revision does not match current State.');
  }
}

function committedAtIso(committedAt: number): string {
  if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
    throw new Error('Runtime control command committed time is invalid.');
  }
  const value = new Date(committedAt);
  if (!Number.isFinite(value.getTime()))
    throw new Error('Runtime control command committed time is invalid.');
  return value.toISOString();
}

function isInteractionMode(value: unknown): value is RuntimeState['mode'] {
  return value === 'accept_edits' || value === 'auto' || value === 'full';
}
