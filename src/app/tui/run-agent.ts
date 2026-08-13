import type { AgentConfig } from '@/core/config/index';
import { defaultCheckpointPath } from '@/core/config/paths';
import type { McpRuntimeProvider, RemoteMcpEgressPermitResolverV1 } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { RunRuntimeAgentInput } from '@/core/runtime/agent';
import { runtimeStorePathFor } from '@/core/runtime/store';
import type { SandboxBackend } from '@/core/sandbox';
import { createRuntimeSecretDetectorV1 } from '@/core/session-logger';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';

export interface BuildRunTaskParams {
  task: string;
  threadId: string;
  workspace: string;
  config: AgentConfig;
  shellExecutor: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  signal: AbortSignal;
  thinkingLevel: string | null;
  skills: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>;
  mcpManager: McpRuntimeProvider | null;
  remoteMcpEgressPermitResolver?: RemoteMcpEgressPermitResolverV1;
  shellContext: string;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  authorizationMode?: import('@/protocol/events').AuthorizationMode;
  authorizationSource?: import('@/core/types').AuthorizationSource;
  phase?: 'planning' | 'building';
  sandboxBackend?: SandboxBackend | 'unknown';
  model?: SupportedChatModel;
}

/** Compatibility field is retained only for the TUI token-stat database path. */
export type TuiRuntimeInput = RunRuntimeAgentInput & { checkpointPath: string };

export function buildRunAgentParams(p: BuildRunTaskParams): TuiRuntimeInput {
  const checkpointPath = defaultCheckpointPath();
  return {
    task: p.task + p.shellContext,
    userGoal: p.task,
    userId: 'tui-user',
    threadId: p.threadId,
    workspace: p.workspace,
    runtimeStorePath: runtimeStorePathFor(checkpointPath),
    checkpointPath,
    config: p.config,
    model: p.model,
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
    sessionLoggingContentInspector: createRuntimeSecretDetectorV1({
      knownSecrets: [p.config.apiKey],
    }),
  };
}
