import React, { useReducer, type Dispatch, type ReactNode } from "react";
import { Box } from "ink";
import type { AgentEvent } from "../../protocol/events";
import type { TuiState, OutputLine, ToolCardState, StatusState, InterruptState } from "./types";
import OutputArea from "./OutputArea";
import ToolCard from "./ToolCard";
import DiffPreview from "./DiffPreview";
import ApprovalBlock from "./components/ApprovalBlock";
import InputBlock from "./components/InputBlock";
import HelpPanel from "./components/HelpPanel";
import ModelSelector from "./components/ModelSelector";
import StatusBar from "./StatusBar";
import { useGlobalKeys, useLeaderKeys } from "./hooks/useGlobalKeys";

type Action =
  | { type: "EVENT"; event: AgentEvent }
  | { type: "SET_EXITED" }
  | { type: "SET_RUNNING" }
  | { type: "SET_IDLE" }
  | { type: "TOGGLE_REASON"; id: number }
  | { type: "TOGGLE_THINKING" }
  | { type: "CLEAR_OUTPUT" }
  | { type: "CLEAR_INTERRUPT" }
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
  | { type: "SHOW_MODEL_SELECTOR" }
  | { type: "HIDE_MODEL_SELECTOR" }
  | { type: "SHOW_MODEL_LIST" }
  | { type: "SHOW_SESSIONS"; id?: string }
  | { type: "SELECT_MODEL"; modelId: string };

let nextId = 1;

function eventReducer(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case "EVENT": {
      const { event } = action;
      switch (event.type) {
        case "text": {
          const line: OutputLine = { id: nextId++, type: "text", content: event.data.text, folded: false };
          return { ...state, output: [...state.output, line] };
        }
        case "reason": {
          const line: OutputLine = { id: nextId++, type: "reason", content: event.data.text, folded: true };
          return { ...state, output: [...state.output, line] };
        }
        case "tool_call": {
          const card: ToolCardState = {
            callId: event.data.call_id,
            name: event.data.name,
            args: event.data.args,
            status: "running",
            summary: "",
          };
          return { ...state, tools: [...state.tools, card] };
        }
        case "tool_done": {
          const updated = state.tools.map((t) =>
            t.callId === event.data.call_id
              ? { ...t, status: event.data.ok ? "done" as const : "error" as const, summary: event.data.summary }
              : t
          );
          return { ...state, tools: updated };
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
          const line: OutputLine = {
            id: nextId++,
            type: "text",
            content: `⚠ Retry #${event.data.attempt}: ${event.data.reason}`,
            folded: false,
          };
          return { ...state, output: [...state.output, line] };
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
          const line: OutputLine = { id: nextId++, type: "text", content: event.data, folded: false };
          return { ...state, output: [...state.output, line] };
        }
        case "need_approval": {
          const interrupt: InterruptState = { kind: "approval", approval: event.data };
          return { ...state, interrupt };
        }
        case "need_input": {
          const interrupt: InterruptState = { kind: "input", question: event.data };
          return { ...state, interrupt };
        }
        case "error": {
          const line: OutputLine = { id: nextId++, type: "text", content: `Error: ${event.data.message}`, folded: false };
          return { ...state, output: [...state.output, line] };
        }
        case "file_change": {
          return { ...state, fileChanges: [...state.fileChanges, { path: event.data.path, kind: event.data.kind }] };
        }
        case "final": {
          return state;
        }
        default:
          return state;
      }
    }
    case "SET_EXITED":
      return { ...state, exited: true };
    case "SET_RUNNING":
      return { ...state, running: true, exited: false };
    case "SET_IDLE":
      return { ...state, running: false, exited: false, interrupt: null };
    case "TOGGLE_REASON": {
      const lines = state.output.map((l) =>
        l.id === action.id && l.type === "reason" ? { ...l, folded: !l.folded } : l
      );
      return { ...state, output: lines };
    }
    case "TOGGLE_THINKING":
      return { ...state, thinkingVisible: !state.thinkingVisible };
    case "CLEAR_OUTPUT":
      return { ...state, output: [], tools: [], fileChanges: [] };
    case "CLEAR_INTERRUPT":
      return { ...state, interrupt: null };
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
      return state;
    case "CTRL_C":
      if (state.running) return { ...state, running: false, ctrlCPressed: true };
      return state;
    case "SWITCH_AUTH": {
      const newMode = action.mode === "toggle"
        ? (state.status.authorization === "full_access" ? "default" : "full_access")
        : action.mode;
      return { ...state, status: { ...state.status, authorization: newMode as "default" | "full_access" } };
    }
    case "COMPACT_CONTEXT":
      return state;
    case "UNDO":
      return state;
    case "REDO":
      return state;
    case "EXPORT_SESSION":
      return state;
    case "OPEN_EDITOR":
      if (process.env.EDITOR) {
        const { spawn } = require("node:child_process");
        spawn(process.env.EDITOR, { stdio: "inherit", shell: true });
      }
      return state;
    case "SHOW_MODEL_SELECTOR":
      return { ...state, showModelSelector: true };
    case "HIDE_MODEL_SELECTOR":
      return { ...state, showModelSelector: false };
    case "SHOW_MODEL_LIST":
      return { ...state, showModelSelector: true };
    case "SHOW_SESSIONS":
      return state;
    case "SELECT_MODEL":
      return {
        ...state,
        showModelSelector: false,
        status: { ...state.status, modelName: action.modelId },
      };
    default:
      return state;
  }
}

const initialState: TuiState = {
  output: [],
  tools: [],
  fileChanges: [],
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
  thinkingVisible: true,
  leaderPending: false,
  showHelp: false,
  showModelSelector: false,
  ctrlCPressed: false,
};

export function createInitialState(): TuiState {
  return { ...initialState, output: [], tools: [], fileChanges: [], interrupt: null };
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
  const onToggleReason = (id: number) => dispatch({ type: "TOGGLE_REASON", id });
  return { state, dispatch, onToggleReason };
}

export default function App({ state, dispatch, onToggleReason, provider, children }: AppProps) {
  useGlobalKeys(dispatch);
  useLeaderKeys(dispatch, state.leaderPending);

  return (
    <Box flexDirection="column" height="100%">
      <OutputArea lines={state.output} onToggleReason={onToggleReason} />
      <ToolCard tools={state.tools} />
      <DiffPreview changes={state.fileChanges} />
      {state.showHelp && <HelpPanel onClose={() => dispatch({ type: "HIDE_HELP" })} />}
      {state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          onSelect={(modelId) => dispatch({ type: "SELECT_MODEL", modelId })}
          onClose={() => dispatch({ type: "HIDE_MODEL_SELECTOR" })}
        />
      )}
      {state.interrupt?.kind === "approval" && state.interrupt.approval && (
        <ApprovalBlock
          approval={state.interrupt.approval}
          provider={provider}
          onResolved={() => dispatch({ type: "CLEAR_INTERRUPT" })}
        />
      )}
      {state.interrupt?.kind === "input" && state.interrupt.question && (
        <InputBlock
          question={state.interrupt.question}
          provider={provider}
          onResolved={() => dispatch({ type: "CLEAR_INTERRUPT" })}
        />
      )}
      {children}
      <StatusBar status={state.status} thinkingVisible={state.thinkingVisible} />
    </Box>
  );
}
