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
import { buildModelMessages } from "./context";
import { BunSqliteSaver } from "./checkpoint";
import { createDeepSeekModel } from "./model";
import { deriveModeFromMessages, derivePlanFromMessages, SWITCH_TO_BUILDER_MESSAGE } from "./plan-state";
import {
  createCodeAgentTools,
  createPlanAgentTools,
  isPlanReadOnlyShellCommand,
} from "./tool-definitions";
import {
  applyPatchTool,
  buildApplyPatchCommand,
  shellTool,
  type ShellExecutor,
} from "./tools";
import type { AgentPlan } from "./types";

const AgentState = Annotation.Root({
  userId: Annotation<string>,
  workspace: Annotation<string>,
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  final: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

export type CodeAgentState = typeof AgentState.State;

export interface BuildCodeAgentGraphInput {
  config: AgentConfig;
  checkpointPath: string;
  shellExecutor?: ShellExecutor;
}

export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model = createDeepSeekModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);

  const agent = async (state: CodeAgentState) => {
    const mode = deriveModeFromMessages(state.messages);
    const tools =
      mode === "plan"
        ? createPlanAgentTools({
            workspace: state.workspace,
            shellExecutor: input.shellExecutor,
          })
        : createCodeAgentTools({
            workspace: state.workspace,
            shellExecutor: input.shellExecutor,
          });

    const response = await model
      .bindTools(tools, { tool_choice: "auto" })
      .invoke(
        buildModelMessages("agent", {
          ...state,
          modelName: input.config.modelName,
        }),
      );

    const request = toolRequestFromMessage(response, state.workspace);
    if (request) {
      const toolCallMessage = messageWithSingleToolCall(response, request.id);
      return {
        messages: [toolCallMessage],
      };
    }

    return {
      final: messageText(response),
      messages: [response],
    };
  };

  const approval = async (state: CodeAgentState) => {
    const mode = deriveModeFromMessages(state.messages);
    const request = getPendingToolRequest(state.messages, state.workspace);

    if (mode === "plan" && state.final && !request) {
      const resume = interrupt({
        kind: "mode_confirmation",
        targetMode: "builder",
        plan: state.final,
      }) as boolean | { approved?: boolean; reason?: string };
      const approved =
        resume === true ||
        (typeof resume === "object" && resume !== null && resume.approved === true);

      return approved
        ? {
            final: "",
            messages: [new HumanMessage(SWITCH_TO_BUILDER_MESSAGE)],
          }
        : {};
    }

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

  const tools = async (state: CodeAgentState) => {
    const request = getPendingToolRequest(state.messages, state.workspace);
    if (!request) {
      return {};
    }

    const result = await runApprovedTool(
      state.workspace,
      request,
      input.shellExecutor,
      deriveModeFromMessages(state.messages),
    );

    return {
      messages: [
        new ToolMessage({
          content: JSON.stringify(result),
          tool_call_id: request.id ?? "missing-tool-call-id",
          status: result.ok === false ? "error" : "success",
        }),
      ],
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

  return { graph, checkpointer };
}

export function routeAfterAgent(state: CodeAgentState): "approval" | "tools" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return deriveModeFromMessages(state.messages) === "plan" && state.final ? "approval" : END;
  }
  return deriveModeFromMessages(state.messages) === "plan" || request.name === "update_plan"
    ? "tools"
    : "approval";
}

export function routeAfterApproval(state: CodeAgentState): "tools" | "agent" | typeof END {
  return getPendingToolRequest(state.messages, state.workspace) ? "tools" : "agent";
}

export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  mode: "plan" | "builder" = "builder",
) {
  if (request.name === "update_plan") {
    return {
      ok: true,
      command: "update_plan",
      exitCode: 0,
      stdout: "",
      stderr: "",
      plan: {
        explanation: request.args.explanation,
        items: request.args.items,
      },
    };
  }

  if (request.name === "shell_read") {
    if (!isPlanReadOnlyShellCommand(request.args.command)) {
      return {
        ok: false,
        command: request.args.command,
        exitCode: -1,
        stdout: "",
        stderr: "Rejected: plan mode allows read-only shell commands only.",
      };
    }
    return (shellExecutor ?? shellTool)({
      workspace,
      command: request.args.command,
    });
  }

  if (mode === "plan") {
    return {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: "",
      stderr: "Rejected: Plan mode allows read-only shell commands only.",
    };
  }

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

  return (shellExecutor ?? shellTool)({
    workspace,
    command: request.args.command,
  });
}

export function isPlanMode(messages: BaseMessage[]): boolean {
  return deriveModeFromMessages(messages) === "plan";
}

type PendingToolRequest =
  | {
      id?: string;
      name: "apply_patch";
      args: {
        path: string;
        content: string;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "shell_execute" | "shell_read";
      args: {
        command: string;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "update_plan";
      args: {
        explanation?: string;
        items: AgentPlan["items"];
      };
      reason: string;
      protectedCommand: string;
    };

function getPendingToolRequest(
  messages: BaseMessage[],
  workspace: string,
): PendingToolRequest | null {
  const lastMessage = messages.at(-1);
  if (!(lastMessage instanceof AIMessage)) {
    return null;
  }
  return toolRequestFromMessage(lastMessage, workspace);
}

function toolRequestFromMessage(
  message: AIMessage,
  workspace: string,
): PendingToolRequest | null {
  const call = message.tool_calls?.[0];
  if (!call) {
    return null;
  }

  if (call.name === "apply_patch") {
    const args = call.args as { path?: string; content?: string };
    const path = normalizePatchPath(workspace, args.path || "");
    const content = args.content || "";
    return {
      id: call.id,
      name: "apply_patch",
      args: { path, content },
      reason: "Model requested apply_patch tool call",
      protectedCommand: buildApplyPatchCommand(assertPreviewPath(workspace, path), content),
    };
  }

  if (call.name === "shell_execute") {
    const args = call.args as { command?: string };
    return {
      id: call.id,
      name: "shell_execute",
      args: { command: args.command || "pwd" },
      reason: "Model requested shell_execute tool call",
      protectedCommand: args.command || "pwd",
    };
  }

  if (call.name === "shell_read") {
    const args = call.args as { command?: string };
    return {
      id: call.id,
      name: "shell_read",
      args: { command: args.command || "pwd" },
      reason: "Model requested read-only shell command",
      protectedCommand: args.command || "pwd",
    };
  }

  if (call.name === "update_plan") {
    const args = call.args as Partial<AgentPlan>;
    return {
      id: call.id,
      name: "update_plan",
      args: {
        explanation: args.explanation,
        items: Array.isArray(args.items) ? args.items : [],
      },
      reason: "Model requested plan state update",
      protectedCommand: "update_plan",
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
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

export { Command };
