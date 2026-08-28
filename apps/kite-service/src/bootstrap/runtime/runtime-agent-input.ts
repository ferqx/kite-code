import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import {
  createChatModel,
  createModelSecretDetector,
  type SupportedChatModel,
} from '@kite-ai/builtin-runtime/model';
import type { ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { SkillManifest, SkillScanOptions } from '@kite-ai/runtime-contract';
import type { AgentConfig } from '#kite-service/config/index';
import { defaultCheckpointPath } from '#kite-service/config/paths';
import type { SandboxBackend } from '#kite-service/sandbox/types';
import type { RuntimeTurnInput } from './turn-coordinator';

export interface BuildRunTaskParams {
  task: string;
  threadId: string;
  workspace: string;
  config: AgentConfig;
  shellExecutor: ShellExecutor;
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
  signal: AbortSignal;
  thinkingLevel: string | null;
  skills: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  mcpManager: McpRuntimeProvider | null;
  shellContext: string;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  phase?: 'planning' | 'building';
  sandboxBackend?: SandboxBackend | 'unknown';
  model?: SupportedChatModel;
}

/** Service runtime input retained for the relocated session execution path. */
export type ServiceRuntimeInput = Omit<
  RuntimeTurnInput,
  'modelInvocationRuntime' | 'runtimeSession' | 'createRuntimeEffectPort' | 'recoveryIdentityKey'
> & {
  checkpointPath: string;
};

export function buildRunAgentParams(p: BuildRunTaskParams): ServiceRuntimeInput {
  const checkpointPath = defaultCheckpointPath();
  return {
    task: p.task + p.shellContext,
    userGoal: p.task,
    userId: 'tui-user',
    threadId: p.threadId,
    workspace: p.workspace,
    checkpointPath,
    config: p.config,
    model:
      p.model ??
      createChatModel({
        ...p.config,
        reasoningEffort: p.thinkingLevel ?? p.config.reasoningEffort ?? null,
      }),
    shellExecutor: p.shellExecutor,
    gitBroker: p.gitBroker,
    mcpManager: p.mcpManager ?? undefined,
    skills: p.skills,
    skillOptions: p.skillOptions ?? undefined,
    initialSkillActivations: p.initialSkillActivations,
    interactionMode: p.interactionMode,
    phase: p.phase,
    thinkingLevel: p.thinkingLevel,
    sandboxBackend: p.sandboxBackend,
    signal: p.signal,
    frontend: 'tui',
    sessionLoggingPolicy: p.config.sessionLoggingPolicy,
    sessionLoggingContentInspector: createModelSecretDetector({
      knownSecrets: [p.config.apiKey],
    }),
  };
}
