import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOllama } from "@langchain/ollama";
import {
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AgentConfig } from "@/core/config/index";
import {
  prepareModelContext,
  sanitizeToolCallPairs,
} from "@/core/model/context";
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
  const model = input.model ?? createChatModel({ ...input.config, reasoningEffort: input.thinkingLevel ?? input.config.reasoningEffort ?? null });
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
    const listener: ModelRetryListener = (attempt, error, delayMs) => {
      retryEvents.push({
        attempt,
        error: typeof error === "string" ? error : String(error).slice(0, 200),
        delayMs,
      });
    };
    if (hasRetryListener(model)) model.setRetryListener(listener);

    let effectiveState = sanitizedState;

    try {
      const { state: result } = await invokeModel({ model, state: effectiveState, tools, skills: input.skills });
      const syncedAuth = authorizationForState(state, override);
      const modelConfigState = {
        modelProvider: input.config.providerName,
        modelName: input.config.modelName,
        thinkingLevel: input.thinkingLevel ?? null,
      };
      if (retryEvents.length > 0) {
        return { ...result, ...modelConfigState, authorization: syncedAuth, modelRetries: retryEvents };
      }
      return { ...result, ...modelConfigState, authorization: syncedAuth };
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
  /** 图中其他节点可消费的状态更新 / State update consumed by other graph nodes */
  state: Record<string, unknown>;
}

/** 共享的模型调用逻辑 / Shared model invocation logic (exported for testing) */
export async function invokeModel({
  model, state, tools, skills,
}: InvokeModelParams): Promise<InvokeModelResult> {
  const prepared = prepareModelContext("agent", state, skills);

  const response = await bindAgentTools(model, tools)
    .invoke(prepared.messages) as AIMessage;

  const request = toolRequestFromMessage(response, state.workspace);
  if (request) {
    return {
      state: {
        workspaceAccess: state.workspaceAccess,
        phase: state.phase,
        approvedToolRequest: state.approvedToolRequest,
        approvedToolGrant: state.approvedToolGrant,
        authorization: state.authorization,
        messages: [response],
      },
    };
  }

  return {
    state: {
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
      approvedToolRequest: state.approvedToolRequest,
      approvedToolGrant: state.approvedToolGrant,
      authorization: state.authorization,
      final: messageText(response),
      messages: [response],
    },
  };
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
