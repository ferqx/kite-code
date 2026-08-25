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
  RUNTIME_STATE_FORMAT_EPOCH as KERNEL_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION as KERNEL_STATE_SCHEMA_VERSION,
  type PlanningState,
  type WorkspaceAccess,
} from '@kite-ai/agent-kernel';
import { createLiveRuntimeIdSource, type RuntimeIdSource } from '../runtime-id-source';

/**
 * Mutable construction view for State 27 fixtures and compatibility adapters.
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

export interface RuntimeHostStateInitialStateInput {
  readonly threadId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId?: string;
  readonly canonicalWorkspaceDigest?: string;
  readonly recoveryIdentityKey: string;
  readonly interactionMode?: InteractionMode;
  readonly workspaceAccess?: WorkspaceAccess;
  readonly phase?: 'planning' | 'building';
  /** Test callers may inject the same deterministic Host source. */
  readonly runtimeIdSource?: RuntimeIdSource;
}

/**
 * Host composition wrapper for the current State 27 constructor.
 *
 * Agent Kernel receives only Host-supplied identity/time facts. This preserves
 * the former test input shape without reintroducing a second State owner.
 */
export function createRuntimeHostStateInitialState(
  input: RuntimeHostStateInitialStateInput,
): RuntimeState {
  const source = input.runtimeIdSource ?? createLiveRuntimeIdSource();
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
  return createInitialAgentState(base);
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

export const RUNTIME_STATE_SCHEMA_VERSION = KERNEL_STATE_SCHEMA_VERSION;
export const RUNTIME_STATE_FORMAT_EPOCH = KERNEL_STATE_FORMAT_EPOCH;
