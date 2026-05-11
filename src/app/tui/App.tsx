import React, { useReducer, type Dispatch } from "react";
import { Box } from "ink";
import type { AgentEvent } from "../../protocol/events";
import type { TuiState, OutputLine, ToolCardState, StatusState, InterruptState } from "./types";
import OutputArea from "./OutputArea";
import ToolCard from "./ToolCard";
import ApprovalDialog from "./ApprovalDialog";
import InputDialog from "./InputDialog";
import StatusBar from "./StatusBar";

type Action =
  | { type: "EVENT"; event: AgentEvent }
  | { type: "SET_EXITED" }
  | { type: "TOGGLE_REASON"; id: number };

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
        case "cache_metrics": {
          const d = event.data;
          return {
            ...state,
            status: {
              ...state.status,
              cacheHitRate: d.hitRate ?? 0,
              totalTokens: state.status.totalTokens + d.inputTokens,
            },
          };
        }
        case "need_approval": {
          const interrupt: InterruptState = { kind: "approval", approval: event.data };
          return { ...state, interrupt };
        }
        case "need_input": {
          const interrupt: InterruptState = { kind: "input", question: event.data };
          return { ...state, interrupt };
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
    case "TOGGLE_REASON": {
      const lines = state.output.map((l) =>
        l.id === action.id && l.type === "reason" ? { ...l, folded: !l.folded } : l
      );
      return { ...state, output: lines };
    }
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
  },
  exited: false,
};

export function createInitialState(): TuiState {
  return { ...initialState, output: [], tools: [], fileChanges: [], interrupt: null };
}

export interface AppProps {
  state: TuiState;
  dispatch: Dispatch<Action>;
  onToggleReason: (id: number) => void;
  provider: import("./provider").TuiUserInputProvider;
}

export function useTuiState(): { state: TuiState; dispatch: Dispatch<Action>; onToggleReason: (id: number) => void } {
  const [state, dispatch] = useReducer(eventReducer, initialState);
  const onToggleReason = (id: number) => dispatch({ type: "TOGGLE_REASON", id });
  return { state, dispatch, onToggleReason };
}

export default function App({ state, dispatch, onToggleReason, provider }: AppProps) {
  return (
    <Box flexDirection="column" height="100%">
      <OutputArea lines={state.output} onToggleReason={onToggleReason} />
      <ToolCard tools={state.tools} />
      {state.interrupt?.kind === "approval" && state.interrupt.approval && (
        <ApprovalDialog approval={state.interrupt.approval} provider={provider} />
      )}
      {state.interrupt?.kind === "input" && state.interrupt.question && (
        <InputDialog question={state.interrupt.question} provider={provider} />
      )}
      <StatusBar status={state.status} />
    </Box>
  );
}
