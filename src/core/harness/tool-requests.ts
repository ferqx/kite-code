import {
  type AIMessage,
  aiMessage,
  type BaseMessage,
  isAIMessage,
  isToolMessage,
} from '@/core/messages';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import type { ShellActionEnvelope, ShellIntent } from '@/core/types';
import type { ShellApprovalGrant, UserInputOption, UserInputRequest } from '@/protocol/events';

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
      args: { path: string; content: string; mode?: 'overwrite' | 'append' };
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
  // Use isAIMessage() instead of instanceof to handle deserialized
  // messages from checkpoint — isInstance falls back to checking the `type`
  // field when the prototype chain is unavailable (e.g. after JSON round-trip).
  // Iterate ALL tool_calls (not just [0]) to handle multi-tool-call AIMessages
  // where the first call is resolved but later ones are not.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isAIMessage(msg)) continue;
    if (!msg.tool_calls || msg.tool_calls.length === 0) continue;
    for (const call of msg.tool_calls) {
      if (!call.id || resolvedIds.has(call.id)) continue;
      return toolRequestFromCall(call, workspace);
    }
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
    if (!isAIMessage(msg)) continue;
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
export function toolRequestFromCall(
  call: { id?: string; name: string; args: Record<string, unknown> },
  workspace: string,
): PendingToolRequest | null {
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

  // 已迁移到 Registry 的工具走泛型解析（ADR-0026）：args 恒等于 schema 解析结果，
  // 不存在逐字段重映射。schema 无效返回 null，走调用方既有的 tool_not_found 路径。
  const viaRegistry = builtinToolRegistry.parseToolCall(call, { workspace });
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

  if (call.name === 'tool_search') {
    const args = call.args as { query?: unknown; limit?: unknown };
    return {
      id: call.id,
      name: 'tool_search',
      args: {
        query: typeof args.query === 'string' ? args.query.trim().slice(0, 512) : '',
        ...(typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? { limit: Math.max(1, Math.min(12, Math.floor(args.limit))) }
          : {}),
      },
      reason: 'Model requested governed capability metadata search',
      protectedCommand: 'tool_search',
    };
  }

  if (call.name === 'read_plan') {
    const args = call.args as { plan_id?: string; version?: number; structural_digest?: string };
    return {
      id: call.id,
      name: 'read_plan',
      args: {
        plan_id: String(args.plan_id ?? ''),
        version: args.version != null ? Number(args.version) : undefined,
        structural_digest:
          typeof args.structural_digest === 'string' ? args.structural_digest : undefined,
      },
      reason: 'Model requested a saved Plan Artifact',
      protectedCommand: 'read_plan',
    };
  }

  if (call.name === 'edit_file') {
    const args = call.args as {
      path?: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
    };
    return {
      id: call.id,
      name: 'edit_file',
      args: {
        path: args.path || '',
        old_string: args.old_string || '',
        new_string: args.new_string || '',
        replace_all: args.replace_all,
      },
      reason: 'Model requested edit_file',
      protectedCommand: `edit_file ${args.path || ''}`,
    };
  }

  if (call.name === 'write_file') {
    const args = call.args as { path?: string; content?: string; mode?: 'overwrite' | 'append' };
    return {
      id: call.id,
      name: 'write_file',
      args: { path: args.path || '', content: args.content || '', mode: args.mode },
      reason: 'Model requested write_file',
      protectedCommand: `write_file ${args.path || ''}`,
    };
  }

  if (call.name === 'shell_execute') {
    const args = normalizeShellActionEnvelope(call.args);
    return {
      id: call.id,
      name: 'shell_execute',
      args,
      reason: 'Model requested shell_execute tool call',
      protectedCommand: args.command,
    };
  }

  if (call.name === 'update_plan') {
    const args = call.args as Record<string, unknown>;
    return {
      id: call.id,
      name: 'update_plan',
      args: {
        plan_id: String(args.plan_id ?? ''),
        updates: (Array.isArray(args.updates) ? args.updates : []).map(
          (u: Record<string, unknown>) => ({
            step_id: String(u.step_id ?? ''),
            status: String(u.status ?? 'pending'),
            note: u.note != null ? String(u.note) : undefined,
          }),
        ),
        complete_plan: args.complete_plan != null ? Boolean(args.complete_plan) : undefined,
      },
      reason: 'Model requested plan progress update',
      protectedCommand: 'update_plan',
    };
  }

  if (call.name === 'write_plan') {
    const args = call.args as Record<string, unknown>;
    const action = args.action === 'submit' ? 'submit' : 'save';
    const normalizedArgs: Extract<PendingToolRequest, { name: 'write_plan' }>['args'] = {
      expected_version: args.expected_version != null ? Number(args.expected_version) : undefined,
      action,
      replan_reason: typeof args.replan_reason === 'string' ? args.replan_reason : undefined,
      ...(typeof args.title === 'string' ? { title: args.title } : {}),
      ...(typeof args.body_markdown === 'string' ? { body_markdown: args.body_markdown } : {}),
      ...(Array.isArray(args.steps)
        ? {
            steps: args.steps.map((s: Record<string, unknown>) => ({
              id: String(s.id ?? ''),
              title: String(s.title ?? ''),
            })),
          }
        : {}),
      ...(typeof args.plan_id === 'string' ? { plan_id: args.plan_id } : {}),
      ...(args.version != null ? { version: Number(args.version) } : {}),
      ...(typeof args.structural_digest === 'string'
        ? { structural_digest: args.structural_digest }
        : {}),
    };
    return {
      id: call.id,
      name: 'write_plan',
      args: normalizedArgs,
      reason: action === 'submit' ? 'Model submitted plan for review' : 'Model saved plan draft',
      protectedCommand: 'write_plan',
    };
  }

  if (call.name === 'ask_user') {
    const args = call.args as Partial<UserInputRequest>;
    return {
      id: call.id,
      name: 'ask_user',
      args: normalizeUserInputRequest(args),
      reason: 'Model requested user clarification',
      protectedCommand: 'ask_user',
    };
  }

  if (call.name === 'list_mcp_resources') {
    const args = call.args as { server?: string };
    return {
      id: call.id,
      name: 'list_mcp_resources',
      args: { ...(args.server ? { server: args.server } : {}) },
      reason: 'Model requested MCP resource discovery',
      protectedCommand: `list_mcp_resources ${args.server || ''}`.trim(),
    };
  }

  if (call.name === 'list_mcp_tools') {
    const args = call.args as { provider?: unknown; limit?: unknown; cursor?: unknown };
    return {
      id: call.id,
      name: 'list_mcp_tools',
      args: {
        ...(typeof args.provider === 'string' && args.provider.trim().length > 0
          ? { provider: args.provider.trim().slice(0, 128) }
          : {}),
        ...(typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? { limit: Math.max(1, Math.min(100, Math.floor(args.limit))) }
          : {}),
        ...(typeof args.cursor === 'string' && args.cursor.length <= 2048
          ? { cursor: args.cursor }
          : {}),
      },
      reason: 'Model requested MCP tool inventory',
      protectedCommand: 'list_mcp_tools',
    };
  }

  if (call.name === 'read_mcp_resource') {
    const args = call.args as { server?: string; uri?: string };
    return {
      id: call.id,
      name: 'read_mcp_resource',
      args: { server: args.server || '', uri: args.uri || '' },
      reason: 'Model requested MCP resource read',
      protectedCommand: `read_mcp_resource ${args.server || ''}`,
    };
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

  if (call.name === 'search_content') {
    const args = call.args as { pattern?: string; path?: string; glob?: string };
    return {
      id: call.id,
      name: 'search_content',
      args: { pattern: args.pattern || '', path: args.path, glob: args.glob },
      reason: 'Model requested content search',
      protectedCommand: `search_content ${args.pattern || ''}`,
    };
  }

  if (call.name === 'search_files') {
    const args = call.args as { pattern?: string; path?: string };
    return {
      id: call.id,
      name: 'search_files',
      args: { pattern: args.pattern || '', path: args.path },
      reason: 'Model requested file search',
      protectedCommand: `search_files ${args.pattern || ''}`,
    };
  }

  if (call.name === 'activate_skill') {
    const args = call.args as { skill_id?: unknown; input?: unknown };
    return {
      id: call.id,
      name: 'activate_skill',
      args: {
        skill_id: typeof args.skill_id === 'string' ? args.skill_id : '',
        input:
          args.input && typeof args.input === 'object' && !Array.isArray(args.input)
            ? (args.input as Record<string, unknown>)
            : {},
      },
      reason: 'Model requested Skill Workflow activation',
      protectedCommand: 'activate_skill',
    };
  }

  if (call.name === 'complete_skill') {
    const args = call.args as { activation_id?: unknown; output?: unknown };
    return {
      id: call.id,
      name: 'complete_skill',
      args: {
        activation_id: typeof args.activation_id === 'string' ? args.activation_id : '',
        output:
          args.output && typeof args.output === 'object' && !Array.isArray(args.output)
            ? (args.output as Record<string, unknown>)
            : {},
      },
      reason: 'Model completed a Skill Workflow',
      protectedCommand: 'complete_skill',
    };
  }

  if (call.name === 'read_skill_reference') {
    const args = call.args as { activation_id?: unknown; path?: unknown };
    return {
      id: call.id,
      name: 'read_skill_reference',
      args: {
        activation_id: typeof args.activation_id === 'string' ? args.activation_id : '',
        path: typeof args.path === 'string' ? args.path : '',
      },
      reason: 'Model requested an active Skill reference',
      protectedCommand: 'read_skill_reference',
    };
  }

  if (call.name === 'task') {
    const args = call.args as Record<string, unknown> | undefined;
    return {
      id: call.id,
      name: 'task',
      args: {
        subagent_type: (args?.subagent_type as 'explore' | 'plan' | 'code' | 'review') ?? 'explore',
        task: (args?.task as string) ?? '',
      },
      reason: 'Model requested sub-agent dispatch',
      protectedCommand: 'task',
    };
  }

  if (call.name === 'web_fetch') {
    const args = call.args as { url?: string; max_chars?: number; timeout_ms?: number };
    return {
      id: call.id,
      name: 'web_fetch',
      args: { url: args.url || '', max_chars: args.max_chars, timeout_ms: args.timeout_ms },
      reason: 'Model requested web page fetch',
      protectedCommand: `web_fetch ${args.url || ''}`,
    };
  }

  return null;
}

/**
 * 检测消息是否为 ToolMessage。
 * 通过 type 字段（'tool'）判别，对 checkpoint 反序列化后的 plain object 同样生效。
 *
 * Detect whether a message is a ToolMessage instance.
 * Uses the `type` field ('tool') — works for both factory-created objects
 * and checkpoint-deserialized plain objects.
 */
function isToolMessageInstance(msg: unknown): boolean {
  return isToolMessage(msg);
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

/** 规范化所有选项（单个问题级别）/ Normalize options for a single question */
function normalizeOptions(raw: unknown[]): UserInputOption[] {
  return raw
    .filter((option): option is Partial<UserInputOption> => !!option && typeof option === 'object')
    .map((option, index) => {
      const id =
        typeof option.id === 'string' && option.id.trim() ? option.id : `option-${index + 1}`;
      const label = typeof option.label === 'string' && option.label.trim() ? option.label : id;
      const normalized: UserInputOption = { id, label };
      if (typeof option.description === 'string' && option.description.trim())
        normalized.description = option.description;
      return normalized;
    });
}

/** 规范化用户澄清请求 / Normalize user clarification request */
function normalizeUserInputRequest(value: Partial<UserInputRequest>): UserInputRequest {
  const rawOptions = Array.isArray(value.options) ? (value.options as unknown[]) : [];
  const options = normalizeOptions(rawOptions);

  // 规范化多问题列表 / Normalize multi-question items
  let questions: UserInputRequest['questions'];
  if (Array.isArray(value.questions)) {
    questions = (value.questions as unknown[]).map((q: unknown) => {
      const item = q as Record<string, unknown>;
      const itemOptions = Array.isArray(item.options) ? (item.options as unknown[]) : [];
      return {
        question: typeof item.question === 'string' ? item.question : '',
        options: normalizeOptions(itemOptions),
        allow_free_text: item.allow_free_text !== false,
        ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id } : {}),
        ...(typeof item.recommended === 'string' ? { recommended: item.recommended } : {}),
      };
    });
  }

  const question =
    typeof value.question === 'string' && value.question.trim()
      ? value.question
      : (questions?.[0]?.question ?? '');

  return {
    question,
    options,
    allow_free_text: value.allow_free_text !== false,
    ...(typeof value.context === 'string' && value.context.trim()
      ? { context: value.context }
      : {}),
    ...(typeof value.recommended === 'string' && value.recommended.trim()
      ? { recommended: value.recommended }
      : {}),
    ...(questions ? { questions } : {}),
  };
}

/** 规范化 shell_execute action envelope / Normalize shell_execute action envelope */
function normalizeShellActionEnvelope(value: unknown): ShellActionEnvelope {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const command =
    typeof record.command === 'string' && record.command.trim() ? record.command : 'pwd';
  return {
    command,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(isShellIntent(record.intent) ? { intent: record.intent } : {}),
    ...(typeof record.objective === 'string' ? { objective: record.objective } : {}),
    ...(typeof record.justification === 'string' ? { justification: record.justification } : {}),
    ...(typeof record.expected_observation === 'string'
      ? { expected_observation: record.expected_observation }
      : {}),
    ...(typeof record.failure_strategy === 'string'
      ? { failure_strategy: record.failure_strategy }
      : {}),
    ...(typeof record.timeout_ms === 'number' && Number.isFinite(record.timeout_ms)
      ? { timeout_ms: Math.max(1, Math.floor(record.timeout_ms)) }
      : {}),
    ...(Array.isArray(record.prefix_rule)
      ? {
          prefix_rule: record.prefix_rule.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
    ...(isShellApprovalGrant(record.grant_request) ? { grant_request: record.grant_request } : {}),
  };
}

function isShellIntent(value: unknown): value is ShellIntent {
  switch (value) {
    case 'inspect':
    case 'verify':
    case 'build':
    case 'test':
    case 'git':
    case 'other':
      return true;
    default:
      return false;
  }
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
