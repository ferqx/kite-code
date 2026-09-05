// ── 组合 reducer：按领域分发到子 reducer ──

import { advanceOutputBlockTimeline } from '../presentation/timeline';
import type { TuiState } from '../types';
import type { Action } from './actions';
import { agentReducer } from './agentReducer';
import { checkpointReducer } from './checkpointReducer';
import { handleClientEventAction, reconcileClientInteractionQueue } from './handleClientEvent';
import { appendLocalText, appendUserMessage, replaceBlockById } from './helpers';
import { sessionReducer } from './sessionReducer';
import { skillReducer } from './skillReducer';
import { uiReducer } from './uiReducer';

export type { Action } from './actions';

// ── Action → 子 reducer 映射表 ──
// 每个子 reducer 声明自己处理的 action 类型集合，避免链式穿透开销
const UI_ACTIONS: ReadonlySet<string> = new Set([
  'SHOW_HELP',
  'HIDE_HELP',
  'SHOW_MODEL_SELECTOR',
  'HIDE_MODEL_SELECTOR',
  'SHOW_PERMISSION_SELECTOR',
  'HIDE_PERMISSION_SELECTOR',
  'SHOW_EFFORT_SELECTOR',
  'HIDE_EFFORT_SELECTOR',
  'SHOW_THEME_SELECTOR',
  'HIDE_THEME_SELECTOR',
  'SHOW_LANGUAGE_SELECTOR',
  'HIDE_LANGUAGE_SELECTOR',
  'SHOW_SESSIONS',
  'HIDE_SESSIONS',
  'SHOW_MCP',
  'HIDE_MCP',
  'SHOW_REWIND',
  'HIDE_REWIND',
  'TOGGLE_REASON',
  'TOGGLE_ALL_REASON',
  'TOGGLE_TOOL_EXPAND',
  'TOGGLE_SUBAGENT_EXPAND',
  'CLEAR_OUTPUT',
]);

const SESSION_ACTIONS: ReadonlySet<string> = new Set([
  'NEW_SESSION',
  'LOAD_SESSION_PENDING',
  'LOAD_SESSION',
  'SWITCH_SESSION',
  'SET_SESSIONS',
  'SET_SESSION_SERVICE_UNAVAILABLE',
  'SESSION_INTERRUPT_PENDING',
  'DELETE_SESSION',
  'SELECT_MODEL',
  'LOCAL_COMMAND',
  'SET_THINKING_LEVEL',
]);

const CHECKPOINT_ACTIONS: ReadonlySet<string> = new Set(['EXECUTE_REWIND', 'SET_CHECKPOINTS']);

const SKILL_ACTIONS: ReadonlySet<string> = new Set(['SET_SKILL_MANIFESTS', 'LIST_SKILLS']);

// AGENT_ACTIONS：剩余所有非 Runtime presentation action（SET_RUNNING, SET_EXITED,
// RESOLVE_INTERRUPT, SWITCH_AUTH, EXPORT_SESSION,
// EXPORT_SESSION_DONE, INJECT_MCP_PROMPT,
// SET_PHASE, CTRL_C, ESCAPE）

function reduceEvent(state: TuiState, action: Action): TuiState {
  if (action.type === 'ACCEPT_PRESENTATION_ENVELOPE') {
    return handleClientEventAction(state, action.event);
  }
  if (action.type === 'RECONCILE_RUNTIME_PROJECTION') {
    const reconciled = reconcileClientInteractionQueue(state, action.projection.interactionQueue);
    return agentReducer(reconciled, action) ?? reconciled;
  }
  if (action.type === 'LOCAL_TEXT') {
    return appendLocalText(state, action.text, action.isError);
  }
  if (action.type === 'LOCAL_USER_PROMPT') {
    return {
      ...appendUserMessage(state, {
        id: state.nextBlockId,
        kind: 'user',
        content: action.text,
        presentationState: 'live',
        pendingEcho: true,
      }),
      // This is presentation-only acknowledgement that the idle prompt has
      // entered the submission path. Runtime events still own Run identity
      // and terminal settlement, but the Footer need not wait for a round trip.
      runPromptPresented: true,
    };
  }
  if (action.type === 'QUEUE_LOCAL_PROMPT') {
    return {
      ...state,
      queuedPrompts: [
        ...(state.queuedPrompts ?? []),
        { id: action.id, sessionId: action.sessionId, text: action.text },
      ],
    };
  }
  if (action.type === 'ACCEPT_QUEUED_PROMPT') {
    const stillQueued = (state.queuedPrompts ?? []).some(
      (prompt) => prompt.id === action.id && prompt.sessionId === action.sessionId,
    );
    const started = agentReducer(state, { type: 'SET_RUNNING' }) ?? state;
    const dequeued = {
      ...started,
      queuedPrompts: (started.queuedPrompts ?? []).filter((prompt) => prompt.id !== action.id),
    };
    if (!stillQueued) {
      // The durable user.message won delivery order over the accepted receipt.
      // Preserve that authoritative block instead of appending a late local echo.
      return { ...dequeued, runPromptPresented: true };
    }
    return appendUserMessage(dequeued, {
      id: dequeued.nextBlockId,
      kind: 'user',
      content: action.text,
      presentationState: 'live',
      messageId: action.messageId,
      pendingEcho: true,
    });
  }
  if (action.type === 'ACCEPT_LOCAL_PROMPT') {
    const pending = [...state.turns.flatMap((turn) => turn.blocks)]
      .reverse()
      .find(
        (block) =>
          block.kind === 'user' &&
          block.pendingEcho === true &&
          block.messageId === undefined &&
          block.content === action.text,
      );
    if (pending?.kind !== 'user') return state;
    return replaceBlockById(state, pending.id, { ...pending, messageId: action.messageId });
  }
  if (action.type === 'DEQUEUE_LOCAL_PROMPT') {
    return {
      ...state,
      queuedPrompts: (state.queuedPrompts ?? []).filter((prompt) => prompt.id !== action.id),
    };
  }
  if (action.type === 'DROP_LOCAL_USER_PROMPT') {
    const hadPendingPrompt = state.turns.some((turn) =>
      turn.blocks.some(
        (block) =>
          block.kind === 'user' && block.pendingEcho === true && block.content === action.text,
      ),
    );
    const turns = state.turns
      .map((turn) => ({
        blocks: turn.blocks.filter(
          (block) =>
            block.kind !== 'user' || block.pendingEcho !== true || block.content !== action.text,
        ),
      }))
      .filter((turn) => turn.blocks.length > 0);
    return hadPendingPrompt
      ? {
          ...state,
          turns,
          runPromptPresented: false,
          runStartTime: undefined,
          exited: true,
        }
      : { ...state, turns };
  }

  // ESCAPE 需要链式分发：uiReducer 关面板 → agentReducer 处理中断
  if (action.type === 'ESCAPE') {
    let next = uiReducer(state, action);
    if (next === null) next = state;
    return agentReducer(next, action) ?? next;
  }

  // Set 查找 O(1) 分发到对应子 reducer
  if (UI_ACTIONS.has(action.type)) return uiReducer(state, action) ?? state;
  if (SESSION_ACTIONS.has(action.type)) return sessionReducer(state, action) ?? state;
  if (CHECKPOINT_ACTIONS.has(action.type)) return checkpointReducer(state, action) ?? state;
  if (SKILL_ACTIONS.has(action.type)) return skillReducer(state, action) ?? state;
  return agentReducer(state, action) ?? state;
}

/**
 * All presentation actions converge through one reducer-owned Timeline.
 * OutputBlock remains a one-way render model adapter, while a previously
 * sealed Timeline item can never be reopened or replaced by a late packet.
 */
export function eventReducer(state: TuiState, action: Action): TuiState {
  const next = reduceEvent(state, action);
  const resetTimeline =
    action.type === 'CLEAR_OUTPUT' ||
    next.sessionKey !== state.sessionKey ||
    next.activeSessionId !== state.activeSessionId;
  if (!resetTimeline && next.turns === state.turns && state.presentationTimeline) return next;

  const previous = resetTimeline ? undefined : state.presentationTimeline;
  const renderEpoch = resetTimeline
    ? (state.presentationTimeline?.renderEpoch ?? 0) + 1
    : (previous?.renderEpoch ?? 0);
  const presentationTimeline = advanceOutputBlockTimeline(
    previous,
    next.turns.flatMap((turn) => turn.blocks),
    renderEpoch,
  );
  return { ...next, presentationTimeline };
}
