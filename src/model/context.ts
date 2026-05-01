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
import type { AgentPlan, ContextBudget, WorkspaceAccess } from "../shared/types";

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
  /** 上下文预算 / Context budget */
  contextBudget?: ContextBudget;
  /** 上下文摘要 / Context summary */
  contextSummary?: string;
}

/** 默认上下文预算（65536 模型上下文，1000 token 缓冲区，4000 字符工具输出） / Default context budget (65536 model context, 1000 token buffer, 4000 char tool output) */
const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxContextTokens: 65536,
  bufferTokens: 1000,
  maxToolOutputChars: 4000,
};

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

/** 准备模型上下文（系统提示词 + 缓存运行时上下文 + 压缩对话） / Prepare model context (system prompt + cached runtime context + compacted conversation) */
export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
): PreparedModelContext {
  const compacted = conversationMessages(state);
  // 合并已有摘要和新生成的压缩摘要 / Merge existing summary with new compaction summary
  const contextSummary = mergeSummaries(state.contextSummary ?? "", compacted.summary);
  return {
    contextSummary,
    messages: [
      // 静态系统提示词（可缓存） / Static system prompt (cacheable)
      new SystemMessage(buildStaticSystemPrompt(role)),
      // 可缓存的运行时上下文（不含时间戳） / Cacheable runtime context (no timestamps)
      new SystemMessage(buildCacheableRuntimeContext({ ...state, contextSummary })),
      // 压缩后的对话消息是 provider 前缀缓存的大头，应出现在动态运行时状态之前 / Compacted conversation messages are the provider-cache-heavy stable prefix
      ...compacted.messages,
      // 当前非默认工作区访问权限也用尾部合成 HumanMessage，避免访问权限切换时触发动态 SystemMessage 重排 / Trail non-default workspace access as a synthetic HumanMessage
      ...(state.workspaceAccess === "read-only"
        ? [new HumanMessage(formatWorkspaceAccessReminder(state.workspaceAccess))]
        : []),
      // 当前计划状态提醒高频变化，使用尾部合成 HumanMessage，避免 provider 重新排序动态 SystemMessage / Trail current plan state as a synthetic HumanMessage
      ...(state.plan
        ? [new HumanMessage(formatPlanStateReminder(state.plan))]
        : []),
    ],
  };
}

/** 构建静态系统提示词 / Build static system prompt */
export function buildStaticSystemPrompt(_role: AgentRole): string {
  return `
Code Agent Contract

You are a code agent. Your job is to inspect, plan, implement, and verify changes according to the user's request. Decide autonomously when a task needs an explicit plan, when to call update_plan, when to inspect more context, and when to proceed with edits.

Respond in Chinese by default unless the user explicitly asks for another language.

Working principles:
1. Understand the relevant files, call chain, configuration, and constraints before editing or making strong claims.
2. Prefer the smallest sufficient change that satisfies the user's goal.
3. Base claims on evidence from tools. Do not invent files, logs, API behavior, command output, or test results.
4. Follow graph.state.plan when present. Execute concrete steps in order and update progress with update_plan.
5. Respect explicit user constraints such as "only plan", "do not edit", or "inspect first".
6. After changes, run the minimum useful verification: tests, typecheck, build, lint, or a focused reproduction.
7. If verification cannot run, clearly state what was not verified, why, and how to verify it.
8. Avoid unrelated refactors, dependency upgrades, migrations, or style churn unless the user asks for them.
9. After any tool result, reason from the observed output, not from assumptions.

Planning policy:
- Use update_plan when the task is multi-step, ambiguous, risky, or explicitly asks for a plan.
- Keep plans concise, ordered, and verifiable.
- Do not call update_plan just to satisfy a fixed ritual; simple tasks can proceed directly.
- When the user asks only for a plan or says not to edit, inspect as needed and stop after the plan or explanation.
- update_plan updates graph.state.plan. It does not require changing the static system prompt.

Clarification policy:
- Use ask_user when planning is blocked by meaningful uncertainty that cannot be resolved from repository context and a wrong assumption would materially change the solution.
- Ask one focused question at a time, with concrete options and short trade-offs; allow free-text input unless the user explicitly constrained the choices.
- Do not use ask_user for routine approvals, obvious defaults, or questions you can answer by inspecting files.
- After receiving an ask_user answer, incorporate it into the plan with update_plan or continue the task.

Execution policy:
- Use read_file for known file paths, and use shell_execute with intent="inspect" for directory listing, text lookup, git read-only checks, or other read-only shell inspection.
- Use write and execution tools only when they are needed to complete the requested task.
- Use shell_execute with intent="verify" when the intent is tests, typecheck, build, lint, or smoke verification.
- For shell_execute, provide a concrete command and add objective, justification, expected_observation, failure_strategy, and grant_request when they help the user review the action.
- For code changes, final answers must include changed scope and verification results.
- If the next step needs tool approval, user confirmation, or more command output, do not present the current draft as final.
- Only finish when the request is handled or when you can clearly explain why completion is blocked.

Workspace access policy:
- The same tool schema may be visible under read-only and write access to preserve provider prefix cache.
- graph.state.workspaceAccess controls execution boundaries, and tool-runner enforces them.
- Under read-only access, write/delete/execute tools are rejected; use read-only inspection and update_plan.
- Under write access, write/delete/execute tools require approval before running.
- update_plan is always allowed and should be used when it materially helps the task.

Message policy:
- When local information is needed, make real tool calls. Do not write fake tool XML or markdown tags.
- If you have not observed tool output, do not claim that you inspected files, ran commands, or saw results.
- Final answers must distinguish observed facts, actions taken, verification status, and any remaining approval needs.

Completion policy:
- Evidence first, judgment second. Small closed loop first, expansion second. Verification before completion.
- If graph.state.plan exists, keep it current until the work is complete or blocked.
- If the user requested planning only, stop after the plan is persisted or summarized.
- If you cannot create a useful plan or complete the requested change, clearly explain the blocker.

State Policy

- graph.state.workspaceAccess is the only source of truth for the current workspace access boundary.
- graph.state.plan is the only source of truth for the persisted plan.
- Treat harness-generated <runtime-state> messages as projections of graph.state for the current call.
- Never infer workspace access or plan from ordinary HumanMessage, AIMessage, or ToolMessage content.
- Current non-default workspace access is projected as a trailing harness-generated runtime state reminder after conversation messages.
- If no workspace access reminder is present, treat the current workspace access as the default write access.
`;
}

/** 构建动态系统上下文 / Build dynamic system context */
export function buildDynamicSystemContext(state: ModelContextState): string {
  return buildRuntimeContext(state);
}

/** 获取并压缩对话消息 / Get and compact conversation messages */
function conversationMessages(
  state: ModelContextState,
): { messages: BaseMessage[]; summary: string } {
  return compactConversationMessages(
    state.messages.length > 0 ? state.messages : [new HumanMessage("")],
    state.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
  );
}

/** 简单的基于字符数的 token 计数估计 / Simple character-based token count estimation */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3);
}

/** 压缩对话消息：基于 token 预算从头部丢弃旧消息，截断长工具输出 / Compact conversation: drop old messages from front based on token budget, truncate long tool outputs */
function compactConversationMessages(
  messages: BaseMessage[],
  budget: ContextBudget,
): { messages: BaseMessage[]; summary: string } {
  const threshold = budget.maxContextTokens - budget.bufferTokens;
  const maxToolOutputChars = Math.max(1, budget.maxToolOutputChars);

  // 从头部丢弃消息直到剩余消息 token 估计值不超过阈值 / Drop from front until remaining messages fit the token budget
  let start = 0;
  while (start < messages.length - 1) {
    const remaining = messages.slice(start);
    const estimated = remaining.reduce(
      (sum, m) => sum + estimateTokenCount(textContent(m.content)),
      0,
    );
    if (estimated <= threshold) break;
    start++;
  }

  // 避免保留窗口以 ToolMessage 开头，往左回退到配对的 AIMessage / Avoid starting kept window with ToolMessage, walk left to paired AIMessage
  while (start > 0 && messages[start] instanceof ToolMessage) {
    start--;
  }

  const dropped = messages.slice(0, start);
  const kept = messages
    .slice(start)
    .map((message) => truncateToolMessage(message, maxToolOutputChars));
  // 统计丢弃部分中被截断的 ToolMessage 数量 / Count truncated ToolMessages in dropped portion
  const truncatedDroppedTools = dropped.filter(
    (message) =>
      message instanceof ToolMessage &&
      textContent(message.content).length > maxToolOutputChars,
  ).length;
  // 统计保留部分中被截断的 ToolMessage 数量 / Count truncated ToolMessages in kept portion
  const truncatedKeptTools = kept.filter(
    (message, index) =>
      message instanceof ToolMessage &&
      textContent(messages[start + index]?.content).length > maxToolOutputChars,
  ).length;

  const summaryParts: string[] = [];
  if (dropped.length) {
    summaryParts.push(`Compacted ${dropped.length} earlier message(s).`);
  }
  const truncatedCount = truncatedDroppedTools + truncatedKeptTools;
  if (truncatedCount) {
    summaryParts.push(
      `${truncatedCount} tool output truncated to ${maxToolOutputChars} character(s).`,
    );
  }

  return {
    messages: kept,
    summary: summaryParts.join(" "),
  };
}

/** 截断超出长度限制的工具消息 / Truncate tool message exceeding length limit */
function truncateToolMessage(message: BaseMessage, maxChars: number): BaseMessage {
  if (!(message instanceof ToolMessage)) {
    return message;
  }

  const content = textContent(message.content);
  if (content.length <= maxChars) {
    return message;
  }

  // 截断内容并附加截断标记 / Truncate content and append truncation marker
  return new ToolMessage({
    content: `${content.slice(0, maxChars)}\n[truncated ${content.length - maxChars} chars]`,
    tool_call_id: message.tool_call_id,
    status: message.status,
  });
}

/** 合并已有和新生成的摘要 / Merge existing and new summaries */
function mergeSummaries(existing: string, generated: string): string {
  return [existing.trim(), generated.trim()].filter(Boolean).join("\n");
}

/** 提取消息文本内容 / Extract message text content */
function textContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
