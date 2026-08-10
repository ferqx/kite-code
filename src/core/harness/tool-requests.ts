import { type AIMessage, aiMessage } from '@/core/messages';
import {
  builtinToolRegistry,
  type PendingBuiltinToolRequest,
} from '@/core/tools/registry/builtins';
import type { ToolAvailabilityContext } from '@/core/tools/registry/spec';
import type { ShellApprovalGrant } from '@/protocol/events';

/** 解析/校验失败的工具调用 — 不进入 PendingToolRequest 联合，非合法请求。 */
export interface InvalidToolRequest {
  source: 'invalid';
  id?: string;
  name: string;
  rawArgs: unknown;
  parseError: string;
  /** Structured failure code from Registry.parseToolCall; distinguishes
   *  unavailable vs. invalid-arguments at the request-adapter layer. */
  parseFailureCode?: import('@/core/tools/registry/registry').ParseFailureCode;
}

/** 动态 MCP 工具请求 — args 无法编译期验证，Record<string,unknown> 是合理上限。 */
export interface PendingMcpToolRequest {
  source: 'mcp';
  id?: string;
  name: `mcp__${string}`;
  args: Record<string, unknown>;
  reason: string;
  protectedCommand: string;
}

/**
 * 待处理的工具请求 / Pending tool request.
 *
 * Builtin 部分从 const tuple 自动推导可辨识联合（name → args 关联由 Registry
 * inputSchema 保证），MCP 部分保持 Record<string,unknown>。
 * 无效调用（parse 失败）由 InvalidToolRequest 单独建模，不混入本联合。
 */
export type PendingToolRequest = PendingBuiltinToolRequest | PendingMcpToolRequest;

/** 工具请求解析结果：合法请求 或 无效调用。 */
export type ToolRequestParseResult =
  | { ok: true; request: PendingToolRequest }
  | { ok: false; request: InvalidToolRequest };

/** 从单个 tool_call 解析工具请求 / Parse tool request from a single tool_call */
export function toolRequestFromCall(
  call: { id?: string; name: string; args: unknown },
  availabilityContext: string | ToolAvailabilityContext,
): ToolRequestParseResult | null {
  const context: ToolAvailabilityContext =
    typeof availabilityContext === 'string'
      ? { workspace: availabilityContext }
      : availabilityContext;

  // 合成调用：invokeModel 在 parseToolCall 失败后注入 _raw_invalid_args 标记。
  // 返回 InvalidToolRequest 而非强转进 PendingToolRequest 联合。
  if (
    call.args !== null &&
    typeof call.args === 'object' &&
    !Array.isArray(call.args) &&
    typeof (call.args as Record<string, unknown>)._raw_invalid_args === 'string'
  ) {
    const argsObj = call.args as Record<string, unknown>;
    return {
      ok: false,
      request: {
        source: 'invalid',
        id: call.id,
        name: call.name,
        rawArgs: argsObj._raw_invalid_args,
        parseError:
          typeof argsObj._parse_error === 'string'
            ? argsObj._parse_error
            : 'invalid JSON arguments',
        parseFailureCode: 'invalid_json',
      },
    };
  }

  // 已迁移到 Registry 的工具走泛型解析（ADR-0043）：
  // parseToolCall 返回类型化结果，Registry 外部不恢复参数类型。
  const viaRegistry = builtinToolRegistry.parseToolCall(
    { id: call.id, name: call.name, args: call.args },
    context,
  );
  let unknownRegistryFailure:
    | { id?: string; name: string; error: string; code: 'unknown_tool' }
    | undefined;
  if (!viaRegistry.ok) {
    // unknown_tool：名称不在 Registry 中，继续检查 MCP 前缀。
    if (viaRegistry.code === 'unknown_tool') {
      unknownRegistryFailure = {
        code: 'unknown_tool',
        id: viaRegistry.id,
        name: viaRegistry.name,
        error: viaRegistry.error,
      };
    } else {
      // tool_unavailable 或 invalid_arguments → InvalidToolRequest。
      return {
        ok: false,
        request: {
          source: 'invalid',
          id: viaRegistry.id,
          name: viaRegistry.name,
          rawArgs: call.args,
          parseError: viaRegistry.error,
          parseFailureCode: viaRegistry.code,
        },
      };
    }
  } else {
    // Registry 返回类型化 ParseSuccess<N,A>；移去 ok 字段，保留 source 得到 PendingBuiltinToolRequest。
    const { ok: _, ...request } = viaRegistry;
    return { ok: true, request };
  }

  if (call.name.startsWith('mcp__')) {
    // MCP 工具：显式验证 args 为非 null 对象，防止数组/字符串等原始值传播。
    if (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) {
      return {
        ok: false,
        request: {
          source: 'invalid',
          id: call.id,
          name: call.name,
          rawArgs: call.args,
          parseError: `MCP tool '${call.name}' arguments must be a JSON object`,
        },
      };
    }
    return {
      ok: true,
      request: {
        source: 'mcp',
        id: call.id,
        name: call.name as `mcp__${string}`,
        args: call.args as Record<string, unknown>,
        reason: `Model requested MCP tool ${call.name}`,
        protectedCommand: call.name,
      },
    };
  }

  return unknownRegistryFailure
    ? {
        ok: false,
        request: {
          source: 'invalid',
          id: unknownRegistryFailure.id,
          name: unknownRegistryFailure.name,
          rawArgs: call.args,
          parseError: unknownRegistryFailure.error,
          parseFailureCode: unknownRegistryFailure.code,
        },
      }
    : null;
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

/** 类型守卫：判断请求是否为动态 MCP 工具调用（基于 source 判别字段）。 */
export function isMcpRequest(req: PendingToolRequest): req is PendingMcpToolRequest {
  return req.source === 'mcp';
}
