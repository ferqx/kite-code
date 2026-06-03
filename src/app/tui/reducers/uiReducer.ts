// ── UI 面板显隐和思考折叠 ──

import type { Action } from "./actions";
import type { TuiState } from "../types";

function resolveInterruptBlock(blocks: TuiState["blocks"], blockId: number): TuiState["blocks"] {
  return blocks.map((b) => {
    if (b.id !== blockId) return b;
    if (b.kind === "approval") return { ...b, resolved: { action: "cancelled" } };
    if (b.kind === "question") return { ...b, resolved: "cancelled" };
    return b;
  });
}

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
      const blocks = state.blocks.map((b) =>
        b.kind === "reason" && b.id === action.id ? { ...b, folded: !b.folded } : b
      );
      return { ...state, blocks };
    }
    case "TOGGLE_ALL_REASON": {
      const reasonBlocks = state.blocks.filter((b) => b.kind === "reason");
      if (reasonBlocks.length === 0) return state;
      const anyExpanded = reasonBlocks.some((b) => b.kind === "reason" && !b.folded);
      const blocks = state.blocks.map((b) =>
        b.kind === "reason" ? { ...b, folded: anyExpanded } : b
      );
      return { ...state, blocks };
    }
    case "TOGGLE_THINKING": {
      const reasonBlocks = state.blocks.filter((b) => b.kind === "reason");
      const isVisible = state.thinkingVisible && reasonBlocks.some((b) => b.kind === "reason" && !b.folded);
      if (isVisible) {
        return { ...state, thinkingVisible: false };
      }
      const blocks = state.blocks.map((b) =>
        b.kind === "reason" ? { ...b, folded: false } : b
      );
      return { ...state, thinkingVisible: true, blocks };
    }
    case "TOGGLE_PLAN": {
      const blocks = state.blocks.map((b) =>
        b.kind === "plan_card" && b.id === action.id ? { ...b, folded: !b.folded } : b
      );
      return { ...state, blocks };
    }
    case "TOGGLE_TOOL_EXPAND": {
      const blocks = state.blocks.map((b) =>
        b.kind === "tool_card" && b.id === action.id ? { ...b, expanded: !b.expanded } : b
      );
      return { ...state, blocks };
    }
    case "TOGGLE_SUBAGENT_EXPAND": {
      const blocks = state.blocks.map((b) =>
        b.kind === "subagent" && b.id === action.id ? { ...b, expanded: !b.expanded } : b
      );
      return { ...state, blocks };
    }
    case "CLEAR_OUTPUT":
      return { ...state, blocks: [], toolStartTimes: undefined, currentRunReasonId: undefined };
    case "ESCAPE": {
      // Panel closing (non-interrupt paths)
      if (state.showHelp) return { ...state, showHelp: false };
      if (state.showSessions) return { ...state, showSessions: false };
      if (state.showModelSelector) return { ...state, showModelSelector: false };
      if (state.showMcp) return { ...state, showMcp: false };
      if (state.showRewind) return { ...state, showRewind: false, checkpoints: [] };
      // Fall through to agent lifecycle handling
      return null;
    }
    default:
      return null;
  }
}
