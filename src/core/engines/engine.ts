import type { RunnableConfig } from '@langchain/core/runnables';
import type { ThreadAuthorizationState } from '@/core/types';

/** A single chunk from the agent engine stream.
 *  Shape matches LangGraph's updates-mode stream output:
 *  { node_name: { messages, workspaceAccess, ... } }
 *  Consumers (e.g. processStream) parse these chunks identically to raw graph.stream output. */
export type EngineChunk = Record<string, unknown>;

/** Engine abstraction over the agent loop graph.
 *  Wraps the low-level LangGraph graph + checkpointer behind a stable interface
 *  so callers don't couple to the graph implementation. */
export interface AgentLoopEngine {
  /** Start or continue the agent graph from the given state.
   *  Pass `null` to continue from an existing checkpoint. */
  run(
    state: Record<string, unknown> | null,
    config?: RunnableConfig,
  ): Promise<AsyncIterable<EngineChunk>>;

  /** Resume the agent graph with a command (e.g. interrupt response). */
  resume(
    command: Record<string, unknown>,
    config?: RunnableConfig,
  ): Promise<AsyncIterable<EngineChunk>>;

  /** Update state for an existing thread. Wraps the graph's updateState. */
  updateState(
    config: RunnableConfig,
    values: Record<string, unknown>,
    asNode?: string,
  ): Promise<RunnableConfig>;

  /** Read the last authorization state for a thread.
   *  Primary source: RuntimeStore snapshot. Fallback: LangGraph checkpoint
   *  (backward compat for sessions created before the Phase 5 RuntimeStore migration). */
  readLastAuthorization(threadId: string): Promise<ThreadAuthorizationState | null>;

  /** Check whether a checkpoint session exists for the given thread.
   *  Returns the stored RunnableConfig if one exists, or null.
   *  Used to determine whether to continue an existing session or start fresh. */
  getExistingSessionConfig(threadId: string): Promise<RunnableConfig | null>;

  /** Read a specific checkpoint's state for revert / fork operations.
   *  Returns null if the checkpoint does not exist. */
  getCheckpointState(
    threadId: string,
    checkpointId: string,
  ): Promise<Record<string, unknown> | null>;

  /** Release resources (checkpointer connection, etc.). */
  close(): void;
}
