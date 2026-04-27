import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AgentConfig } from "../config/index";
import { prepareModelContext } from "../model/context";
import { createChatModel } from "../model/factory";
import { BunSqliteSaver } from "../persistence/checkpoint";
import type { AgentResumeValue } from "../shared/types";
import { createAgentTools } from "../tools/definitions";
import type { ShellExecutor } from "../tools/shell";
import {
  routeAfterAgent,
  routeAfterApproval,
  routeAfterReflect,
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

    const approved = interrupt({
      kind: "tool_approval",
      request,
    }) as boolean | { approved?: boolean; reason?: string };
    const allowed =
      approved === true ||
      (typeof approved === "object" && approved !== null && approved.approved === true);

    if (!allowed) {
      return {
        messages: [
          new ToolMessage({
            content: JSON.stringify({
              ok: false,
              rejected: true,
              reason:
                typeof approved === "object" && approved !== null
                  ? approved.reason ?? "not approved"
                  : "not approved",
            }),
            tool_call_id: request.id ?? "missing-tool-call-id",
            status: "error",
          }),
        ],
      };
    }

    return {};
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
    const request = getPendingToolRequest(state.messages, state.workspace);
    if (!request) {
      return {};
    }

    const result = await runApprovedTool(
      state.workspace,
      request,
      input.shellExecutor,
      state.workspaceAccess,
      state.plan,
    );
    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: request.id ?? "missing-tool-call-id",
      status: result.ok === false ? "error" : "success",
    });

    if ("plan" in result) {
      return {
        plan: result.plan,
        ...("workspaceAccess" in result
          ? { workspaceAccess: result.workspaceAccess }
          : {}),
        messages: [toolMessage],
      };
    }

    return {
      messages: [toolMessage],
    };
  };

  /** 反思节点：评估工具执行结果，注入失败指导 / Reflect node */
  const reflect = async (state: CodeAgentState) => {
    const lastMessage = state.messages.at(-1);
    if (lastMessage instanceof ToolMessage && lastMessage.status === "error") {
      let detail = "unknown error";
      try {
        const parsed = JSON.parse(
          typeof lastMessage.content === "string" ? lastMessage.content : "{}",
        );
        if (typeof parsed.stderr === "string" && parsed.stderr) {
          detail = parsed.stderr.slice(0, 200);
        }
      } catch {
        /* ignore parse failure */
      }
      return {
        messages: [
          new HumanMessage(
            `Tool execution failed: ${detail}. Inspect the failure and choose a different approach.`,
          ),
        ],
      };
    }

    return {};
  };

  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("user_input", userInput)
    .addNode("tools", tools)
    .addNode("reflect", reflect)
    .addConditionalEdges(START, routeEntry)
    .addConditionalEdges("agent", routeAfterAgent)
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("user_input", routeAfterUserInput)
    .addConditionalEdges("tools", routeAfterTools)
    .addConditionalEdges("reflect", routeAfterReflect)
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
      contextSummary: prepared.contextSummary,
      messages: [toolCallMessage],
    };
  }

  return {
    workspaceAccess: state.workspaceAccess,
    contextSummary: prepared.contextSummary,
    final: messageText(response as AIMessage),
    messages: [response],
  };
}
