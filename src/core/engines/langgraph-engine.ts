import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import type { BuildCodeAgentGraphInput } from '@/core/harness/graph';
import { buildCodeAgentGraph } from '@/core/harness/graph';
import type { AgentLoopEngine, EngineChunk } from './engine';

/** Create the default LangGraph-backed engine.
 *  Wraps buildCodeAgentGraph behind the AgentLoopEngine interface. */
export function createLangGraphEngine(input: BuildCodeAgentGraphInput): AgentLoopEngine {
  const { graph, checkpointer } = buildCodeAgentGraph(input);

  return {
    async run(
      state: Record<string, unknown> | null,
      config?: RunnableConfig,
    ): Promise<AsyncIterable<EngineChunk>> {
      // graph.stream accepts null to continue from existing checkpoint
      return graph.stream(state, config ?? {}) as unknown as AsyncIterable<EngineChunk>;
    },

    async resume(
      command: Record<string, unknown>,
      config?: RunnableConfig,
    ): Promise<AsyncIterable<EngineChunk>> {
      return graph.stream(
        new Command(command),
        config ?? {},
      ) as unknown as AsyncIterable<EngineChunk>;
    },

    async updateState(
      config: RunnableConfig,
      values: Record<string, unknown>,
      asNode?: string,
    ): Promise<RunnableConfig> {
      return graph.updateState(config, values, asNode);
    },

    get checkpointer() {
      return checkpointer;
    },

    close(): void {
      checkpointer.close();
    },
  };
}
