// ── Context Frame Serializer / 上下文帧序列化器 ──
// Converts canonical ContextFrame[] back to provider-ready BaseMessage[].
// This is the LAST transformation step before messages enter the provider.

import { type BaseMessage, humanMessage, toolMessage } from '@/core/messages';
import type { ContextFrame } from './context-frame';
import {
  isAssistantFrame,
  isCompactionSummaryFrame,
  isRuntimeFrame,
  isToolCallBlockFrame,
  isUserFrame,
} from './context-frame';

/**
 * 将规范 ContextFrame 列表序列化为 provider-ready BaseMessage[]。
 *
 * 确保每个 ToolCallBlockFrame 产出的 AIMessage 与 ToolMessage 一一配对。
 * 这是 provider 序列化的最后一步：此后再无消息结构变换。
 *
 * Serialize canonical ContextFrame[] into provider-ready BaseMessage[].
 *
 * Guarantees that each ToolCallBlockFrame produces an AIMessage with exactly
 * one ToolMessage per tool call. This is the last transformation step before
 * messages enter the provider.
 */
export function serializeFramesToMessages(frames: ContextFrame[]): BaseMessage[] {
  const messages: BaseMessage[] = [];

  for (const frame of frames) {
    if (isToolCallBlockFrame(frame)) {
      // AIMessage + ToolMessage[] in declaration order
      messages.push(frame.assistantMessage);
      for (const call of frame.calls) {
        messages.push(
          Object.assign(
            toolMessage({
              content: call.content,
              tool_call_id: call.toolCallId,
              name: call.name,
              status: call.ok ? 'success' : 'error',
            }),
            call.resultMeta ?? {},
          ),
        );
      }
    } else if (isUserFrame(frame)) {
      messages.push(frame.message);
    } else if (isAssistantFrame(frame)) {
      messages.push(frame.message);
    } else if (isRuntimeFrame(frame)) {
      // Runtime frames are serialized as HumanMessages with a marker
      messages.push(humanMessage(frame.content));
    } else if (isCompactionSummaryFrame(frame)) {
      // Compaction summary: inject as human message for now (PR 7 refines)
      messages.push(humanMessage(`[Context compaction ${frame.compactionId}]\n${frame.content}`));
    }
  }

  return messages;
}
