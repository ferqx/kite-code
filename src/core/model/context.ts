import {
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
export function buildModelMessages(role: AgentRole, state: ModelContextState) {
  return prepareModelContext(role, state).messages;
}

/** 准备模型上下文（组装系统提示词 + 对话消息，接近阈值时清理旧工具结果） / Prepare model context (assemble, clear old tool results when near threshold) */
export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
): PreparedModelContext {
  let msgs = state.messages.length > 0
    ? state.messages
    : [new HumanMessage("")];

  // 工具结果清理：估计 token 接近窗口限制时清除旧工具结果 / Tool result clearing: clear old results when estimated tokens near window limit
  if (estimatePromptChars(role, { ...state, messages: msgs }) > CLEAR_THRESHOLD_CHARS) {
    msgs = clearOldToolResults(msgs, CLEAR_KEEP_RECENT);
  }

  return {
    contextSummary: state.contextSummary ?? "",
    messages: [
      new SystemMessage(buildStaticSystemPrompt(role)),
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
  while (fullStart > 0 && messages[fullStart] instanceof ToolMessage) {
    fullStart--;
  }

  const toSummarize = messages.slice(0, fullStart);
  const keepFull = messages.slice(fullStart);

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
  compactedMessages.push(...keepFull);

  return {
    messages: compactedMessages,
    summary: `Compacted ${toSummarize.length} earlier message(s) after context overflow.`,
  };
}

/** 构建静态系统提示词 / Build static system prompt */
export function buildStaticSystemPrompt(_role: AgentRole): string {
  return systemPrompt;
}

/** 构建动态系统上下文 / Build dynamic system context */
export function buildDynamicSystemContext(state: ModelContextState): string {
  return buildRuntimeContext(state);
}

/** 估算完整 prompt 的字符数，用于触发清理阈值 / Estimate full prompt character count for clearing threshold */
function estimatePromptChars(role: AgentRole, state: ModelContextState): number {
  let total = buildStaticSystemPrompt(role).length;
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
