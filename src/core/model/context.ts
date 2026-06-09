import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { buildCacheableRuntimeContext, formatPlanStateReminder } from "./runtime-context";
import type { AgentPlan } from "@/protocol/events";
import systemPrompt from "@/core/prompts/system-prompt.txt";
import type { SkillManifest } from "@/core/skills/types";
/** Agent 角色定义 / Agent role definition */
export type AgentRole = "agent";

/** 模型上下文状态输入 / Model context state input */
export interface ModelContextState {
  /** 工作目录 / Workspace path */
  workspace: string;
  /** 对话消息列表 / Conversation messages */
  messages: BaseMessage[];
  /** 最终回答文本 / Final answer text */
  final: string;
  /** 工作区访问权限 / Workspace access level (always "write") */
  workspaceAccess?: "write";
  /** 执行计划 / Execution plan */
  plan?: AgentPlan | null;
  /** 激活的 Skill 关键指令 / Active skill critical instructions */
  activeSkillInstructions?: string;
}

/** 准备好的模型上下文 / Prepared model context */
export interface PreparedModelContext {
  /** 组装好的消息列表 / Assembled message list */
  messages: BaseMessage[];
}

/** 构建模型消息列表 / Build model message list */
export function buildModelMessages(role: AgentRole, state: ModelContextState, skills?: SkillManifest[]): BaseMessage[] {
  return prepareModelContext(role, state, skills).messages;
}

/**
 * 确保 tool_call/ToolMessage 配对完整性：移除孤儿消息（有 tool_calls 无 ToolMessage 的 AIMessage
 * 保留文本内容但清空 tool_calls；移除无匹配 AIMessage 的孤儿 ToolMessage）。
 *
 * 这是 LangGraph interrupt 模型下的正常防御层（非 bug workaround）：
 * - 当 agent 被 interrupt 挂起时，LangGraph 会将未完成的 AIMessage（带 tool_calls）写入 checkpoint，
 *   resume 后这些消息仍在对话历史中，但对应的 ToolMessage 可能不存在（由 resume 路径注入）。
 * - 此函数在每次重建上下文时清理这些结构不完整的配对，防止 DeepSeek API 400 错误。
 *
 * This is a normal defense layer for LangGraph's interrupt model (not a bug workaround):
 * - When the agent is suspended by interrupt, LangGraph writes the pending AIMessage (with tool_calls)
 *   to the checkpoint. After resume, these messages remain but matching ToolMessages may be missing.
 * - This function cleans up incomplete pairs on every context rebuild to prevent API 400 errors.
 */
export function sanitizeToolCallPairs(messages: BaseMessage[]): BaseMessage[] {
  // Collect all tool_call_ids from AIMessages in the list
  const aiToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg instanceof AIMessage && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id) aiToolCallIds.add(tc.id);
      }
    }
  }

  // Collect all tool_call_ids from ToolMessages in the list
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg instanceof ToolMessage) {
      toolResultIds.add(msg.tool_call_id);
    }
  }

  // Fix orphaned AIMessages: strip tool_calls that have no matching ToolMessage
  // Fix orphaned ToolMessages: remove those with no matching AIMessage
  const result: BaseMessage[] = [];
  for (const msg of messages) {
    if (msg instanceof AIMessage && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const orphaned = msg.tool_calls.some((tc) => tc.id && !toolResultIds.has(tc.id));
      if (orphaned) {
        const validCalls = msg.tool_calls.filter((tc) => !tc.id || toolResultIds.has(tc.id));
        const newMsg = new AIMessage({
          id: msg.id,
          content: msg.content,
          tool_calls: validCalls,
          additional_kwargs: { ...msg.additional_kwargs, tool_calls: [] },
          response_metadata: msg.response_metadata,
          usage_metadata: msg.usage_metadata,
        });
        result.push(newMsg);
        continue;
      }
    }
    if (msg instanceof ToolMessage && !aiToolCallIds.has(msg.tool_call_id)) {
      // Orphaned ToolMessage — skip it
      continue;
    }
    result.push(msg);
  }

  return result;
}

/** 准备模型上下文（组装系统提示词 + 对话消息，接近阈值时清理旧工具结果） / Prepare model context (assemble, clear old tool results when near threshold) */
export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
  skills?: SkillManifest[],
): PreparedModelContext {
  const msgs = state.messages.length > 0
    ? sanitizeToolCallPairs(state.messages)
    : [new HumanMessage("")];

  // 合并静态系统提示词与可缓存运行时上下文为单个 SystemMessage，
  // 避免依赖 LangChain 内部的连续 SystemMessage 合并行为。
  // Merge static system prompt and cacheable runtime context into one SystemMessage
  // to avoid relying on LangChain's internal consecutive SystemMessage merging.
  const systemPrompt = buildStaticSystemPrompt(role, skills)
    + "\n\n"
    + buildCacheableRuntimeContext({ workspace: state.workspace });

  return {
    messages: [
      new SystemMessage(systemPrompt),
      ...msgs,
      ...(state.plan
        ? [new HumanMessage(formatPlanStateReminder(state.plan))]
        : []),
    ],
  };
}

/** 构建静态系统提示词 / Build static system prompt */
export function buildStaticSystemPrompt(
  _role: AgentRole,
  skills?: SkillManifest[],
): string {
  const base = systemPrompt;
  if (!skills || skills.length === 0) return base;

  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  const section = [
    "",
    "## Available Skills",
    "",
    "The following skills are available. Use the `Skill` tool to invoke a skill when its",
    "description matches your task. Invoking a skill loads detailed instructions you MUST follow.",
    "",
    ...lines,
    "",
    "IMPORTANT: If there is even a 1% chance a skill might apply, invoke it.",
  ].join("\n");

  return base + section;
}

