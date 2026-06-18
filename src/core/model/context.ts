import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import systemPrompt from '@/core/prompts/system-prompt.txt';
import type { SkillManifest } from '@/core/skills/types';
import type { AgentPlan } from '@/protocol/events';
import { buildCacheableRuntimeContext, formatPlanStateReminder } from './runtime-context';
/** Agent 角色定义 / Agent role definition */
export type AgentRole = 'agent';

/** 模型上下文状态输入 / Model context state input */
export interface ModelContextState {
  /** 工作目录 / Workspace path */
  workspace: string;
  /** 对话消息列表 / Conversation messages */
  messages: BaseMessage[];
  /** 最终回答文本 / Final answer text */
  final: string;
  /** 工作区访问权限 / Workspace access level (always "write") */
  workspaceAccess?: 'write';
  /** 执行计划 / Execution plan */
  plan?: AgentPlan | null;
  /** 激活的 Skill 关键指令 / Active skill critical instructions */
  activeSkillInstructions?: string;
}

/** 准备好的模型上下文 / Prepared model context */
export interface PreparedModelContext {
  /** 组装好的消息列表 / Assembled message list */
  messages: BaseMessage[];
}

/** 构建模型消息列表 / Build model message list */
export function buildModelMessages(
  role: AgentRole,
  state: ModelContextState,
  skills?: SkillManifest[],
): BaseMessage[] {
  return prepareModelContext(role, state, skills).messages;
}

/**
 * 确保 tool_call/ToolMessage 配对完整性：移除孤儿消息（有 tool_calls 无 ToolMessage 的 AIMessage
 * 保留文本内容但清空 tool_calls；移除无匹配 AIMessage 的孤儿 ToolMessage）。
 *
 * 这是 LangGraph interrupt 模型下的正常防御层（非 bug workaround）：
 * - 当 agent 被 interrupt 挂起时，LangGraph 会将未完成的 AIMessage（带 tool_calls）写入 checkpoint，
 *   resume 后这些消息仍在对话历史中，但对应的 ToolMessage 可能不存在（由 resume 路径注入）。
 * - 此函数在每次重建上下文时清理这些结构不完整的配对，防止 DeepSeek API 400 错误。
 *
 * This is a normal defense layer for LangGraph's interrupt model (not a bug workaround):
 * - When the agent is suspended by interrupt, LangGraph writes the pending AIMessage (with tool_calls)
 *   to the checkpoint. After resume, these messages remain but matching ToolMessages may be missing.
 * - This function cleans up incomplete pairs on every context rebuild to prevent API 400 errors.
 */
/**
 * Sanitize orphaned tool-call / tool-result pairs from the message list.
 *
 * After checkpoint deserialization, messages may be plain objects that fail
 * `instanceof` checks. Use field-based detection as fallback to ensure
 * incomplete tool_call pairs are always cleaned.
 */
export function sanitizeToolCallPairs(messages: BaseMessage[]): BaseMessage[] {
  // Helper: get a plain object view of a message for field-based detection
  const asObj = (msg: BaseMessage): Record<string, unknown> =>
    msg as unknown as Record<string, unknown>;

  // Collect all tool_call_ids from AIMessages in the list
  const aiToolCallIds = new Set<string>();
  for (const msg of messages) {
    // Check both tool_calls and additional_kwargs.tool_calls (both can contain tool call data)
    const m = asObj(msg);
    const toolCalls = m.tool_calls;
    const akwToolCalls = (m.additional_kwargs as Record<string, unknown> | undefined)?.tool_calls;
    for (const tc of [toolCalls, akwToolCalls]) {
      if (Array.isArray(tc)) {
        for (const item of tc) {
          if (
            item &&
            typeof item === 'object' &&
            'id' in item &&
            (item as Record<string, unknown>).id
          ) {
            aiToolCallIds.add((item as Record<string, unknown>).id as string);
          }
        }
      }
    }
  }

  // Collect all tool_call_ids from ToolMessages in the list
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    const m = asObj(msg);
    if (
      typeof m.tool_call_id === 'string' &&
      m.tool_call_id.length > 0 &&
      !AIMessage.isInstance(msg)
    ) {
      toolResultIds.add(m.tool_call_id);
    }
  }

  // Fix orphaned AIMessages: strip tool_calls that have no matching ToolMessage
  let result: BaseMessage[] = [];
  for (const msg of messages) {
    const m = asObj(msg);
    const toolCalls = m.tool_calls;
    const akwToolCalls = (m.additional_kwargs as Record<string, unknown> | undefined)?.tool_calls;
    // Check both tool_calls sources
    const allToolCalls = (Array.isArray(toolCalls) ? toolCalls : []).concat(
      Array.isArray(akwToolCalls) ? akwToolCalls : [],
    );
    if (allToolCalls.length > 0) {
      const orphaned = allToolCalls.some((tc: unknown) => {
        if (!tc || typeof tc !== 'object') return true;
        const id = (tc as Record<string, unknown>).id;
        return !id || !toolResultIds.has(id as string);
      });
      if (orphaned) {
        // Only keep calls that have IDs AND matching ToolMessages
        const validCalls = (Array.isArray(toolCalls) ? toolCalls : []) as Array<
          Record<string, unknown>
        >;
        const kept = validCalls.filter((tc) => tc.id && toolResultIds.has(tc.id as string));
        // Rebuild message — preserve non-tool additional_kwargs (e.g. reasoning_content)
        // and response_metadata while explicitly clearing tool_calls to prevent
        // stale data from leaking through LangChain's API serialization.
        const cleanAkw = { ...(msg.additional_kwargs ?? {}) } as Record<string, unknown>;
        delete cleanAkw.tool_calls;
        const newMsg = new AIMessage({
          content: typeof msg.content === 'string' ? msg.content : '',
          tool_calls: kept.length > 0 ? (kept as AIMessage['tool_calls']) : [],
          additional_kwargs: cleanAkw,
          response_metadata: msg.response_metadata ?? {},
        });
        result.push(newMsg);
        continue;
      }
    }
    // Check for orphaned ToolMessage
    if (
      typeof m.tool_call_id === 'string' &&
      m.tool_call_id.length > 0 &&
      !AIMessage.isInstance(msg)
    ) {
      if (!aiToolCallIds.has(m.tool_call_id)) {
        continue;
      }
    }
    result.push(msg);
  }

  // Reorder: ensure ToolMessages immediately follow their AIMessage.
  // The graph's cleanup node adds cancelled ToolMessages for orphaned tool_calls,
  // but LangGraph's append-only messages reducer places them after any new
  // HumanMessage. This shim groups each AIMessage with its ToolMessages
  // before the interleaved user message, satisfying the API requirement.
  result = reorderInterleavedMessages(result);

  return result;
}

/** Group ToolMessages directly after their AIMessage for API compatibility.
 *
 * Uses a two-pass approach: first build a tool_call_id → ToolMessage index,
 * then emit each AIMessage immediately followed by all its ToolMessages.
 * This correctly handles multiple consecutive AIMessages, interleaved
 * human messages, and cancelled ToolMessages appended at the end by cleanup.
 *
 * Exported for testing. */
export function reorderInterleavedMessages(messages: BaseMessage[]): BaseMessage[] {
  // Build index: tool_call_id → ToolMessages
  const toolMsgByCallId = new Map<string, BaseMessage[]>();
  for (const msg of messages) {
    const m = msg as unknown as Record<string, unknown>;
    if (typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0) {
      const list = toolMsgByCallId.get(m.tool_call_id);
      if (list) list.push(msg);
      else toolMsgByCallId.set(m.tool_call_id, [msg]);
    }
  }

  const placed = new Set<BaseMessage>();
  const ordered: BaseMessage[] = [];

  for (const msg of messages) {
    if (placed.has(msg)) continue;

    const tcField = (msg as unknown as Record<string, unknown>).tool_calls;
    if (Array.isArray(tcField) && tcField.length > 0) {
      ordered.push(msg);
      placed.add(msg);

      // Emit matching ToolMessages immediately after, in declaration order
      for (const tc of tcField) {
        if (tc && typeof tc === 'object' && 'id' in tc && tc.id) {
          const tms = toolMsgByCallId.get(tc.id as string);
          if (tms) {
            for (const tm of tms) {
              if (!placed.has(tm)) {
                ordered.push(tm);
                placed.add(tm);
              }
            }
          }
        }
      }
    } else {
      ordered.push(msg);
      placed.add(msg);
    }
  }

  return ordered;
}

/** 准备模型上下文（组装系统提示词 + 对话消息，接近阈值时清理旧工具结果） / Prepare model context (assemble, clear old tool results when near threshold) */
export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
  skills?: SkillManifest[],
): PreparedModelContext {
  const msgs =
    state.messages.length > 0 ? sanitizeToolCallPairs(state.messages) : [new HumanMessage('')];

  // 合并静态系统提示词与可缓存运行时上下文为单个 SystemMessage，
  // 避免依赖 LangChain 内部的连续 SystemMessage 合并行为。
  // Merge static system prompt and cacheable runtime context into one SystemMessage
  // to avoid relying on LangChain's internal consecutive SystemMessage merging.
  const systemPrompt =
    buildStaticSystemPrompt(role, skills) +
    '\n\n' +
    buildCacheableRuntimeContext({ workspace: state.workspace });

  return {
    messages: [
      new SystemMessage(systemPrompt),
      ...msgs,
      ...(state.plan ? [new HumanMessage(formatPlanStateReminder(state.plan))] : []),
    ],
  };
}

/** 构建静态系统提示词 / Build static system prompt */
export function buildStaticSystemPrompt(_role: AgentRole, skills?: SkillManifest[]): string {
  const base = systemPrompt;
  if (!skills || skills.length === 0) return base;

  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  const section = [
    '',
    '## Available Skills',
    '',
    'The following skills are available. Use the `Skill` tool to invoke a skill when its',
    'description matches your task. Invoking a skill loads detailed instructions you MUST follow.',
    '',
    ...lines,
    '',
    'IMPORTANT: If there is even a 1% chance a skill might apply, invoke it.',
  ].join('\n');

  return base + section;
}
