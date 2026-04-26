import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AgentConfig } from "../config/index";
import { prepareModelContext } from "../model/context";
import { createDeepSeekModel } from "../model/deepseek";
import { BunSqliteSaver } from "../persistence/checkpoint";
import {
  createCodeAgentTools,
  createPlanAgentTools,
} from "../tools/definitions";
import type { ShellExecutor } from "../tools/shell";
import { WATCHDOG_STAGNANT_LIMIT } from "./constants";
import { updateEvidence } from "./evidence";
import { recordToolProgress } from "./progress";
import {
  routeAfterAgentBuild,
  routeAfterAgentPlan,
  routeAfterApproval,
  routeAfterReflect,
  routeAfterTools,
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
  const model = createDeepSeekModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);

  /** Plan Agent 节点：使用只读工具进行代码检查和计划 / Plan Agent node */
  const agentPlan = async (state: CodeAgentState) => {
    const tools = createPlanAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
    });
    return invokeModel(model, state, tools, "agent_plan", input.config.modelName);
  };

  /** Build Agent 节点：使用读写工具执行计划步骤 / Build Agent node */
  const agentBuild = async (state: CodeAgentState) => {
    const tools = createCodeAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
    });
    return invokeModel(model, state, tools, "agent_build", input.config.modelName);
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
      state.mode,
      state.plan,
      state.progress,
    );
    const evidence = updateEvidence(state.evidence, request, result);
    const nextPlan = "plan" in result ? result.plan ?? null : state.plan;
    const progress = recordToolProgress({
      previous: state.progress,
      requestName: request.name,
      requestArgs: request.args,
      result,
      previousEvidence: state.evidence,
      nextEvidence: evidence,
      previousPlan: state.plan,
      nextPlan,
    });
    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: request.id ?? "missing-tool-call-id",
      status: result.ok === false ? "error" : "success",
    });

    if ("plan" in result) {
      return {
        plan: result.plan,
        ...("mode" in result ? { mode: result.mode } : {}),
        evidence,
        progress,
        messages: [toolMessage],
      };
    }

    return {
      evidence,
      progress,
      messages: [toolMessage],
    };
  };

  /** 反思节点：评估工具执行结果，注入看门狗或失败指导 / Reflect node */
  const reflect = async (state: CodeAgentState) => {
    const progress = state.progress;
    if (!progress) return {};

    if (progress.stagnantStepCount >= WATCHDOG_STAGNANT_LIMIT) {
      return {
        messages: [
          new HumanMessage(
            `No progress detected across ${progress.stagnantStepCount} consecutive tool step(s). Change strategy, inspect a different signal, update the plan, or report a blocker.`,
          ),
        ],
      };
    }

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
    .addNode("agent_plan", agentPlan)
    .addNode("agent_build", agentBuild)
    .addNode("approval", approval)
    .addNode("tools", tools)
    .addNode("reflect", reflect)
    .addConditionalEdges(START, routeEntry)
    .addConditionalEdges("agent_plan", routeAfterAgentPlan)
    .addConditionalEdges("agent_build", routeAfterAgentBuild)
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("tools", routeAfterTools)
    .addConditionalEdges("reflect", routeAfterReflect)
    .compile({ checkpointer });

  return { graph, checkpointer };
}

/** 共享的模型调用逻辑 / Shared model invocation logic */
async function invokeModel(
  model: ReturnType<typeof createDeepSeekModel>,
  state: CodeAgentState,
  tools: ReturnType<typeof createPlanAgentTools> | ReturnType<typeof createCodeAgentTools>,
  role: "agent_plan" | "agent_build",
  modelName: string,
) {
  const prepared = prepareModelContext(role, {
    ...state,
    modelName,
  });

  const response = await model
    .bindTools(tools, { tool_choice: "auto" })
    .invoke(prepared.messages);

  const request = toolRequestFromMessage(response as AIMessage, state.workspace);
  if (request) {
    const toolCallMessage = messageWithSingleToolCall(response as AIMessage, request.id);
    return {
      mode: state.mode,
      contextSummary: prepared.contextSummary,
      messages: [toolCallMessage],
    };
  }

  return {
    mode: state.mode,
    contextSummary: prepared.contextSummary,
    final: messageText(response as AIMessage),
    messages: [response],
  };
}
