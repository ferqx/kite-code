import React, { useReducer, useCallback, useMemo, useRef, type Dispatch, type ReactNode } from "react";
import { Box } from "ink";
import { sessionExportPath } from "@/core/config/paths";
import type { AgentEvent } from "@/protocol/events";
import type { McpManager } from "@/core/mcp";
import type { TuiState, OutputBlock, StatusState, InterruptState, FileChangeRecord, SessionSnapshot } from "./types";
import OutputArea from "./OutputArea";
import ApprovalBlock from "./components/ApprovalBlock";
import InputBlock from "./components/InputBlock";
import HelpPanel from "./components/HelpPanel";
import McpPanel from "./components/McpPanel";
import CheckpointSelector from "./components/CheckpointSelector";
import type { CheckpointEntry } from "@/core/persistence/checkpoint";
import ModelSelector from "./components/ModelSelector";
import SessionSelector from "./components/SessionSelector.js";

import Header from "./Header";
import Footer from "./Footer";
import { useGlobalKeys } from "./hooks/useGlobalKeys";

const MemoHeader = React.memo(Header);

export type Action =
  | { type: "EVENT"; event: AgentEvent }
  | { type: "SET_EXITED" }
  | { type: "SET_RUNNING" }
  | { type: "SET_IDLE" }
  | { type: "TOGGLE_REASON"; id: number }
  | { type: "TOGGLE_ALL_REASON" }
  | { type: "TOGGLE_THINKING" }
  | { type: "CLEAR_OUTPUT" }
  | { type: "RESOLVE_INTERRUPT"; blockId: number; resolution: string | { action: string; grant?: string; pattern?: string } }
  | { type: "SHOW_HELP" }
  | { type: "HIDE_HELP" }
  | { type: "SET_PHASE"; phase: "planning" | "building" }
  | { type: "ESCAPE" }
  | { type: "CTRL_C" }
  | { type: "SWITCH_AUTH"; mode: string }
  | { type: "COMPACT_CONTEXT" }
  | { type: "EXPORT_SESSION" }
  | { type: "EXPAND_INPUT" }
  | { type: "SHOW_MODEL_SELECTOR" }
  | { type: "HIDE_MODEL_SELECTOR" }
  | { type: "LIST_MODELS" }
  | { type: "SHOW_SESSIONS" }
  | { type: "HIDE_SESSIONS" }
  | { type: "LOAD_SESSION_PENDING"; threadId: string }
  | { type: "LOAD_SESSION"; blocks: OutputBlock[]; interrupt: InterruptState | null; modelProvider: string; modelName: string; thinkingLevel: string | null }
  | { type: "SELECT_MODEL"; modelId: string }
  | { type: "NEW_SESSION"; threadId: string }
  | { type: "USER_MESSAGE"; text: string }
  | { type: "SHOW_SETTING" }
  | { type: "SHOW_MCP" }
  | { type: "HIDE_MCP" }
  | { type: "INJECT_MCP_PROMPT"; server: string; promptName: string }
  | { type: "SHOW_REWIND" }
  | { type: "HIDE_REWIND" }
  | { type: "REVERT_TO_CHECKPOINT"; checkpointId: string }
  | { type: "FORK_FROM_CHECKPOINT"; checkpointId: string }
  | { type: "SET_CHECKPOINTS"; checkpoints: CheckpointEntry[] }
  | { type: "ACTIVATE_SKILL"; name: string; content: string }
  | { type: "DEACTIVATE_SKILL"; name: string }
  | { type: "LIST_SKILLS" }
  | { type: "SET_SKILL_MANIFESTS"; manifests: import("@/core/skills/types").SkillManifest[] }
  // ── 多会话 ──
  | { type: "SWITCH_SESSION"; threadId: string }
  | { type: "SET_SESSIONS"; sessions: import("./types").SessionSnapshot[] }
  | { type: "SESSION_INTERRUPT_PENDING"; threadId: string };

let nextId = 1;

function getToolPreview(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file": return String(args.path ?? "");
    case "write_file":
    case "edit_file": return String(args.path ?? "");
    case "shell_execute": {
      const cmd = String(args.command ?? "");
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "update_plan": return String(args.name ?? "");
    case "ask_user": {
      const q = String(args.question ?? "");
      return q.length > 40 ? q.slice(0, 37) + "..." : q;
    }
    default: return "";
  }
}

function modelListText(): string {
  return [
    "── Available Models ──",
    "  deepseek-v4       DeepSeek V4 (current)",
    "  deepseek-v3       DeepSeek V3",
    "  gpt-4o            OpenAI GPT-4o",
    "  claude-sonnet-4   Claude Sonnet 4",
    "",
    "Use /model to open selector, /model <name> to switch",
  ].join("\n");
}

function computeToolDetail(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case "read_file": {
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (offset != null && offset > 1) {
        return limit != null ? `L${offset}-L${offset + limit - 1}` : `L${offset}-`;
      }
      if (limit != null) {
        return `L1-L${limit}`;
      }
      return undefined;
    }
    case "edit_file": {
      const oldStr = typeof args.old_string === "string" ? args.old_string : "";
      const newStr = typeof args.new_string === "string" ? args.new_string : "";
      const removed = oldStr.split("\n").length;
      const added = newStr.split("\n").length;
      const parts: string[] = [];
      if (added > 0) parts.push(`+${added}`);
      if (removed > 0) parts.push(`-${removed}`);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    default:
      return undefined;
  }
}

function resolveInterruptBlock(blocks: OutputBlock[], blockId: number): OutputBlock[] {
  return blocks.map((b) => {
    if (b.id !== blockId) return b;
    if (b.kind === "approval") return { ...b, resolved: { action: "cancelled" } };
    if (b.kind === "question") return { ...b, resolved: "cancelled" };
    return b;
  });
}

export function eventReducer(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case "EVENT": {
      const { event } = action;
      switch (event.type) {
        case "text": {
          // Replace last streaming text block with updated content instead of
          // appending — prevents block accumulation that breaks viewport culling
          const lastBlock = state.blocks.at(-1);
          if (lastBlock?.kind === "text" && lastBlock.streaming) {
            const updated = state.blocks.slice(0, -1);
            updated.push({ ...lastBlock, content: event.data.text });
            return { ...state, blocks: updated };
          }
          const block: OutputBlock = { id: nextId++, kind: "text", content: event.data.text, streaming: state.running };
          return { ...state, blocks: [...state.blocks, block] };
        }
        case "reason": {
          if (state.currentRunReasonId != null) {
            const lastBlock = state.blocks.at(-1);
            if (lastBlock?.kind === "reason" && lastBlock.id === state.currentRunReasonId) {
              const blocks = state.blocks.map((b) =>
                b.id === state.currentRunReasonId && b.kind === "reason"
                  ? { ...b, content: b.content + "\n\n" + event.data.text }
                  : b
              );
              return { ...state, blocks };
            }
          }
          const id = nextId++;
          const block: OutputBlock = { id, kind: "reason", content: event.data.text, folded: true };
          return { ...state, blocks: [...state.blocks, block], currentRunReasonId: id };
        }
        case "tool_call": {
          const preview = getToolPreview(event.data.name, event.data.args);
          const block: OutputBlock = {
            id: nextId++, kind: "tool_card",
            callId: event.data.call_id, name: event.data.name, args: event.data.args,
            status: "running", summary: "", preview,
          };
          const times = new Map(state.toolStartTimes);
          times.set(event.data.call_id, Date.now());
          return { ...state, blocks: [...state.blocks, block], toolStartTimes: times };
        }
        case "tool_done": {
          const startedAt = state.toolStartTimes?.get(event.data.call_id);
          const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
          const nextTimes = new Map(state.toolStartTimes);
          nextTimes.delete(event.data.call_id);
          const blocks = state.blocks.map((b) => {
            if (b.kind === "tool_card" && b.callId === event.data.call_id) {
              return {
                ...b,
                status: event.data.ok ? "done" as const : "error" as const,
                summary: event.data.summary,
                elapsedMs,
                detail: computeToolDetail(b.name, b.args),
              };
            }
            return b;
          });
          return { ...state, blocks, toolStartTimes: nextTimes };
        }
        case "state_change": {
          const d = event.data;
          const next: StatusState = { ...state.status };
          if (d.phase) next.phase = d.phase;
          if (d.plan !== undefined) next.plan = d.plan;
          if (d.authorization) next.authorization = d.authorization.mode;
          if (d.workspaceAccess) next.workspaceAccess = d.workspaceAccess;
          return { ...state, status: next };
        }
        case "model_retry": {
          const block: OutputBlock = { id: nextId++, kind: "text", content: `⟳ Model retry #${event.data.attempt} (${event.data.delayMs}ms): ${event.data.error}` };
          return { ...state, blocks: [...state.blocks, block] };
        }
        case "step_begin": {
          return { ...state, status: { ...state.status, currentNode: event.data.node } };
        }
        case "step_end": {
          return { ...state, status: { ...state.status, currentNode: null } };
        }
        case "cache_metrics": {
          const d = event.data;
          return {
            ...state,
            status: {
              ...state.status,
              cacheHitRate: d.hitRate ?? 0,
              totalTokens: state.status.totalTokens + d.inputTokens + (d.outputTokens ?? 0),
            },
          };
        }
        case "final": {
          if (event.data.length === 0) return state;
          const block: OutputBlock = { id: nextId++, kind: "text", content: event.data };
          return { ...state, blocks: [...state.blocks, block] };
        }
        case "need_approval": {
          const blockId = nextId++;
          const block: OutputBlock = { id: blockId, kind: "approval", approval: event.data };
          const interrupt: InterruptState = { kind: "approval", blockId };
          return { ...state, blocks: [...state.blocks, block], interrupt };
        }
        case "need_input": {
          const blockId = nextId++;
          const block: OutputBlock = { id: blockId, kind: "question", question: event.data };
          const interrupt: InterruptState = { kind: "input", blockId };
          return { ...state, blocks: [...state.blocks, block], interrupt };
        }
        case "error": {
          const recoverable = event.data.recoverable;
          const prefix = recoverable ? "⟳ Recoverable error" : "Error";
          const block: OutputBlock = { id: nextId++, kind: "text", content: `${prefix}: ${event.data.message}`, isError: !recoverable };
          return { ...state, blocks: [...state.blocks, block], sessionError: !recoverable };
        }
        case "file_change": {
          const change: FileChangeRecord = {
            path: event.data.path,
            kind: event.data.kind,
            linesAdded: event.data.linesAdded,
            linesRemoved: event.data.linesRemoved,
            preview: event.data.preview,
          };
          const lastBlock = state.blocks.at(-1);
          if (lastBlock?.kind === "file_change") {
            const updated = state.blocks.slice(0, -1);
            updated.push({ ...lastBlock, changes: [...lastBlock.changes, change] });
            return { ...state, blocks: updated };
          }
          const block: OutputBlock = { id: nextId++, kind: "file_change", changes: [change] };
          return { ...state, blocks: [...state.blocks, block] };
        }
        case "compact_begin": {
          const block: OutputBlock = { id: nextId++, kind: "text", content: `⟳ Compacting context: ${event.data.reason}` };
          return { ...state, blocks: [...state.blocks, block], compacting: true };
        }
        case "compact_end": {
          const block: OutputBlock = { id: nextId++, kind: "text", content: `✓ Compaction complete: ${event.data.summary}` };
          return { ...state, blocks: [...state.blocks, block], compacting: false };
        }
        default:
          return state;
      }
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
      const block: OutputBlock = { id: nextId++, kind: "text", content: `── ${summary} ──` };
      return { ...state, exited: true, blocks: [...state.blocks, block] };
    }
    case "SET_RUNNING":
      return { ...state, running: true, exited: false, interrupt: null, runCount: state.runCount + 1, runStartTime: Date.now(), currentRunReasonId: undefined, ctrlCPressed: false, exitRequested: false, sessionError: false };
    case "SET_IDLE": {
      const blocks = state.blocks.map((b) =>
        b.kind === "text" && b.streaming ? { ...b, streaming: false } : b
      );
      return { ...state, running: false, exited: false, interrupt: null, blocks };
    }
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
      // Any reasoning content currently visible to the user?
      const isVisible = state.thinkingVisible && reasonBlocks.some((b) => b.kind === "reason" && !b.folded);
      if (isVisible) {
        // Hide everything
        return { ...state, thinkingVisible: false };
      }
      // Show: enable visibility + unfold all reason blocks
      const blocks = state.blocks.map((b) =>
        b.kind === "reason" ? { ...b, folded: false } : b
      );
      return { ...state, thinkingVisible: true, blocks };
    }
    case "CLEAR_OUTPUT":
      return { ...state, blocks: [], toolStartTimes: undefined, currentRunReasonId: undefined };
    case "RESOLVE_INTERRUPT": {
      const blocks = state.blocks.map((b) => {
        if (b.id !== action.blockId) return b;
        if (b.kind === "approval") {
          const r = typeof action.resolution === "string"
            ? { action: action.resolution }
            : action.resolution;
          return { ...b, resolved: r };
        }
        if (b.kind === "question") {
          return { ...b, resolved: typeof action.resolution === "string" ? action.resolution : String(action.resolution) };
        }
        return b;
      });
      return { ...state, blocks, interrupt: null };
    }
    case "SHOW_HELP":
      return { ...state, showHelp: true };
    case "HIDE_HELP":
      return { ...state, showHelp: false };
    case "SHOW_MCP":
      return { ...state, showMcp: true };
    case "HIDE_MCP":
      return { ...state, showMcp: false };
    case "SHOW_REWIND":
      return { ...state, showRewind: true };
    case "HIDE_REWIND":
      return { ...state, showRewind: false, checkpoints: [] };
    case "SET_CHECKPOINTS":
      return { ...state, checkpoints: action.checkpoints };
    case "SET_SKILL_MANIFESTS":
      return { ...state, skillManifests: action.manifests };
    case "ACTIVATE_SKILL": {
      const content = `[SKILL: ${action.name}]\n\n${action.content}\n\n---\n\n`;
      return { ...state, pendingSkills: [...state.pendingSkills, content] };
    }
    case "DEACTIVATE_SKILL":
      return { ...state, pendingSkills: [] };
    case "LIST_SKILLS": {
      if (state.skillManifests.length === 0) {
        return {
          ...state,
          blocks: [...state.blocks, {
            id: Date.now(),
            kind: "text" as const,
            content: "No skills available.",
          }],
        };
      }
      const lines = state.skillManifests.map(
        (s) => `- **${s.name}**: ${s.description} (${s.source}/${s.origin})`,
      );
      return {
        ...state,
        blocks: [...state.blocks, {
          id: Date.now(),
          kind: "text" as const,
          content: "## Available Skills\n\n" + lines.join("\n"),
        }],
      };
    }
    case "REVERT_TO_CHECKPOINT":
      return { ...state, showRewind: false, rewindCounter: state.rewindCounter + 1 };
    case "FORK_FROM_CHECKPOINT":
      return { ...state, showRewind: false, rewindCounter: state.rewindCounter + 1 };
    case "INJECT_MCP_PROMPT": {
      const block: OutputBlock = { id: nextId++, kind: "user", content: `/mcp__${action.server}__${action.promptName}` };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "SET_PHASE":
      return { ...state, status: { ...state.status, phase: action.phase } };
    case "EXPAND_INPUT":
      return { ...state, editorRequested: true };
    case "ESCAPE":
      if (state.showHelp) return { ...state, showHelp: false };
      if (state.showSessions) return { ...state, showSessions: false };
      if (state.showModelSelector) return { ...state, showModelSelector: false };
      if (state.showMcp) return { ...state, showMcp: false };
      if (state.showRewind) return { ...state, showRewind: false, checkpoints: [] };
      if (state.running) {
        let next = { ...state, running: false, ctrlCPressed: true };
        if (state.interrupt) {
          next.interrupt = null;
          next.blocks = resolveInterruptBlock(state.blocks, state.interrupt.blockId);
        }
        return next;
      }
      if (state.interrupt) {
        return {
          ...state,
          interrupt: null,
          blocks: resolveInterruptBlock(state.blocks, state.interrupt.blockId),
        };
      }
      return state;
    case "CTRL_C":
      if (state.running) {
        let next = { ...state, running: false, ctrlCPressed: true };
        if (state.interrupt) {
          next.interrupt = null;
          next.blocks = resolveInterruptBlock(state.blocks, state.interrupt.blockId);
        }
        return next;
      }
      if (state.ctrlCPressed) return { ...state, exitRequested: true };
      return { ...state, ctrlCPressed: true };
    case "SWITCH_AUTH": {
      const newMode = action.mode === "toggle"
        ? (state.status.authorization === "full_access" ? "default" : "full_access")
        : action.mode;
      return { ...state, status: { ...state.status, authorization: newMode as "default" | "full_access" } };
    }
    case "COMPACT_CONTEXT": {
      if (!state.running) return state;
      const block: OutputBlock = { id: nextId++, kind: "text", content: "⟳ Manual compaction requested — context will be compacted on next agent cycle" };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "EXPORT_SESSION": {
      const now = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = sessionExportPath(now);
      const body = state.blocks
        .map((b) => {
          if (b.kind === "user") return `**You:** ${b.content}`;
          if (b.kind === "text") return b.content;
          if (b.kind === "reason") return `> ${b.content}`;
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
      const header = `# OpenPX Session Export\n\n> ${new Date().toLocaleString()}\n\n---\n\n`;
      import("node:fs").then(({ writeFileSync }) => {
        writeFileSync(filename, header + body, "utf-8");
      });
      const block: OutputBlock = { id: nextId++, kind: "text", content: `✓ Session exported to ${filename}` };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "SHOW_MODEL_SELECTOR":
      return { ...state, showModelSelector: true };
    case "HIDE_MODEL_SELECTOR":
      return { ...state, showModelSelector: false };
    case "LIST_MODELS": {
      const block: OutputBlock = { id: nextId++, kind: "text", content: modelListText() };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "SHOW_SESSIONS":
      return { ...state, showSessions: true };
    case "HIDE_SESSIONS":
      return { ...state, showSessions: false };
    case "LOAD_SESSION_PENDING": {
      // No state change — handled in index.tsx via effect
      return state;
    }
    case "LOAD_SESSION": {
      // Reset block ID counter based on loaded blocks
      const maxId = action.blocks.reduce((max, b) => Math.max(max, b.id), 0);
      nextId = maxId + 1;

      return {
        ...state,
        blocks: action.blocks,
        interrupt: action.interrupt,
        showSessions: false,    // Close the session selector
        exited: false,          // Reset exit state
        running: false,         // Not running
        compacting: false,      // Not compacting
        currentRunReasonId: undefined,
        status: {
          ...state.status,
          modelName: action.modelName || state.status.modelName,
          thinkingMode: action.thinkingLevel || state.status.thinkingMode,
        },
      };
    }
    case "SELECT_MODEL":
      return {
        ...state,
        showModelSelector: false,
        status: { ...state.status, modelName: action.modelId },
      };
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
      const block: OutputBlock = { id: nextId++, kind: "text", content: info };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "USER_MESSAGE": {
      const block: OutputBlock = { id: nextId++, kind: "user", content: action.text };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "NEW_SESSION": {
      nextId = 1;
      // Save current session blocks/status to snapshots before creating new
      const newSessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, blocks: state.blocks, status: state.status, active: false }
          : s
      );
      const newSnapshot: SessionSnapshot = {
        threadId: action.threadId,
        name: action.threadId,
        workspace: state.sessions.find(s => s.threadId === state.activeSessionId)?.workspace ?? "",
        active: true,
        running: false,
        pendingInterrupt: false,
        plan: null,
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
        blocks: [],
      };
      return {
        ...state,
        sessions: [...newSessions, newSnapshot],
        activeSessionId: action.threadId,

        blocks: [],
        toolStartTimes: undefined,
        interrupt: null,
        exited: false,
        compacting: false,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        showHelp: false,
        showModelSelector: false,
        showSessions: false,
        showMcp: false,
        rewindCounter: 0,
        currentRunReasonId: undefined,
        sessionKey: state.sessionKey + 1,
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
      };
    }
    case "SWITCH_SESSION": {
      const sessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, blocks: state.blocks, status: state.status, active: false }
          : s.threadId === action.threadId
            ? { ...s, active: true }
            : s
      );
      const target = sessions.find(s => s.threadId === action.threadId);
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        blocks: target?.blocks ?? [],
        status: target?.status ?? {
          ...state.status,
          totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null,
        },
        interrupt: null,
      };
    }
    case "SET_SESSIONS": {
      // Merge runtime snapshots with existing reducer state: keep blocks/status
      // that reducers (NEW_SESSION, SWITCH_SESSION) manage, update runtime info
      // (name, running, pendingInterrupt) from SessionManager.
      // Also sync activeSessionId from the runtime snapshots.
      const mergedSessions = action.sessions.map((incoming) => {
        const existing = state.sessions.find((s) => s.threadId === incoming.threadId);
        if (existing) {
          return { ...incoming, blocks: existing.blocks, status: existing.status };
        }
        return incoming;
      });
      const activeIncoming = action.sessions.find((s) => s.active);
      return {
        ...state,
        sessions: mergedSessions,
        activeSessionId: activeIncoming?.threadId ?? state.activeSessionId,
      };
    }
    case "SESSION_INTERRUPT_PENDING":
      return {
        ...state,
        sessions: state.sessions.map(s =>
          s.threadId === action.threadId
            ? { ...s, pendingInterrupt: true }
            : s
        ),
      };
    default:
      return state;
  }
}

const initialState: TuiState = {
  sessions: [],
  activeSessionId: null,
  blocks: [],
  interrupt: null,
  status: {
    phase: "building",
    plan: null,
    authorization: "default",
    workspaceAccess: "write",
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelName: "deepseek-v4",
    thinkingMode: "max",
  },
  exited: false,
  running: false,
  compacting: false,
  runCount: 0,
  thinkingVisible: true,
  currentRunReasonId: undefined,
  showHelp: false,
  showModelSelector: false,
  showSessions: false,
  showMcp: false,
  showRewind: false,
  checkpoints: [],
  rewindCounter: 0,
  ctrlCPressed: false,
  sessionKey: 0,
  exitRequested: false,
  editorRequested: false,
  sessionError: false,
  pendingSkills: [],
  skillManifests: [],
};

export function createInitialState(): TuiState {
  return { ...initialState, blocks: [], interrupt: null };
}

export interface AppProps {
  state: TuiState;
  dispatch: Dispatch<Action>;
  onToggleReason: (id: number) => void;
  provider: import("./provider").TuiUserInputProvider;
  onCompactRequest?: () => void;
  mcpManager?: McpManager;
  children?: ReactNode;
}

export function useTuiState(): { state: TuiState; dispatch: Dispatch<Action>; onToggleReason: (id: number) => void } {
  const [state, dispatch] = useReducer(eventReducer, initialState);
  const onToggleReason = useCallback((id: number) => dispatch({ type: "TOGGLE_REASON", id }), [dispatch]);
  return { state, dispatch, onToggleReason };
}

export default function App({ state, dispatch, onToggleReason, provider, onCompactRequest, mcpManager, children }: AppProps) {
  useGlobalKeys(dispatch);

  const elapsedRef = useRef(0);

  // Stabilized callbacks for React.memo children
  const hideHelp = useCallback(() => dispatch({ type: "HIDE_HELP" }), [dispatch]);
  const hideModelSelector = useCallback(() => dispatch({ type: "HIDE_MODEL_SELECTOR" }), [dispatch]);
  const selectModel = useCallback((modelId: string) => dispatch({ type: "SELECT_MODEL", modelId }), [dispatch]);
  const hideSessions = useCallback(() => dispatch({ type: "HIDE_SESSIONS" }), [dispatch]);
  const hideMcp = useCallback(() => dispatch({ type: "HIDE_MCP" }), [dispatch]);
  const hideRewind = useCallback(() => dispatch({ type: "HIDE_REWIND" }), [dispatch]);
  const handleRevert = useCallback((checkpointId: string) => dispatch({ type: "REVERT_TO_CHECKPOINT", checkpointId }), [dispatch]);
  const handleFork = useCallback((checkpointId: string) => dispatch({ type: "FORK_FROM_CHECKPOINT", checkpointId }), [dispatch]);
  const selectSession = useCallback(
    (threadId: string) => {
      dispatch({ type: "LOAD_SESSION_PENDING", threadId });
    },
    [dispatch],
  );

  const interruptBlock = useMemo(() => {
    if (!state.interrupt) return undefined;
    return state.blocks.find((b) => b.id === state.interrupt!.blockId);
  }, [state.interrupt, state.blocks]);

  const resolveApproval = useCallback(
    (action: string, grant?: string, pattern?: string) => {
      if (!interruptBlock) return;
      dispatch({ type: "RESOLVE_INTERRUPT", blockId: interruptBlock.id, resolution: { action, grant, pattern } });
    },
    [dispatch, interruptBlock]
  );

  const resolveInput = useCallback(
    (answer: string) => {
      if (!interruptBlock) return;
      dispatch({ type: "RESOLVE_INTERRUPT", blockId: interruptBlock.id, resolution: answer });
    },
    [dispatch, interruptBlock]
  );


  return (
    <Box flexDirection="column">
      {/* ── Left: Main content (existing column layout) ── */}
      <Box flexDirection="column" flexGrow={1}>
        <MemoHeader running={state.running} error={state.sessionError} />
        <OutputArea blocks={state.blocks} onToggleReason={onToggleReason} thinkingVisible={state.thinkingVisible} />
        {state.showHelp && <HelpPanel onClose={hideHelp} />}
        {interruptBlock?.kind === "approval" && !interruptBlock.resolved && (
          <ApprovalBlock
            approval={interruptBlock.approval}
            provider={provider}
            onResolved={resolveApproval}
          />
        )}
        {interruptBlock?.kind === "question" && !interruptBlock.resolved && (
          <InputBlock
            question={interruptBlock.question}
            provider={provider}
            onResolved={resolveInput}
          />
        )}
        {state.showSessions && (
          <SessionSelector
            onSelect={selectSession}
            onClose={hideSessions}
          />
        )}
        {state.showModelSelector && (
          <ModelSelector
            currentModel={state.status.modelName}
            onSelect={selectModel}
            onClose={hideModelSelector}
          />
        )}
        {state.showMcp && mcpManager && (
          <McpPanel manager={mcpManager} onClose={hideMcp} />
        )}
        {state.showRewind && (
          <CheckpointSelector
            checkpoints={state.checkpoints}
            onRevert={handleRevert}
            onFork={handleFork}
            onClose={hideRewind}
          />
        )}
        <Footer
          status={state.status}
          running={state.running}
          compacting={state.compacting}
          thinkingVisible={state.thinkingVisible}
          timerKey={state.runCount}
          elapsedRef={elapsedRef}
        >
          {children}
        </Footer>
      </Box>
    </Box>
  );
}
