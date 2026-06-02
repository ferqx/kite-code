// ── Agent 生命周期（运行/空闲/退出）、中断、授权、Ctrl+C/Esc ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock } from "../types";

/** Replace a single block by id — keeps references for all other blocks */
function replaceBlock(
  blocks: OutputBlock[],
  blockId: number,
  next: OutputBlock,
): OutputBlock[] {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return blocks;
  const copy = blocks.slice();
  copy[idx] = next;
  return copy;
}

/** Finalize all streaming text blocks — only creates new refs for changed blocks */
function finalizeStreaming(blocks: OutputBlock[]): OutputBlock[] {
  let result = blocks;
  for (let i = 0; i < result.length; i++) {
    const b = result[i];
    if (b.kind === "text" && b.streaming) {
      const { streaming: _, ...rest } = b;
      result = replaceBlock(result, b.id, { ...rest, streaming: false } as OutputBlock);
    }
  }
  return result;
}

function resolveInterruptBlock(blocks: OutputBlock[], blockId: number): OutputBlock[] {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) return blocks;
  const b = blocks[idx];
  if (b.kind === "approval") return replaceBlock(blocks, blockId, { ...b, resolved: { action: "cancelled" } });
  if (b.kind === "question") return replaceBlock(blocks, blockId, { ...b, resolved: "cancelled" });
  return blocks;
}

export function agentReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "SET_RUNNING":
      return { ...state, running: true, exited: false, interrupt: null, runCount: state.runCount + 1, runStartTime: Date.now(), currentRunReasonId: undefined, ctrlCPressed: false, exitRequested: false, sessionError: false };
    case "SET_IDLE": {
      return { ...state, running: false, exited: false, interrupt: null, blocks: finalizeStreaming(state.blocks), currentRunReasonId: undefined };
    }
    case "SET_EXITED": {
      const elapsedSec = state.runStartTime ? Math.round((Date.now() - state.runStartTime) / 1000) : 0;
      const elapsedStr = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;
      const fcBlocks = state.blocks.filter((b) => b.kind === "file_change");
      const changeCount = fcBlocks.reduce((sum, b) => sum + (b as Extract<OutputBlock, { kind: "file_change" }>).changes.length, 0);
      const summary = [
        elapsedStr,
        changeCount > 0 ? `${changeCount} files` : null,
      ].filter(Boolean).join(" · ");
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `── ${summary} ──` };
      return { ...state, exited: true, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "RESOLVE_INTERRUPT": {
      const idx = state.blocks.findIndex(b => b.id === action.blockId);
      if (idx === -1) return { ...state, interrupt: null };
      const b = state.blocks[idx];
      let resolved: OutputBlock;
      if (b.kind === "approval") {
        const r = typeof action.resolution === "string"
          ? { action: action.resolution }
          : action.resolution;
        resolved = { ...b, resolved: r };
      } else if (b.kind === "question") {
        resolved = { ...b, resolved: typeof action.resolution === "string" ? action.resolution : String(action.resolution) };
      } else {
        return { ...state, interrupt: null };
      }
      return { ...state, blocks: replaceBlock(state.blocks, action.blockId, resolved), interrupt: null };
    }
    case "SWITCH_AUTH": {
      const newMode = action.mode === "toggle"
        ? (state.status.authorization === "full_access" ? "default" : "full_access")
        : action.mode;
      return { ...state, status: { ...state.status, authorization: newMode as "default" | "full_access" } };
    }
    case "COMPACT_CONTEXT": {
      if (!state.running) return state;
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: "⟳ Manual compaction requested — context will be compacted on next agent cycle" };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "EXPORT_SESSION": {
      return state;
    }
    case "EXPORT_SESSION_DONE": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `✓ Session exported to ${action.filename}` };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "LIST_MODELS": {
      const id = state.nextBlockId;
      const models = [
        "deepseek-v4-flash",
        "deepseek-v4-pro",
      ];
      const lines = models.map(m => m === state.status.modelName ? `  ${m} (current)` : `  ${m}`);
      const block: OutputBlock = { id, kind: "text", content: `── Available Models ──\n${lines.join("\n")}\n\nUse /model to open selector, /model <name> to switch` };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "SHOW_SETTING": {
      const s = state.status;
      const info = [
        "── Current Settings ──",
        `  Model       ${s.modelName}`,
        `  Phase       ${s.phase}`,
        `  Auth        ${s.authorization}`,
        `  Workspace   ${s.workspaceAccess}`,
        `  Thinking    ${s.thinkingMode}`,
        `  Tokens      ${s.totalTokens.toLocaleString()}`,
        `  Cache       ${s.cacheHitRate.toFixed(0)}%`,
      ].join("\n");
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: info };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "INJECT_MCP_PROMPT": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "user", content: `/mcp__${action.server}__${action.promptName}` };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "SET_PHASE":
      return { ...state, status: { ...state.status, phase: action.phase } };
    case "CTRL_C": {
      if (state.running) {
        let blocks = finalizeStreaming(state.blocks);
        if (state.interrupt) {
          blocks = resolveInterruptBlock(blocks, state.interrupt.blockId);
        }
        return { ...state, running: false, ctrlCPressed: true, interrupt: null, blocks };
      }
      if (state.ctrlCPressed) return { ...state, exitRequested: true };
      return { ...state, ctrlCPressed: true };
    }
    case "ESCAPE": {
      // Interrupt handling (after panel closing tried by uiReducer)
      if (state.running) {
        let blocks = finalizeStreaming(state.blocks);
        if (state.interrupt) {
          blocks = resolveInterruptBlock(blocks, state.interrupt.blockId);
        }
        return { ...state, running: false, ctrlCPressed: true, interrupt: null, blocks };
      }
      if (state.interrupt) {
        return {
          ...state,
          interrupt: null,
          blocks: resolveInterruptBlock(state.blocks, state.interrupt.blockId),
        };
      }
      return state;
    }
    default:
      return null;
  }
}
