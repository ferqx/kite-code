// ── Action 类型定义 ──
// 从 App.tsx 中抽出，避免 reducers 和 App.tsx 之间的循环依赖

import type {
  ContextCompactionProgressPhase,
  ContextStatusSnapshot,
  RuntimeInteractionQueueProjection,
} from '@kite-ai/runtime-contract';
import type { RuntimeCheckpointEntry, RuntimePresentationEvent } from '../runtime-presentation';
import type { InterruptState, OutputBlock, RewindScope, TuiState } from '../types';

export type Action =
  | { type: 'RUNTIME_EVENT'; event: RuntimePresentationEvent }
  | {
      type: 'RECONCILE_RUNTIME_PROJECTION';
      active: boolean;
      interactionQueue: RuntimeInteractionQueueProjection;
    }
  | { type: 'LOCAL_TEXT'; text: string; isError?: boolean }
  | { type: 'LOCAL_USER_PROMPT'; text: string }
  | { type: 'DROP_LOCAL_USER_PROMPT'; text: string }
  | { type: 'QUEUE_LOCAL_PROMPT'; id: number; sessionId: string; text: string }
  | { type: 'ACCEPT_QUEUED_PROMPT'; id: number; sessionId: string; text: string }
  | { type: 'DEQUEUE_LOCAL_PROMPT'; id: number }
  | { type: 'SET_EXITED' }
  | { type: 'SET_RUNNING' }
  | {
      type: 'SET_COMPACTION_PROGRESS';
      phase: ContextCompactionProgressPhase;
      source: 'manual' | 'automatic';
    }
  | { type: 'SET_COMPACTION_PROGRESS'; phase?: undefined; source?: never }
  | { type: 'SET_CONTEXT_SNAPSHOT'; snapshot: ContextStatusSnapshot }
  | { type: 'TOGGLE_REASON'; id: number }
  | { type: 'TOGGLE_ALL_REASON' }
  | { type: 'SET_THINKING_LEVEL'; level: string }
  | { type: 'CLEAR_OUTPUT' }
  | {
      type: 'RESOLVE_INTERRUPT';
      blockId?: number;
      /** Child identity captured while the approval Footer is still mounted. */
      approvalTarget?: { subagentId?: string; parentToolCallId?: string };
      resolution:
        | string
        | {
            action: string;
            grant?: string;
            pattern?: string;
            feedback?: string;
            text?: string;
            answers?: Record<string, string>;
          };
    }
  | { type: 'SHOW_HELP' }
  | { type: 'HIDE_HELP' }
  | { type: 'SET_PHASE'; phase: 'planning' | 'building' }
  | { type: 'ESCAPE' }
  | { type: 'CTRL_C' }
  | { type: 'CANCEL_REQUEST_FAILED' }
  | { type: 'RESET_CTRL_C' }
  | { type: 'SWITCH_AUTH'; mode: string }
  | { type: 'EXPORT_SESSION' }
  | { type: 'EXPORT_SESSION_DONE'; filename: string }
  | { type: 'SHOW_MODEL_SELECTOR' }
  | { type: 'HIDE_MODEL_SELECTOR' }
  | { type: 'SHOW_PERMISSION_SELECTOR' }
  | { type: 'HIDE_PERMISSION_SELECTOR' }
  | { type: 'SHOW_EFFORT_SELECTOR' }
  | { type: 'HIDE_EFFORT_SELECTOR' }
  | { type: 'SHOW_THEME_SELECTOR' }
  | { type: 'HIDE_THEME_SELECTOR' }
  | { type: 'SHOW_LANGUAGE_SELECTOR' }
  | { type: 'HIDE_LANGUAGE_SELECTOR' }
  | { type: 'SHOW_SESSIONS' }
  | { type: 'HIDE_SESSIONS' }
  | { type: 'LOAD_SESSION_PENDING'; threadId: string }
  | {
      type: 'LOAD_SESSION';
      threadId: string;
      blocks: OutputBlock[];
      interrupt: InterruptState | null;
      pendingToolCalls?: TuiState['pendingToolCalls'];
      modelProvider: string;
      modelName: string;
      thinkingLevel: string | null;
      reasoningEnabled?: boolean;
      interactionMode?: TuiState['interactionMode'];
    }
  | { type: 'SELECT_MODEL'; provider: string; modelName: string; reasoningEnabled?: boolean }
  | { type: 'NEW_SESSION'; threadId: string }
  | { type: 'LOCAL_COMMAND'; text: string }
  | { type: 'SHOW_MCP' }
  | { type: 'HIDE_MCP' }
  | { type: 'INJECT_MCP_PROMPT'; server: string; promptName: string }
  | { type: 'SHOW_REWIND' }
  | { type: 'HIDE_REWIND' }
  | { type: 'EXECUTE_REWIND'; checkpointId: string; scope: RewindScope }
  | { type: 'SET_CHECKPOINTS'; checkpoints: RuntimeCheckpointEntry[] }
  | { type: 'LIST_SKILLS' }
  | {
      type: 'SET_SKILL_MANIFESTS';
      manifests: import('@kite-ai/runtime-contract').SkillManifest[];
    }
  | { type: 'SWITCH_SESSION'; threadId: string }
  | { type: 'SET_SESSIONS'; sessions: TuiState['sessions'] }
  | { type: 'SET_SESSION_SERVICE_UNAVAILABLE'; unavailable: boolean }
  | { type: 'SESSION_INTERRUPT_PENDING'; threadId: string }
  | { type: 'DELETE_SESSION'; threadId: string }
  | { type: 'SET_INTERACTION_MODE'; mode: 'accept_edits' | 'auto' | 'full' | 'toggle' }
  | { type: 'TOGGLE_PLAN_MODE' }
  | { type: 'TOGGLE_TOOL_EXPAND'; id: number }
  | { type: 'TOGGLE_SUBAGENT_EXPAND'; id: number }
  | {
      type: 'RESOLVE_PLAN_REVIEW';
      resolution: { action: string; feedback?: string };
    };
