import { type AIMessage, aiMessage } from '@/core/messages';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import type { ToolAvailabilityContext } from '@/core/tools/registry/spec';
import type { ShellActionEnvelope } from '@/core/types';
import type { ShellApprovalGrant, UserInputRequest } from '@/protocol/events';

/** 待处理的工具请求（可辨识联合类型） / Pending tool request (discriminated union) */
export type PendingToolRequest =
  | {
      /** Provider-neutral metadata discovery; never an invocation request. */
      id?: string;
      name: 'tool_search';
      args: { query: string; limit?: number };
      reason: string;
      protectedCommand: string;
    }
  | {
      /** Reads a declared non-prompt Skill file through an active Runtime frame. */
      id?: string;
      name: 'read_skill_reference';
      args: { activation_id: string; path: string };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'complete_skill';
      args: { activation_id: string; output: Record<string, unknown> };
      reason: string;
      protectedCommand: string;
    }
  | {
      /** Runtime-mediated Workflow Contract activation request. */
      id?: string;
      name: 'activate_skill';
      args: { skill_id: string; input: Record<string, unknown> };
      reason: string;
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'search_content';
      args: { pattern: string; path?: string; glob?: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'search_files';
      args: { pattern: string; path?: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'read_file';
      args: { path: string; offset?: number; limit?: number };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'read_plan';
      args: { plan_id: string; version?: number; structural_digest?: string };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'edit_file';
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
      name: 'write_file';
      args: { path: string; content: string };
      reason: string;
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'shell_execute';
      args: ShellActionEnvelope;
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'update_plan';
      /** 进度更新参数 / Progress update params */
      args: {
        plan_id: string;
        updates: Array<{ step_id: string; status: string; note?: string }>;
        complete_plan?: boolean;
      };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'write_plan';
      /** write_plan 参数 / write_plan params */
      args: {
        title?: string;
        body_markdown?: string;
        steps?: Array<{ id: string; title: string }>;
        expected_version?: number;
        action: 'save' | 'submit';
        replan_reason?: string;
        plan_id?: string;
        version?: number;
        structural_digest?: string;
      };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'ask_user';
      /** 用户澄清请求 / User clarification request */
      args: UserInputRequest;
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于事件展示的命令 / Command displayed in events */
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'list_mcp_resources';
      args: { server?: string };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'list_mcp_tools';
      args: { provider?: string; limit?: number; cursor?: string };
      reason: string;
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'read_mcp_resource';
      args: { server: string; uri: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** Dynamic MCP calls are accepted only when the Runtime resolves a binding. */
      id?: string;
      name: `mcp__${string}`;
      args: Record<string, unknown>;
      reason: string;
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: 'task';
      args: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      id?: string;
      name: 'web_fetch';
      args: { url: string; max_chars?: number; timeout_ms?: number };
      reason: string;
      protectedCommand: string;
    };

/** 从单个 tool_call 解析工具请求 / Parse tool request from a single tool_call */
export function toolRequestFromCall(
  call: { id?: string; name: string; args: Record<string, unknown> },
  availabilityContext: string | ToolAvailabilityContext,
): PendingToolRequest | null {
  const context: ToolAvailabilityContext =
    typeof availabilityContext === 'string'
      ? { workspace: availabilityContext }
      : availabilityContext;
  // 合成调用：invokeModel 在 parseToolCall 失败后注入 _raw_invalid_args 标记。
  // 跳过工具特定的 args 规范化，保留标记字段直通 runApprovedTool 生成错误反馈。
  // Synthetic call: injected by invokeModel after parseToolCall failure.
  // Skip per-tool args normalization, preserve markers for runApprovedTool.
  if (typeof call.args._raw_invalid_args === 'string') {
    return {
      id: call.id,
      name: call.name,
      args: call.args,
      reason: `Model requested ${call.name} (synthetic — parse failure)`,
      protectedCommand: call.name,
    } as PendingToolRequest;
  }

  // 已迁移到 Registry 的工具走泛型解析（ADR-0043）：args 恒等于 schema 解析结果，
  // 不存在逐字段重映射。schema 无效返回 null，走调用方既有的 tool_not_found 路径。
  const viaRegistry = builtinToolRegistry.parseToolCall(call, context);
  if (viaRegistry) {
    if (!viaRegistry.ok) return null;
    return {
      id: viaRegistry.id,
      name: viaRegistry.name,
      args: viaRegistry.args,
      reason: viaRegistry.reason,
      protectedCommand: viaRegistry.protectedCommand,
    } as PendingToolRequest;
  }

  if (call.name.startsWith('mcp__')) {
    return {
      id: call.id,
      name: call.name as `mcp__${string}`,
      args: call.args,
      reason: `Model requested MCP tool ${call.name}`,
      protectedCommand: call.name,
    };
  }

  return null;
}

/** 从 AIMessage 中提取并保留单个工具调用 / Extract and keep a single tool call from AIMessage */
export function messageWithSingleToolCall(message: AIMessage, toolCallId?: string): AIMessage {
  const selectedCall =
    message.tool_calls?.find((call) => call.id === toolCallId) ?? message.tool_calls?.[0];
  if (!selectedCall) {
    return message;
  }

  const rawToolCalls = Array.isArray(message.additional_kwargs.tool_calls)
    ? message.additional_kwargs.tool_calls.filter(
        (call) =>
          typeof call === 'object' && call !== null && 'id' in call && call.id === selectedCall.id,
      )
    : [];

  const reasoningContent = message.additional_kwargs.reasoning_content as string | undefined;

  return aiMessage({
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
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

export function isShellApprovalGrant(value: unknown): value is ShellApprovalGrant {
  switch (value) {
    case 'approve_once':
    case 'same_command':
    case 'full_access':
      return true;
    default:
      return false;
  }
}
