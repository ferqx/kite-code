import { createHash } from 'node:crypto';
import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import {
  countPendingSteerInputs,
  type StateRuntimeSession,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeInputResourceResult,
  type RuntimeCommandCommitEvidence,
  type RuntimeStoredCommandReceipt,
  type StoredRuntimeEvent,
} from '@kite-ai/runtime-host/storage';
import { eventsForRuntimeAction } from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

export type SteerTurnCommand = Extract<RuntimeCommand, { readonly type: 'steer_turn' }>;

export const MAX_PENDING_STEER_INPUTS_ = 8;

export interface CommittedSteerTurnCommand {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly RuntimeEvent[];
  readonly input: {
    readonly inputId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly sequence: number;
  };
  readonly supersededInteractionId?: string;
}

export function commitSteerTurnCommand(
  session: StateRuntimeSession,
  command: SteerTurnCommand,
  evidence: RuntimeCommandCommitEvidence,
  journal: readonly StoredRuntimeEvent<RuntimeEvent>[],
): CommittedSteerTurnCommand {
  const state = session.getState() as RuntimeState;
  if (command.sessionId !== session.sessionId || evidence.targetSessionId !== session.sessionId) {
    throw new Error('Runtime steer command does not match the State session.');
  }
  if (state.turn.status !== 'active' || state.turn.turnId !== command.expectedTurnId) {
    throw new Error('Runtime steer command target Turn is no longer active.');
  }
  if (!steerQueueHasCapacity(state, journal)) {
    throw new Error('Runtime steer queue is full.');
  }
  const sequence = state.transcript.messages.length;
  const inputId = commandDerivedInputId(command.commandId);
  const input = Object.freeze({
    inputId,
    runId: command.expectedRunId,
    turnId: command.expectedTurnId,
    sequence,
  });
  const pending = state.activeApprovalId
    ? state.pendingApprovals.get(state.activeApprovalId)
    : undefined;
  const supersededInteractionId =
    pending?.status === 'awaiting_user' && pending.childSubagentId === undefined
      ? pending.interactionId
      : undefined;
  const approvalEvents =
    supersededInteractionId === undefined
      ? []
      : eventsForRuntimeAction(state, {
          type: 'reject',
          interactionId: supersededInteractionId,
          generation: pending!.generation,
          reason: 'superseded_by_user_input',
        });
  const event: RuntimeEvent = {
    type: 'user.message_appended',
    messageId: inputId,
    content: command.input,
  };
  const committed = session.commitCommandBatch(
    [
      ...(approvalEvents.length === 0
        ? []
        : [
            {
              type: 'tool.rejected' as const,
              toolCallId: pending!.toolCallId,
              reason: 'superseded_by_user_input',
            },
            ...approvalEvents,
          ]),
      event,
    ],
    session.supportsRunStorage()
      ? Object.freeze({
          ...evidence,
          resourceResult: createRuntimeInputResourceResult(input),
        })
      : evidence,
  );
  return Object.freeze({
    receipt: committed.receipt,
    events: committed.events as readonly RuntimeEvent[],
    input,
    ...(supersededInteractionId === undefined ? {} : { supersededInteractionId }),
  });
}

export function steerQueueHasCapacity(
  state: Readonly<RuntimeState>,
  journal: readonly StoredRuntimeEvent<RuntimeEvent>[],
): boolean {
  const facts = journal.flatMap((entry) => {
    if (entry.event.type !== 'user.message_appended') return [];
    if (!Number.isSafeInteger(entry.revision) || entry.revision === undefined) {
      throw new Error('Runtime steer queue requires persisted input revisions.');
    }
    return [{ messageId: entry.event.messageId, revision: entry.revision }];
  });
  return countPendingSteerInputs(state, facts) < MAX_PENDING_STEER_INPUTS_;
}

function commandDerivedInputId(commandId: string): string {
  return `input_${createHash('sha256')
    .update(`kite.runtime.steer-turn.v1\0input\0${commandId}`)
    .digest('hex')
    .slice(0, 32)}`;
}
