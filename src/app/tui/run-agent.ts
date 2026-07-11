import type { AgentConfig } from '@/core/config/index';
import { defaultCheckpointPath } from '@/core/config/paths';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { RunRuntimeAgentInput } from '@/core/runtime/agent';
import { runtimeStorePathFor } from '@/core/runtime/store';
import type { SandboxBackend } from '@/core/sandbox';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';

export interface BuildRunTaskParams {
  task: string;
  threadId: string;
  workspace: string;
  config: AgentConfig;
  shellExecutor: ShellExecutor;
  signal: AbortSignal;
  thinkingLevel: string | null;
  skills: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpManager | null;
  pendingSkillsContent: string;
  shellContext: string;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  phase?: 'planning' | 'building';
  sandboxBackend?: SandboxBackend | 'unknown';
  model?: SupportedChatModel;
}

/** Compatibility field is retained only for the TUI token-stat database path. */
export type TuiRuntimeInput = RunRuntimeAgentInput & { checkpointPath: string };

export function buildRunAgentParams(p: BuildRunTaskParams): TuiRuntimeInput {
  const checkpointPath = defaultCheckpointPath();
  return {
    task: p.pendingSkillsContent + p.task + p.shellContext,
    userId: 'tui-user',
    threadId: p.threadId,
    workspace: p.workspace,
    runtimeStorePath: runtimeStorePathFor(checkpointPath),
    checkpointPath,
    config: p.config,
    model: p.model,
    shellExecutor: p.shellExecutor,
    mcpManager: p.mcpManager ?? undefined,
    skills: p.skills,
    skillOptions: p.skillOptions ?? undefined,
    interactionMode: p.interactionMode,
    phase: p.phase,
    thinkingLevel: p.thinkingLevel,
    sandboxBackend: p.sandboxBackend,
    signal: p.signal,
    frontend: 'tui',
  };
}
