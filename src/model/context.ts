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
import {
  summarizeMessages,
  formatCompactedSummary,
} from "./summarizer";

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

/** 默认上下文预算（4000 字符工具输出截断） / Default context budget (4000 char tool output truncation) */
const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
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

/** 准备模型上下文（组装系统提示词 + 对话消息，不做预判压缩） / Prepare model context (assemble system prompt + conversation, no proactive compaction) */
export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
): PreparedModelContext {
  const budget = state.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const maxToolOutputChars = Math.max(1, budget.maxToolOutputChars);
  const msgs = state.messages.length > 0
    ? state.messages.map((m) => truncateToolMessage(m, maxToolOutputChars))
    : [new HumanMessage("")];

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
  budget: ContextBudget,
): { messages: BaseMessage[]; summary: string } {
  const maxToolOutputChars = Math.max(1, budget.maxToolOutputChars);
  const KEEP_FULL = 8;

  let fullStart = Math.max(0, messages.length - KEEP_FULL);
  while (fullStart > 0 && messages[fullStart] instanceof ToolMessage) {
    fullStart--;
  }

  const toSummarize = messages.slice(0, fullStart);
  const keepFull = messages
    .slice(fullStart)
    .map((m) => truncateToolMessage(m, maxToolOutputChars));

  if (toSummarize.length === 0) {
    // Nothing to summarize, just truncate and return
    return {
      messages: messages.map((m) => truncateToolMessage(m, maxToolOutputChars)),
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

/** 截断超出长度限制的工具消息 / Truncate tool message exceeding length limit */
function truncateToolMessage(message: BaseMessage, maxChars: number): BaseMessage {
  if (!(message instanceof ToolMessage)) {
    return message;
  }

  const content = textContent(message.content);
  if (content.length <= maxChars) {
    return message;
  }

  return new ToolMessage({
    content: `${content.slice(0, maxChars)}\n[truncated ${content.length - maxChars} chars]`,
    tool_call_id: message.tool_call_id,
    status: message.status,
  });
}

/** 提取消息文本内容 / Extract message text content */
function textContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
