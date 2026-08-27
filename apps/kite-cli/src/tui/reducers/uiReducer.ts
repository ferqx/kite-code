// ── UI 面板显隐和思考折叠 ──

import type { OutputBlock, TuiState } from '../types';
import type { Action } from './actions';
import { findBlockById, replaceBlockById } from './helpers';

/** Collect all reason blocks across all turns — shared by TOGGLE_ALL_REASON and TOGGLE_THINKING */
function collectReasonBlocks(state: TuiState): (OutputBlock & { kind: 'reason' })[] {
  const reasonBlocks: (OutputBlock & { kind: 'reason' })[] = [];
  for (const turn of state.turns) {
    for (const b of turn.blocks) {
      if (b.kind === 'reason') reasonBlocks.push(b);
    }
  }
  return reasonBlocks;
}

export function uiReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case 'SHOW_HELP':
      return {
        ...state,
        showHelp: true,
        showModelSelector: false,
        showPermissionSelector: false,
        showEffortSelector: false,
        showThemeSelector: false,
        showLanguageSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_HELP':
      return { ...state, showHelp: false };
    case 'SHOW_MODEL_SELECTOR':
      return {
        ...state,
        showModelSelector: true,
        showPermissionSelector: false,
        showEffortSelector: false,
        showThemeSelector: false,
        showLanguageSelector: false,
        showHelp: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_MODEL_SELECTOR':
      return { ...state, showModelSelector: false };
    case 'SHOW_PERMISSION_SELECTOR':
      return {
        ...state,
        showPermissionSelector: true,
        showHelp: false,
        showModelSelector: false,
        showEffortSelector: false,
        showThemeSelector: false,
        showLanguageSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_PERMISSION_SELECTOR':
      return { ...state, showPermissionSelector: false };
    case 'SHOW_EFFORT_SELECTOR':
      return {
        ...state,
        showEffortSelector: true,
        showThemeSelector: false,
        showLanguageSelector: false,
        showHelp: false,
        showModelSelector: false,
        showPermissionSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_EFFORT_SELECTOR':
      return { ...state, showEffortSelector: false };
    case 'SHOW_THEME_SELECTOR':
      return {
        ...state,
        showThemeSelector: true,
        showLanguageSelector: false,
        showEffortSelector: false,
        showHelp: false,
        showModelSelector: false,
        showPermissionSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_THEME_SELECTOR':
      return { ...state, showThemeSelector: false };
    case 'SHOW_LANGUAGE_SELECTOR':
      return {
        ...state,
        showLanguageSelector: true,
        showThemeSelector: false,
        showEffortSelector: false,
        showHelp: false,
        showModelSelector: false,
        showPermissionSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_LANGUAGE_SELECTOR':
      return { ...state, showLanguageSelector: false };
    case 'SHOW_SESSIONS':
      return {
        ...state,
        showSessions: true,
        showHelp: false,
        showModelSelector: false,
        showPermissionSelector: false,
        showEffortSelector: false,
        showThemeSelector: false,
        showMcp: false,
        showRewind: false,
      };
    case 'HIDE_SESSIONS':
      return { ...state, showSessions: false, loadingSessionId: null };
    case 'SHOW_MCP':
      return {
        ...state,
        showMcp: true,
        showHelp: false,
        showModelSelector: false,
        showPermissionSelector: false,
        showEffortSelector: false,
        showThemeSelector: false,
        showSessions: false,
        showRewind: false,
      };
    case 'HIDE_MCP':
      return { ...state, showMcp: false };
    case 'SHOW_REWIND':
      return {
        ...state,
        showRewind: true,
        showHelp: false,
        showModelSelector: false,
        showPermissionSelector: false,
        showEffortSelector: false,
        showThemeSelector: false,
        showSessions: false,
        showMcp: false,
      };
    case 'HIDE_REWIND':
      return { ...state, showRewind: false, checkpoints: [] };
    case 'TOGGLE_REASON': {
      const block = findBlockById(state, action.id);
      if (block?.kind !== 'reason') return state;
      return replaceBlockById(state, action.id, { ...block, folded: !block.folded });
    }
    case 'TOGGLE_ALL_REASON': {
      const reasonBlocks = collectReasonBlocks(state);
      if (reasonBlocks.length === 0) return state;
      const anyExpanded = reasonBlocks.some((b) => !b.folded);
      let next = state;
      for (const b of reasonBlocks) {
        next = replaceBlockById(next, b.id, { ...b, folded: anyExpanded });
      }
      return next;
    }
    case 'TOGGLE_TOOL_EXPAND': {
      const block = findBlockById(state, action.id);
      if (block?.kind !== 'tool_card') return state;
      return replaceBlockById(state, action.id, { ...block, expanded: !block.expanded });
    }
    case 'TOGGLE_SUBAGENT_EXPAND': {
      const block = findBlockById(state, action.id);
      if (block?.kind !== 'subagent') return state;
      return replaceBlockById(state, action.id, { ...block, expanded: !block.expanded });
    }
    case 'CLEAR_OUTPUT':
      return {
        ...state,
        turns: [],
        nextBlockId: 0,
        interrupt: null,
        toolStartTimes: undefined,
        pendingToolCalls: {},
        currentRunReasonId: undefined,
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
        currentModelRequestId: undefined,
        currentModelTextStreamed: undefined,
        toolBearingModelRequestId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
        currentModelReasoningRequestId: undefined,
      };
    case 'ESCAPE': {
      if (state.showHelp) return { ...state, showHelp: false };
      if (state.showSessions) return { ...state, showSessions: false };
      if (state.showModelSelector) return { ...state, showModelSelector: false };
      if (state.showPermissionSelector) return { ...state, showPermissionSelector: false };
      if (state.showEffortSelector) return { ...state, showEffortSelector: false };
      if (state.showThemeSelector) return { ...state, showThemeSelector: false };
      if (state.showLanguageSelector) return { ...state, showLanguageSelector: false };
      if (state.showMcp) return { ...state, showMcp: false };
      if (state.showRewind) return { ...state, showRewind: false, checkpoints: [] };
      return null;
    }
    default:
      return null;
  }
}
