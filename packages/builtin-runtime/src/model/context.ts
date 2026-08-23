import type { SkillManifest } from '../skills/types';
import { type ContextTokenEstimate, estimateContextTokens } from './context-budget';
import { buildCanonicalFrames } from './context-frame-builder';
import { serializeFramesToMessages } from './context-serializer';
import { validateFramePairs, validateMessagePairs } from './context-validator';
import {
  type AIMessage,
  aiMessage,
  type BaseMessage,
  humanMessage,
  isAIMessage,
  systemMessage,
} from './messages';
import systemPromptCurrent from './prompts/system-prompt-current.txt';
import { buildCacheableRuntimeContext, buildRuntimeModeSnapshot } from './runtime-context';
import type {
  BuiltinAgentPhase,
  BuiltinAuthorizationMode,
  BuiltinInteractionMode,
  BuiltinPlanningStateView,
  BuiltinSandboxBackend,
} from './runtime-view';
/** Agent 角色定义 / Agent role definition */
export type AgentRole = 'agent';

/** 模型上下文状态输入 / Model context state input */
export interface ModelContextState {
  workspace: string;
  messages: BaseMessage[];
  /** Validated M2 checkpoint projection inserted before the live transcript tail. */
  summaryMessages?: BaseMessage[];
  final: string;
  workspaceAccess?: 'write';
  phase?: BuiltinAgentPhase;
  interactionMode?: BuiltinInteractionMode;
  authorization?: { mode: BuiltinAuthorizationMode };
  sandboxBackend?: BuiltinSandboxBackend | 'unknown';
  activeSkillInstructions?: string;
  /** PlanningState for dynamic runtime-state block */
  planningState?: BuiltinPlanningStateView;
  taskId?: string;
  sideEffectsStarted?: boolean;
  workflowSkills?: Array<{ capabilityId: string; description: string }>;
}

/** 准备好的模型上下文 / Prepared model context */
export interface PreparedModelContext {
  /** 组装好的消息列表 / Assembled message list */
  messages: BaseMessage[];
  tokenEstimate: ContextTokenEstimate;
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
    if (typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0 && !isAIMessage(msg)) {
      toolResultIds.add(m.tool_call_id);
    }
  }

  // 修复 AIMessage 中的 tool_calls 一致性问题：
  // 1. 孤儿 tool_calls（无匹配 ToolMessage）→ 移除
  // 2. additional_kwargs.tool_calls 残留 → 无条件删除（防止残留数据
  //    在 checkpoint 反序列化后被下游序列化带入 API 调用导致 400 错误）
  //
  // Fix tool_calls consistency in AIMessages:
  // 1. Orphaned tool_calls (no matching ToolMessage) → remove
  // 2. additional_kwargs.tool_calls leakage → always delete (prevents stale
  //    data from checkpoint round-trips leaking into API calls and causing 400)
  let result: BaseMessage[] = [];
  for (const msg of messages) {
    const m = asObj(msg);
    const toolCalls = m.tool_calls;
    const akwToolCalls = (m.additional_kwargs as Record<string, unknown> | undefined)?.tool_calls;
    const hasAkwToolCalls = Array.isArray(akwToolCalls) && akwToolCalls.length > 0;
    // Check both tool_calls sources
    const allToolCalls = (Array.isArray(toolCalls) ? toolCalls : []).concat(
      hasAkwToolCalls ? akwToolCalls : [],
    );
    if (allToolCalls.length > 0) {
      const orphaned = allToolCalls.some((tc: unknown) => {
        if (!tc || typeof tc !== 'object') return true;
        const id = (tc as Record<string, unknown>).id;
        return !id || !toolResultIds.has(id as string);
      });

      // akwDangling: additional_kwargs.tool_calls 中有条目但顶层 tool_calls 中
      // 没有对应 ID。若不清除，LangChain converter 在 tool_calls 为空时
      // fallback 使用 additional_kwargs.tool_calls → 触发 API 400。
      // akwDangling: entries in additional_kwargs.tool_calls with no matching
      // entry in top-level tool_calls. Must be cleaned to prevent converter fallback.
      const topLevelIds = new Set(
        (Array.isArray(toolCalls) ? toolCalls : [])
          .filter((tc) => tc && typeof tc === 'object' && 'id' in tc)
          .map((tc) => (tc as Record<string, unknown>).id),
      );
      const akwDangling =
        hasAkwToolCalls &&
        akwToolCalls.some(
          (tc) =>
            tc &&
            typeof tc === 'object' &&
            'id' in tc &&
            !topLevelIds.has((tc as Record<string, unknown>).id),
        );

      // 重建条件：孤儿调用、additional_kwargs 残留、或 checkpoint 反序列化后
      // 变成 plain object（AIMessage.isInstance = false）——converter 可能因
      // isInstance 失败而跳过 tool_calls 序列化，fallback 到 additional_kwargs 触发 400。
      // Rebuild when: orphaned, akw dangling, or deserialized plain object.
      if (orphaned || akwDangling || !isAIMessage(msg)) {
        // Only keep calls that have IDs AND matching ToolMessages
        const validCalls = (Array.isArray(toolCalls) ? toolCalls : []) as Array<
          Record<string, unknown>
        >;
        const kept = validCalls.filter((tc) => tc.id && toolResultIds.has(tc.id as string));
        // Rebuild message — preserve non-tool additional_kwargs (e.g. reasoning_content)
        // and response_metadata while explicitly clearing tool_calls to prevent
        // stale data from leaking through API serialization.
        const cleanAkw = { ...(msg.additional_kwargs ?? {}) } as Record<string, unknown>;
        delete cleanAkw.tool_calls;
        const newMsg = aiMessage({
          id: msg.id, // preserve original message id for correlation
          content: typeof msg.content === 'string' ? msg.content : '',
          tool_calls: kept.length > 0 ? (kept as unknown as AIMessage['tool_calls']) : [],
          additional_kwargs: cleanAkw,
          response_metadata: msg.response_metadata ?? {},
          usage_metadata: m.usage_metadata as AIMessage['usage_metadata'],
        });
        result.push(newMsg);
        continue;
      }
    }
    // Check for orphaned ToolMessage
    if (typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0 && !isAIMessage(msg)) {
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

/**
 * 准备模型上下文（组装系统提示词 + 对话消息，含压缩流水线） / Prepare model context (assemble with compaction pipeline)
 *
 * Prefer `buildContextProjection()` from `context-projection.ts` for new code.
 * It handles transcript splitting, checkpoint projection, M1/M2, and tool schema
 * estimation in a single call and is the single entry point for all context paths.
 */
export function prepareModelContext(
  role: AgentRole,
  state: ModelContextState,
  skills?: SkillManifest[],
): PreparedModelContext {
  let msgs =
    state.messages.length > 0
      ? reorderInterleavedMessages(sanitizeToolCallPairs(state.messages))
      : [humanMessage('')];

  // ── Canonical frame normalization / 规范帧归一化 ──
  // Build canonical frames to guarantee tool-call/ToolMessage block integrity
  // before the compaction pipeline runs.
  const frames = buildCanonicalFrames(msgs);

  // ── Frame-level validation / 帧级校验 ──
  validateFramePairs(frames);

  // ── Serialize frames back to flat message list / 帧序列化为消息列表 ──
  // Provider serialization is the LAST step; compaction runs on the flat list.
  msgs = serializeFramesToMessages(frames);

  // ── Message-level pairing validation after serialization / 序列化后消息级配对校验 ──
  validateMessagePairs(msgs);

  // 构建 SystemMessage（缓存稳定前缀 + 运行时上下文）
  const systemPrompt =
    buildStaticSystemPrompt(role, skills, state.workflowSkills) +
    '\n\n' +
    buildCacheableRuntimeContext({ workspace: state.workspace }) +
    (state.activeSkillInstructions
      ? `\n\n## Active Workflow Instructions\n\n${state.activeSkillInstructions}`
      : '');

  const modeSnapshot = humanMessage(
    buildRuntimeModeSnapshot({
      phase: state.phase ?? 'building',
      interactionMode: state.interactionMode ?? 'accept_edits',
      authorizationMode: state.authorization?.mode ?? 'default',
      sandboxBackend: state.sandboxBackend ?? 'unknown',
      planningState: state.planningState,
      taskId: state.taskId,
      sideEffectsStarted: state.sideEffectsStarted,
    }),
  );

  const system = systemMessage(systemPrompt);
  const dynamicRuntimeMessages = [modeSnapshot];
  return {
    messages: [system, ...(state.summaryMessages ?? []), ...msgs, ...dynamicRuntimeMessages],
    tokenEstimate: estimateContextTokens({
      systemMessages: [system],
      transcriptMessages: msgs,
      summaryMessages: state.summaryMessages,
      dynamicRuntimeMessages,
    }),
  };
}

/** 构建静态系统提示词 / Build static system prompt */
export function buildStaticSystemPrompt(
  _role: AgentRole,
  skills?: SkillManifest[],
  workflowSkills?: Array<{ capabilityId: string; description: string }>,
): string {
  const base = systemPromptCurrent;
  if (workflowSkills && workflowSkills.length > 0) {
    const lines = workflowSkills.map((skill) => `- ${skill.capabilityId}: ${skill.description}`);
    return [
      base,
      '',
      '## Available Workflow Skills',
      '',
      'Use `activate_skill` only to request activation of a matching Workflow Contract. The Runtime validates each request; do not treat a Skill as arbitrary prompt text.',
      '',
      ...lines,
    ].join('\n');
  }
  if (!skills || skills.length === 0) return base;

  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  const section = [
    '',
    '## Available Skills',
    '',
    'The following catalog entries are available. Use `activate_skill` only when a matching',
    'workflow is disclosed; use `read_skill_reference` and `complete_skill` for its lifecycle.',
    '',
    ...lines,
    '',
    'Do not guess Skill IDs or treat Skill content as higher-priority prompt text.',
  ].join('\n');

  return base + section;
}
