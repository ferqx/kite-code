import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import type { AgentConfig } from "./config";
import { buildCodeAgentGraph, normalizeThreadMode, type ThreadModeInput } from "./graph";
import type { ShellExecutor } from "./tools";
import type { AgentEvent } from "./types";

export interface StreamCodeAgentInput {
  task: string;
  threadMode?: ThreadModeInput;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  memoryPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
}

export interface ResumeCodeAgentInput extends Omit<StreamCodeAgentInput, "task"> {
  resume: boolean | { approved?: boolean; reason?: string; nextMode?: ThreadModeInput };
}

export async function* streamCodeAgent(
  input: StreamCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, memory, checkpointer } = buildCodeAgentGraph(input);
  const directive = parsePlanDirective(input.task);
  try {
    const stream = await graph.stream(
      {
        task: directive.task,
        threadMode: normalizeThreadMode(input.threadMode ?? directive.threadMode),
        userId: input.userId,
        workspace: input.workspace,
      },
      graphConfig(input.threadId),
    );

    yield* normalizeGraphStream(stream);
  } finally {
    memory.close();
    checkpointer.close();
  }
}

export async function* resumeCodeAgent(
  input: ResumeCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, memory, checkpointer } = buildCodeAgentGraph(input);
  try {
    const stream = await graph.stream(
      new Command({ resume: input.resume }),
      graphConfig(input.threadId),
    );

    yield* normalizeGraphStream(stream);
  } finally {
    memory.close();
    checkpointer.close();
  }
}

export function parsePlanDirective(task: string): { task: string; threadMode: "plan" | "builder" } {
  const match = task.match(/^\s*\/plan(?:\s+|$)([\s\S]*)$/i);
  if (!match) {
    return { task, threadMode: "builder" };
  }
  return {
    task: match[1].trim(),
    threadMode: "plan",
  };
}

function graphConfig(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    streamMode: "updates" as const,
    recursionLimit: 20,
  };
}

async function* normalizeGraphStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<AgentEvent> {
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

    yield { type: "update", data: chunk };
    const final = findFinal(chunk);
    if (final) {
      yield { type: "final", data: final };
    }
  }
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
