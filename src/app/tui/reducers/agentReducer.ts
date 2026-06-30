// ── Agent 生命周期（运行/空闲/退出）、中断、授权、Ctrl+C/Esc ──

import type { OutputBlock, TuiState } from '../types';
import type { Action } from './actions';
import { buildToolSummaryLine } from './consolidateTools';
import {
  appendBlock,
  finalizeLastTurnStreaming,
  findBlock,
  findBlockById,
  lastTurn,
  mergeConsecutiveTextBlocksInLastTurn,
  replaceBlockById,
} from './helpers';

/** 将最后 turn 中所有 running 状态的 subagent/tool_card/tool_summary 标记为 cancelled。
 *  Esc 取消后 running→false，所有 block 移入 Static 冻结。必须在 render
 *  之前同步收尾，否则 spinner 状态被写入 scrollback 后永远不可恢复。
 *  Mark all running subagent/tool_card/tool_summary blocks in the last turn as cancelled
 *  before running flips to false, so they don't get frozen into Static. */
function cancelRunningBlocks(s: TuiState): TuiState {
  const last = lastTurn(s);
  if (!last) return s;
  const now = Date.now();
  let changed = false;
  const blocks = last.blocks.map((b) => {
    if (b.kind === 'subagent' && b.status === 'running') {
      changed = true;
      return {
        ...b,
        status: 'cancelled' as const,
        summary: 'Cancelled',
        error: 'Cancelled',
        toolCallCount: b.steps.length,
        durationMs: s.runStartTime ? now - s.runStartTime : 0,
        expanded: false,
      };
    }
    if (b.kind === 'tool_card' && b.status === 'running') {
      changed = true;
      return { ...b, status: 'cancelled' as const, summary: 'Cancelled' };
    }
    if (b.kind === 'tool_summary') {
      const tools = b.tools.map((t) =>
        t.status === 'running' ? { ...t, status: 'cancelled' as const, summary: 'Cancelled' } : t,
      );
      if (tools.some((t, i) => t.status !== b.tools[i]!.status) || b.active) {
        changed = true;
        return {
          ...b,
          tools,
          summaryLine: buildToolSummaryLine(tools),
          active: false,
          latestActivity: undefined,
          totalElapsedMs: now - b.createdAt,
        };
      }
    }
    return b;
  });
  if (!changed) return s;
  const turns = s.turns.slice();
  turns[turns.length - 1] = { blocks };
  return { ...s, turns, currentThoughtSummaryId: undefined };
}

function settleActiveThought(s: TuiState): TuiState {
  if (s.currentThoughtSummaryId == null) return s;
  const now = Date.now();
  let changed = false;
  const turns = s.turns.map((turn) => ({
    blocks: turn.blocks.flatMap((block) => {
      if (block.kind !== 'tool_summary' || block.id !== s.currentThoughtSummaryId) return [block];
      changed = true;
      if (block.tools.length === 0) return [];
      return [
        {
          ...block,
          active: false,
          latestActivity: undefined,
          totalElapsedMs: now - block.createdAt,
        },
      ];
    }),
  }));
  return changed ? { ...s, turns, currentThoughtSummaryId: undefined } : s;
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
    (blk) => blk.kind === 'tool_card' && blk.name === 'ask_user' && blk.status === 'running',
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
    // plan_review 没有 blockId，仅清除 interrupt / plan_review has no blockId, just clear interrupt
    if (s.interrupt.kind === 'plan_review') {
      const planCard = findBlock(next, (b) => b.kind === 'tool_card' && b.name === 'update_plan');
      if (planCard?.kind === 'tool_card') {
        next = replaceBlockById(next, planCard.id, {
          ...planCard,
          status: 'done' as const,
          expanded: true,
        });
      }
      const block: OutputBlock = {
        id: next.nextBlockId,
        kind: 'text',
        content: '── Plan declined ──',
      };
      return {
        ...appendBlock(settleActiveThought(next), block),
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
  return {
    ...settleActiveThought(next),
    running: false,
    ctrlCPressed: setCtrlCPressed,
    interrupt: null,
  };
}

export function agentReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
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
        currentRunReasonId: undefined,
        status: { ...s.status, currentNode: null, plan: null, retryState: null },
      };
    }
    case 'SET_EXITED': {
      const s = finalizeLastTurnStreaming(settleActiveThought(state));
      const merged = mergeConsecutiveTextBlocksInLastTurn(s);
      const elapsedSec = merged.runStartTime
        ? Math.round((Date.now() - merged.runStartTime) / 1000)
        : 0;
      const elapsedStr =
        elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
      let changeCount = 0;
      for (const turn of merged.turns) {
        for (const b of turn.blocks) {
          if (b.kind === 'file_change')
            changeCount += (b as Extract<OutputBlock, { kind: 'file_change' }>).changes.length;
        }
      }
      const summary = [elapsedStr, changeCount > 0 ? `${changeCount} files` : null]
        .filter(Boolean)
        .join(' · ');
      const block: OutputBlock = {
        id: merged.nextBlockId,
        kind: 'text',
        content: `── ${summary} ──`,
      };
      const appended = appendBlock(merged, block);
      return {
        ...appended,
        running: false,
        exited: true,
        interrupt: null,
        status: { ...appended.status, currentNode: null, plan: null },
      };
    }
    case 'RESOLVE_INTERRUPT': {
      const b = findBlockById(state, action.blockId);
      if (!b || (b.kind !== 'approval' && b.kind !== 'question')) {
        return state;
      }
      let resolved: OutputBlock;
      if (b.kind === 'approval') {
        const r =
          typeof action.resolution === 'string' ? { action: action.resolution } : action.resolution;
        resolved = { ...b, resolved: r };
      } else {
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
      }
      // 重置工具启动时间戳，排除审批等待耗时 / Reset tool start timestamps to exclude approval wait time
      const now = Date.now();
      const nextTimes: Record<string, number> = {};
      if (state.toolStartTimes) {
        for (const k of Object.keys(state.toolStartTimes)) nextTimes[k] = now;
      }
      // 同步更新 block 上的 startedAt，排除审批等待耗时 / Sync startedAt on blocks to exclude approval wait
      const withResolved = replaceBlockById(state, action.blockId, resolved);
      const updatedTurns = withResolved.turns.map((turn) => {
        let changed = false;
        const blocks = turn.blocks.map((blk) => {
          if ((blk.kind === 'tool_card' || blk.kind === 'subagent') && blk.status === 'running') {
            changed = true;
            return { ...blk, startedAt: now };
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
      const approved = r.action === 'approved_auto' || r.action === 'approved_manual';
      return {
        ...state,
        interrupt: null,
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
      // 审批/提问中 → 只取消中断，继续会话 / Interrupt active → cancel interrupt only
      if (state.interrupt) {
        // plan_review Esc → 只取消审查中断，不停止会话；graph 继续处理 rejection 落盘 checkpoint
        // plan_review Esc → cancel review only, keep session alive so graph persists rejection to checkpoint
        if (state.interrupt.kind === 'plan_review') {
          const s = cancelRunningBlocks(state);
          const finalized = finalizeLastTurnStreaming(s);
          // card 已被 need_plan_review 设为 done；工具执行成功，仅用户拒绝，保持 done
          // card already set to done by need_plan_review; tool succeeded, user just declined, keep done
          const planCard = findBlock(
            finalized,
            (b) => b.kind === 'tool_card' && b.name === 'update_plan',
          );
          let next = finalized;
          if (planCard?.kind === 'tool_card') {
            next = replaceBlockById(next, planCard.id, {
              ...planCard,
              status: 'done' as const,
              expanded: true,
            });
          }
          const block: OutputBlock = {
            id: next.nextBlockId,
            kind: 'text',
            content: '── Plan declined ──',
          };
          return { ...appendBlock(next, block), interrupt: null };
        }
        if (!state.interrupt.blockId) return state;
        const b = findBlockById(state, state.interrupt.blockId);
        if (b) {
          if (b.kind === 'approval') {
            return {
              ...replaceBlockById(state, b.id, { ...b, resolved: { action: 'cancelled' } }),
              interrupt: null,
            };
          } else if (b.kind === 'question') {
            return { ...cancelAskUserToolCard(state, b.id), interrupt: null };
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
