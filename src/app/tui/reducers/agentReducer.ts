// ── Agent 生命周期（运行/空闲/退出）、中断、授权、Ctrl+C/Esc ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock } from "../types";
import { appendBlock, findBlockById, replaceBlockById, finalizeLastTurnStreaming } from "./helpers";

/** Shared helper: cancel a running interrupt during Ctrl+C or Escape */
function cancelInterrupt(s: TuiState, setCtrlCPressed: boolean): TuiState {
  let next = finalizeLastTurnStreaming(s);
  if (s.interrupt) {
    const b = findBlockById(next, s.interrupt.blockId);
    if (b) {
      if (b.kind === "approval") {
        next = replaceBlockById(next, b.id, { ...b, resolved: { action: "cancelled" } });
      } else if (b.kind === "question") {
        next = replaceBlockById(next, b.id, { ...b, resolved: "cancelled" });
      }
    }
  }
  return { ...next, running: false, ctrlCPressed: setCtrlCPressed, interrupt: null };
}

export function agentReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "SET_RUNNING":
      return { ...state, running: true, exited: false, interrupt: null, runCount: state.runCount + 1, runStartTime: Date.now(), currentRunReasonId: undefined, ctrlCPressed: false, exitRequested: false, sessionError: false };
    case "SET_IDLE": {
      return { ...finalizeLastTurnStreaming(state), running: false, exited: false, interrupt: null, currentRunReasonId: undefined };
    }
    case "SET_EXITED": {
      const elapsedSec = state.runStartTime ? Math.round((Date.now() - state.runStartTime) / 1000) : 0;
      const elapsedStr = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;
      let changeCount = 0;
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "file_change") changeCount += (b as Extract<OutputBlock, { kind: "file_change" }>).changes.length;
        }
      }
      const summary = [elapsedStr, changeCount > 0 ? `${changeCount} files` : null].filter(Boolean).join(" · ");
      const block: OutputBlock = { id: state.nextBlockId, kind: "text", content: `── ${summary} ──` };
      return { ...state, exited: true, turns: appendBlock(state, block).turns, nextBlockId: state.nextBlockId + 1 };
    }
    case "RESOLVE_INTERRUPT": {
      const b = findBlockById(state, action.blockId);
      if (!b || (b.kind !== "approval" && b.kind !== "question")) {
        return { ...state, interrupt: null };
      }
      let resolved: OutputBlock;
      if (b.kind === "approval") {
        const r = typeof action.resolution === "string" ? { action: action.resolution } : action.resolution;
        resolved = { ...b, resolved: r };
      } else {
        resolved = { ...b, resolved: typeof action.resolution === "string" ? action.resolution : String(action.resolution) };
      }
      return { ...replaceBlockById(state, action.blockId, resolved), interrupt: null };
    }
    case "SWITCH_AUTH": {
      const newMode = action.mode === "toggle"
        ? (state.status.authorization === "full_access" ? "default" : "full_access")
        : action.mode;
      return { ...state, status: { ...state.status, authorization: newMode as "default" | "full_access" } };
    }
    case "COMPACT_CONTEXT": {
      if (!state.running) return state;
      const block: OutputBlock = { id: state.nextBlockId, kind: "text", content: "⟳ Manual compaction requested — context will be compacted on next agent cycle" };
      return appendBlock(state, block);
    }
    case "EXPORT_SESSION":
      return state;
    case "EXPORT_SESSION_DONE": {
      const block: OutputBlock = { id: state.nextBlockId, kind: "text", content: `✓ Session exported to ${action.filename}` };
      return appendBlock(state, block);
    }
    case "LIST_MODELS": {
      const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
      const lines = models.map(m => m === state.status.modelName ? `  ${m} (current)` : `  ${m}`);
      const block: OutputBlock = { id: state.nextBlockId, kind: "text", content: `── Available Models ──\n${lines.join("\n")}\n\nUse /model to open selector, /model <name> to switch` };
      return appendBlock(state, block);
    }
    case "SHOW_SETTING": {
      const s = state.status;
      const info = [
        "── Current Settings ──",
        `  Model       ${s.modelName}`, `  Phase       ${s.phase}`, `  Auth        ${s.authorization}`,
        `  Workspace   ${s.workspaceAccess}`, `  Thinking    ${s.thinkingMode}`,
        `  Tokens      ${s.totalTokens.toLocaleString()}`, `  Cache       ${s.cacheHitRate.toFixed(0)}%`,
      ].join("\n");
      const block: OutputBlock = { id: state.nextBlockId, kind: "text", content: info };
      return appendBlock(state, block);
    }
    case "INJECT_MCP_PROMPT": {
      const block: OutputBlock = { id: state.nextBlockId, kind: "user", content: `/mcp__${action.server}__${action.promptName}` };
      return appendBlock(state, block);
    }
    case "SET_PHASE":
      return { ...state, status: { ...state.status, phase: action.phase } };

    case "CTRL_C": {
      if (state.running) return cancelInterrupt(state, true);
      if (state.ctrlCPressed) return { ...state, exitRequested: true };
      return { ...state, ctrlCPressed: true };
    }
    case "RESET_CTRL_C":
      return state.ctrlCPressed ? { ...state, ctrlCPressed: false } : state;
    case "ESCAPE": {
      if (state.running) return cancelInterrupt(state, true);
      if (state.interrupt) {
        const b = findBlockById(state, state.interrupt.blockId);
        if (b) {
          if (b.kind === "approval") {
            return { ...replaceBlockById(state, b.id, { ...b, resolved: { action: "cancelled" } }), interrupt: null };
          } else if (b.kind === "question") {
            return { ...replaceBlockById(state, b.id, { ...b, resolved: "cancelled" }), interrupt: null };
          }
        }
        return { ...state, interrupt: null };
      }
      return state;
    }
    default:
      return null;
  }
}
