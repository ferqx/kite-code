import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  AgentPlan,
  PlanStatus,
  ShellApprovalGrant,
  UserInputOption,
  UserInputRequest,
} from "@/protocol/events";
import type {
  ShellActionEnvelope,
  ShellIntent,
} from "@/core/types";

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
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "shell_execute";
      args: ShellActionEnvelope;
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
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "read_mcp_resource";
      args: { server: string; uri: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "search_code";
      args: { pattern: string; path?: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "Skill";
      args: { skill: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "task";
      args: { subagent_type: "explore" | "code" | "review"; task: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    };

/** 从消息列表中获取待处理的工具请求 / Get pending tool request from message list

 向后搜索最新的含有 tool_calls 的 AIMessage，检查其 tool_call_id 是否已被后方
 ToolMessage 应答，避免 checkpoint 恢复时遗漏悬空工具调用。
*/
export function getPendingToolRequest(
  messages: BaseMessage[],
  workspace: string,
): PendingToolRequest | null {
  // Collect resolved tool_call_ids from ToolMessages
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (isToolMessageInstance(msg)) {
      const tcId = (msg as unknown as Record<string, string>).tool_call_id;
      if (tcId) resolvedIds.add(tcId);
    }
  }

  // Search backwards for the last AIMessage with an unresolved tool_call.
  // Use AIMessage.isInstance() instead of instanceof to handle deserialized
  // messages from checkpoint — isInstance falls back to checking the `type`
  // field when the prototype chain is unavailable (e.g. after JSON round-trip).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!AIMessage.isInstance(msg)) continue;
    const call = msg.tool_calls?.[0];
    if (!call) continue;
    if (!call.id || resolvedIds.has(call.id)) continue;
    return toolRequestFromMessage(msg, workspace);
  }

  return null;
}

/** 从消息列表中获取最后一个 AIMessage 的所有待处理工具请求 / Get all pending tool requests from the last AIMessage

 与 getPendingToolRequest 相同的搜索逻辑，但返回所有未解决的 tool_calls，
 用于在 tools 节点中批量处理（如并行派发多个子 agent）。
*/
export function getAllPendingToolRequests(
  messages: BaseMessage[],
  workspace: string,
): PendingToolRequest[] {
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (isToolMessageInstance(msg)) {
      const tcId = (msg as unknown as Record<string, string>).tool_call_id;
      if (tcId) resolvedIds.add(tcId);
    }
  }

  // Find the last AIMessage with tool_calls
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!AIMessage.isInstance(msg)) continue;
    if (!msg.tool_calls || msg.tool_calls.length === 0) continue;

    // Parse all unresolved tool_calls from this AIMessage
    const requests: PendingToolRequest[] = [];
    for (const call of msg.tool_calls) {
      if (!call.id || resolvedIds.has(call.id)) continue;
      const req = toolRequestFromCall(call, workspace);
      if (req) requests.push(req);
    }
    return requests;
  }

  return [];
}

/** 从单个 tool_call 解析工具请求 / Parse tool request from a single tool_call */
function toolRequestFromCall(
  call: { id?: string; name: string; args: Record<string, unknown> },
  _workspace: string,
): PendingToolRequest | null {
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
    const args = call.args as { path?: string; old_string?: string; new_string?: string; replace_all?: boolean };
    return {
      id: call.id,
      name: "edit_file",
      args: { path: args.path || "", old_string: args.old_string || "", new_string: args.new_string || "", replace_all: args.replace_all },
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

  if (call.name === "shell_execute") {
    const args = normalizeShellActionEnvelope(call.args);
    return {
      id: call.id,
      name: "shell_execute",
      args,
      reason: "Model requested shell_execute tool call",
      protectedCommand: args.command,
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

  if (call.name === "read_mcp_resource") {
    const args = call.args as { server?: string; uri?: string };
    return {
      id: call.id,
      name: "read_mcp_resource",
      args: { server: args.server || "", uri: args.uri || "" },
      reason: "Model requested MCP resource read",
      protectedCommand: `read_mcp_resource ${args.server || ""}`,
    };
  }

  if (call.name === "Skill") {
    const args = call.args as { skill?: string };
    return {
      id: call.id,
      name: "Skill",
      args: { skill: args.skill || "" },
      reason: "Model requested Skill tool",
      protectedCommand: "Skill",
    };
  }

  if (call.name === "task") {
    const args = call.args as Record<string, unknown> | undefined;
    return {
      id: call.id,
      name: "task",
      args: {
        subagent_type: (args?.subagent_type as "explore" | "code" | "review") ?? "explore",
        task: (args?.task as string) ?? "",
      },
      reason: "Model requested sub-agent dispatch",
      protectedCommand: "task",
    };
  }

  return null;
}

/**
 * 检测消息是否为 ToolMessage 实例。
 * 优先使用 _getType() 方法（正确构造的实例），fallback 到检查
 * tool_call_id 字段（checkpoint 反序列化后的 plain object）。
 *
 * Detect whether a message is a ToolMessage instance.
 * Prefer _getType() (correctly constructed instances), fall back to
 * checking the tool_call_id field (plain objects after checkpoint deserialization).
 */
function isToolMessageInstance(msg: unknown): boolean {
  const m = msg as Record<string, unknown> | null;
  if (!m) return false;

  // Primary: use _getType() for correctly constructed instances
  try {
    if (typeof m._getType === "function") {
      return (m._getType as () => string).call(m) === "tool";
    }
  } catch { /* ignore */ }

  // Fallback: checkpoint-deserialized messages — check for tool_call_id
  // which is unique to ToolMessage in the LangChain message hierarchy
  if (typeof m.tool_call_id === "string" && m.tool_call_id.length > 0) {
    // Guard against false positives: AIMessage never has tool_call_id
    if (AIMessage.isInstance(msg)) return false;
    // HumanMessage / SystemMessage never have tool_call_id
    return true;
  }

  return false;
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

  if (call.name === "shell_execute") {
    const args = normalizeShellActionEnvelope(call.args);
    return {
      id: call.id,
      name: "shell_execute",
      args,
      reason: "Model requested shell_execute tool call",
      protectedCommand: args.command,
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

  if (call.name === "read_mcp_resource") {
    const args = call.args as { server?: string; uri?: string };
    return {
      id: call.id,
      name: "read_mcp_resource",
      args: { server: args.server || "", uri: args.uri || "" },
      reason: "Model requested MCP resource read",
      protectedCommand: `read_mcp_resource ${args.server || ""}`,
    };
  }

  if (call.name === "Skill") {
    const args = call.args as { skill?: string };
    return {
      id: call.id,
      name: "Skill",
      args: { skill: args.skill || "" },
      reason: "Model requested Skill tool",
      protectedCommand: "Skill",
    };
  }

  if (call.name === "task") {
    const args = call.args as Record<string, unknown> | undefined;
    return {
      id: call.id,
      name: "task",
      args: {
        subagent_type: (args?.subagent_type as "explore" | "code" | "review") ?? "explore",
        task: (args?.task as string) ?? "",
      },
      reason: "Model requested sub-agent dispatch",
      protectedCommand: "task",
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
    : [];

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

/** 规范化 shell_execute action envelope / Normalize shell_execute action envelope */
function normalizeShellActionEnvelope(value: unknown): ShellActionEnvelope {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const command = typeof record.command === "string" && record.command.trim()
    ? record.command
    : "pwd";
  return {
    command,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(isShellIntent(record.intent) ? { intent: record.intent } : {}),
    ...(typeof record.objective === "string" ? { objective: record.objective } : {}),
    ...(typeof record.justification === "string"
      ? { justification: record.justification }
      : {}),
    ...(typeof record.expected_observation === "string"
      ? { expected_observation: record.expected_observation }
      : {}),
    ...(typeof record.failure_strategy === "string"
      ? { failure_strategy: record.failure_strategy }
      : {}),
    ...(Array.isArray(record.prefix_rule)
      ? { prefix_rule: record.prefix_rule.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(isShellApprovalGrant(record.grant_request)
      ? { grant_request: record.grant_request }
      : {}),
  };
}

function isShellIntent(value: unknown): value is ShellIntent {
  switch (value) {
    case "inspect":
    case "verify":
    case "build":
    case "test":
    case "git":
    case "other":
      return true;
    default:
      return false;
  }
}

export function isShellApprovalGrant(value: unknown): value is ShellApprovalGrant {
  switch (value) {
    case "approve_once":
    case "same_command":
    case "full_access":
      return true;
    default:
      return false;
  }
}
