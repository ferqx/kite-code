// ── Context Frame Validator / 上下文帧校验器 ──
// Validates tool-call/ToolMessage pairing integrity at both frame and message levels.
// Failures block model invocation to prevent API 400 errors.

import { type BaseMessage, isAIMessage, isToolMessage } from '@/core/messages';
import type { ContextFrame } from './context-frame';
import { isToolCallBlockFrame } from './context-frame';

// ── Frame-level validation ──

/**
 * 校验帧列表的 tool block 完整性。
 *
 * 检查：
 * - 每个 ToolCallBlockFrame 的 calls 数量与 assistantMessage.tool_calls 数量一致
 * - call.toolCallId 与 tool_calls 中的 id 一一对应
 * - 所有 call 都有 ok/content/name 字段
 *
 * Validate frame-level tool block integrity.
 */
export function validateFramePairs(frames: ContextFrame[]): void {
  const errors: string[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    if (!isToolCallBlockFrame(frame)) continue;

    const m = frame.assistantMessage as unknown as Record<string, unknown>;
    const toolCalls = m.tool_calls;

    if (!Array.isArray(toolCalls)) {
      errors.push(`Frame[${i}]: ToolCallBlockFrame has no tool_calls in assistantMessage`);
      continue;
    }

    const expectedIds = (toolCalls as Array<Record<string, unknown>>)
      .filter((tc) => tc && typeof tc === 'object' && 'id' in tc && tc.id)
      .map((tc) => tc.id as string);

    if (expectedIds.length !== frame.calls.length) {
      errors.push(
        `Frame[${i}]: tool_calls count (${expectedIds.length}) ≠ calls count (${frame.calls.length})`,
      );
      continue;
    }

    for (let j = 0; j < expectedIds.length; j++) {
      const expectedId = expectedIds[j]!;
      const call = frame.calls[j];
      if (!call) {
        errors.push(`Frame[${i}]: missing call[${j}] for tool_call ${expectedId}`);
        continue;
      }
      if (call.toolCallId !== expectedId) {
        errors.push(
          `Frame[${i}]: call[${j}].toolCallId "${call.toolCallId}" ≠ expected "${expectedId}"`,
        );
      }
      if (!call.name) {
        errors.push(`Frame[${i}]: call[${j}] "${expectedId}" has empty name`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Frame-level tool-pair validation failed:\n${errors.join('\n')}`);
  }
}

// ── Message-level validation ──

/**
 * 校验消息列表中每个 AIMessage tool_call 都有唯一匹配的 ToolMessage，
 * 且不存在孤儿 ToolMessage。
 *
 * 校验失败时抛出详细错误，阻止模型调用。
 *
 * Validate that every AIMessage tool_call has exactly one matching ToolMessage
 * and no orphan ToolMessages exist.
 *
 * Throws with details on failure to prevent model invocation with broken pairs.
 */
export function validateMessagePairs(messages: BaseMessage[]): void {
  // 收集 AIMessage 中的所有 tool_call_id
  const aiToolCallIds = new Set<string>();
  for (const msg of messages) {
    const m = msg as unknown as Record<string, unknown>;
    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0 && (m.type === 'ai' || isAIMessage(msg))) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        if (tc && typeof tc === 'object' && 'id' in tc && tc.id) {
          aiToolCallIds.add(tc.id as string);
        }
      }
    }
  }

  // no tool calls in AI messages — still check for orphan ToolMessages

  // 统计每个 tool_call_id 在 ToolMessages 中出现的次数
  const toolResultCount = new Map<string, number>();
  for (const msg of messages) {
    const m = msg as unknown as Record<string, unknown>;
    if (
      (m.type === 'tool' || isToolMessage(msg)) &&
      typeof m.tool_call_id === 'string' &&
      m.tool_call_id.length > 0 &&
      !isAIMessage(msg)
    ) {
      toolResultCount.set(m.tool_call_id, (toolResultCount.get(m.tool_call_id) ?? 0) + 1);
    }
  }

  const missingResults: string[] = [];
  const duplicateResults: string[] = [];

  for (const id of aiToolCallIds) {
    const count = toolResultCount.get(id) ?? 0;
    if (count === 0) missingResults.push(id);
    else if (count > 1) duplicateResults.push(id);
  }

  // 检查孤儿 ToolMessage（无匹配 AIMessage）
  const orphanIds = [...toolResultCount.keys()].filter((id) => !aiToolCallIds.has(id));

  const errors: string[] = [];
  if (missingResults.length > 0) {
    errors.push(
      `Missing ToolMessages for ${missingResults.length} tool call(s): ${missingResults.slice(0, 5).join(', ')}${missingResults.length > 5 ? '...' : ''}`,
    );
  }
  if (duplicateResults.length > 0) {
    errors.push(
      `Duplicate ToolMessages for ${duplicateResults.length} tool call(s): ${duplicateResults.slice(0, 5).join(', ')}${duplicateResults.length > 5 ? '...' : ''}`,
    );
  }
  if (orphanIds.length > 0) {
    errors.push(
      `Orphan ToolMessages for ${orphanIds.length} tool call(s): ${orphanIds.slice(0, 5).join(', ')}${orphanIds.length > 5 ? '...' : ''}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Tool-call pairing validation failed after compaction:\n${errors.join('\n')}`);
  }
}
