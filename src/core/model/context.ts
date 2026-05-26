import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  buildCacheableRuntimeContext,
  buildRuntimeContext,
  formatWorkspaceAccessReminder,
  formatPlanStateReminder,
} from "./runtime-context";
import type { AgentPlan, WorkspaceAccess } from "@/protocol/events";
import {
  summarizeMessages,
  formatCompactedSummary,
} from "./summarizer";
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
  /** 工作区访问权限 / Workspace access level */
  workspaceAccess?: WorkspaceAccess;
  /** 执行计划 / Execution plan */
  plan?: AgentPlan | null;
  /** 上下文摘要 / Context summary */
  contextSummary?: string;
}

/** 工具结果清理触发阈值（字符数，≈ 48K tokens）/ Tool result clearing trigger threshold (chars, ≈ 48K tokens) */
const CLEAR_THRESHOLD_CHARS = 150000;

/** 工具结果清理时保留的最近 ToolMessage 数量 / Number of recent ToolMessages to keep when clearing */
const CLEAR_KEEP_RECENT = 6;

/** 准备好的模型上下文 / Prepared model context */
export interface PreparedModelContext {
  /** 组装好的消息列表 / Assembled message list */
  messages: BaseMessage[];
  /** 上下文摘要 / Context summary */
  contextSummary: string;
}

/** 构建模型消息列表 / Build model message list */
export function buildModelMessages(role: AgentRole, state: ModelContextState, skills?: SkillManifest[]) {
  return prepareModelContext(role, state, skills).messages;
}

/**
 * 确保 tool_call/ToolMessage 配对完整性：移除孤儿消息（有 tool_calls 无 ToolMessage 的 AIMessage
 * 保留文本内容但清空 tool_calls；移除无匹配 AIMessage 的孤儿 ToolMessage）。
 * 修复 checkpoint 中因中断/崩溃导致的消息不对齐，防止 DeepSeek API 400 错误。
 */
function sanitizeToolCallPairs(messages: BaseMessage[]): BaseMessage[] {
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
  let msgs = state.messages.length > 0
    ? sanitizeToolCallPairs(state.messages)
    : [new HumanMessage("")];

  // 工具结果清理：估计 token 接近窗口限制时清除旧工具结果 / Tool result clearing: clear old results when estimated tokens near window limit
  if (estimatePromptChars(role, { ...state, messages: msgs }, skills) > CLEAR_THRESHOLD_CHARS) {
    msgs = clearOldToolResults(msgs, CLEAR_KEEP_RECENT);
  }

  return {
    contextSummary: state.contextSummary ?? "",
    messages: [
      new SystemMessage(buildStaticSystemPrompt(role, skills)),
      new SystemMessage(buildCacheableRuntimeContext({ ...state, contextSummary: state.contextSummary ?? "" })),
      ...msgs,
      ...(state.workspaceAccess === "read-only"
        ? [new HumanMessage(formatWorkspaceAccessReminder(state.workspaceAccess))]
        : []),
      ...(state.plan
        ? [new HumanMessage(formatPlanStateReminder(state.plan))]
        : []),
    ],
  };
}

/** 强制压缩对话消息（仅由 context overflow 触发）/ Force compaction of conversation messages (only triggered by context overflow) */
export function forceContextCompaction(
  messages: BaseMessage[],
): { messages: BaseMessage[]; summary: string } {
  const KEEP_FULL = 8;

  let fullStart = Math.max(0, messages.length - KEEP_FULL);

  // Walk back past leading ToolMessages at the split boundary
  while (fullStart > 0 && messages[fullStart] instanceof ToolMessage) {
    fullStart--;
  }

  // Ensure tool_call/ToolMessage pair integrity: if keepFull contains
  // any ToolMessage whose matching AIMessage landed in toSummarize, we
  // must expand the boundary to include that AIMessage.
  // Otherwise the model API rejects the request with:
  //   "An assistant message with 'tool_calls' must be followed by
  //    tool messages responding to each 'tool_call_id'"
  const keepFull = messages.slice(fullStart);
  const orphanedToolIds = new Set<string>();
  for (const msg of keepFull) {
    if (msg instanceof ToolMessage) {
      orphanedToolIds.add(msg.tool_call_id);
    }
  }

  // Walk fullStart backwards to find matching AIMessages for orphaned ToolMessages
  let expandedStart = fullStart;
  for (let i = fullStart - 1; i >= 0 && orphanedToolIds.size > 0; i--) {
    const msg = messages[i];
    if (msg instanceof AIMessage && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (orphanedToolIds.has(tc.id ?? "")) {
          orphanedToolIds.delete(tc.id ?? "");
          expandedStart = Math.min(expandedStart, i);
        }
      }
    }
  }

  fullStart = expandedStart;

  const toSummarize = messages.slice(0, fullStart);
  const finalKeepFull = messages.slice(fullStart);

  if (toSummarize.length === 0) {
    return {
      messages,
      summary: "",
    };
  }

  const summaries = summarizeMessages(toSummarize);
  const compactedMessages: BaseMessage[] = [];

  if (summaries.length > 0) {
    const conciseText = formatCompactedSummary(summaries, "concise");
    compactedMessages.push(new HumanMessage(conciseText));
  }
  compactedMessages.push(...finalKeepFull);

  return {
    messages: compactedMessages,
    summary: `Compacted ${toSummarize.length} earlier message(s) after context overflow.`,
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

/** 构建动态系统上下文 / Build dynamic system context */
export function buildDynamicSystemContext(state: ModelContextState): string {
  return buildRuntimeContext(state);
}

/** 估算完整 prompt 的字符数，用于触发清理阈值 / Estimate full prompt character count for clearing threshold */
function estimatePromptChars(role: AgentRole, state: ModelContextState, skills?: SkillManifest[]): number {
  let total = buildStaticSystemPrompt(role, skills).length;
  total += buildCacheableRuntimeContext({ ...state, contextSummary: state.contextSummary ?? "" }).length;
  for (const msg of state.messages) {
    total += textContent(msg.content).length;
  }
  if (state.workspaceAccess === "read-only") {
    total += formatWorkspaceAccessReminder(state.workspaceAccess).length;
  }
  if (state.plan) {
    total += formatPlanStateReminder(state.plan).length;
  }
  return total;
}

/** 清理旧工具结果，仅保留最近 N 条 ToolMessage 的完整内容 / Clear old tool results, keeping only the last N ToolMessages intact */
export function clearOldToolResults(messages: BaseMessage[], keepRecent: number): BaseMessage[] {
  const result = [...messages];
  let kept = 0;

  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] instanceof ToolMessage) {
      const tm = result[i] as ToolMessage;
      if (kept < keepRecent) {
        kept++;
      } else {
        result[i] = new ToolMessage({
          content: "[tool result cleared to save context]",
          tool_call_id: tm.tool_call_id,
          status: tm.status,
        });
      }
    }
  }

  return result;
}

/** 提取消息文本内容 / Extract message text content */
function textContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
