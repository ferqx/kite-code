import type {
  McpRuntimeProvider,
  RemoteMcpEgressPermitResolverV1,
} from '@kite/builtin-runtime/mcp';
import {
  createChatModel,
  createModelSecretDetectorV1,
  type SupportedChatModel,
} from '@kite/builtin-runtime/model';
import type { ShellExecutor } from '@kite/builtin-runtime/sandbox';
import type { SkillManifest, SkillScanOptions } from '@kite/runtime-contract';
import type { State25AuthorizationSourceV1 } from '@kite/runtime-host';
import type { AgentConfig } from '#app/config/index';
import { defaultCheckpointPath } from '#app/config/paths';
import type { SandboxBackend } from '#app/sandbox/types';
import type { RuntimeTurnInputV1 } from './turn-coordinator';

export interface BuildRunTaskParams {
  task: string;
  threadId: string;
  workspace: string;
  config: AgentConfig;
  shellExecutor: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
  signal: AbortSignal;
  thinkingLevel: string | null;
  skills: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  mcpManager: McpRuntimeProvider | null;
  remoteMcpEgressPermitResolver?: RemoteMcpEgressPermitResolverV1;
  shellContext: string;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  authorizationMode?: import('@kite/runtime-contract').AuthorizationMode;
  authorizationSource?: State25AuthorizationSourceV1;
  phase?: 'planning' | 'building';
  sandboxBackend?: SandboxBackend | 'unknown';
  model?: SupportedChatModel;
}

/** Compatibility field is retained only for the TUI token-stat database path. */
export type TuiRuntimeInput = Omit<
  RuntimeTurnInputV1,
  'modelInvocationRuntime' | 'runtimeSession' | 'createRuntimeEffectPort' | 'recoveryIdentityKey'
> & {
  checkpointPath: string;
};

export function buildRunAgentParams(p: BuildRunTaskParams): TuiRuntimeInput {
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
    remoteMcpEgressPermitResolver: p.remoteMcpEgressPermitResolver,
    skills: p.skills,
    skillOptions: p.skillOptions ?? undefined,
    initialSkillActivations: p.initialSkillActivations,
    interactionMode: p.interactionMode,
    authorizationMode: p.authorizationMode,
    authorizationSource: p.authorizationSource,
    phase: p.phase,
    thinkingLevel: p.thinkingLevel,
    sandboxBackend: p.sandboxBackend,
    signal: p.signal,
    frontend: 'tui',
    sessionLoggingPolicy: p.config.sessionLoggingPolicy,
    sessionLoggingContentInspector: createModelSecretDetectorV1({
      knownSecrets: [p.config.apiKey],
    }),
  };
}
