// ── Agent 生命周期（运行/空闲/退出）、中断、授权、Ctrl+C/Esc ──

import { InteractionMode } from '@/protocol/events';
import { getToolDetail } from '../components/render-utils';
import type { OutputBlock, TuiState } from '../types';
import type { Action } from './actions';
import { buildToolSummaryLine } from './consolidateTools';
import {
  appendBlock,
  finalizeLastTurnStreaming,
  findBlock,
  findBlockById,
  lastTurn,
  replaceBlockById,
} from './helpers';

/** 将最后 turn 中所有 queued/running 状态的 subagent/tool_card/tool_summary 标记为 cancelled。
 *  Esc 取消后 running→false，所有 block 移入 Static 冻结。必须在 render
 *  之前同步收尾，否则 spinner 状态被写入 scrollback 后永远不可恢复。
 *  Mark all queued/running subagent/tool_card/tool_summary blocks in the last turn as cancelled
 *  before running flips to false, so they don't get frozen into Static. */
export function cancelRunningBlocks(s: TuiState): TuiState {
  const last = lastTurn(s);
  if (!last) return s;
  const now = Date.now();
  let changed = false;
  let nextBlockId = s.nextBlockId;
  const blocks = last.blocks.flatMap((b): OutputBlock[] => {
    if (b.kind === 'subagent' && b.status === 'running') {
      changed = true;
      return [
        {
          ...b,
          status: 'cancelled' as const,
          summary: 'Cancelled',
          error: 'Cancelled',
          toolCallCount: b.steps.length,
          durationMs: s.runStartTime ? now - s.runStartTime : 0,
          expanded: false,
        },
      ];
    }
    if (b.kind === 'tool_card' && (b.status === 'queued' || b.status === 'running')) {
      changed = true;
      return [
        {
          ...b,
          status: 'cancelled' as const,
          summary: 'Cancelled',
          detail: b.detail ?? getToolDetail(b.name, b.args),
        },
      ];
    }
    if (b.kind === 'tool_summary') {
      // Queued exploration calls never started, so they must not become
      // completed-looking "read N files" statistics when the run is cancelled.
      const tools = b.tools.flatMap((t) => {
        if (t.status === 'queued') return [];
        return [
          t.status === 'running' ? { ...t, status: 'cancelled' as const, summary: 'Cancelled' } : t,
        ];
      });
      const removedQueuedTools = tools.length !== b.tools.length;
      if (
        removedQueuedTools ||
        tools.some((t, i) => t.status !== b.tools[i]!.status) ||
        b.active ||
        b.pendingCaption
      ) {
        changed = true;
        if (tools.length === 0 && b.hasThinking !== true) {
          const narration = [
            ...(b.captions ?? []),
            ...(b.pendingCaption ? [b.pendingCaption] : []),
          ].join('\n\n');
          return narration ? [{ id: b.id, kind: 'text' as const, content: narration }] : [];
        }
        // 取消/中断 settle 时按工具状态重算 result（阶段块可能横跨多轮工具，
        // 残留的旧 result 会误导结算状态）。规则 15。
        // Recompute result from tool states at cancel/interrupt settle (rule 15).
        const hasError = tools.some(
          (t) => t.status === 'error' || t.status === 'timeout' || t.status === 'exhausted',
        );
        const anyCancelled = tools.some(
          (t) => t.status === 'cancelled' || t.status === 'queued' || t.status === 'running',
        );
        const result = hasError
          ? ('error' as const)
          : anyCancelled
            ? ('cancelled' as const)
            : ('done' as const);
        const settled: OutputBlock = {
          ...b,
          tools,
          summaryLine: buildToolSummaryLine(tools),
          active: false,
          latestActivity: undefined,
          totalElapsedMs: b.modelMs ?? now - b.createdAt,
          pendingCaption: undefined,
          result,
        };
        // ADR-0030 / 规则 24：取消/中断时未确认旁白脱离为独立文本块
        // Unconfirmed captions detach on cancel/interrupt too
        if (b.pendingCaption != null) {
          return [settled, { id: nextBlockId++, kind: 'text' as const, content: b.pendingCaption }];
        }
        return [settled];
      }
    }
    return [b];
  });
  if (!changed) return s;
  const turns = s.turns.slice();
  turns[turns.length - 1] = { blocks };
  return {
    ...s,
    turns,
    nextBlockId,
    currentThoughtSummaryId: undefined,
    thoughtPhaseStatus: undefined,
  };
}

function settleActiveThought(s: TuiState): TuiState {
  if (s.currentThoughtSummaryId == null) return s;
  const now = Date.now();
  let changed = false;
  let nextBlockId = s.nextBlockId;
  const turns = s.turns.map((turn) => ({
    blocks: turn.blocks.flatMap((block): OutputBlock[] => {
      if (block.kind !== 'tool_summary' || block.id !== s.currentThoughtSummaryId) return [block];
      changed = true;
      // 纯思考块（无工具）同样保留并 settle，与 closeCurrentThought 行为一致
      // Pure-thinking blocks are kept and settled, consistent with closeCurrentThought
      const hasError = block.tools.some(
        (t) => t.status === 'error' || t.status === 'timeout' || t.status === 'exhausted',
      );
      const anyUnsettled = block.tools.some(
        (t) => t.status === 'cancelled' || t.status === 'queued' || t.status === 'running',
      );
      const result = hasError
        ? ('error' as const)
        : anyUnsettled
          ? ('cancelled' as const)
          : ('done' as const);
      const settled: OutputBlock = {
        ...block,
        active: false,
        latestActivity: undefined,
        totalElapsedMs: block.modelMs ?? now - block.createdAt,
        pendingCaption: undefined,
        result,
      };
      // ADR-0030 / 规则 24：轮次边界 settle 时未确认旁白脱离为独立文本块
      // （final 事件通常已先一步脱离；这里是中断/异常收尾的安全网）
      // Unconfirmed captions detach at turn-boundary settle (final normally
      // detaches first; this is the safety net for interrupts/error paths).
      if (block.pendingCaption != null) {
        return [
          settled,
          { id: nextBlockId++, kind: 'text' as const, content: block.pendingCaption },
        ];
      }
      return [settled];
    }),
  }));
  return changed
    ? {
        ...s,
        turns,
        nextBlockId,
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
      }
    : s;
}

/** 取消 ask_user 问题块时同步更新关联的 tool_card 为 Cancelled
 *  When cancelling an ask_user question block, also update its tool_card. */
function cancelAskUserToolCard(s: TuiState, questionBlockId: number): TuiState {
  let next = replaceBlockById(s, questionBlockId, {
    ...findBlockById(s, questionBlockId)!,
    resolved: 'cancelled',
  } as OutputBlock);
  const toolCard = findBlock(
    next,
    (blk) =>
      blk.kind === 'tool_card' &&
      blk.name === 'ask_user' &&
      (blk.status === 'queued' || blk.status === 'running'),
  );
  if (toolCard?.kind === 'tool_card') {
    next = replaceBlockById(next, toolCard.id, {
      ...toolCard,
      status: 'done' as const,
      summary: 'Cancelled',
      expanded: true,
    });
  }
  return next;
}

/** Shared helper: cancel a running interrupt during Ctrl+C or Escape */
function cancelInterrupt(s: TuiState, setCtrlCPressed: boolean): TuiState {
  let next = finalizeLastTurnStreaming(s);
  if (s.interrupt) {
    // The reviewed plan card already contains the persisted draft. Runtime
    // cancellation events settle the turn; do not add a local-only banner.
    if (s.interrupt.kind === 'plan_review') {
      return {
        ...settleActiveThought(next),
        running: false,
        ctrlCPressed: setCtrlCPressed,
        interrupt: null,
      };
    }
    if (s.interrupt.blockId) {
      const b = findBlockById(next, s.interrupt.blockId);
      if (b) {
        if (b.kind === 'approval') {
          next = replaceBlockById(next, b.id, { ...b, resolved: { action: 'cancelled' } });
        } else if (b.kind === 'question') {
          next = cancelAskUserToolCard(next, b.id);
        }
      }
    }
  }
  // 清除子 agent 的 awaitingApproval / Clear sub-agent awaiting state on cancel
  const clearedTurns = next.turns.map((turn) => {
    let changed = false;
    const blocks = turn.blocks.map((blk) => {
      if (blk.kind === 'subagent' && blk.status === 'running') {
        changed = true;
        return { ...blk, awaitingApproval: false };
      }
      return blk;
    });
    return changed ? { blocks } : turn;
  });
  next = { ...next, turns: clearedTurns };
  return {
    ...settleActiveThought(next),
    running: false,
    ctrlCPressed: setCtrlCPressed,
    interrupt: null,
  };
}

export function agentReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case 'SET_COMPACTION_PROGRESS':
      return {
        ...state,
        compactionProgress: action.phase
          ? { phase: action.phase, placement: action.placement ?? 'status' }
          : undefined,
        status: {
          ...state.status,
          currentNode: action.phase ? `context_${action.phase}` : null,
        },
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
        running: true,
        exited: false,
        interrupt: null,
        toolStartTimes: undefined,
        runCount: state.runCount + 1,
        runStartTime: Date.now(),
        runTokenBaseline: state.status.totalTokens,
        currentRunReasonId: undefined,
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
        currentModelRequestId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
        explorationSummaryIds: {},
        pendingToolCalls: {},
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        status: { ...state.status, currentNode: null, plan: null, retryState: null },
      };
    case 'SET_IDLE': {
      const s = settleActiveThought(cancelRunningBlocks(state));
      return {
        ...finalizeLastTurnStreaming(s),
        running: false,
        exited: false,
        interrupt: null,
        toolStartTimes: undefined,
        pendingToolCalls: {},
        currentRunReasonId: undefined,
        status: { ...s.status, currentNode: null, plan: null, retryState: null },
      };
    }
    case 'SET_EXITED': {
      const settled = finalizeLastTurnStreaming(settleActiveThought(state));
      return {
        ...settled,
        running: false,
        exited: true,
        interrupt: null,
        status: { ...settled.status, currentNode: null, plan: null },
      };
    }
    case 'RESOLVE_INTERRUPT': {
      const b = action.blockId == null ? undefined : findBlockById(state, action.blockId);
      if (state.interrupt?.kind === 'approval') {
        let withResolved = state;
        if (b?.kind === 'approval') {
          const resolution =
            typeof action.resolution === 'string'
              ? { action: action.resolution }
              : action.resolution;
          withResolved = replaceBlockById(state, b.id, { ...b, resolved: resolution });
        }
        const approvedSubagentId = state.interrupt.approval?.subagentId;
        const now = approvedSubagentId ? Date.now() : undefined;
        const updatedTurns = withResolved.turns.map((turn) => {
          let changed = false;
          const blocks = turn.blocks.map((block) => {
            if (
              block.kind === 'subagent' &&
              block.status === 'running' &&
              block.subagentId === approvedSubagentId
            ) {
              changed = true;
              return {
                ...block,
                ...(now != null ? { startedAt: now } : {}),
                awaitingApproval: false,
              };
            }
            return block;
          });
          return changed ? { blocks } : turn;
        });
        return {
          ...withResolved,
          turns: updatedTurns,
          interrupt: null,
        };
      }
      if (b?.kind !== 'question') return state;

      let resolved: OutputBlock;
      if (typeof action.resolution === 'string') {
        resolved = { ...b, resolved: action.resolution };
      } else {
        // 多问题模式：resolved 带 answers / Multi-question: resolved with answers
        const r = action.resolution as unknown as {
          action?: string;
          text?: string;
          answers?: Record<string, string>;
        };
        const text = r.text ?? r.action ?? '';
        resolved = { ...b, resolved: r.answers ? { text, answers: r.answers } : text };
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
      const newMode =
        action.mode === 'toggle'
          ? state.status.authorization === 'full_access'
            ? 'default'
            : 'full_access'
          : action.mode;
      return {
        ...state,
        status: { ...state.status, authorization: newMode as 'default' | 'full_access' },
      };
    }
    case 'EXPORT_SESSION':
      return state;
    case 'EXPORT_SESSION_DONE': {
      const block: OutputBlock = {
        id: state.nextBlockId,
        kind: 'text',
        content: `✓ Session exported to ${action.filename}`,
      };
      return appendBlock(state, block);
    }
    case 'INJECT_MCP_PROMPT': {
      const block: OutputBlock = {
        id: state.nextBlockId,
        kind: 'user',
        content: `/mcp__${action.server}__${action.promptName}`,
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
      const auth = next === InteractionMode.Full ? 'full_access' : 'default';
      return {
        ...state,
        interactionMode: next,
        status: { ...state.status, authorization: auth as 'default' | 'full_access' },
      };
    }
    case 'TOGGLE_PLAN_MODE': {
      const nextPhase = state.status.phase === 'planning' ? 'building' : 'planning';
      const nextAuth = nextPhase === 'planning' ? 'default' : state.status.authorization;
      return {
        ...state,
        status: {
          ...state.status,
          phase: nextPhase,
          authorization: nextAuth as 'default' | 'full_access',
        },
      };
    }

    case 'CTRL_C': {
      if (state.running) return cancelInterrupt(state, true);
      if (state.ctrlCPressed) return { ...state, exitRequested: true };
      return { ...state, ctrlCPressed: true };
    }
    case 'RESET_CTRL_C':
      return state.ctrlCPressed ? { ...state, ctrlCPressed: false } : state;
    case 'ESCAPE': {
      // Locally clear the interaction first. The provider then submits a
      // durable cancel action. Tool approval and plan review cancellation come
      // back as turn.aborted; ask_user keeps its per-interaction semantics.
      if (state.interrupt) {
        if (state.interrupt.kind === 'plan_review') {
          return { ...finalizeLastTurnStreaming(state), interrupt: null };
        }
        if (!state.interrupt.blockId) {
          const turns = state.turns.map((turn) => ({
            blocks: turn.blocks.map((block) =>
              block.kind === 'subagent' && block.status === 'running'
                ? { ...block, awaitingApproval: false }
                : block,
            ),
          }));
          return { ...state, turns, interrupt: null };
        }
        const b = findBlockById(state, state.interrupt.blockId);
        if (b) {
          if (b.kind === 'approval') {
            const withResolved = replaceBlockById(state, b.id, {
              ...b,
              resolved: { action: 'cancelled' },
            });
            // 清除子 agent 的 waiting 状态 / Clear sub-agent awaiting state on Escape
            const updatedTurns = withResolved.turns.map((turn) => {
              let changed = false;
              const blocks = turn.blocks.map((blk) => {
                if (blk.kind === 'subagent' && blk.status === 'running') {
                  changed = true;
                  return { ...blk, awaitingApproval: false };
                }
                return blk;
              });
              return changed ? { blocks } : turn;
            });
            return { ...withResolved, turns: updatedTurns, interrupt: null };
          } else if (b.kind === 'question') {
            const finalized = finalizeLastTurnStreaming(state);
            return { ...cancelAskUserToolCard(finalized, b.id), interrupt: null };
          }
        }
        return { ...state, interrupt: null };
      }
      // 非审批（思考/回复中）→ 停止本轮会话 / Agent running → stop this session
      if (state.running) {
        const s = cancelRunningBlocks(state);
        return { ...finalizeLastTurnStreaming(s), running: false, exited: false };
      }
      return state;
    }
    default:
      return null;
  }
}
