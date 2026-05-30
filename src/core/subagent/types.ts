// src/core/subagent/types.ts
import type { SubAgentRole, SubAgentStartPayload, SubAgentStepPayload, SubAgentToolResultPayload, SubAgentDonePayload, SubAgentErrorPayload } from "@/protocol/events";

export type { SubAgentRole };

/** 子 agent 角色配置 */
export interface SubAgentRoleConfig {
  role: SubAgentRole;
  /** System prompt 文本 */
  systemPrompt: string;
  /** 允许使用的工具名称集合（undefined 表示全部可用） */
  allowedTools?: Set<string>;
}

/** 子 agent 运行结果 */
export interface SubAgentResult {
  ok: boolean;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
}

/** 事件回调：子 agent 运行时向外推送生命周期事件 */
export type SubAgentEventSink = (event:
  | { type: "start"; data: SubAgentStartPayload }
  | { type: "step"; data: SubAgentStepPayload }
  | { type: "tool_result"; data: SubAgentToolResultPayload }
  | { type: "done"; data: SubAgentDonePayload }
  | { type: "error"; data: SubAgentErrorPayload }
) => void;
