import { createHash } from 'node:crypto';
import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import type { StateRuntimeSession } from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeInputResourceResult,
  type RuntimeCommandCommitEvidence,
  type RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import { eventsForRuntimeAction } from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

export type SteerTurnCommand = Extract<RuntimeCommand, { readonly type: 'steer_turn' }>;

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
): CommittedSteerTurnCommand {
  const state = session.getState() as RuntimeState;
  if (command.sessionId !== session.sessionId || evidence.targetSessionId !== session.sessionId) {
    throw new Error('Runtime steer command does not match the State session.');
  }
  if (state.turn.status !== 'active' || state.turn.turnId !== command.expectedTurnId) {
    throw new Error('Runtime steer command target Turn is no longer active.');
  }
  if (
    session.supportsRunStorage() &&
    session.getLifecycleProjection().currentRun?.runId !== command.expectedRunId
  ) {
    throw new Error('Runtime steer command target Run is no longer active.');
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

function commandDerivedInputId(commandId: string): string {
  return `input_${createHash('sha256')
    .update(`kite.runtime.steer-turn.v1\0input\0${commandId}`)
    .digest('hex')
    .slice(0, 32)}`;
}
