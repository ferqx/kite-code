// ── 组合 reducer：按领域分发到子 reducer ──

import type { TuiState } from '../types';
import type { Action } from './actions';
import { agentReducer } from './agentReducer';
import { checkpointReducer } from './checkpointReducer';
import { handleEventAction, handleRuntimeEventAction } from './handleEvent';
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
  'USER_MESSAGE',
  'SET_THINKING_LEVEL',
]);

const CHECKPOINT_ACTIONS: ReadonlySet<string> = new Set(['EXECUTE_REWIND', 'SET_CHECKPOINTS']);

const SKILL_ACTIONS: ReadonlySet<string> = new Set(['SET_SKILL_MANIFESTS', 'LIST_SKILLS']);

// AGENT_ACTIONS：剩余所有非 RuntimeEvent action（SET_RUNNING, SET_IDLE, SET_EXITED,
// RESOLVE_INTERRUPT, SWITCH_AUTH, EXPORT_SESSION,
// EXPORT_SESSION_DONE, INJECT_MCP_PROMPT,
// SET_PHASE, CTRL_C, ESCAPE）

export function eventReducer(state: TuiState, action: Action): TuiState {
  if (action.type === 'RUNTIME_EVENT') {
    return handleRuntimeEventAction(state, action.event);
  }
  if (action.type === 'LOCAL_TEXT') {
    return handleEventAction(state, {
      type: 'text',
      data: { text: action.text },
    });
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
