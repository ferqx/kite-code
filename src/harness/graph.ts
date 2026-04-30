import { AIMessage, ToolMessage } from "@langchain/core/messages";
import {
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AgentConfig } from "../config/index";
import { prepareModelContext } from "../model/context";
import { createChatModel } from "../model/factory";
import { BunSqliteSaver } from "../persistence/checkpoint";
import type { AgentResumeValue, ShellApprovalGrant } from "../shared/types";
import { createAgentTools } from "../tools/definitions";
import type { ShellExecutor } from "../tools/shell";
import {
  routeAfterAgent,
  routeAfterApproval,
  routeAfterTools,
  routeAfterUserInput,
  routeEntry,
} from "./routes";
import { AgentState, type CodeAgentState } from "./state";
import {
  getPendingToolRequest,
  messageText,
  messageWithSingleToolCall,
  toolRequestFromMessage,
} from "./tool-requests";
import {
  buildToolApproval,
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
  applyApprovalGrant,
  replaceApprovalCommand,
  validateApprovalHash,
} from "./tool-policy";
import { runApprovedTool } from "./tool-runner";
import { userInputToolMessage } from "./user-input";

/** 构建代码 Agent 图的输入 / Build code agent graph input */
export interface BuildCodeAgentGraphInput {
  /** Agent 配置 / Agent configuration */
  config: AgentConfig;
  /** Checkpoint 数据库路径 / Checkpoint database path */
  checkpointPath: string;
  /** 可选的自定义 Shell 执行器 / Optional custom shell executor */
  shellExecutor?: ShellExecutor;
}

/** 构建 LangGraph 状态图 / Build LangGraph state graph */
export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model = createChatModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);

  /** Agent 节点：使用稳定工具 schema，由执行层强制工作区访问边界 / Agent node */
  const agent = async (state: CodeAgentState) => {
    const tools = createAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
    });
    return invokeModel(model, state, tools);
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

  /** 工具节点：执行已批准的工具调用 / Tools node */
  const tools = async (state: CodeAgentState) => {
    const pendingRequest = getPendingToolRequest(state.messages, state.workspace);
    const request =
      state.approvedToolRequest &&
      pendingRequest &&
      state.approvedToolRequest.id === pendingRequest.id
        ? state.approvedToolRequest
        : pendingRequest;
    const grantUsed =
      state.approvedToolRequest &&
      pendingRequest &&
      state.approvedToolRequest.id === pendingRequest.id
        ? state.approvedToolGrant ?? "none"
        : "none";
    if (!request) {
      return {};
    }

    const result = await runApprovedTool(
      state.workspace,
      request,
      input.shellExecutor,
      state.workspaceAccess,
      state.plan,
      state.phase,
      state.authorization,
      grantUsed,
      state.threadId,
    );
    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: request.id ?? "missing-tool-call-id",
      status: result.ok === false ? "error" : "success",
    });

    if ("plan" in result) {
      return {
        plan: result.plan,
        approvedToolRequest: null,
        approvedToolGrant: null,
        ...("workspaceAccess" in result
          ? { workspaceAccess: result.workspaceAccess }
          : {}),
        messages: [toolMessage],
      };
    }

    return {
      approvedToolRequest: null,
      approvedToolGrant: null,
      messages: [toolMessage],
    };
  };

  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("user_input", userInput)
    .addNode("tools", tools)
    .addConditionalEdges(START, routeEntry)
    .addConditionalEdges("agent", routeAfterAgent)
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("user_input", routeAfterUserInput)
    .addConditionalEdges("tools", routeAfterTools)
    .compile({ checkpointer });

  return { graph, checkpointer };
}

/** 共享的模型调用逻辑 / Shared model invocation logic */
async function invokeModel(
  model: ReturnType<typeof createChatModel>,
  state: CodeAgentState,
  tools: ReturnType<typeof createAgentTools>,
) {
  const prepared = prepareModelContext("agent", state);

  const response = await model
    .bindTools(tools, { tool_choice: "auto" })
    .invoke(prepared.messages);

  const request = toolRequestFromMessage(response as AIMessage, state.workspace);
  if (request) {
    const toolCallMessage = messageWithSingleToolCall(response as AIMessage, request.id);
    return {
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
      approvedToolRequest: state.approvedToolRequest,
      approvedToolGrant: state.approvedToolGrant,
      authorization: state.authorization,
      contextSummary: prepared.contextSummary,
      messages: [toolCallMessage],
    };
  }

  return {
    workspaceAccess: state.workspaceAccess,
    phase: state.phase,
    approvedToolRequest: state.approvedToolRequest,
    approvedToolGrant: state.approvedToolGrant,
    authorization: state.authorization,
    contextSummary: prepared.contextSummary,
    final: messageText(response as AIMessage),
    messages: [response],
  };
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
        status: "error",
      }),
    ],
  };
}
