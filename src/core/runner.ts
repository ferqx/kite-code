import { readFileSync } from "node:fs";
import { HumanMessage } from "@langchain/core/messages";
import { Command, isInterrupted, INTERRUPT } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { AgentConfig } from "./config/index";
import type { SupportedChatModel } from "./model/factory";
import { buildCodeAgentGraph } from "./harness/graph";
import type { BunSqliteSaver } from "./persistence/checkpoint";
import type { ShellExecutor } from "./tools/shell";
import {
  createPromptCacheStandardTracker,
  extractPromptCacheMetrics,
} from "./cache-metrics";
import type {
  AgentPhase,
  AgentEvent,
  CacheMetricsPayload,
  StateChangePayload,
  ToolCallPayload,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
  WorkspaceAccessRequest,
} from "@/protocol/events";
import type { UserAction } from "@/protocol/actions";
import type { UserInputProvider } from "@/protocol/provider";
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ContextBudget,
  ModelRetryEvent,
  ThreadAuthorizationState,
} from "./types";
import { defaultAuthorizationState } from "./harness/tool-policy";

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
  /** 测试用：注入自定义模型（mock）/ Inject custom model for testing mocks the LLM */
  model?: SupportedChatModel;
  /** 恢复值：提供时将直接从 checkpoint 恢复而非创建新 initial state / Resume value: if provided, resumes from checkpoint instead of creating new initial state */
  resume?: AgentResumeValue;
  /** 外部中止信号 / External abort signal to cancel the agent loop */
  signal?: AbortSignal;
  /** 思考级别，映射到 reasoning_effort API 参数 / Thinking level, mapped to reasoning_effort API param */
  thinkingLevel?: string | null;
}

export interface StreamCodeAgentInput {
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
  /** 思考级别 / Thinking level */
  thinkingLevel?: string | null;
}

export interface ResumeCodeAgentInput extends Omit<StreamCodeAgentInput, "task"> {
  resume: AgentResumeValue;
}

/** 从上次 checkpoint 读取 thread 授权状态 / Read thread authorization state from last checkpoint */
async function readLastAuthorization(
  checkpointer: BunSqliteSaver,
  threadId: string,
): Promise<ThreadAuthorizationState | null> {
  try {
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    if (!tuple) return null;
    const auth = tuple.checkpoint.channel_values?.authorization as
      | ThreadAuthorizationState
      | undefined;
    if (!auth || typeof auth.mode !== "string") return null;
    return auth;
  } catch {
    return null;
  }
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
    model: input.model,
    thinkingLevel: input.thinkingLevel,
  });

  try {
    const initialAccess = initialWorkspaceAccessForTask(input.task, input.mode ?? "auto");
    const initialPhase = workspaceAccessToPhase(initialAccess);

    const prevAuth = await readLastAuthorization(checkpointer, input.threadId);

    const initialState = {
      messages: [new HumanMessage(input.task)],
      workspaceAccess: initialAccess,
      phase: initialPhase,
      plan: null,
      userId: input.userId,
      threadId: input.threadId,
      workspace: input.workspace,
      authorization: prevAuth ?? defaultAuthorizationState(),
      contextSummary: "",
      contextBudget: input.contextBudget,
      modelProvider: input.config.providerName,
      modelName: input.config.modelName,
      thinkingLevel: input.thinkingLevel ?? null,
    };

    let resumeValue: AgentResumeValue | null = input.resume ?? null;

    const signal = input.signal;

    while (true) {
      if (signal?.aborted) break;

      const streamConfig = {
        configurable: { thread_id: input.threadId },
        streamMode: "updates" as const,
        recursionLimit: 60,
      };

      const stream = resumeValue
        ? await graph.stream(new Command({ resume: resumeValue }) as any, streamConfig)
        : await graph.stream(initialState, streamConfig);

      resumeValue = null;

      const result = await processStream(provider, stream, signal);

      yield* result.events;

      if (result.kind === "done") break;

      resumeValue = mapActionToResumeValue(result.action);
    }
  } finally {
    checkpointer.close();
  }
}

type StreamResult =
  | { kind: "done"; events: AgentEvent[] }
  | { kind: "interrupt"; action: UserAction; events: AgentEvent[] };

async function processStream(
  provider: UserInputProvider,
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const { isInterrupted, INTERRUPT } = await import("@langchain/langgraph");
  const cacheStandard = createPromptCacheStandardTracker();
  let currentAccess: WorkspaceAccess = "write";
  const allEvents: AgentEvent[] = [];
  const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();

  for await (const chunk of stream) {
    if (signal?.aborted) {
      return { events: allEvents, kind: "done" };
    }

    const interruptData = extractInterrupt(chunk, isInterrupted, INTERRUPT as unknown as symbol);
    if (interruptData) {
      const event = interruptToEvent(interruptData);
      if (event) {
        provider.onEvent(event);
        allEvents.push(event);
        const payload = eventToInterruptPayload(interruptData, event);
        if (payload) {
          const action = await provider.requestAction(payload);
          return { events: allEvents, kind: "interrupt", action };
        }
      }
      continue;
    }

    const acc = findWorkspaceAccess(chunk);
    if (acc) currentAccess = acc;

    const events = chunkToEvents(chunk, currentAccess, cacheStandard);

    // Record tool calls for cross-chunk file_change matching
    for (const e of events) {
      if (e.type === "tool_call") {
        pendingToolCalls.set(e.data.call_id, { name: e.data.name, args: e.data.args });
      }
    }
    // Generate file_change events when a write/edit tool completes
    for (const e of events) {
      if (e.type === "tool_done" && e.data.ok && (e.data.name === "write_file" || e.data.name === "edit_file")) {
        const call = pendingToolCalls.get(e.data.call_id);
        if (call) {
          const path = call.args.path;
          if (typeof path === "string") {
            produceFileChange(events, path, e.data.name);
          }
        }
      }
    }

    for (const e of events) {
      provider.onEvent(e);
      allEvents.push(e);
    }
  }

  return { events: allEvents, kind: "done" };
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
      const inner = (item as Record<string, unknown>).value;
      if (inner && typeof inner === "object") {
        const v = inner as Record<string, unknown>;
        if (v.kind === "tool_approval") {
          const approval = v.approval as ToolApprovalPayload | undefined;
          if (approval && typeof approval === "object") {
            return { type: "need_approval", data: approval };
          }
        }
        if (v.kind === "user_input") {
          const request = v.request as Record<string, unknown> | undefined;
          if (request && typeof request === "object") {
            const args = request.args as Record<string, unknown> | undefined;
            const payload: UserInputPayload = {
              question: (args?.question as string) ?? "User input required",
              options: (args?.options as UserInputPayload["options"]) ?? [],
              allow_free_text: (args?.allow_free_text as boolean) ?? true,
              context: typeof args?.context === "string" ? args.context : undefined,
            };
            return { type: "need_input", data: payload };
          }
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

export function chunkToEvents(
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

    events.push({ type: "step_begin", data: { node: key } });

    const msgs = node.messages;
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        if (AIMessage.isInstance(msg)) {
          const rawMsg = msg as unknown as Record<string, unknown>;
          const rc = (rawMsg.reasoning_content as string | undefined)
            ?? (rawMsg.additional_kwargs as Record<string, unknown> | undefined)?.reasoning_content as string | undefined;
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
          const text = extractText(content);
          if (text.length > 0) {
            events.push({ type: "text", data: { text } });
          }
        }

        const tm = msg as Record<string, unknown>;
        if (isToolMessage(tm)) {
          const content = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
          let ok = true;
          let summary = content.slice(0, 200);
          try {
            const p = JSON.parse(content);
            if (p && typeof p === "object") {
              ok = p.ok !== false;
              if (p.ok !== false) {
                summary = (p.stdout as string) ?? (p.message as string) ?? (p.summary as string) ?? summary;
              } else {
                const reason = (p.rejected as boolean)
                  ? ((p.reason as string) ?? "action rejected")
                  : (p.failure as Record<string, unknown> | undefined)?.reason as string
                    ?? (p.stderr as string)
                    ?? (p.message as string)
                    ?? (p.summary as string)
                    ?? summary;
                summary = reason;
              }
            }
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
    const plan = node.plan ?? (node.metadata as Record<string, unknown> | undefined)?.plan;
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
            type: "model_retry",
            data: {
              attempt: (r as Record<string, unknown>).attempt as number,
              error: ((r as Record<string, unknown>).error as string) ?? "unknown",
              delayMs: ((r as Record<string, unknown>).delayMs as number) ?? 0,
            },
          });
        }
      }
    }

    events.push({ type: "step_end", data: { node: key } });
  }


  const final = findFinal(chunk);
  if (final && !events.some((e) => e.type === "text" && e.data.text === final)) {
    events.push({ type: "final", data: final });
  }

  const metrics = findCacheMetrics(chunk);
  if (metrics) {
    const outputTokens = findOutputTokens(chunk);
    events.push({
      type: "cache_metrics",
      data: {
        workspaceAccess,
        cacheHitTokens: metrics.cacheHitTokens,
        cacheMissTokens: metrics.cacheMissTokens,
        cacheWriteTokens: 0,
        inputTokens: metrics.inputTokens,
        outputTokens,
        standard: cacheStandard.record(metrics) as unknown as Record<string, unknown>,
      } satisfies CacheMetricsPayload,
    });
  }

  return events;
}

function isToolMessage(msg: Record<string, unknown>): boolean {
  try {
    if (typeof msg._getType === "function") return (msg._getType as () => string).call(msg) === "tool";
  } catch { /* ignore */ }
  return false;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (block && typeof block === "object" && "text" in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text);
        }
        return "";
      })
      .join("");
  }
  return String(content ?? "");
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
  return findPromptCacheMetrics(chunk);
}

function findOutputTokens(chunk: unknown): number {
  if (!chunk || typeof chunk !== "object") return 0;
  for (const v of Object.values(chunk as Record<string, unknown>)) {
    if (AIMessage.isInstance(v)) {
      const um = v.usage_metadata as { output_tokens?: number } | undefined;
      const ru = v.response_metadata?.usage as { completion_tokens?: number; output_tokens?: number } | undefined;
      return um?.output_tokens ?? ru?.output_tokens ?? ru?.completion_tokens ?? 0;
    }
  }
  return 0;
}

export function initialWorkspaceAccessForTask(task: string, requested: WorkspaceAccessRequest = "auto"): WorkspaceAccess {
  if (requested === "plan" || requested === "read-only") return "read-only";
  if (requested === "builder" || requested === "write") return "write";
  if (task.trimStart().toLowerCase().startsWith("/plan")) return "read-only";
  return "write";
}

export function workspaceAccessToPhase(access: WorkspaceAccess): AgentPhase {
  return access === "read-only" ? "planning" : "building";
}

export function initialAgentPhaseForAccess(workspaceAccess: WorkspaceAccess): AgentPhase {
  return workspaceAccessToPhase(workspaceAccess);
}

export function taskMessageForInitialAccess(task: string, _workspaceAccess: WorkspaceAccess): string {
  return task;
}

export async function* normalizeGraphStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<AgentEvent> {
  let currentWorkspaceAccess: WorkspaceAccess | null = null;
  const cacheStandard = createPromptCacheStandardTracker();
  for await (const chunk of stream) {
    if (isInterrupted(chunk)) {
      yield { type: "interrupt", data: chunk[INTERRUPT as unknown as keyof typeof chunk] };
      continue;
    }

    const chunkRecord = chunk as Record<string, unknown>;
    if (INTERRUPT in chunkRecord) {
      yield { type: "interrupt", data: chunkRecord[String(INTERRUPT)] };
      continue;
    }

    currentWorkspaceAccess = findWorkspaceAccess(chunk) ?? currentWorkspaceAccess;
    yield { type: "update", data: chunk };

    for (const retry of findModelRetries(chunk)) {
      yield { type: "model_retry", data: retry };
    }

    const metrics = findPromptCacheMetrics(chunk);
    if (metrics && currentWorkspaceAccess) {
      yield {
        type: "cache_metrics",
        data: {
          workspaceAccess: currentWorkspaceAccess,
          ...metrics,
          outputTokens: findOutputTokens(chunk),
          cacheWriteTokens: 0,
          standard: cacheStandard.record(metrics) as unknown as Record<string, unknown>,
        },
      };
    }

    const final = findFinal(chunk);
    if (final) {
      yield { type: "final", data: final };
    }
  }
}

export async function* streamCodeAgent(
  input: StreamCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
    thinkingLevel: input.thinkingLevel,
  });

  let streamCompleted = false;
  try {
    const initialWorkspaceAccess = initialWorkspaceAccessForTask(input.task, input.mode ?? "auto");
    const initialPhase = initialAgentPhaseForAccess(initialWorkspaceAccess);

    const prevAuth = await readLastAuthorization(checkpointer, input.threadId);

    const stream = await graph.stream(
      {
        messages: [new HumanMessage(taskMessageForInitialAccess(input.task, initialWorkspaceAccess))],
        workspaceAccess: initialWorkspaceAccess,
        phase: initialPhase,
        plan: null,
        userId: input.userId,
        threadId: input.threadId,
        workspace: input.workspace,
        authorization: prevAuth ?? defaultAuthorizationState(),
        contextSummary: "",
        contextBudget: input.contextBudget,
        modelProvider: input.config.providerName,
        modelName: input.config.modelName,
        thinkingLevel: input.thinkingLevel ?? null,
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

export async function* resumeCodeAgent(
  input: ResumeCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
    thinkingLevel: input.thinkingLevel,
  });

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
    recursionLimit: 60,
  };
}

function findFinal(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as Record<string, unknown>;
  for (const key of ["agent", "agent_plan", "agent_build"]) {
    const node = record[key] as { final?: unknown } | undefined;
    if (typeof node?.final === "string") return node.final;
  }
  return null;
}

function findModelRetries(chunk: unknown): ModelRetryEvent[] {
  const all: ModelRetryEvent[] = [];
  for (const value of walkValues(chunk)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const modelRetries = (value as Record<string, unknown>).modelRetries;
    if (Array.isArray(modelRetries)) {
      for (const item of modelRetries) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).attempt === "number") {
          all.push(item as ModelRetryEvent);
        }
      }
    }
  }
  return all;
}

function findPromptCacheMetrics(chunk: unknown) {
  for (const value of walkValues(chunk)) {
    if (AIMessage.isInstance(value)) {
      const metrics = extractPromptCacheMetrics(value);
      if (metrics) return metrics;
    }
  }
  return null;
}

function* walkValues(value: unknown): Generator<unknown> {
  yield value;
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkValues(item);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    yield* walkValues(item);
  }
}

/** Generate a file_change event when a write/edit tool completes */
function produceFileChange(
  events: AgentEvent[],
  path: string,
  toolName: string,
): void {
  const kind = toolName === "write_file" ? "add" as const : "edit" as const;
  let linesAdded: number | undefined;
  let linesRemoved: number | undefined;
  let preview: string | undefined;
  try {
    const content = readFileSync(path, "utf-8");
    const allLines = content.split("\n");
    const lineCount = allLines.length;
    linesAdded = lineCount;
    preview = allLines.slice(0, 6).join("\n");
    if (allLines.length > 6) preview += "\n...";
  } catch { /* file not readable */ }
  events.push({ type: "file_change", data: { path, kind, linesAdded, linesRemoved, preview } });
}
