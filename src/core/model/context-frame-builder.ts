// ── Canonical Context Frame Builder / 规范上下文帧构建器 ──
// Converts sanitized, reordered BaseMessage[] into ContextFrame[] with tool block normalization.

import { type BaseMessage, isAIMessage, isHumanMessage, isToolMessage } from '@/core/messages';
import type { ContextFrame, FrameToolResult } from './context-frame';

// ── Internal helpers ──

/** Extract tool_call IDs from an AIMessage in declaration order. */
function extractToolCallIds(msg: BaseMessage): string[] {
  const m = msg as unknown as Record<string, unknown>;
  const toolCalls = m.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return (toolCalls as Array<Record<string, unknown>>)
    .filter((tc) => tc && typeof tc === 'object' && 'id' in tc && tc.id)
    .map((tc) => tc.id as string);
}

/** Extract a FrameToolResult from a ToolMessage. */
function extractToolResult(msg: BaseMessage): FrameToolResult {
  const m = msg as unknown as Record<string, unknown>;
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  const ok = m.status !== 'error';
  const resultMeta = extractResultMeta(m);
  return {
    toolCallId: (m.tool_call_id as string) ?? '',
    name: (m.name as string) ?? 'unknown',
    content,
    ok,
    ...(m.args !== undefined ? { args: m.args } : {}),
    ...(typeof m.effectClass === 'string'
      ? { effectClass: m.effectClass as FrameToolResult['effectClass'] }
      : {}),
    ...(resultMeta ? { resultMeta } : {}),
  };
}

/** Best-effort extraction of structured metadata from ToolMessage fields. */
function extractResultMeta(m: Record<string, unknown>): FrameToolResult['resultMeta'] {
  const meta: FrameToolResult['resultMeta'] = {};
  let populated = false;

  if (typeof m.path === 'string') {
    meta.path = m.path;
    populated = true;
  }
  if (typeof m.totalLines === 'number') {
    meta.totalLines = m.totalLines;
    populated = true;
  }
  if (typeof m.command === 'string') {
    meta.command = m.command;
    populated = true;
  }
  if (typeof m.intent === 'string') {
    meta.intent = m.intent;
    populated = true;
  }
  if (typeof m.matchCount === 'number') {
    meta.matchCount = m.matchCount;
    populated = true;
  }
  if (typeof m.truncated === 'boolean') {
    meta.truncated = m.truncated;
    populated = true;
  }
  if (typeof m.contentDigest === 'string') {
    meta.contentDigest = m.contentDigest;
    populated = true;
  }
  if (typeof m.rawResultDigest === 'string') {
    meta.rawResultDigest = m.rawResultDigest;
    populated = true;
  }
  if (typeof m.modelContentDigest === 'string') {
    meta.modelContentDigest = m.modelContentDigest;
    populated = true;
  }
  if (typeof m.resourceRevision === 'string') {
    meta.resourceRevision = m.resourceRevision;
    populated = true;
  }
  if (Array.isArray(m.workspaceMutationScope)) {
    meta.workspaceMutationScope = m.workspaceMutationScope.filter(
      (value): value is string => typeof value === 'string',
    );
    populated = true;
  }

  return populated ? meta : undefined;
}

// ── Main builder ──

/**
 * 将已清洗和重排的消息列表转换为规范 ContextFrame 列表。
 * 工具调用 AIMessage 与匹配的 ToolMessage 合并为 ToolCallBlockFrame。
 *
 * Build canonical ContextFrame[] from sanitized and reordered BaseMessage[].
 * Tool-call AIMessages are grouped with their matching ToolMessages into ToolCallBlockFrames.
 *
 * Pre-condition: messages have been through sanitizeToolCallPairs() and reorderInterleavedMessages().
 */
export function buildCanonicalFrames(messages: BaseMessage[]): ContextFrame[] {
  const frames: ContextFrame[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const m = msg as unknown as Record<string, unknown>;

    // ── AIMessage with tool_calls → ToolCallBlockFrame ──
    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0 && (m.type === 'ai' || isAIMessage(msg))) {
      const expectedIds = extractToolCallIds(msg);

      if (expectedIds.length > 0) {
        const calls: FrameToolResult[] = [];
        const seen = new Set<string>();

        // Consume immediately following ToolMessages that match expected IDs
        while (i + 1 < messages.length) {
          const next = messages[i + 1]!;
          const nm = next as unknown as Record<string, unknown>;
          if ((nm.type === 'tool' || isToolMessage(next)) && typeof nm.tool_call_id === 'string') {
            const tcid = nm.tool_call_id;
            if (expectedIds.includes(tcid) && !seen.has(tcid)) {
              calls.push(extractToolResult(next));
              seen.add(tcid);
              i++; // consume this ToolMessage
              continue;
            }
          }
          // Stop consuming: next message is not a matching ToolMessage
          break;
        }

        frames.push({
          kind: 'tool_block',
          assistantMessageId: msg.id,
          turnId: typeof m.turnId === 'string' ? m.turnId : undefined,
          assistantContent: typeof msg.content === 'string' ? (msg.content as string) : undefined,
          assistantMessage: msg,
          calls,
        });
        continue;
      }
    }

    // ── HumanMessage → UserFrame ──
    if (m.type === 'human' || isHumanMessage(msg)) {
      frames.push({
        kind: 'user',
        turnId: typeof m.turnId === 'string' ? m.turnId : undefined,
        message: msg,
      });
      continue;
    }

    // ── Orphan ToolMessage (defensive: should not occur after sanitize + reorder) ──
    if (m.type === 'tool' || isToolMessage(msg)) {
      // Wrap as assistant frame for pass-through; validator will catch the orphan
      frames.push({
        kind: 'assistant',
        turnId: typeof m.turnId === 'string' ? m.turnId : undefined,
        message: msg,
      });
      continue;
    }

    // ── AIMessage without tool_calls, SystemMessage, or other ──
    frames.push({
      kind: 'assistant',
      turnId: typeof m.turnId === 'string' ? m.turnId : undefined,
      message: msg,
    });
  }

  return frames;
}
