// ── Action 类型定义 ──
// 从 App.tsx 中抽出，避免 reducers 和 App.tsx 之间的循环依赖

import type { AgentEvent } from "@/protocol/events";
import type { TuiState, OutputBlock, InterruptState } from "../types";
import type { CheckpointEntry } from "@/core/persistence/checkpoint";

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
  | { type: "RESET_CTRL_C" }
  | { type: "SWITCH_AUTH"; mode: string }
  | { type: "COMPACT_CONTEXT" }
  | { type: "EXPORT_SESSION" }
  | { type: "EXPORT_SESSION_DONE"; filename: string }
  | { type: "EXPAND_INPUT" }
  | { type: "SHOW_MODEL_SELECTOR" }
  | { type: "HIDE_MODEL_SELECTOR" }
  | { type: "EDITOR_DONE" }
  | { type: "LIST_MODELS" }
  | { type: "SHOW_SESSIONS" }
  | { type: "HIDE_SESSIONS" }
  | { type: "LOAD_SESSION_PENDING"; threadId: string }
  | { type: "LOAD_SESSION"; threadId: string; blocks: OutputBlock[]; interrupt: InterruptState | null; modelProvider: string; modelName: string; thinkingLevel: string | null }
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
  | { type: "DEACTIVATE_SKILL" }
  | { type: "LIST_SKILLS" }
  | { type: "SET_SKILL_MANIFESTS"; manifests: import("@/core/skills/types").SkillManifest[] }
  | { type: "SWITCH_SESSION"; threadId: string }
  | { type: "SET_SESSIONS"; sessions: TuiState["sessions"] }
  | { type: "SESSION_INTERRUPT_PENDING"; threadId: string }
  | { type: "DELETE_SESSION"; threadId: string }
  | { type: "TOGGLE_PLAN"; id: number }
  | { type: "TOGGLE_TOOL_EXPAND"; id: number }
  | { type: "TOGGLE_SUBAGENT_EXPAND"; id: number };
