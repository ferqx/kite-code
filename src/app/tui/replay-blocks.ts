import type { SessionData } from '../../core/persistence/sessions.js';
import type { RuntimeEvent } from '../../core/runtime/events.js';
import { decodeHistoricalToolOutcomeEventV1 } from '../../core/runtime/tool-outcome-events.js';
import { createInitialState } from './initialState.js';
import { handleEventAction, handleRuntimeEventAction } from './reducers/handleEvent.js';
import { findBlockById, replaceBlockById } from './reducers/helpers.js';
import type { InterruptState, OutputBlock, TuiState } from './types.js';

export const TUI_REPLAY_CANCELLED_TEXT = '用户取消执行（会话恢复时交互未完成）';

function withoutPendingTool(state: TuiState, toolCallId: string): TuiState {
  if (!state.pendingToolCalls[toolCallId]) return state;
  const { [toolCallId]: _, ...pendingToolCalls } = state.pendingToolCalls;
  return { ...state, pendingToolCalls };
}

function visibleToolName(state: TuiState, toolCallId: string): string | undefined {
  for (const turn of state.turns) {
    for (const block of turn.blocks) {
      if (block.kind === 'tool_card' && block.callId === toolCallId) return block.name;
      if (block.kind === 'tool_summary') {
        const tool = block.tools.find((candidate) => candidate.callId === toolCallId);
        if (tool) return tool.name;
      }
    }
  }
  return state.pendingToolCalls[toolCallId]?.name;
}

function materializeReplayTool(state: TuiState, toolCallId: string): TuiState {
  const pending = state.pendingToolCalls[toolCallId];
  if (!pending) return state;
  return handleEventAction(state, {
    type: 'tool_call',
    data: {
      call_id: toolCallId,
      name: pending.name,
      args: pending.args,
      status: 'queued',
    },
  });
}

function locallyCancelTool(state: TuiState, toolCallId: string): TuiState {
  const materialized = materializeReplayTool(state, toolCallId);
  const name = visibleToolName(materialized, toolCallId);
  if (!name) return withoutPendingTool(materialized, toolCallId);
  const card = materialized.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.kind === 'tool_card' && block.callId === toolCallId);
  // Plan review already materializes the plan document as a completed card;
  // the local recovery overlay must not replace that durable draft.
  if (
    card?.kind === 'tool_card' &&
    card.status === 'done' &&
    (card.name === 'write_plan' || card.name === 'update_plan')
  ) {
    return withoutPendingTool(materialized, toolCallId);
  }
  return withoutPendingTool(
    handleEventAction(materialized, {
      type: 'tool_done',
      data: {
        call_id: toolCallId,
        name,
        ok: false,
        summary: TUI_REPLAY_CANCELLED_TEXT,
        status: 'cancelled',
      },
    }),
    toolCallId,
  );
}

function locallyResolveQuestion(state: TuiState, blockId: number): TuiState {
  const block = findBlockById(state, blockId);
  if (block?.kind !== 'question') return state;
  return replaceBlockById(state, block.id, {
    ...block,
    resolved: TUI_REPLAY_CANCELLED_TEXT,
  });
}

/**
 * An invocation intent is the side-effect boundary. A tool with an unfinished
 * intent can no longer be projected as a user cancellation: another Runtime
 * client will recover it as `unknown` and reconcile it before any retry.
 */
function uncertainCapabilityToolCalls(runtimeEvents: SessionData['runtimeEvents']): Set<string> {
  const invocationToolCalls = new Map<string, string>();
  const unsettled = new Set<string>();
  for (const event of runtimeEvents) {
    switch (event.type) {
      case 'capability.invocation_recorded':
        invocationToolCalls.set(event.invocationId, event.toolCallId);
        unsettled.add(event.invocationId);
        break;
      case 'capability.execution_succeeded':
      case 'capability.execution_failed':
      case 'capability.reconciliation_resolved':
        unsettled.delete(event.invocationId);
        break;
      case 'capability.execution_unknown':
        unsettled.add(event.invocationId);
        break;
      default:
        break;
    }
  }
  return new Set(
    [...unsettled]
      .map((invocationId) => invocationToolCalls.get(invocationId))
      .filter((toolCallId): toolCallId is string => toolCallId != null),
  );
}

function clearRecoveredInteractionUi(
  state: TuiState,
  options: { toolCallId?: string; clearPendingPlan: boolean },
): TuiState {
  const withoutTool = options.toolCallId ? withoutPendingTool(state, options.toolCallId) : state;
  return {
    ...withoutTool,
    interrupt: null,
    status: {
      ...withoutTool.status,
      pendingPlan: options.clearPendingPlan ? null : withoutTool.status.pendingPlan,
    },
    turns: withoutTool.turns.map((turn) => ({
      blocks: turn.blocks.map((block) =>
        block.kind === 'subagent' && block.status === 'suspended' && block.awaitingApproval
          ? {
              ...block,
              status: 'running' as const,
              awaitingApproval: false,
              approvingStepIndex: undefined,
            }
          : block,
      ),
    })),
  };
}

/**
 * Runtime replay is canonical and immutable. This pass is deliberately TUI
 * only: an interaction left open by a crashed process is projected as a
 * local cancellation so the TUI never renders a stale pending prompt. No
 * RuntimeEvent is created or written here.
 */
export function recoverPendingInteractionsForTui(
  state: TuiState,
  runtimeEvents: SessionData['runtimeEvents'],
): TuiState {
  const startedToolCalls = new Set(
    runtimeEvents.flatMap((event) => (event.type === 'tool.started' ? [event.toolCallId] : [])),
  );
  const uncertainToolCalls = uncertainCapabilityToolCalls(runtimeEvents);
  const completedAutoReviews = new Set(
    runtimeEvents.flatMap((event) =>
      event.type === 'auto_review.completed' &&
      (event.result.ok || event.result.failureType != null)
        ? [event.reviewId]
        : [],
    ),
  );
  const requestedAutoReviews = runtimeEvents.filter(
    (
      event,
    ): event is Extract<
      import('@/core/runtime/events').RuntimeEvent,
      { type: 'auto_review.requested' }
    > => event.type === 'auto_review.requested',
  );

  let next = state;
  for (const request of requestedAutoReviews) {
    if (
      completedAutoReviews.has(request.reviewId) ||
      startedToolCalls.has(request.toolCallId) ||
      uncertainToolCalls.has(request.toolCallId)
    ) {
      continue;
    }
    next = locallyCancelTool(next, request.toolCallId);
  }

  const pending = next.interrupt;
  if (pending) {
    const toolCallId =
      pending.kind === 'approval'
        ? (pending.toolCallId ?? pending.approval?.callId)
        : pending.kind === 'plan_review'
          ? pending.toolCallId
          : (() => {
              const block = findBlockById(next, pending.blockId);
              return block && 'toolCallId' in block ? block.toolCallId : undefined;
            })();

    const executionOutcomeUnknown =
      toolCallId != null &&
      (startedToolCalls.has(toolCallId) || uncertainToolCalls.has(toolCallId));
    // A started call or durable invocation intent crossed the side-effect
    // boundary. Do not manufacture a cancelled result; that outcome remains
    // unknown and belongs to Runtime reconciliation.
    if (toolCallId && !executionOutcomeUnknown) next = locallyCancelTool(next, toolCallId);
    if (pending.kind === 'input') next = locallyResolveQuestion(next, pending.blockId);
    next = clearRecoveredInteractionUi(next, {
      toolCallId,
      clearPendingPlan: pending.kind === 'plan_review',
    });
  }
  return next;
}

/** Replay is intentionally RuntimeEvent-only.  Graph checkpoint messages are
 * not a supported recovery format after the Kernel cutover. */
export function sessionDataToUI(data: SessionData): {
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
  interactionMode: import('./types.js').TuiState['interactionMode'];
  pendingToolCalls: import('./types.js').TuiState['pendingToolCalls'];
  /** The TUI hid a canonical pending interaction and must fork before new work. */
  recoveredPendingInteraction: boolean;
} {
  const runtimeEvents = data.runtimeEvents.map(decodeHistoricalToolOutcomeEventV1);
  let state = createInitialState();
  for (const event of runtimeEvents) state = handleRuntimeEventAction(state, event);
  if (!state.interrupt && data.interrupt) {
    const callIds = new Map(
      state.turns.flatMap((turn) =>
        turn.blocks.flatMap((block) =>
          'callId' in block && block.callId ? [[block.callId, block.id] as const] : [],
        ),
      ),
    );
    state = {
      ...state,
      interrupt:
        data.interrupt.kind === 'approval'
          ? {
              kind: 'approval',
              approval: data.interrupt.callId
                ? ({
                    callId: data.interrupt.callId,
                  } as unknown as import('@/protocol/events').ToolApprovalPayload)
                : undefined,
              blockId: callIds.get(data.interrupt.callId ?? ''),
            }
          : data.interrupt.kind === 'input'
            ? { kind: 'input', blockId: callIds.get(data.interrupt.callId ?? '') ?? 0 }
            : {
                kind: 'plan_review',
                plan: data.interrupt.plan,
                ...(data.interrupt.artifact ? { artifact: data.interrupt.artifact } : {}),
              },
    };
  }
  const unfinishedAutoReview = runtimeEvents.some((event) => {
    if (event.type !== 'auto_review.requested') return false;
    const completed = runtimeEvents.find(
      (candidate): candidate is Extract<RuntimeEvent, { type: 'auto_review.completed' }> =>
        candidate.type === 'auto_review.completed' && candidate.reviewId === event.reviewId,
    );
    // Pre-classification records cannot distinguish an explicit deny from a
    // provider failure. Treat an old `ok:false` result conservatively: it is
    // not permission to reject or execute, and must not leave a hidden pending
    // auto-review behind in this TUI replay.
    return !completed || (!completed.result.ok && !completed.result.failureType);
  });
  // RuntimeState is authoritative for whether an interaction is still pending.
  // A historical approval.requested may be followed directly by tool.started
  // (for example after an already-persisted grant) without a separate
  // approval.granted event in the replay slice. Its UI projection can remain
  // stale, but it must not create another recovery fork of an otherwise
  // completed session.
  const recoveredPendingInteraction = data.interrupt != null || unfinishedAutoReview;
  state = recoverPendingInteractionsForTui(state, runtimeEvents);
  // Replay uses the same event reducer as the live stream, with only the
  // explicit local recovery projection above for process-crash interactions.
  const blocks = state.turns.flatMap((turn) => turn.blocks);
  const interrupt: InterruptState | null = state.interrupt;
  return {
    blocks,
    interrupt,
    interactionMode: state.interactionMode,
    pendingToolCalls: state.pendingToolCalls,
    recoveredPendingInteraction,
  };
}
