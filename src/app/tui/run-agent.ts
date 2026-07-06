/**
 * 从 TUI 状态构建 runAgent / revertToCheckpoint / forkFromCheckpoint 参数。
 * 抽离出 index.tsx，使其可被单元测试覆盖，防止参数遗漏回归。
 */

import type { AgentConfig } from '@/core/config/index';
import { defaultCheckpointPath } from '@/core/config/paths';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { ForkInput, RevertInput, RunAgentInput } from '@/core/runner';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { AuthorizationOverride } from '@/core/types';
import type { AgentPhase } from '@/protocol/events';

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
  /** 后台会话默认注入 full_access，避免中断阻塞 generator */
  authorizationOverride?: AuthorizationOverride;
}

export interface BuildRunTaskParams extends BaseTuiParams {
  task: string;
  pendingSkillsContent: string;
  shellContext: string;
  /** 当前 TUI phase，传入 core 由 tool policy 执行边界 / Current TUI phase enforced by core policy */
  initialPhase?: AgentPhase;
  interactionMode?: 'ask' | 'auto' | 'full';
  /** 可选的自定义模型实例（用于测试注入）/ Optional custom model instance (for test injection) */
  model?: SupportedChatModel;
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
    authorizationOverride: p.authorizationOverride,
  };
}

export function buildRunAgentParams(p: BuildRunTaskParams): RunAgentInput {
  const fullTask = p.pendingSkillsContent + p.task + p.shellContext;
  return {
    ...baseParams(p),
    task: fullTask,
    userId: 'tui-user',
    threadId: p.threadId,
    skills: p.skills,
    skillOptions: p.skillOptions ?? undefined,
    model: p.model,
    initialPhase: p.initialPhase,
    interactionMode: p.interactionMode,
    frontend: 'tui',
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
