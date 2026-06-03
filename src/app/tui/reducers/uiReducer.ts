// ── UI 面板显隐和思考折叠 ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock } from "../types";
import { findBlockById, replaceBlockById } from "./helpers";

export function uiReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "SHOW_HELP":
      return { ...state, showHelp: true };
    case "HIDE_HELP":
      return { ...state, showHelp: false };
    case "SHOW_MODEL_SELECTOR":
      return { ...state, showModelSelector: true };
    case "HIDE_MODEL_SELECTOR":
      return { ...state, showModelSelector: false };
    case "SHOW_SESSIONS":
      return { ...state, showSessions: true };
    case "HIDE_SESSIONS":
      return { ...state, showSessions: false };
    case "SHOW_MCP":
      return { ...state, showMcp: true };
    case "HIDE_MCP":
      return { ...state, showMcp: false };
    case "SHOW_REWIND":
      return { ...state, showRewind: true };
    case "HIDE_REWIND":
      return { ...state, showRewind: false, checkpoints: [] };
    case "EDITOR_DONE":
      return { ...state, editorRequested: false };
    case "EXPAND_INPUT":
      return { ...state, editorRequested: true };
    case "TOGGLE_REASON": {
      const block = findBlockById(state, action.id);
      if (!block || block.kind !== "reason") return state;
      return replaceBlockById(state, action.id, { ...block, folded: !block.folded });
    }
    case "TOGGLE_ALL_REASON": {
      const reasonBlocks: (OutputBlock & { kind: "reason" })[] = [];
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "reason") reasonBlocks.push(b);
        }
      }
      if (reasonBlocks.length === 0) return state;
      const anyExpanded = reasonBlocks.some((b) => !b.folded);
      let next = state;
      for (const b of reasonBlocks) {
        next = replaceBlockById(next, b.id, { ...b, folded: anyExpanded });
      }
      return next;
    }
    case "TOGGLE_THINKING": {
      const reasonBlocks: (OutputBlock & { kind: "reason" })[] = [];
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "reason") reasonBlocks.push(b);
        }
      }
      const anyExpanded = reasonBlocks.some((b) => !b.folded);
      const isVisible = state.thinkingVisible && anyExpanded;
      if (isVisible) {
        return { ...state, thinkingVisible: false };
      }
      let next = state;
      for (const b of reasonBlocks) {
        next = replaceBlockById(next, b.id, { ...b, folded: false });
      }
      return { ...next, thinkingVisible: true };
    }
    case "TOGGLE_PLAN": {
      const block = findBlockById(state, action.id);
      if (!block || block.kind !== "plan_card") return state;
      return replaceBlockById(state, action.id, { ...block, folded: !block.folded });
    }
    case "TOGGLE_TOOL_EXPAND": {
      const block = findBlockById(state, action.id);
      if (!block || block.kind !== "tool_card") return state;
      return replaceBlockById(state, action.id, { ...block, expanded: !block.expanded });
    }
    case "TOGGLE_SUBAGENT_EXPAND": {
      const block = findBlockById(state, action.id);
      if (!block || block.kind !== "subagent") return state;
      return replaceBlockById(state, action.id, { ...block, expanded: !block.expanded });
    }
    case "CLEAR_OUTPUT":
      return { ...state, turns: [], toolStartTimes: undefined, currentRunReasonId: undefined };
    case "ESCAPE": {
      if (state.showHelp) return { ...state, showHelp: false };
      if (state.showSessions) return { ...state, showSessions: false };
      if (state.showModelSelector) return { ...state, showModelSelector: false };
      if (state.showMcp) return { ...state, showMcp: false };
      if (state.showRewind) return { ...state, showRewind: false, checkpoints: [] };
      return null;
    }
    default:
      return null;
  }
}
