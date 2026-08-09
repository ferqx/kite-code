// src/core/subagent/types.ts
import type { BaseMessage } from '@/core/messages';
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
  mcpManager?: import('@/core/mcp').McpRuntimeProvider;
  skills?: import('@/core/skills/types').SkillManifest[];
  skillOptions?: import('@/core/skills/types').SkillScanOptions;
  mcpBindings?: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
  /** Explicit capability-derived tool ceiling for a governed caller. */
  allowedTools?: Set<string>;
  authorization?: import('@/core/types').ThreadAuthorizationState;
  workspaceAccess?: import('@/protocol/events').WorkspaceAccess;
  phase?: import('@/protocol/events').AgentPhase;
  /** Project instructions visible to the parent model when this sub-agent was dispatched. */
  projectInstructions?: import('@/core/model/project-instructions').ProjectInstructionSnapshot;
  threadId?: string;
  model?: import('@/core/model/factory').SupportedChatModel;
  providerDataAdmission?: import('@/core/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: import('@/core/runtime/resource-budget-admission').DescendantResourceAdmissionV1;
  timeoutMs: number;
  signal: AbortSignal;
  eventSink: SubAgentEventSink;
  /** 当前嵌套深度（0 = 主 agent 直接派生）/ Current nesting depth (0 = spawned by main agent) */
  depth?: number;
  /** 最大允许嵌套深度（0 = 不允许子 agent 再派生）/ Max nesting depth (0 = no further nesting) */
  maxDepth?: number;
  /** 写入前文件原像记录器（ADR-0042 §4），透传给工具执行。 */
  recordFilePreimage?: import('@/core/runtime/file-checkpoints').FilePreimageRecorder;
}

export interface SubAgentContinuation {
  id: string;
  role: SubAgentRoleConfig;
  task: string;
  messages: BaseMessage[];
  toolCallCount: number;
  steps: SubAgentStepSnapshot[];
  /** Phase 5: journal state preserved across approval round-trips */
  executionJournal?: import('@/core/execution/journal').ExecutionJournalEntry[];
  exhaustedFingerprints?: Record<string, true>;
  projectInstructions?: import('@/core/model/project-instructions').ProjectInstructionSnapshot;
}

/** 已暂停子 agent 的待执行工具 / Pending tool preserved with a suspended continuation */
export interface SubAgentBlockedTool {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  command: string;
}

/** 从持久化快照恢复的 continuation，包含恢复前必须执行的阻塞工具 */
export interface RestoredSubAgentContinuation extends SubAgentContinuation {
  blockedTool: SubAgentBlockedTool;
}

/** 子 agent 步骤记录（用于持久化到 checkpoint）
 *  status 与 TUI 的 SubAgentStepRecord.status 保持一致 */
export interface SubAgentStepSnapshot {
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** 步生命周期状态（与 TUI SubAgentStepRecord.status 同步） */
  status: 'pending' | 'awaiting_approval' | 'success' | 'rejected' | 'error';
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
  /** Phase 5: 子 Agent 工具执行的 journal 条目 / Journal entries from subagent tool executions */
  executionJournal?: import('@/core/execution/journal').ExecutionJournalEntry[];
  /** Phase 5: 子 Agent 中已耗尽的操作指纹 / Exhausted fingerprints detected in subagent */
  exhaustedFingerprints?: Record<string, true>;
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
