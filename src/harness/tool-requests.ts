import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  AgentPlan,
  PlanStatus,
  UserInputOption,
  UserInputRequest,
} from "../shared/types";

/** 待处理的工具请求（可辨识联合类型） / Pending tool request (discriminated union) */
export type PendingToolRequest =
  | {
      id?: string;
      name: "read_file";
      args: { path: string; offset?: number; limit?: number };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "edit_file";
      args: {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "write_file";
      args: { path: string; content: string };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "search";
      args: {
        pattern: string;
        path?: string;
        context_lines?: number;
        case_sensitive?: boolean;
        max_results?: number;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "shell_execute" | "shell_read";
      args: {
        /** shell 命令 / Shell command */
        command: string;
      };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "update_plan";
      /** 计划数据 / Plan data */
      args: AgentPlan;
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "ask_user";
      /** 用户澄清请求 / User clarification request */
      args: UserInputRequest;
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于事件展示的命令 / Command displayed in events */
      protectedCommand: string;
    };

/** 从消息列表中获取待处理的工具请求 / Get pending tool request from message list */
export function getPendingToolRequest(
  messages: BaseMessage[],
  workspace: string,
): PendingToolRequest | null {
  const lastMessage = messages.at(-1);
  if (!(lastMessage instanceof AIMessage)) {
    return null;
  }
  return toolRequestFromMessage(lastMessage, workspace);
}

/** 解析 AIMessage 中的工具调用请求 / Parse tool call request from an AIMessage */
export function toolRequestFromMessage(
  message: AIMessage,
  _workspace: string,
): PendingToolRequest | null {
  const call = message.tool_calls?.[0];
  if (!call) {
    return null;
  }

  if (call.name === "read_file") {
    const args = call.args as { path?: string; offset?: number; limit?: number };
    return {
      id: call.id,
      name: "read_file",
      args: { path: args.path || "", offset: args.offset, limit: args.limit },
      reason: "Model requested read_file",
      protectedCommand: `read_file ${args.path || ""}`,
    };
  }

  if (call.name === "edit_file") {
    const args = call.args as {
      path?: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
    };
    return {
      id: call.id,
      name: "edit_file",
      args: {
        path: args.path || "",
        old_string: args.old_string || "",
        new_string: args.new_string || "",
        replace_all: args.replace_all,
      },
      reason: "Model requested edit_file",
      protectedCommand: `edit_file ${args.path || ""}`,
    };
  }

  if (call.name === "write_file") {
    const args = call.args as { path?: string; content?: string };
    return {
      id: call.id,
      name: "write_file",
      args: { path: args.path || "", content: args.content || "" },
      reason: "Model requested write_file",
      protectedCommand: `write_file ${args.path || ""}`,
    };
  }

  if (call.name === "search") {
    const args = call.args as {
      pattern?: string;
      path?: string;
      context_lines?: number;
      case_sensitive?: boolean;
      max_results?: number;
    };
    return {
      id: call.id,
      name: "search",
      args: {
        pattern: args.pattern || "",
        path: args.path,
        context_lines: args.context_lines,
        case_sensitive: args.case_sensitive,
        max_results: args.max_results,
      },
      reason: "Model requested search",
      protectedCommand: `search ${args.pattern || ""}`,
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
      args: normalizeAgentPlan(args),
      reason: "Model requested plan state update",
      protectedCommand: "update_plan",
    };
  }

  if (call.name === "ask_user") {
    const args = call.args as Partial<UserInputRequest>;
    return {
      id: call.id,
      name: "ask_user",
      args: normalizeUserInputRequest(args),
      reason: "Model requested user clarification",
      protectedCommand: "ask_user",
    };
  }

  return null;
}

/** 从 AIMessage 中提取并保留单个工具调用 / Extract and keep a single tool call from AIMessage */
export function messageWithSingleToolCall(
  message: AIMessage,
  toolCallId?: string,
): AIMessage {
  const selectedCall =
    message.tool_calls?.find((call) => call.id === toolCallId) ??
    message.tool_calls?.[0];
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

  const reasoningContent = message.additional_kwargs.reasoning_content as
    | string
    | undefined;

  return new AIMessage({
    id: message.id,
    content: message.content,
    additional_kwargs: {
      ...message.additional_kwargs,
      tool_calls: rawToolCalls,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    },
    response_metadata: message.response_metadata,
    tool_calls: [selectedCall],
    usage_metadata: message.usage_metadata,
  });
}

/** 提取 AIMessage 的文本内容 / Extract text content from AIMessage */
export function messageText(message: AIMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

/** 规范化 Agent 计划结构，填充默认值 / Normalize Agent plan structure */
function normalizeAgentPlan(value: Partial<AgentPlan>): AgentPlan {
  const rawSteps: unknown[] = Array.isArray(value.steps) ? (value.steps as unknown[]) : [];
  return {
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    status: normalizePlanStatus(value.status),
    steps: rawSteps
      .filter((step): step is Record<string, unknown> => !!step && typeof step === "object")
      .map((step) => ({
        step: typeof step.step === "string" ? step.step : "",
        status: normalizePlanStatus(step.status),
      })),
  };
}

/** 规范化用户澄清请求 / Normalize user clarification request */
function normalizeUserInputRequest(value: Partial<UserInputRequest>): UserInputRequest {
  const rawOptions = Array.isArray(value.options) ? (value.options as unknown[]) : [];
  const options = rawOptions
    .filter((option): option is Partial<UserInputOption> => {
      return !!option && typeof option === "object";
    })
    .map((option, index) => {
      const id =
        typeof option.id === "string" && option.id.trim()
          ? option.id
          : `option-${index + 1}`;
      const label =
        typeof option.label === "string" && option.label.trim()
          ? option.label
          : id;
      return {
        id,
        label,
        ...(typeof option.description === "string" && option.description.trim()
          ? { description: option.description }
          : {}),
      };
    });

  return {
    question: typeof value.question === "string" ? value.question : "",
    options,
    allow_free_text: value.allow_free_text !== false,
    ...(typeof value.context === "string" && value.context.trim()
      ? { context: value.context }
      : {}),
  };
}

/** 规范化计划状态值 / Normalize plan status value */
function normalizePlanStatus(status: unknown): PlanStatus {
  return status === "in_progress" || status === "completed" ? status : "pending";
}
