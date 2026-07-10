import type { AgentConfig } from '@/core/config/index';
import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { RuntimeEffectExecutor } from './kernel';

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  signal?: AbortSignal;
  subagentEventSink?: SubAgentEventSink;
}

/** Build the production executor for Kernel effects. */
export function createRuntimeEffectExecutor(
  dependencies: RuntimeExecutorDependencies,
): RuntimeEffectExecutor {
  return async (effect, state) => {
    if (effect.type === 'call_model') {
      return invokeRuntimeModel({
        model: dependencies.model,
        state,
        config: dependencies.config,
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        skills: dependencies.skills,
        skillOptions: dependencies.skillOptions,
        subagentEventSink: dependencies.subagentEventSink,
        signal: dependencies.signal,
      });
    }
    if (effect.type === 'run_tools') {
      return executeRuntimeTools({
        state,
        toolCallIds: effect.toolCallIds,
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        skillManifests: dependencies.skills,
        skillOptions: dependencies.skillOptions,
        signal: dependencies.signal,
        taskConfig: dependencies.config,
        taskModel: dependencies.model,
        subagentEventSink: dependencies.subagentEventSink,
      });
    }
    return [];
  };
}
