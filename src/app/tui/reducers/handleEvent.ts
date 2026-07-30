// ── TUI render-event handler ──

import { contextCompactionTerminalNotice } from '@/core/model/context-compaction-presentation';
import type { RuntimeEvent } from '@/core/runtime/events';
import type * as Protocol from '@/protocol/events';
import {
  formatToolResultForDisplay,
  getToolDetail,
  getToolPreview,
} from '../components/render-utils';
import { MAX_TOOL_LINES } from '../components/ToolCardBlock';
import { providerActionInput, providerAdmissionInput } from '../mcp/runtime-interrupts';
import type { ConsolidatedToolEntry, FileChangeRecord, OutputBlock, TuiState } from '../types';
import { cancelRunningBlocks } from './agentReducer';
import {
  buildToolSummaryLine,
  isExplorationToolByName,
  isExplorationToolEvent,
  maybeConsolidateLastTurnBlocks,
} from './consolidateTools';
import {
  appendBlock,
  finalizeLastTurnStreaming,
  findBlock,
  findBlockById,
  hasBlock,
  lastTurn,
  replaceBlockById,
  updateLastBlock,
} from './helpers';

/** Internal rendering vocabulary shared by RuntimeEvent rendering paths.
 * RuntimeEvent remains the only streamed action accepted by the TUI reducer. */
export type RenderEvent =
  | { type: 'step_begin'; data: { node: string; spanId: string; internal?: boolean } }
  | { type: 'step_end'; data: { node: string; spanId: string } }
  | {
      type: 'reason' | 'text';
      data: { text: string; durationMs?: number; streamingDelta?: boolean };
    }
  | { type: 'model_requested'; data: { requestId: string } }
  | { type: 'tool_call'; data: Protocol.ToolCallPayload }
  | { type: 'tool_started'; data: Protocol.ToolStartedPayload }
  | { type: 'tool_done'; data: Protocol.ToolResultPayload }
  | { type: 'need_approval'; data: Protocol.ToolApprovalPayload }
  | { type: 'need_input'; data: Protocol.UserInputPayload; toolCallId?: string }
  | { type: 'need_plan_review'; data: Protocol.NeedPlanReviewPayload }
  | { type: 'state_change'; data: Protocol.StateChangePayload }
  | {
      type: 'file_change';
      data: {
        path: string;
        kind: 'add' | 'edit' | 'delete';
        linesAdded?: number;
        linesRemoved?: number;
        preview?: string;
      };
    }
  | { type: 'cache_metrics'; data: Protocol.CacheMetricsPayload }
  | { type: 'error'; data: { message: string; recoverable: boolean } }
  | { type: 'interrupt' | 'update'; data: unknown }
  | {
      type: 'model_retry';
      data: { attempt: number; maxAttempts: number; error: string; delayMs: number };
    }
  | { type: 'final'; data: string }
  | { type: 'subagent_start'; data: Protocol.SubAgentStartPayload }
  | { type: 'subagent_step'; data: Protocol.SubAgentStepPayload }
  | { type: 'subagent_tool_result'; data: Protocol.SubAgentToolResultPayload }
  | { type: 'subagent_done'; data: Protocol.SubAgentDonePayload }
  | { type: 'subagent_error'; data: Protocol.SubAgentErrorPayload }
  | { type: 'subagent_cache_metrics'; data: Protocol.SubAgentCacheMetricsPayload }
  | { type: 'tool_progress'; data: Protocol.ToolProgressPayload }
  | { type: 'turn_begin'; data: { index: number; spanId: string } }
  | { type: 'turn_end'; data: { index: number } }
  | { type: 'user_message'; data: Protocol.UserMessagePayload };

// ── Structural text block helpers ──
// Streaming text is published only at complete top-level Markdown boundaries.
// Structural elements (tables, code blocks, lists, quotes) therefore reach
// MarkdownBlock as a whole instead of changing shape while they are visible.

// ── Table detection ──

const TABLE_PIPE = /[|│]/;
const TIMEOUT_RE = /(?:^|\r?\n)Command timed out after (\d+)ms\./;

function parseTimeoutMs(summary: string): number | undefined {
  const match = summary.match(TIMEOUT_RE);
  return match ? Number(match[1]) : undefined;
}

function isTableSepLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!TABLE_PIPE.test(trimmed)) return false;
  return /^[\s\-:|─━┼╿]+$/.test(trimmed);
}

function isTableRowLike(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!TABLE_PIPE.test(trimmed)) return false;
  return /^[|│]/.test(trimmed) || /[|│]$/.test(trimmed) || isTableSepLine(trimmed);
}

// ── Code block detection ──

/** True when the first line of content is a code fence (```). */
function isCodeFenceStart(content: string): boolean {
  return content.trimStart().startsWith('```');
}

// ── Structural merge ──

type TextBlock = OutputBlock & { kind: 'text' };

/**
 * Freeze only complete top-level Markdown chunks while streaming. A blank-line
 * boundary outside fenced code is safe for paragraphs, tables, lists and
 * quotes; keeping the final chunk live lets it continue changing shape.
 *
 * The boundary is committed only after at least one character arrives behind
 * it. The unfinished tail stays entirely outside the render tree until another
 * boundary or the terminal model response proves that it is complete.
 */
function splitStreamingMarkdown(content: string): {
  committed: string;
  tail: string;
  live?: { kind: 'code' | 'table'; content: string };
} {
  let inFence = false;
  let boundary = -1;
  let lineStart = 0;
  let previousListItemStart = -1;
  let listItemIndent = -1;

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf('\n', lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex;
    const line = content.slice(lineStart, lineEnd);
    if (/^\s*```/.test(line)) inFence = !inFence;

    if (!inFence) {
      // A new top-level list item proves that the preceding item is complete.
      // Commit before the new marker so ordered, unordered and task lists can
      // appear item-by-item without exposing a half-written current item.
      const listMatch = line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+\S/);
      if (listMatch) {
        const indent = listMatch[1]!.length;
        if (previousListItemStart < 0 || indent < listItemIndent) {
          previousListItemStart = lineStart;
          listItemIndent = indent;
        } else if (indent === listItemIndent) {
          boundary = lineStart;
          previousListItemStart = lineStart;
        }
      } else if (line.trim().length === 0) {
        previousListItemStart = -1;
        listItemIndent = -1;
        if (lineEnd + 1 < content.length) boundary = lineEnd + 1;
      } else if (/^\S/.test(line) && previousListItemStart >= 0) {
        // A non-indented top-level line ends the list. Keep the new component
        // in the hidden tail until its own completion boundary.
        boundary = lineStart;
        previousListItemStart = -1;
        listItemIndent = -1;
      }
    }
    if (newlineIndex < 0) break;
    lineStart = lineEnd + 1;
  }

  if (boundary > 0) {
    return { committed: content.slice(0, boundary), tail: content.slice(boundary) };
  }

  const lines = content.split('\n');
  if (/^\s*```/.test(lines[0] ?? '')) {
    const closingIndex = lines.findIndex((line, index) => index > 0 && /^\s*```\s*$/.test(line));
    if (closingIndex >= 0) {
      const committed = lines.slice(0, closingIndex + 1).join('\n');
      return { committed, tail: content.slice(committed.length) };
    }
    const completeEnd = content.lastIndexOf('\n') + 1;
    if (completeEnd > 0) {
      return {
        committed: '',
        tail: content,
        live: { kind: 'code', content: content.slice(0, completeEnd) },
      };
    }
  }

  const completeEnd = content.lastIndexOf('\n') + 1;
  const completeLines =
    completeEnd > 0 ? content.slice(0, completeEnd).split('\n').slice(0, -1) : [];
  if (
    completeLines.length >= 2 &&
    isTableRowLike(completeLines[0] ?? '') &&
    isTableSepLine(completeLines[1] ?? '')
  ) {
    return {
      committed: '',
      tail: content,
      live: { kind: 'table', content: content.slice(0, completeEnd) },
    };
  }

  return { committed: '', tail: content };
}

function removeStreamingComponent(state: TuiState): TuiState {
  const last = lastTurn(state);
  if (!last) return state;
  const blocks = last.blocks.filter((block) => {
    if (block.kind !== 'text' || block.streamingComponent == null) return true;
    return (
      state.currentModelRequestId != null && block.modelRequestId !== state.currentModelRequestId
    );
  });
  if (blocks.length === last.blocks.length) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks };
  return { ...state, turns };
}

function showStreamingComponent(
  state: TuiState,
  source: string,
  live: { kind: 'code' | 'table'; content: string },
): TuiState {
  const last = lastTurn(state);
  const pending = last?.blocks.find(
    (block): block is TextBlock => block.kind === 'text' && block.streamingComponent != null,
  );
  if (pending) {
    if (pending.content === live.content && pending.streamingSource === source) return state;
    return replaceBlockById(state, pending.id, {
      ...pending,
      content: live.content,
      streamingComponent: live.kind,
      streamingSource: source,
    });
  }
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'text',
    content: live.content,
    streaming: true,
    streamingComponent: live.kind,
    streamingSource: source,
    ...(state.currentModelRequestId ? { modelRequestId: state.currentModelRequestId } : {}),
  });
}

/** Merge consecutive text blocks that form structural markdown elements
 *  (tables, code blocks) so that MarkdownBlock.groupLines() receives
 *  the multi-line context it needs to render them correctly. */
function mergeStructuralTextBlocks(state: TuiState): TuiState {
  const last = state.turns.at(-1);
  if (!last) return state;

  const merged: OutputBlock[] = [];
  let buffer: TextBlock[] = [];
  let changed = false;

  const flushBuffer = () => {
    if (buffer.length <= 1) {
      for (const b of buffer) merged.push(b);
      buffer = [];
      return;
    }
    const first = buffer[0]!;
    const lastBuf = buffer[buffer.length - 1]!;
    const content = buffer.map((b) => b.content).join('\n');
    merged.push({
      id: first.id,
      kind: 'text' as const,
      content,
      streaming: lastBuf.streaming,
      responsePending: buffer.some((b) => b.responsePending === true) || undefined,
      isError: buffer.some((b) => b.isError === true) || undefined,
      // ADR-0026 题头字段随行块合并保留在首行块上
      // Preserve the ADR-0026 header field on the first line of a merged run
      thoughtElapsedMs: first.thoughtElapsedMs,
      thoughtContent: first.thoughtContent,
      // Structural markdown assembled from streamed fragments still belongs
      // to the same model invocation for terminal-response reconciliation.
      modelRequestId: lastBuf.modelRequestId ?? first.modelRequestId,
    });
    changed = true;
    buffer = [];
  };

  let inCode = false;

  for (const block of last.blocks) {
    if (block.kind !== 'text') {
      flushBuffer();
      inCode = false;
      merged.push(block);
      continue;
    }

    if (isCodeFenceStart(block.content)) {
      if (!inCode) {
        // Opening fence: start code-block buffer (flush any prior table buffer)
        flushBuffer();
        buffer.push(block);
        inCode = true;
      } else {
        // Closing fence: complete the code block
        buffer.push(block);
        flushBuffer();
        inCode = false;
      }
    } else if (inCode || isTableRowLike(block.content)) {
      // Inside code block body, or table row outside code block
      buffer.push(block);
    } else {
      flushBuffer();
      merged.push(block);
    }
  }
  flushBuffer();

  // ADR-0026：文本事件出口统一执行纯思考题头并入（见 mergePureThoughtHeader）。
  // text/final 的所有建块路径都经过本函数，故并入点收敛于此。
  // ADR-0026: every text/final block-building path funnels through this
  // function, so the pure-thought header merge is applied at both exits.
  if (!changed) return mergePureThoughtHeader(state);
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks: merged };
  return mergePureThoughtHeader({ ...state, turns });
}

/**
 * ADR-0026：纯思考块被文本关闭后并入该文本块的题头。
 *
 * 从最后一轮末尾向前扫描：跳过尾部文本组（text + 不渲染的 reason 块），
 * 若其前紧邻的是刚关闭的纯思考块（无工具、hasThinking、inactive），删除该块
 * 并把它冻结的 elapsed 写为文本组首个 text 块的 `thoughtElapsedMs`（渲染为
 * 暗色 "Thought for Xs" 题头）。循环执行到收敛——并入删除块后可能暴露出
 * 前一对新的相邻关系（多轮 reason+text 链）。
 *
 * 由非探索工具 / 审批关闭的纯思考块与文本之间隔着其他块类型，永远不会被
 * 并入——裸线继续保留（规则 19）。纯空白文本不建块，无并入对象，同样保留。
 * 跨文本不吸收：工具聚合块不继承先行纯思考块的 hasThinking/modelMs。
 *
 * Merge pure-thinking blocks closed by text into that text's header
 * (ADR-0026). Scans backward past the trailing text run (text + unrendered
 * reason blocks) of the last turn; if the block before it is a just-closed
 * pure thought (no tools, hasThinking, inactive), removes it and stamps its
 * frozen elapsed onto the first text block of the run. Repeats to a
 * fixpoint — each removal can expose a further adjacent pair (multi-round
 * reason+text chains). Blocks closed by non-exploration tools or approval
 * are shielded by those block kinds and keep their bare line (rule 19);
 * absorption across text never happens.
 */
function mergePureThoughtHeader(state: TuiState): TuiState {
  let next = state;
  for (;;) {
    const merged = mergePureThoughtHeaderOnce(next);
    if (merged === next) return next;
    next = merged;
  }
}

function mergePureThoughtHeaderOnce(state: TuiState): TuiState {
  const last = lastTurn(state);
  if (!last || last.blocks.length < 2) return state;
  const blocks = last.blocks;
  // 定位尾部文本组起点（reason 块不渲染但在数组中，一并跳过）
  // Locate the trailing text run (reason blocks don't render but occupy slots)
  let runStart = blocks.length;
  while (runStart > 0) {
    const kind = blocks[runStart - 1]!.kind;
    if (kind !== 'text' && kind !== 'reason') break;
    runStart--;
  }
  if (runStart === 0 || runStart === blocks.length) return state;
  const prev = blocks[runStart - 1]!;
  if (
    prev.kind !== 'tool_summary' ||
    prev.active ||
    prev.responsePending === true ||
    prev.tools.length > 0 ||
    prev.hasThinking !== true
  ) {
    return state;
  }
  // 题头落在文本组首个 text 块上（组内可能先夹着 reason 块）
  // The header lands on the run's first text block (reason blocks may lead)
  let firstTextIdx = runStart;
  while (firstTextIdx < blocks.length && blocks[firstTextIdx]!.kind !== 'text') firstTextIdx++;
  if (firstTextIdx === blocks.length) return state;
  const firstText = blocks[firstTextIdx]!;
  if (firstText.kind !== 'text' || firstText.thoughtElapsedMs != null) return state;
  const completeThought =
    prev.latestActivity?.kind === 'thinking'
      ? prev.latestActivity.text
      : [...(prev.timeline ?? [])]
          .reverse()
          .find((entry) => entry.kind === 'thinking' && entry.text)?.text;
  const stamped: OutputBlock = {
    ...firstText,
    thoughtElapsedMs: prev.totalElapsedMs,
    ...(completeThought ? { thoughtContent: completeThought } : {}),
  };
  const newBlocks = [
    ...blocks.slice(0, runStart - 1),
    ...blocks.slice(runStart, firstTextIdx),
    stamped,
    ...blocks.slice(firstTextIdx + 1),
  ];
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks: newBlocks };
  return { ...state, turns };
}

/** 格式化 file_change 事件的原始预览内容，截断到最多 6 行 / Format raw file_change preview, truncating to max 6 lines */
const MAX_PREVIEW_LINES = 6;

function formatFilePreview(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines = raw.split('\n');
  if (lines.length > MAX_PREVIEW_LINES) {
    return `${lines.slice(0, MAX_PREVIEW_LINES).join('\n')}\n...`;
  }
  // Remove trailing empty line from exact-slice files (common for files ending with \n)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1).join('\n');
  }
  return raw;
}

function findToolSummaryLocation(
  state: TuiState,
  callId: string,
  preferredBlockId?: number,
): {
  turnIndex: number;
  blockIndex: number;
  block: Extract<OutputBlock, { kind: 'tool_summary' }>;
} | null {
  if (preferredBlockId != null) {
    for (let turnIndex = 0; turnIndex < state.turns.length; turnIndex++) {
      const blockIndex = state.turns[turnIndex]!.blocks.findIndex(
        (b) => b.kind === 'tool_summary' && b.id === preferredBlockId,
      );
      if (blockIndex >= 0) {
        return {
          turnIndex,
          blockIndex,
          block: state.turns[turnIndex]!.blocks[blockIndex]! as Extract<
            OutputBlock,
            { kind: 'tool_summary' }
          >,
        };
      }
    }
  }

  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex--) {
    const blocks = state.turns[turnIndex]!.blocks;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex]!;
      if (block.kind === 'tool_summary' && block.tools.some((t) => t.callId === callId)) {
        return { turnIndex, blockIndex, block };
      }
    }
  }

  return null;
}

function updateToolSummaryById(
  state: TuiState,
  blockId: number,
  update: (
    block: Extract<OutputBlock, { kind: 'tool_summary' }>,
  ) => Extract<OutputBlock, { kind: 'tool_summary' }> | null,
): TuiState {
  let changed = false;
  const turns = state.turns.map((turn) => ({
    blocks: turn.blocks.flatMap((block) => {
      if (block.kind !== 'tool_summary' || block.id !== blockId) return [block];
      const next = update(block);
      changed = true;
      return next ? [next] : [];
    }),
  }));
  return changed ? { ...state, turns } : state;
}

function findThoughtSummary(
  state: TuiState,
  blockId: number | undefined,
): Extract<OutputBlock, { kind: 'tool_summary' }> | null {
  if (blockId == null) return null;
  const block = findBlockById(state, blockId);
  return block?.kind === 'tool_summary' ? block : null;
}

/** Thought 关闭原因（ADR-0030 / ADR-0047 / 规则 23-24）：
 *  text 决定纯思考块是否并入回答题头；其他原因均关闭当前可见 Thought。
 *  思考归属不会跨边界复制到后续聚合块。
 *  注意：模型调用（model.requested）不再是关闭原因——阶段块跨调用存活
 *  （ADR-0030 / 规则 24）；文本在非流式模型下也不关闭活跃阶段块，而是作为
 *  旁白吸收进块顶（pendingCaption），仅在流式回退路径与 final 事件走 'text' 关闭。
 *  Cause of a Thought closure. Thinking attribution is consumed by the block
 *  that rendered it and is never copied across a boundary (ADR-0047). */
type ThoughtCloseCause = 'text' | 'tool' | 'human_wait' | 'boundary';

function closeCurrentThought(state: TuiState, cause: ThoughtCloseCause = 'boundary'): TuiState {
  const summary = findThoughtSummary(state, state.currentThoughtSummaryId);
  if (!summary)
    return {
      ...state,
      currentThoughtSummaryId: undefined,
      thoughtPhaseStatus: undefined,
    };

  // 有模型调用时长时以其冻结（对齐 Claude Code），否则回退墙钟
  // Freeze at model-call duration when known (CC parity), else wall clock
  const frozenElapsed = summary.modelMs ?? Date.now() - summary.createdAt;
  // ADR-0030 / 规则 24 + ADR-0026：纯思考块被文本关闭（非流式模型的最终回答
  // 路径）时，待确认旁白就是最终回答本身——并入文本题头：删除思考块，冻结
  // 时长写为文本块的 thoughtElapsedMs（信息不丢失）。
  // Pure-thinking block closed by text: the pending caption IS the final
  // answer — merge it into the text header (remove the thought block, stamp
  // its frozen elapsed onto the text block, ADR-0026).
  const mergeHeader =
    summary.tools.length === 0 && cause === 'text' && summary.pendingCaption != null;

  let next: TuiState;
  if (mergeHeader) {
    next = updateToolSummaryById(state, summary.id, () => null);
  } else {
    next = updateToolSummaryById(state, summary.id, (block) => {
      // 纯思考块（无工具）同样保留并 settle —— reason→非探索工具后必须留下
      // "Thought for Xs" 裸线（规则 19）。流式路径下由文本关闭的纯思考块随后
      // 由 mergePureThoughtHeader 并入题头（ADR-0026：删除发生在时长转移后）。
      // Pure-thinking blocks are kept and settled — the bare "Thought for Xs"
      // line must survive reason→non-exploration-tool (rule 19); on the
      // streaming path, mergePureThoughtHeader merges them into the header.
      const hasError = block.tools.some(
        (t) => t.status === 'error' || t.status === 'timeout' || t.status === 'exhausted',
      );
      const anyCancelled = block.tools.some((t) => t.status === 'cancelled');
      const allSettled = block.tools.every((t) => t.status !== 'queued' && t.status !== 'running');
      // Only assign result when all tools have actually settled.
      // If tools are still running, leave result undefined — later tool_done
      // events will recalculate it.
      const result = allSettled
        ? hasError
          ? ('error' as const)
          : anyCancelled
            ? ('cancelled' as const)
            : ('done' as const)
        : undefined;
      return {
        ...block,
        active: false,
        latestActivity: undefined,
        responsePending: undefined,
        totalElapsedMs: frozenElapsed,
        // 待确认旁白在下方脱离为独立块——块上清除，避免字幕与文本块重复渲染
        // Pending caption is detached below; clear it here to avoid duplicates
        pendingCaption: undefined,
        ...(result ? { result } : {}),
      };
    });
  }
  // ADR-0030 / 规则 24：脱离未确认的待确认旁白——阶段结束时仍无只读工具确认
  // 的文本（最终回答 / 写入前旁白）成为块后的独立文本块（活跃块必在末尾，
  // 追加顺序即时序）。已被工具确认的字幕（captions）留在块内不动。
  // Detach an unconfirmed pending caption: text with no read-only tool after
  // it (final answer / pre-write narration) becomes a standalone text block
  // after the settled block. Confirmed captions stay inside the block.
  if (summary.pendingCaption != null) {
    const textBlock: OutputBlock = {
      id: next.nextBlockId,
      kind: 'text',
      content: summary.pendingCaption,
      ...(mergeHeader ? { thoughtElapsedMs: frozenElapsed } : {}),
    };
    next = appendBlock(next, textBlock);
  }
  return {
    ...next,
    currentThoughtSummaryId: undefined,
    thoughtPhaseStatus: undefined,
  };
}

function updateCurrentThoughtActivity(
  state: TuiState,
  latestActivity: Extract<OutputBlock, { kind: 'tool_summary' }>['latestActivity'],
  durationMs?: number,
): TuiState {
  const isThinking = latestActivity?.kind === 'thinking';
  const summary = findThoughtSummary(state, state.currentThoughtSummaryId);
  if (summary?.active) {
    const next = updateToolSummaryById(state, summary.id, (block) => {
      const seq = (block.nextTimelineSeq ?? block.timeline?.length ?? 0) + 1;
      const timelineEntry = isThinking
        ? { seq, kind: 'thinking' as const, text: latestActivity!.text }
        : { seq, kind: 'tool' as const, callId: latestActivity!.callId };
      // 计时对齐 Claude Code：elapsed = 模型调用累计时长（不含工具执行）；
      // 无 durationMs（旧事件日志）时回退创建→现在墙钟。
      // Claude Code parity: elapsed = accumulated model-call duration
      // (excluding tool execution); legacy events without durationMs
      // fall back to wall-clock since creation.
      const modelMs = durationMs != null ? (block.modelMs ?? 0) + durationMs : block.modelMs;
      return {
        ...block,
        active: true,
        latestActivity,
        ...(state.currentModelRequestId ? { modelRequestId: state.currentModelRequestId } : {}),
        hasThought: isThinking ? true : block.hasThought,
        hasThinking: isThinking ? true : block.hasThinking,
        totalElapsedMs: modelMs ?? Date.now() - block.createdAt,
        ...(modelMs != null ? { modelMs } : {}),
        timeline: [...(block.timeline ?? []), timelineEntry],
        nextTimelineSeq: seq,
      };
    });
    return { ...next, thoughtPhaseStatus: 'running' };
  }

  const id = state.nextBlockId;
  const initialTimeline = latestActivity
    ? [
        {
          seq: 1,
          kind: latestActivity.kind as 'thinking' | 'tool',
          ...(latestActivity.kind === 'thinking'
            ? { text: latestActivity.text }
            : { callId: latestActivity.callId }),
        },
      ]
    : [];
  const block: OutputBlock = {
    id,
    kind: 'tool_summary',
    tools: [],
    totalElapsedMs: durationMs ?? 0,
    ...(durationMs != null ? { modelMs: durationMs } : {}),
    createdAt: Date.now(),
    summaryLine: 'thinking',
    active: true,
    ...(state.currentModelRequestId ? { modelRequestId: state.currentModelRequestId } : {}),
    hasThought: true,
    latestActivity,
    hasThinking: isThinking || undefined,
    timeline: initialTimeline as Extract<OutputBlock, { kind: 'tool_summary' }>['timeline'],
    nextTimelineSeq: 1,
  };
  return {
    ...appendBlock(state, block),
    currentThoughtSummaryId: id,
    thoughtPhaseStatus: 'running',
  };
}

/** ADR-0030 / 规则 24：把一次无 reasoning 的模型调用时长累加进活跃阶段块。
 *  阶段时长 = Σ 各次模型调用时长（规则 22），与思考是否存在无关。
 *  Add a no-reasoning model call's duration to the active phase block. */
function addThoughtDuration(state: TuiState, durationMs: number): TuiState {
  const summary = findThoughtSummary(state, state.currentThoughtSummaryId);
  if (!summary?.active) return state;
  return updateToolSummaryById(state, summary.id, (block) => {
    const modelMs = (block.modelMs ?? 0) + durationMs;
    return { ...block, modelMs, totalElapsedMs: modelMs };
  });
}

export function handleEventAction(state: TuiState, event: RenderEvent): TuiState {
  // Guard: malformed events from corrupted checkpoints must not crash the TUI
  if (!event.data) return state;

  // 非 reason 事件清除 currentRunReasonId，让下一个 reason 创建新块。
  // 避免中间隔了工具调用后两个 reason 块被合并。
  // 但 cache_metrics / state_change / step_begin / step_end / interrupt / update
  // 等纯内部事件不应打断 reason 连续性——这些事件不代表模型推理周期中断。
  // Auto-clear currentRunReasonId on content-bearing events,
  // so the next reason creates a new block instead of appending.
  // Internal bookkeeping events (cache_metrics, state_change, step_*) must NOT
  // break reason continuity — they are not part of the model's reasoning cycle.
  const REASON_CONTINUITY_EVENTS = new Set([
    'cache_metrics',
    'state_change',
    'step_begin',
    'step_end',
    'interrupt',
    'update',
    'tool_progress',
    'subagent_cache_metrics',
  ]);
  if (
    event.type !== 'reason' &&
    state.currentRunReasonId !== undefined &&
    !REASON_CONTINUITY_EVENTS.has(event.type)
  ) {
    const reasonBlock = findBlockById(state, state.currentRunReasonId);
    if (reasonBlock?.kind === 'reason' && reasonBlock.folded) {
      state = replaceBlockById(state, state.currentRunReasonId, { ...reasonBlock, folded: false });
    }
    state = { ...state, currentRunReasonId: undefined };
  }

  switch (event.type) {
    case 'text': {
      // ADR-0030 / 规则 24：纯空白文本整体忽略——阶段模型里它既不代表模型
      // 开始输出（非流式调用不产生空白文本），也不应关闭 Thought 或产生空行。
      // Blank/whitespace-only text is ignored entirely under the phase model.
      if (!/\S/u.test(event.data.text)) return state;

      // ADR-0030 / 规则 24：旁白文本吸收。阶段块活跃时，文本吸收为
      // pendingCaption（渲染于块顶），等随后到来的只读工具确认（确认 →
      // captions，永久留在块内）；阶段结束时仍未确认的由 closeCurrentThought
      // 脱离为独立文本块（最终回答），纯思考块被文本关闭时并入该文本块
      // 题头（ADR-0026）。多段旁白按时间顺序累积；流式提供商的增量文本
      // （新事件包含旧全文）以 startsWith 识别并替换，避免重复。
      // Narration absorption (ADR-0030): while the phase block is active,
      // text is absorbed into pendingCaption (rendered at the block top),
      // confirmed into captions by the next read-only tool; unconfirmed text
      // is detached at phase end (final answers) or merges into the header
      // when it closes a pure-thinking block (ADR-0026). Multiple narrations
      // accumulate chronologically; streaming providers resend the full text
      // each event — startsWith detects growth and replaces instead of
      // duplicating.
      if (state.running && event.data.streamingDelta) {
        // The first answer delta is the only reliable stream-level signal that
        // the reasoning channel is complete. Publish its cached full value in
        // one update, then visually settle the Thought while it retains
        // terminal duration ownership.
        const activeStreamThought = findThoughtSummary(state, state.currentThoughtSummaryId);
        const completedReasoning = state.currentModelReasoningText;
        if (activeStreamThought?.active && completedReasoning) {
          state = {
            ...updateToolSummaryById(state, activeStreamThought.id, (block) => {
              const timeline = [...(block.timeline ?? [])];
              const alreadyPublished =
                block.latestActivity?.kind === 'thinking' &&
                block.latestActivity.text === completedReasoning;
              const seq = alreadyPublished
                ? (block.nextTimelineSeq ?? timeline.length)
                : (block.nextTimelineSeq ?? timeline.length) + 1;
              if (!alreadyPublished) {
                timeline.push({ seq, kind: 'thinking', text: completedReasoning });
              }
              return {
                ...block,
                active: false,
                responsePending: true,
                hasThinking: true,
                latestActivity: { kind: 'thinking', text: completedReasoning },
                totalElapsedMs: block.modelMs ?? Date.now() - block.createdAt,
                timeline,
                nextTimelineSeq: seq,
              };
            }),
            thoughtPhaseStatus: 'awaiting_terminal',
          };
        }
        const committedLength = currentModelResponseTextParts(state)
          .filter((part) => part.streamingSource == null)
          .reduce((length, part) => length + part.text.length, 0);
        const unpublishedSource = event.data.text.slice(committedLength);
        const { committed, live } = splitStreamingMarkdown(unpublishedSource);
        if (!committed) {
          if (!live) return state;
          if (state.thoughtPhaseStatus === 'awaiting_terminal') {
            state = {
              ...closeCurrentThought(state, 'text'),
              thoughtPhaseStatus: 'awaiting_terminal',
            };
          }
          return showStreamingComponent(state, unpublishedSource, live);
        }
        state = removeStreamingComponent(state);
        // The complete reasoning is useful only while the user is waiting for
        // an answer component. As soon as the first complete answer component
        // becomes visible, settle the Thought into Static. Keep only the
        // lifecycle attribution marker so late deltas cannot create a second
        // Thought before model.responded arrives.
        if (state.thoughtPhaseStatus === 'awaiting_terminal') {
          state = {
            ...closeCurrentThought(state, 'text'),
            thoughtPhaseStatus: 'awaiting_terminal',
          };
        }
      }
      const activeThought = findThoughtSummary(state, state.currentThoughtSummaryId);
      if (activeThought?.active) {
        if (event.data.streamingDelta) {
          state = {
            ...updateToolSummaryById(state, activeThought.id, (block) => ({
              ...block,
              active: false,
              responsePending: true,
              totalElapsedMs: block.modelMs ?? Date.now() - block.createdAt,
            })),
            thoughtPhaseStatus: 'awaiting_terminal',
          };
        } else {
          return updateToolSummaryById(state, activeThought.id, (block) => ({
            ...block,
            pendingCaption:
              block.pendingCaption != null &&
              (event.data.text === block.pendingCaption ||
                event.data.text.startsWith(block.pendingCaption))
                ? event.data.text
                : block.pendingCaption != null
                  ? `${block.pendingCaption}\n\n${event.data.text}`
                  : event.data.text,
          }));
        }
      }
      const preservesPendingPhase =
        event.data.streamingDelta &&
        (state.thoughtPhaseStatus === 'running' ||
          state.thoughtPhaseStatus === 'awaiting_terminal');
      if (!preservesPendingPhase) {
        state = closeCurrentThought(state, 'text');
      }
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);

      // Keep the legacy cumulative text event path intact. Runtime streaming
      // deltas use the commit-boundary path below; legacy callers still own a
      // single mutable live block until their final event arrives.
      if (
        state.running &&
        !event.data.streamingDelta &&
        lastBlock?.kind === 'text' &&
        lastBlock.streaming
      ) {
        if (lastBlock.content === event.data.text) return state;
        return mergePureThoughtHeader(
          updateLastBlock(state, { ...lastBlock, content: event.data.text }),
        );
      }

      if (state.running && event.data.streamingDelta) {
        const committedLength = currentModelResponseTextParts(state)
          .filter((part) => part.streamingSource == null)
          .reduce((length, part) => length + part.text.length, 0);
        const unpublishedSource = event.data.text.slice(committedLength);
        const { committed, live } = splitStreamingMarkdown(unpublishedSource);
        if (!committed) {
          return live ? showStreamingComponent(state, unpublishedSource, live) : state;
        }
        state = removeStreamingComponent(state);
        return mergePureThoughtHeader(
          appendBlock(state, {
            id: state.nextBlockId,
            kind: 'text',
            content: committed,
            ...(state.currentModelRequestId ? { modelRequestId: state.currentModelRequestId } : {}),
          }),
        );
      }

      // Dedup: check all text blocks in the last turn
      if (lastBlock?.kind === 'text' && lastBlock.content === event.data.text) return state;
      if (last) {
        for (let i = last.blocks.length - 1; i >= 0; i--) {
          const blk = last.blocks[i]!;
          if (blk.kind === 'text') {
            if (blk.content === event.data.text) return state;
          }
        }
      }
      // 纯空白文本（含 Unicode 空白）不创建 block — MarkdownBlock 不渲染，
      // 但 block 本身会通过 gapFrom 的 marginTop 产生多余空白行。
      // Blank/whitespace-only text (incl. Unicode whitespace) creates no
      // visual output but its marginTop adds unwanted blank lines.
      const id = state.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'text',
        content: event.data.text,
        streaming: state.running,
      };
      const appended = appendBlock(state, block);
      return mergeStructuralTextBlocks(appended);
    }
    case 'model_requested': {
      // ADR-0030 / 规则 24：模型调用不是阶段边界。kernel 收齐上一轮工具结果
      // 后重新调用模型属于实现细节（分批喂工具结果），用户感知的是一段连续
      // 探索：Thought 块跨调用存活——圆点持续闪烁、时长跨调用累加、旁白继续
      // 吸收，直到真正的阶段边界（文本脱离 / 非探索工具 / 人机等待 / 生命
      // 周期）统一关闭 settle。（取代 ADR-0025 在此关闭的 settle 行为；
      // model.requested 即时发出本身保留。）
      // A model call is NOT a phase boundary (ADR-0030 / rule 24): the phase
      // block survives across calls — the dot keeps blinking, elapsed keeps
      // accumulating, narrations keep absorbing — until a real phase boundary
      // closes it. (Supersedes the ADR-0025 settle-on-requested behavior; the
      // immediate emission of model.requested itself is retained.)
      return state;
    }
    case 'reason': {
      if (state.currentRunReasonId != null) {
        const reasonBlock = findBlockById(state, state.currentRunReasonId);
        if (reasonBlock?.kind === 'reason') {
          const next: OutputBlock = {
            ...reasonBlock,
            content: `${reasonBlock.content}\n\n${event.data.text}`,
          };
          return updateCurrentThoughtActivity(
            replaceBlockById(state, reasonBlock.id, next),
            { kind: 'thinking', text: event.data.text },
            event.data.durationMs,
          );
        }
      }
      // Finalize streaming text so it doesn't enter <Static> with cursor
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: 'reason', content: event.data.text, folded: true };
      const withReason = { ...appendBlock(finalized, block), currentRunReasonId: id };
      return updateCurrentThoughtActivity(
        withReason,
        { kind: 'thinking', text: event.data.text },
        event.data.durationMs,
      );
    }
    case 'tool_call': {
      const isExploration = isExplorationToolEvent(event.data);
      const toolStatus = event.data.status ?? 'running';
      // task tool has its own subagent block
      if (!isExploration) state = closeCurrentThought(state, 'tool');
      if (isExploration) {
        // Execution start is the real phase boundary. Publish any model text
        // held off-screen before deciding whether the next exploration call
        // belongs to the preceding Thought.
        state = finalizeLastTurnStreaming(state);
        const turn = lastTurn(state);
        const thoughtIndex = turn?.blocks.findIndex(
          (block) => block.id === state.currentThoughtSummaryId,
        );
        if (
          turn &&
          thoughtIndex != null &&
          thoughtIndex >= 0 &&
          turn.blocks.slice(thoughtIndex + 1).some((block) => block.kind === 'text')
        ) {
          // Published assistant text is a phase boundary once a later tool
          // proves it was narration before another exploration step.
          state = mergePureThoughtHeader(closeCurrentThought(state, 'text'));
        }
      }
      if (event.data.name === 'task') return state;
      // 已审批方案后的 update_plan 调用是进度追踪，不在消息列表中展示
      if (event.data.name === 'update_plan' && state.status.plan !== null) return state;
      // Dedup: skip if this callId already exists in any block
      if (hasBlock(state, (b) => b.kind === 'tool_card' && b.callId === event.data.call_id))
        return state;
      // Finalize streaming text so it doesn't enter <Static> with cursor
      const finalized = finalizeLastTurnStreaming(state);
      const now = Date.now();
      const times =
        toolStatus === 'running'
          ? { ...finalized.toolStartTimes, [event.data.call_id]: now }
          : finalized.toolStartTimes;

      // ── Pre-consolidation: exploration tools go directly to tool_summary, never as tool_card ──
      if (isExploration) {
        const entry: ConsolidatedToolEntry = {
          callId: event.data.call_id,
          name: event.data.name,
          args: event.data.args,
          ok: false,
          summary: '',
          status: toolStatus,
          totalLines:
            typeof event.data.args?.totalLines === 'number'
              ? event.data.args.totalLines
              : undefined,
        };
        const currentThought = findThoughtSummary(finalized, finalized.currentThoughtSummaryId);

        if (currentThought?.active) {
          // Dedup: skip if this callId already exists in tools (dual pipeline: side-channel + stream)
          if (currentThought.tools.some((t) => t.callId === event.data.call_id)) {
            return finalized;
          }
          const now = Date.now();
          const tools = [...currentThought.tools, entry];
          // The Thought activity window is mutually exclusive: a tool event
          // immediately replaces the reasoning view; a later reasoning delta
          // may switch it back again.
          const latestActivity = { kind: 'tool', callId: event.data.call_id } as const;
          const seq = (currentThought.nextTimelineSeq ?? currentThought.timeline?.length ?? 0) + 1;
          const updated: Extract<OutputBlock, { kind: 'tool_summary' }> = {
            ...currentThought,
            tools,
            // ADR-0030 / 规则 24：只读工具确认待确认旁白为正式块顶字幕。
            // 纯思考块借此转为工具阶段块（开始渲染统计标签与步骤树）。
            // A read-only tool confirms the pending caption; a pure-thinking
            // block becomes a tool phase block here.
            ...(currentThought.pendingCaption != null
              ? {
                  captions: [...(currentThought.captions ?? []), currentThought.pendingCaption],
                  pendingCaption: undefined,
                }
              : {}),
            // 有模型调用时长时 elapsed 不随工具执行增长（对齐 Claude Code）
            // Elapsed stays frozen at model-call duration while tools run (CC parity)
            totalElapsedMs: currentThought.modelMs ?? now - currentThought.createdAt,
            summaryLine: buildToolSummaryLine(tools),
            active: true,
            latestActivity,
            timeline: [
              ...(currentThought.timeline ?? []),
              { seq, kind: 'tool' as const, callId: event.data.call_id },
            ],
            nextTimelineSeq: seq,
          };
          return {
            ...replaceBlockById(finalized, currentThought.id, updated),
            toolStartTimes: times,
            explorationSummaryIds: {
              ...finalized.explorationSummaryIds,
              [event.data.call_id]: currentThought.id,
            },
            currentThoughtSummaryId: currentThought.id,
            thoughtPhaseStatus: 'running',
          };
        }

        // A Thought label is consumed by the block that rendered the reasoning.
        // Exploration after a standalone-tool boundary starts as a tool-only
        // aggregate until a later, real reason event reaches it (ADR-0047).
        const id = finalized.nextBlockId;
        const block: OutputBlock = {
          id,
          kind: 'tool_summary',
          tools: [entry],
          totalElapsedMs: 0,
          createdAt: now,
          summaryLine: buildToolSummaryLine([entry]),
          active: true,
          hasThought: false,
          latestActivity: { kind: 'tool', callId: event.data.call_id },
          timeline: [{ seq: 1, kind: 'tool' as const, callId: event.data.call_id }],
          nextTimelineSeq: 1,
        };
        return {
          ...appendBlock(finalized, block),
          toolStartTimes: times,
          explorationSummaryIds: { ...finalized.explorationSummaryIds, [event.data.call_id]: id },
          currentThoughtSummaryId: id,
          thoughtPhaseStatus: 'running',
        };
      }

      // Non-exploration tool → standard tool_card
      const preview = getToolPreview(event.data.name, event.data.args);
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'tool_card',
        callId: event.data.call_id,
        name: event.data.name,
        args: event.data.args,
        status: toolStatus,
        summary: '',
        preview,
        ...(toolStatus === 'running' ? { startedAt: now } : {}),
      };
      return { ...appendBlock(finalized, block), toolStartTimes: times };
    }
    case 'tool_started': {
      const now = Date.now();
      const matched = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.callId === event.data.call_id,
      );
      if (matched?.kind === 'tool_card') {
        if (matched.status === 'running') return state;
        if (matched.status !== 'queued') return state;
        return {
          ...replaceBlockById(state, matched.id, {
            ...matched,
            status: 'running' as const,
            startedAt: now,
          }),
          toolStartTimes: { ...state.toolStartTimes, [event.data.call_id]: now },
        };
      }

      const location = findToolSummaryLocation(state, event.data.call_id);
      if (!location) return state;
      const { turnIndex, blockIndex, block: summary } = location;
      let changed = false;
      const tools = summary.tools.map((t) => {
        if (t.callId !== event.data.call_id || t.status !== 'queued') return t;
        changed = true;
        return { ...t, status: 'running' as const };
      });
      if (!changed) return state;
      const updatedSummary: OutputBlock = {
        ...summary,
        tools,
        active: summary.active,
        totalElapsedMs:
          summary.modelMs ?? (summary.active ? now - summary.createdAt : summary.totalElapsedMs),
        summaryLine: buildToolSummaryLine(tools),
      };
      const turnsCopy = state.turns.map((t, ti) => {
        if (ti !== turnIndex) return t;
        return { blocks: t.blocks.map((b, bi) => (bi === blockIndex ? updatedSummary : b)) };
      });
      return {
        ...state,
        turns: turnsCopy,
        toolStartTimes: { ...state.toolStartTimes, [event.data.call_id]: now },
      };
    }
    case 'tool_done': {
      if (event.data.name === 'task') return state;
      const startedAt = state.toolStartTimes?.[event.data.call_id];
      const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
      const { [event.data.call_id]: _, ...nextTimes } = state.toolStartTimes ?? {};

      // ── Exploration tool: update entry in tool_summary (only if it was pre-consolidated) ──
      // shell_execute with inspect intent + search/ls prefix enters Thought; others fall through to tool_card
      if (isExplorationToolByName(event.data.name)) {
        const blockId = state.explorationSummaryIds[event.data.call_id];
        const location = findToolSummaryLocation(state, event.data.call_id, blockId);
        if (location) {
          const { turnIndex, blockIndex, block: summary } = location;
          const tools = summary.tools.map((t) =>
            t.callId === event.data.call_id
              ? {
                  ...t,
                  ok: event.data.ok,
                  summary: event.data.summary,
                  elapsedMs,
                  totalLines: event.data.totalLines ?? t.totalLines,
                  status:
                    event.data.status === 'exhausted'
                      ? ('exhausted' as const)
                      : event.data.ok
                        ? ('done' as const)
                        : ('error' as const),
                  reviewFailure: event.data.reviewFailure ?? t.reviewFailure,
                }
              : t,
          );
          // 有模型调用时长时 elapsed 不随工具执行增长（对齐 Claude Code）
          // Elapsed stays frozen at model-call duration while tools run (CC parity)
          const totalElapsedMs = summary.modelMs ?? Date.now() - summary.createdAt;
          // 所有工具均 settled 时重新计算 result，修复 closeCurrentThought 提前
          // 关闭导致的 result='cancelled' 残留——后续 tool_done 到达后不再卡在 cancelled。
          // Recompute result when all tools are settled, fixing stale 'cancelled'
          // left by closeCurrentThought before late-arriving tool_done events.
          const allSettled = tools.every(
            (t) =>
              t.status !== 'queued' &&
              t.status !== 'running' &&
              (t.status === 'done' ||
                t.status === 'error' ||
                t.status === 'cancelled' ||
                t.status === 'timeout' ||
                t.status === 'exhausted'),
          );
          const hasError = tools.some(
            (t) => t.status === 'error' || t.status === 'timeout' || t.status === 'exhausted',
          );
          const updatedSummary: OutputBlock = {
            ...summary,
            tools,
            totalElapsedMs,
            summaryLine: buildToolSummaryLine(tools),
            ...(allSettled ? { result: hasError ? ('error' as const) : ('done' as const) } : {}),
          };
          const turnsCopy = state.turns.map((t, ti) => {
            if (ti !== turnIndex) return t;
            return { blocks: t.blocks.map((b, bi) => (bi === blockIndex ? updatedSummary : b)) };
          });
          let next = { ...state, turns: turnsCopy, toolStartTimes: nextTimes };
          if (event.data.toolTokenCount && event.data.toolTokenCount > 0) {
            next = {
              ...next,
              status: {
                ...state.status,
                totalTokens: state.status.totalTokens + event.data.toolTokenCount,
              },
            };
          }
          return next;
        }
        // Not found via map or in blocks — fall through to standard tool_card update
      }

      // ── Standard tool_card update (non-exploration tools + exploration tools not pre-consolidated) ──
      const matched = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.callId === event.data.call_id,
      );
      if (matched?.kind !== 'tool_card') {
        // Preflight block: tool was stopped before execution (fingerprint already exhausted).
        // No tool_card was created by a prior tool_call event — create one now so the
        // user sees the system intervention.  The status footer ("blocked") is sufficient;
        // no separate notification text block needed.
        if (event.data.status === 'exhausted') {
          const id = state.nextBlockId;
          const card: OutputBlock = {
            id,
            kind: 'tool_card',
            callId: event.data.call_id,
            name: event.data.name,
            args: {},
            status: 'exhausted' as const,
            summary: event.data.summary,
            expanded: true,
          };
          return {
            ...appendBlock(state, card),
            toolStartTimes: nextTimes,
          };
        }
        return { ...state, toolStartTimes: nextTimes };
      }
      // update_plan declined
      if (matched.name === 'update_plan' && !event.data.ok) {
        const declined: OutputBlock = { ...matched, status: 'done' as const, expanded: true };
        return { ...replaceBlockById(state, matched.id, declined), toolStartTimes: nextTimes };
      }

      // ask_user summary extraction
      let summaryText = event.data.summary;
      if (matched.name === 'ask_user') {
        try {
          const p = JSON.parse(summaryText);
          if (p && typeof p === 'object') {
            if (p.ok === false) {
              summaryText =
                (p.detail as string) ||
                (p.stderr as string) ||
                'ask_user failed: invalid arguments';
            } else {
              const answer = p.answer as string | undefined;
              const answers = p.answers as Record<string, string> | undefined;
              if (answers && Object.keys(answers).length > 0) {
                summaryText = Object.entries(answers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n');
              } else if (typeof answer === 'string') {
                summaryText = answer || '(no answer)';
              }
            }
          }
        } catch {
          /* not JSON, use raw summary */
        }
      }

      const cancelled = !event.data.ok && summaryText === 'Cancelled';
      const exhaustedStatus = event.data.status === 'exhausted';
      const timedOut =
        !event.data.ok &&
        matched.name === 'shell_execute' &&
        (event.data.exitCode === 124 || TIMEOUT_RE.test(summaryText));
      const timeoutMs =
        timedOut && typeof matched.args.timeout_ms === 'number'
          ? matched.args.timeout_ms
          : timedOut
            ? parseTimeoutMs(summaryText)
            : undefined;
      const displaySummary =
        timedOut && TIMEOUT_RE.test(summaryText) && matched.liveOutput
          ? matched.liveOutput
          : summaryText;
      // A reviewed write_plan already contains the full plan document from
      // plan.review_requested. Its final tool.finished event carries only a
      // machine-readable approval/revision payload; do not replace the plan
      // document with that JSON in either live rendering or replay.
      const preserveReviewedPlan =
        matched.name === 'write_plan' &&
        event.data.ok &&
        (state.status.plan !== null || state.status.pendingPlan !== null) &&
        matched.summary.trim().length > 0;
      const next: OutputBlock = {
        ...matched,
        status: exhaustedStatus
          ? ('exhausted' as const)
          : event.data.ok
            ? ('done' as const)
            : cancelled
              ? ('cancelled' as const)
              : timedOut
                ? ('timeout' as const)
                : ('error' as const),
        reviewFailure:
          event.data.reviewFailure ??
          ('reviewFailure' in matched ? matched.reviewFailure : undefined),
        userInput: event.data.userInput ?? matched.userInput,
        summary: preserveReviewedPlan ? matched.summary : displaySummary,
        elapsedMs: elapsedMs ?? matched.elapsedMs,
        detail: getToolDetail(matched.name, matched.args, event.data.totalLines),
        ...(timeoutMs != null ? { timeoutMs } : {}),
        expanded:
          exhaustedStatus ||
          !event.data.ok ||
          matched.name === 'shell_execute' ||
          matched.name === 'edit_file' ||
          matched.name === 'write_file' ||
          matched.name === 'write_plan' ||
          matched.name === 'update_plan' ||
          matched.name === 'ask_user',
      };

      const updated = replaceBlockById(state, matched.id, next);
      let result: TuiState = { ...updated, toolStartTimes: nextTimes };
      if (event.data.toolTokenCount && event.data.toolTokenCount > 0) {
        result = {
          ...result,
          status: {
            ...state.status,
            totalTokens: state.status.totalTokens + event.data.toolTokenCount,
          },
        };
      }

      // ── Flush pending tool_summary: when non-exploration tool completes, ensure preceding
      //     exploration tools get flushed (they may be trapped behind a non-exploration tool_card) ──
      const turn2 = lastTurn(result);
      if (turn2) {
        const consolidated = maybeConsolidateLastTurnBlocks(turn2.blocks, result.nextBlockId);
        const tCopy = result.turns.slice();
        tCopy[tCopy.length - 1] = { blocks: consolidated.blocks };
        result = { ...result, turns: tCopy, nextBlockId: consolidated.nextBlockId };
      }

      // Exhaustion is rendered by the tool_card itself (amber dot + status footer
      // "blocked (too many repeated failures)"), no separate notification needed.
      return result;
    }
    case 'state_change': {
      const d = event.data;
      const next = { ...state.status };
      let nextInteractionMode = state.interactionMode;
      if (d.phase) next.phase = d.phase;
      if (d.plan !== undefined) next.plan = d.plan;
      if (d.authorization) next.authorization = d.authorization.mode;
      if (d.interactionMode)
        nextInteractionMode = d.interactionMode as 'accept_edits' | 'auto' | 'full';
      if (d.workspaceAccess) next.workspaceAccess = d.workspaceAccess;
      if (d.modelProvider) next.modelProvider = d.modelProvider;
      if (d.modelName) next.modelName = d.modelName;
      return { ...state, status: next, interactionMode: nextInteractionMode };
    }
    case 'model_retry': {
      const maxAttempts = event.data.maxAttempts;
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state, 'boundary'));
      return {
        ...finalized,
        currentModelReasoningText: undefined,
        status: {
          ...finalized.status,
          retryState: {
            attempt: event.data.attempt,
            maxAttempts,
            error: event.data.error,
            delayMs: event.data.delayMs,
          },
        },
      };
    }
    case 'step_begin': {
      return { ...state, status: { ...state.status, currentNode: event.data.node } };
    }
    case 'step_end': {
      return { ...state, status: { ...state.status, currentNode: null } };
    }
    case 'cache_metrics': {
      const d = event.data;
      const hit = state.status.cacheHitTokens + d.cacheHitTokens;
      const miss = state.status.cacheMissTokens + d.cacheMissTokens;
      const cacheTotal = hit + miss;
      // 手动统计 tokens，不依赖 provider 的 cache_miss 字段：
      // - 首次调用：inputTokens = 全量上下文，作为基准线
      // - 后续调用：只加模型产出 (outputTokens)，上下文增量由 tool_done 的 toolTokenCount 计入
      // Manual token counting, provider-agnostic:
      // - First call: inputTokens = full context baseline
      // - Subsequent calls: only add model output; context growth tracked via toolTokenCount in tool_done
      const isFirstCall = state.status.totalTokens === 0;
      const addedTokens = isFirstCall
        ? d.inputTokens + (d.outputTokens ?? 0)
        : (d.outputTokens ?? 0);
      const updated = {
        ...state,
        status: {
          ...state.status,
          cacheHitTokens: hit,
          cacheMissTokens: miss,
          cacheHitRate: cacheTotal > 0 ? hit / cacheTotal : 0,
          totalTokens: state.status.totalTokens + addedTokens,
        },
      };
      // 缓存命中日志：调试时取消注释即可启用 / Cache hit log: uncomment to enable for debugging
      // if (d.inputTokens > 0) {
      //   const hitTokens = d.cacheHitTokens;
      //   const missTokens = d.cacheMissTokens;
      //   const rate = d.inputTokens > 0 ? (hitTokens / d.inputTokens * 100).toFixed(0) : "0";
      //   const log = `⚡ cache: ${fmt(hitTokens)} hit / ${fmt(missTokens)} miss · ${rate}%`;
      //   const block: OutputBlock = { id: updated.nextBlockId, kind: "text", content: log };
      //   return appendBlock(updated, block);
      // }
      return updated;
    }
    case 'final': {
      if (event.data.length === 0) return state;
      if (!/\S/u.test(event.data)) return state;
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state, 'text'));
      const last = lastTurn(finalized);
      // Current streaming segments preserve their original separators and
      // therefore concatenate exactly. Legacy per-line blocks had separators
      // removed, so replay compatibility still joins those with newlines.
      const textBlocks = (last?.blocks ?? []).filter(
        (block): block is TextBlock => block.kind === 'text',
      );
      const hasOwnedStreamingSegments = textBlocks.some((block) => block.modelRequestId != null);
      const fullText = textBlocks
        .map((block) => block.content)
        .join(hasOwnedStreamingSegments ? '' : '\n');
      if (fullText === event.data) return finalized;
      // final 可能比最后一个 text 事件多几个字符 → 只追加增量，不创建全文 block 避免重复
      if (fullText.length > 0 && event.data.startsWith(fullText)) {
        const delta = event.data.slice(fullText.length);
        if (delta.length === 0 || !/\S/u.test(delta)) return finalized;
        const id = finalized.nextBlockId;
        const block: OutputBlock = { id, kind: 'text', content: delta };
        const appended = appendBlock(finalized, block);
        return mergeStructuralTextBlocks(appended);
      }
      // 无前置 text block（纯 tool 调用等）→ 创建全文 block
      if (fullText.length === 0) {
        const id = finalized.nextBlockId;
        const block: OutputBlock = { id, kind: 'text', content: event.data };
        const appended = appendBlock(finalized, block);
        return mergeStructuralTextBlocks(appended);
      }
      // final 内容与已渲染文本不一致 → 保留已有 block，不创建重复
      return finalized;
    }
    case 'need_approval': {
      // Dedup: side-channel + stream interrupt can both emit need_approval for the same request.
      if (state.interrupt?.kind === 'approval') return state;
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state, 'human_wait'));
      let next: TuiState = {
        ...finalized,
        interrupt: { kind: 'approval' as const, approval: event.data },
      };
      if (event.data.reviewFailure) {
        const pendingTool = findBlock(
          next,
          (b) =>
            b.kind === 'tool_card' &&
            (b.status === 'queued' || b.status === 'running') &&
            (b.callId === event.data.callId || (!event.data.callId && b.name === event.data.tool)),
        );
        if (pendingTool?.kind === 'tool_card') {
          next = replaceBlockById(next, pendingTool.id, {
            ...pendingTool,
            reviewFailure: event.data.reviewFailure,
          });
        }
      }
      // 如果是子 agent 的工具需要审批，标记该子 agent 为等待审批状态
      if (event.data.subagentId) {
        next = {
          ...next,
          turns: next.turns.map((turn) => {
            let changed = false;
            const blocks = turn.blocks.map((blk) => {
              if (
                blk.kind === 'subagent' &&
                blk.subagentId === event.data.subagentId &&
                blk.status === 'running'
              ) {
                changed = true;
                const stepIndex = blk.steps.length - 1;
                const steps = blk.steps.map((s, i) =>
                  i === stepIndex ? { ...s, status: 'awaiting_approval' as const } : s,
                );
                return {
                  ...blk,
                  awaitingApproval: true,
                  approvingStepIndex: stepIndex,
                  steps,
                };
              }
              return blk;
            });
            return changed ? { ...turn, blocks } : turn;
          }),
        };
      }
      return next;
    }
    case 'need_input': {
      // Dedup: side-channel + stream interrupt can both emit need_input for the same request.
      // Skip if a question block is already active (interrupt pending).
      if (state.interrupt?.kind === 'input') return state;
      let finalized = finalizeLastTurnStreaming(closeCurrentThought(state, 'human_wait'));
      const askCard = findBlock(
        finalized,
        (candidate) =>
          candidate.kind === 'tool_card' &&
          candidate.name === 'ask_user' &&
          candidate.callId === event.toolCallId,
      );
      if (askCard?.kind === 'tool_card') {
        const args = { ...event.data };
        finalized = replaceBlockById(finalized, askCard.id, {
          ...askCard,
          args,
          detail: getToolDetail('ask_user', args),
        });
      }
      const block: OutputBlock = {
        id: finalized.nextBlockId,
        kind: 'question',
        question: event.data,
        toolCallId: event.toolCallId,
      };
      return { ...appendBlock(finalized, block), interrupt: { kind: 'input', blockId: block.id } };
    }
    case 'need_plan_review': {
      // Dedup: side-channel + stream interrupt can both emit need_plan_review for the same request.
      if (state.interrupt?.kind === 'plan_review') return state;
      // 方案内容在 OutputArea 以 Markdown tool_card 渲染，同时 Footer PlanReviewBlock
      // 展示确认操作条。填充 summary + expanded 以便 MarkdownBlock 展开渲染。
      // Plan content rendered in OutputArea as Markdown tool_card; Footer PlanReviewBlock
      // shows the confirmation bar. Populate summary + expanded for MarkdownBlock rendering.
      const planCard = findBlock(
        state,
        (b) =>
          b.kind === 'tool_card' &&
          (b.name === 'write_plan' || b.name === 'update_plan') &&
          (b.status === 'queued' || b.status === 'running'),
      );
      const plan = event.data.plan;
      const stepsText = (plan.steps ?? []).map((s, i) => `${i + 1}. ${s.step}`).join('\n');
      const planSummary = plan.description
        ? `${plan.description}\n\nSteps:\n${stepsText}`
        : `Steps:\n${stepsText}`;
      let next = closeCurrentThought(state, 'human_wait');
      if (planCard?.kind === 'tool_card') {
        next = replaceBlockById(next, planCard.id, {
          ...planCard,
          status: 'done' as const,
          summary: planSummary,
          detail: getToolDetail(planCard.name, planCard.args),
          expanded: true,
        });
      }
      return {
        ...next,
        interrupt: {
          kind: 'plan_review',
          plan: event.data.plan,
          ...(event.data.artifact ? { artifact: event.data.artifact } : {}),
        },
        status: { ...next.status, pendingPlan: event.data.plan },
      };
    }
    case 'error': {
      // 错误打断当前思考周期；恢复/重试后的 reasoning 属于新阶段。
      // An error closes the current cycle; reasoning after recovery/retry is a new phase.
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state, 'boundary'));
      const prefix = event.data.recoverable ? '⟳ Recoverable error' : 'Error';
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'text',
        content: `${prefix}: ${event.data.message}`,
        isError: !event.data.recoverable,
      };
      return { ...appendBlock(finalized, block), sessionError: !event.data.recoverable };
    }
    case 'file_change': {
      const change: FileChangeRecord = {
        path: event.data.path,
        kind: event.data.kind,
        linesAdded: event.data.linesAdded,
        linesRemoved: event.data.linesRemoved,
        preview: formatFilePreview(event.data.preview),
      };
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);
      if (lastBlock?.kind === 'file_change') {
        return updateLastBlock(state, { ...lastBlock, changes: [...lastBlock.changes, change] });
      }
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: 'file_change', changes: [change] };
      return appendBlock(finalized, block);
    }
    case 'subagent_start': {
      if (hasBlock(state, (b) => b.kind === 'subagent' && b.subagentId === event.data.id))
        return state;
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'subagent',
        subagentId: event.data.id,
        role: event.data.role,
        task: event.data.task,
        status: 'running',
        summary: '',
        toolCallCount: 0,
        durationMs: 0,
        steps: [],
        startedAt: Date.now(),
      };
      return appendBlock(finalized, block);
    }
    case 'subagent_step': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      const next: OutputBlock = {
        ...matched,
        steps: [
          ...matched.steps,
          {
            toolName: event.data.toolName,
            toolArgs: event.data.toolArgs,
            status: 'pending' as const,
          },
        ],
        awaitingApproval: false, // 新步骤到来时清除等待状态
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_tool_result': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      // Reverse-scan unresolved steps by status (not ok boolean).
      // pending / awaiting_approval → unresolved; success / rejected / error → resolved.
      let lastMatchIdx = -1;
      for (let i = matched.steps.length - 1; i >= 0; i--) {
        if (
          matched.steps[i]!.toolName === event.data.toolName &&
          (matched.steps[i]!.status === 'pending' ||
            matched.steps[i]!.status === 'awaiting_approval')
        ) {
          lastMatchIdx = i;
          break;
        }
      }
      // Fallback: old data without status field → match by ok===undefined (unresolved)
      if (lastMatchIdx === -1) {
        for (let i = matched.steps.length - 1; i >= 0; i--) {
          if (
            matched.steps[i]!.toolName === event.data.toolName &&
            matched.steps[i]!.ok === undefined
          ) {
            lastMatchIdx = i;
            break;
          }
        }
      }
      // Absolute fallback: all steps have ok set already, re-resolve the last one
      if (lastMatchIdx === -1) {
        for (let i = matched.steps.length - 1; i >= 0; i--) {
          if (matched.steps[i]!.toolName === event.data.toolName) {
            lastMatchIdx = i;
            break;
          }
        }
      }
      if (lastMatchIdx === -1) return state;
      // Compute step status from result + approval context.
      // A rejected approval produces status:'rejected', not status:'error'.
      const isApprovalRejected =
        matched.approvingStepIndex === lastMatchIdx && event.data.ok === false;
      const stepStatus: 'rejected' | 'success' | 'error' = isApprovalRejected
        ? 'rejected'
        : event.data.ok
          ? 'success'
          : 'error';
      const steps = matched.steps.map((s, i) => {
        if (i !== lastMatchIdx) return s;
        return { ...s, status: stepStatus, ok: event.data.ok, totalLines: event.data.totalLines };
      });
      if (steps.every((s, i) => s === matched.steps[i]!)) return state;
      const next: OutputBlock = {
        ...matched,
        steps,
        awaitingApproval: false,
        approvingStepIndex: undefined,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_done': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      const next: OutputBlock = {
        ...matched,
        status: 'done' as const,
        summary: event.data.summary,
        toolCallCount: event.data.toolCallCount,
        durationMs: event.data.durationMs,
        expanded: false,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_error': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      const summary = event.data.summary ?? event.data.error;
      const cancelled = summary === 'Cancelled';
      const next: OutputBlock = {
        ...matched,
        status: cancelled ? ('cancelled' as const) : ('error' as const),
        summary,
        error: summary || undefined,
        toolCallCount: event.data.toolCallCount ?? matched.toolCallCount,
        durationMs: event.data.durationMs ?? matched.durationMs,
        expanded: false,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_cache_metrics': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.subagentId,
      );
      if (matched?.kind !== 'subagent') return state;
      const prevHit = matched.cacheHitTokens ?? 0;
      const prevMiss = matched.cacheMissTokens ?? 0;
      const next: typeof matched = {
        ...matched,
        cacheHitTokens: prevHit + event.data.cacheHitTokens,
        cacheMissTokens: prevMiss + event.data.cacheMissTokens,
      };
      const updated = replaceBlockById(state, matched.id, next);
      // 子 agent 缓存命中日志：调试时取消注释即可启用 / Sub-agent cache hit log: uncomment to enable for debugging
      // const hitTokens = event.data.cacheHitTokens;
      // const missTokens = event.data.cacheMissTokens;
      // const inputTokens = event.data.inputTokens;
      // if (inputTokens > 0) {
      //   const rate = (hitTokens / inputTokens * 100).toFixed(0);
      //   const log = `  ⚡ sub cache: ${fmt(hitTokens)} hit / ${fmt(missTokens)} miss · ${rate}%`;
      //   const block = { id: updated.nextBlockId, kind: "text" as const, content: log };
      //   return appendBlock(updated, block);
      // }
      return updated;
    }
    case 'tool_progress': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.callId === event.data.call_id,
      );
      if (matched?.kind !== 'tool_card' || matched.status !== 'running') return state;

      const prev = matched.liveOutput ?? '';
      const line = event.data.chunk;
      const next = prev ? `${prev}\n${line}` : line;

      // Tail-follow：固定窗口，保留最近 N 行（与 ToolCardBlock.MAX_TOOL_LINES 一致）
      const lines = next.split('\n');
      const capped = lines.length > MAX_TOOL_LINES ? lines.slice(-MAX_TOOL_LINES).join('\n') : next;

      // 累计总行数：基于上一次的 total + 新行数（非完整行不计数）
      const prevTotal = matched.liveTotalLines ?? 0;
      const prevLineCount = prev ? prev.split('\n').length : 0;
      const newCompleteLines = lines.length - prevLineCount;

      return replaceBlockById(state, matched.id, {
        ...matched,
        liveOutput: capped,
        liveTotalLines: prevTotal + Math.max(0, newCompleteLines),
      });
    }
    // Raw passthrough events — intentionally no-op for UI consumers
    case 'interrupt':
    case 'update':
      return state;
    case 'turn_begin':
      // Informational — turn boundary marker, no UI state change needed
      return state;
    case 'turn_end':
      // Informational — turn boundary marker, no UI state change needed
      return state;
    case 'user_message':
      // Informational — user message already rendered via other mechanisms
      return state;
    default:
      return state;
  }
}

/** Shared RuntimeEvent rendering path for live updates and session replay. */
function currentModelResponseTextParts(
  state: TuiState,
): Array<{ text: string; streamingSource?: string }> {
  const blocks = lastTurn(state)?.blocks ?? [];
  if (state.currentModelRequestId) {
    const owned = blocks.flatMap((block) =>
      block.kind === 'text' && block.modelRequestId === state.currentModelRequestId
        ? [
            {
              text: block.streamingSource ?? block.content,
              ...(block.streamingSource ? { streamingSource: block.streamingSource } : {}),
            },
          ]
        : [],
    );
    if (owned.length > 0) return owned;
  }

  const trailing: Array<{ text: string; streamingSource?: string }> = [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.kind !== 'text') break;
    trailing.unshift({
      text: block.streamingSource ?? block.content,
      ...(block.streamingSource ? { streamingSource: block.streamingSource } : {}),
    });
  }
  return trailing;
}

/**
 * Establish terminal reasoning before text already committed by the same model
 * request. Streaming Markdown may have published complete prefix blocks before
 * model.responded reveals the complete Thought; appending the Thought at the
 * tail would place it between that prefix and the terminal paragraph.
 */
function insertTerminalReasoningBeforeCommittedText(
  state: TuiState,
  reasoningText: string,
  durationMs?: number,
): TuiState {
  const turn = lastTurn(state);
  if (!turn || !state.currentModelRequestId) {
    return handleEventAction(state, {
      type: 'reason',
      data: { text: reasoningText, durationMs },
    });
  }
  const firstOwnedTextIndex = turn.blocks.findIndex(
    (block) => block.kind === 'text' && block.modelRequestId === state.currentModelRequestId,
  );
  if (firstOwnedTextIndex < 0) {
    return handleEventAction(state, {
      type: 'reason',
      data: { text: reasoningText, durationMs },
    });
  }

  const committedText = turn.blocks.filter(
    (block) => block.kind === 'text' && block.modelRequestId === state.currentModelRequestId,
  );
  const turns = state.turns.slice();
  turns[turns.length - 1] = {
    blocks: turn.blocks.filter(
      (block) => !(block.kind === 'text' && block.modelRequestId === state.currentModelRequestId),
    ),
  };
  const withThought = handleEventAction(
    { ...state, turns },
    {
      type: 'reason',
      data: { text: reasoningText, durationMs },
    },
  );
  const nextTurns = withThought.turns.slice();
  const nextTurn = nextTurns.at(-1);
  if (!nextTurn) return withThought;
  nextTurns[nextTurns.length - 1] = {
    blocks: [...nextTurn.blocks, ...committedText],
  };
  return { ...withThought, turns: nextTurns };
}

function pendingToolArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function withoutPendingTool(state: TuiState, toolCallId: string): TuiState {
  if (!state.pendingToolCalls[toolCallId]) return state;
  const { [toolCallId]: _, ...pendingToolCalls } = state.pendingToolCalls;
  return { ...state, pendingToolCalls };
}

function visibleToolName(state: TuiState, toolCallId: string): string | undefined {
  const card = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === toolCallId,
  );
  if (card?.kind === 'tool_card') return card.name;
  const summary = findToolSummaryLocation(state, toolCallId)?.block;
  return summary?.tools.find((tool) => tool.callId === toolCallId)?.name;
}

function materializePendingTool(
  state: TuiState,
  toolCallId: string,
  status: 'queued' | 'running',
  consume: boolean,
): TuiState {
  const pending = state.pendingToolCalls[toolCallId];
  if (!pending) return state;
  const materialized = handleEventAction(state, {
    type: 'tool_call',
    data: {
      call_id: toolCallId,
      name: pending.name,
      args: pending.args,
      status,
    },
  });
  return consume ? withoutPendingTool(materialized, toolCallId) : materialized;
}

export function handleRuntimeEventAction(state: TuiState, event: RuntimeEvent): TuiState {
  switch (event.type) {
    case 'subagent.started':
      return handleEventAction(state, { type: 'subagent_start', data: event.subagent });
    case 'subagent.step':
      return handleEventAction(state, { type: 'subagent_step', data: event.subagent });
    case 'subagent.tool_result':
      return handleEventAction(state, { type: 'subagent_tool_result', data: event.subagent });
    case 'subagent.completed':
      return handleEventAction(state, { type: 'subagent_done', data: event.subagent });
    case 'subagent.failed':
      return handleEventAction(state, { type: 'subagent_error', data: event.subagent });
    case 'subagent.cache_metrics':
      return handleEventAction(state, { type: 'subagent_cache_metrics', data: event.subagent });
    case 'user.message_appended':
      return appendBlock(state, {
        id: state.nextBlockId,
        kind: 'user',
        content: event.content.replace(/^User:\s*/, ''),
      });
    case 'user.command_invoked':
      return appendBlock(state, {
        id: state.nextBlockId,
        kind: 'user',
        content: event.command,
      });
    case 'model.requested':
      return handleEventAction(
        {
          ...state,
          currentModelRequestId: event.requestId,
          currentModelReasoningStreamed: false,
          currentModelReasoningText: undefined,
        },
        {
          type: 'model_requested',
          data: { requestId: event.requestId },
        },
      );
    case 'model.text_delta':
      return handleEventAction(
        { ...state, status: { ...state.status, retryState: null } },
        { type: 'text', data: { text: event.text, streamingDelta: true } },
      );
    case 'model.reasoning_delta': {
      const cached = {
        ...state,
        currentModelReasoningStreamed: true,
        currentModelReasoningText: event.text,
        status: { ...state.status, retryState: null },
      };
      // A reasoning stream is one atomic transient component. Deltas only
      // update the cache; the first text delta publishes the complete value.
      // Late reasoning after that boundary remains cache-only and must not
      // reactivate or split the Thought.
      if (
        cached.thoughtPhaseStatus === 'running' ||
        cached.thoughtPhaseStatus === 'awaiting_terminal'
      ) {
        return cached;
      }
      return updateCurrentThoughtActivity(cached, undefined);
    }
    case 'model.reasoning_completed': {
      const cached = {
        ...state,
        currentModelReasoningStreamed: true,
        currentModelReasoningText: event.text,
        status: { ...state.status, retryState: null },
      };
      if (cached.thoughtPhaseStatus === 'awaiting_terminal') return cached;
      const current = findThoughtSummary(cached, cached.currentThoughtSummaryId);
      if (
        current?.active &&
        current.latestActivity?.kind === 'thinking' &&
        current.latestActivity.text === event.text
      ) {
        return cached;
      }
      return updateCurrentThoughtActivity(cached, {
        kind: 'thinking',
        text: event.text,
      });
    }
    case 'model.responded': {
      let next: TuiState = {
        ...removeStreamingComponent(state),
        status: { ...state.status, retryState: null },
      };
      const renderedBeforeTerminal = currentModelResponseTextParts(state);
      const renderedBeforeTerminalText = renderedBeforeTerminal.map((part) => part.text);
      const terminalTextAlreadyRendered =
        event.text != null &&
        renderedBeforeTerminal.every((part) => part.streamingSource == null) &&
        (renderedBeforeTerminalText.join('') === event.text ||
          renderedBeforeTerminalText.join('\n') === event.text);
      const activeStreamedThought = findThoughtSummary(next, next.currentThoughtSummaryId);
      const settledStreamedThought = terminalTextAlreadyRendered
        ? ([...(lastTurn(next)?.blocks ?? [])]
            .reverse()
            .find(
              (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
                block.kind === 'tool_summary' &&
                block.hasThinking === true &&
                (!next.currentModelRequestId ||
                  block.modelRequestId === next.currentModelRequestId),
            ) ?? null)
        : null;
      const streamedThought = activeStreamedThought ?? settledStreamedThought;
      const streamedThoughtHeader = terminalTextAlreadyRendered
        ? ([...(lastTurn(next)?.blocks ?? [])]
            .reverse()
            .find(
              (block): block is Extract<OutputBlock, { kind: 'text' }> =>
                block.kind === 'text' && block.thoughtElapsedMs != null,
            ) ?? null)
        : null;
      const reasoningText = event.reasoningText ?? state.currentModelReasoningText;
      if (reasoningText) {
        if (streamedThought) {
          next = updateToolSummaryById(next, streamedThought.id, (block) => {
            const timeline = [...(block.timeline ?? [])];
            const lastEntry = timeline.at(-1);
            if (lastEntry?.kind === 'thinking') {
              timeline[timeline.length - 1] = { ...lastEntry, text: reasoningText };
            } else {
              timeline.push({
                seq: (block.nextTimelineSeq ?? timeline.length) + 1,
                kind: 'thinking',
                text: reasoningText,
              });
            }
            const modelMs =
              event.durationMs != null ? (block.modelMs ?? 0) + event.durationMs : block.modelMs;
            return {
              ...block,
              hasThinking: true,
              ...(block.active
                ? { latestActivity: { kind: 'thinking' as const, text: reasoningText } }
                : {}),
              timeline,
              nextTimelineSeq: timeline.at(-1)?.seq ?? block.nextTimelineSeq,
              ...(modelMs != null ? { modelMs, totalElapsedMs: modelMs } : {}),
            };
          });
        } else if (streamedThoughtHeader) {
          next = replaceBlockById(next, streamedThoughtHeader.id, {
            ...streamedThoughtHeader,
            ...(event.durationMs != null ? { thoughtElapsedMs: event.durationMs } : {}),
          });
        } else if (terminalTextAlreadyRendered && next.currentModelReasoningStreamed) {
          const streamedText = [...(lastTurn(next)?.blocks ?? [])]
            .reverse()
            .find(
              (block): block is Extract<OutputBlock, { kind: 'text' }> =>
                block.kind === 'text' &&
                (!next.currentModelRequestId ||
                  block.modelRequestId === next.currentModelRequestId),
            );
          if (streamedText && event.durationMs != null) {
            next = replaceBlockById(next, streamedText.id, {
              ...streamedText,
              thoughtElapsedMs: event.durationMs,
            });
          }
        } else if (
          next.thoughtPhaseStatus === 'awaiting_terminal' &&
          next.currentModelReasoningStreamed
        ) {
          // The first complete answer component already committed the Thought
          // (or merged a pure Thought into that text) to Static. Keep the
          // terminal reasoning authoritative only in the model response; never
          // insert or mutate a visual Thought behind already-published text.
        } else {
          next = insertTerminalReasoningBeforeCommittedText(next, reasoningText, event.durationMs);
        }
      } else if (event.durationMs != null)
        // ADR-0030 / 规则 24：无 reasoning 的调用同样计入阶段时长（Σ 各次
        // 模型调用，规则 22）。reason 事件已携带 durationMs，仅在无思考时补计。
        // Non-reasoning calls also add to the phase duration (Σ model calls);
        // reason events already carry their own durationMs.
        next = addThoughtDuration(next, event.durationMs);
      if (event.text) {
        const renderedTextParts = currentModelResponseTextParts(next);
        const renderedText = renderedTextParts.map((part) => part.text);
        // A reconnect freezes the interrupted prefix and streams only the
        // recovered suffix in a new block. Together they may already equal the
        // authoritative final response; do not replace the suffix block with
        // the full response and duplicate the preserved prefix.
        const alreadyRendered =
          renderedText.join('') === event.text || renderedText.join('\n') === event.text;
        if (!alreadyRendered) {
          const renderedPrefix = renderedText.join('');
          if (event.text.startsWith(renderedPrefix)) {
            const remainder = event.text.slice(renderedPrefix.length);
            if (remainder.length > 0) {
              const closed = closeCurrentThought(next, 'text');
              next = mergePureThoughtHeader(
                appendBlock(closed, {
                  id: closed.nextBlockId,
                  kind: 'text',
                  content: remainder,
                  ...(closed.currentModelRequestId
                    ? { modelRequestId: closed.currentModelRequestId }
                    : {}),
                }),
              );
            }
          }
          // Divergent reconnect: the retry produced text that does not match
          // the frozen prefix from the previous attempt.  Dispatching through
          // the normal text handler would slice event.text by the prefix's
          // committed length (currentModelResponseTextParts includes both old
          // and new blocks) and truncate the new text.  Replace all text blocks
          // from this request with a single block holding the authoritative
          // final text.
          else if (renderedTextParts.length > 0) {
            const turns = next.turns.map((turn) => ({
              blocks: turn.blocks.flatMap((block) => {
                if (block.kind === 'text' && block.modelRequestId === next.currentModelRequestId) {
                  return [];
                }
                return [block];
              }),
            }));
            const finalBlock: OutputBlock = {
              id: next.nextBlockId,
              kind: 'text',
              content: event.text,
              ...(next.currentModelRequestId ? { modelRequestId: next.currentModelRequestId } : {}),
            };
            next = appendBlock({ ...next, turns }, finalBlock);
          } else {
            next = handleEventAction(next, { type: 'text', data: { text: event.text } });
          }
        }
      }
      if (
        event.text &&
        (next.thoughtPhaseStatus === 'running' || next.thoughtPhaseStatus === 'awaiting_terminal')
      ) {
        next = mergePureThoughtHeader(closeCurrentThought(next, 'text'));
      }
      return {
        ...finalizeLastTurnStreaming(next),
        currentModelReasoningText: undefined,
      };
    }
    case 'run.completed':
      // `model.responded` may be rendered while the run is still active, leaving
      // its final line in the dynamic streaming tree. Reconcile against the
      // authoritative persisted output and finalize it before SET_IDLE moves
      // the turn into Ink <Static>; otherwise the tail can be lost during the
      // same-frame Static/Dynamic handoff and appear only after session replay.
      return handleEventAction(state, { type: 'final', data: event.output });
    case 'model.retry':
      return handleEventAction(state, {
        type: 'model_retry',
        data: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          error: event.error,
          delayMs: event.delayMs,
        },
      });
    case 'model.cache_metrics':
      return handleEventAction(state, {
        type: 'cache_metrics',
        data: {
          workspaceAccess: 'write' as const,
          inputTokens: event.inputTokens,
          cacheHitTokens: event.cacheHitTokens,
          cacheMissTokens: event.cacheMissTokens,
          hitRate: event.hitRate,
          standard: {
            callIndex: 1,
            isWarmup: false,
            includedInStandard: false,
            targetHitRate: 0.8,
            minimumMeasuredInputTokens: 0,
            summary: {
              inputTokens: event.inputTokens,
              cacheHitTokens: event.cacheHitTokens,
              cacheMissTokens: event.cacheMissTokens,
              hitRate: event.hitRate,
              totalCalls: 1,
              warmupCalls: 0,
              measuredCalls: 0,
              targetHitRate: 0.8,
              minimumMeasuredInputTokens: 0,
              hasEnoughMeasuredTokens: false,
              meetsTarget: null,
            },
          },
        },
      });
    case 'context.compaction_completed': {
      const notice = contextCompactionTerminalNotice(event);
      if (state.terminalCompactionNotices?.[notice.compactionId]) return state;
      const next = handleEventAction(state, {
        type: 'text',
        data: { text: notice.message },
      });
      const previousSnapshot = next.status.contextSnapshot;
      const usableInputTokens = previousSnapshot?.usableInputTokens;
      const utilization =
        usableInputTokens != null && usableInputTokens > 0
          ? event.checkpoint.inputTokensAfter / usableInputTokens
          : undefined;
      return {
        ...next,
        status: {
          ...next.status,
          contextSnapshot: {
            ...(previousSnapshot ?? {
              estimate: {
                systemTokens: 0,
                toolSchemaTokens: 0,
                transcriptTokens: 0,
                summaryTokens: 0,
                dynamicRuntimeTokens: 0,
                framingTokens: 0,
                totalInputTokens: event.checkpoint.inputTokensAfter,
              },
              status: 'unknown' as const,
            }),
            estimate: {
              ...(previousSnapshot?.estimate ?? {
                systemTokens: 0,
                toolSchemaTokens: 0,
                transcriptTokens: 0,
                summaryTokens: 0,
                dynamicRuntimeTokens: 0,
                framingTokens: 0,
              }),
              totalInputTokens: event.checkpoint.inputTokensAfter,
            },
            utilization,
            activeCheckpointId: event.checkpoint.compactionId,
            inputTokensBefore: event.checkpoint.inputTokensBefore,
            inputTokensAfter: event.checkpoint.inputTokensAfter,
          },
        },
        terminalCompactionNotices: {
          ...next.terminalCompactionNotices,
          [notice.compactionId]: notice.kind,
        },
      };
    }
    case 'context.compaction_failed': {
      const notice = contextCompactionTerminalNotice(event);
      if (state.terminalCompactionNotices?.[notice.compactionId]) return state;
      // Benign rejections: render as plain text (persisted across restarts).
      if (!notice.isError) {
        const next = handleEventAction(state, {
          type: 'text',
          data: { text: `  ⎿  ${notice.message}` },
        });
        return {
          ...next,
          terminalCompactionNotices: {
            ...next.terminalCompactionNotices,
            [notice.compactionId]: notice.kind,
          },
        };
      }
      const next = handleEventAction(state, {
        type: 'error',
        data: {
          message: notice.message,
          recoverable: event.retryable,
        },
      });
      return {
        ...next,
        terminalCompactionNotices: {
          ...next.terminalCompactionNotices,
          [notice.compactionId]: notice.kind,
        },
      };
    }
    case 'model.context_metrics':
      return {
        ...state,
        status: {
          ...state.status,
          contextSnapshot: {
            estimate: event.estimate,
            status: event.status,
            usableInputTokens: event.usableInputTokens,
            utilization: event.utilization,
            activeCheckpointId: state.status.contextSnapshot?.activeCheckpointId,
            inputTokensBefore: state.status.contextSnapshot?.inputTokensBefore,
            inputTokensAfter: state.status.contextSnapshot?.inputTokensAfter,
          },
        },
      };
    case 'context.compaction_reset':
      return handleEventAction(
        {
          ...state,
          status: {
            ...state.status,
            contextSnapshot: state.status.contextSnapshot
              ? {
                  ...state.status.contextSnapshot,
                  activeCheckpointId: undefined,
                  inputTokensBefore: undefined,
                  inputTokensAfter: undefined,
                }
              : undefined,
          },
        },
        {
          type: 'text',
          data: { text: 'Context checkpoint reset; using the original transcript.' },
        },
      );
    case 'run.error':
      return handleEventAction(state, {
        type: 'error',
        data: { message: event.message, recoverable: event.recoverable },
      });
    case 'tool.queued':
      return {
        ...state,
        pendingToolCalls: {
          ...state.pendingToolCalls,
          [event.toolCallId]: {
            name: event.name,
            args: pendingToolArgs(event.args),
          },
        },
      };
    case 'tool.started': {
      const materialized = materializePendingTool(state, event.toolCallId, 'running', true);
      return handleEventAction(materialized, {
        type: 'tool_started',
        data: { call_id: event.toolCallId },
      });
    }
    case 'tool.execution_ready':
      // Legacy replay compatibility: the former shell batch barrier persisted
      // readiness without starting the call, so it remains invisible.
      return state;
    case 'tool.progress':
      return handleEventAction(state, {
        type: 'tool_progress',
        data: { call_id: event.toolCallId, name: '', chunk: event.chunk, stream: event.stream },
      });
    case 'tool.finished': {
      const materialized = materializePendingTool(state, event.toolCallId, 'running', true);
      return handleEventAction(materialized, {
        type: 'tool_done',
        data: {
          call_id: event.toolCallId,
          name: event.name,
          ok: event.result.ok,
          summary: formatToolResultForDisplay(event.name, event.result.stdout, event.result.stderr),
          exitCode: event.result.exitCode,
          status: event.result.status,
          userInput: event.result.userInput,
        },
      });
    }
    case 'tool.failed': {
      const pendingName =
        state.pendingToolCalls[event.toolCallId]?.name ??
        visibleToolName(state, event.toolCallId) ??
        '';
      const materialized = materializePendingTool(state, event.toolCallId, 'queued', true);
      return handleEventAction(materialized, {
        type: 'tool_done',
        data: {
          call_id: event.toolCallId,
          name: pendingName,
          ok: false,
          summary: event.failure?.message ?? event.error ?? 'Tool failed.',
        },
      });
    }
    case 'tool.rejected': {
      if (event.failure?.kind === 'phase_deferred') {
        return withoutPendingTool(state, event.toolCallId);
      }
      if (event.failure?.kind === 'phase_denied') {
        if (state.pendingToolCalls[event.toolCallId] == null) return state;
        const cleared = withoutPendingTool(state, event.toolCallId);
        const finalized = closeCurrentThought(cleared, 'tool');
        return appendBlock(finalized, {
          id: finalized.nextBlockId,
          kind: 'text',
          content: event.reason,
        });
      }
      const pendingName =
        state.pendingToolCalls[event.toolCallId]?.name ??
        visibleToolName(state, event.toolCallId) ??
        '';
      const materialized = materializePendingTool(state, event.toolCallId, 'queued', true);
      return handleEventAction(materialized, {
        type: 'tool_done',
        data: {
          call_id: event.toolCallId,
          name: pendingName,
          ok: false,
          summary: event.reason,
        },
      });
    }
    case 'tool.cancelled': {
      const wasPending = state.pendingToolCalls[event.toolCallId] != null;
      const visibleCard = findBlock(
        state,
        (block) => block.kind === 'tool_card' && block.callId === event.toolCallId,
      );
      const name = visibleToolName(state, event.toolCallId);
      const next = withoutPendingTool(state, event.toolCallId);
      if (wasPending && !name) return next;
      if (!name) return next;
      // plan.review_requested already rendered the durable draft and marked its
      // card done. Cancelling execution authorization must not replace that
      // document with a synthetic Cancelled result.
      if (
        visibleCard?.kind === 'tool_card' &&
        visibleCard.status === 'done' &&
        (visibleCard.name === 'write_plan' || visibleCard.name === 'update_plan')
      ) {
        return next;
      }
      return handleEventAction(next, {
        type: 'tool_done',
        data: {
          call_id: event.toolCallId,
          name,
          ok: false,
          summary: 'Cancelled',
        },
      });
    }
    case 'tool.file_change':
      return handleEventAction(state, {
        type: 'file_change',
        data: {
          path: event.path,
          kind: event.kind,
          linesAdded: event.linesAdded,
          linesRemoved: event.linesRemoved,
          preview: event.preview,
        },
      });
    case 'user_input.requested': {
      const materialized = materializePendingTool(state, event.toolCallId, 'queued', false);
      return handleEventAction(materialized, {
        type: 'need_input',
        data: event.request,
        toolCallId: event.toolCallId,
      });
    }
    case 'provider.action_required':
      return handleEventAction(state, {
        type: 'need_input',
        data: providerActionInput(event.providerId, event.action),
        toolCallId: event.originatingToolCallId,
      });
    case 'provider.admission_required':
      return handleEventAction(state, {
        type: 'need_input',
        data: providerAdmissionInput(event.providerId, event.providerStatus, event.retryable),
      });
    case 'approval.requested': {
      return handleEventAction(state, {
        type: 'need_approval',
        data: {
          ...event.approval,
          callId: event.approval.callId ?? event.toolCallId,
        },
      });
    }
    case 'approval.rejected': {
      const approvalBlock =
        state.interrupt?.kind === 'approval' && state.interrupt.blockId
          ? findBlockById(state, state.interrupt.blockId)
          : undefined;
      const activeApproval = approvalBlock?.kind === 'approval' ? approvalBlock : undefined;
      const interruptApproval =
        state.interrupt?.kind === 'approval' ? state.interrupt.approval : undefined;
      const toolCallId =
        event.toolCallId ?? interruptApproval?.callId ?? activeApproval?.approval.callId;
      const visibleName = toolCallId ? visibleToolName(state, toolCallId) : undefined;
      let next = toolCallId ? withoutPendingTool(state, toolCallId) : state;
      if (toolCallId && visibleName) {
        next = handleEventAction(next, {
          type: 'tool_done',
          data: {
            call_id: toolCallId,
            name: visibleName,
            ok: false,
            summary: event.reason,
            status: 'error',
          },
        });
      }
      if (activeApproval && (!toolCallId || activeApproval.approval.callId === toolCallId)) {
        next = replaceBlockById(next, activeApproval.id, {
          ...activeApproval,
          resolved: activeApproval.resolved ?? { action: 'reject' },
        });
      }
      return { ...next, interrupt: null };
    }
    case 'planning.entered':
      return { ...state, status: { ...state.status, phase: 'planning' } };
    case 'planning.exited':
      return { ...state, status: { ...state.status, phase: 'building' } };
    case 'plan.review_requested': {
      const materialized = materializePendingTool(state, event.toolCallId, 'queued', false);
      return handleEventAction(materialized, {
        type: 'need_plan_review',
        data: { plan: event.plan, ...(event.artifact ? { artifact: event.artifact } : {}) },
      });
    }
    case 'plan.approved':
      return {
        ...state,
        status: {
          ...state.status,
          phase: 'building',
          // Replay has no separate RESOLVE_PLAN_REVIEW UI action. Promote the
          // pending plan here so replay and live rendering share the same
          // update_plan visibility rule.
          plan: state.status.pendingPlan ?? state.status.plan,
          pendingPlan: null,
        },
      };
    case 'plan.progress_updated':
    case 'plan.completed':
      return {
        ...state,
        status: { ...state.status, plan: event.plan },
      };
    case 'plan.revision_requested':
      return {
        ...state,
        interrupt: null,
        status: {
          ...state.status,
          pendingPlan: state.status.plan, // keep current plan for revision display
        },
      };
    case 'plan.review_cancelled':
      return {
        ...state,
        interrupt: null,
        status: { ...state.status, pendingPlan: null },
      };
    case 'plan.rejected':
      return {
        ...state,
        status: { ...state.status, pendingPlan: null },
      };
    case 'task.completed':
      return { ...state, status: { ...state.status, phase: 'building' } };
    case 'task.cancelled':
      return { ...state, status: { ...state.status, phase: 'building', pendingPlan: null } };
    case 'turn.aborted': {
      if (event.cause !== 'user') return state;
      const cancelled = finalizeLastTurnStreaming(
        cancelRunningBlocks({
          ...state,
          pendingToolCalls: {},
        }),
      );
      return {
        ...cancelled,
        running: false,
        interrupt: null,
      };
    }
    default:
      return state;
  }
}
