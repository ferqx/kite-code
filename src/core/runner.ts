import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { AgentConfig } from "./config/index";
import { buildCodeAgentGraph } from "./harness/graph";
import type { ShellExecutor } from "./tools/shell";
import {
  createPromptCacheStandardTracker,
  extractPromptCacheMetrics,
} from "./cache-metrics";
import type {
  AgentEvent,
  CacheMetricsPayload,
  StateChangePayload,
  ToolCallPayload,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
  WorkspaceAccessRequest,
} from "../protocol/events";
import type { UserAction } from "../protocol/actions";
import type { UserInputProvider } from "../protocol/provider";
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ContextBudget,
} from "./types";

export interface RunAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: WorkspaceAccessRequest;
  contextBudget?: ContextBudget;
  authorizationOverride?: AuthorizationOverride;
}

export async function* runAgent(
  provider: UserInputProvider,
  input: RunAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
  });

  let streamCompleted = false;
  try {
    const initialAccess = initialWorkspaceAccessForTask(input.task, input.mode ?? "auto");
    const initialPhase = workspaceAccessToPhase(initialAccess);

    const initialState = {
      messages: [new HumanMessage(input.task)],
      workspaceAccess: initialAccess,
      phase: initialPhase,
      plan: null,
      userId: input.userId,
      threadId: input.threadId,
      workspace: input.workspace,
      contextSummary: "",
      contextBudget: input.contextBudget,
    };

    let resumeValue: AgentResumeValue | null = null;

    while (true) {
      const streamConfig = {
        configurable: { thread_id: input.threadId },
        streamMode: "updates" as const,
        recursionLimit: 60,
      };

      const stream = resumeValue
        ? await graph.stream(new Command({ resume: resumeValue }) as any, streamConfig)
        : await graph.stream(initialState, streamConfig);

      resumeValue = null;

      const result = await processStream(provider, stream);

      if (result.kind === "done") break;

      resumeValue = mapActionToResumeValue(result.action);
    }

    streamCompleted = true;
  } finally {
    if (streamCompleted) {
      checkpointer.close();
    }
  }
}

type StreamResult =
  | { kind: "done" }
  | { kind: "interrupt"; action: UserAction };

async function processStream(
  provider: UserInputProvider,
  stream: AsyncIterable<unknown>,
): Promise<StreamResult> {
  const { isInterrupted, INTERRUPT } = await import("@langchain/langgraph");
  const cacheStandard = createPromptCacheStandardTracker();
  let currentAccess: WorkspaceAccess = "write";

  for await (const chunk of stream) {
    const interruptData = extractInterrupt(chunk, isInterrupted, INTERRUPT as unknown as symbol);
    if (interruptData) {
      const event = interruptToEvent(interruptData);
      if (event) {
        provider.onEvent(event);
        const payload = eventToInterruptPayload(interruptData, event);
        if (payload) {
          const action = await provider.requestAction(payload);
          return { kind: "interrupt", action };
        }
      }
      continue;
    }

    const acc = findWorkspaceAccess(chunk);
    if (acc) currentAccess = acc;

    const events = chunkToEvents(chunk, currentAccess, cacheStandard);
    for (const e of events) provider.onEvent(e);
  }

  return { kind: "done" };
}

function extractInterrupt(
  chunk: unknown,
  isInterrupted: (c: unknown) => boolean,
  INTERRUPT_KEY: symbol,
): unknown {
  if (isInterrupted(chunk)) return (chunk as Record<symbol, unknown>)[INTERRUPT_KEY];
  const rec = chunk as Record<string, unknown>;
  if (INTERRUPT_KEY in rec) return rec[String(INTERRUPT_KEY)];
  return null;
}

function interruptToEvent(data: unknown): AgentEvent | null {
  const arr = data as Record<string, unknown>[] | undefined;
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (item && typeof item === "object") {
      const inner = item.__interrupt__;
      if (Array.isArray(inner) && inner.length > 0) {
        const v = inner[0] as Record<string, unknown> | undefined;
        if (v?.kind === "tool_approval") {
          return { type: "need_approval", data: v.payload as ToolApprovalPayload };
        }
        if (v?.kind === "user_input") {
          return { type: "need_input", data: v.payload as UserInputPayload };
        }
      }
    }
  }
  return null;
}

function eventToInterruptPayload(
  _data: unknown,
  event: AgentEvent,
): { kind: "approval"; approval: ToolApprovalPayload } | { kind: "input"; question: UserInputPayload } | null {
  if (event.type === "need_approval") return { kind: "approval", approval: event.data };
  if (event.type === "need_input") return { kind: "input", question: event.data };
  return null;
}

function mapActionToResumeValue(action: UserAction): AgentResumeValue {
  switch (action.type) {
    case "approve": return { approved: true, grant: action.grant as any };
    case "reject": return { approved: false };
    case "input": return { answer: action.text };
    case "cancel": return { approved: false };
    case "switch_auth": return { approved: false };
  }
}

function chunkToEvents(
  chunk: unknown,
  workspaceAccess: WorkspaceAccess,
  cacheStandard: ReturnType<typeof createPromptCacheStandardTracker>,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!chunk || typeof chunk !== "object") return events;
  const record = chunk as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const node = record[key] as Record<string, unknown> | undefined;
    if (!node || typeof node !== "object") continue;

    const msgs = node.messages;
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        if (AIMessage.isInstance(msg)) {
          const rc = (msg as unknown as Record<string, unknown>).reasoning_content;
          if (typeof rc === "string" && rc.length > 0) {
            events.push({ type: "reason", data: { text: rc } });
          }
          if (
            Array.isArray(msg.tool_calls) &&
            msg.tool_calls.length > 0
          ) {
            for (const tc of msg.tool_calls) {
              events.push({
                type: "tool_call",
                data: {
                  call_id: tc.id ?? "",
                  name: tc.name as ToolCallPayload["name"],
                  args: tc.args as Record<string, unknown>,
                },
              });
            }
          }
          const content = msg.content;
          if (typeof content === "string" && content.length > 0) {
            events.push({ type: "text", data: { text: content } });
          }
        }

        const tm = msg as Record<string, unknown>;
        if (isToolMessage(tm)) {
          const content = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
          let ok = true;
          let summary = content.slice(0, 200);
          try {
            const p = JSON.parse(content);
            if (p && typeof p === "object") { ok = p.ok !== false; summary = p.message ?? p.summary ?? summary; }
          } catch { /* use raw content */ }
          events.push({
            type: "tool_done",
            data: {
              call_id: (tm.tool_call_id as string) ?? "",
              name: (tm.name as string) ?? "",
              ok,
              summary,
            },
          });
        }
      }
    }

    const sc: StateChangePayload = {};
    const ws = node.workspaceAccess as string | undefined;
    const phase = node.phase as string | undefined;
    const plan = node.plan;
    const auth = node.authorization;
    if (ws === "read-only" || ws === "write") sc.workspaceAccess = ws;
    if (phase === "planning" || phase === "building") sc.phase = phase;
    if (plan !== undefined) sc.plan = plan as StateChangePayload["plan"];
    if (auth && typeof auth === "object") {
      sc.authorization = { mode: (auth as Record<string, unknown>).mode as "default" | "full_access" };
    }
    if (Object.keys(sc).length > 0) {
      events.push({ type: "state_change", data: sc });
    }

    const retries = node.modelRetries;
    if (Array.isArray(retries)) {
      for (const r of retries) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).attempt === "number") {
          events.push({
            type: "retry",
            data: {
              attempt: (r as Record<string, unknown>).attempt as number,
              reason: ((r as Record<string, unknown>).error as string) ?? "unknown",
            },
          });
        }
      }
    }
  }

  const metrics = findCacheMetrics(chunk);
  if (metrics) {
    events.push({
      type: "cache_metrics",
      data: {
        workspaceAccess,
        cacheHitTokens: metrics.cacheHitTokens,
        cacheMissTokens: metrics.cacheMissTokens,
        cacheWriteTokens: 0,
        inputTokens: metrics.inputTokens,
        outputTokens: 0,
        standard: {
          label: "cache_hit_rate",
          value: metrics.hitRate,
        },
      } satisfies CacheMetricsPayload,
    });
  }

  return events;
}

function isToolMessage(msg: Record<string, unknown>): boolean {
  try {
    const type = msg._getType;
    if (typeof type === "function") return (type as () => string)() === "tool";
  } catch { /* ignore */ }
  return false;
}

function findWorkspaceAccess(chunk: unknown): WorkspaceAccess | null {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
  for (const v of Object.values(chunk as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ws = (v as Record<string, unknown>).workspaceAccess;
      if (ws === "read-only" || ws === "write") return ws;
    }
  }
  return null;
}

function findCacheMetrics(chunk: unknown) {
  if (!chunk || typeof chunk !== "object") return null;
  for (const v of Object.values(chunk as Record<string, unknown>)) {
    if (AIMessage.isInstance(v)) return extractPromptCacheMetrics(v);
  }
  return null;
}

function initialWorkspaceAccessForTask(task: string, requested: WorkspaceAccessRequest): WorkspaceAccess {
  if (requested === "plan" || requested === "read-only") return "read-only";
  if (requested === "builder" || requested === "write") return "write";
  if (task.trimStart().toLowerCase().startsWith("/plan")) return "read-only";
  return "write";
}

function workspaceAccessToPhase(access: WorkspaceAccess): "planning" | "building" {
  return access === "read-only" ? "planning" : "building";
}
