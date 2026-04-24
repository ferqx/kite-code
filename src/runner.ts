import { HumanMessage } from "@langchain/core/messages";
import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { AgentConfig } from "./config";
import { buildCodeAgentGraph } from "./graph";
import type { ShellExecutor } from "./tools";
import { extractPromptCacheMetrics } from "./cache-metrics";
import type { AgentEvent, AgentMode, AgentRunMode, ContextBudget } from "./types";

export interface StreamCodeAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: AgentRunMode;
  contextBudget?: ContextBudget;
}

export interface ResumeCodeAgentInput extends Omit<StreamCodeAgentInput, "task"> {
  resume: boolean | { approved?: boolean; reason?: string };
}

export async function* streamCodeAgent(
  input: StreamCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  const directAnswer = runtimeQuestionAnswer(input.task, {
    modelName: input.config.modelName,
  });
  if (directAnswer) {
    yield { type: "final", data: directAnswer };
    return;
  }

  const { graph, checkpointer } = buildCodeAgentGraph(input);
  let streamCompleted = false;
  try {
    const initialMode = initialModeForTask(input.task, input.mode ?? "auto");
    const stream = await graph.stream(
      {
        messages: [new HumanMessage(taskMessageForInitialMode(input.task, initialMode))],
        mode: initialMode,
        plan: null,
        userId: input.userId,
        workspace: input.workspace,
        contextSummary: "",
        evidence: { commands: [], files: [], verification: [] },
        contextBudget: input.contextBudget,
      },
      graphConfig(input.threadId),
    );

    yield* normalizeGraphStream(stream);
    streamCompleted = true;
  } finally {
    if (streamCompleted) {
      checkpointer.close();
    }
  }
}

export function runtimeQuestionAnswer(
  task: string,
  input: { modelName: string },
): string | null {
  const normalized = task.toLowerCase();
  const asksModel =
    task.includes("模型") ||
    normalized.includes("model") ||
    normalized.includes("configured model");
  const asksContext =
    task.includes("上下文") ||
    normalized.includes("context") ||
    normalized.includes("context window");

  if (!asksModel && !asksContext) {
    return null;
  }

  return [
    `当前配置模型: ${input.modelName}`,
    "上下文长度: 当前运行时未提供精确 token 窗口；请以模型提供商配置为准。",
  ].join("\n");
}

export function taskMessageForInitialMode(task: string, mode: AgentMode): string {
  if (mode !== "plan" || task.trimStart().startsWith("/plan")) {
    return task;
  }
  return `/plan ${task}`;
}

export function initialModeForTask(
  task: string,
  requestedMode: AgentRunMode = "auto",
): AgentMode {
  if (requestedMode === "plan" || requestedMode === "builder") {
    return requestedMode;
  }
  const normalized = task.trimStart().toLowerCase();
  if (normalized.startsWith("/plan")) {
    return "plan";
  }
  return isNaturalLanguagePlanRequest(normalized) ? "plan" : "builder";
}

export async function* resumeCodeAgent(
  input: ResumeCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph(input);
  let streamCompleted = false;
  try {
    const stream = await graph.stream(
      new Command({ resume: input.resume }),
      graphConfig(input.threadId),
    );

    yield* normalizeGraphStream(stream);
    streamCompleted = true;
  } finally {
    if (streamCompleted) {
      checkpointer.close();
    }
  }
}

function graphConfig(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    streamMode: "updates" as const,
    recursionLimit: 40,
  };
}

export async function* normalizeGraphStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<AgentEvent> {
  let currentMode: AgentMode | null = null;
  for await (const chunk of stream) {
    if (isInterrupted(chunk)) {
      yield {
        type: "interrupt",
        data: chunk[INTERRUPT],
      };
      continue;
    }

    const chunkRecord = chunk as Record<string, unknown>;
    if (INTERRUPT in chunkRecord) {
      yield {
        type: "interrupt",
        data: chunkRecord[INTERRUPT],
      };
      continue;
    }

    currentMode = findMode(chunk) ?? currentMode;
    yield { type: "update", data: chunk };
    const metrics = findPromptCacheMetrics(chunk);
    if (metrics && currentMode) {
      yield { type: "cache_metrics", data: { mode: currentMode, ...metrics } };
    }
    const final = findFinal(chunk);
    if (final) {
      yield { type: "final", data: final };
    }
  }
}

function findMode(chunk: unknown): AgentMode | null {
  for (const value of walkValues(chunk)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const mode = (value as Record<string, unknown>).mode;
    if (mode === "plan" || mode === "builder") {
      return mode;
    }
  }
  return null;
}

function isNaturalLanguagePlanRequest(task: string): boolean {
  const planIntent =
    task.includes("先计划") ||
    task.includes("只计划") ||
    task.includes("仅计划") ||
    task.includes("不要改") ||
    task.includes("不要写") ||
    task.includes("别改") ||
    task.includes("plan first") ||
    task.includes("only plan") ||
    task.includes("do not edit") ||
    task.includes("don't edit") ||
    task.includes("without editing");
  const executionIntent =
    task.includes("直接改") ||
    task.includes("开始实现") ||
    task.includes("implement now") ||
    task.includes("edit now");
  return planIntent && !executionIntent;
}

function findFinal(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const record = chunk as Record<string, unknown>;
  const agent = record.agent as { final?: unknown } | undefined;
  if (typeof agent?.final === "string") {
    return agent.final;
  }
  return null;
}

function findPromptCacheMetrics(chunk: unknown) {
  for (const value of walkValues(chunk)) {
    if (AIMessage.isInstance(value)) {
      const metrics = extractPromptCacheMetrics(value);
      if (metrics) {
        return metrics;
      }
    }
  }
  return null;
}

function* walkValues(value: unknown): Generator<unknown> {
  yield value;
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkValues(item);
    }
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    yield* walkValues(item);
  }
}
