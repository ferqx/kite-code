import { isAbsolute, relative } from "node:path";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  messagesStateReducer,
} from "@langchain/langgraph";
import type { AgentConfig } from "./config";
import { extractPromptCacheMetrics, type PromptCacheMetrics } from "./cache-metrics";
import { buildModelMessages } from "./context";
import { BunSqliteSaver } from "./checkpoint";
import { SqliteLongTermMemory } from "./memory";
import { createDeepSeekModel } from "./model";
import { createCodeAgentTools } from "./tool-definitions";
import {
  applyPatchTool,
  buildApplyPatchCommand,
  shellTool,
  type ShellExecutor,
} from "./tools";
import type { ToolRequest } from "./types";

export type ThreadMode = "plan" | "builder";
export type ThreadModeInput = ThreadMode | "execute";

const AgentState = Annotation.Root({
  task: Annotation<string>,
  userId: Annotation<string>,
  workspace: Annotation<string>,
  threadMode: Annotation<ThreadMode>({
    reducer: (_left, right) => right,
    default: () => "builder",
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  memories: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  roles: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  toolRequest: Annotation<ToolRequest | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  toolResults: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  final: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  verification: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  cacheMetrics: Annotation<PromptCacheMetrics | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

export type CodeAgentState = typeof AgentState.State;

export interface BuildCodeAgentGraphInput {
  config: AgentConfig;
  checkpointPath: string;
  memoryPath: string;
  shellExecutor?: ShellExecutor;
}

export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model = createDeepSeekModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);
  const memory = new SqliteLongTermMemory(input.memoryPath);

  const agent = async (state: CodeAgentState) => {
    const memories = memory.recallText(state.userId);
    const initializedMessages =
      state.messages.length > 0 ? state.messages : [new HumanMessage(state.task)];

    if (state.threadMode === "plan") {
      const response = await model.invoke(
        buildModelMessages("agent", {
          ...state,
          modelName: input.config.modelName,
          memories,
          messages: initializedMessages,
        }),
      );
      return {
        memories,
        final: messageText(response),
        messages: state.messages.length > 0 ? [response] : [initializedMessages[0], response],
        cacheMetrics: extractPromptCacheMetrics(response),
        roles: ["agent"],
        toolRequest: {
          type: "mode_change",
          targetMode: "builder",
          reason: "Plan mode completed and requires user confirmation before edits.",
        } satisfies ToolRequest,
      };
    }

    const tools = createCodeAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
    });
    const response = await model
      .bindTools(tools, { tool_choice: "auto" })
      .invoke(
        buildModelMessages("agent", {
          ...state,
          modelName: input.config.modelName,
          memories,
          messages: initializedMessages,
        }),
      );

    const request = toolRequestFromMessage(response, state);
    if (request) {
      const toolCallMessage = messageWithSingleToolCall(response, request.id);
      return {
        memories,
        messages:
          state.messages.length > 0
            ? [toolCallMessage]
            : [initializedMessages[0], toolCallMessage],
        cacheMetrics: extractPromptCacheMetrics(response),
        toolRequest: request,
        roles: ["agent"],
      };
    }

    return {
      memories,
      final: messageText(response),
      messages: state.messages.length > 0 ? [response] : [initializedMessages[0], response],
      cacheMetrics: extractPromptCacheMetrics(response),
      roles: ["agent"],
    };
  };

  const approval = async (state: CodeAgentState) => {
    if (!state.toolRequest) {
      return {};
    }

    if (state.toolRequest.type === "mode_change") {
      const resume = interrupt({
        kind: "mode_confirmation",
        targetMode: state.toolRequest.targetMode,
        plan: state.final,
      }) as boolean | { approved?: boolean; nextMode?: ThreadModeInput; reason?: string };
      const approved =
        resume === true ||
        (typeof resume === "object" && resume !== null && resume.approved === true);
      return {
        threadMode: approved
          ? typeof resume === "object" && resume.nextMode
            ? normalizeThreadMode(resume.nextMode)
            : state.toolRequest.targetMode
          : state.threadMode,
        final: approved ? "" : state.final,
        messages: approved
          ? [
              new HumanMessage(
                state.toolRequest.targetMode === "plan"
                  ? "Plan mode confirmed. Create a concise plan for the original user request. Do not edit files."
                  : "Plan confirmed. Switch to builder mode and complete the original user request using tools as needed.",
              ),
            ]
          : [],
        toolRequest: null,
        roles: ["approval"],
      };
    }

    const approved = interrupt({
      kind: "tool_approval",
      request: state.toolRequest,
    }) as boolean | { approved?: boolean; reason?: string };
    const allowed =
      approved === true ||
      (typeof approved === "object" && approved !== null && approved.approved === true);

    if (!allowed) {
      return {
        toolRequest: null,
        toolResults: [
          `Rejected: ${
            typeof approved === "object" && approved !== null
              ? approved.reason ?? "not approved"
              : "not approved"
          }`,
        ],
        roles: ["approval"],
      };
    }

    return {
      roles: ["approval"],
    };
  };

  const tools = async (state: CodeAgentState) => {
    if (!state.toolRequest || state.toolRequest.type !== "tool_call") {
      return {};
    }

    const result = await runApprovedTool(
      state.workspace,
      state.toolRequest,
      input.shellExecutor,
    );
    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: state.toolRequest.id ?? "missing-tool-call-id",
      status: result?.ok === false ? "error" : "success",
    });

    if (state.toolRequest.name === "remember") {
      memory.put({
        userId: state.userId,
        namespace: state.toolRequest.args.namespace,
        key: state.toolRequest.args.key,
        value: state.toolRequest.args.value,
      });
    }

    return {
      toolRequest: null,
      toolResults: [JSON.stringify(result)],
      messages: [toolMessage],
      roles: ["tools"],
    };
  };

  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("tools", tools)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent)
    .addConditionalEdges("approval", routeAfterApproval)
    .addEdge("tools", "agent")
    .compile({ checkpointer });

  return { graph, checkpointer, memory };
}

function routeAfterAgent(state: CodeAgentState): "approval" | typeof END {
  return state.toolRequest ? "approval" : END;
}

export function routeAfterApproval(state: CodeAgentState): "tools" | "agent" | typeof END {
  if (state.toolRequest?.type === "tool_call") {
    return "tools";
  }
  return "agent";
}

async function runApprovedTool(
  workspace: string,
  request: Extract<ToolRequest, { type: "tool_call" }>,
  shellExecutor?: ShellExecutor,
) {
  if (request.name === "apply_patch") {
    if (!request.args.path || !request.args.content) {
      return {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: "",
        stderr: "apply_patch requires explicit path and content arguments from the model.",
      };
    }
    return applyPatchTool({
      workspace,
      path: request.args.path,
      content: request.args.content,
      shellExecutor,
    });
  }
  if (request.name === "remember") {
    return {
      ok: true,
      command: request.protectedCommand,
      exitCode: 0,
      stdout: request.args.value,
      stderr: "",
    };
  }
  return (shellExecutor ?? shellTool)({
    workspace,
    command: request.args.command,
  });
}

function toolRequestFromMessage(
  message: AIMessage,
  state: CodeAgentState,
): Extract<ToolRequest, { type: "tool_call" }> | null {
  const call = message.tool_calls?.find((item) => item.name === "remember") ?? message.tool_calls?.[0];
  if (!call) {
    return null;
  }

  if (call.name === "apply_patch") {
    const args = call.args as { path?: string; content?: string };
    const path = normalizePatchPath(state.workspace, args.path || "");
    const content = args.content || "";
    return {
      type: "tool_call",
      id: call.id,
      name: "apply_patch",
      args: { path, content },
      reason: "Model requested apply_patch tool call",
      protectedCommand: buildApplyPatchCommand(assertPreviewPath(state.workspace, path), content),
    };
  }

  if (call.name === "shell_execute") {
    const args = call.args as { command?: string };
    return {
      type: "tool_call",
      id: call.id,
      name: "shell_execute",
      args: { command: args.command || "pwd" },
      reason: "Model requested shell_execute tool call",
      protectedCommand: args.command || "pwd",
    };
  }

  if (call.name === "remember") {
    const args = call.args as { namespace?: string; key?: string; value?: string };
    const namespace = args.namespace || "task";
    const key = args.key || "memory";
    const value = args.value || "";
    return {
      type: "tool_call",
      id: call.id,
      name: "remember",
      args: { namespace, key, value },
      reason: "Model requested long-term memory storage",
      protectedCommand: `remember ${namespace}/${key}`,
    };
  }

  return null;
}

function messageWithSingleToolCall(message: AIMessage, toolCallId?: string): AIMessage {
  const selectedCall =
    message.tool_calls?.find((call) => call.id === toolCallId) ?? message.tool_calls?.[0];
  if (!selectedCall) {
    return message;
  }

  const rawToolCalls = Array.isArray(message.additional_kwargs.tool_calls)
    ? message.additional_kwargs.tool_calls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "id" in call &&
          call.id === selectedCall.id,
      )
    : message.additional_kwargs.tool_calls;

  return new AIMessage({
    id: message.id,
    content: message.content,
    additional_kwargs: {
      ...message.additional_kwargs,
      tool_calls: rawToolCalls,
    },
    response_metadata: message.response_metadata,
    tool_calls: [selectedCall],
    usage_metadata: message.usage_metadata,
  });
}

function normalizePatchPath(workspace: string, requestedPath: string): string {
  if (!isAbsolute(requestedPath)) {
    return requestedPath;
  }

  const relativePath = relative(workspace, requestedPath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }

  return "";
}

function assertPreviewPath(workspace: string, path: string): string {
  return `${workspace.replace(/[\\/]+$/, "")}\\${path}`;
}

function messageText(message: AIMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return JSON.stringify(message.content);
}

export function normalizeThreadMode(mode: ThreadModeInput | undefined): ThreadMode {
  if (mode === "plan") {
    return "plan";
  }
  return "builder";
}

export { Command };
