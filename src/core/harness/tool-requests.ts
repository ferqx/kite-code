import { type AIMessage, aiMessage } from '@/core/messages';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import type { ToolAvailabilityContext } from '@/core/tools/registry/spec';
import type { ShellApprovalGrant } from '@/protocol/events';

/** 工具名枚举——从 Registry 派生，保持编译期完备性。 */
export type BuiltinToolName = string;

/** 待处理的工具请求 / Pending tool request.
 *
 * args 由 Registry inputSchema 解析后透传（一致性不变量 i1），类型不再手工
 * 重复声明。需要编译期工具名收窄时从 Registry spec 导出类型，而非在此维护
 * 第二份手写参数声明。 */
export interface PendingToolRequest {
  id?: string;
  name: string;
  args: unknown;
  reason: string;
  protectedCommand: string;
}

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
