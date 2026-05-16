import React, { useReducer, useCallback, useMemo, type Dispatch, type ReactNode } from "react";
import { Box } from "ink";
import type { AgentEvent } from "../../protocol/events";
import type { TuiState, OutputBlock, StatusState, InterruptState, FileChangeRecord } from "./types";
import OutputArea from "./OutputArea";
import ApprovalBlock from "./components/ApprovalBlock";
import InputBlock from "./components/InputBlock";
import HelpPanel from "./components/HelpPanel";
import ModelSelector from "./components/ModelSelector";
import Header from "./Header";
import Footer from "./Footer";
import { useGlobalKeys, useLeaderKeys } from "./hooks/useGlobalKeys";

const MemoHeader = React.memo(Header);

export type Action =
  | { type: "EVENT"; event: AgentEvent }
  | { type: "SET_EXITED" }
  | { type: "SET_RUNNING" }
  | { type: "SET_IDLE" }
  | { type: "TOGGLE_REASON"; id: number }
  | { type: "TOGGLE_THINKING" }
  | { type: "CLEAR_OUTPUT" }
  | { type: "RESOLVE_INTERRUPT"; blockId: number; resolution: string | { action: string; grant?: string; pattern?: string } }
  | { type: "SHOW_HELP" }
  | { type: "HIDE_HELP" }
  | { type: "SET_PHASE"; phase: "planning" | "building" }
  | { type: "LEADER_PENDING" }
  | { type: "LEADER_CANCEL" }
  | { type: "ESCAPE" }
  | { type: "CTRL_C" }
  | { type: "SWITCH_AUTH"; mode: string }
  | { type: "COMPACT_CONTEXT" }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "EXPORT_SESSION" }
  | { type: "OPEN_EDITOR" }
  | { type: "EDITOR_DONE" }
  | { type: "SHOW_MODEL_SELECTOR" }
  | { type: "HIDE_MODEL_SELECTOR" }
  | { type: "LIST_MODELS" }
  | { type: "SHOW_SESSIONS"; id?: string }
  | { type: "SELECT_MODEL"; modelId: string }
  | { type: "NEW_SESSION" }
  | { type: "USER_MESSAGE"; text: string }
  | { type: "SHOW_SETTING" };

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
          const block: OutputBlock = { id: nextId++, kind: "reason", content: event.data.text, folded: true };
          return { ...state, blocks: [...state.blocks, block] };
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
          const blocks = state.blocks.map((b) =>
            b.kind === "tool_card" && b.callId === event.data.call_id
              ? { ...b, status: event.data.ok ? "done" as const : "error" as const, summary: event.data.summary, elapsedMs }
              : b
          );
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
        case "retry": {
          const block: OutputBlock = { id: nextId++, kind: "text", content: `⚠ Retry #${event.data.attempt}: ${event.data.reason}` };
          return { ...state, blocks: [...state.blocks, block] };
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
          const block: OutputBlock = { id: nextId++, kind: "text", content: `Error: ${event.data.message}` };
          return { ...state, blocks: [...state.blocks, block], sessionError: true };
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
      return { ...state, running: true, exited: false, runCount: state.runCount + 1, runStartTime: Date.now(), ctrlCPressed: false, exitRequested: false, sessionError: false };
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
    case "TOGGLE_THINKING":
      return { ...state, thinkingVisible: !state.thinkingVisible };
    case "CLEAR_OUTPUT":
      return { ...state, blocks: [], toolStartTimes: undefined };
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
    case "SET_PHASE":
      return { ...state, status: { ...state.status, phase: action.phase } };
    case "LEADER_PENDING":
      return { ...state, leaderPending: true };
    case "LEADER_CANCEL":
      return { ...state, leaderPending: false };
    case "ESCAPE":
      if (state.showHelp) return { ...state, showHelp: false };
      if (state.showModelSelector) return { ...state, showModelSelector: false };
      if (state.leaderPending) return { ...state, leaderPending: false };
      if (state.interrupt) {
        return { ...state, interrupt: null };
      }
      return state;
    case "CTRL_C":
      if (state.running) {
        // When interrupt is active, also clear it so the provider is cancelled
        const next = { ...state, running: false, ctrlCPressed: true };
        if (state.interrupt) next.interrupt = null;
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
      const block: OutputBlock = { id: nextId++, kind: "text", content: "⟳ Manual compaction requested — waiting for graph node to trigger" };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "UNDO": {
      const block: OutputBlock = { id: nextId++, kind: "text", content: "Undo: checkpoint rollback not yet implemented" };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "REDO": {
      const block: OutputBlock = { id: nextId++, kind: "text", content: "Redo: checkpoint restore not yet implemented" };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "EXPORT_SESSION": {
      const now = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${process.cwd()}/.openpx/session-${now}.md`;
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
    case "OPEN_EDITOR": {
      return { ...state, editorRequested: true };
    }
    case "EDITOR_DONE":
      return { ...state, editorRequested: false };
    case "SHOW_MODEL_SELECTOR":
      return { ...state, showModelSelector: true };
    case "HIDE_MODEL_SELECTOR":
      return { ...state, showModelSelector: false };
    case "LIST_MODELS": {
      const block: OutputBlock = { id: nextId++, kind: "text", content: modelListText() };
      return { ...state, blocks: [...state.blocks, block] };
    }
    case "SHOW_SESSIONS": {
      const content = action.id
        ? `Session switch to "${action.id}": session management not yet implemented`
        : "Session list: session management not yet implemented";
      const block: OutputBlock = { id: nextId++, kind: "text", content };
      return { ...state, blocks: [...state.blocks, block] };
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
      return {
        ...state,
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
        leaderPending: false,
        sessionKey: state.sessionKey + 1,
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
      };
    }
    default:
      return state;
  }
}

const initialState: TuiState = {
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
  leaderPending: false,
  showHelp: false,
  showModelSelector: false,
  ctrlCPressed: false,
  sessionKey: 0,
  exitRequested: false,
  editorRequested: false,
  sessionError: false,
};

export function createInitialState(): TuiState {
  return { ...initialState, blocks: [], interrupt: null };
}

export interface AppProps {
  state: TuiState;
  dispatch: Dispatch<Action>;
  onToggleReason: (id: number) => void;
  provider: import("./provider").TuiUserInputProvider;
  children?: ReactNode;
}

export function useTuiState(): { state: TuiState; dispatch: Dispatch<Action>; onToggleReason: (id: number) => void } {
  const [state, dispatch] = useReducer(eventReducer, initialState);
  const onToggleReason = useCallback((id: number) => dispatch({ type: "TOGGLE_REASON", id }), [dispatch]);
  return { state, dispatch, onToggleReason };
}

export default function App({ state, dispatch, onToggleReason, provider, children }: AppProps) {
  useGlobalKeys(dispatch, state.running);
  useLeaderKeys(dispatch, state.leaderPending);

  // Stabilized callbacks for React.memo children
  const hideHelp = useCallback(() => dispatch({ type: "HIDE_HELP" }), [dispatch]);
  const hideModelSelector = useCallback(() => dispatch({ type: "HIDE_MODEL_SELECTOR" }), [dispatch]);
  const selectModel = useCallback((modelId: string) => dispatch({ type: "SELECT_MODEL", modelId }), [dispatch]);

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
      <MemoHeader status={state.status} running={state.running} timerKey={state.runCount} error={state.sessionError} />
      <OutputArea blocks={state.blocks} onToggleReason={onToggleReason} thinkingVisible={state.thinkingVisible} />
      {state.showHelp && <HelpPanel onClose={hideHelp} />}
      {state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          onSelect={selectModel}
          onClose={hideModelSelector}
        />
      )}
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
      {children}
      <Footer />
    </Box>
  );
}
