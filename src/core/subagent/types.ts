// src/core/subagent/types.ts
import type { BaseMessage } from '@langchain/core/messages';
import type {
  SubAgentDonePayload,
  SubAgentErrorPayload,
  SubAgentRole,
  SubAgentStartPayload,
  SubAgentStepPayload,
  SubAgentToolResultPayload,
} from '@/protocol/events';

export type { SubAgentRole };

/** 子 agent 角色配置 */
export interface SubAgentRoleConfig {
  role: SubAgentRole;
  /** System prompt 文本 */
  systemPrompt: string;
  /** 允许使用的工具名称集合（undefined 表示全部可用） */
  allowedTools?: Set<string>;
  /** 可选独立模型（不指定则使用主 agent 模型）/ Optional model override for this role */
  model?: import('@/core/model/factory').SupportedChatModel;
  /** 可选超时毫秒（不指定则使用 SubAgentRunnerInput.timeoutMs）/ Optional timeout in milliseconds */
  timeoutMs?: number;
}

/** 子 agent 运行输入 / Sub-agent runner input */
export interface SubAgentRunnerInput {
  config: import('@/core/config/index').AgentConfig;
  workspace: string;
  role: SubAgentRoleConfig;
  task: string;
  shellExecutor?: import('@/core/tools/shell').ShellExecutor;
  mcpManager?: import('@/core/mcp').McpManager;
  skills?: import('@/core/skills/types').SkillManifest[];
  skillOptions?: import('@/core/skills/types').SkillScanOptions;
  authorization?: import('@/core/types').ThreadAuthorizationState;
  workspaceAccess?: import('@/protocol/events').WorkspaceAccess;
  phase?: import('@/protocol/events').AgentPhase;
  threadId?: string;
  model?: import('@/core/model/factory').SupportedChatModel;
  timeoutMs: number;
  signal: AbortSignal;
  eventSink: SubAgentEventSink;
  /** 当前嵌套深度（0 = 主 agent 直接派生）/ Current nesting depth (0 = spawned by main agent) */
  depth?: number;
  /** 最大允许嵌套深度（0 = 不允许子 agent 再派生）/ Max nesting depth (0 = no further nesting) */
  maxDepth?: number;
}

export interface SubAgentContinuation {
  id: string;
  role: SubAgentRoleConfig;
  task: string;
  messages: BaseMessage[];
  toolCallCount: number;
  steps: SubAgentStepSnapshot[];
}

/** 子 agent 步骤记录（用于持久化到 checkpoint） */
export interface SubAgentStepSnapshot {
  toolName: string;
  toolArgs: Record<string, unknown>;
  ok?: boolean;
  totalLines?: number;
}

/** 子 agent 运行结果 */
export interface SubAgentResult {
  ok: boolean;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
  blocked?: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL';
    toolCallId: string;
    toolName: string;
    command: string;
    args: Record<string, unknown>;
    message: string;
    continuation: SubAgentContinuation;
  };
  /** 步骤快照：用于会话重放时恢复步骤树 / Step snapshots for session replay */
  steps?: SubAgentStepSnapshot[];
}

/** 子 agent 缓存指标 / Sub-agent cache metrics */
export interface SubAgentCacheMetrics {
  subagentId: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  inputTokens: number;
}

/** 事件回调：子 agent 运行时向外推送生命周期事件 */
export type SubAgentEventSink = (
  event:
    | { type: 'start'; data: SubAgentStartPayload }
    | { type: 'step'; data: SubAgentStepPayload }
    | { type: 'tool_result'; data: SubAgentToolResultPayload }
    | { type: 'done'; data: SubAgentDonePayload }
    | { type: 'error'; data: SubAgentErrorPayload }
    | { type: 'cache_metrics'; data: SubAgentCacheMetrics },
) => void;
