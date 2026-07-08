import type { RunnableConfig } from '@langchain/core/runnables';
import type { BunSqliteSaver } from '@/core/persistence/checkpoint';

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

  /** The underlying checkpointer. Exposed for callers that need direct access
   *  (e.g. reading authorization state, revert/fork checkpoint lookups). */
  readonly checkpointer: BunSqliteSaver;

  /** Release resources (checkpointer connection, etc.). */
  close(): void;
}
