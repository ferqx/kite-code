import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOllama } from "@langchain/ollama";
import {
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AgentConfig } from "@/core/config/index";
import {
  buildStaticSystemPrompt,
  prepareModelContext,
  forceContextCompaction,
  sanitizeToolCallPairs,
} from "@/core/model/context";
import {
  buildCacheableRuntimeContext,
  formatWorkspaceAccessReminder,
  formatPlanStateReminder,
} from "@/core/model/runtime-context";
import { createChatModel, type SupportedChatModel } from "@/core/model/factory";
import { type ModelRetryListener, type RetryListenerHost } from "@/core/model/deepseek";
import { BunSqliteSaver } from "@/core/persistence/checkpoint";
import type { ShellApprovalGrant } from "@/protocol/events";
import type { AgentResumeValue, AuthorizationOverride, ModelRetryEvent, ThreadAuthorizationState } from "@/core/types";
import { createAgentTools } from "@/core/tools/definitions";
import type { ShellExecutor } from "@/core/tools/shell";
import type { McpManager } from "@/core/mcp";
import {
  routeAfterAgent,
  routeAfterApproval,
  routeAfterTools,
  routeAfterUserInput,
  routeEntry,
} from "./routes";
import { AgentState, type CodeAgentState } from "./state";
import {
  getAllPendingToolRequests,
  getPendingToolRequest,
  messageText,
  toolRequestFromMessage,
} from "./tool-requests";
import {
  buildToolApproval,
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
  applyApprovalGrant,
  normalizeAuthorizationState,
  replaceApprovalCommand,
  validateApprovalHash,
} from "./tool-policy";
import { runApprovedTool } from "./tool-runner";
import { userInputToolMessage } from "./user-input";
import { createTaskTool } from "@/core/subagent/task-tool";

/** 构建代码 Agent 图的输入 / Build code agent graph input */
export interface BuildCodeAgentGraphInput {
  /** Agent 配置 / Agent configuration */
  config: AgentConfig;
  /** Checkpoint 数据库路径 / Checkpoint database path */
  checkpointPath: string;
  /** 可选的自定义 Shell 执行器 / Optional custom shell executor */
  shellExecutor?: ShellExecutor;
  /** 可选的自定义模型实例（用于 mock 测试）/ Optional custom model instance (for mock testing) */
  model?: SupportedChatModel;
  /** 可选的内存级授权覆盖 / Optional in-memory authorization override */
  authorizationOverride?: AuthorizationOverride;
  /** 思考级别，映射到 reasoning_effort API 参数 / Thinking level, mapped to reasoning_effort API param */
  thinkingLevel?: string | null;
  /** 可选 MCP 管理器 / Optional MCP manager */
  mcpManager?: McpManager;
  /** 可选技能清单 / Optional skill manifests */
  skills?: import("@/core/skills/types").SkillManifest[];
  /** 可选技能扫描选项 / Optional skill scan options */
  skillOptions?: import("@/core/skills/types").SkillScanOptions;
  /** 子 agent 事件回调 */
  subagentEventSink?: import("@/core/subagent/types").SubAgentEventSink;
  /** 子 agent 中止信号 */
  subagentSignal?: AbortSignal;
}

/** 构建 LangGraph 状态图 / Build LangGraph state graph */
export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model = input.model ?? createChatModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);
  const override = input.authorizationOverride;

  // Build MCP risk override map from server configs
  const mcpRiskOverride: Record<string, "read"> = {};
  if (input.mcpManager) {
    for (const [name, state] of input.mcpManager.getServerStates()) {
      if (state.config.risk === "read") {
        mcpRiskOverride[name] = "read";
      }
    }
  }

  /** Agent 节点：使用稳定工具 schema，由执行层强制工作区访问边界 / Agent node */
  const agent = async (state: CodeAgentState) => {
    // 防御层：resume 后清理因 interrupt 产生的孤儿 tool_call/ToolMessage 配对 / Defense: clean up orphaned tool_call/ToolMessage pairs after resume
    const sanitizedMessages = sanitizeToolCallPairs(state.messages);
    const sanitizedState = sanitizedMessages !== state.messages
      ? { ...state, messages: sanitizedMessages }
      : state;
    const tools = createAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
      config: input.config,
      subagentEventSink: input.subagentEventSink,
      subagentSignal: input.subagentSignal,
      signal: input.subagentSignal,
      model: input.model,
      threadId: state.threadId,
    });
    const retryEvents: ModelRetryEvent[] = [];
    let compactionPerformed: { reason: string; summary: string } | null = null;
    const listener: ModelRetryListener = (attempt, error, delayMs) => {
      retryEvents.push({
        attempt,
        error: typeof error === "string" ? error : String(error).slice(0, 200),
        delayMs,
      });
    };
    if (hasRetryListener(model)) model.setRetryListener(listener);

    // 手动压缩：在下一次模型调用前压缩上下文
    // Manual compaction: compact context before next model invocation
    let effectiveState = sanitizedState;
    if (sanitizedState.forceCompact) {
      const compacted = forceContextCompaction(sanitizedState.messages);
      const newSummary = sanitizedState.contextSummary
        ? `${state.contextSummary}\n\n${compacted.summary}`.trim()
        : compacted.summary;
      effectiveState = {
        ...sanitizedState,
        messages: compacted.messages,
        contextSummary: newSummary,
        forceCompact: false,
      } as CodeAgentState;
      compactionPerformed = {
        reason: "Manual compaction triggered by /compact or Ctrl+X c",
        summary: compacted.summary,
      };
    }

    try {
      const { state: result, contextRetries, compactionPerformed: autoCompact } = await invokeModel({ model, state: effectiveState, tools, skills: input.skills });
      if (autoCompact && !compactionPerformed) {
        compactionPerformed = autoCompact;
      }
      const allRetries = [...retryEvents, ...contextRetries];
      const syncedAuth = authorizationForState(state, override);
      const modelConfigState = {
        modelProvider: input.config.providerName,
        modelName: input.config.modelName,
        thinkingLevel: input.thinkingLevel ?? null,
      };
      if (allRetries.length > 0) {
        return { ...result, ...modelConfigState, authorization: syncedAuth, modelRetries: allRetries, compactionPerformed };
      }
      return { ...result, ...modelConfigState, authorization: syncedAuth, compactionPerformed };
    } finally {
      if (hasRetryListener(model)) model.setRetryListener(null);
    }
  };

  /** 审批节点：中断等待人工批准 / Approval node */
  const approval = async (state: CodeAgentState) => {
    const request = getPendingToolRequest(state.messages, state.workspace);

    if (!request) {
      return {};
    }

    const workspaceAccess = state.workspaceAccess ?? "write";
    const policy = evaluateToolPolicy({
      request,
      workspaceAccess,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: state.authorization,
      override,
      mcpRiskOverride,
    });
    const approvalPayload = buildToolApproval({
      workspace: state.workspace,
      threadId: state.threadId,
      request,
      decision: policy,
    });

    const approved = interrupt({
      kind: "tool_approval",
      request,
      policy,
      approval: approvalPayload,
    }) as boolean | {
      approved?: boolean;
      grant?: ShellApprovalGrant;
      approvalHash?: string;
      replacementCommand?: string;
      reason?: string;
    };
    const approvalGrant = approvalGrantFromResume(approved);
    const allowed =
      approved === true ||
      (typeof approved === "object" &&
        approved !== null &&
        (approved.approved === true ||
          (approved.approved === undefined && approvalGrant !== null)) &&
        (approved.approvalHash === undefined ||
          validateApprovalHash(approved, approvalPayload.approvalHash)));

    if (!allowed) {
      const hashMismatch =
        typeof approved === "object" &&
        approved !== null &&
        approved.approvalHash !== undefined &&
        !validateApprovalHash(approved, approvalPayload.approvalHash);
      return rejectedToolMessage(
        request,
        hashMismatch
          ? "approved request does not match current tool request"
          : typeof approved === "object" && approved !== null
            ? approved.reason ?? "not approved"
            : "not approved",
      );
    }

    let approvedRequest = request;
    if (
      typeof approved === "object" &&
      approved !== null &&
      approved.replacementCommand
    ) {
      try {
        approvedRequest = replaceApprovalCommand(request, approved.replacementCommand);
      } catch (error) {
        return rejectedToolMessage(
          request,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const grant = approvalGrant ?? "approve_once";
    const nextAuthorization = applyApprovalGrant({
      authorization: state.authorization,
      grant,
      workspace: state.workspace,
      threadId: state.threadId,
      request: approvedRequest,
    });
    const approvedPolicy = evaluateToolPolicy({
      request: approvedRequest,
      workspaceAccess,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: nextAuthorization,
      override,
    });
    if (!approvedPolicy.allowed) {
      return rejectedToolMessage(
        request,
        `approved command rejected by tool policy: ${approvedPolicy.reason}`,
      );
    }

    return {
      approvedToolRequest: approvedRequest,
      approvedToolGrant: grant,
      authorization: nextAuthorization,
    };
  };

  /** 用户输入节点：中断等待用户选择或自由文本 / User input node */
  const userInput = async (state: CodeAgentState) => {
    const request = getPendingToolRequest(state.messages, state.workspace);

    if (!request || request.name !== "ask_user") {
      return {};
    }

    const resume = interrupt({
      kind: "user_input",
      request,
    }) as AgentResumeValue;

    return {
      messages: [userInputToolMessage(request, resume)],
    };
  };

  /** 执行单个工具调用并返回 ToolMessage / Execute a single tool call and return ToolMessage */
  async function executeOneTool(
    request: import("./tool-requests").PendingToolRequest,
    state: CodeAgentState,
    grantUsed: string,
  ): Promise<{ toolMessage: ToolMessage; extra: Record<string, unknown> }> {
    // Handle task tool (sub-agent dispatch)
    if (request.name === "task" && input.subagentEventSink) {
      try {
        const taskTool = createTaskTool({
          config: input.config,
          workspace: state.workspace,
          shellExecutor: input.shellExecutor,
          mcpManager: input.mcpManager,
          skills: input.skills,
          skillOptions: input.skillOptions,
          eventSink: input.subagentEventSink,
          signal: input.subagentSignal,
          model: input.model,
        });
        const toolOutput = await taskTool.invoke(request.args);
        let taskOk = true;
        try { const p = JSON.parse(toolOutput); taskOk = p.ok !== false; } catch {}
        return {
          toolMessage: new ToolMessage({
            content: toolOutput,
            tool_call_id: request.id ?? "missing-tool-call-id",
            name: request.name,
            status: taskOk ? "success" : "error",
          }),
          extra: {},
        };
      } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        return {
          toolMessage: new ToolMessage({
            content: JSON.stringify({ ok: false, error: errorMsg }),
            tool_call_id: request.id ?? "missing-tool-call-id",
            name: request.name,
            status: "error",
          }),
          extra: {},
        };
      }
    }

    const result = await runApprovedTool({
      workspace: state.workspace,
      request,
      shellExecutor: input.shellExecutor,
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
      authorization: state.authorization,
      approvedGrant: grantUsed as import("@/protocol/events").ShellGrantUsed,
      threadId: state.threadId,
      override,
      mcpManager: input.mcpManager,
      mcpRiskOverride,
      skillManifests: input.skills,
      skillOptions: input.skillOptions,
      signal: input.subagentSignal,
    });
    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: request.id ?? "missing-tool-call-id",
      name: request.name,
      status: result.ok === false ? "error" : "success",
    });

    const extra: Record<string, unknown> = {};
    if ("plan" in result) extra.plan = result.plan;
    if ("workspaceAccess" in result) extra.workspaceAccess = result.workspaceAccess;
    if ("authorization" in result) extra.authorization = result.authorization;
    if ("activeSkillInstructions" in result) extra.activeSkillInstructions = result.activeSkillInstructions;

    return { toolMessage, extra };
  }

  /** 工具节点：执行所有待处理的工具调用 / Tools node — execute all pending tool calls */
  const tools = async (state: CodeAgentState) => {
    // 获取所有待处理的工具请求（支持并行派发多个子 agent 等场景）
    // Get all pending tool requests (supports parallel dispatch of multiple sub-agents etc.)
    const allRequests = getAllPendingToolRequests(state.messages, state.workspace);

    // 如果有审批过的请求，替换匹配的那个
    // If there's an approved request, replace the matching one
    const requests = allRequests.map((r) =>
      state.approvedToolRequest && r.id === state.approvedToolRequest.id
        ? state.approvedToolRequest
        : r,
    );
    const approvedId = state.approvedToolRequest?.id;
    const grantUsed =
      approvedId && requests.some((r) => r.id === approvedId)
        ? state.approvedToolGrant ?? "none"
        : "none";

    if (requests.length === 0) {
      return {};
    }

    // task 工具并行执行，其他工具顺序执行
    // Execute task tools in parallel, other tools sequentially
    const taskRequests = requests.filter((r) => r.name === "task");
    const otherRequests = requests.filter((r) => r.name !== "task");

    const results: Array<{ toolMessage: ToolMessage; extra: Record<string, unknown> }> = [];

    // 并行执行所有 task 工具
    if (taskRequests.length > 0) {
      const taskResults = await Promise.all(
        taskRequests.map((r) => executeOneTool(r, state, grantUsed)),
      );
      results.push(...taskResults);
    }

    // 顺序执行其他工具
    for (const req of otherRequests) {
      results.push(await executeOneTool(req, state, grantUsed));
    }

    // 合并所有 ToolMessage 和 extra 状态
    const messages: ToolMessage[] = results.map((r) => r.toolMessage);
    const mergedExtra: Record<string, unknown> = {};
    for (const r of results) {
      Object.assign(mergedExtra, r.extra);
    }

    return {
      approvedToolRequest: null,
      approvedToolGrant: null,
      ...mergedExtra,
      messages,
    };
  };

  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("user_input", userInput)
    .addNode("tools", tools)
    .addConditionalEdges(START, (state: CodeAgentState) => routeEntry(state, override, mcpRiskOverride))
    .addConditionalEdges("agent", (state: CodeAgentState) => routeAfterAgent(state, override, mcpRiskOverride))
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("user_input", routeAfterUserInput)
    .addConditionalEdges("tools", routeAfterTools)
    .compile({ checkpointer });

  return { graph, checkpointer };
}

/** 检查模型是否支持 RetryListener / Check if model supports RetryListener */
function hasRetryListener(model: SupportedChatModel): model is SupportedChatModel & RetryListenerHost {
  return "setRetryListener" in model && typeof (model as { setRetryListener: unknown }).setRetryListener === "function";
}

/** 将 override 同步到 state.authorization / Sync override to state.authorization */
/**
 * Strip all orphaned ToolMessages whose matching AIMessage is not present.
 * Prevents the DeepSeek 400 error when compaction/slicing breaks tool_call/ToolMessage pairs.
 * Handles orphans at any position (not just leading), which occurs after slice(-8) in layer 2 recovery.
 */
function ensureNoOrphanedToolMessages(messages: BaseMessage[]): BaseMessage[] {
  const hasId = new Set<string>();
  for (const msg of messages) {
    if (msg instanceof AIMessage && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id) hasId.add(tc.id);
      }
    }
  }
  return messages.filter(
    (msg) => !(msg instanceof ToolMessage && !hasId.has(msg.tool_call_id)),
  );
}

function authorizationForState(
  state: CodeAgentState,
  override?: AuthorizationOverride,
): ThreadAuthorizationState {
  const base = normalizeAuthorizationState(state.authorization);
  if (override && override.current !== base.mode) {
    return { ...base, mode: override.current };
  }
  return base;
}

/** invokeModel 参数 / invokeModel parameters (exported for testing) */
export interface InvokeModelParams {
  model: ReturnType<typeof createChatModel>;
  state: CodeAgentState;
  tools: ReturnType<typeof createAgentTools>;
  skills?: import("@/core/skills/types").SkillManifest[];
}

/** invokeModel 返回值 / Return value of invokeModel */
export interface InvokeModelResult {
  /** 图中其他节点可消费的状态更新（不含 modelRetries）/ State update consumed by other graph nodes (without modelRetries) */
  state: Record<string, unknown>;
  /** 上下文溢出重试事件（Layer 1/2），由 agent 节点合并到 modelRetries / Context overflow retry events, merged into modelRetries by agent node */
  contextRetries: ModelRetryEvent[];
  /** 压缩触发信息（由 agent 节点检测并 emit compact 事件）/ Compaction trigger info (detected by agent node to emit compact events) */
  compactionPerformed?: { reason: string; summary: string } | null;
}

/** 共享的模型调用逻辑 / Shared model invocation logic (exported for testing) */
export async function invokeModel({
  model, state, tools, skills,
}: InvokeModelParams): Promise<InvokeModelResult> {
  let prepared = prepareModelContext("agent", state, skills);
  const contextRetries: ModelRetryEvent[] = [];
  let compactionPerformed: { reason: string; summary: string } | null = null;

  let response: AIMessage;
  try {
    response = await bindAgentTools(model, tools)
      .invoke(prepared.messages) as AIMessage;
  } catch (error) {
    if (!isContextOverflowError(error)) throw error;

    // 第一层：规则压缩 + 重试 / Layer 1: rules-based compaction + retry
    contextRetries.push({
      attempt: 1,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      delayMs: 0,
    });
    const compacted = forceContextCompaction(state.messages);
    const retryMessages = rebuildMessages("agent", state, compacted.messages, skills);
    try {
      response = await bindAgentTools(model, tools)
        .invoke(retryMessages) as AIMessage;
      compactionPerformed = {
        reason: "Auto compaction due to context overflow (layer 1: rules-based)",
        summary: compacted.summary,
      };
      prepared = { ...prepared, contextSummary: mergeSummaries(state.contextSummary ?? "", compacted.summary) };
    } catch (retryError) {
      if (!isContextOverflowError(retryError)) throw retryError;

      // 第二层：LLM 自总结 + 重试 / Layer 2: LLM summarization + retry
      contextRetries.push({
        attempt: 2,
        error: retryError instanceof Error ? retryError.message.slice(0, 200) : String(retryError).slice(0, 200),
        delayMs: 0,
      });
      const summaryMsg = await generateLLMSummary(model, state.messages);
      const tail = compacted.messages.slice(-8);
      // Ensure the tail doesn't start with orphaned ToolMessages from the slice
      const safeTail = ensureNoOrphanedToolMessages(tail);
      const llmMessages = [new HumanMessage(summaryMsg), ...safeTail];
      const llmRetry = rebuildMessages("agent", state, llmMessages, skills);
      response = await bindAgentTools(model, tools)
        .invoke(llmRetry) as AIMessage;
      compactionPerformed = {
        reason: "Auto compaction due to context overflow (layer 2: LLM summarization)",
        summary: "Generated conversation summary via LLM",
      };
      prepared = {
        ...prepared,
        contextSummary: mergeSummaries(state.contextSummary ?? "",
          `Compacted conversation via LLM summary after repeated context overflow.`),
      };
    }
  }

  const request = toolRequestFromMessage(response, state.workspace);
  if (request) {
    // 保留完整的 AIMessage（含所有 tool_calls），不剥离其他待处理的调用
    // Keep the full AIMessage with all tool_calls — don't strip other pending calls
    return {
      state: {
        workspaceAccess: state.workspaceAccess,
        phase: state.phase,
        approvedToolRequest: state.approvedToolRequest,
        approvedToolGrant: state.approvedToolGrant,
        authorization: state.authorization,
        contextSummary: prepared.contextSummary,
        messages: [response],
      },
      contextRetries,
      compactionPerformed,
    };
  }

  return {
    state: {
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
      approvedToolRequest: state.approvedToolRequest,
      approvedToolGrant: state.approvedToolGrant,
      authorization: state.authorization,
      contextSummary: prepared.contextSummary,
      final: messageText(response),
      messages: [response],
    },
    contextRetries,
    compactionPerformed,
  };
}

/** 使用 LLM 生成对话摘要 / Generate conversation summary using LLM */
async function generateLLMSummary(
  model: ReturnType<typeof createChatModel>,
  messages: BaseMessage[],
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const role = m.type;
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}] ${content}`;
    })
    .join("\n\n")
    .slice(-8000); // 只取最后 8000 字符作为摘要素材 / Use last 8000 chars as summary material

  const prompt = [
    "Summarize the following conversation for context compaction.",
    "Preserve: files created/modified, verification results, errors, plan state, unresolved issues.",
    "Keep it concise. Output only the summary, no preamble.",
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
  ].join("\n");

  try {
    const summary = await model.invoke([new HumanMessage(prompt)]);
    return `<summary>${typeof summary.content === "string" ? summary.content : JSON.stringify(summary.content)}</summary>`;
  } catch (error) {
    // 摘要调用本身也可能溢出，回退到截断式摘要避免递归
    // Summary call itself may overflow; fall back to truncation to avoid recursion
    if (isContextOverflowError(error)) {
      return `<summary>${conversationText.slice(-2000)}</summary>`;
    }
    throw error;
  }
}

/** 检测 context overflow 错误 / Detect context overflow errors */
function isContextOverflowError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /context.*(?:length|limit|window|exceed|too\s+long)/i.test(msg) ||
    /maximum.*(?:context|token|length)/i.test(msg) ||
    /reduce.*(?:message|context|prompt)/i.test(msg);
}

/** 用压缩后的对话消息重建完整上下文 / Rebuild full context with compacted conversation messages */
function rebuildMessages(
  role: "agent",
  state: CodeAgentState,
  conversationMessages: BaseMessage[],
  skills?: import("@/core/skills/types").SkillManifest[],
): BaseMessage[] {
  const messages: BaseMessage[] = [];
  messages.push(new SystemMessage(buildStaticSystemPrompt(role, skills)));
  messages.push(new SystemMessage(buildCacheableRuntimeContext({ ...state, contextSummary: state.contextSummary ?? "", activeSkillInstructions: state.activeSkillInstructions })));
  messages.push(...conversationMessages);
  if (state.workspaceAccess === "read-only") {
    messages.push(new HumanMessage(formatWorkspaceAccessReminder(state.workspaceAccess)));
  }
  if (state.plan) {
    messages.push(new HumanMessage(formatPlanStateReminder(state.plan)));
  }
  return messages;
}

/** 绑定模型工具，按 provider adapter 传入其支持的调用参数 / Bind tools with provider-supported call options */
function bindAgentTools(
  model: ReturnType<typeof createChatModel>,
  tools: ReturnType<typeof createAgentTools>,
) {
  if (model instanceof ChatOllama) {
    return model.bindTools(tools);
  }
  return model.bindTools(tools, { tool_choice: "auto" });
}

/** 合并已有和新生成的摘要 / Merge existing and new summaries */
function mergeSummaries(existing: string, generated: string): string {
  return [existing.trim(), generated.trim()].filter(Boolean).join("\n");
}

function approvalGrantFromResume(
  resume: boolean | { grant?: ShellApprovalGrant } | null | undefined,
): ShellApprovalGrant | null {
  if (resume === true) {
    return "approve_once";
  }
  if (
    resume &&
    typeof resume === "object" &&
    (resume.grant === "approve_once" ||
      resume.grant === "same_command" ||
      resume.grant === "full_access")
  ) {
    return resume.grant;
  }
  return null;
}

function rejectedToolMessage(
  request: NonNullable<ReturnType<typeof getPendingToolRequest>>,
  reason: string,
) {
  return {
    messages: [
      new ToolMessage({
        content: JSON.stringify({
          ok: false,
          rejected: true,
          reason,
        }),
        tool_call_id: request.id ?? "missing-tool-call-id",
        name: request.name,
        status: "error",
      }),
    ],
  };
}
