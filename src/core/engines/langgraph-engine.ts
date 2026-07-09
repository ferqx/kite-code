import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import type { BuildCodeAgentGraphInput } from '@/core/harness/graph';
import { buildCodeAgentGraph } from '@/core/harness/graph';
import type { RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import type { ThreadAuthorizationState } from '@/core/types';
import type { AgentLoopEngine, EngineChunk } from './engine';

/** Create the default LangGraph-backed engine.
 *  Wraps buildCodeAgentGraph behind the AgentLoopEngine interface. */
export function createLangGraphEngine(input: BuildCodeAgentGraphInput): AgentLoopEngine {
  const { graph, checkpointer } = buildCodeAgentGraph(input);

  // Compute once at construction time for readLastAuthorization
  const runtimeStorePath = input.checkpointPath.replace(/\.sqlite$/, '') + '.runtime.db';

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

    // ── Checkpoint abstraction methods / Phase 5 checkpoint demotion ──

    async readLastAuthorization(threadId: string): Promise<ThreadAuthorizationState | null> {
      try {
        // Phase 5: Primary — RuntimeStore snapshot
        try {
          const store = createRuntimeStore(runtimeStorePath);
          const snapshot = store.loadSnapshot<RuntimeState>(threadId);
          store.close();
          if (snapshot?.authorization?.mode) {
            return {
              mode: snapshot.authorization.mode,
              commandGrants: snapshot.authorization.commandGrants ?? {},
            };
          }
        } catch {
          /* RuntimeStore not yet populated — fall back to checkpoint */
        }

        // Fallback: read from checkpoint (backward compat for pre-migration sessions)
        const tuple = await checkpointer.getTuple({
          configurable: { thread_id: threadId },
        });
        if (!tuple) return null;
        const auth = tuple.checkpoint.channel_values?.authorization as
          | ThreadAuthorizationState
          | undefined;
        if (!auth || typeof auth.mode !== 'string') return null;
        return auth;
      } catch {
        return null;
      }
    },

    async getExistingSessionConfig(threadId: string): Promise<RunnableConfig | null> {
      const tuple = await checkpointer.getTuple({
        configurable: { thread_id: threadId },
      });
      return tuple?.config ?? null;
    },

    async getCheckpointState(
      threadId: string,
      checkpointId: string,
    ): Promise<Record<string, unknown> | null> {
      return checkpointer.getCheckpointState(threadId, checkpointId) as Promise<Record<
        string,
        unknown
      > | null>;
    },

    close(): void {
      checkpointer.close();
    },
  };
}
