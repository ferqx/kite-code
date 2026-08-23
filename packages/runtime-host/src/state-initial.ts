import type { AuthorizationSourceV1 } from '@kite/agent-kernel';
import {
  type AgentState,
  type AgentTaskState,
  type AgentToolCallState,
  type AgentToolResultMeta,
  createInitialAgentState,
  getActivePlanning as getKernelActivePlanning,
  getActiveTask as getKernelActiveTask,
  getEffectiveInteractionMode as getKernelEffectiveInteractionMode,
  type InteractionMode,
  type PlanningState,
  type WorkspaceAccess,
} from '@kite/agent-kernel';
import { createLiveRuntimeIdSourceV1, type RuntimeIdSourceV1 } from './runtime-id-source';

/**
 * Mutable construction view for State 25 fixtures and compatibility adapters.
 * The persisted schema and all validation remain owned by Agent Kernel.
 */
type MutableState<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { -readonly [Key in keyof T]: MutableState<T[Key]> }
      : T;

export type RuntimeState = MutableState<AgentState>;
export type TaskState = MutableState<AgentTaskState>;
export type ToolCallRecord = MutableState<AgentToolCallState>;
export type ToolCallStatus = AgentToolCallState['status'];
export type ToolResultMeta = AgentToolResultMeta;

export interface RuntimeHostStateInitialStateInputV1 {
  readonly threadId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
  readonly recoveryIdentityKey: string;
  readonly interactionMode?: InteractionMode;
  readonly authorizationMode?: 'default' | 'full_access';
  readonly authorizationSource?: AuthorizationSourceV1;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly phase?: 'planning' | 'building';
  /** Test callers may inject the same deterministic Host source. */
  readonly runtimeIdSource?: RuntimeIdSourceV1;
}

/**
 * Host composition wrapper for the current State 25 constructor.
 *
 * Agent Kernel receives only Host-supplied identity/time facts. This preserves
 * the former test input shape without reintroducing a second State owner.
 */
export function createRuntimeHostStateInitialStateV1(
  input: RuntimeHostStateInitialStateInputV1,
): RuntimeState {
  const source = input.runtimeIdSource ?? createLiveRuntimeIdSourceV1();
  const authorizationMode = input.authorizationMode ?? 'default';
  const base = {
    threadId: input.threadId,
    userId: input.userId,
    workspace: input.workspace,
    projectId: input.projectId,
    canonicalWorkspaceDigest: input.canonicalWorkspaceDigest,
    turnId: source.next('turn'),
    recoveryIdentityKey: input.recoveryIdentityKey,
    interactionMode: input.interactionMode,
    workspaceAccess: input.workspaceAccess,
    phase: input.phase,
  } as const;
  const state =
    authorizationMode === 'full_access'
      ? createInitialAgentState({
          ...base,
          authorizationMode,
          authorizationSource: input.authorizationSource ?? 'system',
          modeGrantedAt: new Date(source.now()).toISOString(),
        })
      : createInitialAgentState({
          ...base,
          authorizationMode: 'default',
          ...(input.authorizationSource === undefined
            ? {}
            : { authorizationSource: input.authorizationSource }),
        });
  return state;
}

export function getActiveTask(state: RuntimeState): TaskState | null {
  return getKernelActiveTask(state);
}

export function getActivePlanning(state: RuntimeState): PlanningState {
  return getKernelActivePlanning(state);
}

export function getEffectiveInteractionMode(state: RuntimeState): InteractionMode {
  return getKernelEffectiveInteractionMode(state);
}

/** Test-only pure projection helper; state authority remains Agent Kernel. */
export function setActivePlanning(state: RuntimeState, planning: PlanningState): RuntimeState {
  const activeTask = getKernelActiveTask(state);
  if (!activeTask) return state;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [activeTask.taskId]: { ...activeTask, planning },
    },
  };
}

export const RUNTIME_STATE_SCHEMA_VERSION = 26 as const;
export const RUNTIME_STATE_FORMAT_EPOCH = 'kite-runtime-modularization-v1-2026-08-19' as const;
