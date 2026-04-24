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

export type AgentRole = "agent";

export interface ModelContextState {
  userId: string;
  workspace: string;
  messages: BaseMessage[];
  final: string;
  mode?: AgentMode;
  plan?: AgentPlan | null;
  modelName?: string;
  contextBudget?: ContextBudget;
  contextSummary?: string;
  evidence?: AgentEvidence;
  progress?: AgentProgressLedger;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxMessages: 24,
  maxToolOutputChars: 4000,
};

export interface PreparedModelContext {
  messages: BaseMessage[];
  contextSummary: string;
}

export function buildModelMessages(role: AgentRole, state: ModelContextState) {
  return prepareModelContext(role, state).messages;
}

export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
): PreparedModelContext {
  const compacted = conversationMessages(state);
  const contextSummary = mergeSummaries(state.contextSummary ?? "", compacted.summary);
  return {
    contextSummary,
    messages: [
      new SystemMessage(buildStaticSystemPrompt(role)),
      new SystemMessage(buildCacheableRuntimeContext({ ...state, contextSummary })),
      ...compacted.messages,
    ],
  };
}

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

export function buildDynamicSystemContext(state: ModelContextState): string {
  return buildRuntimeContext(state);
}

function conversationMessages(
  state: ModelContextState,
): { messages: BaseMessage[]; summary: string } {
  return compactConversationMessages(
    state.messages.length > 0 ? state.messages : [new HumanMessage("")],
    state.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
  );
}

function compactConversationMessages(
  messages: BaseMessage[],
  budget: ContextBudget,
): { messages: BaseMessage[]; summary: string } {
  const maxMessages = Math.max(1, budget.maxMessages);
  const maxToolOutputChars = Math.max(1, budget.maxToolOutputChars);
  let start = Math.max(0, messages.length - maxMessages);
  while (start > 0 && messages[start] instanceof ToolMessage) {
    start--;
  }

  const dropped = messages.slice(0, start);
  const kept = messages
    .slice(start)
    .map((message) => truncateToolMessage(message, maxToolOutputChars));
  const truncatedDroppedTools = dropped.filter(
    (message) =>
      message instanceof ToolMessage &&
      textContent(message.content).length > maxToolOutputChars,
  ).length;
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

function mergeSummaries(existing: string, generated: string): string {
  return [existing.trim(), generated.trim()].filter(Boolean).join("\n");
}

function textContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
