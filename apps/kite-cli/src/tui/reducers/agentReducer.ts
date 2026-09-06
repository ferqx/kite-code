// ── Agent 生命周期（运行/空闲/退出）、中断、授权、Ctrl+C/Esc ──

import { InteractionMode } from '@kite-ai/runtime-contract';
import { isTuiRunActive } from '../presentation/selectors';
import type { OutputBlock, TuiApprovalStatus, TuiPendingApproval, TuiState } from '../types';
import type { Action } from './actions';
import { projectPresentationBoundary } from './handleClientEvent';
import { appendBlock, findBlockById, replaceBlockById } from './helpers';

function focusableApproval(status: TuiApprovalStatus): boolean {
  return (
    status === 'queued_auto' ||
    status === 'auto_reviewing' ||
    status === 'queued_user' ||
    status === 'awaiting_user'
  );
}

function advanceApprovalQueue(
  state: TuiState,
  interactionId: string | undefined,
  grant?: 'approve_once' | 'same_command',
): TuiState {
  if (!state.pendingApprovals || interactionId == null) return state;
  const queue = new Map(state.pendingApprovals);
  const pending = queue.get(interactionId);
  if (!pending) return { ...state, interrupt: null, activeApprovalId: null };
  queue.set(interactionId, {
    ...pending,
    status: 'approving',
    ...(grant ? { grant } : {}),
  });
  let next: TuiPendingApproval | undefined;
  for (const candidate of queue.values()) {
    if (!focusableApproval(candidate.status)) continue;
    if (
      next === undefined ||
      candidate.sequence < next.sequence ||
      (candidate.sequence === next.sequence &&
        candidate.interactionId.localeCompare(next.interactionId) < 0)
    ) {
      next = candidate;
    }
  }
  return {
    ...state,
    pendingApprovals: queue,
    activeApprovalId: next?.interactionId ?? null,
    interrupt: next?.clientInteraction
      ? {
          kind: 'approval',
          interactionId: next.interactionId,
          toolCallId: next.toolCallId,
        }
      : null,
  };
}

export function agentReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case 'RECONCILE_RUNTIME_PROJECTION': {
      const serverActive =
        action.projection.currentRun?.status === 'queued' ||
        action.projection.currentRun?.status === 'running' ||
        action.projection.currentRun?.status === 'waiting' ||
        action.projection.currentRun?.status === 'recovery_required';
      if (serverActive) {
        return {
          ...state,
          presentationMode: 'live',
          runtimeAuthority: action.projection,
          exited: false,
        };
      }
      if (!isTuiRunActive(state) && state.interrupt == null && !state.cancelRequestedRunId) {
        return { ...state, presentationMode: 'live', runtimeAuthority: action.projection };
      }
      const settled = projectPresentationBoundary(state);
      return {
        ...settled,
        presentationMode: 'live',
        runtimeAuthority: action.projection,
        cancelRequestedRunId: undefined,
        exited: false,
        interrupt: null,
        activeApprovalId: null,
        pendingApprovals: new Map(),
        toolStartTimes: undefined,
        pendingToolCalls: {},
        presentationGroupSummaryIds: {},
        currentRunReasonId: undefined,
        runStartTime: undefined,
        status: { ...settled.status, currentNode: null, plan: null, retryState: null },
      };
    }
    case 'SET_COMPACTION_PROGRESS':
      return {
        ...state,
        compactionProgress: action.phase
          ? { phase: action.phase, source: action.source }
          : undefined,
      };
    case 'SET_CONTEXT_SNAPSHOT':
      return {
        ...state,
        status: {
          ...state.status,
          contextSnapshot: action.snapshot,
        },
      };
    case 'SET_RUNNING':
      return {
        ...state,
        presentationMode: 'live',
        cancelRequestedRunId: undefined,
        runPromptPresented: false,
        exited: false,
        interrupt: null,
        toolStartTimes: undefined,
        runCount: state.runCount + 1,
        runStartTime: Date.now(),
        runTokenBaseline: state.status.totalTokens,
        currentRunReasonId: undefined,
        currentThoughtSummaryId: undefined,
        currentModelRequestId: undefined,
        currentModelTextStreamed: undefined,
        currentModelTextSource: undefined,
        toolBearingModelRequestId: undefined,
        toolBearingPresentationGroupId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
        currentModelReasoningRequestId: undefined,
        settledModelRequestIds: new Set(),
        explorationSummaryIds: {},
        presentationGroupSummaryIds: {},
        pendingToolCalls: {},
        pendingSubagentTerminals: new Map(),
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        status: { ...state.status, currentNode: null, plan: null, retryState: null },
      };
    case 'SET_EXITED': {
      const settled = projectPresentationBoundary(state);
      return {
        ...settled,
        presentationMode: 'live',
        cancelRequestedRunId: undefined,
        runStartTime: undefined,
        exited: true,
        interrupt: null,
        status: { ...settled.status, currentNode: null, plan: null },
      };
    }
    case 'RESOLVE_INTERRUPT': {
      const b = action.blockId == null ? undefined : findBlockById(state, action.blockId);
      const resolution =
        typeof action.resolution === 'string' ? { action: action.resolution } : action.resolution;
      const approvalInterrupt = state.interrupt?.kind === 'approval' ? state.interrupt : undefined;
      if (approvalInterrupt) {
        if (
          resolution.action === 'reject' ||
          resolution.action === 'denied' ||
          resolution.action === 'cancelled'
        ) {
          // Local rejection/cancellation has no durable identity on this
          // action. Leave the approval queue and card live until the Runtime
          // projects approval.rejected with its interactionId, generation,
          // and owner binding; otherwise a stale key press could settle a
          // different concurrent child.
          return state;
        }
        // Only an accepted approval is safe to project optimistically. A
        // rejection/cancellation must keep the interrupt identity until the
        // durable approval.rejected event terminalizes the affected turn.
        if (resolution.action !== 'approve' && resolution.action !== 'approved') return state;
        const queueAcknowledgement = advanceApprovalQueue(
          state,
          approvalInterrupt?.interactionId,
          resolution.grant === 'same_command' ? 'same_command' : 'approve_once',
        );
        let withResolved = queueAcknowledgement;
        if (b?.kind === 'approval') {
          withResolved = replaceBlockById(withResolved, b.id, {
            ...b,
            resolved: resolution,
            presentationState: 'sealed',
          });
        }
        // The local key acknowledgement may project only `approving` in the
        // durable queue. Child running/authorized state is derived exclusively
        // from approval.granted or approval.batch_released so live and replay
        // cannot diverge.
        return withResolved;
      }
      if (b?.kind !== 'question') return state;

      let resolved: OutputBlock;
      if (typeof action.resolution === 'string') {
        resolved = {
          ...b,
          resolved: action.resolution,
          presentationState: 'sealed',
        };
      } else {
        // 多问题模式：resolved 带 answers / Multi-question: resolved with answers
        const r = action.resolution as unknown as {
          action?: string;
          text?: string;
          answers?: Record<string, string>;
        };
        const text = r.text ?? r.action ?? '';
        resolved = {
          ...b,
          resolved: r.answers ? { text, answers: r.answers } : text,
          presentationState: 'sealed',
        };
      }
      const now = Date.now();
      const nextTimes: Record<string, number> = { ...(state.toolStartTimes ?? {}) };
      const withResolved = replaceBlockById(state, b.id, resolved);
      const userInput =
        typeof action.resolution === 'string'
          ? { answer: action.resolution }
          : {
              answer: action.resolution.text ?? action.resolution.action ?? '',
              ...(action.resolution.answers ? { answers: action.resolution.answers } : {}),
            };
      const activeAskUsers = withResolved.turns.flatMap((turn) =>
        turn.blocks.filter(
          (blk): blk is Extract<OutputBlock, { kind: 'tool_card' }> =>
            blk.kind === 'tool_card' &&
            blk.name === 'ask_user' &&
            (blk.status === 'queued' || blk.status === 'running'),
        ),
      );
      const activeAskUser = b.toolCallId
        ? activeAskUsers.find((blk) => blk.callId === b.toolCallId)
        : activeAskUsers.length === 1
          ? activeAskUsers[0]
          : undefined;
      if (activeAskUser) nextTimes[activeAskUser.callId] = now;
      const updatedTurns = withResolved.turns.map((turn) => {
        let changed = false;
        const blocks = turn.blocks.map((blk) => {
          if (blk.kind === 'tool_card' && blk.id === activeAskUser?.id) {
            changed = true;
            const question = typeof blk.args.question === 'string' ? blk.args.question : '';
            const detail = question
              ? question.length > 60
                ? `${question.slice(0, 57)}...`
                : question
              : 'Asked';
            return {
              ...blk,
              startedAt: now,
              summary: userInput?.answer ?? '',
              status: 'done' as const,
              expanded: true,
              detail,
              userInput,
            };
          }
          return blk;
        });
        return changed ? { blocks } : turn;
      });
      return {
        ...withResolved,
        turns: updatedTurns,
        interrupt: null,
        toolStartTimes: nextTimes,
      };
    }
    case 'RESOLVE_PLAN_REVIEW': {
      const r = action.resolution;
      const approved = r.action === 'approved_auto' || r.action === 'approved_accept_edits';
      const nextInteractionMode =
        r.action === 'approved_auto'
          ? InteractionMode.Auto
          : r.action === 'approved_accept_edits'
            ? InteractionMode.AcceptEdits
            : state.interactionMode;
      return {
        ...state,
        interrupt: null,
        interactionMode: nextInteractionMode,
        status: {
          ...state.status,
          plan: approved ? state.status.pendingPlan : state.status.plan,
          pendingPlan: null,
        },
      };
    }
    case 'SWITCH_AUTH': {
      // Authorization grants are durable Runtime approvals.  The TUI only
      // owns the orthogonal interaction mode; this legacy action is retained
      // for slash-command compatibility and must not recreate a grant mode.
      return state;
    }
    case 'EXPORT_SESSION':
      return state;
    case 'EXPORT_SESSION_DONE': {
      const block: OutputBlock = {
        id: state.nextBlockId,
        kind: 'text',
        content: `✓ Session exported to ${action.filename}`,
        presentationState: 'sealed',
      };
      return appendBlock(state, block);
    }
    case 'INJECT_MCP_PROMPT': {
      const block: OutputBlock = {
        id: state.nextBlockId,
        kind: 'user',
        content: `/mcp__${action.server}__${action.promptName}`,
        presentationState: 'live',
      };
      return appendBlock(state, block);
    }
    case 'SET_PHASE':
      return { ...state, status: { ...state.status, phase: action.phase } };
    case 'SET_INTERACTION_MODE': {
      const next =
        action.mode === 'toggle'
          ? state.interactionMode === InteractionMode.AcceptEdits
            ? InteractionMode.Auto
            : state.interactionMode === InteractionMode.Auto
              ? InteractionMode.Full
              : InteractionMode.AcceptEdits
          : action.mode;
      return {
        ...state,
        interactionMode: next,
      };
    }
    case 'TOGGLE_PLAN_MODE': {
      const nextPhase = state.status.phase === 'planning' ? 'building' : 'planning';
      return {
        ...state,
        status: {
          ...state.status,
          phase: nextPhase,
        },
      };
    }

    case 'CTRL_C': {
      // The UI records this presentation receipt immediately before submitting
      // the Runtime command. Keep the pending interaction visible until its
      // durable terminal event is streamed back; clearing it locally would
      // re-open the prompt if the process exits between those two steps.
      if (state.ctrlCPressed) return { ...state, exitRequested: true };
      if (state.interrupt || isTuiRunActive(state)) {
        return {
          ...state,
          ctrlCPressed: true,
          cancelRequestedRunId: state.runtimeAuthority?.currentRun?.runId,
        };
      }
      return { ...state, ctrlCPressed: true };
    }
    case 'CANCEL_REQUEST_FAILED':
      return state.cancelRequestedRunId ? { ...state, cancelRequestedRunId: undefined } : state;
    case 'RESET_CTRL_C':
      return state.ctrlCPressed ? { ...state, ctrlCPressed: false } : state;
    case 'ESCAPE': {
      // App records this presentation action before submitting the Runtime
      // cancel command. Keep domain and lifecycle completion owned by the
      // authoritative terminal, but acknowledge the in-flight request now so
      // repeated keys do not look ignored.
      return isTuiRunActive(state) && !state.cancelRequestedRunId
        ? {
            ...state,
            cancelRequestedRunId: state.runtimeAuthority?.currentRun?.runId,
          }
        : state;
    }
    default:
      return null;
  }
}
