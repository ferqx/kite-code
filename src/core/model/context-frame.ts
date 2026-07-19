// ── Canonical Context Frame 类型定义 / Canonical context frame type definitions ──
// PR 2: Provider-neutral intermediate representation for context projection.
// Frames are the single source of truth for tool-call/ToolMessage pairing integrity.
// LangChain BaseMessage[] is only produced at the final serialization step.

import type { BaseMessage } from '@/core/messages';
import type { ToolEffectClass } from '@/core/policies/tool-capabilities';

// ── Tool result metadata ──

/** Structured metadata extracted from a tool result (populated in PR 3+). */
export interface FrameToolResultMeta {
  path?: string;
  totalLines?: number;
  command?: string;
  intent?: string;
  matchCount?: number;
  truncated?: boolean;
  contentDigest?: string;
  resourceRevision?: string;
  workspaceMutationScope?: string[];
  /** Provenance of digest fields — 'legacy_unknown' means pre-V2 data, never fold. */
  digestScope?: 'raw' | 'projected' | 'legacy_unknown';
}

// ── Frame types ──

/** A single tool call result within a ToolCallBlockFrame. */
export interface FrameToolResult {
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;
  args?: unknown;
  effectClass?: ToolEffectClass;
  resultMeta?: FrameToolResultMeta;
}

/**
 * 工具调用块：一个 AIMessage 及其所有 ToolMessage 的原子组合。
 * 多工具调用 AIMessage 的所有 tool_call 及其结果必须保持在同一个 block 中。
 *
 * Atomic block: one AIMessage with tool_calls + all matching ToolMessages.
 * Multi-tool AIMessages keep all calls and results together in one block.
 */
export interface ToolCallBlockFrame {
  kind: 'tool_block';
  /** ID of the assistant message that issued these tool calls / 发起工具调用的助理消息 ID */
  assistantMessageId?: string;
  turnId?: string;
  /** Text content of the assistant message (may be empty) / 助理消息的文本内容（可能为空） */
  assistantContent?: string;
  /** The original AIMessage used during provider serialization / 原始 AIMessage，用于 provider 序列化 */
  assistantMessage: BaseMessage;
  /** Tool call results, one per tool_call in declaration order / 工具调用结果，按声明顺序一一对应 */
  calls: FrameToolResult[];
}

/** A user message / 用户消息 */
export interface UserFrame {
  kind: 'user';
  turnId?: string;
  message: BaseMessage;
}

/** A plain assistant message without tool calls / 无工具调用的纯助理消息 */
export interface AssistantFrame {
  kind: 'assistant';
  turnId?: string;
  message: BaseMessage;
}

/** Runtime-injected message (mode snapshot, plan reminder, etc.) / 运行时注入的消息 */
export interface RuntimeFrame {
  kind: 'runtime';
  content: string;
  /** Label for diagnostics, e.g. 'mode_snapshot', 'plan_reminder' / 诊断标签 */
  label?: string;
}

/** M2 compaction summary frame (reserved for PR 7+) / M2 压缩摘要帧（PR 7+ 预留） */
export interface CompactionSummaryFrame {
  kind: 'compaction_summary';
  compactionId: string;
  content: string;
}

/** Canonical context frame — provider-neutral / 规范上下文帧 — provider 无关 */
export type ContextFrame =
  | UserFrame
  | AssistantFrame
  | ToolCallBlockFrame
  | RuntimeFrame
  | CompactionSummaryFrame;

// ── Type guards ──

export function isToolCallBlockFrame(f: ContextFrame): f is ToolCallBlockFrame {
  return f.kind === 'tool_block';
}

export function isUserFrame(f: ContextFrame): f is UserFrame {
  return f.kind === 'user';
}

export function isAssistantFrame(f: ContextFrame): f is AssistantFrame {
  return f.kind === 'assistant';
}

export function isRuntimeFrame(f: ContextFrame): f is RuntimeFrame {
  return f.kind === 'runtime';
}

export function isCompactionSummaryFrame(f: ContextFrame): f is CompactionSummaryFrame {
  return f.kind === 'compaction_summary';
}
