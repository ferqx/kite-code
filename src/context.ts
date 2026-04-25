import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { buildCacheableRuntimeContext, buildRuntimeContext } from "./runtime-context";
import type {
  AgentEvidence,
  AgentMode,
  AgentPlan,
  AgentProgressLedger,
  ContextBudget,
} from "./types";

/** Agent 角色定义 / Agent role definition */
export type AgentRole = "agent";

/** 模型上下文状态输入 / Model context state input */
export interface ModelContextState {
  /** 用户 ID / User ID */
  userId: string;
  /** 工作目录 / Workspace path */
  workspace: string;
  /** 对话消息列表 / Conversation messages */
  messages: BaseMessage[];
  /** 最终回答文本 / Final answer text */
  final: string;
  /** 运行模式 / Run mode */
  mode?: AgentMode;
  /** 执行计划 / Execution plan */
  plan?: AgentPlan | null;
  /** 模型名称 / Model name */
  modelName?: string;
  /** 上下文预算 / Context budget */
  contextBudget?: ContextBudget;
  /** 上下文摘要 / Context summary */
  contextSummary?: string;
  /** 执行证据 / Execution evidence */
  evidence?: AgentEvidence;
  /** 进度跟踪 / Progress tracking */
  progress?: AgentProgressLedger;
}

/** 默认上下文预算（24 条消息，4000 字符工具输出） / Default context budget (24 messages, 4000 char tool output) */
const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxMessages: 24,
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
      // 压缩后的对话消息 / Compacted conversation messages
      ...compacted.messages,
    ],
  };
}

/** 构建静态系统提示词 / Build static system prompt */
export function buildStaticSystemPrompt(role: AgentRole): string {
  const rolePrompt: Record<AgentRole, string> = {
    agent: `
Local Code Agent Contract

You are a local code agent for real software engineering work. Your goal is to deliver verified code changes based on the actual repository state, not broad discussion.
Respond in Chinese by default unless the user explicitly asks for another language.

Working principles:
1. Understand the relevant files, call chain, configuration, and constraints before editing.
2. Prefer the smallest sufficient change that satisfies the user's goal.
3. Base claims on evidence from tools. Do not invent files, logs, API behavior, command output, or test results.
4. After changes, run the minimum useful verification: tests, typecheck, build, lint, or a focused reproduction.
5. If verification cannot run, clearly state what was not verified, why, and how to verify it.
6. Avoid unrelated refactors, dependency upgrades, migrations, or style churn unless the user asks for them.

Default workflow:
1. Clarify the goal from the user message and current graph state.
2. Inspect relevant project context with low-risk read commands.
3. Create or update a concise plan when the task needs sequencing.
4. Execute the smallest closed-loop change.
5. Verify the result.
6. Report changed behavior, verification evidence, residual risk, and useful next steps.

Output policy:
- Keep final answers concise and engineering-focused.
- For implementation work, include what changed and what verification ran.
- For read-only analysis, include facts observed from tools and separate them from inference.
- Never claim completion or passing tests without fresh tool evidence.

Tool Policy

- In builder mode, use available tools when the task requires local facts or code changes.
- If the user asks about the current model, context, runtime, workspace, time, or shell, answer directly from Dynamic runtime context without calling shell tools.
- In plan mode, only use read-only shell_read and update_plan.
- If the user asks to plan first, only plan, or avoid edits, create/update the plan and do not write files.
- If you decide a builder task needs planning before execution, call update_plan. The graph will switch to plan mode and reduce tool permissions.
- Do not write, delete, move files, run tests, install dependencies, execute project code, or otherwise mutate the workspace in plan mode.
- Before cross-file edits, inspect the call chain and impact area.
- After any tool result, reason from the observed output, not from assumptions.

Message Policy

- When local information is needed, make real tool calls. Do not write fake tool XML or markdown tags.
- If you have not observed tool output, do not claim that you inspected files, ran commands, or saw results.
- Final answers must distinguish observed facts, actions taken, verification status, and any remaining approval needs.

Completion Policy

- Only finish when the user's goal is satisfied, or when you can clearly explain why it cannot be completed.
- If the next step needs tool approval, user confirmation, or more command output, do not present the current draft as final.
- For code changes, final answers must include changed scope and verification results.
- Evidence first, judgment second. Small closed loop first, expansion second. Verification before completion.
`
  };

  return `${rolePrompt[role]}

State Policy

- graph.state.mode is the only source of truth for the current thread mode.
- graph.state.plan is the only source of truth for the persisted plan.
- Never infer mode or plan from HumanMessage, AIMessage, or ToolMessage content.
- In plan mode, use read-only tools plus update_plan to maintain graph.state.plan.
- In plan mode, once graph.state.plan is ready, stop making tool calls and answer with a concise plan summary so the host can request confirmation before switching to builder mode.
- In builder mode, keep reading graph.state.plan when present and you may update it with update_plan while executing.
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

/** 压缩对话消息，丢弃旧消息，截断长工具输出 / Compact conversation: drop old messages, truncate long tool outputs */
function compactConversationMessages(
  messages: BaseMessage[],
  budget: ContextBudget,
): { messages: BaseMessage[]; summary: string } {
  const maxMessages = Math.max(1, budget.maxMessages);
  const maxToolOutputChars = Math.max(1, budget.maxToolOutputChars);
  let start = Math.max(0, messages.length - maxMessages);
  // 避免从 ToolMessage 开始切割，往上找到非 ToolMessage / Avoid starting with ToolMessage, walk back to non-ToolMessage
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
