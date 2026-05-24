/**
 * 从 TUI 状态构建 runAgent / revertToCheckpoint / forkFromCheckpoint 参数。
 * 抽离出 index.tsx，使其可被单元测试覆盖，防止参数遗漏回归。
 */
import type { ShellExecutor } from "@/core/tools/shell";
import type { AgentConfig } from "@/core/config/index";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { McpManager } from "@/core/mcp";
import type { RunAgentInput, RevertInput, ForkInput } from "@/core/runner";
import { defaultCheckpointPath } from "@/core/config/paths";

export interface BaseTuiParams {
  threadId: string;
  workspace: string;
  config: AgentConfig;
  shellExecutor: ShellExecutor;
  signal: AbortSignal;
  thinkingLevel: string | null;
  skills: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpManager | null;
}

export interface BuildRunTaskParams extends BaseTuiParams {
  task: string;
  pendingSkillsContent: string;
  shellContext: string;
}

export interface BuildRewindParams extends BaseTuiParams {
  checkpointId: string;
}

export interface BuildForkParams extends BaseTuiParams {
  oldThreadId: string;
  checkpointId: string;
  newThreadId: string;
}

function baseParams(p: BaseTuiParams) {
  return {
    workspace: p.workspace,
    checkpointPath: defaultCheckpointPath(),
    config: p.config,
    shellExecutor: p.shellExecutor,
    signal: p.signal,
    thinkingLevel: p.thinkingLevel,
    mcpManager: p.mcpManager ?? undefined,
  };
}

export function buildRunAgentParams(p: BuildRunTaskParams): RunAgentInput {
  const fullTask = p.pendingSkillsContent + p.task + p.shellContext;
  return {
    ...baseParams(p),
    task: fullTask,
    userId: "tui-user",
    threadId: p.threadId,
    skills: p.skills,
    skillOptions: p.skillOptions ?? undefined,
  };
}

export function buildRevertParams(p: BuildRewindParams): RevertInput {
  return {
    ...baseParams(p),
    threadId: p.threadId,
    checkpointId: p.checkpointId,
  };
}

export function buildForkParams(p: BuildForkParams): ForkInput {
  return {
    ...baseParams(p),
    oldThreadId: p.oldThreadId,
    checkpointId: p.checkpointId,
    newThreadId: p.newThreadId,
  };
}
