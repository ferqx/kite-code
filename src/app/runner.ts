import { HumanMessage } from "@langchain/core/messages";
import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { AgentConfig } from "../core/config/index";
import { buildCodeAgentGraph } from "../core/harness/graph";
import type { ShellExecutor } from "../core/tools/shell";
import {
  createPromptCacheStandardTracker,
  extractPromptCacheMetrics,
} from "../core/cache-metrics";
import type {
  AgentPhase,
  AgentEvent,
  WorkspaceAccess,
  WorkspaceAccessRequest,
} from "../protocol/index";
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ContextBudget,
  ModelRetryEvent,
} from "../core/types";

/** 流式运行 Agent 输入 / Stream agent input */
export interface StreamCodeAgentInput {
  /** 用户任务 / User task */
  task: string;
  /** 用户 ID / User ID */
  userId: string;
  /** LangGraph 线程 ID / LangGraph thread ID */
  threadId: string;
  /** 工作目录 / Workspace */
  workspace: string;
  /** Checkpoint 数据库路径 / Checkpoint database path */
  checkpointPath: string;
  /** Agent 配置 / Agent configuration */
  config: AgentConfig;
  /** 可选 Shell 执行器 / Optional shell executor */
  shellExecutor?: ShellExecutor;
  /** 兼容 CLI mode / 工作区访问请求 / Compatible CLI mode or workspace access request */
  mode?: WorkspaceAccessRequest;
  /** 上下文预算 / Context budget */
  contextBudget?: ContextBudget;
  /** 可选的内存级授权覆盖 / Optional in-memory authorization override */
  authorizationOverride?: AuthorizationOverride;
}

/** 恢复执行 Agent 输入 / Resume agent input */
export interface ResumeCodeAgentInput extends Omit<StreamCodeAgentInput, "task"> {
  /** 恢复值（工具审批或用户输入）/ Resume value for tool approval or user input */
  resume: AgentResumeValue;
}

/** 流式运行 Agent，处理直接回答和访问权限检测 / Stream agent execution, handle direct answers and access detection */
export async function* streamCodeAgent(
  input: StreamCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  // 构建 Agent 图 / Build agent graph
  const { graph, checkpointer } = buildCodeAgentGraph({
    ...input,
    authorizationOverride: input.authorizationOverride,
  });
  // 跟踪流是否正常完成 / Track if stream completed normally
  let streamCompleted = false;
  try {
    // 检测初始工作区访问权限 / Detect initial workspace access
    const initialWorkspaceAccess = initialWorkspaceAccessForTask(
      input.task,
      input.mode ?? "auto",
    );
    const initialPhase = initialAgentPhaseForAccess(initialWorkspaceAccess);
    // 以初始状态启动图流 / Start graph stream with initial state
    const stream = await graph.stream(
      {
        messages: [
          new HumanMessage(
            taskMessageForInitialAccess(input.task, initialWorkspaceAccess),
          ),
        ],
        workspaceAccess: initialWorkspaceAccess,
        phase: initialPhase,
        plan: null,
        userId: input.userId,
        threadId: input.threadId,
        workspace: input.workspace,
        contextSummary: "",
        contextBudget: input.contextBudget,
      },
      graphConfig(input.threadId),
    );

    // 标准化流输出 / Normalize stream outputs
    yield* normalizeGraphStream(stream);
    // 标记流已正常完成 / Mark stream as completed
    streamCompleted = true;
  } finally {
    // 仅在流正常完成时关闭 checkpointer / Only close checkpointer if stream completed normally
    if (streamCompleted) {
      checkpointer.close();
    }
  }
}

/** 为初始工作区访问权限准备任务消息 / Prepare task message for initial workspace access */
export function taskMessageForInitialAccess(
  task: string,
  _workspaceAccess: WorkspaceAccess,
): string {
  // 不改写用户输入；当前访问权限由图状态和尾部运行时状态提醒表达 / Do not rewrite user input; graph state carries access
  return task;
}

/** 根据任务内容和用户指令检测初始工作区访问权限 / Detect initial workspace access from task and user instruction */
export function initialWorkspaceAccessForTask(
  task: string,
  requestedAccess: WorkspaceAccessRequest = "auto",
): WorkspaceAccess {
  // 兼容旧 mode 值，并支持新的 read-only/write 值 / Map legacy mode values and new access values
  if (requestedAccess === "plan" || requestedAccess === "read-only") {
    return "read-only";
  }
  if (requestedAccess === "builder" || requestedAccess === "write") {
    return "write";
  }
  const normalized = task.trimStart().toLowerCase();
  // /plan 前缀强制使用只读访问 / /plan prefix forces read-only access
  if (normalized.startsWith("/plan")) {
    return "read-only";
  }
  // auto 不再用启发式进入只读；模型可自主调用 update_plan / Auto lets the model decide whether to call update_plan
  return "write";
}

/** 根据工作区访问权限派生初始执行阶段 / Derive initial execution phase from workspace access */
export function initialAgentPhaseForAccess(workspaceAccess: WorkspaceAccess): AgentPhase {
  return workspaceAccess === "read-only" ? "planning" : "building";
}

/** 恢复被中断的 Agent 执行 / Resume interrupted agent execution */
export async function* resumeCodeAgent(
  input: ResumeCodeAgentInput,
): AsyncGenerator<AgentEvent> {
  // 构建 Agent 图 / Build agent graph
  const { graph, checkpointer } = buildCodeAgentGraph({
    ...input,
    authorizationOverride: input.authorizationOverride,
  });
  // 跟踪流是否正常完成 / Track if stream completed normally
  let streamCompleted = false;
  try {
    // 以恢复命令启动图流 / Start graph stream with resume command
    const stream = await graph.stream(
      new Command({ resume: input.resume }),
      graphConfig(input.threadId),
    );

    // 标准化流输出 / Normalize stream outputs
    yield* normalizeGraphStream(stream);
    // 标记流已正常完成 / Mark stream as completed
    streamCompleted = true;
  } finally {
    // 仅在流正常完成时关闭 checkpointer / Only close checkpointer if stream completed normally
    if (streamCompleted) {
      checkpointer.close();
    }
  }
}

/** 构建 LangGraph 图运行配置 / Build LangGraph graph run configuration */
function graphConfig(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    streamMode: "updates" as const,
    recursionLimit: 60,
  };
}

/** 标准化图流输出，提取中断、更新、缓存指标和最终答案 / Normalize graph stream output, extract interrupts, updates, cache metrics, and final answers */
export async function* normalizeGraphStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<AgentEvent> {
  // 跟踪当前工作区访问权限 / Track current workspace access
  let currentWorkspaceAccess: WorkspaceAccess | null = null;
  const cacheStandard = createPromptCacheStandardTracker();
  for await (const chunk of stream) {
    // 处理中断事件 / Handle interrupt events
    if (isInterrupted(chunk)) {
      yield {
        type: "interrupt",
        data: chunk[INTERRUPT],
      };
      continue;
    }

    const chunkRecord = chunk as Record<string, unknown>;
    // 处理 INTERRUPT 键 / Handle INTERRUPT key
    if (INTERRUPT in chunkRecord) {
      yield {
        type: "interrupt",
        data: chunkRecord[INTERRUPT],
      };
      continue;
    }

    // 查找并更新当前工作区访问权限 / Find and update current workspace access
    currentWorkspaceAccess = findWorkspaceAccess(chunk) ?? currentWorkspaceAccess;
    // 产出更新事件 / Yield update event
    yield { type: "update", data: chunk };
    // 提取模型重试事件 / Extract model retry events
    for (const retry of findModelRetries(chunk)) {
      yield { type: "model_retry", data: retry };
    }
    // 提取缓存指标 / Extract cache metrics
    const metrics = findPromptCacheMetrics(chunk);
    if (metrics && currentWorkspaceAccess) {
      // 产出缓存指标事件 / Yield cache metrics event
      yield {
        type: "cache_metrics",
        data: {
          workspaceAccess: currentWorkspaceAccess,
          ...metrics,
          standard: cacheStandard.record(metrics) as unknown as Record<string, unknown>,
        },
      };
    }
    // 查找并产出最终答案 / Find and yield final answer
    const final = findFinal(chunk);
    if (final) {
      yield { type: "final", data: final };
    }
  }
}

/** 从流块中查找工作区访问权限 / Find workspace access value from stream chunk */
function findWorkspaceAccess(chunk: unknown): WorkspaceAccess | null {
  for (const value of walkValues(chunk)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const workspaceAccess = (value as Record<string, unknown>).workspaceAccess;
    if (workspaceAccess === "read-only" || workspaceAccess === "write") {
      return workspaceAccess;
    }
  }
  return null;
}

/** 从流块中查找最终答案 / Find final answer from stream chunk */
function findFinal(chunk: unknown): string | null {
  // 非对象类型直接返回 null / Return null for non-object types
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const record = chunk as Record<string, unknown>;
  // 查找 agent 节点中的 final 字段，保留旧节点名兼容已有 checkpoint 流输出 / Find final field in agent nodes
  for (const key of ["agent", "agent_plan", "agent_build"]) {
    const node = record[key] as { final?: unknown } | undefined;
    if (typeof node?.final === "string") {
      return node.final;
    }
  }
  return null;
}

/** 从流块中提取提示缓存指标 / Extract prompt cache metrics from stream chunk */
function findPromptCacheMetrics(chunk: unknown) {
  // 遍历查找 AI 消息中的缓存指标 / Walk to find cache metrics in AI messages
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

/** 从流块中提取模型重试事件 / Extract model retry events from stream chunk */
function findModelRetries(chunk: unknown): ModelRetryEvent[] {
  const all: ModelRetryEvent[] = [];
  for (const value of walkValues(chunk)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const modelRetries = (value as Record<string, unknown>).modelRetries;
    if (Array.isArray(modelRetries)) {
      for (const item of modelRetries) {
        if (item && typeof item === "object" && typeof (item as any).attempt === "number") {
          all.push(item as ModelRetryEvent);
        }
      }
    }
  }
  return all;
}

/** 递归遍历对象值生成器 / Recursively walk object values generator */
function* walkValues(value: unknown): Generator<unknown> {
  // 产出当前值 / Yield current value
  yield value;
  // 非对象类型终止遍历 / Stop traversal for non-object types
  if (!value || typeof value !== "object") {
    return;
  }
  // 递归遍历数组元素 / Recursively walk array elements
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkValues(item);
    }
    return;
  }
  // 递归遍历对象属性值 / Recursively walk object property values
  for (const item of Object.values(value as Record<string, unknown>)) {
    yield* walkValues(item);
  }
}
